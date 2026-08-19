/**
 * 回调型平台桥：企业微信应用 / 微信公众号 / WhatsApp。
 * 这类平台无长连接，由平台服务器向本插件注册的回调端点推送消息：
 * - 企业微信应用：GET 验证（msg_signature + AES 解密 echostr）、POST 加密 XML；
 *   回复走「应用消息」send API（access_token + message/send）。
 * - 微信公众号：GET 验证（SHA1 signature + echostr）、POST 明文 XML；
 *   回复走「客服消息」custom send API。
 * - WhatsApp（Meta Cloud API）：GET 验证（hub.challenge）、POST JSON；
 *   回复走 Graph API messages 端点。
 * 三者均为「保存凭据 + 在平台后台配置回调 URL → 直接可用」，无第三方依赖。
 * @module dsh-message-gateway/host/callback-bridges
 */

import { createHash, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto'
import type { ChatIdentity, ReplySink } from './bridge-manager.ts'

/** access_token 缓存（约 7000 秒有效期，提前 300 秒刷新）。 */
const TOKEN_TTL_MS = 7_000_000
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

function cachedToken(key: string): string | null {
  const entry = tokenCache.get(key)
  if (entry === undefined || entry.expiresAt <= Date.now()) return null
  return entry.token
}

function setCachedToken(key: string, token: string): void {
  tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS })
}

// ---------- 通用小工具 ----------

/** SHA1(排序拼接) 签名（企业微信 msg_signature / 公众号 signature 同构）。 */
export function sha1Sorted(parts: string[]): string {
  const sorted = [...parts].sort()
  return createHash('sha1').update(sorted.join('')).digest('hex')
}

/** 从 XML 中提取字段值（支持 CDATA）。 */
export function xmlField(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`))
  return match === null ? '' : match[1].trim()
}

/** 从 XML 中提取 Encrypt 节点（企业微信密文载体）。 */
export function xmlEncrypt(xml: string): string {
  return xmlField(xml, 'Encrypt')
}

/** PKCS#7 去除填充。 */
function unpad(data: Buffer): Buffer {
  const pad = data[data.length - 1]
  if (pad < 1 || pad > 32) return data
  return data.subarray(0, data.length - pad)
}

/** PKCS#7 填充。 */
function pad(data: Buffer, blockSize = 32): Buffer {
  const len = blockSize - (data.length % blockSize)
  return Buffer.concat([data, Buffer.alloc(len, len)])
}

function buildKey(encodingAESKey: string): Buffer {
  return Buffer.from(`${encodingAESKey}=`, 'base64')
}

// ---------- 企业微信应用 ----------

/** 企业微信应用桥：回调验证 + 消息解密 + 应用消息发送。 */
export class WecomAppBridge {
  constructor(
    private readonly corpId: string,
    private readonly agentId: string,
    private readonly secret: string,
    private readonly token: string,
    private readonly encodingAESKey: string,
  ) {}

  /** 校验回调签名（token + timestamp + nonce + encrypt 排序拼接 SHA1）。 */
  verifySignature(msgSignature: string, timestamp: string, nonce: string, encrypt: string): boolean {
    if (this.token === '' || msgSignature === '' || timestamp === '' || nonce === '' || encrypt === '') return false
    const expected = sha1Sorted([this.token, timestamp, nonce, encrypt])
    return expected === msgSignature.toLowerCase()
  }

  /** 解密回调密文 → { message, receiveId }（16B 随机 + 4B 长度 + 消息 + corpId）。 */
  decrypt(encrypt: string): { message: string; receiveId: string } {
    const key = buildKey(this.encodingAESKey)
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
    const plain = unpad(Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()]))
    const msgLen = plain.readUInt32BE(16)
    return {
      message: plain.subarray(20, 20 + msgLen).toString('utf8'),
      receiveId: plain.subarray(20 + msgLen).toString('utf8'),
    }
  }

  /** 加密（被动回复 / 测试往返用）。 */
  encrypt(message: string): string {
    const key = buildKey(this.encodingAESKey)
    const payload = Buffer.concat([
      randomBytes(16),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(Buffer.byteLength(message)); return b })(),
      Buffer.from(message, 'utf8'),
      Buffer.from(this.corpId, 'utf8'),
    ])
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
    return Buffer.concat([cipher.update(pad(payload)), cipher.final()]).toString('base64')
  }

  /** 解析解密后的消息 XML → { from, text }。 */
  parseMessage(xml: string): { from: string; text: string } {
    return { from: xmlField(xml, 'FromUserName'), text: xmlField(xml, 'Content') }
  }

  /** 发送文本到用户（企业微信应用消息 API；文本上限 2048 字节）。 */
  async sendText(userId: string, content: string): Promise<boolean> {
    const token = await this.accessToken()
    if (token === null) return false
    const body = { touser: userId, msgtype: 'text', agentid: Number(this.agentId) || 0, text: { content: content.slice(0, 2000) } }
    const result = await postJson(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
      body,
    ) as { errcode?: number; errmsg?: string }
    if (result === null) return false
    if (result.errcode === 0) return true
    // 42001/40014：token 失效 → 清缓存重试一次。
    if (result.errcode === 42001 || result.errcode === 40014) {
      tokenCache.delete(`wecom:${this.corpId}`)
      const retry = await this.accessToken()
      if (retry === null) return false
      const again = await postJson(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(retry)}`,
        body,
      ) as { errcode?: number } | null
      return again?.errcode === 0
    }
    console.warn('[dsh-message-gateway] wecom-app send failed', result.errmsg ?? result.errcode)
    return false
  }

  private async accessToken(): Promise<string | null> {
    const cacheKey = `wecom:${this.corpId}`
    const cached = cachedToken(cacheKey)
    if (cached !== null) return cached
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.secret)}`
    const result = await getJson(url) as { errcode?: number; access_token?: string } | null
    if (result !== null && result.errcode === 0 && result.access_token !== undefined) {
      setCachedToken(cacheKey, result.access_token)
      return result.access_token
    }
    return null
  }
}

// ---------- 微信公众号 ----------

/** 微信公众号桥：回调验证 + 消息解析 + 客服消息发送。 */
export class WechatMpBridge {
  constructor(
    private readonly appId: string,
    private readonly secret: string,
    private readonly token: string,
  ) {}

  /** 校验回调签名（token + timestamp + nonce 排序拼接 SHA1）。 */
  verifySignature(signature: string, timestamp: string, nonce: string): boolean {
    if (this.token === '' || signature === '' || timestamp === '' || nonce === '') return false
    return sha1Sorted([this.token, timestamp, nonce]) === signature.toLowerCase()
  }

  /** 解析消息 XML → { from, to, text, msgType }。 */
  parseMessage(xml: string): { from: string; to: string; text: string; msgType: string } {
    return {
      from: xmlField(xml, 'FromUserName'),
      to: xmlField(xml, 'ToUserName'),
      text: xmlField(xml, 'Content'),
      msgType: xmlField(xml, 'MsgType'),
    }
  }

  /** 发送文本到用户（公众号客服消息 API）。 */
  async sendText(openId: string, content: string): Promise<boolean> {
    const token = await this.accessToken()
    if (token === null) return false
    const body = { touser: openId, msgtype: 'text', text: { content: content.slice(0, 2000) } }
    const result = await postJson(
      `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
      body,
    ) as { errcode?: number; errmsg?: string } | null
    if (result !== null && result.errcode === 0) return true
    if (result !== null && (result.errcode === 40001 || result.errcode === 42001)) {
      tokenCache.delete(`mp:${this.appId}`)
      const retry = await this.accessToken()
      if (retry === null) return false
      const again = await postJson(
        `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(retry)}`,
        body,
      ) as { errcode?: number } | null
      return again?.errcode === 0
    }
    console.warn('[dsh-message-gateway] wechat-mp send failed', result?.errmsg ?? 'unknown')
    return false
  }

  private async accessToken(): Promise<string | null> {
    const cacheKey = `mp:${this.appId}`
    const cached = cachedToken(cacheKey)
    if (cached !== null) return cached
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(this.appId)}&secret=${encodeURIComponent(this.secret)}`
    const result = await getJson(url) as { access_token?: string; errcode?: number } | null
    if (result !== null && result.access_token !== undefined) {
      setCachedToken(cacheKey, result.access_token)
      return result.access_token
    }
    return null
  }
}

// ---------- WhatsApp（Meta Cloud API） ----------

/** WhatsApp 桥：Webhook 验证 + 消息发送。 */
export class WhatsappBridge {
  constructor(
    private readonly token: string,
    private readonly phoneId: string,
  ) {}

  /** Webhook 验证：hub.mode=subscribe 且 hub.verify_token 匹配 → 返回 challenge。 */
  verifyChallenge(params: Record<string, string | undefined>): string | null {
    if (params.mode !== 'subscribe') return null
    if (params.verify_token === undefined || params.verify_token === '') return null
    const stored = this.token
    if (stored === '') return null
    return params.verify_token === stored ? (params.challenge ?? null) : null
  }

  /** 从 Webhook 负载提取 { from, text }。 */
  parseWebhook(body: unknown): { from: string; text: string } | null {
    if (typeof body !== 'object' || body === null) return null
    const entry = (body as { entry?: unknown[] }).entry
    const first = Array.isArray(entry) ? entry[0] : undefined
    const changes = (first as { changes?: unknown[] } | undefined)?.changes
    const value = Array.isArray(changes) ? (changes[0] as { value?: unknown } | undefined)?.value : undefined
    const messages = (value as { messages?: unknown[] } | undefined)?.messages
    const msg = Array.isArray(messages) ? messages[0] : undefined
    if (typeof msg !== 'object' || msg === null) return null
    const m = msg as { from?: unknown; type?: unknown; text?: { body?: unknown } }
    if (typeof m.from !== 'string') return null
    if (m.type === 'text' && typeof m.text?.body === 'string' && m.text.body.trim() !== '') {
      return { from: m.from, text: m.text.body.trim() }
    }
    return null
  }

  /** 发送文本（Graph API；4096 字符上限）。 */
  async sendText(to: string, content: string): Promise<boolean> {
    const result = await postJson(
      `https://graph.facebook.com/v20.0/${encodeURIComponent(this.phoneId)}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: content.slice(0, 4096) },
      },
      { authorization: `Bearer ${this.token}` },
    )
    return result !== null
  }
}

// ---------- HTTP 小工具 ----------

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    try {
      return await response.json() as unknown
    } catch {
      return null
    }
  } catch (error) {
    console.warn('[dsh-message-gateway] getJson failed', url.split('?')[0], String(error))
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    try {
      return await response.json() as unknown
    } catch {
      return { status: response.status }
    }
  } catch (error) {
    console.warn('[dsh-message-gateway] postJson failed', url.split('?')[0], String(error))
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 回调平台：从消息构造统一身份（sink 仅在定稿时发送完整回复）。 */
export function callbackIdentity(
  key: string,
  send: (content: string) => Promise<boolean>,
): ChatIdentity {
  const sink: ReplySink = {
    stream: (_frame, _sid, _content, finish) => {
      // 回调平台无「流式编辑」，只发送定稿；chunk 阶段忽略。
      if (!finish) return
      void send(_content)
    },
  }
  return { key, frame: {}, sink, chatType: 'single' }
}