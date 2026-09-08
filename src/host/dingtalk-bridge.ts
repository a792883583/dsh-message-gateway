/**
 * 钉钉开放平台企业自建应用机器人常驻桥（双向对话与 Stream 长连接）。
 * 基于钉钉官方 dingtalk-stream SDK 的 DWClient 模式：
 * 1. 无需公网 IP，无需内网穿透；
 * 2. 凭 Client ID (AppKey) + Client Secret (AppSecret) 自动鉴权建立 WebSocket 长连接；
 * 3. 监听 /v1.0/im/bot/messages/get 主题接收单聊与群聊 @机器人 消息；
 * 4. 收到消息时使用 socketCallBackResponse 确认接收，并在任务完成后通过 sessionWebhook 回复；
 * 5. 退出时优雅断开连接。
 *
 * @module dsh-message-gateway/host/dingtalk-bridge
 */

import { DWClient, TOPIC_ROBOT, type DWClientDownStream, type RobotTextMessage } from 'dingtalk-stream'
import type { BridgeStatus } from './wecom-bridge.ts'

export interface DingTalkBridgeCallbacks {
  onStatus: (status: BridgeStatus) => void
  onText: (
    text: string,
    frame: {
      conversationId: string
      msgId: string
      senderNick: string
      senderStaffId: string
      sessionWebhook: string
      chatType: 'single' | 'group'
    },
  ) => void
}

export class DingTalkBridge {
  private client: DWClient | null = null
  private started = false
  status: BridgeStatus = { state: 'idle', detail: '', connectedAt: null }

  constructor(
    private readonly cred: { clientId: string; clientSecret: string; robotCode?: string },
    private readonly callbacks: DingTalkBridgeCallbacks,
  ) {}

  private setStatus(state: BridgeStatus['state'], detail = ''): void {
    this.status = {
      state,
      detail,
      connectedAt: state === 'connected' ? (this.status.connectedAt ?? Date.now()) : null,
    }
    this.callbacks.onStatus(this.status)
  }

  /** 建立长连接。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.setStatus('connecting', '正在连接钉钉 Stream 长连接…')

    try {
      this.client = new DWClient({
        clientId: this.cred.clientId,
        clientSecret: this.cred.clientSecret,
        debug: false,
      })

      // 注册机器人消息回调监听器
      this.client.registerCallbackListener(TOPIC_ROBOT, async (downstream: DWClientDownStream) => {
        try {
          const raw = JSON.parse(downstream.data || '{}') as Partial<RobotTextMessage>
          // 立即给钉钉服务端发送响应，避免服务端超时 60s 内重发
          this.client?.socketCallBackResponse(downstream.headers.messageId, {
            response: {
              statusLine: { code: 200, reasonPhrase: 'OK' },
              headers: {},
              body: JSON.stringify({ status: 'SUCCESS' }),
            },
          })

          const text = raw.text?.content?.trim() || ''
          if (!text) return

          const isGroup = raw.conversationType === '2'
          const sessionWebhook = raw.sessionWebhook || ''

          this.callbacks.onText(text, {
            conversationId: raw.conversationId || '',
            msgId: raw.msgId || downstream.headers.messageId,
            senderNick: raw.senderNick || '',
            senderStaffId: raw.senderStaffId || '',
            sessionWebhook,
            chatType: isGroup ? 'group' : 'single',
          })
        } catch (err) {
          console.error('[dsh-message-gateway] dingtalk message parsing error', err)
        }
      })

      this.client.connect().then(() => {
        this.setStatus('connected', `Client ID: ${this.cred.clientId}`)
        console.log('[dsh-message-gateway] dingtalk stream connected for', this.cred.clientId)
      }).catch((error) => {
        console.error('[dsh-message-gateway] dingtalk connect failed', error)
        this.setStatus('error', error instanceof Error ? error.message : String(error))
      })
    } catch (error) {
      console.error('[dsh-message-gateway] dingtalk start failed', error)
      this.setStatus('error', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 回复单次消息（通过 sessionWebhook 回复）。
   */
  async replySession(sessionWebhook: string, content: string): Promise<boolean> {
    if (!sessionWebhook) return false
    try {
      const resp = await fetch(sessionWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: {
            title: 'DSH 助手回复',
            text: content,
          },
        }),
      })
      const data = (await resp.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
      return data.errcode === 0
    } catch (err) {
      console.error('[dsh-message-gateway] dingtalk replySession error', err)
      return false
    }
  }

  /** 优雅停止长连接。 */
  stop(): void {
    this.started = false
    try {
      this.client?.disconnect()
    } catch (e) {
      console.warn('[dsh-message-gateway] dingtalk disconnect warning', e)
    }
    this.client = null
    this.setStatus('idle')
  }
}
