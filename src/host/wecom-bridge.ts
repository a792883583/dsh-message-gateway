/**
 * 企业微信智能机器人常驻桥接：SDK 长连接生命周期管理 + 消息事件回调 + 智能表格 REST API 对接。
 * 与「连接测试」（临时连接即断）不同，本桥在插件生命周期内保持连接，
 * 接收消息并转发给会话层（见 bridge-manager）。
 * @module dsh-message-gateway/host/wecom-bridge
 */

import AiBot, { WSClient } from '@wecom/aibot-node-sdk'
import type {
  BaseMessage, EventMessageWith, EnterChatEvent, FileMessage, ImageMessage, MixedMessage,
  VideoMessage, VoiceMessage, WsFrame, TextMessage,
} from '@wecom/aibot-node-sdk'
import { WecomSmartsheetClient, type CreateSmartsheetOptions, type CreateSmartsheetResult } from './wecom-smartsheet.ts'
import type { IncomingAttachment } from './incoming.ts'

export interface BridgeStatus {
  state: 'idle' | 'connecting' | 'connected' | 'error'
  detail: string
  connectedAt: number | null
}

export interface WecomBridgeCallbacks {
  onStatus(status: BridgeStatus): void
  /** 收到文本消息（frame 可用于 reply 回发）；attachments 为随附的图片/文件。 */
  onText(text: string, frame: WsFrame<BaseMessage>, attachments?: IncomingAttachment[]): void
  /** 用户当天首次进入单聊会话。 */
  onEnter(frame: WsFrame<EventMessageWith<EnterChatEvent>>): void
}

/** 常驻连接管理。 */
export class WecomBridge {
  private client: WSClient | null = null
  private smartsheetClient: WecomSmartsheetClient | null = null
  private started = false
  status: BridgeStatus = { state: 'idle', detail: '', connectedAt: null }

  constructor(
    private readonly cred: { botId: string; secret: string },
    private readonly callbacks: WecomBridgeCallbacks,
  ) {
    this.smartsheetClient = new WecomSmartsheetClient({
      botId: cred.botId,
      secret: cred.secret,
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

  /** 获取智能表格操作客户端 */
  getSmartsheetClient(): WecomSmartsheetClient | null {
    return this.smartsheetClient
  }

  /** 获取底层已认证连接的 WSClient 实例 */
  getClient(): WSClient | null {
    return this.client
  }

  /**
   * 创建企业微信智能表格。
   */
  async createSmartsheet(options: CreateSmartsheetOptions): Promise<CreateSmartsheetResult> {
    if (!this.smartsheetClient) {
      return { ok: false, error: '企业微信智能表格客户端未初始化' }
    }
    return await this.smartsheetClient.createSmartsheet(options)
  }

  /** 建立常驻连接（断线由 SDK 自动指数退避重连）。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.setStatus('connecting')
    const client = new WSClient({ botId: this.cred.botId, secret: this.cred.secret })
    this.client = client
    client.on('authenticated', () => {
      this.setStatus('connected', `botId ${this.cred.botId}`)
    })
    client.on('message.text', (frame: WsFrame<TextMessage>) => {
      const content = frame.body?.text?.content ?? ''
      if (content.trim() !== '') this.callbacks.onText(content, frame)
    })
    // ---- 媒体消息（官方长连接文档：image/file/video 为 url+aeskey，需下载后 AES 解密）----
    client.on('message.image', async (frame: WsFrame<ImageMessage>) => {
      const img = frame.body?.image
      if (img?.url === undefined || img.url === '') return
      try {
        // SDK 的 downloadFile 内部完成「GET 加密资源 → AES-256-CBC 解密」，
        // 官方文档：url 5 分钟内有效、aeskey 每个链接唯一，必须立即下载。
        const { buffer, filename } = await client.downloadFile(img.url, img.aeskey)
        if (buffer.byteLength === 0) throw new Error('下载结果为空')
        this.callbacks.onText('', frame, [{ kind: 'image', data: new Uint8Array(buffer), name: filename }])
      } catch (err) {
        this.callbacks.onText(`（图片接收失败：${err instanceof Error ? err.message : String(err)}）`, frame)
      }
    })
    client.on('message.file', async (frame: WsFrame<FileMessage>) => {
      const f = frame.body?.file
      if (f?.url === undefined || f.url === '') return
      try {
        const { buffer, filename } = await client.downloadFile(f.url, f.aeskey)
        if (buffer.byteLength === 0) throw new Error('下载结果为空')
        this.callbacks.onText('', frame, [{ kind: 'file', data: new Uint8Array(buffer), name: filename }])
      } catch (err) {
        this.callbacks.onText(`（文件接收失败：${err instanceof Error ? err.message : String(err)}）`, frame)
      }
    })
    client.on('message.video', async (frame: WsFrame<VideoMessage>) => {
      const v = frame.body?.video
      if (v?.url === undefined || v.url === '') return
      try {
        const { buffer, filename } = await client.downloadFile(v.url, v.aeskey)
        if (buffer.byteLength === 0) throw new Error('下载结果为空')
        this.callbacks.onText('', frame, [{ kind: 'file', data: new Uint8Array(buffer), name: filename ?? 'video.mp4' }])
      } catch (err) {
        this.callbacks.onText(`（视频接收失败：${err instanceof Error ? err.message : String(err)}）`, frame)
      }
    })
    // 图文混排（官方文档：群聊 @机器人 配图走 mixed，msg_item 中 text/image 交替）。
    client.on('message.mixed', async (frame: WsFrame<MixedMessage>) => {
      const items = frame.body?.mixed?.msg_item ?? []
      const texts: string[] = []
      const attachments: IncomingAttachment[] = []
      for (const item of items) {
        if (item.msgtype === 'text') {
          const t = item.text?.content ?? ''
          if (t.trim() !== '') texts.push(t.trim())
        } else if (item.msgtype === 'image' && item.image?.url) {
          try {
            // mixed 子项图片官方示例可能不带 aeskey：带了就解密，没带按官方 SDK
            // 行为原样下载（SDK 缺 aeskey 时 warn 并返回密文——密文无法直接用，
            // 但至少不静默丢弃，给用户可见提示）。
            const { buffer } = await client.downloadFile(item.image.url, item.image.aeskey)
            if (buffer.byteLength > 0) {
              attachments.push({ kind: 'image', data: new Uint8Array(buffer) })
            }
          } catch (err) {
            texts.push(`（图片接收失败：${err instanceof Error ? err.message : String(err)}）`)
          }
        }
      }
      this.callbacks.onText(texts.join('\n'), frame, attachments.length > 0 ? attachments : undefined)
    })
    // 语音：官方文档明确「已转为文本」，直接作为文本处理。
    client.on('message.voice', (frame: WsFrame<VoiceMessage>) => {
      const content = frame.body?.voice?.content ?? ''
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

  /**
   * 主动向会话发送图片消息（chatid：单聊=userid，群聊=群 ID）。
   * 内部自动上传临时素材（WeCom uploadMedia）后通过 aibot_send_msg 发送。
   * @param chatid 接收会话 ID
   * @param image 图片数据（Buffer）
   * @param filename 可选文件名（默认 image.png）
   */
  async sendImage(chatid: string, image: Buffer, filename = 'image.png'): Promise<boolean> {
    try {
      const media = await this.client?.uploadMedia(image, { type: 'image', filename })
      if (!media?.media_id) {
        console.error('[dsh-message-gateway] sendImage upload failed: no media_id returned')
        return false
      }
      await this.client?.sendMediaMessage(chatid, 'image', media.media_id)
      return true
    } catch (error) {
      console.error('[dsh-message-gateway] sendImage failed', error)
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
