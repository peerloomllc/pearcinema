// Letting a phone in.
//
// THIS IS THE SCREEN THAT UNBLOCKS AN UMBREL INSTALL. PearTune pairs by scanning a
// QR on its dashboard; PearCinema had no dashboard, so a packaged install could be
// started and then never actually reached by a phone. The QR is the product here,
// not decoration.
//
// Three window kinds, and the difference is access rather than convenience:
//
//   guest  - access expires. For lending the library to someone for a weekend.
//   normal - permanent access, read only.
//   owner  - permanent AND may manage the library. Only this page can open one,
//            which is what keeps owner scope rooted in dashboard access. The host
//            enforces owner XOR guest, so an owner is never time-limited.
//
// The window closes itself after a few minutes. That is the host's rule, not this
// page's, and the countdown here reads it rather than deciding it.

import { useState, useEffect } from 'preact/hooks'
import { api, copyText, fmtDur } from './api'

const GUEST_OPTIONS = [
  { label: '1 hour', ms: 3600e3 },
  { label: '24 hours', ms: 86400e3 },
  { label: '7 days', ms: 7 * 86400e3 },
  { label: '30 days', ms: 30 * 86400e3 }
]

export default function Pair ({ state, reload, onClose }) {
  const [win, setWin] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [left, setLeft] = useState(0)
  const [guestMs, setGuestMs] = useState(86400e3)

  // A window opened before this page loaded (or in another tab) is still open, and
  // the QR has to come back for it rather than silently opening a second one.
  useEffect(() => {
    if (state.pairing?.open && !win) {
      setWin({ link: state.pairing.link, guest: state.pairing.guest, owner: state.pairing.owner, expiresMs: state.pairing.expiresMs })
    }
  }, [state.pairing?.open])

  useEffect(() => {
    if (!win?.until) return
    const t = setInterval(() => setLeft(Math.max(0, win.until - Date.now())), 500)
    return () => clearInterval(t)
  }, [win?.until])

  const open = async (opts) => {
    setBusy(true)
    const res = await api('/api/pair/start', opts)
    setBusy(false)
    if (res.error) return
    setWin({ ...res, until: Date.now() + (res.ttlMs || 0) })
    setLeft(res.ttlMs || 0)
    reload()
  }

  const stop = async () => {
    await api('/api/pair/stop', {})
    setWin(null)
    reload()
  }

  if (!win) {
    return (
      <div>
        <p class='hint'>
          Open a window, then scan the code with PearCinema on the phone. Only a device
          that scans while the window is open gets in.
        </p>

        <div class='card' style='background:var(--card-2)'>
          <h3>Give someone permanent access</h3>
          <p class='hint'>They can watch everything, and cannot change anything.</p>
          <button disabled={busy} onClick={() => open({})}>Open a window</button>
        </div>

        <div class='card' style='background:var(--card-2)'>
          <h3>Lend it for a while</h3>
          <p class='hint'>Access stops on its own when the time is up. Nothing to remember to undo.</p>
          <div class='row'>
            <select value={String(guestMs)} onChange={e => setGuestMs(Number(e.currentTarget.value))}>
              {GUEST_OPTIONS.map(o => <option key={o.ms} value={String(o.ms)}>{o.label}</option>)}
            </select>
            <button class='ghost' disabled={busy} onClick={() => open({ expiresMs: guestMs })}>Open a guest window</button>
          </div>
        </div>

        <div class='card' style='background:var(--card-2)'>
          <h3>Add another of your own devices</h3>
          <p class='hint'>
            An owner device can pair other phones and revoke them. Give this only to
            yourself, or to someone you would hand this page's password to.
          </p>
          <button class='ghost' disabled={busy} onClick={() => open({ owner: true })}>Open an owner window</button>
        </div>
      </div>
    )
  }

  const kind = win.owner ? 'Owner' : win.guest ? 'Guest' : 'Full'

  return (
    <div>
      <div class='row' style='justify-content:center;margin-bottom:.6rem'>
        <span class={'chip ' + (win.owner ? 'accent' : win.guest ? 'warn' : 'good')}>{kind} access</span>
        {win.guest && win.expiresMs && <span class='chip'>expires {fmtDur(win.expiresMs)} after pairing</span>}
      </div>

      {/* The host renders the SVG, so the page and any other client of the API
          always show the same code at the same quiet zone. */}
      <div class='qr' dangerouslySetInnerHTML={{ __html: win.svg || '' }} />

      <p class='hint' style='text-align:center;margin-top:.7rem'>
        Scan this in PearCinema on the phone.
        {left > 0 && <> This window closes in {Math.ceil(left / 1000)}s.</>}
      </p>

      <div class='linkbox'>{win.link}</div>

      <div class='confirm-actions'>
        <button class='ghost' onClick={async () => { setCopied(await copyText(win.link)); setTimeout(() => setCopied(false), 1500) }}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <button class='ghost' onClick={stop}>Close the window</button>
        <button onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
