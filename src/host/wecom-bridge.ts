/**
 * 企业微信智能机器人常驻桥接：SDK 长连接生命周期管理 + 消息事件回调。
 * 与「连接测试」（临时连接即断）不同，本桥在插件生命周期内保持连接，
 * 接收消息并转发给会话层（见 bridge-manager）。
 * @module dsh-message-gateway/host/wecom-bridge
 */

import AiBot, { WSClient } from '@wecom/aibot-node-sdk'
import type { EventMessageWith, EnterChatEvent, WsFrame, TextMessage } from '@wecom/aibot-node-sdk'

export interface BridgeStatus {
  state: 'idle' | 'connecting' | 'connected' | 'error'
  detail: string
  connectedAt: number | null
}

export interface WecomBridgeCallbacks {
  onStatus(status: BridgeStatus): void
  /** 收到文本消息（frame 可用于 reply 回发）。 */
  onText(text: string, frame: WsFrame<TextMessage>): void
  /** 用户当天首次进入单聊会话。 */
  onEnter(frame: WsFrame<EventMessageWith<EnterChatEvent>>): void
}

/** 常驻连接管理。 */
export class WecomBridge {
  private client: WSClient | null = null
  private started = false
  status: BridgeStatus = { state: 'idle', detail: '', connectedAt: null }

  constructor(
    private readonly cred: { botId: string; secret: string },
    private readonly callbacks: WecomBridgeCallbacks,
  ) {}

  private setStatus(state: BridgeStatus['state'], detail = ''): void {
    this.status = {
      state,
      detail,
      connectedAt: state === 'connected' ? Date.now() : this.status.connectedAt,
    }
    this.callbacks.onStatus(this.status)
  }

  /** 建立常驻连接（断线由 SDK 自动指数退避重连）。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.setStatus('connecting')
    const client = new WSClient({ botId: this.cred.botId, secret: this.cred.secret })
    this.client = client
    client.on('authenticated', () => this.setStatus('connected', `botId ${this.cred.botId}`))
    client.on('message.text', (frame: WsFrame<TextMessage>) => {
      const content = frame.body?.text?.content ?? ''
      if (content.trim() !== '') this.callbacks.onText(content, frame)
    })
    client.on('event.enter_chat', (frame: WsFrame<EventMessageWith<EnterChatEvent>>) => {
      this.callbacks.onEnter(frame)
    })
    client.on('error', (err: Error) => {
      // SDK 内部重连；仅在从未连接成功时标记错误。
      if (this.status.state !== 'connected') this.setStatus('error', err?.message ?? '连接错误')
    })
    client.connect()
  }

  /** 经 response_url（企业微信官方 HTTP 通道）发送完整回复，无超时限制。 */
  async postResponse(url: string, content: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      })
      if (!response.ok) console.error('[dsh-message-gateway] response_url http', response.status)
      return response.ok
    } catch (error) {
      console.error('[dsh-message-gateway] response_url failed', error)
      return false
    }
  }

  /** 流式回复：全量更新内容，finish=true 定稿。 */
  async streamReply(frame: WsFrame<TextMessage>, streamId: string, content: string, finish: boolean): Promise<void> {
    try {
      await this.client?.replyStream(frame, streamId, content, finish)
    } catch (error) {
      console.error('[dsh-message-gateway] stream reply failed', error)
    }
  }

  /** 主动向会话发送 markdown 消息（chatid：单聊=userid，群聊=群 ID）。 */
  async sendMessage(chatid: string, content: string): Promise<boolean> {
    try {
      await this.client?.sendMessage(chatid, { msgtype: 'markdown', markdown: { content } })
      return true
    } catch (error) {
      console.error('[dsh-message-gateway] sendMessage failed', error)
      return false
    }
  }

  /** 回复欢迎语（enter_chat 事件）。 */
  async welcome(frame: WsFrame<EventMessageWith<EnterChatEvent>>, content: string): Promise<void> {
    try {
      await this.client?.replyWelcome(frame, { msgtype: 'text', text: { content } })
    } catch (error) {
      console.error('[dsh-message-gateway] welcome reply failed', error)
    }
  }

  /** 停止常驻连接。 */
  stop(): void {
    this.started = false
    this.client?.disconnect()
    this.client = null
    this.setStatus('idle')
  }
}
