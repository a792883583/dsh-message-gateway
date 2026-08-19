/**
 * dsh-message-gateway — 浏览器半区：在侧边栏「新会话」按钮下方挂一个
 * 「消息平台」按钮，点击打开全屏平台管理页面（配置凭据 / 测试连接 / 查看状态）。
 * 所有接线失败均记录日志而不抛出——插件 apply 抛错会导致整个 shell 启动失败。
 * @module dsh-message-gateway/client
 */

import { createElement, useCallback, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GatewayApi } from './api.ts'
import { initI18n, useT } from './i18n.ts'
import { GatewayPage } from './Page.tsx'

/** 注入的 client runtime 结构面孔。 */
interface GatewayClientContext {
  effect(fn: () => (() => void) | void, name: string): void
  locale: {
    getLocale(): { active: string }
    subscribe(fn: () => void): () => void
  }
}

export const inject = ['locale']

/** 侧边栏「新会话」按钮 CSS-module 哈希片段（*contains* 选择器）。 */
const NEW_SESSION_SELECTOR = '[class*="newSession"]'

const BUTTON_STYLE = `
.dsh-gw-open { display:flex; align-items:center; gap:8px; width:100%; padding:8px 12px;
  border:none; background:transparent; color:var(--dsh-git-panel-fg, #24292f); cursor:pointer;
  font-size:12px; font-weight:500; border-radius:8px; }
.dsh-gw-open:hover { background:rgba(128,128,128,0.1); }
.dsh-gw-open .icon { font-size:15px; flex:none; }
.dsh-gw-open .label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; text-align:left; }
`

let styleInjected = false
function ensureButtonStyle(): void {
  if (styleInjected) return
  styleInjected = true
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-message-gateway-btn'
  tag.textContent = BUTTON_STYLE
  document.head.appendChild(tag)
}

/** 按钮 + 页面根组件（挂在「新会话」按钮下方）。 */
function GatewayApp(props: { api: GatewayApi }): React.ReactElement {
  const { api } = props
  const t = useT()
  const [open, setOpen] = useState(false)
  const close = useCallback((): void => setOpen(false), [])
  ensureButtonStyle()
  return createElement(
    'div',
    null,
    createElement(
      'button',
      { type: 'button', className: 'dsh-gw-open', title: t('gateway.open'), onClick: () => setOpen(true) },
      createElement('span', { className: 'icon' }, '📮'),
      createElement('span', { className: 'label' }, t('gateway.title')),
    ),
    open ? createElement(GatewayPage, { api, onClose: close }) : null,
  )
}

/** Apply the browser half. */
export function apply(ctx: GatewayClientContext): void {
  try {
    initI18n(ctx.locale)
  } catch (error) {
    console.error('dsh-message-gateway: i18n init failed (falling back to Chinese)', error)
  }

  ctx.effect(() => {
    const host = document.createElement('div')
    host.dataset.gatewayHost = ''
    const root: Root = createRoot(host)
    const api = new GatewayApi()
    let disposed = false

    const render = (): void => {
      if (disposed) return
      root.render(createElement(GatewayApp, { api }))
    }

    // 轮询等待侧边栏「新会话」按钮，把「消息平台」按钮插到它下方。
    // 挂载成功后停止轮询，由低频兜底定时器负责侧边栏重建时的重新挂载。
    let raf = 0
    let polling = true
    const poll = (): void => {
      if (disposed || !polling) return
      if (!host.isConnected) {
        const btn = document.querySelector<HTMLElement>(NEW_SESSION_SELECTOR)
        if (btn !== null && btn.parentElement !== null) {
          btn.after(host)
          render()
          polling = false
          console.debug('[dsh-message-gateway] mounted after newSession')
          return
        }
      } else {
        polling = false
        return
      }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)

    const fallback = window.setInterval(() => {
      if (disposed) return
      if (!host.isConnected) {
        polling = true
        raf = requestAnimationFrame(poll)
      }
    }, 5000)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      window.clearInterval(fallback)
      try {
        root.unmount()
      } catch {
        /* 忽略 */
      }
      host.remove()
    }
  }, 'dsh-message-gateway: mount')
}

/** Cordis plugin entry — named + default export so the loader always resolves it. */
export default { apply, inject }
