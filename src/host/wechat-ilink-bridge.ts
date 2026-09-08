/**
 * 微信官方智能机器人（Tencent iLink Bot 协议）原生常驻桥。
 * 直接基于腾讯官方 ilinkai.weixin.qq.com 协议标准接入：
 * 1. 免第三方框架，免本地安装运行其他客户端；
 * 2. 支持获取登录二维码与扫码状态轮询；
 * 3. 登录后通过 getupdates 长轮询监听好友私聊与群聊消息；
 * 4. 收到消息后接入 DSH 独立 Agent 管线与工具链，并通过 sendmessage 回传定稿文本；
 * 5. 优雅退出时释放轮询定时器与网络请求。
 *
 * @module dsh-message-gateway/host/wechat-ilink-bridge
 */

import crypto from 'node:crypto'
import type { BridgeStatus } from './wecom-bridge.ts'
import type { ChatIdentity, ReplySink } from './bridge-manager.ts'

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
// 0x00020408 = 2.4.8
const ILINK_CLIENT_VERSION = ((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (8 & 0xff)

export interface WechatIlinkBridgeCallbacks {
  onStatus: (status: BridgeStatus) => void
  onText: (text: string, identity: ChatIdentity) => void
}

export interface WechatIlinkCred {
  botToken: string
  baseUrl?: string
  botId?: string
  userId?: string
  nickname?: string
}

export class WechatIlinkBridge {
  private stopped = false
  private pollController: AbortController | null = null
  private syncBuf = ''
  private readonly cred: WechatIlinkCred
  private readonly callbacks: WechatIlinkBridgeCallbacks
  status: BridgeStatus = { state: 'idle', detail: '', connectedAt: null }

  constructor(
    cred: WechatIlinkCred,
    callbacks: WechatIlinkBridgeCallbacks,
  ) {
    this.cred = cred
    this.callbacks = callbacks
  }

  private setStatus(state: BridgeStatus['state'], detail = ''): void {
    this.status = {
      state,
      detail,
      connectedAt: state === 'connected' ? (this.status.connectedAt ?? Date.now()) : null,
    }
    this.callbacks.onStatus(this.status)
  }

  private static randomWechatUin(): string {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0)
    return Buffer.from(String(uint32), 'utf-8').toString('base64')
  }

  private static buildHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
      'X-WECHAT-UIN': WechatIlinkBridge.randomWechatUin(),
    }
    if (token?.trim()) {
      headers['Authorization'] = `Bearer ${token.trim()}`
      headers['AuthorizationType'] = 'ilink_bot_token'
    }
    return headers
  }

  /**
   * 生成微信扫码登录二维码。
   * 返回 qrcode key 与完整二维码展示图片/扫码 URL。
   */
  static async getLoginQr(): Promise<{ qrcode: string; qrcodeUrl: string }> {
    const url = `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`
    const resp = await fetch(url, {
      method: 'POST',
      headers: WechatIlinkBridge.buildHeaders(),
      body: JSON.stringify({ local_token_list: [] }),
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) {
      throw new Error(`get_bot_qrcode failed: HTTP ${resp.status}`)
    }
    const data = (await resp.json()) as { qrcode: string; qrcode_img_content?: string }
    const qrcode = data.qrcode
    const rawTarget = data.qrcode_img_content || `https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_img?qrcode=${encodeURIComponent(qrcode)}`
    let qrcodeUrl = rawTarget
    try {
      const QRCode = (await import('qrcode')) as any
      qrcodeUrl = await QRCode.toDataURL(rawTarget, { width: 220, margin: 1 })
    } catch (e) {
      console.warn('[dsh-message-gateway] QRCode.toDataURL error', e)
    }
    return { qrcode, qrcodeUrl }
  }

  /**
   * 轮询扫码状态。
   */
  static async pollQrStatus(qrcode: string): Promise<{
    status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
    botToken?: string
    baseUrl?: string
    botId?: string
    userId?: string
  }> {
    const url = `${ILINK_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    const resp = await fetch(url, {
      method: 'GET',
      headers: WechatIlinkBridge.buildHeaders(),
      signal: AbortSignal.timeout(35000),
    })
    if (!resp.ok) {
      return { status: 'wait' }
    }
    const data = (await resp.json()) as {
      status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
      bot_token?: string
      baseurl?: string
      ilink_bot_id?: string
      ilink_user_id?: string
    }
    return {
      status: data.status,
      botToken: data.bot_token,
      baseUrl: data.baseurl || ILINK_BASE_URL,
      botId: data.ilink_bot_id,
      userId: data.ilink_user_id,
    }
  }

  /**
   * 启动长轮询消息监听。
   */
  start(): void {
    if (this.status.state === 'connected') return
    this.stopped = false
    const label = this.cred.nickname || this.cred.userId ? `@${this.cred.nickname || this.cred.userId}` : '微信智能机器人'
    this.setStatus('connected', label)
    console.log('[dsh-message-gateway] wechat ilink bridge started for', label)
    void this.pollLoop()
  }

  private async pollLoop(): Promise<void> {
    const baseUrl = this.cred.baseUrl || ILINK_BASE_URL
    while (!this.stopped) {
      try {
        this.pollController = new AbortController()
        const timeoutId = setTimeout(() => this.pollController?.abort(), 35000)
        const resp = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
          method: 'POST',
          headers: WechatIlinkBridge.buildHeaders(this.cred.botToken),
          body: JSON.stringify({
            get_updates_buf: this.syncBuf,
            base_info: { channel_version: '2.4.8', bot_agent: 'DSH-Message-Gateway' },
          }),
          signal: this.pollController.signal,
        })
        clearTimeout(timeoutId)

        if (!resp.ok) {
          if (resp.status === 401 || resp.status === 403) {
            this.setStatus('error', 'Token 已失效，请重新扫码')
            break
          }
          await new Promise((r) => setTimeout(r, 3000))
          continue
        }

        const data = (await resp.json()) as {
          ret?: number
          msgs?: Array<any>
          get_updates_buf?: string
        }

        if (data.get_updates_buf) {
          this.syncBuf = data.get_updates_buf
        }

        const msgs = data.msgs ?? []
        for (const msg of msgs) {
          // 消息类型：1=USER，2=BOT。仅处理用户消息
          if (msg.message_type !== 1) continue
          this.handleInboundMessage(msg)
        }
      } catch (err) {
        if (this.stopped) break
        const isAbort = err instanceof Error && err.name === 'AbortError'
        if (!isAbort) {
          console.warn('[dsh-message-gateway] wechat getupdates error, retrying in 2s:', err)
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    }
  }

  /**
   * 处理单条从微信拉取到的消息。
   */
  private handleInboundMessage(msg: any): void {
    const fromUser = String(msg.from_user_id ?? '')
    if (!fromUser) return

    // 提取文本内容
    let text = ''
    if (Array.isArray(msg.item_list)) {
      for (const item of msg.item_list) {
        if (item.type === 1 && item.text_item?.text) {
          text += (text ? '\n' : '') + String(item.text_item.text).trim()
        }
      }
    }
    if (!text) return

    const contextToken = msg.context_token ?? ''
    const sessionId = msg.session_id || fromUser
    const frame = {
      fromUser,
      contextToken,
      sessionId,
      msgId: msg.message_id,
    }

    // 启动「正在输入中…」打字态心跳
    let typingTimer: ReturnType<typeof setInterval> | null = null
    let typingTicket = ''

    const startTyping = async () => {
      try {
        typingTicket = await this.getTypingTicket(fromUser, contextToken)
        if (typingTicket) {
          await this.sendTypingIndicator(fromUser, typingTicket)
          // 微信客户端的输入态通常维持 5~10 秒，每 4.5 秒发一次心跳续期
          typingTimer = setInterval(() => {
            void this.sendTypingIndicator(fromUser, typingTicket)
          }, 4500)
        }
      } catch (err) {
        console.warn('[dsh-message-gateway] wechat startTyping failed', err)
      }
    }
    void startTyping()

    const sink: ReplySink = {
      stream: (_f, _streamId, content, finish) => {
        // 当 DSH Agent 终局完成（finish=true）时，清理输入中心跳，并发出定稿消息
        if (finish) {
          if (typingTimer) {
            clearInterval(typingTimer)
            typingTimer = null
          }
          if (content.trim()) {
            void this.sendMessage(fromUser, content, contextToken)
          }
        }
      },
      ack: false,
    }

    const identity: ChatIdentity = {
      key: `wechat:${sessionId}`,
      frame,
      sink,
      chatType: msg.group_id ? 'group' : 'single',
    }

    this.callbacks.onText(text, identity)
  }

  /**
   * 获取微信用户的 typing_ticket（打字态凭证）。
   */
  async getTypingTicket(userId: string, contextToken?: string): Promise<string> {
    const baseUrl = this.cred.baseUrl || ILINK_BASE_URL
    try {
      const resp = await fetch(`${baseUrl}/ilink/bot/getconfig`, {
        method: 'POST',
        headers: WechatIlinkBridge.buildHeaders(this.cred.botToken),
        body: JSON.stringify({
          ilink_user_id: userId,
          context_token: contextToken || '',
          base_info: { channel_version: '2.4.8', bot_agent: 'DSH-Message-Gateway' },
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) return ''
      const data = (await resp.json()) as { typing_ticket?: string }
      return data.typing_ticket ?? ''
    } catch {
      return ''
    }
  }

  /**
   * 向微信客户端发送「对方正在输入…」指示。
   */
  async sendTypingIndicator(toUserId: string, typingTicket: string): Promise<boolean> {
    if (!typingTicket) return false
    const baseUrl = this.cred.baseUrl || ILINK_BASE_URL
    try {
      const resp = await fetch(`${baseUrl}/ilink/bot/sendtyping`, {
        method: 'POST',
        headers: WechatIlinkBridge.buildHeaders(this.cred.botToken),
        body: JSON.stringify({
          ilink_user_id: toUserId,
          typing_ticket: typingTicket,
          base_info: { channel_version: '2.4.8', bot_agent: 'DSH-Message-Gateway' },
        }),
        signal: AbortSignal.timeout(6000),
      })
      if (!resp.ok) return false
      const data = (await resp.json()) as { ret?: number }
      return data.ret === 0
    } catch {
      return false
    }
  }

  /**
   * 发送回复消息回微信用户。
   */
  async sendMessage(toUserId: string, content: string, contextToken?: string): Promise<boolean> {
    const baseUrl = this.cred.baseUrl || ILINK_BASE_URL
    const clientId = `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      const resp = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: WechatIlinkBridge.buildHeaders(this.cred.botToken),
        body: JSON.stringify({
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: clientId,
            message_type: 2, // BOT
            message_state: 2, // FINISH
            context_token: contextToken || '',
            item_list: [
              {
                type: 1, // TEXT
                text_item: { text: content },
              },
            ],
          },
          base_info: { channel_version: '2.4.8', bot_agent: 'DSH-Message-Gateway' },
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) {
        console.error('[dsh-message-gateway] wechat sendmessage failed:', resp.status)
        return false
      }
      const data = (await resp.json()) as { ret?: number }
      return data.ret === 0
    } catch (err) {
      console.error('[dsh-message-gateway] wechat sendmessage error:', err)
      return false
    }
  }

  /**
   * 停止微信长轮询连接。
   */
  stop(): void {
    this.stopped = true
    this.pollController?.abort()
    this.pollController = null
    this.setStatus('idle')
  }
}
