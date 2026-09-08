/**
 * 三语文案（中 / 英 / 西）。语言自动检测：优先跟随 DSH 平台语言（zh → 简体中文），
 * 其次浏览器语言（es → 西班牙语），其余默认简体中文。
 * @module dsh-message-gateway/client/i18n
 */

import { useSyncExternalStore } from 'react'

export type Lang = 'zh' | 'en' | 'es'

type Dict = Record<string, string>

const DICTS: Record<Lang, Dict> = {
  zh: {
    'gateway.title': '消息平台',
    'gateway.open': '打开消息平台',
    'gateway.close': '关闭',
    'gateway.save': '保存',
    'gateway.test': '测试连接',
    'gateway.testing': '测试中…',
    'gateway.delete': '删除配置',
    'gateway.saved': '已保存',
    'gateway.deleted': '已删除',
    'gateway.testing.result': '测试结果',
    'gateway.status.connected': '已连接',
    'gateway.status.connecting': '连接中',
    'gateway.status.error': '连接失败',
    'gateway.status.none': '未配置',
    'gateway.status.manual': '手动模式',
    'gateway.updatedAt': '最近测试',
    'platform.telegram': 'Telegram',
    'platform.discord': 'Discord',
    'platform.qq': 'QQ 机器人',
    'platform.qq.hint': '支持两种接入方式（控制台二选一）：① WebSocket 长连接——保存 AppID+Secret 即自动连接；② Webhook 回调——需公网 HTTPS 地址指向 /gateway/qq/callback（控制台允许 80/443/8080/8443），并填回调 Token。回复经被动消息 API 发送。',
    'platform.wecom': '企业微信',
    'platform.wecom.hint': '回调式接入：在企业微信管理后台「应用 → 接收消息」配置回调 URL（需公网可访问，指向 /gateway/wecom/callback）并填入 Token 与 EncodingAESKey，用户给应用发消息即可自动对话。',
    'platform.wecomAibot': '企业微信 · 智能机器人',
    'platform.wecomAibot.hint': '使用官方 SDK 长连接（WebSocket），配置 Bot ID 与 Secret 即可连接智能机器人。',
    'field.botId': 'Bot ID',
    'platform.wechat': '微信',
    'platform.wechatMp': '微信公众号',
    'platform.wechatMp.hint': '回调式接入：在公众号后台「设置与开发 → 基本配置」配置服务器 URL（需公网可访问，指向 /gateway/wechat-mp/callback）并填入 Token，关注用户发消息即可自动对话。',
    'platform.whatsapp': 'WhatsApp',
    'platform.whatsapp.hint': 'Webhook 接入：在 Meta WhatsApp 开发者后台把 Webhook 指向 /gateway/whatsapp/webhook，验证 Token 填此处的 Token；用户发消息即自动对话。',
    'platform.email': 'Email',
    'platform.email.hint': 'IMAP 轮询收件（993 隐式 TLS / 143 STARTTLS）+ SMTP 回复（465 隐式 TLS / 587、25 STARTTLS）。按邮件线程自动归类会话，回复用 Re: 原主题；SMTP 留空时复用 IMAP 服务器与账号。',
    'platform.dingtalk': '钉钉机器人',
    'platform.dingtalk.hint': '在钉钉开发者后台创建企业自建应用，在「凭证与基础信息」中复制 Client ID (AppKey) 与 Client Secret (AppSecret)；在「应用能力 → 机器人」中开启机器人并复制 RobotCode，即可实现免公网 IP 的 Stream 长连接双向对话！',
    'field.dingtalkClientId': 'Client ID (AppKey)',
    'field.dingtalkClientId.ph': '如：dingxxxxxxxxxxxx',
    'field.dingtalkClientSecret': 'Client Secret (AppSecret)',
    'field.dingtalkClientSecret.ph': '输入应用密钥 Client Secret',
    'field.dingtalkRobotCode': 'RobotCode (机器人标识)',
    'field.dingtalkRobotCode.ph': '开发者后台机器人配置中的 RobotCode',
    'platform.feishu': '飞书机器人',
    'platform.feishu.hint': '在飞书开放平台创建企业自建应用，在「凭证与基础信息」中复制 App ID 与 App Secret；开启机器人能力并配置长连接事件订阅，即可实现免公网 IP 的实时双向对话！',
    'field.feishuAppId': 'App ID',
    'field.feishuAppId.ph': '如：cli_a92c71ed65785bc7',
    'field.feishuAppSecret': 'App Secret',
    'field.feishuAppSecret.ph': '输入应用密钥 App Secret',
    'platform.bark': 'Bark (iOS 极简推送)',
    'platform.bark.hint': '苹果 iOS 设备安装 Bark App，填入生成的 Device Key（或自建服务器地址），即可向手机秒级推送实时通知。',
    'field.barkServer': '自建服务器 (留空默认官方 https://api.day.app)',
    'field.barkServer.ph': 'https://api.day.app',
    'field.barkKey': 'Device Key',
    'field.barkKey.ph': '粘贴 Bark 提供的设备 Key',
    'platform.serverchan': 'Server酱 (Turbo版)',
    'platform.serverchan.hint': '通过 Server酱 推送消息至微信 / 手机服务号。前往 sct.ftqq.com 获取 SendKey 即可。',
    'field.serverchanKey': 'SendKey',
    'field.serverchanKey.ph': 'SCTxxxxxxxxxxxx',
    'platform.webhooks': 'Webhooks',
    'platform.wechat.hint': '微信个人号需第三方框架（如 Wechaty）扫码登录，本插件暂未内置连接器。',
    'platform.webhooks.hint': 'Webhook 无需凭据即可启用；可设置签名密钥用于校验请求。接收端点：POST /gateway/webhook/in，请求体 {"text": "..."}（text / content / message 任一字段）。',
    'field.token': 'Bot Token',
    'field.token.ph': '粘贴机器人 Token',
    'field.secret': '密钥',
    'field.secret.ph': '粘贴密钥',
    'field.appId': 'App ID',
    'field.callbackToken': '回调 Token',
    'field.qqCallbackToken': '回调 Token（Webhook 方式）',
    'field.encodingAESKey': 'EncodingAESKey',
    'field.corpId': '企业 ID (CorpID)',
    'field.agentId': '应用 ID (AgentID)',
    'field.phoneId': 'Phone Number ID',
    'field.imapHost': 'IMAP 服务器',
    'field.imapPort': 'IMAP 端口',
    'field.imapUser': '邮箱账号',
    'field.imapPass': '邮箱密码 / 授权码',
    'field.smtpHost': 'SMTP 服务器（可留空复用 IMAP）',
    'field.smtpPort': 'SMTP 端口',
    'field.smtpUser': 'SMTP 账号',
    'field.smtpPass': 'SMTP 密码 / 授权码',
    'field.webhookSecret': '签名密钥（可选）',
  },
  en: {
    'gateway.title': 'Message platforms',
    'gateway.open': 'Open message platforms',
    'gateway.close': 'Close',
    'gateway.save': 'Save',
    'gateway.test': 'Test connection',
    'gateway.testing': 'Testing…',
    'gateway.delete': 'Delete config',
    'gateway.saved': 'Saved',
    'gateway.deleted': 'Deleted',
    'gateway.testing.result': 'Test result',
    'gateway.status.connected': 'Connected',
    'gateway.status.connecting': 'Connecting',
    'gateway.status.error': 'Connection failed',
    'gateway.status.none': 'Not configured',
    'gateway.status.manual': 'Manual mode',
    'gateway.updatedAt': 'Last test',
    'platform.telegram': 'Telegram',
    'platform.discord': 'Discord',
    'platform.qq': 'QQ Bot',
    'platform.qq.hint': 'Two delivery modes (pick one in the console): ① WebSocket long-connection — save AppID+Secret to connect automatically; ② Webhook callback — needs a public HTTPS URL pointing at /gateway/qq/callback (console allows ports 80/443/8080/8443) plus the callback token. Replies go through the passive message API.',
    'platform.wecom': 'WeCom',
    'platform.wecom.hint': 'Callback style: in the WeCom admin console (App → Receive messages) point the callback URL (publicly reachable) at /gateway/wecom/callback and fill in the Token and EncodingAESKey; users who message the app get auto replies.',
    'platform.wecomAibot': 'WeCom · AI Bot',
    'platform.wecomAibot.hint': 'Uses the official SDK long connection (WebSocket): configure Bot ID and Secret to connect the AI bot.',
    'field.botId': 'Bot ID',
    'platform.wechat': 'WeChat',
    'platform.wechatMp': 'WeChat Official Account',
    'platform.wechatMp.hint': 'Callback style: in the Official Account console (Settings & Development → Basic config) point the server URL (publicly reachable) at /gateway/wechat-mp/callback and fill in the Token; followers who message get auto replies.',
    'platform.whatsapp': 'WhatsApp',
    'platform.whatsapp.hint': 'Webhook style: in the Meta WhatsApp developer console point the webhook at /gateway/whatsapp/webhook and use this Token as the verify token; users who message get auto replies.',
    'platform.email': 'Email',
    'platform.email.hint': 'Receives via IMAP polling (993 implicit TLS / 143 STARTTLS) and replies via SMTP (465 implicit TLS / 587, 25 STARTTLS). Messages are grouped into per-thread sessions; replies use Re: original subject; leave SMTP empty to reuse the IMAP server and account.',
    'platform.webhooks': 'Webhooks',
    'platform.wechat.hint': 'WeChat personal accounts need a third-party framework (e.g. Wechaty) with QR login; this plugin does not bundle a connector yet.',
    'platform.webhooks.hint': 'Webhooks work without credentials; an optional signing secret validates incoming requests. Receive endpoint: POST /gateway/webhook/in with body {"text": "..."} (any of text / content / message).',
    'field.token': 'Bot token',
    'field.token.ph': 'Paste the bot token',
    'field.secret': 'Secret',
    'field.secret.ph': 'Paste the secret',
    'field.appId': 'App ID',
    'field.callbackToken': 'Callback token',
    'field.qqCallbackToken': 'Callback token (Webhook mode)',
    'field.encodingAESKey': 'EncodingAESKey',
    'field.corpId': 'Corp ID',
    'field.agentId': 'Agent ID',
    'field.phoneId': 'Phone number ID',
    'field.imapHost': 'IMAP host',
    'field.imapPort': 'IMAP port',
    'field.imapUser': 'Email account',
    'field.imapPass': 'Email password / app password',
    'field.smtpHost': 'SMTP host (empty = reuse IMAP)',
    'field.smtpPort': 'SMTP port',
    'field.smtpUser': 'SMTP account',
    'field.smtpPass': 'SMTP password / app password',
    'field.webhookSecret': 'Signing secret (optional)',
    'platform.feishu': 'Feishu Bot',
    'platform.feishu.hint': 'Create a custom app on Feishu Open Platform, copy App ID and App Secret from "Credentials & Basic Info"; enable Bot capability and WebSocket event subscription for instant two-way chat without public IP.',
    'field.feishuAppId': 'App ID',
    'field.feishuAppId.ph': 'e.g. cli_a92c71ed65785bc7',
    'field.feishuAppSecret': 'App Secret',
    'field.feishuAppSecret.ph': 'Enter Feishu App Secret',
    'platform.dingtalk': 'DingTalk Bot',
    'platform.dingtalk.hint': 'Create an internal app on DingTalk Open Platform, copy Client ID (AppKey) and Client Secret (AppSecret) from "Credentials & Basic Info"; enable Robot capability and copy RobotCode to start Stream mode two-way chat without public IP.',
    'field.dingtalkClientId': 'Client ID (AppKey)',
    'field.dingtalkClientId.ph': 'e.g. dingxxxxxxxxxxxx',
    'field.dingtalkClientSecret': 'Client Secret (AppSecret)',
    'field.dingtalkClientSecret.ph': 'Enter DingTalk Client Secret',
    'field.dingtalkRobotCode': 'RobotCode',
    'field.dingtalkRobotCode.ph': 'RobotCode from Developer Console',
  },
  es: {
    'gateway.title': 'Plataformas de mensajería',
    'gateway.open': 'Abrir plataformas de mensajería',
    'gateway.close': 'Cerrar',
    'gateway.save': 'Guardar',
    'gateway.test': 'Probar conexión',
    'gateway.testing': 'Probando…',
    'gateway.delete': 'Eliminar configuración',
    'gateway.saved': 'Guardado',
    'gateway.deleted': 'Eliminado',
    'gateway.testing.result': 'Resultado de la prueba',
    'gateway.status.connected': 'Conectado',
    'gateway.status.connecting': 'Conectando',
    'gateway.status.error': 'Error de conexión',
    'gateway.status.none': 'No configurado',
    'gateway.status.manual': 'Modo manual',
    'gateway.updatedAt': 'Última prueba',
    'platform.telegram': 'Telegram',
    'platform.discord': 'Discord',
    'platform.qq': 'Bot de QQ',
    'platform.wecom': 'WeCom',
    'platform.wecom.hint': 'Estilo callback: en la consola de WeCom (App → Recibir mensajes) apunte la URL de callback (accesible públicamente) a /gateway/wecom/callback y rellene el Token y el EncodingAESKey; los usuarios que escriban al app reciben respuestas automáticas.',
    'platform.wecomAibot': 'WeCom · Bot de IA',
    'platform.wecomAibot.hint': 'Usa la conexión larga del SDK oficial (WebSocket): configura el Bot ID y el Secret para conectar el bot de IA.',
    'field.botId': 'Bot ID',
    'platform.wechat': 'WeChat',
    'platform.wechatMp': 'Cuenta oficial de WeChat',
    'platform.wechatMp.hint': 'Estilo callback: en la consola de la Cuenta oficial (Configuración y desarrollo → Configuración básica) apunte la URL del servidor (accesible públicamente) a /gateway/wechat-mp/callback y rellene el Token; los seguidores que escriban reciben respuestas automáticas.',
    'platform.whatsapp': 'WhatsApp',
    'platform.whatsapp.hint': 'Estilo webhook: en la consola de Meta WhatsApp apunte el webhook a /gateway/whatsapp/webhook y use este Token como token de verificación; los usuarios que escriban reciben respuestas automáticas.',
    'platform.email': 'Email',
    'platform.email.hint': 'Recibe por sondeo IMAP (993 TLS implícito / 143 STARTTLS) y responde por SMTP (465 TLS implícito / 587, 25 STARTTLS). Los mensajes se agrupan en sesiones por hilo; las respuestas usan Re: asunto original; deje SMTP vacío para reutilizar el servidor y la cuenta IMAP.',
    'platform.webhooks': 'Webhooks',
    'platform.wechat.hint': 'Las cuentas personales de WeChat necesitan un framework de terceros (p. ej. Wechaty) con inicio de sesión por QR; este plugin aún no incluye un conector.',
    'platform.webhooks.hint': 'Los webhooks funcionan sin credenciales; un secreto de firma opcional valida las peticiones entrantes. Endpoint de recepción: POST /gateway/webhook/in con cuerpo {"text": "..."} (cualquiera de text / content / message).',
    'field.token': 'Token del bot',
    'field.token.ph': 'Pega el token del bot',
    'field.secret': 'Secreto',
    'field.secret.ph': 'Pega el secreto',
    'field.appId': 'App ID',
    'field.callbackToken': 'Token de callback',
    'field.encodingAESKey': 'EncodingAESKey',
    'field.corpId': 'Corp ID',
    'field.agentId': 'Agent ID',
    'field.phoneId': 'Phone number ID',
    'field.imapHost': 'Servidor IMAP',
    'field.imapPort': 'Puerto IMAP',
    'field.imapUser': 'Cuenta de correo',
    'field.imapPass': 'Contraseña / contraseña de aplicación',
    'field.smtpHost': 'Servidor SMTP (vacío = reutilizar IMAP)',
    'field.smtpPort': 'Puerto SMTP',
    'field.smtpUser': 'Cuenta SMTP',
    'field.smtpPass': 'Contraseña SMTP / contraseña de aplicación',
    'field.webhookSecret': 'Secreto de firma (opcional)',
    'platform.feishu': 'Bot de Feishu',
    'platform.feishu.hint': 'Crea una aplicación personalizada en Feishu Open Platform, copia el App ID y App Secret desde "Credenciales e información básica"; habilita la funcionalidad de Bot y la suscripción de eventos por WebSocket para mensajería bidireccional instantánea sin IP pública.',
    'field.feishuAppId': 'App ID',
    'field.feishuAppId.ph': 'p. ej. cli_a92c71ed65785bc7',
    'field.feishuAppSecret': 'App Secret',
    'field.feishuAppSecret.ph': 'Ingresa el App Secret de Feishu',
    'platform.dingtalk': 'Bot de DingTalk',
    'platform.dingtalk.hint': 'Crea una aplicación interna en DingTalk Open Platform, copia el Client ID (AppKey) y Client Secret (AppSecret) desde "Credenciales e información básica"; habilita la capacidad de Bot y copia el RobotCode para iniciar el chat bidireccional por Stream sin IP pública.',
    'field.dingtalkClientId': 'Client ID (AppKey)',
    'field.dingtalkClientId.ph': 'p. ej. dingxxxxxxxxxxxx',
    'field.dingtalkClientSecret': 'Client Secret (AppSecret)',
    'field.dingtalkClientSecret.ph': 'Ingresa el Client Secret de DingTalk',
    'field.dingtalkRobotCode': 'RobotCode',
    'field.dingtalkRobotCode.ph': 'RobotCode de la consola de desarrolladores',
  },
}

/** 平台 locale 服务的结构面孔（见 index.ts）。 */
interface LocaleService {
  getLocale(): { active: string }
  subscribe(fn: () => void): () => void
}

let locale: LocaleService | null = null
let lang: Lang = 'zh'
let revision = 0
const listeners = new Set<() => void>()

function notify(): void {
  revision += 1
  for (const fn of listeners) fn()
}

function detectLang(): Lang {
  const active = locale?.getLocale().active
  if (active === 'zh') return 'zh'
  const nav = (navigator.language || '').toLowerCase()
  if (nav.startsWith('es')) return 'es'
  if (active === 'en') return 'en'
  if (nav.startsWith('zh')) return 'zh'
  return 'zh'
}

/** 接入平台 locale 服务；从 client 入口调用一次。 */
export function initI18n(service: LocaleService): void {
  if (locale === service) return
  locale = service
  lang = detectLang()
  service.subscribe(() => {
    const next = detectLang()
    if (next !== lang) {
      lang = next
      notify()
    }
  })
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const getSnapshot = (): number => revision

/** 翻译；缺失的 key 回退到中文。 */
export function t(key: string): string {
  return DICTS[lang][key] ?? DICTS.zh[key] ?? key
}

/** React hook：语言切换时触发重渲染；返回的 t() 为模块级稳定引用。 */
export function useT(): (key: string) => string {
  useSyncExternalStore(subscribe, getSnapshot)
  return t
}
