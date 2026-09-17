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
import { downloadBytes, type IncomingAttachment } from './incoming.ts'

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
    attachments?: IncomingAttachment[],
  ) => void
}

export class DingTalkBridge {
  private client: DWClient | null = null
  private started = false
  /** 企业内部应用 accessToken 缓存（下载机器人消息文件需要）。 */
  private accessToken: string | null = null
  private accessTokenExpiresAt = 0
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
          const raw = JSON.parse(downstream.data || '{}') as Partial<RobotTextMessage> & {
            msgtype?: string
            content?: { downloadCode?: string; richText?: Array<{ text?: string; type?: string; downloadCode?: string }>; recognition?: string }
            robotCode?: string
          }
          // 立即给钉钉服务端发送响应，避免服务端超时 60s 内重发
          this.client?.socketCallBackResponse(downstream.headers.messageId, {
            response: {
              statusLine: { code: 200, reasonPhrase: 'OK' },
              headers: {},
              body: JSON.stringify({ status: 'SUCCESS' }),
            },
          })

          // 官方文档字段位置注意：文本在 text.content，图片下载码在 content.downloadCode。
          const msgtype = raw.msgtype ?? 'text'
          const robotCode = raw.robotCode ?? this.cred.robotCode ?? ''
          let text = ''
          const attachments: IncomingAttachment[] = []
          const notes: string[] = []

          if (msgtype === 'text') {
            text = raw.text?.content?.trim() || ''
          } else if (msgtype === 'picture') {
            const downloadCode = raw.content?.downloadCode ?? ''
            const data = await this.downloadRobotFile(downloadCode, robotCode)
            if (data === null) text = '（图片下载失败）'
            else attachments.push({ kind: 'image', data, name: `dingtalk-${raw.msgId ?? Date.now()}.jpg` })
          } else if (msgtype === 'richText') {
            // 官方结构：content.richText[] 中 text 与 picture（downloadCode）交替。
            const nodes = raw.content?.richText ?? []
            const texts: string[] = []
            for (const node of nodes) {
              if (typeof node.text === 'string' && node.text !== '') texts.push(node.text)
              else if (node.type === 'picture' && node.downloadCode !== undefined) {
                const data = await this.downloadRobotFile(node.downloadCode, robotCode)
                if (data !== null) attachments.push({ kind: 'image', data, name: `dingtalk-${Date.now()}.jpg` })
                else notes.push('（富文本图片下载失败）')
              }
            }
            text = texts.join('')
          } else if (msgtype === 'audio') {
            // 官方提供 recognition（语音识别文本）；群聊 @机器人 收不到 audio。
            text = raw.content?.recognition?.trim() || '（收到语音消息，但平台未提供识别文本）'
            const downloadCode = raw.content?.downloadCode ?? ''
            if (downloadCode !== '') {
              const data = await this.downloadRobotFile(downloadCode, robotCode)
              if (data !== null) attachments.push({ kind: 'file', data, name: `voice-${Date.now()}.bin` })
            }
          } else if (msgtype === 'video' || msgtype === 'file') {
            // 官方限制：群聊 @机器人 场景收不到 video/file，仅单聊支持。
            const downloadCode = raw.content?.downloadCode ?? ''
            const data = await this.downloadRobotFile(downloadCode, robotCode)
            if (data === null) notes.push(`（${msgtype === 'video' ? '视频' : '文件'}下载失败，或该场景不支持接收）`)
            else attachments.push({ kind: 'file', data, name: `dingtalk-${Date.now()}.bin` })
          } else {
            // 绝不静默丢弃。
            text = `（收到钉钉「${msgtype}」类型消息，暂不支持处理）`
          }

          if (notes.length > 0) text = text === '' ? notes.join('\n') : `${text}\n${notes.join('\n')}`
          if (text.trim() === '' && attachments.length === 0) return

          const isGroup = raw.conversationType === '2'
          const sessionWebhook = raw.sessionWebhook || ''

          this.callbacks.onText(text.trim(), {
            conversationId: raw.conversationId || '',
            msgId: raw.msgId || downstream.headers.messageId,
            senderNick: raw.senderNick || '',
            senderStaffId: raw.senderStaffId || '',
            sessionWebhook,
            chatType: isGroup ? 'group' : 'single',
          }, attachments.length > 0 ? attachments : undefined)
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
   * 取企业内部应用 accessToken（官方 v1.0 接口，AppKey/AppSecret）。
   * 带 60 秒提前过期的本地缓存，避免每条附件都换一次令牌。
   */
  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken !== null && Date.now() < this.accessTokenExpiresAt) return this.accessToken
    try {
      const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appKey: this.cred.clientId, appSecret: this.cred.clientSecret }),
      })
      if (!response.ok) {
        console.warn('[dsh-message-gateway] dingtalk accessToken http', response.status)
        return null
      }
      const body = (await response.json()) as { accessToken?: string; expireIn?: number }
      if (typeof body.accessToken !== 'string' || body.accessToken === '') return null
      this.accessToken = body.accessToken
      this.accessTokenExpiresAt = Date.now() + Math.max(0, (body.expireIn ?? 7200) - 60) * 1000
      return this.accessToken
    } catch (error) {
      console.warn('[dsh-message-gateway] dingtalk accessToken failed', String(error))
      return null
    }
  }

  /**
   * 下载机器人接收到的消息文件。
   *
   * 官方文档两步走：
   * 1. `POST /v1.0/robot/messageFiles/download`（header `x-acs-dingtalk-access-token`，
   *    body `{ downloadCode, robotCode }`）→ `{ downloadUrl }`
   * 2. GET 该 downloadUrl 取二进制（返回的文件名无扩展名，官方要求自行判断/替换）
   */
  private async downloadRobotFile(downloadCode: string, robotCode: string): Promise<Uint8Array | null> {
    if (downloadCode === '') return null
    const token = await this.getAccessToken()
    if (token === null) return null
    try {
      const response = await fetch('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
        method: 'POST',
        headers: { 'x-acs-dingtalk-access-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ downloadCode, robotCode }),
      })
      if (!response.ok) {
        console.warn('[dsh-message-gateway] dingtalk file download http', response.status)
        return null
      }
      const body = (await response.json()) as { downloadUrl?: string }
      if (typeof body.downloadUrl !== 'string' || body.downloadUrl === '') return null
      return await downloadBytes(body.downloadUrl, { timeoutMs: 60_000 })
    } catch (error) {
      console.warn('[dsh-message-gateway] dingtalk file download failed', String(error))
      return null
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
