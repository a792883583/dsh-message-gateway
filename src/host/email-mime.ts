/**
 * 邮件 MIME 解析（纯 RFC 实现，无第三方依赖）。
 *
 * 依据：
 * - RFC 2045 §6.1/§6.8：Content-Transfer-Encoding（缺省 7bit；base64 须忽略字母表外字符）
 * - RFC 2046 §5.1：multipart 嵌套（mixed / alternative / related；未知 subtype 按 mixed）
 * - RFC 2183 §2.3/§2.8：Content-Disposition（未知类型按 attachment；filename 须剥离路径）
 * - RFC 2231：`filename*` 参数（charset'lang'pct-encoded，含编号续行写法）
 * - RFC 2047：encoded-word（`=?charset?B/Q?...?=`，Q 中 `_` 表示空格）
 * - RFC 3501 §6.4.5/§9：BODYSTRUCTURE 结构与 part 编号（嵌套用点号）
 *
 * @module dsh-message-gateway/host/email-mime
 */

/** 解析后的 MIME 部件。 */
export interface MimeNode {
  /** IMAP part 编号（顶层 multipart 的子部件为 1/2/…，嵌套形如 1.2）。 */
  part: string
  type: string
  subtype: string
  /** Content-Type 与 Content-Disposition 的合并参数（键统一小写）。 */
  params: Record<string, string>
  /** Content-ID（已去尖括号）。 */
  id: string
  /** Content-Transfer-Encoding，缺省 7bit。 */
  encoding: string
  /** 该 part 解码后字节数。 */
  octets: number
  /** Content-Disposition 类型（小写）；空串表示未声明。 */
  disposition: string
  /** 由 filename* / filename / name 解析出的文件名（已剥离路径）。 */
  filename: string
  children: MimeNode[]
}

/** BODYSTRUCTURE 的 S-expression token：字符串 / NIL / 子列表。 */
type Tok = string | null | Tok[]

/** 解析圆括号 S-expression；返回顶层列表，失败返回 null。 */
function tokenize(text: string): Tok[] | null {
  let i = 0
  const parseList = (): Tok[] | null => {
    if (text[i] !== '(') return null
    i += 1
    const out: Tok[] = []
    while (i < text.length) {
      const c = text[i]
      if (c === ' ' || c === '\r' || c === '\n' || c === '\t') {
        i += 1
        continue
      }
      if (c === ')') {
        i += 1
        return out
      }
      if (c === '(') {
        const inner = parseList()
        if (inner === null) return null
        out.push(inner)
        continue
      }
      if (c === '"') {
        i += 1
        let s = ''
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\' && i + 1 < text.length) {
            i += 1
            s += text[i]
            i += 1
            continue
          }
          s += text[i]
          i += 1
        }
        i += 1
        out.push(s)
        continue
      }
      let atom = ''
      while (i < text.length && !' ()\r\n\t'.includes(text[i])) {
        atom += text[i]
        i += 1
      }
      out.push(atom.toUpperCase() === 'NIL' ? null : atom)
    }
    return out
  }
  while (i < text.length && /\s/.test(text[i])) i += 1
  return parseList()
}

/** 键值对列表 → 小写键的字典。 */
function asParams(tok: Tok | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(tok)) return out
  for (let i = 0; i + 1 < tok.length; i += 2) {
    const k = tok[i]
    const v = tok[i + 1]
    if (typeof k === 'string' && typeof v === 'string') out[k.toLowerCase()] = v
  }
  return out
}

/** 百分号解码为字节（RFC 2231 的编码方式与 RFC 2047 一致）。 */
function pctToBuffer(s: string): Buffer {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '%' && i + 2 < s.length) {
      const hex = s.slice(i + 1, i + 3)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
    }
    bytes.push(s.charCodeAt(i) & 0xff)
  }
  return Buffer.from(bytes)
}

/** 按 charset 解码字节；未知 charset 退回 UTF-8。 */
function bufferToString(buf: Buffer, charset: string): string {
  const cs = charset.trim().toLowerCase()
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252') return buf.toString('latin1')
  if (cs === 'us-ascii' || cs === 'ascii') return buf.toString('ascii')
  return buf.toString('utf8')
}

/** RFC 2231：`charset'lang'pct-encoded`。 */
function decodeRfc2231(value: string): string {
  const m = value.match(/^([^']*)'([^']*)'(.*)$/)
  const charset = m === null ? 'utf-8' : m[1]
  const encoded = m === null ? value : m[3]
  return bufferToString(pctToBuffer(encoded), charset)
}

/** RFC 2047：encoded-word（用于 filename 里内嵌 `=?utf-8?B?...?=` 的老式写法）。 */
function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, enc: string, text: string) => {
    try {
      if (enc.toUpperCase() === 'B') return bufferToString(Buffer.from(text, 'base64'), charset)
      const qp = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)))
      return bufferToString(Buffer.from(qp, 'latin1'), charset)
    } catch {
      return text
    }
  })
}

/** 取参数值：支持 `name` / `name*`（RFC 2231 扩展）/ `name*0*` 续行拼接。 */
function paramValue(params: Record<string, string>, base: string): { value: string; extended: boolean } | null {
  const single = params[`${base}*`]
  if (single !== undefined) return { value: single, extended: true }
  const parts: Array<{ i: number; v: string; ext: boolean }> = []
  const re = new RegExp(`^${base}\\*(\\d+)(\\*)?$`)
  for (const [k, v] of Object.entries(params)) {
    const m = k.match(re)
    if (m !== null) parts.push({ i: Number(m[1]), v, ext: m[2] === '*' })
  }
  if (parts.length > 0) {
    parts.sort((a, b) => a.i - b.i)
    return { value: parts.map((p) => p.v).join(''), extended: parts[0].ext }
  }
  const plain = params[base]
  return plain === undefined ? null : { value: plain, extended: false }
}

/** RFC 2183 §2.3：文件名必须剥离任何路径信息。 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned === '' ? 'attachment' : cleaned
}

/** 依次尝试 filename* / filename / name（RFC 2231 > RFC 2183 > Content-Type 遗留 name）。 */
function pickFilename(params: Record<string, string>): string {
  for (const base of ['filename', 'name']) {
    const hit = paramValue(params, base)
    if (hit === null) continue
    const decoded = hit.extended ? decodeRfc2231(hit.value) : decodeEncodedWords(hit.value)
    if (decoded.trim() !== '') return sanitizeFilename(decoded)
  }
  return ''
}

/** 把解析出的 S-expression 解释为节点（multipart 递归，part 编号按 RFC 3501 用点号）。 */
function interpret(sexp: Tok, prefix: string): MimeNode | null {
  if (!Array.isArray(sexp) || sexp.length === 0) return null
  if (Array.isArray(sexp[0])) {
    // multipart：前导若干子部件列表，随后是 subtype，再后是参数。
    const children: MimeNode[] = []
    let idx = 0
    while (idx < sexp.length && Array.isArray(sexp[idx])) {
      const childPart = prefix === '' ? String(children.length + 1) : `${prefix}.${children.length + 1}`
      const child = interpret(sexp[idx] as Tok, childPart)
      if (child !== null) children.push(child)
      idx += 1
    }
    const subtypeRaw = sexp[idx]
    const subtype = typeof subtypeRaw === 'string' ? subtypeRaw.toLowerCase() : 'mixed'
    const params = asParams(sexp[idx + 1])
    return {
      part: prefix, type: 'multipart', subtype, params, id: '',
      encoding: '', octets: 0, disposition: '', filename: '', children,
    }
  }
  const type = typeof sexp[0] === 'string' ? sexp[0].toLowerCase() : 'application'
  const subtype = typeof sexp[1] === 'string' ? sexp[1].toLowerCase() : 'octet-stream'
  const params = asParams(sexp[2])
  const id = typeof sexp[3] === 'string' ? sexp[3].replace(/^<|>$/g, '') : ''
  const encoding = typeof sexp[5] === 'string' ? sexp[5].toLowerCase() : '7bit'
  const octets = Number(sexp[6] ?? 0) || 0
  // 扩展字段里找 disposition：形如 ("ATTACHMENT" ("FILENAME" "x.pdf"))。
  let disposition = ''
  let dispParams: Record<string, string> = {}
  for (let i = 7; i < sexp.length; i += 1) {
    const el = sexp[i]
    if (Array.isArray(el) && el.length >= 1 && typeof el[0] === 'string') {
      disposition = el[0].toLowerCase()
      dispParams = asParams(el[1])
      break
    }
  }
  const merged = { ...params, ...dispParams }
  return {
    part: prefix === '' ? '1' : prefix,
    type, subtype, params: merged, id, encoding, octets, disposition,
    filename: pickFilename(merged), children: [],
  }
}

/** 解析 BODYSTRUCTURE 文本为节点树；失败返回 null。 */
export function parseBodyStructure(sexp: string): MimeNode | null {
  const tok = tokenize(sexp)
  if (tok === null) return null
  return interpret(tok as Tok, '')
}

/** 深度优先展开为部件列表（不含 multipart 容器本身）。 */
export function flattenParts(root: MimeNode | null): MimeNode[] {
  if (root === null) return []
  const out: MimeNode[] = []
  const walk = (node: MimeNode): void => {
    if (node.children.length > 0) {
      for (const c of node.children) walk(c)
      return
    }
    out.push(node)
  }
  walk(root)
  return out
}

/**
 * 按 Content-Transfer-Encoding 解码 part 正文。
 * RFC 2045 §6.8：base64 解码必须忽略字母表外字符（换行/空格等）。
 * RFC 2045 §6.1：缺省 7bit，不需要解码。
 */
export function decodeBody(raw: string, encoding: string): Uint8Array {
  const enc = encoding.toLowerCase()
  if (enc === 'base64') {
    return new Uint8Array(Buffer.from(raw.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'))
  }
  if (enc === 'quoted-printable') {
    const bytes: number[] = []
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] === '=') {
        if (raw[i + 1] === '\r' && raw[i + 2] === '\n') {
          i += 2
          continue
        }
        if (raw[i + 1] === '\n') {
          i += 1
          continue
        }
        const hex = raw.slice(i + 1, i + 3)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16))
          i += 2
          continue
        }
      }
      bytes.push(raw.charCodeAt(i) & 0xff)
    }
    return new Uint8Array(Buffer.from(bytes))
  }
  return new Uint8Array(Buffer.from(raw, 'latin1'))
}
