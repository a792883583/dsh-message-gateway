/**
 * 敏感信息脱敏工具：对日志 / 推送内容中的疑似密钥进行遮蔽，避免 API Key、
 * 密码等机密在控制台或日志文件中泄露。通用正则，不绑定任何特定平台。
 * @module dsh-message-gateway/host/sanitize
 */

const REDACTED = '***'

/** 常见密钥模式的匹配规则（先匹配长/特异性模式，避免误伤）。 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // OpenAI / DeepSeek / 通用 sk- 前缀密钥（sk- 后接较长字符）。
  { name: 'sk-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  // GitHub PAT。
  { name: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9_]{20,}/g },
  // Bearer token（请求头形式）。
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}/gi },
  // 赋值形式的密钥：key=value / "key": "value" / key: value。
  { name: 'key-assign', re: /\b(?:api[_-]?key|secret|password|passwd|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|app[_-]?secret)\b\s*[=:]\s*["']?[A-Za-z0-9._~+\/-]{12,}/gi },
  // Authorization 头。
  { name: 'authorization', re: /\bAuthorization\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}/gi },
  // 长 base64 / 高熵字符串（>= 32 字符连续字母数字）。
  { name: 'high-entropy', re: /[A-Za-z0-9_-]{40,}/g },
  // 私钥 PEM 块。
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
]

/**
 * 对文本中的敏感信息进行脱敏遮蔽。
 * @param text 原始文本。
 * @returns 脱敏后的文本。
 */
export function sanitizeSecrets(text: string): string {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const { re } of PATTERNS) {
    out = out.replace(re, (match) => {
      // 保留前缀类型标识（如 sk- 前 3 字符 + ***），便于人读判断类型。
      const keep = match.length > 12 ? match.slice(0, 4) : ''
      return `${keep}${REDACTED}`
    })
  }
  return out
}