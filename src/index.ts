/**
 * dsh-message-gateway — 通用消息平台网关插件。
 * 宿主侧：多平台消息连接器的凭据存储与连接测试，经共享 webserver 暴露
 * /gateway/* HTTP 路由；企业微信智能机器人常驻桥接（每聊天独立会话、
 * 上下文自动压缩，与 Web 对话一致）。浏览器侧部分（导出 "./client"）
 * 由同包的 dsh.client 声明通过 client-modules 提供。
 * @module dsh-message-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BridgeManager } from './host/bridge-manager.ts'
import { loadStore } from './host/gateway-store.ts'
import { registerGatewayRoutes } from './host/routes.ts'
import { Config, type GatewayConfig } from './core/config.ts'
import { TelegramBridge } from './host/telegram-bridge.ts'
import { DiscordBridge } from './host/discord-bridge.ts'
import { QQBridge, QqWebhookBridge } from './host/qq-bridge.ts'
import { EmailBridge, ImapClient, SmtpClient, headerField, parseAddress, cleanBody } from './host/email-bridge.ts'
import { WecomBridge } from './host/wecom-bridge.ts'
import { WecomAppBridge, WechatMpBridge, WhatsappBridge, sha1Sorted, xmlField, xmlEncrypt } from './host/callback-bridges.ts'
import { CALLBACK_PATHS } from './host/routes.ts'
import { PLATFORMS, platformDef, testPlatform } from './host/platforms.ts'

/** 所需服务：路由注册表、会话存储、agent 工厂（消息注入目标）、默认模型选择、工具注册表。 */
export const inject = ['webServer', 'sessions', 'agents', 'agentDefaultModel', 'tools']

/** 插件配置 schema。 */
export { Config }

/** 供宿主嵌入/测试使用的内部类与平台表。 */
export {
  BridgeManager, TelegramBridge, DiscordBridge, QQBridge, QqWebhookBridge, WecomBridge, EmailBridge, ImapClient, SmtpClient,
  headerField, parseAddress, cleanBody,
  WecomAppBridge, WechatMpBridge, WhatsappBridge,
  sha1Sorted, xmlField, xmlEncrypt, CALLBACK_PATHS,
  PLATFORMS, platformDef, testPlatform,
}
export type { GatewayConfig }

/** 挂载网关路由并启动已配置平台的常驻桥。 */
export function apply(ctx: Context, config: GatewayConfig = Config({} as GatewayConfig) as GatewayConfig): void {
  const manager = new BridgeManager(ctx, config)
  ctx.effect(() => {
    // 已保存的各平台凭据 → 自动建立常驻连接（配置项可关）。
    void loadStore().then((store) => {
      const wecom = store.platforms['wecom-aibot']
      if (config.autoStartWecom && wecom !== undefined && wecom.botId !== '' && wecom.secret !== '') {
        manager.startWecom({ botId: wecom.botId, secret: wecom.secret })
        console.log('[dsh-message-gateway] wecom-aibot bridge auto-started')
      }
      const telegram = store.platforms.telegram
      if (config.autoStartTelegram && telegram !== undefined && telegram.token !== '') {
        manager.startTelegram(telegram)
        console.log('[dsh-message-gateway] telegram bridge auto-started')
      }
      const discord = store.platforms.discord
      if (config.autoStartDiscord && discord !== undefined && discord.token !== '') {
        manager.startDiscord(discord)
        console.log('[dsh-message-gateway] discord bridge auto-started')
      }
      const qq = store.platforms.qq
      if (config.autoStartQQ && qq !== undefined && qq.appId !== '' && qq.secret !== '') {
        manager.startQQ(qq)
        console.log('[dsh-message-gateway] qq bridge auto-started')
      }
      const email = store.platforms.email
      if (config.autoStartEmail && email !== undefined && email.imapHost !== '' && email.imapUser !== '') {
        manager.startEmail(email)
        console.log('[dsh-message-gateway] email bridge auto-started')
      }
    })
    const disposeRoutes = registerGatewayRoutes(ctx, manager)
    // 注册通用 Agent 消息推送工具 send_chat_message
    let disposeTool: (() => void) | undefined
    if (ctx.tools) {
      disposeTool = ctx.tools.register(defineTool({
        name: 'send_chat_message',
        description: '向已连接的消息平台（Telegram / Discord / 企业微信智能机器人 / Email 等）主动推送文本消息。例如把代码总结、任务结果推送至指定的群聊或私信频道。',
        parameters: {
          platform: {
            type: 'string',
            required: true,
            description: '目标平台 id：telegram / discord / wecom-aibot / email',
          },
          target: {
            type: 'string',
            required: true,
            description: '推送目标（telegram=chatId 数字；discord=channelId；wecom-aibot=userid/群ID；email=收件人地址）',
          },
          message: {
            type: 'string',
            required: true,
            description: '要推送的文本正文内容（支持 Markdown）',
          },
          title: {
            type: 'string',
            description: '可选标题（email 作为主题，其他平台作为首行加粗前缀）',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
        },
        async execute(args: { platform: string; target: string; message: string; title?: string }) {
          const platform = String(args.platform ?? '').trim()
          const target = String(args.target ?? '').trim()
          const message = String(args.message ?? '').trim()
          const title = args.title !== undefined ? String(args.title).trim() : undefined
          if (!platform || !target || !message) {
            return '错误：platform, target 与 message 均为必填参数'
          }
          const res = await manager.pushMessage(platform, target, message, { title })
          if (res.ok) {
            return `消息已成功推送至 [${platform}] 目标 ${target}`
          }
          return `推送失败：${res.detail}`
        },
      }))
    }
    return () => {
      disposeTool?.()
      disposeRoutes()
      void manager.dispose()
    }
  }, 'dsh-message-gateway: routes + bridges')
}

/** Cordis plugin entry — named + default export so the loader always resolves it. */
export default { apply, inject, Config }