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
import { collectStream, type IncomingAttachment } from './incoming.ts'

export interface FeishuBridgeCallbacks {
  onStatus: (status: BridgeStatus) => void
  onText: (
    text: string,
    frame: { chatId: string; messageId: string; senderId: string; chatType: 'single' | 'group' },
    attachments?: IncomingAttachment[],
  ) => void
}

/** 飞书 content 里可能出现的消息类型（官方 im-v1 文档）。 */
const FEISHU_TEXT_TYPES = new Set(['text'])

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
            if (!msg) return
            const messageId = msg.message_id
            const messageType = msg.message_type
            let text = ''
            const attachments: IncomingAttachment[] = []

            if (FEISHU_TEXT_TYPES.has(messageType)) {
              const parsedContent = JSON.parse(msg.content || '{}') as { text?: string }
              text = parsedContent.text || ''
              // 群聊时如果包含 @提及 标记，剥离 @_user_1 等占位符
              if (msg.chat_type === 'group' && Array.isArray(msg.mentions)) {
                for (const mention of msg.mentions) {
                  if (mention.key) {
                    text = text.replace(new RegExp(mention.key, 'g'), '').trim()
                  }
                }
              }
            } else if (messageType === 'image') {
              // 官方文档：content = {"image_key":"img_xxx"}
              const parsed = JSON.parse(msg.content || '{}') as { image_key?: string }
              if (parsed.image_key !== undefined) {
                const data = await this.downloadMessageResource(messageId, parsed.image_key, 'image')
                if (data === null) text = '（图片下载失败）'
                else attachments.push({ kind: 'image', data, name: `${parsed.image_key}.img` })
              }
            } else if (messageType === 'file' || messageType === 'audio' || messageType === 'media') {
              // 官方文档：file/audio/media 均用 file_key；file 另带 file_name。
              const parsed = JSON.parse(msg.content || '{}') as { file_key?: string; file_name?: string }
              if (parsed.file_key !== undefined) {
                const data = await this.downloadMessageResource(messageId, parsed.file_key, 'file')
                if (data === null) text = '（文件下载失败）'
                else attachments.push({ kind: 'file', data, name: parsed.file_name ?? `${parsed.file_key}.bin` })
              }
            } else if (messageType === 'post') {
              // 官方建议优先使用 content_v2；其中图片节点 tag='img'。
              const parsed = JSON.parse(msg.content || '{}') as {
                content?: Array<Array<{ tag?: string; text?: string; image_key?: string }>>
                content_v2?: Array<Array<{ tag?: string; text?: string; image_key?: string }>>
              }
              const rows = parsed.content_v2 ?? parsed.content ?? []
              const texts: string[] = []
              for (const row of rows) {
                for (const node of row) {
                  if (node.tag === 'text' && typeof node.text === 'string') texts.push(node.text)
                  else if (node.tag === 'img' && node.image_key !== undefined) {
                    const data = await this.downloadMessageResource(messageId, node.image_key, 'image')
                    if (data !== null) attachments.push({ kind: 'image', data, name: `${node.image_key}.img` })
                  }
                }
              }
              text = texts.join('')
            } else if (messageType === 'sticker') {
              // 官方文档明确：不支持下载表情包资源。
              text = '（收到表情包消息：飞书不支持下载表情包资源，无法处理）'
            } else {
              // 绝不静默丢弃：明确告知该类型暂不支持。
              text = `（收到飞书「${messageType}」类型消息，暂不支持处理）`
            }

            text = text.trim()
            if (text === '' && attachments.length === 0) return

            this.callbacks.onText(
              text,
              {
                chatId: msg.chat_id,
                messageId,
                senderId: data.sender?.sender_id?.user_id || data.sender?.sender_id?.open_id || '',
                chatType: msg.chat_type === 'group' ? 'group' : 'single',
              },
              attachments.length > 0 ? attachments : undefined,
            )
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
   * 下载消息中的资源文件。
   *
   * 官方文档：必须使用「获取消息中的资源文件」
   * `GET /open-apis/im/v1/messages/:message_id/resources/:file_key`——
   * **不能**用 `im/v1/images/:image_key`（后者只能下载机器人自己上传的图片，
   * 下载用户发来的图会报 234008）。图片把 image_key 的值填到 file_key 位置。
   *
   * @param messageId 消息 ID
   * @param fileKey 图片传 image_key；文件/音频/视频传 file_key
   * @param type image=图片（含富文本图片）；file=文件/音频/视频
   */
  private async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<Uint8Array | null> {
    if (this.client === null) return null
    try {
      const res = await this.client.im.messageResource.get({
        params: { type },
        path: { message_id: messageId, file_key: fileKey },
      })
      return await collectStream(res.getReadableStream())
    } catch (error) {
      console.warn('[dsh-message-gateway] feishu resource download failed', fileKey, String(error))
      return null
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
