/**
 * 消息平台定义与连接测试。测试通过 Node 原生 fetch / net 完成，无第三方依赖。
 * @module dsh-message-gateway/host/platforms
 */

import { connect } from 'node:net'
import AiBot from '@wecom/aibot-node-sdk'
import type { PlatformDef, TestResult } from '../core/types.ts'

/** 全部平台定义（client 侧亦引用本表渲染表单）。 */
export const PLATFORMS: PlatformDef[] = [
  {
    id: 'telegram',
    nameKey: 'platform.telegram',
    icon: '✈️',
    testable: true,
    fields: [{ key: 'token', labelKey: 'field.token', placeholderKey: 'field.token.ph', kind: 'secret' }],
  },
  {
    id: 'discord',
    nameKey: 'platform.discord',
    icon: '🎮',
    testable: true,
    fields: [{ key: 'token', labelKey: 'field.token', placeholderKey: 'field.token.ph', kind: 'secret' }],
  },
  {
    id: 'qq',
    nameKey: 'platform.qq',
    icon: '💬',
    testable: true,
    hintKey: 'platform.qq.hint',
    fields: [
      { key: 'appId', labelKey: 'field.appId', kind: 'text' },
      { key: 'secret', labelKey: 'field.secret', placeholderKey: 'field.secret.ph', kind: 'secret' },
      { key: 'callbackToken', labelKey: 'field.qqCallbackToken', placeholderKey: 'field.secret.ph', kind: 'secret' },
    ],
  },
  {
    id: 'wecom',
    nameKey: 'platform.wecom',
    icon: '🏢',
    testable: true,
    hintKey: 'platform.wecom.hint',
    fields: [
      { key: 'corpId', labelKey: 'field.corpId', kind: 'text' },
      { key: 'agentId', labelKey: 'field.agentId', kind: 'text' },
      { key: 'secret', labelKey: 'field.secret', placeholderKey: 'field.secret.ph', kind: 'secret' },
      { key: 'token', labelKey: 'field.callbackToken', kind: 'text' },
      { key: 'encodingAESKey', labelKey: 'field.encodingAESKey', placeholderKey: 'field.secret.ph', kind: 'secret' },
    ],
  },
  {
    id: 'wecom-aibot',
    nameKey: 'platform.wecomAibot',
    icon: '🤖',
    testable: true,
    hintKey: 'platform.wecomAibot.hint',
    fields: [
      { key: 'botId', labelKey: 'field.botId', kind: 'text' },
      { key: 'secret', labelKey: 'field.secret', placeholderKey: 'field.secret.ph', kind: 'secret' },
    ],
  },
  {
    id: 'wechat',
    nameKey: 'platform.wechat',
    icon: '💚',
    testable: false,
    hintKey: 'platform.wechat.hint',
    fields: [
      { key: 'gatewayUrl', labelKey: 'field.gatewayUrl', placeholderKey: 'field.gatewayUrl.ph', kind: 'text' },
      { key: 'token', labelKey: 'field.token', placeholderKey: 'field.secret.ph', kind: 'secret' },
    ],
  },
  {
    id: 'wechat-mp',
    nameKey: 'platform.wechatMp',
    icon: '📰',
    testable: true,
    hintKey: 'platform.wechatMp.hint',
    fields: [
      { key: 'appId', labelKey: 'field.appId', kind: 'text' },
      { key: 'secret', labelKey: 'field.secret', placeholderKey: 'field.secret.ph', kind: 'secret' },
      { key: 'token', labelKey: 'field.callbackToken', kind: 'text' },
    ],
  },
  {
    id: 'whatsapp',
    nameKey: 'platform.whatsapp',
    icon: '🟢',
    testable: true,
    hintKey: 'platform.whatsapp.hint',
    fields: [
      { key: 'token', labelKey: 'field.token', placeholderKey: 'field.token.ph', kind: 'secret' },
      { key: 'phoneId', labelKey: 'field.phoneId', kind: 'text' },
    ],
  },
  {
    id: 'email',
    nameKey: 'platform.email',
    icon: '📧',
    testable: true,
    hintKey: 'platform.email.hint',
    fields: [
      { key: 'imapHost', labelKey: 'field.imapHost', kind: 'text' },
      { key: 'imapPort', labelKey: 'field.imapPort', kind: 'number' },
      { key: 'imapUser', labelKey: 'field.imapUser', kind: 'text' },
      { key: 'imapPass', labelKey: 'field.imapPass', placeholderKey: 'field.secret.ph', kind: 'secret' },
      { key: 'smtpHost', labelKey: 'field.smtpHost', kind: 'text' },
      { key: 'smtpPort', labelKey: 'field.smtpPort', kind: 'number' },
      { key: 'smtpUser', labelKey: 'field.smtpUser', kind: 'text' },
      { key: 'smtpPass', labelKey: 'field.smtpPass', placeholderKey: 'field.secret.ph', kind: 'secret' },
    ],
  },
  {
    id: 'webhooks',
    nameKey: 'platform.webhooks',
    icon: '🪝',
    testable: false,
    hintKey: 'platform.webhooks.hint',
    fields: [{ key: 'secret', labelKey: 'field.webhookSecret', placeholderKey: 'field.secret.ph', kind: 'secret' }],
  },
]

export function platformDef(id: string): PlatformDef | undefined {
  return PLATFORMS.find((p) => p.id === id)
}

/** 短超时 JSON GET/POST。 */
async function httpJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      /* 非 JSON 响应 */
    }
    return { status: response.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/** TCP banner 检查（IMAP/SMTP 服务可达性）。 */
function tcpBanner(host: string, port: number, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('')
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => { /* 等待 banner */ })
    socket.once('data', (chunk: string) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(String(chunk).trim().slice(0, 120))
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
  })
}

/** 各平台连接测试；未实现测试的平台返回 ok（凭据已保存视为已配置）。 */
export async function testPlatform(id: string, cred: Record<string, string>): Promise<TestResult> {
  switch (id) {
    case 'telegram': {
      const { status, body } = await httpJson(`https://api.telegram.org/bot${cred.token ?? ''}/getMe`)
      const r = body as { ok?: boolean; result?: { username?: string }; description?: string }
      if (status === 200 && r.ok === true && r.result !== undefined) {
        return { ok: true, detail: `@${r.result.username ?? ''}` }
      }
      return { ok: false, detail: (r.description ?? `HTTP ${status}`) }
    }
    case 'discord': {
      const { status, body } = await httpJson('https://discord.com/api/v10/users/@me', {
        headers: { authorization: `Bot ${cred.token ?? ''}` },
      })
      const r = body as { username?: string; message?: string }
      if (status === 200) return { ok: true, detail: r.username ?? 'ok' }
      return { ok: false, detail: (r.message ?? `HTTP ${status}`) }
    }
    case 'qq': {
      const { status, body } = await httpJson('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: cred.appId ?? '', clientSecret: cred.secret ?? '' }),
      })
      const r = body as { access_token?: string; message?: string; code?: number }
      if (status === 200 && r.access_token !== undefined) return { ok: true, detail: `appId ${cred.appId}` }
      return { ok: false, detail: (r.message ?? `HTTP ${status}`) }
    }
    case 'wecom-aibot': {
      // 官方 SDK 长连接：建立 WebSocket 并等待认证成功。
      const client = new AiBot.WSClient({ botId: cred.botId ?? '', secret: cred.secret ?? '' })
      return await new Promise<TestResult>((resolve) => {
        const timer = setTimeout(() => {
          client.disconnect()
          resolve({ ok: false, detail: '连接超时' })
        }, 12_000)
        client.on('authenticated', () => {
          clearTimeout(timer)
          client.disconnect()
          resolve({ ok: true, detail: `botId ${cred.botId ?? ''}` })
        })
        client.on('error', (err: Error) => {
          clearTimeout(timer)
          client.disconnect()
          resolve({ ok: false, detail: err?.message ?? '连接错误' })
        })
        client.connect()
      })
    }
    case 'wecom': {
      const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(cred.corpId ?? '')}&corpsecret=${encodeURIComponent(cred.secret ?? '')}`
      const { body } = await httpJson(url)
      const r = body as { errcode?: number; errmsg?: string; access_token?: string }
      if (r.errcode === 0 && r.access_token !== undefined) return { ok: true, detail: `corpId ${cred.corpId}` }
      return { ok: false, detail: (r.errmsg ?? '未知错误') }
    }
    case 'wechat-mp': {
      const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cred.appId ?? '')}&secret=${encodeURIComponent(cred.secret ?? '')}`
      const { body } = await httpJson(url)
      const r = body as { access_token?: string; errmsg?: string; errcode?: number }
      if (r.access_token !== undefined) return { ok: true, detail: `appId ${cred.appId}` }
      return { ok: false, detail: (r.errmsg ?? '未知错误') }
    }
    case 'whatsapp': {
      const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(cred.phoneId ?? '')}?access_token=${encodeURIComponent(cred.token ?? '')}`
      const { status, body } = await httpJson(url)
      const r = body as { name?: string; error?: { message?: string } }
      if (status === 200) return { ok: true, detail: (r.name ?? `phoneId ${cred.phoneId}`) }
      return { ok: false, detail: (r.error?.message ?? `HTTP ${status}`) }
    }
    case 'email': {
      const port = Number(cred.imapPort ?? '143')
      const banner = await tcpBanner(cred.imapHost ?? '', port)
      if (banner !== '' && /ok|ready|imap/i.test(banner)) {
        return { ok: true, detail: banner }
      }
      return { ok: false, detail: banner === '' ? `无法连接 ${cred.imapHost}:${port}` : banner }
    }
    default:
      return { ok: true, detail: 'configured' }
  }
}
