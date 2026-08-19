/**
 * Discord 机器人桥：WebSocket 网关（Gateway v10，原生 WebSocket），无第三方依赖。
 * 心跳保活 + 断线重连；收到 MESSAGE_CREATE 后经统一管线回复。
 * 流式回复体验：先发送消息，随后 PATCH 渐进更新，finish=true 定稿。
 * 注意：需在 Discord 开发者后台为机器人开启 MESSAGE CONTENT 特权意图。
 * @module dsh-message-gateway/host/discord-bridge
 */

import type { BridgeStatus } from './wecom-bridge.ts'
import type { ChatIdentity, ReplySink } from './bridge-manager.ts'

export interface DiscordBridgeCallbacks {
  onStatus(status: BridgeStatus): void
  onText(text: string, identity: ChatIdentity): void
}

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
const REST = 'https://discord.com/api/v10'

/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT。 */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

const EDIT_INTERVAL_MS = 1200
const MSG_LIMIT = 2000

interface GatewayPayload {
  op: number
  d?: unknown
  s?: number | null
  t?: string
}

export class DiscordBridge {
  private ws: WebSocket | null = null
  private stopped = false
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private seq: number | null = null
  /** streamId → 已发送消息（用于渐进编辑）。 */
  private streams = new Map<string, { channelId: string; messageId: string; lastEdit: number }>()
  /** streamId → 最新待推送内容（流式合并，单 worker 消费）。 */
  private state = new Map<string, { content: string; finish: boolean }>()
  private working = new Set<string>()
  status: BridgeStatus = { state: 'idle', detail: '', connectedAt: null }

  constructor(
    private readonly token: string,
    private readonly callbacks: DiscordBridgeCallbacks,
  ) {}

  private setStatus(state: BridgeStatus['state'], detail = ''): void {
    this.status = { state, detail, connectedAt: state === 'connected' ? Date.now() : this.status.connectedAt }
    this.callbacks.onStatus(this.status)
  }

  /** 启动网关连接。 */
  start(): void {
    if (!this.stopped && this.ws !== null) return
    this.stopped = false
    this.setStatus('connecting', 'gateway')
    this.connect()
  }

  private connect(): void {
    if (this.stopped) return
    let ws: WebSocket
    try {
      ws = new WebSocket(GATEWAY_URL)
    } catch (error) {
      console.error('[dsh-message-gateway] discord ws create failed', error)
      this.setStatus('error', 'ws create failed')
      return
    }
    this.ws = ws
    ws.onopen = () => console.log('[dsh-message-gateway] discord gateway open')
    ws.onmessage = (event) => this.onMessage(String(event.data))
    ws.onerror = () => ws.close()
    ws.onclose = () => {
      this.clearHeartbeat()
      this.ws = null
      if (!this.stopped) {
        console.warn('[dsh-message-gateway] discord gateway closed, reconnect in 3s')
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
      case 1: { // HEARTBEAT（服务器请求）
        this.sendOp(1, this.seq)
        break
      }
      case 0: { // DISPATCH
        if (payload.t === 'READY') {
          this.setStatus('connected', 'discord')
          console.log('[dsh-message-gateway] discord READY')
        } else if (payload.t === 'MESSAGE_CREATE') {
          this.handleMessage(payload.d as Record<string, unknown>)
        }
        break
      }
      case 7: { // RECONNECT 请求
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
      token: this.token,
      intents: INTENTS,
      properties: { os: 'linux', browser: 'dsh-message-gateway', device: 'dsh-message-gateway' },
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
        headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        console.warn('[dsh-message-gateway] discord rest', method, path, response.status)
        return null
      }
      return await response.json() as unknown
    } catch (error) {
      console.warn('[dsh-message-gateway] discord rest failed', method, path, String(error))
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
    const guildId = typeof d.guild_id === 'string' ? d.guild_id : ''
    const frame = { channelId, messageId: String(d.id ?? ''), guildId }
    const sink: ReplySink = {
      stream: (f, sid, content, finish) => void this.streamReply(f as typeof frame, sid, content, finish),
    }
    const identity: ChatIdentity = {
      key: `discord:${channelId}`,
      frame,
      sink,
      chatType: guildId === '' ? 'single' : 'group',
    }
    console.log('[dsh-message-gateway] discord text', { channelId, text: text.slice(0, 60) })
    this.callbacks.onText(text, identity)
  }

  /** 流式回复：状态合并 + 单 worker——首次发送消息，随后 PATCH 渐进更新（限频）。 */
  private async streamReply(frame: { channelId: string }, streamId: string, content: string, finish: boolean): Promise<void> {
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
          const result = (await this.rest('POST', `/channels/${frame.channelId}/messages`, { content: text })) as { id?: string } | null
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
      console.error('[dsh-message-gateway] discord reply failed', error)
    } finally {
      this.working.delete(streamId)
    }
  }

  /** 停止网关连接。 */
  stop(): void {
    this.stopped = true
    this.clearHeartbeat()
    this.streams.clear()
    this.ws?.close()
    this.ws = null
    this.setStatus('idle')
  }
}