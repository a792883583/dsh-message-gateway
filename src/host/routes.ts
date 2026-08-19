/**
 * /gateway/* 路由层：平台列表视图（含状态）、凭据保存 / 删除、连接测试。
 * 凭据明文只进存储文件，绝不回传客户端（list 只返回 configured 标记）。
 * @module dsh-message-gateway/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { GatewayView, PlatformStatus, TestResult } from '../core/types.ts'
import { loadStore, saveStore } from './gateway-store.ts'
import type { BridgeManager } from './bridge-manager.ts'
import { platformDef, PLATFORMS, testPlatform } from './platforms.ts'
import { WecomAppBridge, WechatMpBridge, WhatsappBridge, xmlEncrypt, callbackIdentity } from './callback-bridges.ts'
import { QqWebhookBridge } from './qq-bridge.ts'

type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

const BODY_CAP_BYTES = 1 << 20

/** 回调型平台在插件内的端点路径（用户配置到对应平台后台的公网 URL 后缀）。 */
export const CALLBACK_PATHS: Record<string, string> = {
  wecom: '/gateway/wecom/callback',
  'wechat-mp': '/gateway/wechat-mp/callback',
  whatsapp: '/gateway/whatsapp/webhook',
  qq: '/gateway/qq/callback',
}

/** 读取请求体：返回原始文本（供 HMAC 签名校验）与解析后的 JSON。 */
async function readJsonBody(req: IncomingMessage): Promise<{ raw: string; json: unknown }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const part = chunk as Buffer
    total += part.length
    if (total > BODY_CAP_BYTES) {
      req.destroy()
      return { raw: '', json: null }
    }
    chunks.push(part)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  let json: unknown = null
  if (raw !== '') {
    try {
      json = JSON.parse(raw) as unknown
    } catch {
      json = null
    }
  }
  return { raw, json }
}

/** HMAC-SHA256 签名校验（hex，constant-time 比较）。 */
function validSignature(secret: string, raw: string, header: string | undefined): boolean {
  if (header === undefined || header === '') return false
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest('hex')
  const a = Buffer.from(header.toLowerCase(), 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(res: ServerResponse, envelope: Envelope<unknown>, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/** 组装视图：平台定义 + 状态（不含凭据；桥接平台合并实时连接状态）。 */
async function buildView(manager: BridgeManager): Promise<GatewayView> {
  const store = await loadStore()
  const status: Record<string, PlatformStatus> = {}
  for (const def of PLATFORMS) {
    const stored = store.statuses[def.id]
    const configured = store.platforms[def.id] !== undefined
    let state: PlatformStatus['state'] = stored?.state ?? (def.id === 'wechat' || def.id === 'webhooks' ? 'manual' : 'none')
    let detail = stored?.detail ?? ''
    let testedAt = stored?.testedAt ?? null
    if (def.id === 'wecom-aibot' || def.id === 'telegram' || def.id === 'discord' || def.id === 'qq' || def.id === 'email') {
      const merged = manager.mergeStatus(stored, def.id)
      state = merged.state
      detail = merged.detail
      testedAt = merged.testedAt
    }
    // 回调型平台：凭据就绪即视为可用，详情展示回调端点路径（供配置后台）。
    if (def.id === 'wecom' || def.id === 'wechat-mp' || def.id === 'whatsapp') {
      if (configured) {
        state = stored?.state === 'error' ? 'error' : 'connected'
        detail = stored?.state !== 'none' && stored?.detail !== '' ? (stored?.detail ?? '') : (CALLBACK_PATHS[def.id] ?? '')
        testedAt = stored?.testedAt ?? testedAt
      } else {
        state = 'none'
      }
    }
    status[def.id] = { id: def.id, configured, state, detail, testedAt }
  }
  return { platforms: PLATFORMS, status }
}

/** 回调型平台端点：GET 验证 / POST 接收消息 → 统一管线。 */
async function handleCallbackRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
  manager: BridgeManager,
): Promise<void> {
  const store = await loadStore()
  try {
    if (path === '/gateway/wecom/callback') {
      const cred = store.platforms.wecom
      if (cred === undefined || cred.token === '' || cred.encodingAESKey === '') {
        json(res, { ok: false, error: { code: 'internal', message: 'wecom callback not configured' } }, 400)
        return
      }
      const bridge = new WecomAppBridge(cred.corpId ?? '', cred.agentId ?? '', cred.secret ?? '', cred.token, cred.encodingAESKey)
      if (req.method === 'GET') {
        const msgSignature = query.get('msg_signature') ?? ''
        const timestamp = query.get('timestamp') ?? ''
        const nonce = query.get('nonce') ?? ''
        const echostr = query.get('echostr') ?? ''
        if (!bridge.verifySignature(msgSignature, timestamp, nonce, echostr)) {
          json(res, { ok: false, error: { code: 'internal', message: 'signature mismatch' } }, 403)
          return
        }
        try {
          const decrypted = bridge.decrypt(echostr)
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(decrypted.message)
        } catch {
          json(res, { ok: false, error: { code: 'internal', message: 'decrypt failed' } }, 403)
        }
        return
      }
      const { raw } = await readJsonBody(req)
      const msgSignature = query.get('msg_signature') ?? ''
      const timestamp = query.get('timestamp') ?? ''
      const nonce = query.get('nonce') ?? ''
      if (!bridge.verifySignature(msgSignature, timestamp, nonce, xmlEncrypt(raw))) {
        json(res, { ok: false, error: { code: 'internal', message: 'signature mismatch' } }, 403)
        return
      }
      try {
        const decrypted = bridge.decrypt(xmlEncrypt(raw))
        const { from, text } = bridge.parseMessage(decrypted.message)
        if (from !== '' && text.trim() !== '') {
          const identity = callbackIdentity(`wecom-app:user:${from}`, (content) => bridge.sendText(from, content))
          void manager.handleExternalMessage(identity, text)
        }
      } catch (error) {
        console.error('[dsh-message-gateway] wecom-app callback decrypt failed', error)
      }
      // 立即 200（空响应）：AI 回复经应用消息 API 异步送达。
      json(res, { ok: true, value: null })
      return
    }
    if (path === '/gateway/wechat-mp/callback') {
      const cred = store.platforms['wechat-mp']
      if (cred === undefined || cred.token === '') {
        json(res, { ok: false, error: { code: 'internal', message: 'wechat-mp callback not configured' } }, 400)
        return
      }
      const bridge = new WechatMpBridge(cred.appId ?? '', cred.secret ?? '', cred.token)
      if (req.method === 'GET') {
        const signature = query.get('signature') ?? ''
        const timestamp = query.get('timestamp') ?? ''
        const nonce = query.get('nonce') ?? ''
        const echostr = query.get('echostr') ?? ''
        if (!bridge.verifySignature(signature, timestamp, nonce)) {
          json(res, { ok: false, error: { code: 'internal', message: 'signature mismatch' } }, 403)
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(echostr)
        return
      }
      const { raw } = await readJsonBody(req)
      const signature = query.get('signature') ?? ''
      const timestamp = query.get('timestamp') ?? ''
      const nonce = query.get('nonce') ?? ''
      if (!bridge.verifySignature(signature, timestamp, nonce)) {
        json(res, { ok: false, error: { code: 'internal', message: 'signature mismatch' } }, 403)
        return
      }
      const parsed = bridge.parseMessage(raw)
      if (parsed.msgType === 'text' && parsed.from !== '' && parsed.text.trim() !== '') {
        const identity = callbackIdentity(`wechat-mp:user:${parsed.from}`, (content) => bridge.sendText(parsed.from, content))
        void manager.handleExternalMessage(identity, parsed.text)
      }
      json(res, { ok: true, value: null })
      return
    }
    if (path === '/gateway/whatsapp/webhook') {
      const cred = store.platforms.whatsapp
      if (cred === undefined || cred.token === '' || cred.phoneId === '') {
        json(res, { ok: false, error: { code: 'internal', message: 'whatsapp not configured' } }, 400)
        return
      }
      const bridge = new WhatsappBridge(cred.token, cred.phoneId)
      if (req.method === 'GET') {
        const challenge = bridge.verifyChallenge({
          mode: query.get('hub.mode') ?? undefined,
          verify_token: query.get('hub.verify_token') ?? undefined,
          challenge: query.get('hub.challenge') ?? undefined,
        })
        if (challenge === null) {
          json(res, { ok: false, error: { code: 'internal', message: 'verify token mismatch' } }, 403)
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(challenge)
        return
      }
      const { json: payload } = await readJsonBody(req)
      const parsed = bridge.parseWebhook(payload)
      if (parsed !== null) {
        const identity = callbackIdentity(`whatsapp:${parsed.from}`, (content) => bridge.sendText(parsed.from, content))
        void manager.handleExternalMessage(identity, parsed.text)
      }
      json(res, { ok: true, value: null })
      return
    }
    if (path === '/gateway/qq/callback') {
      const cred = store.platforms.qq
      if (cred === undefined || cred.callbackToken === '') {
        json(res, { ok: false, error: { code: 'internal', message: 'qq callback not configured' } }, 400)
        return
      }
      const bridge = new QqWebhookBridge(cred.appId ?? '', cred.secret ?? '', cred.callbackToken, {
        onText: (text, identity) => void manager.handleExternalMessage(identity, text),
      })
      const { raw, json: payload } = await readJsonBody(req)
      const body = (payload ?? {}) as { op?: number; d?: unknown; t?: unknown }
      if (body.op === 13) {
        // 回调地址验证握手：返回 plain_token + ed25519 签名（裸 JSON，非 Envelope）。
        const validated = bridge.validate((body.d ?? {}) as { plain_token?: unknown; event_ts?: unknown })
        if (validated === null) {
          json(res, { ok: false, error: { code: 'internal', message: 'bad validation payload' } }, 400)
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(validated))
        return
      }
      // 事件推送：验签（X-Signature-Ed25519 / X-Signature-Timestamp + 原始 body）。
      const signature = req.headers['x-signature-ed25519']
      const timestamp = req.headers['x-signature-timestamp']
      if (typeof signature !== 'string' || typeof timestamp !== 'string' || !bridge.verifySignature(raw, signature, timestamp)) {
        json(res, { ok: false, error: { code: 'internal', message: 'signature mismatch' } }, 403)
        return
      }
      bridge.handleEvent(body)
      // 立即 200：回复经被动消息 API 异步送达。
      json(res, { ok: true, value: null })
      return
    }
    json(res, { ok: false, error: { code: 'internal', message: 'unknown callback route' } }, 404)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    json(res, { ok: false, error: { code: 'internal', message } })
  }
}

/** 校验并提取字段（只取平台定义中的字段，丢弃多余键）。 */
function extractCredentials(defId: string, payload: unknown): Record<string, string> {
  const def = platformDef(defId)
  if (def === undefined) throw new Error('unknown platform')
  const out: Record<string, string> = {}
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    for (const field of def.fields) {
      const value = record[field.key]
      if (typeof value === 'string') out[field.key] = value
    }
  }
  return out
}

/** 挂载 /gateway 路由。 */
export function registerGatewayRoutes(ctx: Context, manager: BridgeManager): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/gateway',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh')
      const path = url.pathname

      // 回调型平台端点（GET 验证 / POST 接收消息），先于 POST-only 检查。
      if (
        path === '/gateway/wecom/callback' ||
        path === '/gateway/wechat-mp/callback' ||
        path === '/gateway/whatsapp/webhook' ||
        path === '/gateway/qq/callback'
      ) {
        await handleCallbackRoute(req, res, path, url.searchParams, manager)
        return
      }

      if (req.method !== 'POST') {
        json(res, { ok: false, error: { code: 'internal', message: 'method not allowed' } }, 405)
        return
      }
      const { raw, json: payload } = await readJsonBody(req)

      const fail = (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error)
        json(res, { ok: false, error: { code: 'internal', message } })
      }

      try {
        if (path === '/gateway/webhook/in') {
          // Webhook 接收端点：配置了签名密钥时校验 X-Gateway-Signature（HMAC-SHA256 hex）。
          const store = await loadStore()
          const secret = store.platforms.webhooks?.secret ?? ''
          if (secret !== '') {
            const signature = req.headers['x-gateway-signature']
            if (typeof signature !== 'string' || !validSignature(secret, raw, signature)) {
              json(res, { ok: false, error: { code: 'internal', message: 'invalid signature' } }, 401)
              return
            }
          }
          const body = payload as { text?: unknown; content?: unknown; message?: unknown } | null
          const text =
            [body?.text, body?.content, body?.message]
              .map((value) => (typeof value === 'string' ? value : ''))
              .find((value) => value.trim() !== '') ?? ''
          if (text === '') {
            json(res, { ok: false, error: { code: 'internal', message: 'missing text' } }, 400)
            return
          }
          // 注入专用 agent 会话并同步等待完整回复。
          const result = await manager.sendAndWait(text)
          if (!result.ok) {
            json(res, { ok: false, error: { code: 'internal', message: result.reply } }, 409)
            return
          }
          json(res, { ok: true, value: { reply: result.reply } })
          return
        }
        if (path === '/gateway/wechat-status') {
          const store = await loadStore()
          const cred = store.platforms.wechat ?? {}
          const base = (cred.gatewayUrl ?? '').trim().replace(/\/$/, '')
          if (base === '') {
            json(res, { ok: true, value: { configured: false, loggedIn: false, name: '', qrcode: null, qrcodeUrl: null, error: '' } })
            return
          }
          // 轮询本机 Wechaty HTTP 网关（契约见 docs/wechaty-gateway.md：GET /status）。
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 8000)
          try {
            const headers: Record<string, string> = { accept: 'application/json' }
            if (typeof cred.token === 'string' && cred.token !== '') headers.authorization = `Bearer ${cred.token}`
            const response = await fetch(`${base}/status`, { headers, signal: controller.signal })
            if (!response.ok) {
              json(res, { ok: true, value: { configured: true, loggedIn: false, name: '', qrcode: null, qrcodeUrl: null, error: `HTTP ${response.status}` } })
              return
            }
            const r = (await response.json()) as {
              loggedIn?: boolean; name?: string; qrcode?: string | null; qrcodeUrl?: string | null
            }
            json(res, {
              ok: true,
              value: {
                configured: true,
                loggedIn: r.loggedIn === true,
                name: r.name ?? '',
                qrcode: typeof r.qrcode === 'string' && r.qrcode !== '' ? r.qrcode : null,
                qrcodeUrl: typeof r.qrcodeUrl === 'string' && r.qrcodeUrl !== '' ? r.qrcodeUrl : null,
                error: '',
              },
            })
          } catch (error) {
            json(res, {
              ok: true,
              value: { configured: true, loggedIn: false, name: '', qrcode: null, qrcodeUrl: null, error: error instanceof Error ? error.message : String(error) },
            })
          } finally {
            clearTimeout(timer)
          }
          return
        }
        if (path === '/gateway/send') {
          // 主动发送通道：以机器人身份向会话发送 markdown 消息（单聊=userid，群聊=群 ID）。
          const body = payload as { chatid?: unknown; content?: unknown } | null
          const chatid = typeof body?.chatid === 'string' ? body.chatid.trim() : ''
          const content = typeof body?.content === 'string' ? body.content.trim() : ''
          if (chatid === '' || content === '') {
            json(res, { ok: false, error: { code: 'internal', message: 'missing chatid/content' } }, 400)
            return
          }
          const sent = await manager.sendToChat(chatid, content)
          if (!sent) {
            json(res, { ok: false, error: { code: 'internal', message: 'send failed (bridge not connected?)' } }, 409)
            return
          }
          json(res, { ok: true, value: { sent: true } })
          return
        }
        if (path === '/gateway/list') {
          json(res, { ok: true, value: await buildView(manager) })
          return
        }
        if (path === '/gateway/save' || path === '/gateway/delete' || path === '/gateway/test') {
          const platform = (payload as { platform?: unknown } | null)?.platform
          if (typeof platform !== 'string') {
            json(res, { ok: false, error: { code: 'internal', message: 'missing platform' } })
            return
          }
          const store = await loadStore()
          if (path === '/gateway/delete') {
            delete store.platforms[platform]
            delete store.statuses[platform]
            await saveStore(store)
            if (platform === 'wecom-aibot') manager.stopWecom()
            if (platform === 'telegram') manager.stopTelegram()
            if (platform === 'discord') manager.stopDiscord()
            if (platform === 'qq') manager.stopQQ()
            if (platform === 'email') manager.stopEmail()
            json(res, { ok: true, value: await buildView(manager) })
            return
          }
          if (path === '/gateway/save') {
            const credentials = extractCredentials(platform, payload)
            const def = platformDef(platform)
            if (def !== undefined && def.fields.length > 0 && Object.keys(credentials).length === 0) {
              json(res, { ok: false, error: { code: 'internal', message: 'empty credentials' } })
              return
            }
            store.platforms[platform] = credentials
            // 保存后清除旧测试状态，等待重新测试。
            delete store.statuses[platform]
            await saveStore(store)
            // 保存即启动常驻桥（凭据完整时）；清空凭据则停止。
            if (platform === 'wecom-aibot') {
              if (credentials.botId !== '' && credentials.secret !== '') {
                manager.startWecom({ botId: credentials.botId, secret: credentials.secret })
              } else {
                manager.stopWecom()
              }
            }
            if (platform === 'telegram') {
              if (credentials.token !== undefined && credentials.token !== '') manager.startTelegram(credentials)
              else manager.stopTelegram()
            }
            if (platform === 'discord') {
              if (credentials.token !== undefined && credentials.token !== '') manager.startDiscord(credentials)
              else manager.stopDiscord()
            }
            if (platform === 'qq') {
              if (credentials.appId !== undefined && credentials.appId !== '' && credentials.secret !== undefined && credentials.secret !== '') {
                manager.startQQ(credentials)
              } else {
                manager.stopQQ()
              }
            }
            if (platform === 'email') {
              if (credentials.imapHost !== undefined && credentials.imapHost !== '' && credentials.imapUser !== undefined && credentials.imapUser !== '') {
                manager.startEmail(credentials)
              } else {
                manager.stopEmail()
              }
            }
            json(res, { ok: true, value: await buildView(manager) })
            return
          }
          // /gateway/test：优先用请求携带的凭据（只测不存），否则用已保存的。
          const submitted = extractCredentials(platform, payload)
          const hasSubmitted = Object.keys(submitted).length > 0
          const credentials = hasSubmitted ? submitted : (store.platforms[platform] ?? {})
          const result: TestResult = await testPlatform(platform, credentials)
          const stored = {
            state: result.ok ? ('connected' as const) : ('error' as const),
            detail: result.detail,
            testedAt: Date.now(),
          }
          store.statuses[platform] = stored
          await saveStore(store)
          json(res, { ok: true, value: { ok: result.ok, detail: result.detail } })
          return
        }
        json(res, { ok: false, error: { code: 'internal', message: 'unknown route' } }, 404)
      } catch (error) {
        fail(error)
      }
    },
  })
}
