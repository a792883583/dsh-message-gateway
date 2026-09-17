/**
 * 跨平台「入站消息」归一化：文本 + 附件（图片 / 任意文件）。
 *
 * 各平台 bridge 按官方文档解析事件并下载（必要时解密）二进制后，
 * 统一产出 IncomingAttachment[] 交给 bridge-manager：
 * - kind='image' → ctx.attachments.saveImage → ImageBlock（多模态交给模型）
 * - kind='file'  → ctx.attachments.saveFile  → FileBlock（请求组装时投影为
 *   「文件名 + 字节数 + 只读路径」句柄文本，Agent 可用文件工具读取处理）
 *
 * @module dsh-message-gateway/host/incoming
 */

/** 单条已下载的附件（二进制驻留内存；各平台下载上限远低于内存安全范围）。 */
export interface IncomingAttachment {
  kind: 'image' | 'file'
  data: Uint8Array
  /** 平台声明/推断的 MIME；图片保存时会按字节校验，未知时按文件名/魔数兜底。 */
  mediaType?: string
  /** 展示文件名（平台给出时）。 */
  name?: string
}

/** 有界下载：默认 60s 超时、100MB 上限（对齐各平台官方下载上限的最大公约数）。 */
export async function downloadBytes(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {},
): Promise<Uint8Array> {
  const { timeoutMs = 60_000, maxBytes = 100 * 1024 * 1024, headers } = opts
  if (!/^https?:\/\//i.test(url)) throw new Error('非法下载地址')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (contentLength > maxBytes) throw new Error('附件超过大小上限')
    const buf = new Uint8Array(await response.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new Error('附件超过大小上限')
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/** 从可读流收集全部字节（飞书 SDK 的 getReadableStream 返回 Node Readable）。 */
export async function collectStream(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  // 两种流的运行时都支持异步迭代；类型上做一次断言。
  const iterable = stream as unknown as AsyncIterable<Uint8Array>
  for await (const chunk of iterable) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
