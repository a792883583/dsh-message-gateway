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
import { WecomSmartsheetClient, type CreateSmartsheetOptions, type CreateSmartsheetResult, type SmartsheetFieldDef } from './host/wecom-smartsheet.ts'
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
  WecomSmartsheetClient,
}
export type { GatewayConfig, CreateSmartsheetOptions, CreateSmartsheetResult, SmartsheetFieldDef }

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
      const feishu = store.platforms.feishu
      if (config.autoStartFeishu && feishu !== undefined && feishu.appId !== '' && feishu.appSecret !== '') {
        manager.startFeishu(feishu)
        console.log('[dsh-message-gateway] feishu bridge auto-started')
      }
      const dingtalk = store.platforms.dingtalk
      if (config.autoStartDingtalk && dingtalk !== undefined && dingtalk.clientId !== '' && dingtalk.clientSecret !== '') {
        manager.startDingTalk(dingtalk)
        console.log('[dsh-message-gateway] dingtalk bridge auto-started')
      }
    })
    const disposeRoutes = registerGatewayRoutes(ctx, manager)
    // 注册通用 Agent 工具：① send_chat_message ② wecom_create_smartsheet
    let disposeTools: (() => void) | undefined
    if (ctx.tools) {
      const disposeSend = ctx.tools.register(defineTool({
        name: 'send_chat_message',
        description: '向已连接的消息平台（Telegram / Discord / 企业微信智能机器人 / 飞书 / 钉钉 / Email 等）主动推送文本消息。例如把代码总结、任务结果推送至指定的群聊或私信频道。',
        parameters: {
          platform: {
            type: 'string',
            required: true,
            description: '目标平台 id：telegram / discord / wecom-aibot / feishu / dingtalk / email',
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
          image: {
            type: 'string',
            description: '可选图片数据：Base64 字符串或公网可访问的 http/https 图片 URL',
          },
          filename: {
            type: 'string',
            description: '可选图片文件名（如 screenshot.png，默认 image.png）',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
        },
        async execute(args: { platform: string; target: string; message?: string; title?: string; image?: string; filename?: string }) {
          const platform = String(args.platform ?? '').trim()
          const target = String(args.target ?? '').trim()
          const message = String(args.message ?? '').trim()
          const title = args.title !== undefined ? String(args.title).trim() : undefined
          const image = args.image !== undefined ? String(args.image).trim() : undefined
          const filename = args.filename !== undefined ? String(args.filename).trim() : undefined
          if (!platform || !target || (!message && !image)) {
            return '错误：platform、target 为必填，且 message 与 image 至少提供一个'
          }
          if (message) {
            const res = await manager.pushMessage(platform, target, message, { title })
            if (!res.ok) return `文本推送失败：${res.detail}`
          }
          if (image) {
            let imgPayload: Buffer | string
            if (/^https?:\/\//i.test(image)) {
              imgPayload = image
            } else {
              const clean = image.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
              imgPayload = Buffer.from(clean, 'base64')
            }
            const imgRes = await manager.pushImage(platform, target, imgPayload, { caption: message ? undefined : title, filename })
            if (!imgRes.ok) return `图片推送失败：${imgRes.detail}`
          }
          return `已成功推送至 [${platform}] 目标 ${target}`
        },
      }))

      const disposeSmartsheet = ctx.tools.register(defineTool({
        name: 'wecom_create_smartsheet',
        description: '在企业微信中创建一份全新的在线智能表格（Smartsheet），支持定义表格标题、字段列（文本/单选/多选/人员/日期/数字等）与初始数据行，并返回智能表格在线访问链接。',
        parameters: {
          title: {
            type: 'string',
            required: true,
            description: '智能表格文档标题（如：2026年Q3项目开发排期表）',
          },
          sheetTitle: {
            type: 'string',
            description: '首个工作表名称（默认：数据表）',
          },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', required: true },
                type: {
                  type: 'string',
                  enum: ['text', 'number', 'single_select', 'multi_select', 'date_time', 'user', 'checkbox'],
                },
                options: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
            description: '列字段定义列表，如 [{"title": "任务名称", "type": "text"}, {"title": "状态", "type": "single_select", "options": ["待办", "进行中", "已完成"]}]',
          },
          records: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
            },
            description: '初始填入的数据行列表，如 [{"任务名称": "需求评审", "状态": "已完成"}]',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
        },
        async execute(args: {
          title: string
          sheetTitle?: string
          fields?: Array<{ title: string; type?: string; options?: string[] }>
          records?: Array<Record<string, unknown>>
        }) {
          const title = String(args.title ?? '').trim()
          if (!title) return '错误：表格标题 title 为必填项'

          // 从已保存的凭据中提取企业微信凭据
          const store = await loadStore()
          const wecomCred = store.platforms['wecom-aibot'] || store.platforms['wecom']
          if (!wecomCred || (!wecomCred.secret && !wecomCred.corpId && !wecomCred.botId)) {
            return '错误：未在消息平台中配置企业微信凭据，请先在侧边栏「消息平台」中配置企业微信智能机器人或自建应用凭据'
          }
          // 企业微信智能表格当前仅支持智能机器人（botId + secret）授权通道（@wecom/cli）
          if (!wecomCred.botId || !wecomCred.secret) {
            return '错误：创建企业微信智能表格需要使用智能机器人凭据（botId + secret），当前仅配置了自建应用凭据，暂不支持'
          }

          const client = new WecomSmartsheetClient({
            botId: wecomCred.botId,
            secret: wecomCred.secret,
          })

          const res = await client.createSmartsheet({
            title,
            sheetTitle: args.sheetTitle,
            fields: args.fields as any,
            records: args.records,
          })

          if (!res.ok) {
            return `创建智能表格失败：${res.error}`
          }

          return `✅ 智能表格「${title}」创建成功！\n- 文档 ID: ${res.docid}\n- 在线访问链接: ${res.url}`
        },
      }))

      disposeTools = () => {
        disposeSend()
        disposeSmartsheet()
      }
    }
    const onShutdown = (): void => {
      try {
        void manager.dispose()
      } catch {}
    }
    process.once('SIGTERM', onShutdown)
    process.once('SIGINT', onShutdown)
    process.once('beforeExit', onShutdown)

    return () => {
      process.off('SIGTERM', onShutdown)
      process.off('SIGINT', onShutdown)
      process.off('beforeExit', onShutdown)
      disposeTools?.()
      disposeRoutes()
      void manager.dispose()
    }
  }, 'dsh-message-gateway: routes + bridges')
}

/** Cordis plugin entry — named + default export so the loader always resolves it. */
export default { apply, inject, Config }