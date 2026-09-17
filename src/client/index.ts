/**
 * dsh-message-gateway — 浏览器半区：在侧边栏「工作区」行内挂一个「消息平台」图标按钮
 * （紧贴「智能提醒日历」左侧、搜索图标再左），点击打开全屏平台管理页面
 * （配置凭据 / 测试连接 / 查看状态）。
 * 所有接线失败均记录日志而不抛出——插件 apply 抛错会导致整个 shell 启动失败。
 * @module dsh-message-gateway/client
 */

import { createElement, useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { GatewayApi } from './api.ts'
import { initI18n, useT } from './i18n.ts'
import { GatewayPage } from './Page.tsx'
import { InboxIcon } from './icons.tsx'

/** 注入的 client runtime 结构面孔。 */
interface GatewayClientContext {
  effect(fn: () => (() => void) | void, name: string): void
  locale: {
    getLocale(): { active: string }
    subscribe(fn: () => void): () => void
  }
}

export const inject = ['locale']

const BUTTON_STYLE = `
/* 消息平台入口按钮：样式对齐官方 workspace 插件的 searchButton。
   wide（宽栏）28x28 圆形 / --dsw-alias-label-secondary；
   rail（收起）36x36 圆形 / --dsw-alias-label-primary（官方在收起时放大并提亮）。 */
.dsh-gw-open {
  display:inline-flex; align-items:center; justify-content:center;
  width:28px; height:28px; flex:none; padding:0; margin:0;
  border:none; background:transparent; color:var(--dsw-alias-label-secondary);
  cursor:pointer; border-radius:50%; box-sizing:border-box;
  transition: background 0.15s ease, color 0.15s ease;
}
.dsh-gw-open:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dsh-gw-open:focus-visible { outline:2px solid var(--dsw-alias-label-primary); outline-offset:1px; }
.dsh-gw-open svg { display:block; }

/* 位置：本入口是该行最左侧的注入项，由它承担 margin-left:auto 吸收剩余空间，
   从而与后面的日历 / 搜索图标紧贴成排。
   注意：多个 auto 会被 flex **平分**剩余空间（曾因此出现 100+px 空档），
   所以当日历入口紧随其后时，必须让它交出 auto。 */
[data-gateway-host] { display:flex; align-items:center; flex:none; margin-left:auto; }
[data-gateway-host] + [data-reminder-host] { margin-left:0; }
[data-gateway-host] + [class*="searchSlot"] { margin-left:0 !important; }

/* rail（侧边栏收起）模式：跟随官方 36x36 / primary 色 / 下边距 12px。 */
[class*="rail"] [data-gateway-host] { margin:0 0 12px; }
[class*="rail"] .dsh-gw-open { width:36px; height:36px; color:var(--dsw-alias-label-primary); }
[class*="rail"] .dsh-gw-open svg { width:18px; height:18px; }

/* 悬停提示：portal 到 body，绕开 sectionHeader 的 overflow:hidden 裁剪。 */
.dsh-gw-tip {
  position:fixed; z-index:9999; pointer-events:none; white-space:nowrap;
  padding:4px 8px; border-radius:6px; font-size:12px; line-height:1.4;
  /* 侧边栏 tooltip 官方 token：浅色主题 #f5f6f7（浅底深字）、深色主题 #353638（深底浅字）。
     此前误用不存在的 --dsw-alias-bg-elevated → 回退成白底，深色模式下变成
     「白底 + 浅色字」而看不见。 */
  background:var(--dsw-specific-tip, #f5f6f7);
  color:var(--dsw-alias-label-primary, #0f1115);
  border:1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.28));
  box-shadow:0 4px 12px rgba(0,0,0,0.12);
}
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

/** 按钮 + 页面根组件（挂在「工作区」行内的图标按钮）。 */
function GatewayApp(props: { api: GatewayApi }): React.ReactElement {
  const { api } = props
  const t = useT()
  const [open, setOpen] = useState(false)
  const [tip, setTip] = useState<{ left: number; top: number; transform: string } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const close = useCallback((): void => setOpen(false), [])
  ensureButtonStyle()

  const label = t('gateway.title')

  /** 宽栏在按钮下方居中；收起态在按钮右侧垂直居中（窄栏向下会压住下一个图标）。 */
  const showTip = useCallback((): void => {
    const el = btnRef.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    const inRail = el.closest('[class*="rail"]') !== null
    if (inRail) {
      setTip({ left: r.right + 8, top: r.top + r.height / 2, transform: 'translateY(-50%)' })
    } else {
      setTip({ left: r.left + r.width / 2, top: r.bottom + 6, transform: 'translateX(-50%)' })
    }
  }, [])

  const hideTip = useCallback((): void => setTip(null), [])

  return createElement(
    'div',
    null,
    createElement(
      'button',
      {
        ref: btnRef,
        type: 'button',
        className: 'dsh-gw-open',
        'aria-label': label,
        onClick: () => setOpen(true),
        onMouseEnter: showTip,
        onMouseLeave: hideTip,
        onFocus: showTip,
        onBlur: hideTip,
      },
      createElement(InboxIcon, { size: 16 }),
    ),
    tip !== null
      ? createPortal(
        createElement(
          'div',
          {
            className: 'dsh-gw-tip',
            role: 'tooltip',
            style: { left: tip.left, top: tip.top, transform: tip.transform },
          },
          label,
        ),
        document.body,
      )
      : null,
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

    /**
     * 期望的前一个兄弟节点（即 host 应插到谁之前）。
     * 优先贴到「智能提醒日历」左侧；日历不在就退到搜索槽 / 搜索容器之前。
     * 注意官方在 rail（收起）模式不渲染 searchSlot，此时搜索按钮位于独立的
     * .search 容器内，因此锚点要取其父容器。
     */
    const resolveAnchor = (): HTMLElement | null => {
      const reminder = document.querySelector<HTMLElement>('[data-reminder-host]')
      if (reminder !== null) return reminder
      const searchSlot = document.querySelector<HTMLElement>('[class*="searchSlot"]')
      if (searchSlot !== null) return searchSlot
      const searchBtn = document.querySelector<HTMLElement>('[class*="searchButton"]')
      return searchBtn?.parentElement ?? null
    }

    /** host 是否已挂在正确位置（宽栏 ↔ 收起切换时锚点会变）。 */
    const isPlacedCorrectly = (): boolean => {
      if (!host.isConnected) return false
      const anchor = resolveAnchor()
      if (anchor === null) return false
      return host.nextElementSibling === anchor
    }

    const mount = (): boolean => {
      if (isPlacedCorrectly()) return true

      // 清理历史 host：hot-reload / 多次挂载会残留多个 host。
      document.querySelectorAll<HTMLElement>('[data-gateway-host]').forEach((node) => {
        if (node !== host) node.remove()
      })

      const anchor = resolveAnchor()
      if (anchor === null || anchor.parentElement === null) return false
      anchor.before(host)
      render()
      return true
    }

    // 轮询等待侧边栏就绪；挂载成功后由低频兜底定时器负责位置校验与重挂。
    let raf = 0
    let polling = true
    const poll = (): void => {
      if (disposed || !polling) return
      if (mount()) {
        polling = false
        return
      }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)

    const fallback = window.setInterval(() => {
      if (disposed) return
      // 位置错了也要重挂（宽栏 ↔ 收起 切换后锚点会变）。
      if (!isPlacedCorrectly()) mount()
    }, 1000)

    return () => {
      disposed = true
      polling = false
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
