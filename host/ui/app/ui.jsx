// Shared chrome: the modal, the themed confirm/notify dialog and the theme.
//
// Split out so App, the wizard and the panels can all reach a <Modal> without
// importing each other, which is how a cycle starts.

import { useState, useEffect } from 'preact/hooks'
import { Close } from './icons'

/* ---- theme ---------------------------------------------------------------- */

// AND THE OTHER TWO APPEARANCE CHOICES, kept beside the theme because they are the same
// kind of thing: a preference about this browser, remembered here, never sent anywhere.
// The phone keeps its own in the worklet's settings, deliberately - it is a different
// device with a different screen, and somebody wearing the 35mm skin on the sofa does not
// thereby want it on the television in the study.
const SKIN_KEY = 'pearcinema.skin'
const TONE_KEY = 'pearcinema.tone'

const SKINS = ['off', 'film', 'mst3k']
const TONES = ['off', 'bw', 'sepia']

const readPref = (key, allowed) => {
  try {
    const v = localStorage.getItem(key)
    return allowed.includes(v) ? v : allowed[0]
  } catch {
    return allowed[0]
  }
}
const writePref = (key, v) => { try { localStorage.setItem(key, v) } catch {} }

export const loadSkinPref = () => readPref(SKIN_KEY, SKINS)
export const saveSkinPref = (v) => writePref(SKIN_KEY, SKINS.includes(v) ? v : 'off')
export const loadTonePref = () => readPref(TONE_KEY, TONES)
export const saveTonePref = (v) => writePref(TONE_KEY, TONES.includes(v) ? v : 'off')


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
        {/* No `center` variant any more: every window centres its buttons, so
            the one-button case needs no class of its own. */}
        <div class='confirm-actions'>
          {!c.info && <button class='ghost' onClick={() => close(false)}>{c.cancelLabel || 'Cancel'}</button>}
          <button class={c.danger ? 'destructive' : ''} onClick={() => close(true)} autofocus>{c.confirmLabel || 'Confirm'}</button>
        </div>
      </div>
    </div>
  )
}

// `closeLabel` is for a window with STEPS in it: on a step, the corner button goes
// back rather than out, and a screen reader should not be told otherwise.
export function Modal ({ title, onClose, children, wide = false, closeLabel = 'Close' }) {
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
          <button class='iconbtn' onClick={onClose} aria-label={closeLabel}><Close size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Banner ({ kind = '', children }) {
  return <div class={'banner ' + kind}>{children}</div>
}
