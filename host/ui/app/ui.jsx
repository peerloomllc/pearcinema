// Shared chrome: the modal, the themed confirm/notify dialog and the theme.
//
// Split out so App, the wizard and the panels can all reach a <Modal> without
// importing each other, which is how a cycle starts.

import { useState, useEffect } from 'preact/hooks'

/* ---- theme ---------------------------------------------------------------- */

const THEME_KEY = 'pearcinema.theme'

function systemIsDark () {
  try {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true
  }
}

export function resolveTheme (pref) {
  if (pref === 'system') return systemIsDark() ? 'dark' : 'light'
  return pref === 'light' ? 'light' : 'dark'
}

export function loadThemePref () {
  try {
    const p = localStorage.getItem(THEME_KEY)
    return p === 'light' || p === 'dark' || p === 'system' ? p : 'system'
  } catch {
    return 'system'
  }
}

export function applyThemePref (pref) {
  const resolved = resolveTheme(pref)
  document.documentElement.setAttribute('data-theme', resolved)
  try { localStorage.setItem(THEME_KEY, pref) } catch {}
  return resolved
}

/* ---- confirm -------------------------------------------------------------- */

// window.confirm on a control plane is both ugly and, in some browsers,
// suppressible. This is the themed replacement, with the same await-a-boolean shape
// so a caller reads the same way.
let _pushConfirm = null

export function askConfirm (opts) {
  return new Promise(resolve => {
    if (!_pushConfirm) return resolve(window.confirm(opts.message || opts.title))
    _pushConfirm({ ...opts, resolve })
  })
}

// An informational popup (single button), for the outcome of Test / Save / Rescan.
export function notify (title, message) {
  return askConfirm({ title, message, confirmLabel: 'Done', info: true })
}

export function ConfirmHost () {
  const [c, setC] = useState(null)
  useEffect(() => { _pushConfirm = setC; return () => { _pushConfirm = null } }, [])
  useEffect(() => {
    if (!c) return
    const h = e => { if (e.key === 'Escape') { c.resolve(false); setC(null) } }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [c])
  if (!c) return null
  const close = v => { c.resolve(v); setC(null) }
  return (
    <div class='overlay' onMouseDown={e => { if (e.target === e.currentTarget) close(false) }}>
      <div class='modal' role='alertdialog' aria-modal='true'>
        <h3>{c.title}</h3>
        {c.message && <p class='hint' style='white-space:pre-wrap'>{c.message}</p>}
        <div class={'confirm-actions' + (c.info ? ' center' : '')}>
          {!c.info && <button class='ghost' onClick={() => close(false)}>{c.cancelLabel || 'Cancel'}</button>}
          <button class={c.danger ? 'destructive' : ''} onClick={() => close(true)} autofocus>{c.confirmLabel || 'Confirm'}</button>
        </div>
      </div>
    </div>
  )
}

export function Modal ({ title, onClose, children, wide = false }) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div class='overlay' onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div class='modal' role='dialog' aria-modal='true' aria-label={title} style={wide ? 'max-width:44rem' : ''}>
        <div class='modal-head'>
          <h3>{title}</h3>
          <button class='iconbtn' onClick={onClose} aria-label='Close'>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Banner ({ kind = '', children }) {
  return <div class={'banner ' + kind}>{children}</div>
}
