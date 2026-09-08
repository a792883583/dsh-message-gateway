/**
 * 智能代理辅助工具：
 * 为境外平台（Discord / Telegram）提供开箱即用的代理通道支持。
 * 优先级：
 * 1. 环境变量 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY
 * 2. 本地常见代理端口（如 7890 Clash / 10808 v2ray / 1087 Shadowsocks）
 *
 * @module dsh-message-gateway/host/proxy
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'

let cachedProxyUrl: string | null | undefined = undefined

/** 获取可用的 HTTP 代理 URL。若未检测到有效代理则返回 null。 */
export async function getProxyUrl(): Promise<string | null> {
  if (cachedProxyUrl !== undefined) return cachedProxyUrl

  const envProxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.all_proxy ||
    process.env.ALL_PROXY

  if (envProxy) {
    cachedProxyUrl = envProxy
    return cachedProxyUrl
  }

  // 探测本地常见代理端口
  const commonPorts = [7890, 7897, 10808, 10809, 1087]
  const net = await import('node:net')

  for (const port of commonPorts) {
    const isUp = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port, timeout: 500 })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })

    if (isUp) {
      cachedProxyUrl = `http://127.0.0.1:${port}`
      console.log(`[dsh-message-gateway] auto-detected local proxy on port ${port}`)
      return cachedProxyUrl
    }
  }

  cachedProxyUrl = null
  return null
}

/** 为境外 fetch 调用创建智能 Dispatcher。 */
export async function getProxyDispatcher(): Promise<ProxyAgent | undefined> {
  const proxyUrl = await getProxyUrl()
  if (proxyUrl) {
    return new ProxyAgent(proxyUrl)
  }
  return undefined
}

/** 智能 fetch：自动对境外平台附加代理 dispatcher，完全兼容 undici ProxyAgent。 */
export async function smartFetch(url: string | URL, init?: RequestInit): Promise<{ status: number; json: () => Promise<unknown> }> {
  const urlStr = String(url)
  const isOverseas = /discord\.com|telegram\.org|api\.openai\.com/i.test(urlStr)
  if (isOverseas) {
    const dispatcher = await getProxyDispatcher()
    if (dispatcher) {
      const res = await undiciFetch(urlStr, { ...init, dispatcher } as any)
      return {
        status: res.status,
        json: () => res.json(),
      }
    }
  }
  const res = await fetch(url, init)
  return {
    status: res.status,
    json: () => res.json(),
  }
}
