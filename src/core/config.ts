/**
 * 插件配置（schemastery schema）：每个安装者可独立配置，
 * 经 `dsh plugin config` / 配置文件下发，apply(ctx, config) 接收。
 * @module dsh-message-gateway/core/config
 */

import Schema from '@deepseek-ai/schemastery'

/** 机器人回复语言。 */
export type BotLocale = 'zh' | 'en'

/** 可选的机器人专用模型覆盖（不设置时跟随部署默认模型，与 Web 对话一致）。 */
export interface BotModelOverride {
  provider: string
  model: string
}

/** 插件运行时配置。 */
export interface GatewayConfig {
  /** 机器人回复语言（默认中文；企业微信等平台面向中文用户）。 */
  botLocale: BotLocale
  /** 每个机器人最多保留的聊天会话数（超出自动淘汰最旧会话）。 */
  maxChatAgents: number
  /** 可选：机器人专用模型（provider + model），优先于部署默认模型。 */
  botModel?: BotModelOverride
  /** 启动时自动用已保存的企业微信智能机器人凭据建立常驻连接。 */
  autoStartWecom: boolean
  /** 启动时自动用已保存的 Telegram 凭据建立常驻连接。 */
  autoStartTelegram: boolean
  /** 启动时自动用已保存的 Discord 凭据建立常驻连接。 */
  autoStartDiscord: boolean
  /** 启动时自动用已保存的 QQ 凭据建立常驻连接。 */
  autoStartQQ: boolean
  /** 启动时自动用已保存的 Email 凭据建立常驻连接（IMAP 轮询）。 */
  autoStartEmail: boolean
  /** 是否回复群聊消息（false 时只处理单聊）。 */
  groupReply: boolean
}

/** 插件配置 schema（cordis Loader 校验 + dsh 配置面板渲染）。 */
export const Config = Schema.object({
  botLocale: Schema.union(['zh', 'en']).default('zh').description('机器人回复语言（zh 中文 / en English）'),
  maxChatAgents: Schema.natural().min(1).max(200).default(40).description('每个机器人最多保留的聊天会话数，超出自动淘汰最旧会话'),
  botModel: Schema.object({
    provider: Schema.string().required().description('模型供应商（如 pipio / opencode-go）'),
    model: Schema.string().required().description('模型 id（如 deepseek-v4-flash-0731）'),
  })
    .default(undefined as never)
    .description('可选：机器人专用模型，优先于部署默认模型（不填则与 Web 对话一致）'),
  autoStartWecom: Schema.boolean().default(true).description('启动时自动用已保存的企业微信智能机器人凭据建立常驻连接'),
  autoStartTelegram: Schema.boolean().default(true).description('启动时自动用已保存的 Telegram 凭据建立常驻连接'),
  autoStartDiscord: Schema.boolean().default(true).description('启动时自动用已保存的 Discord 凭据建立常驻连接'),
  autoStartQQ: Schema.boolean().default(true).description('启动时自动用已保存的 QQ 凭据建立常驻连接'),
  autoStartEmail: Schema.boolean().default(true).description('启动时自动用已保存的 Email 凭据建立常驻连接（IMAP 轮询）'),
  groupReply: Schema.boolean().default(true).description('是否回复群聊消息（false 时只处理单聊）'),
})