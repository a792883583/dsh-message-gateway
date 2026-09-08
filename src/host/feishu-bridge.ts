/**
 * 飞书开放平台企业自建应用机器人常驻桥（双向对话与事件订阅）。
 * 基于飞书官方 @larksuiteoapi/node-sdk 的 WSClient 长连接模式：
 * 1. 无需公网 IP，无需内网穿透；
 * 2. 凭 App ID + App Secret 自动鉴权与长连接握手；
 * 3. 接收单聊私聊与群聊 @机器人 文本消息，并转交给 DSH 专属会话处理；
 * 4. 支持发送文本、Markdown 卡片回复与富文本消息；
 * 5. 进程退出时支持优雅调用 close() 释放长连接。
 *
 * @module dsh-message-gateway/host/feishu-bridge
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { BridgeStatus } from './wecom-bridge.ts'

export interface FeishuBridgeCallbacks {
  onStatus: (status: BridgeStatus) => void
  onText: (text: string, frame: { chatId: string; messageId: string; senderId: string; chatType: 'single' | 'group' }) => void
}

export class FeishuBridge {
  private client: lark.Client | null = null
  private wsClient: lark.WSClient | null = null
  private started = false
  status: BridgeStatus = { state: 'idle', detail: '', connectedAt: null }

  constructor(
    private readonly cred: { appId: string; appSecret: string },
    private readonly callbacks: FeishuBridgeCallbacks,
  ) {
    this.client = new lark.Client({
      appId: cred.appId,
      appSecret: cred.appSecret,
    })
  }

  private setStatus(state: BridgeStatus['state'], detail = ''): void {
    this.status = {
      state,
      detail,
      connectedAt: state === 'connected' ? (this.status.connectedAt ?? Date.now()) : null,
    }
    this.callbacks.onStatus(this.status)
  }

  /** 获取飞书官方 REST API Client 实例。 */
  getClient(): lark.Client | null {
    return this.client
  }

  /** 建立长连接。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.setStatus('connecting', '正在连接飞书长连接…')

    try {
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            const msg = data.message
            if (!msg || msg.message_type !== 'text') return

            const parsedContent = JSON.parse(msg.content || '{}') as { text?: string }
            let text = parsedContent.text || ''

            // 群聊时如果包含 @提及 标记，剥离 @_user_1 等占位符
            if (msg.chat_type === 'group' && Array.isArray(msg.mentions)) {
              for (const mention of msg.mentions) {
                if (mention.key) {
                  text = text.replace(new RegExp(mention.key, 'g'), '').trim()
                }
              }
            }

            if (text.trim() === '') return

            this.callbacks.onText(text.trim(), {
              chatId: msg.chat_id,
              messageId: msg.message_id,
              senderId: data.sender?.sender_id?.user_id || data.sender?.sender_id?.open_id || '',
              chatType: msg.chat_type === 'group' ? 'group' : 'single',
            })
          } catch (err) {
            console.error('[dsh-message-gateway] feishu message parsing error', err)
          }
        },
      })

      this.wsClient = new lark.WSClient({
        appId: this.cred.appId,
        appSecret: this.cred.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      })

      // 监听长连接启动
      this.wsClient.start({ eventDispatcher })
      this.setStatus('connected', `App ID: ${this.cred.appId}`)
      console.log('[dsh-message-gateway] feishu wsClient connection initiated for', this.cred.appId)
    } catch (error) {
      console.error('[dsh-message-gateway] feishu start failed', error)
      this.setStatus('error', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 回复某条消息（通过 message_id 引用回复）。
   */
  async replyMessage(messageId: string, content: string): Promise<boolean> {
    if (!this.client) return false
    try {
      await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text: content }),
          msg_type: 'text',
        },
      })
      return true
    } catch (err) {
      console.error('[dsh-message-gateway] feishu replyMessage error', err)
      return false
    }
  }

  /**
   * 主动发送消息至指定会话（支持单聊 open_id/user_id 或群聊 chat_id）。
   */
  async sendMessage(receiveId: string, content: string, receiveIdType: 'open_id' | 'user_id' | 'chat_id' = 'chat_id'): Promise<boolean> {
    if (!this.client) return false
    try {
      await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: content }),
        },
      })
      return true
    } catch (err) {
      console.error('[dsh-message-gateway] feishu sendMessage error', err)
      return false
    }
  }

  /** 优雅停止长连接。 */
  stop(): void {
    this.started = false
    try {
      this.wsClient?.close({ force: true })
    } catch (e) {
      console.warn('[dsh-message-gateway] feishu wsClient close warning', e)
    }
    this.wsClient = null
    this.setStatus('idle')
  }
}
