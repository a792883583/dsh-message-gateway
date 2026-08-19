/**
 * 凭据与状态存储：`~/.dsh/gateway.json`（权限 600，不输出明文到日志）。
 * @module dsh-message-gateway/host/gateway-store
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PlatformState } from '../core/types.ts'

export interface StoredStatus {
  state: PlatformState
  detail: string
  testedAt: number | null
}

export interface GatewayStoreData {
  /** 各平台凭据（明文仅存于此文件）。 */
  platforms: Record<string, Record<string, string>>
  /** 各平台最近一次测试状态。 */
  statuses: Record<string, StoredStatus>
}

const FILE = join(homedir(), '.dsh', 'gateway.json')

/** 读取存储；不存在或损坏时返回空数据。 */
export async function loadStore(): Promise<GatewayStoreData> {
  try {
    const text = await readFile(FILE, 'utf8')
    const parsed = JSON.parse(text) as Partial<GatewayStoreData>
    return {
      platforms: parsed.platforms ?? {},
      statuses: parsed.statuses ?? {},
    }
  } catch {
    return { platforms: {}, statuses: {} }
  }
}

/** 原子写入存储（临时文件 + 改名），权限 600。 */
export async function saveStore(data: GatewayStoreData): Promise<void> {
  await mkdir(join(homedir(), '.dsh'), { recursive: true })
  const tmp = `${FILE}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, FILE)
}
