/**
 * Telegram 机器人桥：Bot API 长轮询（getUpdates），无第三方依赖（Node fetch）。
 * 流式回复体验：首次 sendMessage 建立消息，随后 editMessageText 渐进更新，
 * finish=true 定稿（停止编辑）。Markdown 解析失败自动降级为纯文本。
 * @module dsh-message-gateway/host/telegram-bridge
 */

import type { BridgeStatus } from './wecom-bridge.ts'
import type { ChatIdentity, ReplySink } from './bridge-manager.ts'
import type { IncomingAttachment } from './incoming.ts'
import { getProxyDispatcher } from './proxy.ts'

export interface TelegramBridgeCallbacks {
  onStatus(status: BridgeStatus): void
  onText(text: string, identity: ChatIdentity, attachments?: IncomingAttachment[]): void
}

/** 流式编辑限频（Telegram 约 1 次/秒/聊天）。 */
const EDIT_INTERVAL_MS = 1200
const MSG_LIMIT = 4096
const POLL_TIMEOUT = 25
/** 官方文档：Bot 可下载文件上限 20MB（超出需 Local Bot API Server）。 */
const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024

export class TelegramBridge {
  private stopped = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private offset = 0
  /** streamId → 已发送消息（用于渐进编辑）。 */
  private streams = new Map<string, { chatId: number; messageId: number; lastEdit: number }>()
  /** streamId → 最新待推送内容（流式合并，单 worker 消费）。 */
  private state = new Map<string, { content: string; finish: boolean }>()
  private working = new Set<string>()
  status: BridgeStatus = { state: 'idle', detail: '', connectedAt: null }

  constructor(
    private readonly token: string,
    private readonly callbacks: TelegramBridgeCallbacks,
  ) {}

  private setStatus(state: BridgeStatus['state'], detail = ''): void {
    this.status = { state, detail, connectedAt: state === 'connected' ? Date.now() : this.status.connectedAt }
    this.callbacks.onStatus(this.status)
  }

  /** 启动长轮询。 */
  start(): void {
    if (!this.stopped && this.pollTimer !== null) return
    this.stopped = false
    this.setStatus('connecting', 'long polling')
    this.pollTimer = setTimeout(() => void this.poll(), 0)
  }

  private async api(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const dispatcher = await getProxyDispatcher()
      const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit)
      const body = (await response.json()) as { ok?: boolean; result?: unknown; description?: string }
      if (body.ok === true) return body.result
      console.warn('[dsh-message-gateway] telegram api', method, body.description ?? `HTTP ${response.status}`)
      return null
    } catch (error) {
      console.warn('[dsh-message-gateway] telegram api failed', method, String(error))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) return
    const result = await this.api(
      'getUpdates',
      { offset: this.offset, timeout: POLL_TIMEOUT, allowed_updates: ['message'] },
      (POLL_TIMEOUT + 15) * 1000,
    )
    if (this.stopped) return
    if (result !== null) {
      this.setStatus('connected', 'telegram')
      const updates = result as Array<{ update_id: number; message?: Record<string, unknown> }>
      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1)
        if (update.message !== undefined) void this.handleMessage(update.message)
      }
    } else {
      // getUpdates 失败（网络/限流）：退避 3 秒后重试，避免空转。
      this.setStatus('error', 'poll failed')
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    if (!this.stopped) this.pollTimer = setTimeout(() => void this.poll(), 0)
  }

  private async handleMessage(m: Record<string, unknown>): Promise<void> {
    const from = m.from as { is_bot?: boolean } | undefined
    if (from?.is_bot === true) return
    const chat = m.chat as { id: number; type?: string } | undefined
    if (chat === undefined) return
    const caption = typeof m.caption === 'string' ? m.caption.trim() : ''
    let text = typeof m.text === 'string' ? m.text.trim() : ''
    if (text === '') text = caption
    const notes: string[] = []
    const attachments: IncomingAttachment[] = []

    // ---- 附件（官方文档探测顺序：animation → photo → document → video → video_note → voice → audio → sticker）----
    if (Array.isArray(m.photo) && m.photo.length > 0) {
      // photo 是 PhotoSize[]，官方未保证有序：显式挑「最大」一张。
      const sizes = m.photo as Array<{ file_id?: string; width?: number; height?: number; file_size?: number }>
      const best = sizes.reduce((a, b) => {
        const sa = a.file_size ?? (a.width ?? 0) * (a.height ?? 0)
        const sb = b.file_size ?? (b.width ?? 0) * (b.height ?? 0)
        return sb > sa ? b : a
      })
      if (best.file_id !== undefined) {
        const data = await this.downloadTelegramFile(best.file_id)
        if (data !== null) attachments.push({ kind: 'image', data })
        else notes.push('（图片下载失败）')
      }
    } else {
      const mediaKeys = ['animation', 'document', 'video', 'video_note', 'voice', 'audio', 'sticker'] as const
      for (const key of mediaKeys) {
        const media = m[key] as { file_id?: string; file_name?: string; mime_type?: string; file_size?: number } | undefined
        if (media?.file_id === undefined) continue
        const size = media.file_size ?? 0
        if (size > TG_DOWNLOAD_LIMIT) {
          notes.push(`（${key} 超过官方 20MB 下载上限，未下载）`)
          break
        }
        const data = await this.downloadTelegramFile(media.file_id)
        if (data !== null) {
          attachments.push({ kind: 'file', data, name: media.file_name, mediaType: media.mime_type })
        } else {
          notes.push(`（${key} 下载失败）`)
        }
        break
      }
    }

    // 绝不静默丢弃：携带内容但未识别的类型给出可见提示；纯系统消息不打扰。
    if (text === '' && attachments.length === 0 && notes.length === 0) {
      const contentKeys = ['contact', 'location', 'venue', 'poll', 'dice', 'game', 'forward_origin']
      if (!contentKeys.some((k) => m[k] !== undefined)) return
      text = '（收到该类型 Telegram 消息，暂不支持处理）'
    }
    if (text === '' && notes.length > 0) text = notes.join('\n')

    const frame = { chatId: chat.id, messageId: m.message_id ?? 0, chatType: chat.type ?? 'private' }
    const sink: ReplySink = {
      stream: (f, sid, content, finish) => void this.streamReply(f as typeof frame, sid, content, finish),
    }
    const identity: ChatIdentity = {
      key: `telegram:${chat.id}`,
      frame,
      sink,
      chatType: (chat.type ?? 'private') === 'private' ? 'single' : 'group',
    }
    console.log('[dsh-message-gateway] telegram text', { chatId: chat.id, text: text.slice(0, 60), atts: attachments.length })
    this.callbacks.onText(text, identity, attachments.length > 0 ? attachments : undefined)
  }

  /** 官方文档：getFile(file_id) → file_path → https://api.telegram.org/file/bot<token>/<file_path>。 */
  private async downloadTelegramFile(fileId: string): Promise<Uint8Array | null> {
    try {
      const result = (await this.api('getFile', { file_id: fileId })) as { result?: { file_path?: string } }
      const filePath = result?.result?.file_path
      if (filePath === undefined || filePath === '') return null
      const dispatcher = await getProxyDispatcher()
      const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
        signal: AbortSignal.timeout(60_000),
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit)
      if (!response.ok) return null
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      console.warn('[dsh-message-gateway] telegram download failed', fileId, String(error))
      return null
    }
  }

  /** 流式回复：状态合并 + 单 worker——首次 sendMessage，随后 editMessageText 渐进更新（限频）。 */
  private async streamReply(frame: { chatId: number }, streamId: string, content: string, finish: boolean): Promise<void> {
    const prev = this.state.get(streamId)
    this.state.set(streamId, { content, finish: finish || (prev?.finish ?? false) })
    if (this.working.has(streamId)) return
    this.working.add(streamId)
    try {
      for (let guard = 0; guard < 200; guard += 1) {
        const current = this.state.get(streamId)
        if (current === undefined) break
        const text = current.content === '' ? ' ' : current.content
        const existing = this.streams.get(streamId)
        if (existing === undefined) {
          if (current.content === '' && !current.finish) break
          const result = await this.sendText(frame.chatId, text)
          if (result === null) break
          this.streams.set(streamId, { chatId: frame.chatId, messageId: result.messageId, lastEdit: Date.now() })
          if (current.finish || this.state.get(streamId)!.content === current.content) break
          continue
        }
        const wait = EDIT_INTERVAL_MS - (Date.now() - existing.lastEdit)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        existing.lastEdit = Date.now()
        const ok = await this.editText(existing.chatId, existing.messageId, text)
        if (!ok && current.finish) {
          this.streams.delete(streamId)
          break
        }
        if (current.finish || this.state.get(streamId)!.content === current.content) break
      }
    } catch (error) {
      console.error('[dsh-message-gateway] telegram reply failed', error)
    } finally {
      this.working.delete(streamId)
    }
  }

  /** 主动推送：以机器人身份向指定 chat 发送文本（不经回复管线，无编辑）。 */
  async send(chatId: number, content: string): Promise<boolean> {
    const result = await this.sendText(chatId, content)
    return result !== null
  }

  /**
   * 主动推送图片：向指定 chat 发送照片（支持 Buffer 或图片 URL）。
   * @param chatId 目标聊天 ID
   * @param photo 图片数据 Buffer 或公网图片 URL
   * @param caption 可选图片附带文字说明
   * @param filename 可选文件名
   */
  async sendPhoto(chatId: number, photo: Buffer | string, caption?: string, filename = 'photo.png'): Promise<boolean> {
    try {
      if (typeof photo === 'string') {
        const body: Record<string, unknown> = { chat_id: chatId, photo }
        if (caption) body.caption = caption.slice(0, 1024)
        const result = (await this.api('sendPhoto', body)) as { message_id?: number } | null
        return result?.message_id !== undefined
      }
      // multipart/form-data 上传 Buffer
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append('photo', new Blob([new Uint8Array(photo)]), filename)
      if (caption) form.append('caption', caption.slice(0, 1024))
      const response = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) return false
      const data = (await response.json()) as { ok?: boolean }
      return data.ok === true
    } catch (error) {
      console.error('[dsh-message-gateway] telegram sendPhoto failed', error)
      return false
    }
  }

  /** 发送文本（Markdown 失败自动降级纯文本）。 */
  private async sendText(chatId: number, text: string): Promise<{ messageId: number } | null> {
    const body = { chat_id: chatId, text: text.slice(0, MSG_LIMIT), parse_mode: 'Markdown', disable_web_page_preview: true }
    const result = (await this.api('sendMessage', body)) as { message_id?: number } | null
    if (result?.message_id !== undefined) return { messageId: result.message_id }
    const plain = (await this.api('sendMessage', { chat_id: chatId, text: text.slice(0, MSG_LIMIT), disable_web_page_preview: true })) as { message_id?: number } | null
    return plain?.message_id !== undefined ? { messageId: plain.message_id } : null
  }

  /** 编辑消息（Markdown 失败自动降级纯文本）。 */
  private async editText(chatId: number, messageId: number, text: string): Promise<boolean> {
    const body = { chat_id: chatId, message_id: messageId, text: text.slice(0, MSG_LIMIT), parse_mode: 'Markdown' }
    if ((await this.api('editMessageText', body)) !== null) return true
    const plain = (await this.api('editMessageText', { chat_id: chatId, message_id: messageId, text: text.slice(0, MSG_LIMIT) })) !== null
    return plain
  }

  /** 停止长轮询。 */
  stop(): void {
    this.stopped = true
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.streams.clear()
    this.setStatus('idle')
  }
}