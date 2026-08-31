/**
 * 企业微信智能表格（Smartsheet）客户端——基于官方 @wecom/cli 二进制。
 *
 * 企业微信智能机器人的 botId+secret 不能走企微标准 `corpid` 鉴权（gettoken 返回
 * 40013），官方唯一支持智能机器人创建智能表格的通道是 `@wecom/cli`（腾讯官方
 * SDK 生态，与 @wecom/aibot-node-sdk 同源；npm 安装时自动携带平台二进制）。
 *
 * 流程：`auth init --bot-id <id> --secret <secret>`（非 TTY 直连授权，凭据落盘到
 * WECOM_CLI_CONFIG_DIR）→ `smartsheet create --json <body>`（返回 docid + url）。
 * 凭据目录按 botId+secret 指纹隔离；`auth init` 幂等短路（credentials.enc 与
 * .encryption_key 存在即跳过），避免重复打鉴权接口触发 45009 频率限制。
 * @module dsh-message-gateway/host/wecom-smartsheet
 */

import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export interface SmartsheetFieldDef {
  /** 字段/列名称 */
  title: string
  /** 字段类型：text | number | single_select | multi_select | date_time | user | checkbox */
  type?: 'text' | 'number' | 'single_select' | 'multi_select' | 'date_time' | 'user' | 'checkbox'
  /** 单选/多选字段的可选配置项列表 */
  options?: string[]
}

export interface CreateSmartsheetOptions {
  /** 表格文档名称 */
  title: string
  /** 首个工作表名称（默认：数据表） */
  sheetTitle?: string
  /** 列字段定义列表 */
  fields?: SmartsheetFieldDef[]
  /** 初始写入的数据行列表（对象数组：字段标题 → 值） */
  records?: Array<Record<string, unknown>>
}

export interface CreateSmartsheetResult {
  ok: boolean
  docid?: string
  url?: string
  error?: string
}

/** 每个 (botId, secret) 组合一个配置目录 → 多 bot 隔离 + secret 轮换即时生效。 */
function configDirFor(botId: string, secret: string): string {
  const fp = createHash('sha256').update(`${botId}:${secret}`, 'utf8').digest('hex').slice(0, 8)
  return join(homedir(), '.local', 'share', 'dsh-message-gateway', 'wecom-cli', `${botId.replace(/[^A-Za-z0-9_-]/g, '_')}-${fp}`)
}

/** 解析 @wecom/cli 平台二进制路径（与官方 bin/wecom.js 相同逻辑）。 */
function resolveCliBinary(): string {
  const require = createRequire(import.meta.url)
  const platformMap: Record<string, string> = {
    'darwin-arm64': '@wecom/cli-darwin-arm64',
    'darwin-x64': '@wecom/cli-darwin-x64',
    'linux-arm64': '@wecom/cli-linux-arm64',
    'linux-x64': '@wecom/cli-linux-x64',
    'win32-x64': '@wecom/cli-win32-x64',
  }
  const key = `${process.platform}-${process.arch}`
  const pkg = platformMap[key]
  if (!pkg) throw new Error(`wecom-cli: unsupported platform ${key}`)
  const binaryName = process.platform === 'win32' ? 'wecom-cli.exe' : 'wecom-cli'
  try {
    const pkgDir = require.resolve(`${pkg}/package.json`)
    return join(dirname(pkgDir), 'bin', binaryName)
  } catch {
    throw new Error('wecom-cli: cannot locate platform binary, reinstall @wecom/cli (do not use --no-optional)')
  }
}

function runCli(bin: string, argv: string[], configDir: string, timeoutMs = 90_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      WECOM_CLI_CONFIG_DIR: configDir,
      WECOM_CLI_LOG_LEVEL: 'warn',
    }
    const child = execFile(bin, argv, { env, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        reject(new Error(`wecom-cli 执行超时：${argv.join(' ')}`))
        return
      }
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
    // 非 TTY 直连授权分支需要 stdin 关闭（避免挂起等待交互输入）
    child.stdin?.end()
  })
}

function isAuthorized(dir: string): boolean {
  return existsSync(join(dir, 'credentials.enc')) && existsSync(join(dir, '.encryption_key'))
}

export class WecomSmartsheetClient {
  private bin: string
  private dir: string
  private authDone = false

  constructor(
    private readonly creds: { botId?: string; secret?: string },
  ) {
    this.bin = resolveCliBinary()
    const botId = creds.botId ?? ''
    const secret = creds.secret ?? ''
    if (!botId || !secret) throw new Error('企业微信智能机器人凭据不完整（缺少 botId 或 secret）')
    this.dir = configDirFor(botId, secret)
  }

  /** 确保已授权（幂等短路，避免重复鉴权触发频率限制）。 */
  private async ensureAuthorized(): Promise<void> {
    if (this.authDone && isAuthorized(this.dir)) return
    mkdirSync(this.dir, { recursive: true })
    if (!isAuthorized(this.dir)) {
      const res = await runCli(this.bin, ['auth', 'init', '--bot-id', this.creds.botId ?? '', '--secret', this.creds.secret ?? ''], this.dir, 60_000)
      if (res.code !== 0) {
        throw new Error(`企业微信智能机器人授权失败：${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`)
      }
    }
    this.authDone = true
  }

  /** 映射字段类型为企微官方字段类型标识。 */
  private mapFieldType(type?: string): string {
    switch (type?.toLowerCase()) {
      case 'number': return 'number'
      case 'single_select':
      case 'select': return 'single_select'
      case 'multi_select': return 'select'
      case 'date':
      case 'date_time':
      case 'datetime': return 'date_time'
      case 'user':
      case 'member': return 'user'
      case 'checkbox': return 'checkbox'
      case 'text':
      default: return 'text'
    }
  }

  /**
   * 创建一份全新的在线智能表格（Smartsheet）。
   */
  async createSmartsheet(options: CreateSmartsheetOptions): Promise<CreateSmartsheetResult> {
    try {
      await this.ensureAuthorized()

      // 字段定义（单选/多选带选项）。
      const fields = (options.fields && options.fields.length > 0
        ? options.fields
        : [
            { title: '标题', type: 'text' as const },
            { title: '状态', type: 'single_select' as const, options: ['未开始', '进行中', '已完成'] },
            { title: '负责人', type: 'user' as const },
            { title: '截止日期', type: 'date_time' as const },
          ]
      ).map((f, idx) => {
        const fieldType = this.mapFieldType(f.type)
        const item: Record<string, unknown> = {
          field_title: f.title,
          field_type: fieldType,
        }
        if ((fieldType === 'single_select' || fieldType === 'select') && f.options) {
          item[fieldType === 'select' ? 'property_select' : 'property_single_select'] = {
            options: f.options.map((text, oi) => ({ id: String(oi + 1), text: String(text) })),
          }
        }
        void idx
        return item
      })

      // 初始数据行 → grid_data（单元格按 data_type + cell_value 组织）。
      const rows = (options.records ?? []).map((rec) => {
        const values = fields.map((f) => {
          const title = String(f.field_title)
          const raw = rec[title]
          const fieldType = String(f.field_type)
          if (fieldType === 'number') {
            const n = Number(raw ?? 0)
            return { data_type: 'NUMBER', cell_value: { number: Number.isFinite(n) ? n : 0 } }
          }
          if (fieldType === 'single_select' || fieldType === 'select') {
            const text = String(raw ?? '')
            const f2 = f as Record<string, unknown>
            const property = (f2.property_single_select ?? f2.property_select ?? {}) as { options?: Array<{ id: string; text: string }> }
            const options = property.options ?? []
            const hit = options.find((o) => o.text === text)
            return {
              data_type: 'SELECT',
              cell_value: { select: { value: hit ? [hit.id] : [], options } },
            }
          }
          return { data_type: 'TEXT', cell_value: { text: String(raw ?? '') } }
        })
        return { values }
      })

      const body = JSON.stringify({
        name: options.title || '新建智能表格',
        sheet_title: options.sheetTitle || '数据表',
        fields,
        ...(rows.length > 0 ? { grid_data: { start_row: 0, start_column: 0, rows } } : {}),
      })

      const res = await runCli(this.bin, ['smartsheet', 'create', '--json', body], this.dir, 90_000)
      if (res.code !== 0) {
        return { ok: false, error: `创建智能表格失败：${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}` }
      }
      const parsed = JSON.parse(res.stdout) as { docid?: string; url?: string; errcode?: number; errmsg?: string }
      if (parsed.errcode !== 0 || !parsed.docid) {
        return { ok: false, error: `创建智能表格失败 [${parsed.errcode}]: ${parsed.errmsg || '未知错误'}` }
      }
      return { ok: true, docid: parsed.docid, url: parsed.url || `https://doc.weixin.qq.com/smartsheet/${parsed.docid}` }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}