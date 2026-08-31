/**
 * 企业微信智能表格（Smartsheet）原生 REST API 客户端。
 * 纯 TypeScript 原生实现，零外部二进制依赖，纯 fetch 通讯。
 * 支持智能表格的创建、字段定义、记录插入与查询，直接输出企微官方可访问的文档 URL。
 * @module dsh-message-gateway/host/wecom-smartsheet
 */

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
  /** 初始写入的数据行列表（对象数组或字段值数组） */
  records?: Array<Record<string, unknown>>
  /** 管理员/操作者 userid（可选） */
  adminUsers?: string[]
}

export interface CreateSmartsheetResult {
  ok: boolean
  docid?: string
  url?: string
  error?: string
}

export class WecomSmartsheetClient {
  private token: string | null = null
  private tokenExpiresAt = 0

  constructor(
    private readonly creds: {
      botId?: string
      secret?: string
      corpId?: string
    },
  ) {}

  /**
   * 获取有效的 access_token（自动内存缓存与续期）。
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.token && now < this.tokenExpiresAt - 60_000) {
      return this.token
    }

    const corpId = this.creds.corpId || this.creds.botId || ''
    const secret = this.creds.secret || ''

    if (!corpId || !secret) {
      throw new Error('企业微信凭据不完整（缺少 botId/corpId 或 secret）')
    }

    // 企微官方标准 token 获取端点
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const data = (await res.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number }

    if (data.errcode !== 0 || !data.access_token) {
      throw new Error(`获取企业微信 access_token 失败 [${data.errcode}]: ${data.errmsg || '未知错误'}`)
    }

    this.token = data.access_token
    this.tokenExpiresAt = now + (data.expires_in ?? 7200) * 1000
    return this.token
  }

  /**
   * 映射字段类型为企微官方标准枚举。
   */
  private mapFieldType(type?: string): string {
    switch (type?.toLowerCase()) {
      case 'number':
        return 'FIELD_TYPE_NUMBER'
      case 'single_select':
      case 'select':
        return 'FIELD_TYPE_SINGLE_SELECT'
      case 'multi_select':
        return 'FIELD_TYPE_MULTI_SELECT'
      case 'date':
      case 'date_time':
      case 'datetime':
        return 'FIELD_TYPE_DATE_TIME'
      case 'user':
      case 'member':
        return 'FIELD_TYPE_USER'
      case 'checkbox':
        return 'FIELD_TYPE_CHECKBOX'
      case 'text':
      default:
        return 'FIELD_TYPE_TEXT'
    }
  }

  /**
   * 创建一份全新的在线智能表格（Smartsheet）。
   */
  async createSmartsheet(options: CreateSmartsheetOptions): Promise<CreateSmartsheetResult> {
    try {
      const token = await this.getAccessToken()
      const url = `https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/create?access_token=${encodeURIComponent(token)}`

      // 构造字段列表
      const fields = (options.fields && options.fields.length > 0)
        ? options.fields.map((f) => {
            const fieldType = this.mapFieldType(f.type)
            const item: Record<string, unknown> = {
              field_title: f.title,
              field_type: fieldType,
            }
            if ((fieldType === 'FIELD_TYPE_SINGLE_SELECT' || fieldType === 'FIELD_TYPE_MULTI_SELECT') && f.options) {
              item.property = {
                options: f.options.map((opt) => ({ text: String(opt) })),
              }
            }
            return item
          })
        : [
            { field_title: '标题', field_type: 'FIELD_TYPE_TEXT' },
            { field_title: '状态', field_type: 'FIELD_TYPE_SINGLE_SELECT', property: { options: [{ text: '未开始' }, { text: '进行中' }, { text: '已完成' }] } },
            { field_title: '负责人', field_type: 'FIELD_TYPE_USER' },
            { field_title: '截止日期', field_type: 'FIELD_TYPE_DATE_TIME' },
          ]

      const payload: Record<string, unknown> = {
        doc_name: options.title || '新建智能表格',
        sheet_title: options.sheetTitle || '数据表',
        fields,
      }

      if (options.adminUsers && options.adminUsers.length > 0) {
        payload.admin_users = options.adminUsers
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      })

      const data = (await res.json()) as {
        errcode?: number
        errmsg?: string
        docid?: string
        url?: string
      }

      if (data.errcode !== 0 || !data.docid) {
        return {
          ok: false,
          error: `创建智能表格失败 [${data.errcode}]: ${data.errmsg || '未知错误'}`,
        }
      }

      // 如果有初始记录，追加写入记录
      if (options.records && options.records.length > 0) {
        await this.addRecords(data.docid, options.records).catch((err) => {
          console.warn('[WecomSmartsheetClient] 写入初始数据失败（表格已创建成功）:', err)
        })
      }

      return {
        ok: true,
        docid: data.docid,
        url: data.url || `https://doc.weixin.qq.com/smartsheet/${data.docid}`,
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 向指定的智能表格中追加行记录。
   */
  async addRecords(docid: string, records: Array<Record<string, unknown>>, sheetId?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const token = await this.getAccessToken()
      const url = `https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/add_records?access_token=${encodeURIComponent(token)}`

      // 构造 values 数组
      const recordItems = records.map((rec) => ({
        values: rec,
      }))

      const payload: Record<string, unknown> = {
        docid,
        records: recordItems,
      }
      if (sheetId) {
        payload.sheet_id = sheetId
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      })

      const data = (await res.json()) as { errcode?: number; errmsg?: string }
      if (data.errcode !== 0) {
        return { ok: false, error: `添加记录失败 [${data.errcode}]: ${data.errmsg || '未知错误'}` }
      }

      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
