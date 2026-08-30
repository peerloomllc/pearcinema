// Letting a phone in.
//
// THIS IS THE SCREEN THAT UNBLOCKS AN UMBREL INSTALL. PearTune pairs by scanning a QR
// on its dashboard; PearCinema had no dashboard, so a packaged install could be started
// and then never actually reached by a phone. The QR is the product here, not
// decoration.
//
// THE DESIGN AND THE WORDING ARE PEARTUNE'S, deliberately and almost verbatim (Tim,
// 2026-08-13). Pairing is the one flow a person meets in both apps, usually minutes
// apart and usually while holding a phone in the other hand; two different shapes for
// the same act is where a companion app stops feeling like one. Its segmented control,
// its white QR panel, its captions, its outcome cards.
//
// Three window kinds, and the difference is ACCESS rather than convenience:
//
//   full   - permanent access, read only.
//   guest  - access expires. For lending the library to someone for a weekend.
//   owner  - permanent AND may manage the library. Only this page can open one, which
//            is what keeps owner scope rooted in dashboard access. The host enforces
//            owner XOR guest, so an owner is never time-limited.
//
// PearTune passes `owner` in as a prop from a separate button; here it is a third
// segment, because this dashboard has one Pair button and three things it can mean.
//
// The window closes itself after a few minutes. That is the HOST's rule, not this
// page's, and the countdown here reads it rather than deciding it.

import { useState, useEffect, useRef } from 'preact/hooks'
import { api, copyText, fmtDur } from './api'
import { Check, ChevronDown, Close } from './icons'
import { Modal, notify } from './ui'
import { FolderPicker } from './People'

const DAY_MS = 86400e3
const GUEST_DURATIONS = [
  { ms: 3600e3, label: '1 hour' },
  { ms: DAY_MS, label: '24 hours' },
  { ms: 7 * DAY_MS, label: '7 days' },
  { ms: 30 * DAY_MS, label: '30 days' }
]

export default function Pair ({ state, reload, onClose }) {
  const [kind, setKind] = useState('full') // full | guest | owner
  // WHAT THIS DEVICE WILL BE ABLE TO SEE, chosen BEFORE it is let in
  // (proposals/2026-08-30-per-person-folders.md, open question 1). Until now a person was
  // let in with the whole library and narrowed on the People page afterwards, which leaves
  // a window - however short - where they can see everything. Empty means everything,
  // which is the default and what every pairing did before.
  const [paths, setPaths] = useState([])
  const [choosing, setChoosing] = useState(false)
  // A DECISION, NOT A DEFAULT. "Can see: everything" was a line somebody had to notice
  // and disagree with, which is the same mistake the eye icon made (Tim, 2026-08-30).
  // Nothing is selected until it is chosen, and the code cannot be shown before that.
  const [access, setAccess] = useState(null) // null | 'all' | 'some'
  const [win, setWin] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [left, setLeft] = useState(0)
  const [durMs, setDurMs] = useState(DAY_MS)
  // { ok: true, label, owner } once a device came through, { ok: false } once the
  // window closed with nobody through it.
  const [outcome, setOutcome] = useState(null)

  // WHO WAS ALREADY HERE, keyed by device and stamped with grantedAt AND scope.
  // Success is a device whose signature CHANGED rather than merely a new key: a
  // re-pair stamps a fresh grantedAt, and an owner promotion of an already-paired
  // phone flips scope without one. Folding both in catches both. (PearTune learned
  // this the hard way; it is copied rather than re-derived.)
  const before = useRef(new Map())
  const sig = (d) => `${d.grantedAt}|${d.scope || ''}`

  // A window opened before this page loaded (or in another tab) is still open, and the
  // QR has to come back for it rather than silently opening a second one.
  useEffect(() => {
    if (state.pairing?.open && !win) {
      setWin({
        link: state.pairing.link,
        svg: state.pairing.svg,
        guest: state.pairing.guest,
        owner: state.pairing.owner,
        expiresMs: state.pairing.expiresMs
      })
    }
  }, [state.pairing?.open])

  useEffect(() => {
    if (!win?.until) return
    const t = setInterval(() => setLeft(Math.max(0, win.until - Date.now())), 500)
    return () => clearInterval(t)
  }, [win?.until])

  // SAY WHAT HAPPENED, rather than leaving somebody holding a code with no idea
  // whether it worked. The host's window is one-shot, so `pairing` goes false either
  // way; a device whose signature changed is what separates "paired" from "expired".
  // Polls faster than the page's own refresh so the confirmation feels immediate, and
  // only while a code is actually up.
  useEffect(() => {
    if (!win || outcome) return
    let done = false
    const t = setInterval(async () => {
      if (done) return
      const st = await api('/api/state').catch(() => null)
      if (!st || done) return
      const fresh = (st.devices || []).find(d => !d.revokedAt && before.current.get(d.deviceKey) !== sig(d))
      if (fresh) {
        done = true
        const label = fresh.label || 'a device'
        setOutcome({ ok: true, label, owner: win.owner || fresh.scope === 'owner' })
        reload()
        setTimeout(onClose, 2200)
      } else if (st.pairing === false) {
        // The window ended with nobody through it. Do NOT close on its own: somebody
        // is standing there and needs a fresh code, not a modal that vanishes.
        done = true
        setOutcome({ ok: false })
      }
    }, 1000)
    return () => { done = true; clearInterval(t) }
  }, [win, outcome])

  const open = async () => {
    setBusy(true)
    const st = await api('/api/state').catch(() => null)
    before.current = new Map((st?.devices || []).map(d => [d.deviceKey, sig(d)]))

    // An owner is never filtered, so the choice is not offered for one and not sent.
    const seeing = kind !== 'owner' && access === 'some' && paths.length ? { paths } : {}
    const res = await api('/api/pair/start',
      kind === 'owner' ? { owner: true } : kind === 'guest' ? { expiresMs: durMs, ...seeing } : seeing)
    setBusy(false)
    if (res.error) return
    setWin({ ...res, until: Date.now() + (res.ttlMs || 0) })
    setLeft(res.ttlMs || 0)
    reload()
  }

  const stop = async () => {
    await api('/api/pair/stop', {})
    setWin(null)
    setOutcome(null)
    reload()
  }

  const copyLink = async () => {
    if (await copyText(win.link)) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
  }

  // --- the outcome ----------------------------------------------------------

  if (outcome) {
    return (
      <div class='stack center'>
        {outcome.ok
          ? (
            <>
              <span class='pairicon good'><Check size={30} /></span>
              <h3 class='pairdone'>
                {outcome.owner ? `${outcome.label} is now an owner` : `Paired with ${outcome.label}`}
              </h3>
              <p class='hint center'>
                {outcome.owner
                  ? 'It can manage this library from the app now. Closing…'
                  : 'It can reach your library now. Closing…'}
              </p>
            </>
            )
          : (
            <>
              <span class='pairicon'><Close size={28} /></span>
              <h3 class='pairdone'>That code expired</h3>
              <p class='hint center'>Nobody paired through it. Show a fresh one when the phone is ready.</p>
              <div class='pairacts'>
                <button class='ghost' onClick={onClose}>Close</button>
                <button onClick={() => { setOutcome(null); setWin(null) }}>New code</button>
              </div>
            </>
            )}
      </div>
    )
  }

  // --- choosing what kind of access -----------------------------------------

  if (!win) {
    return (
      <div class='stack center'>
        <div class='seg wide'>
          <button class={kind === 'full' ? 'on' : ''} onClick={() => setKind('full')}>Full access</button>
          <button class={kind === 'guest' ? 'on' : ''} onClick={() => setKind('guest')}>Guest pass</button>
          <button class={kind === 'owner' ? 'on' : ''} onClick={() => setKind('owner')}>Owner</button>
        </div>

        {kind === 'owner' && (
          <p class='hint center'>
            Scan this in PearCinema on the phone you want to make an <b>owner</b>. It can
            then manage this library from the app: see devices, revoke, open a pairing
            window.
          </p>
        )}
        {kind === 'guest' && (
          <label class='hint center dur'>Access expires
            <select value={String(durMs)} onChange={e => setDurMs(Number(e.currentTarget.value))}>
              {GUEST_DURATIONS.map(o => <option key={o.ms} value={String(o.ms)}>{o.label} after pairing</option>)}
            </select>
          </label>
        )}
        {kind === 'full' && (
          <p class='hint center'>Permanent access. Scan the code in PearCinema on your phone.</p>
        )}

        {/* WHAT THIS DEVICE WILL BE ABLE TO SEE, ASKED RATHER THAN ASSUMED. An owner is
            never filtered, so an owner window skips the question entirely. */}
        {kind !== 'owner' && (
          <>
            <p class='hint center'>What will this device be able to see?</p>
            <div class='seg wide'>
              <button
                class={access === 'all' ? 'on' : ''}
                onClick={() => { setAccess('all'); setPaths([]) }}
              >The whole library</button>
              <button
                class={access === 'some' ? 'on' : ''}
                onClick={() => { setAccess('some'); setChoosing(true) }}
              >Only some folders</button>
            </div>
            {access === 'some' && (
              <button class='seeline center-self' onClick={() => setChoosing(true)}>
                {paths.length
                  ? `${paths.length} folder${paths.length === 1 ? '' : 's'} chosen - change`
                  : 'Choose the folders'}
                <span class='seechev'><ChevronDown size={13} /></span>
              </button>
            )}
          </>
        )}
        {choosing && (
          <Modal title='What this device can see' onClose={() => setChoosing(false)}>
            <FolderPicker
              picked={paths}
              onChange={setPaths}
              who='this device'
              prompt='Tick the drives or folders this device may watch. Everything inside a ticked folder is included.'
            />
            {/* The house shape for a window's buttons: centred, one width, no inline
                style - `.confirm-actions`, which every other window here uses. */}
            <div class='confirm-actions'>
              <button onClick={() => setChoosing(false)}>Done</button>
            </div>
          </Modal>
        )}

        {/* THE GATE. No code until the question is answered, and no code for "only some
            folders" until some are actually chosen - an empty list means everything, and
            handing somebody the whole library while they believe they narrowed it is the
            one outcome this whole feature exists to prevent. */}
        <button onClick={open} disabled={busy || (kind !== 'owner' && (!access || (access === 'some' && !paths.length)))}>
          {busy ? 'Starting…' : 'Show pairing code'}
        </button>
        {kind !== 'owner' && !access && <p class='hint center'>Choose what they can see first.</p>}
        {kind !== 'owner' && access === 'some' && !paths.length && <p class='hint center'>Pick at least one folder.</p>}
      </div>
    )
  }

  // --- the code -------------------------------------------------------------

  return (
    <div class='stack center'>
      {/* A BIGGER, WELL-PADDED WHITE PANEL, in both themes, and it is not decoration:
          a phone camera's auto-exposure meters what surrounds the code, so a small
          white card floating in a dark modal gets blown out and the modules wash into
          grey. Widening the light region is what makes it scan in a dark room.
          Inherited from PearTune, which paid for it. */}
      <div class='qrpanel'>
        {/* The host renders the SVG, so this page and any other client of the API show
            the same code at the same quiet zone. */}
        <div class='qr' dangerouslySetInnerHTML={{ __html: win.svg || '' }} />
        <div class='qrcap'>
          {win.owner
            ? 'Owner pairing. This phone gains library management, valid for 5 minutes.'
            : win.guest
              ? `Guest pass. Access expires ${fmtDur(win.expiresMs)} after this device pairs.`
              : 'Valid for 5 minutes. Closes as soon as one device pairs.'}
        </div>
      </div>

      {left > 0 && <p class='hint center'>This window closes in {Math.ceil(left / 1000)}s.</p>}

      <div class='keyrow'>
        <div class='key addr'>{win.link}</div>
      </div>

      <div class='pairacts'>
        <button class='ghost' onClick={stop}>Cancel</button>
        <button onClick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  )
}
