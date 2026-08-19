/**
 * QQ 机器人桥（开放平台 API v2，单聊/群聊）：appId+secret → access_token → WSS 长连接。
 * 协议要点（官方文档）：
 * - 网关地址：GET https://api.bot.qq.com/gateway → { url: 'wss://api.sgroup.qq.com/websocket' }
 * - 鉴权：Identify 的 token 格式为 `QQBot {access_token}`，intents 1<<25（GROUP_AND_C2C_EVENT）
 * - 事件：C2C_MESSAGE_CREATE（单聊）/ GROUP_AT_MESSAGE_CREATE（群@，content 已去 @前缀）
 * - 回复：POST /v2/users/{user_openid}/messages（单聊）/ /v2/groups/{group_openid}/messages（群聊），
 *   带 msg_id 被动回复；群聊不支持流式参数，故整条回复一次发出。
 * @module dsh-message-gateway/host/qq-bridge
 */

import type { BridgeStatus } from './wecom-bridge.ts'
import type { ChatIdentity, ReplySink } from './bridge-manager.ts'
import { createPrivateKey, sign, verify, type KeyObject } from 'node:crypto'

export interface QQBridgeCallbacks {
  onStatus(status: BridgeStatus): void
  onText(text: string, identity: ChatIdentity): void
}

const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken'
const BASE = 'https://api.bot.qq.com'
/** 事件订阅：GROUP_AND_C2C_EVENT = 1<<25（覆盖 C2C_MESSAGE_CREATE 与 GROUP_AT_MESSAGE_CREATE）。 */
const INTENTS = 1 << 25

/** 被动消息 msg_id 去重窗口（官方提示相同 msg_id 可能重复推送）。 */
const DEDUP_CAP = 64

/** 回复帧：单聊=user_openid，群聊=group_openid。 */
export interface QqFrame {
  openid: string
  msgId: string
  scene: 'c2c' | 'group'
}

/** 从回调 Token 派生 ed25519 密钥（官方算法：seed = token 重复填充到 32 字节）。 */
function qqEd25519Key(secret: string): KeyObject {
  let seed = secret
  while (Buffer.byteLength(seed) < 32) seed += seed
  const seedBuf = Buffer.from(seed, 'utf8').subarray(0, 32)
  const inner = Buffer.concat([Buffer.from([0x04, 0x20]), seedBuf])
  const wrapped = Buffer.concat([Buffer.from([0x04, inner.length]), inner])
  const alg = Buffer.from([0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70])
  const ver = Buffer.from([0x02, 0x01, 0x00])
  const body = Buffer.concat([ver, alg, wrapped])
  const der = Buffer.concat([Buffer.from([0x30, body.length]), body])
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

interface GatewayPayload {
  op: number
  d?: unknown
  s?: number | null
  t?: string
}

export class QQBridge {
  private ws: WebSocket | null = null
  private stopped = false
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private seq: number | null = null
  private accessToken: string | null = null
  /** access_token 过期时间戳（官方 ≤7200s；实测可能更短，提前 60s 刷新）。 */
  private tokenExpiresAt = 0
  /** streamId → 已发出（单条定稿消息，防重复发送）。 */
  private sent = new Set<string>()
  private recentMsgIds = new Set<string>()
  status: BridgeStatus = { state: 'idle', detail: '', connectedAt: null }

  constructor(
    private readonly appId: string,
    private readonly secret: string,
    private readonly callbacks: QQBridgeCallbacks,
  ) {}

  private setStatus(state: BridgeStatus['state'], detail = ''): void {
    this.status = { state, detail, connectedAt: state === 'connected' ? Date.now() : this.status.connectedAt }
    this.callbacks.onStatus(this.status)
  }

  /** 启动：先取 access_token，再取 WSS 接入点，最后连网关。 */
  start(): void {
    if (!this.stopped && this.ws !== null) return
    this.stopped = false
    this.setStatus('connecting', 'access token')
    void this.getAccessToken().then(async (token) => {
      if (this.stopped) return
      if (token === null) {
        this.setStatus('error', 'access token failed')
        return
      }
      this.setStatus('connecting', 'gateway')
      const url = await this.getGatewayUrl()
      if (this.stopped) return
      if (url === null) {
        this.setStatus('error', 'gateway url failed')
        return
      }
      this.connect(url)
    })
  }

  private async getAccessToken(): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
        signal: controller.signal,
      })
      const body = (await response.json()) as { access_token?: string; expires_in?: number; message?: string; code?: number }
      if (response.ok && body.access_token !== undefined && body.access_token !== '') {
        this.accessToken = body.access_token
        this.tokenExpiresAt = Date.now() + (body.expires_in ?? 7200) * 1000
        return body.access_token
      }
      console.warn('[dsh-message-gateway] qq access token failed', response.status, body.message ?? body.code)
      return null
    } catch (error) {
      console.warn('[dsh-message-gateway] qq access token error', String(error))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 确保 access_token 未过期（提前 60s 刷新），供 REST/重连使用。 */
  private async ensureToken(): Promise<boolean> {
    if (this.accessToken !== null && Date.now() < this.tokenExpiresAt - 60_000) return true
    const token = await this.getAccessToken()
    return token !== null
  }

  /** 获取通用 WSS 接入点（官方推荐先调接口拿地址，避免写死）。 */
  private async getGatewayUrl(): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(`${BASE}/gateway`, {
        headers: { authorization: `QQBot ${this.accessToken ?? ''}` },
        signal: controller.signal,
      })
      if (!response.ok) {
        console.warn('[dsh-message-gateway] qq gateway url', response.status)
        return null
      }
      const body = (await response.json()) as { url?: string }
      if (typeof body.url === 'string' && body.url !== '') return body.url
      console.warn('[dsh-message-gateway] qq gateway url missing', JSON.stringify(body).slice(0, 120))
      return null
    } catch (error) {
      console.warn('[dsh-message-gateway] qq gateway url error', String(error))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private connect(url: string): void {
    if (this.stopped) return
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (error) {
      console.error('[dsh-message-gateway] qq ws create failed', error)
      this.setStatus('error', 'ws create failed')
      return
    }
    this.ws = ws
    ws.onopen = () => console.log('[dsh-message-gateway] qq gateway open', url)
    ws.onmessage = (event) => this.onMessage(String(event.data))
    ws.onerror = () => console.warn('[dsh-message-gateway] qq gateway ws error')
    ws.onclose = () => {
      this.clearHeartbeat()
      this.ws = null
      if (!this.stopped) {
        console.warn('[dsh-message-gateway] qq gateway closed, reconnect in 3s')
        setTimeout(() => {
          if (this.stopped) return
          // 重连前刷新 token + 接入点（token 会过期）。
          void this.ensureToken().then(async (ok) => {
            if (this.stopped || !ok) return
            const u = await this.getGatewayUrl()
            if (this.stopped || u === null) return
            this.connect(u)
          })
        }, 3000)
      }
    }
  }

  private onMessage(raw: string): void {
    let payload: GatewayPayload
    try {
      payload = JSON.parse(raw) as GatewayPayload
    } catch {
      return
    }
    if (payload.s !== null && payload.s !== undefined) this.seq = payload.s
    switch (payload.op) {
      case 10: { // HELLO
        const d = payload.d as { heartbeat_interval: number }
        this.startHeartbeat(d.heartbeat_interval)
        this.identify()
        break
      }
      case 1: { // Heartbeat 请求 → 回 seq
        this.sendOp(1, this.seq)
        break
      }
      case 0: {
        if (payload.t === 'READY') {
          this.setStatus('connected', 'qq')
          console.log('[dsh-message-gateway] qq READY')
        } else if (payload.t === 'C2C_MESSAGE_CREATE') {
          this.handleMessage(payload.d as Record<string, unknown>, 'c2c')
        } else if (payload.t === 'GROUP_AT_MESSAGE_CREATE') {
          this.handleMessage(payload.d as Record<string, unknown>, 'group')
        }
        break
      }
      case 9: { // INVALID_SESSION：日志后由 onclose 重连
        console.warn('[dsh-message-gateway] qq identify rejected (INVALID_SESSION) — 请确认控制台事件订阅为 WebSocket 长连接')
        this.ws?.close()
        break
      }
      case 7: { // RECONNECT
        this.ws?.close()
        break
      }
      case 11: // Heartbeat ACK，无操作
        break
    }
  }

  private sendOp(op: number, d: unknown): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ op, d }))
  }

  private identify(): void {
    this.sendOp(2, {
      token: `QQBot ${this.accessToken ?? ''}`,
      intents: INTENTS,
      shard: [0, 1],
    })
  }

  private startHeartbeat(interval: number): void {
    this.clearHeartbeat()
    this.heartbeat = setInterval(() => this.sendOp(1, this.seq), interval)
    this.heartbeat.unref?.()
  }

  private clearHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  private async rest(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    // 回复前确保 token 未过期（刷新失败则放弃本次调用）。
    if (!(await this.ensureToken())) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          authorization: `QQBot ${this.accessToken ?? ''}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = (await response.text()).slice(0, 200)
        console.warn('[dsh-message-gateway] qq rest', method, path, response.status, text)
        return null
      }
      return (await response.json()) as unknown
    } catch (error) {
      console.warn('[dsh-message-gateway] qq rest failed', method, path, String(error))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 单聊/群聊消息分发（content 群聊已去 @前缀）。 */
  private handleMessage(d: Record<string, unknown>, scene: 'c2c' | 'group'): void {
    const author = d.author as { bot?: boolean; user_openid?: string; member_openid?: string } | undefined
    if (author?.bot === true) return
    const text = typeof d.content === 'string' ? d.content.trim() : ''
    if (text === '') return
    const msgId = String(d.id ?? '')
    if (msgId === '') return
    // 官方提示：相同 msg_id 可能重复推送，去重。
    if (this.recentMsgIds.has(msgId)) return
    this.recentMsgIds.add(msgId)
    if (this.recentMsgIds.size > DEDUP_CAP) {
      const first = this.recentMsgIds.values().next().value
      if (first !== undefined) this.recentMsgIds.delete(first)
    }
    const openid = scene === 'c2c' ? (author?.user_openid ?? '') : String(d.group_openid ?? '')
    if (openid === '') return
    const frame: QqFrame = { openid, msgId, scene }
    const sink: ReplySink = {
      // 单聊/群聊回复不支持就地编辑（群聊明确不支持流式），ack 关闭：
      // 只发一条最终消息，避免「正在处理… + 回复」两条。
      ack: false,
      stream: (f, sid, content, finish) => void this.streamReply(f as QqFrame, sid, content, finish),
    }
    const identity: ChatIdentity = {
      key: scene === 'c2c' ? `qq:c2c:${openid}` : `qq:group:${openid}`,
      frame,
      sink,
      chatType: scene === 'c2c' ? 'single' : 'group',
    }
    console.log('[dsh-message-gateway] qq text', { scene, openid, text: text.slice(0, 60) })
    this.callbacks.onText(text, identity)
  }

  /** 回复：finish 时一次发出（带 msg_id 被动回复；幂等防重发）。 */
  private async streamReply(frame: QqFrame, streamId: string, content: string, finish: boolean): Promise<void> {
    if (!finish) return
    if (this.sent.has(streamId)) return
    this.sent.add(streamId)
    const text = content.trim() === '' ? '（空回复）' : content.slice(0, 2000)
    const path =
      frame.scene === 'c2c'
        ? `/v2/users/${encodeURIComponent(frame.openid)}/messages`
        : `/v2/groups/${encodeURIComponent(frame.openid)}/messages`
    const result = await this.rest('POST', path, { content: text, msg_type: 0, msg_id: frame.msgId })
    if (result === null) this.sent.delete(streamId) // 失败允许重试
  }

  /** 停止网关连接。 */
  stop(): void {
    this.stopped = true
    this.clearHeartbeat()
    this.sent.clear()
    this.recentMsgIds.clear()
    this.ws?.close()
    this.ws = null
    this.accessToken = null
    this.setStatus('idle')
  }
}

// ---------- QQ Webhook（回调）桥 ----------

/**
 * QQ 机器人 Webhook 方式：开放平台向配置的公网回调地址 POST 事件。
 * - URL 验证握手（op 13）：返回 ed25519(回调Token) 签名的 { plain_token, signature }。
 * - 事件推送：Header X-Signature-Ed25519 / X-Signature-Timestamp，签名体 = timestamp + 原始 body。
 * - 事件体与 WS 同构（op:0, d, t），回复走同一套 /v2/.../messages 被动消息 API。
 * 前置：回调地址需公网可达（控制台允许端口 80/443/8080/8443），且接入方式选 Webhook。
 * @module dsh-message-gateway/host/qq-bridge
 */
export class QqWebhookBridge {
  private readonly key: KeyObject
  private accessToken: string | null = null
  private tokenExpiresAt = 0
  private recentMsgIds = new Set<string>()

  constructor(
    private readonly appId: string,
    private readonly secret: string,
    private readonly callbackToken: string,
    private readonly callbacks: { onText(text: string, identity: ChatIdentity): void },
  ) {
    this.key = qqEd25519Key(callbackToken)
  }

  /** op 13 回调地址验证握手 → { plain_token, signature }（供控制台校验通过）。 */
  validate(d: { plain_token?: unknown; event_ts?: unknown }): { plain_token: string; signature: string } | null {
    const plainToken = typeof d.plain_token === 'string' ? d.plain_token : ''
    const eventTs = typeof d.event_ts === 'string' ? d.event_ts : ''
    if (plainToken === '' || eventTs === '') return null
    const signature = sign(null, Buffer.from(eventTs + plainToken, 'utf8'), this.key).toString('hex')
    return { plain_token: plainToken, signature }
  }

  /** 事件签名验证：X-Signature-Timestamp + 原始 body，ed25519 校验。 */
  verifySignature(rawBody: string, sigHex: string, timestamp: string): boolean {
    if (sigHex === '' || timestamp === '') return false
    let sig: Buffer
    try {
      sig = Buffer.from(sigHex, 'hex')
    } catch {
      return false
    }
    if (sig.length !== 64) return false
    const msg = Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(rawBody, 'utf8')])
    return verify(null, msg, this.key, sig)
  }

  /** 事件分发（payload { t, d }）；返回是否已消费（非本桥事件返回 false）。 */
  handleEvent(payload: { t?: unknown; d?: unknown }): boolean {
    const t = typeof payload.t === 'string' ? payload.t : ''
    let scene: 'c2c' | 'group' | null = null
    if (t === 'C2C_MESSAGE_CREATE') scene = 'c2c'
    else if (t === 'GROUP_AT_MESSAGE_CREATE') scene = 'group'
    if (scene === null) return false
    const d = (payload.d ?? {}) as Record<string, unknown>
    const author = d.author as { bot?: boolean; user_openid?: string; member_openid?: string } | undefined
    if (author?.bot === true) return true
    const text = typeof d.content === 'string' ? d.content.trim() : ''
    const msgId = String(d.id ?? '')
    if (text === '' || msgId === '') return true
    // 官方提示：相同 msg_id 可能重复推送。
    if (this.recentMsgIds.has(msgId)) return true
    this.recentMsgIds.add(msgId)
    if (this.recentMsgIds.size > DEDUP_CAP) {
      const first = this.recentMsgIds.values().next().value
      if (first !== undefined) this.recentMsgIds.delete(first)
    }
    const openid = scene === 'c2c' ? (author?.user_openid ?? '') : String(d.group_openid ?? '')
    if (openid === '') return true
    const frame: QqFrame = { openid, msgId, scene }
    const sink: ReplySink = {
      ack: false,
      stream: (_f, _sid, content, finish) => {
        if (finish) void this.reply(frame, content)
      },
    }
    const identity: ChatIdentity = {
      key: scene === 'c2c' ? `qq:c2c:${openid}` : `qq:group:${openid}`,
      frame,
      sink,
      chatType: scene === 'c2c' ? 'single' : 'group',
    }
    console.log('[dsh-message-gateway] qq webhook text', { scene, openid, text: text.slice(0, 60) })
    this.callbacks.onText(text, identity)
    return true
  }

  /** 确保 access_token 未过期（提前 60s 刷新）。 */
  private async ensureToken(): Promise<boolean> {
    if (this.accessToken !== null && Date.now() < this.tokenExpiresAt - 60_000) return true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
        signal: controller.signal,
      })
      const body = (await response.json()) as { access_token?: string; expires_in?: number }
      if (response.ok && body.access_token !== undefined && body.access_token !== '') {
        this.accessToken = body.access_token
        this.tokenExpiresAt = Date.now() + (body.expires_in ?? 7200) * 1000
        return true
      }
      console.warn('[dsh-message-gateway] qq webhook token failed', response.status)
      return false
    } catch (error) {
      console.warn('[dsh-message-gateway] qq webhook token error', String(error))
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** 发送单聊/群聊消息（带 msg_id 被动回复，幂等由调用方保证）。 */
  async reply(frame: QqFrame, content: string): Promise<boolean> {
    if (!(await this.ensureToken())) return false
    const text = content.trim() === '' ? '（空回复）' : content.slice(0, 2000)
    const path =
      frame.scene === 'c2c'
        ? `/v2/users/${encodeURIComponent(frame.openid)}/messages`
        : `/v2/groups/${encodeURIComponent(frame.openid)}/messages`
    try {
      const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { authorization: `QQBot ${this.accessToken ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: text, msg_type: 0, msg_id: frame.msgId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        const err = (await response.text()).slice(0, 120)
        console.warn('[dsh-message-gateway] qq webhook reply', response.status, err)
        return false
      }
      return true
    } catch (error) {
      console.warn('[dsh-message-gateway] qq webhook reply failed', String(error))
      return false
    }
  }
}