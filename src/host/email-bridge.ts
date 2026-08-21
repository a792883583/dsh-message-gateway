/**
 * Email 桥：IMAP 轮询收件 + SMTP 回复。无第三方依赖（node:net / node:tls）。
 * - 收件：IMAP（993 隐式 TLS / 143 STARTTLS / 143 明文）定时轮询 INBOX 未读邮件，
 *   提取 发件人/主题/Message-ID/References，按「会话线程」映射到独立 agent 会话。
 * - 回复：SMTP（465 隐式 TLS / 587、25 STARTTLS）以 Re: 原主题回复发件人。
 * 邮件无「流式编辑」，回复仅在定稿时发送（不发送处理回执，避免一封回一封）。
 * @module dsh-message-gateway/host/email-bridge
 */

import { connect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { BridgeStatus } from './wecom-bridge.ts'
import type { ChatIdentity, ReplySink } from './bridge-manager.ts'

export interface EmailCred {
  imapHost: string
  imapPort: string
  imapUser: string
  imapPass: string
  smtpHost?: string
  smtpPort?: string
  smtpUser?: string
  smtpPass?: string
}

export interface EmailBridgeCallbacks {
  onStatus(status: BridgeStatus): void
  onText(text: string, identity: ChatIdentity): void
}

/** 轮询间隔。 */
const POLL_MS = 30_000
const RETRY_MS = 5_000
const MAX_BODY = 12_000

// ==================== IMAP 客户端 ====================

interface Pending {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 极简 IMAP 客户端：LOGIN / SELECT / SEARCH / FETCH / STORE，支持字面量与 TLS。 */
export class ImapClient {
  private socket: Socket | TLSSocket | null = null
  private buffer = ''
  private pending = new Map<string, Pending>()
  private untagged: string[] = []
  private tagSeq = 0

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly user: string,
    private readonly pass: string,
  ) {}

  /** 是否走 TLS：993=隐式 TLS；其余端口尝试 STARTTLS（失败则明文）。 */
  private get secure(): boolean {
    return this.port === 993
  }

  private wire(socket: Socket | TLSSocket): void {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      this.process()
    })
    socket.on('error', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('imap connection error'))
      }
      this.pending.clear()
    })
    socket.on('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('imap connection closed'))
      }
      this.pending.clear()
    })
  }

  /** 建立连接：读问候 → 可选 STARTTLS 升级。 */
  async connect(timeoutMs = 15_000): Promise<void> {
    if (this.secure) {
      const tls = tlsConnect({ host: this.host, port: this.port, rejectUnauthorized: false })
      this.wire(tls)
      await this.waitGreeting(timeoutMs)
      return
    }
    const raw = connect({ host: this.host, port: this.port })
    this.wire(raw)
    await this.waitGreeting(timeoutMs)
    // STARTTLS（143 默认启用；失败不阻塞——部分服务器未开启）。
    try {
      const res = await this.command('STARTTLS', 10_000)
      if (/^a\d+ OK/i.test(res.trim())) {
        raw.removeAllListeners('data')
        const tls = tlsConnect({ socket: raw, rejectUnauthorized: false })
        this.wire(tls)
        await this.waitGreeting(10_000)
      }
    } catch {
      /* 服务器不支持 STARTTLS → 明文继续 */
    }
  }

  private waitGreeting(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll)
        reject(new Error('imap greeting timeout'))
      }, timeoutMs)
      const check = (): void => {
        const idx = this.untagged.findIndex((l) => l.startsWith('* OK'))
        if (idx !== -1) {
          clearTimeout(timer)
          clearInterval(poll)
          this.untagged.splice(idx, 1)
          resolve()
        }
      }
      // 简单轮询 greeting（数据到达即被 process() 消费进 untagged）。
      const poll = setInterval(check, 20)
      check()
      this.socket?.once('error', () => {
        clearTimeout(timer)
        clearInterval(poll)
        reject(new Error('imap greeting error'))
      })
    })
  }

  /** 发送命令并等待完成标记（tag OK/NO/BAD），返回含未标记响应的全文。 */
  async command(cmd: string, timeoutMs = 20_000): Promise<string> {
    const tag = `a${++this.tagSeq}`
    const full = `${tag} ${cmd}\r\n`
    const existing = this.socket
    if (existing === null || existing.destroyed) throw new Error('imap not connected')
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tag)
        reject(new Error(`imap command timeout: ${cmd.split(' ')[0]}`))
      }, timeoutMs)
      this.pending.set(tag, { resolve, reject, timer })
      existing.write(full)
    })
  }

  /** 解析输入：完整行 + 字面量块。 */
  private process(): void {
    for (;;) {
      const literal = this.buffer.match(/^[^\r\n]*\{(\d+)\}\r\n/)
      if (literal !== null) {
        const size = Number(literal[1])
        if (this.buffer.length < literal[0].length + size) return
        const block = this.buffer.slice(0, literal[0].length + size)
        this.buffer = this.buffer.slice(literal[0].length + size)
        if (this.buffer.startsWith('\r\n')) this.buffer = this.buffer.slice(2)
        this.dispatch(block)
        continue
      }
      const line = this.buffer.match(/^[^\r\n]*\r\n/)
      if (line === null) return
      this.buffer = this.buffer.slice(line[0].length)
      this.dispatch(line[0])
    }
  }

  private dispatch(line: string): void {
    const trimmed = line.trim()
    const tagged = trimmed.match(/^(a\d+) (OK|NO|BAD)(.*)$/)
    if (tagged !== null) {
      const pending = this.pending.get(tagged[1])
      if (pending !== undefined) {
        clearTimeout(pending.timer)
        this.pending.delete(tagged[1])
        const collected = [...this.untagged, line].join('')
        this.untagged = []
        if (tagged[2] === 'OK') pending.resolve(collected)
        else pending.reject(new Error(`IMAP ${tagged[2]} ${tagged[3].trim()}`))
      }
      return
    }
    // 非完成标记的响应行/字面量块都累积（FETCH 的 BODY[TEXT] 块不以 * 开头）。
    this.untagged.push(line)
  }

  async login(): Promise<void> {
    await this.command(`LOGIN "${this.user}" "${this.pass}"`)
  }

  async select(): Promise<void> {
    await this.command('SELECT INBOX')
  }

  /** 未读消息序号列表。 */
  async searchUnseen(): Promise<number[]> {
    const res = await this.command('SEARCH UNSEEN')
    const match = res.match(/\* SEARCH ([\d ]*)/)
    if (match === null) return []
    return match[1].trim().split(/\s+/).filter((s) => s !== '').map(Number)
  }

  /** FETCH 头部与正文（BODY.PEEK 不置已读）。 */
  async fetchMessage(id: number): Promise<{ uid: string; header: string; text: string }> {
    const res = await this.command(
      `FETCH ${id} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID REFERENCES IN-REPLY-TO)] BODY.PEEK[TEXT])`,
      30_000,
    )
    const uid = res.match(/UID (\d+)/)?.[1] ?? String(id)
    const header = literalAt(res, 'BODY[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID REFERENCES IN-REPLY-TO)]')?.value ?? ''
    const text = literalAt(res, 'BODY[TEXT]')?.value ?? ''
    return { uid, header, text }
  }

  async markSeen(id: number): Promise<void> {
    await this.command(`STORE ${id} +FLAGS (\\Seen)`)
  }

  close(): void {
    try {
      this.socket?.end()
    } catch {
      /* 忽略 */
    }
    this.socket = null
  }
}

/** 从 IMAP 响应中按字面量长度精确截取指定标记后的块。 */
function literalAt(text: string, marker: string): { value: string } | null {
  const idx = text.indexOf(marker)
  if (idx === -1) return null
  const sizeMatch = text.slice(idx + marker.length).match(/^ ?\{(\d+)\}\r\n/)
  if (sizeMatch === null) return null
  const size = Number(sizeMatch[1])
  const start = idx + marker.length + sizeMatch[0].length
  return { value: text.slice(start, start + size) }
}

// ==================== SMTP 客户端 ====================

/** 极简 SMTP 客户端：EHLO / AUTH LOGIN / MAIL / RCPT / DATA。 */
export class SmtpClient {
  private onResponse: (code: string, text: string, done: (ok: boolean) => void) => void = () => {}

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly user: string,
    private readonly pass: string,
    private readonly from: string,
  ) {}

  /** 是否隐式 TLS：465 直连 TLS；587/25 走 STARTTLS。 */
  private get secure(): boolean {
    return this.port === 465
  }

  /** 发送一封邮件；返回是否成功。 */
  async send(to: string, subject: string, body: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      let socket: Socket | TLSSocket
      let step = 'greeting'
      let buffer = ''
      const afterTls = (sock: Socket | TLSSocket, isWrap: boolean): void => {
        socket = sock
        if (isWrap) sock.removeAllListeners('data')
        sock.setEncoding('utf8')
        sock.on('data', (chunk: string) => {
          buffer += chunk
          drive()
        })
        sock.on('error', () => {
          if (step !== 'done') {
            step = 'done'
            resolve(false)
          }
        })
        sock.on('close', () => {
          if (step !== 'done') {
            step = 'done'
            resolve(false)
          }
        })
      }
      const drive = (): void => {
        if (step === 'done') return
        const parts = buffer.split('\r\n')
        if (parts[parts.length - 1] === '') parts.pop()
        if (parts.length === 0) return
        const tail = parts[parts.length - 1]
        // 多行响应以最后一行「code 」为完成标志（250-… 中间行以 - 结尾）。
        if (!/^\d{3}( |$)/.test(tail)) return
        buffer = ''
        const resp = parts[0]
        // done(ok) 始终 resolve，避免失败路径挂起。
        this.onResponse(resp.slice(0, 3), resp.slice(4), (ok) => resolve(ok))
      }
      const send = (line: string): void => {
        socket.write(`${line}\r\n`)
      }
      this.onResponse = (code, text, done) => {
        switch (step) {
          case 'greeting': {
            if (code === '220') {
              step = this.secure ? 'ehlo' : 'starttls'
              send(`EHLO dsh-message-gateway`)
            } else {
              step = 'done'
              done(false)
            }
            break
          }
          case 'starttls': {
            if (code === '250') {
              step = 'tls-upgrade'
              send('STARTTLS')
            } else {
              step = 'auth'
              send(`AUTH LOGIN`)
            }
            break
          }
          case 'tls-upgrade': {
            if (code === '220') {
              step = 'ehlo-tls'
              const tls = tlsConnect({ socket: socket as Socket, rejectUnauthorized: false })
              afterTls(tls, true)
              send(`EHLO dsh-message-gateway`)
            } else {
              // STARTTLS 不受支持 → 回退明文 AUTH（部分服务器允许）。
              step = 'auth'
              send(`AUTH LOGIN`)
            }
            break
          }
          case 'ehlo':
          case 'ehlo-tls': {
            if (code === '250') {
              step = 'auth'
              send(`AUTH LOGIN`)
            } else {
              step = 'done'
              done(false)
            }
            break
          }
          case 'auth': {
            if (code === '334') {
              step = 'auth-user'
              send(Buffer.from(this.user, 'utf8').toString('base64'))
            } else {
              step = 'done'
              done(false)
            }
            break
          }
          case 'auth-user': {
            if (code === '334') {
              step = 'auth-pass'
              send(Buffer.from(this.pass, 'utf8').toString('base64'))
            } else {
              step = 'done'
              done(false)
            }
            break
          }
          case 'auth-pass': {
            if (code === '235') {
              step = 'mail'
              send(`MAIL FROM:<${this.from}>`)
            } else {
              step = 'done'
              done(false)
            }
            break
          }
          case 'mail': {
            if (code === '250') {
              step = 'rcpt'
              send(`RCPT TO:<${to}>`)
            } else {
              step = 'done'
              done(false)
            }
            break
          }
          case 'rcpt': {
            if (code === '250') {
              step = 'data'
              send('DATA')
            } else {
              step = 'done'
              done(false)
            }
            break
          }
          case 'data': {
            if (code === '354') {
              step = 'content'
              const headers = [
                `From: ${this.from}`,
                `To: ${to}`,
                `Subject: ${subject}`,
                'MIME-Version: 1.0',
                'Content-Type: text/plain; charset=utf-8',
                'Content-Transfer-Encoding: 8bit',
              ].join('\r\n')
              send(`${headers}\r\n\r\n${body}\r\n.`)
            } else {
              step = 'done'
              done(false)
            }
            break
          }
          case 'content': {
            if (code === '250') {
              step = 'quit'
              send('QUIT')
              done(true)
            } else {
              step = 'done'
              done(false)
            }
            break
          }
          default:
            step = 'done'
            done(false)
        }
      }
      const raw = this.secure
        ? tlsConnect({ host: this.host, port: this.port, rejectUnauthorized: false })
        : connect({ host: this.host, port: this.port })
      afterTls(raw, false)
    })
  }
}

// ==================== Email 桥 ====================

/** 从头部文本提取字段（含折叠行）。 */
export function headerField(header: string, name: string): string {
  const match = header.match(new RegExp(`^${name}:(?:[ \\t]*(?:\\r\\n[ \\t]+[^\\r\\n]*)*[ \\t]*[^\\r\\n]*)`, 'im'))
  if (match === null) return ''
  return match[0].replace(new RegExp(`^${name}:`, 'i'), '').replace(/\r\n[ \t]+/g, ' ').trim()
}

/** 去掉 <...> 尖括号与引号，取第一个邮箱。 */
export function parseAddress(raw: string): string {
  const angle = raw.match(/<([^<>]+)>/)
  return (angle?.[1] ?? raw).trim().replace(/^["']|["']$/g, '')
}

/** 粗略清洗邮件正文：去 HTML 标签、折叠空行、限长。 */
export function cleanBody(raw: string): string {
  let text = raw
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length > MAX_BODY) text = text.slice(0, MAX_BODY)
  return text
}

export class EmailBridge {
  private stopped = true
  private imap: ImapClient | null = null
  private seen = new Set<string>()
  status: BridgeStatus = { state: 'idle', detail: '', connectedAt: null }

  constructor(
    private readonly cred: EmailCred,
    private readonly callbacks: EmailBridgeCallbacks,
  ) {}

  private setStatus(state: BridgeStatus['state'], detail = ''): void {
    this.status = { state, detail, connectedAt: state === 'connected' ? Date.now() : this.status.connectedAt }
    this.callbacks.onStatus(this.status)
  }

  /** 启动轮询循环。 */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.setStatus('connecting', 'imap')
    void this.loop()
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        if (this.imap === null) {
          const imap = new ImapClient(
            this.cred.imapHost,
            Number(this.cred.imapPort || '143'),
            this.cred.imapUser,
            this.cred.imapPass,
          )
          await imap.connect()
          await imap.login()
          await imap.select()
          this.imap = imap
          this.setStatus('connected', 'email')
        }
        const ids = await this.imap.searchUnseen()
        for (const id of ids) {
          if (this.stopped) break
          await this.processMessage(id)
        }
        await sleep(POLL_MS)
      } catch (error) {
        console.warn('[dsh-message-gateway] email poll error', String(error))
        this.imap?.close()
        this.imap = null
        this.setStatus('error', 'imap error')
        await sleep(RETRY_MS)
      }
    }
  }

  private async processMessage(id: number): Promise<void> {
    if (this.imap === null) return
    let fetched: { uid: string; header: string; text: string }
    try {
      fetched = await this.imap.fetchMessage(id)
    } catch {
      return
    }
    if (this.seen.has(fetched.uid)) {
      void this.imap.markSeen(id).catch(() => {})
      return
    }
    this.seen.add(fetched.uid)
    // 线程键：References 最旧祖先 / In-Reply-To / 自身 Message-ID。
    const references = headerField(fetched.header, 'References')
      .split(/[\s,<>]+/).filter((s) => s.includes('@'))
    const inReplyTo = parseAddress(headerField(fetched.header, 'In-Reply-To'))
    const messageId = parseAddress(headerField(fetched.header, 'Message-ID'))
    const threadKey = references[0] ?? (inReplyTo !== '' ? inReplyTo : messageId)
    const from = parseAddress(headerField(fetched.header, 'From'))
    const subject = headerField(fetched.header, 'Subject')
    const text = cleanBody(fetched.text)
    void this.imap.markSeen(id).catch(() => {})
    if (from === '' || text.trim() === '') return
    const frame = { from, subject, threadKey }
    const sink: ReplySink = {
      ack: false, // 邮件不发送「正在处理…」回执
      stream: (f, _sid, content, finish) => {
        if (!finish) return
        void this.sendReply(f as typeof frame, content)
      },
    }
    const identity: ChatIdentity = {
      key: `email:${threadKey === '' ? 'default' : threadKey}`,
      frame,
      sink,
      chatType: 'single',
    }
    console.log('[dsh-message-gateway] email text', { from, subject: subject.slice(0, 40), len: text.length })
    this.callbacks.onText(text, identity)
  }

  private async sendReply(frame: { from: string; subject: string }, content: string): Promise<void> {
    try {
      const smtpHost = this.cred.smtpHost ?? this.cred.imapHost
      const smtpPort = Number(this.cred.smtpPort || '465')
      const smtpUser = this.cred.smtpUser ?? this.cred.imapUser
      const smtpPass = this.cred.smtpPass ?? this.cred.imapPass
      const smtp = new SmtpClient(smtpHost, smtpPort, smtpUser, smtpPass, smtpUser)
      const subject = frame.subject.startsWith('Re:') ? frame.subject : `Re: ${frame.subject}`
      const ok = await smtp.send(frame.from, subject, content)
      console.log('[dsh-message-gateway] email reply sent', { to: frame.from, ok })
    } catch (error) {
      console.error('[dsh-message-gateway] email reply failed', error)
    }
  }

  /** 主动推送：向任意收件人发送邮件（SMTP 配置复用桥凭据）。 */
  async send(to: string, subject: string, content: string): Promise<boolean> {
    try {
      const smtpHost = this.cred.smtpHost ?? this.cred.imapHost
      const smtpPort = Number(this.cred.smtpPort || '465')
      const smtpUser = this.cred.smtpUser ?? this.cred.imapUser
      const smtpPass = this.cred.smtpPass ?? this.cred.imapPass
      const smtp = new SmtpClient(smtpHost, smtpPort, smtpUser, smtpPass, smtpUser)
      const ok = await smtp.send(to, subject, content)
      console.log('[dsh-message-gateway] email push sent', { to, subject: subject.slice(0, 40), ok })
      return ok
    } catch (error) {
      console.error('[dsh-message-gateway] email push failed', error)
      return false
    }
  }

  /** 停止轮询。 */
  stop(): void {
    this.stopped = true
    this.imap?.close()
    this.imap = null
    this.setStatus('idle')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}