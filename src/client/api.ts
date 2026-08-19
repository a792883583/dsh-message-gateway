/**
 * /gateway/* 路由的浏览器侧客户端。
 * @module dsh-message-gateway/client/api
 */

import type { GatewayView } from '../core/types.ts'

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** 面向 host /gateway 路由的 JSON 客户端。 */
export class GatewayApi {
  private async post<T>(path: string, payload: unknown): Promise<Envelope<T>> {
    let response: Response
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
    } catch (error) {
      return { ok: false, error: { code: 'network', message: error instanceof Error ? error.message : 'network error' } }
    }
    try {
      return (await response.json()) as Envelope<T>
    } catch {
      return { ok: false, error: { code: 'internal', message: `bad response (${response.status})` } }
    }
  }

  list(): Promise<Envelope<GatewayView>> {
    return this.post('/gateway/list', {})
  }

  save(platform: string, credentials: Record<string, string>): Promise<Envelope<GatewayView>> {
    return this.post('/gateway/save', { platform, ...credentials })
  }

  delete(platform: string): Promise<Envelope<GatewayView>> {
    return this.post('/gateway/delete', { platform })
  }

  test(platform: string, credentials?: Record<string, string>): Promise<Envelope<{ ok: boolean; detail: string }>> {
    return this.post('/gateway/test', { platform, ...credentials })
  }
}
