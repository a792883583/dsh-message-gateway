/** host 与 client 共享的类型定义。 */

/** 支持的平台标识。 */
export type PlatformId =
  | 'telegram' | 'discord' | 'qq' | 'wecom' | 'wecom-aibot' | 'wechat' | 'wechat-mp' | 'whatsapp' | 'email' | 'webhooks'

/** 平台凭据字段。 */
export interface PlatformField {
  key: string
  labelKey: string
  placeholderKey?: string
  /** text = 明文（如 corpid）；secret = 密码框（token）；number = 数字。 */
  kind: 'text' | 'secret' | 'number'
}

/** 平台静态定义。 */
export interface PlatformDef {
  id: PlatformId
  nameKey: string
  /** 展示图标（emoji）。 */
  icon: string
  fields: PlatformField[]
  /** 是否有连接测试。 */
  testable: boolean
  /** 说明文案 key（如微信需要第三方框架）。 */
  hintKey?: string
}

/** 平台连接状态。 */
export type PlatformState = 'none' | 'connecting' | 'connected' | 'error' | 'manual'

/** 平台状态视图（不含凭据明文）。 */
export interface PlatformStatus {
  id: PlatformId
  /** 已保存过凭据。 */
  configured: boolean
  state: PlatformState
  /** 测试返回信息（机器人用户名 / 错误消息）。 */
  detail: string
  testedAt: number | null
}

/** 网关完整视图。 */
export interface GatewayView {
  platforms: PlatformDef[]
  status: Record<string, PlatformStatus>
}

/** 连接测试结果。 */
export interface TestResult {
  ok: boolean
  detail: string
}
