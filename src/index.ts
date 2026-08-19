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
import { BridgeManager } from './host/bridge-manager.ts'
import { loadStore } from './host/gateway-store.ts'
import { registerGatewayRoutes } from './host/routes.ts'
import { Config, type GatewayConfig } from './core/config.ts'
import { TelegramBridge } from './host/telegram-bridge.ts'
import { DiscordBridge } from './host/discord-bridge.ts'
import { QQBridge } from './host/qq-bridge.ts'
import { EmailBridge, ImapClient, SmtpClient, headerField, parseAddress, cleanBody } from './host/email-bridge.ts'
import { WecomBridge } from './host/wecom-bridge.ts'
import { WecomAppBridge, WechatMpBridge, WhatsappBridge, sha1Sorted, xmlField, xmlEncrypt } from './host/callback-bridges.ts'
import { CALLBACK_PATHS } from './host/routes.ts'
import { PLATFORMS, platformDef, testPlatform } from './host/platforms.ts'

/** 所需服务：路由注册表、会话存储、agent 工厂（消息注入目标）、默认模型选择。 */
export const inject = ['webServer', 'sessions', 'agents', 'agentDefaultModel']

/** 插件配置 schema。 */
export { Config }

/** 供宿主嵌入/测试使用的内部类与平台表。 */
export {
  BridgeManager, TelegramBridge, DiscordBridge, QQBridge, WecomBridge, EmailBridge, ImapClient, SmtpClient,
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
    return () => {
      disposeRoutes()
      void manager.dispose()
    }
  }, 'dsh-message-gateway: routes + bridges')
}

/** Cordis plugin entry — named + default export so the loader always resolves it. */
export default { apply, inject, Config }