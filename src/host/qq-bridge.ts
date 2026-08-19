/**
 * QQ 机器人桥（QQ 开放平台 / 频道与群）：appId+secret → access_token → WebSocket 网关。
 * 无第三方依赖（Node fetch + 原生 WebSocket）。消息事件经统一管线回复。
 * 流式体验：首次按被动回复发送（带 msg_id），随后 PATCH 渐进更新（限频）。
 * 注意：被动回复需在收到消息后尽快发送（超时会话过期则需主动消息能力）。
 * @module dsh-message-gateway/host/qq-bridge
 */

import type { BridgeStatus } from './wecom-bridge.ts'
import type { ChatIdentity, ReplySink } from './bridge-manager.ts'

export interface QQBridgeCallbacks {
  onStatus(status: BridgeStatus): void
  onText(text: string, identity: ChatIdentity): void
}

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const REST = 'https://api.sgroup.qq.com'
const GATEWAY = 'wss://api.sgroup.qq.com/?v=1&encoding=json'

/** GUILD_MESSAGES | DIRECT_MESSAGE | PUBLIC_GUILD_MESSAGES。 */
const INTENTS = (1 << 9) | (1 << 12) | (1 << 30)

const EDIT_INTERVAL_MS = 1200
const MSG_LIMIT = 2000

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
  /** streamId → 已发送消息（用于渐进编辑）。 */
  private streams = new Map<string, { channelId: string; messageId: string; lastEdit: number }>()
  /** streamId → 最新待推送内容（流式合并，单 worker 消费）。 */
  private state = new Map<string, { content: string; finish: boolean }>()
  private working = new Set<string>()
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

  /** 启动：先取 access_token，再连网关。 */
  start(): void {
    if (!this.stopped && this.ws !== null) return
    this.stopped = false
    this.setStatus('connecting', 'access token')
    void this.getAccessToken().then((token) => {
      if (this.stopped) return
      if (token === null) {
        this.setStatus('error', 'access token failed')
        return
      }
      this.accessToken = token
      this.setStatus('connecting', 'gateway')
      this.connect()
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
      const body = (await response.json()) as { access_token?: string; message?: string; code?: number }
      if (response.ok && body.access_token !== undefined && body.access_token !== '') {
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

  private connect(): void {
    if (this.stopped) return
    let ws: WebSocket
    try {
      ws = new WebSocket(GATEWAY)
    } catch (error) {
      console.error('[dsh-message-gateway] qq ws create failed', error)
      this.setStatus('error', 'ws create failed')
      return
    }
    this.ws = ws
    ws.onopen = () => console.log('[dsh-message-gateway] qq gateway open')
    ws.onmessage = (event) => this.onMessage(String(event.data))
    ws.onerror = () => console.warn('[dsh-message-gateway] qq gateway ws error')
    ws.onclose = () => {
      this.clearHeartbeat()
      this.ws = null
      if (!this.stopped) {
        console.warn('[dsh-message-gateway] qq gateway closed, reconnect in 3s')
        setTimeout(() => this.connect(), 3000)
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
      case 1: {
        this.sendOp(1, this.seq)
        break
      }
      case 0: {
        if (payload.t === 'READY') {
          this.setStatus('connected', 'qq')
          console.log('[dsh-message-gateway] qq READY')
        } else if (payload.t === 'MESSAGE_CREATE' || payload.t === 'DIRECT_MESSAGE_CREATE') {
          this.handleMessage(payload.d as Record<string, unknown>)
        }
        break
      }
      case 7: {
        this.ws?.close()
        break
      }
    }
  }

  private sendOp(op: number, d: unknown): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ op, d }))
  }

  private identify(): void {
    this.sendOp(2, {
      token: this.accessToken,
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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(`${REST}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.accessToken ?? ''}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        console.warn('[dsh-message-gateway] qq rest', method, path, response.status)
        return null
      }
      return await response.json() as unknown
    } catch (error) {
      console.warn('[dsh-message-gateway] qq rest failed', method, path, String(error))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private handleMessage(d: Record<string, unknown>): void {
    const author = d.author as { id?: string; bot?: boolean } | undefined
    if (author?.bot === true) return
    const text = typeof d.content === 'string' ? d.content.trim() : ''
    if (text === '') return
    const channelId = String(d.channel_id ?? '')
    if (channelId === '') return
    const guildId = String(d.guild_id ?? '')
    const frame = { channelId, messageId: String(d.id ?? ''), guildId }
    const sink: ReplySink = {
      stream: (f, sid, content, finish) => void this.streamReply(f as typeof frame, sid, content, finish),
    }
    const identity: ChatIdentity = {
      key: `qq:${channelId}`,
      frame,
      sink,
      chatType: guildId === '' ? 'single' : 'group',
    }
    console.log('[dsh-message-gateway] qq text', { channelId, text: text.slice(0, 60) })
    this.callbacks.onText(text, identity)
  }

  /** 流式回复：状态合并 + 单 worker——首次被动回复，随后 PATCH 渐进更新（限频）。 */
  private async streamReply(frame: { channelId: string; messageId: string }, streamId: string, content: string, finish: boolean): Promise<void> {
    const prev = this.state.get(streamId)
    this.state.set(streamId, { content, finish: finish || (prev?.finish ?? false) })
    if (this.working.has(streamId)) return
    this.working.add(streamId)
    try {
      for (let guard = 0; guard < 200; guard += 1) {
        const current = this.state.get(streamId)
        if (current === undefined) break
        const text = (current.content === '' ? ' ' : current.content).slice(0, MSG_LIMIT)
        const existing = this.streams.get(streamId)
        if (existing === undefined) {
          if (current.content === '' && !current.finish) break
          // 首次：被动回复（带 msg_id），2 分钟内有效。
          const result = (await this.rest('POST', `/channels/${frame.channelId}/messages`, {
            content: text,
            msg_type: 0,
            msg_id: frame.messageId,
          })) as { id?: string } | null
          if (result?.id === undefined) break
          this.streams.set(streamId, { channelId: frame.channelId, messageId: result.id, lastEdit: Date.now() })
          if (current.finish || this.state.get(streamId)!.content === current.content) break
          continue
        }
        const wait = EDIT_INTERVAL_MS - (Date.now() - existing.lastEdit)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        existing.lastEdit = Date.now()
        await this.rest('PATCH', `/channels/${existing.channelId}/messages/${existing.messageId}`, { content: text })
        if (current.finish || this.state.get(streamId)!.content === current.content) break
      }
    } catch (error) {
      console.error('[dsh-message-gateway] qq reply failed', error)
    } finally {
      this.working.delete(streamId)
    }
  }

  /** 停止网关连接。 */
  stop(): void {
    this.stopped = true
    this.clearHeartbeat()
    this.streams.clear()
    this.state.clear()
    this.working.clear()
    this.ws?.close()
    this.ws = null
    this.accessToken = null
    this.setStatus('idle')
  }
}