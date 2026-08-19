/**
 * 消息平台页面：覆盖在对话区之上的全屏页面。左栏为平台列表（图标 + 状态），
 * 右栏为选中平台的凭据表单（保存 / 测试连接 / 删除 / 状态详情）。
 * @module dsh-message-gateway/client/Page
 */

import { useCallback, useEffect, useState } from 'react'
import type { GatewayView, PlatformDef, PlatformStatus } from '../core/types.ts'
import type { GatewayApi } from './api.ts'
import { useT } from './i18n.ts'

const STYLE = `
.dsh-gw { --gw-fg:#24292f; --gw-muted:#6e7781; --gw-border:rgba(128,128,128,0.25);
  --gw-hover:rgba(0,0,0,0.06); --gw-bg:#ffffff; --gw-panel:#f6f8fa; --gw-accent:#1976d2;
  --gw-ok:#1a7f37; --gw-err:#cf222e; --gw-warn:#9a6700; position:fixed; inset:0; z-index:1200;
  background:rgba(0,0,0,0.45); display:flex; align-items:center; justify-content:center;
  color:var(--gw-fg); font-size:13px; font-family:-apple-system,BlinkMacSystemFont,
  "Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
[data-ds-dark-theme] .dsh-gw { --gw-fg:#d1d9e0; --gw-muted:#9198a1; --gw-border:rgba(255,255,255,0.14);
  --gw-hover:rgba(255,255,255,0.08); --gw-bg:#1f2328; --gw-panel:#161b22; --gw-accent:#58a6ff;
  --gw-ok:#3fb950; --gw-err:#f85149; --gw-warn:#d4a72c; }
.dsh-gw * { box-sizing:border-box; }
.dsh-gw-page { width:min(1000px, 94vw); height:min(680px, 88vh); background:var(--gw-bg);
  border:1px solid var(--gw-border); border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,0.35);
  display:flex; flex-direction:column; overflow:hidden; }
.dsh-gw-head { display:flex; align-items:center; gap:8px; padding:14px 18px;
  border-bottom:1px solid var(--gw-border); font-weight:600; font-size:15px; }
.dsh-gw-head .spacer { flex:1; }
.dsh-gw-close { border:none; background:transparent; color:var(--gw-muted); cursor:pointer;
  width:30px; height:30px; border-radius:8px; display:flex; align-items:center;
  justify-content:center; padding:0; }
.dsh-gw-close:hover { background:var(--gw-hover); color:var(--gw-fg); }
.dsh-gw-body { flex:1; display:flex; min-height:0; }
.dsh-gw-list { width:230px; flex:none; border-right:1px solid var(--gw-border);
  overflow-y:auto; padding:8px; }
.dsh-gw-item { display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px;
  cursor:pointer; }
.dsh-gw-item:hover { background:var(--gw-hover); }
.dsh-gw-item.active { background:var(--gw-hover); box-shadow:inset 0 0 0 1px var(--gw-border); }
.dsh-gw-item .icon { font-size:18px; flex:none; }
.dsh-gw-item .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; }
.dsh-gw-item .dot { flex:none; width:8px; height:8px; border-radius:50%; }
.dsh-gw-item .dot.connected { background:var(--gw-ok); }
.dsh-gw-item .dot.error { background:var(--gw-err); }
.dsh-gw-item .dot.none { background:#8b949e; }
.dsh-gw-item .dot.manual { background:var(--gw-warn); }
.dsh-gw-item .st { font-size:10px; color:var(--gw-muted); flex:none; width:56px;
  text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-gw-detail { flex:1; min-width:0; overflow-y:auto; padding:18px 22px; }
.dsh-gw-detail h3 { margin:0 0 4px; font-size:15px; display:flex; align-items:center; gap:8px; }
.dsh-gw-detail .hint { color:var(--gw-muted); font-size:12px; line-height:1.6; margin:4px 0 14px; }
.dsh-gw-status { display:inline-flex; align-items:center; gap:6px; padding:3px 10px;
  border-radius:999px; font-size:11px; margin-bottom:14px; }
.dsh-gw-status.connected { background:rgba(26,127,55,0.12); color:var(--gw-ok); }
.dsh-gw-status.error { background:rgba(207,34,46,0.12); color:var(--gw-err); }
.dsh-gw-status.none { background:var(--gw-panel); color:var(--gw-muted); }
.dsh-gw-status.manual { background:rgba(154,103,0,0.12); color:var(--gw-warn); }
.dsh-gw-field { margin-bottom:12px; }
.dsh-gw-field label { display:block; font-size:12px; color:var(--gw-muted); margin-bottom:4px; }
.dsh-gw-input { width:100%; padding:8px 10px; font-size:13px; color:var(--gw-fg);
  background:var(--gw-bg); border:1px solid var(--gw-border); border-radius:8px; outline:none; }
.dsh-gw-input:focus { border-color:var(--gw-accent); }
.dsh-gw-input.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.dsh-gw-actions { display:flex; gap:8px; margin-top:16px; align-items:center; }
.dsh-gw-btn { border:1px solid var(--gw-border); background:transparent; color:var(--gw-fg);
  border-radius:8px; padding:7px 14px; font-size:13px; cursor:pointer; }
.dsh-gw-btn:hover { background:var(--gw-hover); }
.dsh-gw-btn.primary { background:var(--gw-accent); border-color:var(--gw-accent); color:#fff; }
.dsh-gw-btn.danger { color:var(--gw-err); }
.dsh-gw-btn:disabled { opacity:0.5; cursor:default; }
.dsh-gw-msg { flex:1; font-size:12px; text-align:right; white-space:pre-wrap; word-break:break-all; }
.dsh-gw-msg.ok { color:var(--gw-ok); }
.dsh-gw-msg.err { color:var(--gw-err); }
.dsh-gw-detail-empty { color:var(--gw-muted); padding:40px; text-align:center; }
`

let styleInjected = false
function ensureStyle(): void {
  if (styleInjected) return
  styleInjected = true
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-message-gateway'
  tag.textContent = STYLE
  document.head.appendChild(tag)
}

/** 页面 props。 */
export function GatewayPage(props: { api: GatewayApi; onClose: () => void }): React.ReactElement {
  const { api, onClose } = props
  const t = useT()
  const [view, setView] = useState<GatewayView | null>(null)
  const [selected, setSelected] = useState<string>('telegram')
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const result = await api.list()
    if (result.ok) {
      setView(result.value)
      // 预填当前选中平台的已存凭据（表单初始为空，占位显示）。
    } else {
      setMessage({ text: result.error.message, kind: 'err' })
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  // ESC 关闭。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  ensureStyle()

  const statusOf = (id: string): PlatformStatus | undefined => view?.status[id]
  const defOf = (id: string): PlatformDef | undefined => view?.platforms.find((p) => p.id === id)

  const select = (id: string): void => {
    setSelected(id)
    setForm({})
    setMessage(null)
    setTestResult(null)
  }

  const save = async (): Promise<void> => {
    const def = defOf(selected)
    if (def === undefined) return
    if (def.fields.length > 0 && def.fields.every((f) => (form[f.key] ?? '').trim() === '')) {
      setMessage({ text: t('field.token.ph'), kind: 'err' })
      return
    }
    setBusy(true)
    setMessage(null)
    const result = await api.save(selected, form)
    setBusy(false)
    if (result.ok) {
      setView(result.value)
      setMessage({ text: t('gateway.saved'), kind: 'ok' })
      // 保存成功后立即用刚保存的凭据测一次连接，状态即时刷新。
      void runTest()
    } else {
      setMessage({ text: result.error.message, kind: 'err' })
    }
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    // 直接用当前表单值测试（只测不存）；保存才是持久化。
    const def = defOf(selected)
    const result = await api.test(selected, def !== undefined && def.fields.length > 0 ? form : undefined)
    setTesting(false)
    if (result.ok) {
      setTestResult(result.value)
      void load()
    } else {
      setTestResult({ ok: false, detail: result.error.message })
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    const result = await api.delete(selected)
    setBusy(false)
    if (result.ok) {
      setView(result.value)
      setForm({})
      setTestResult(null)
      setMessage({ text: t('gateway.deleted'), kind: 'ok' })
    } else {
      setMessage({ text: result.error.message, kind: 'err' })
    }
  }

  const selectedDef = defOf(selected)
  const selectedStatus = statusOf(selected)

  return (
    <div className="dsh-gw" onClick={onClose}>
      <div className="dsh-gw-page" onClick={(event) => event.stopPropagation()}>
        <div className="dsh-gw-head">
          <span>📮 {t('gateway.title')}</span>
          <span className="spacer" />
          <button type="button" className="dsh-gw-close" title={t('gateway.close')} onClick={onClose}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        <div className="dsh-gw-body">
          <div className="dsh-gw-list">
            {view === null
              ? null
              : view.platforms.map((def) => {
                  const st = view.status[def.id]
                  const state = st?.state ?? 'none'
                  return (
                    <div key={def.id}
                      className={`dsh-gw-item${def.id === selected ? ' active' : ''}`}
                      onClick={() => select(def.id)}>
                      <span className="icon">{def.icon}</span>
                      <span className="name">{t(def.nameKey)}</span>
                      <span className={`dot ${state}`} />
                      <span className="st">{t(`gateway.status.${state}`)}</span>
                    </div>
                  )
                })}
          </div>
          <div className="dsh-gw-detail">
            {selectedDef === undefined ? (
              <div className="dsh-gw-detail-empty">…</div>
            ) : (
              <>
                <h3>{selectedDef.icon} {t(selectedDef.nameKey)}</h3>
                {selectedDef.hintKey !== undefined ? (
                  <div className="hint">{t(selectedDef.hintKey)}</div>
                ) : null}
                {selectedStatus !== undefined ? (
                  <span className={`dsh-gw-status ${selectedStatus.state}`}>
                    {t(`gateway.status.${selectedStatus.state}`)}
                    {selectedStatus.state === 'connected' && selectedStatus.detail !== ''
                      ? ` · ${selectedStatus.detail}`
                      : ''}
                    {selectedStatus.state === 'error' && selectedStatus.detail !== ''
                      ? ` · ${selectedStatus.detail}`
                      : ''}
                  </span>
                ) : null}

                {selectedDef.fields.map((field) => (
                  <div key={field.key} className="dsh-gw-field">
                    <label>{t(field.labelKey)}</label>
                    <input
                      className={`dsh-gw-input mono`}
                      type={field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
                      value={form[field.key] ?? ''}
                      placeholder={field.placeholderKey !== undefined ? t(field.placeholderKey) : ''}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setForm((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    />
                  </div>
                ))}

                <div className="dsh-gw-actions">
                  {selectedDef.fields.length > 0 ? (
                    <>
                      <button type="button" className="dsh-gw-btn primary" disabled={busy}
                        onClick={() => void save()}>{t('gateway.save')}</button>
                      {selectedDef.testable ? (
                        <button type="button" className="dsh-gw-btn" disabled={busy || testing}
                          onClick={() => void runTest()}>
                          {testing ? t('gateway.testing') : t('gateway.test')}
                        </button>
                      ) : null}
                      {selectedStatus?.configured === true ? (
                        <button type="button" className="dsh-gw-btn danger" disabled={busy}
                          onClick={() => void remove()}>{t('gateway.delete')}</button>
                      ) : null}
                    </>
                  ) : (
                    <span className="hint">{t(selectedDef.hintKey ?? '')}</span>
                  )}
                  {message !== null ? <span className={`dsh-gw-msg ${message.kind}`}>{message.text}</span> : null}
                </div>

                {testResult !== null ? (
                  <div className="dsh-gw-field" style={{ marginTop: 14 }}>
                    <label>{t('gateway.testing.result')}</label>
                    <div className={`dsh-gw-msg ${testResult.ok ? 'ok' : 'err'}`}
                      style={{ textAlign: 'left' }}>{testResult.detail}</div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
