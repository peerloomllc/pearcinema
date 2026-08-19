// The shell.
//
// Three places, and the split is deliberate: WATCH (the library and the player),
// WHO (devices and people, where revoke lives) and SETTINGS (the source, the name,
// the password). PearTune's dashboard had no first tab at all, which is the gap
// this app closes.

import { useState, useEffect, useCallback } from 'preact/hooks'
import { api, copyText, setRemoteBase, fmtSize, onLive } from './api'
import { Modal, ConfirmHost, notify, loadThemePref, applyThemePref, resolveTheme } from './ui'
import { needsSetup, setupDismissed, undismissSetup } from './setup'
import { probeCapabilities } from './playback'
// `People` is the devices SCREEN; `PeopleIcon` is the picture of one.
import { Home, Search, Close, Gear, Sun, Moon, People as PeopleIcon, Download as DownloadIcon, Trash, Play, Eye, EyeOff } from './icons'
import Library from './Library'
import Player from './Player'
import People from './People'
import Pair from './Pair'
import SourcePanel from './SourcePanel'
import Metadata from './Metadata'
import Wizard from './Wizard'

// Asked once. canPlayType cannot change while the page is open, and every poster in
// a 274-film grid would otherwise ask again.
const CAPS = probeCapabilities()

// SETTINGS IS A SIDE NAVIGATION, one section on screen at a time (Tim, 2026-08-14,
// picked from three sketches). Five cards stacked in one column read as clutter the
// moment two of them grew real controls; a slim nav gives each section the whole
// width and the page one calm shape - the same shape Plex and Jellyfin settle on,
// so it also reads as familiar.
const SETTINGS_SECTIONS = [
  ['source', 'Source'],
  ['artwork', 'Artwork'],
  ['library', 'Library'],
  ['support', 'Support development'],
  ['remotes', 'Remote libraries'],
  ['casting', 'Casting'],
  ['host', 'This host']
]

// PAGES THAT WENT SOMEWHERE ELSE. Eight sections is being consolidated to five (Tim,
// 2026-08-19), and a section that moves must not turn every link and bookmark to it
// into a silent fall back to Source. Security was one password field with a nav item
// of its own; it lives on This host now, which is whose password it is.
const MOVED_SECTIONS = { security: 'host' }

// The hash names the page - #settings/source opens Settings on Source - so a
// section is linkable, refreshable and reachable by anything that can only
// load a URL (a bookmark, a support reply, a headless screenshot).
const hashParts = () => String(location.hash || '').replace(/^#/, '').split('/')

// Somebody else's libraries (proposal 2026-08-16-desktop-client): paste the
// pairing link from their dashboard - the QR always carries its link underneath
// for machines without a camera - and their films play in these same pages.
function RemotePanel ({ remotes, reload, onSource, source }) {
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const pair = async () => {
    setBusy(true); setErr('')
    const r = await api('/api/remote/pair', { link: link.trim() })
    setBusy(false)
    if (r?.error) return setErr(r.error)
    setLink('')
    await reload()
    if (r?.libraryId) onSource(r.libraryId)
  }

  const remove = async (row) => {
    if (source === row.libraryId) onSource('')
    await api('/api/remote/remove', { hostKey: row.hostKey })
    await reload()
  }

  return (
    <div class='card'>
      <h3>Remote libraries</h3>
      <p class='hint'>
        Watch a library that lives on somebody else's server. On their dashboard,
        open a pairing window and send you the link under the code. Paste it here.
        They can cut this machine off any time, and your spot in a film is kept on
        their server like any other device's.
      </p>
      {remotes.length > 0 && (
        <div class='rootlist'>
          {remotes.map(r => (
            <div class='rootrow' key={r.hostKey}>
              <span class='rootpath'>{r.libraryName || 'Library'}{r.online ? '' : ' (offline)'}</span>
              <button onClick={() => onSource(source === r.libraryId ? '' : r.libraryId)}>
                {source === r.libraryId ? 'Watching' : 'Watch'}
              </button>
              <button
                class='iconbtn danger' onClick={() => remove(r)}
                aria-label={`Remove ${r.libraryName || 'this library'}`} title='Remove'
              ><Trash size={17} /></button>
            </div>
          ))}
        </div>
      )}
      <div class='field'>
        <input
          type='text' value={link} placeholder='pear://pearcinema/pair?...'
          onInput={e => setLink(e.currentTarget.value)}
        />
      </div>
      {err && <p class='error'>{err}</p>}
      <div class='actions'>
        <button onClick={pair} disabled={busy || !link.trim()}>{busy ? 'Pairing...' : 'Pair'}</button>
      </div>
    </div>
  )
}

// Films kept on this machine from friends' libraries (phase 2). Hidden until
// there is one - an empty downloads card is a feature announcement, and the
// place downloads are discovered is the player's details sheet.
function DownloadsCard ({ remotes, onPlay }) {
  const [items, setItems] = useState(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    let t = null
    const look = async () => {
      const r = await api('/api/downloads')
      if (!live) return
      setItems(r.items || [])
      // Fast while something moves, gently otherwise - removing a library
      // takes its downloads with it server-side, and the card must not keep
      // showing what is already gone (Tim, 2026-08-17).
      t = setTimeout(look, (r.items || []).some(d => d.downloading) ? 2000 : 10000)
    }
    look()
    return () => { live = false; clearTimeout(t) }
  }, [tick, remotes.map(r => r.libraryId).join(',')])
  if (!items?.length) return null
  const nameOf = (lib) => remotes.find(r => r.libraryId === lib)?.libraryName || 'a library'
  return (
    <div class='card'>
      <h3>Downloads</h3>
      <p class='hint'>
        Films kept on this machine. They play here even while the library they
        came from is offline.
      </p>
      <div class='rootlist'>
        {items.map(d => (
          <div class='rootrow' key={d.itemId}>
            <span class='rootpath'>
              {d.title || 'Untitled'}
              {d.downloading
                ? (
                  <span class='dlline'>
                    <span class='meter dlmeter'>
                      <i style={`width:${d.size ? Math.min(99, Math.round((d.got / d.size) * 100)) : 0}%`} />
                    </span>
                    <span class='hint'>
                      {d.size ? Math.min(99, Math.round((d.got / d.size) * 100)) : 0}%{d.converting ? ' · being converted' : ''}
                    </span>
                  </span>
                  )
                : <span class='hint'> · {fmtSize(d.size)} · from {nameOf(d.lib)}</span>}
            </span>
            {d.downloading
              ? (
                <button
                  class='iconbtn' aria-label={`Stop downloading ${d.title || 'this'}`} title='Stop downloading'
                  onClick={async () => { await api('/api/downloads/cancel', { itemId: d.itemId }); setTick(t => t + 1) }}
                ><Close size={17} /></button>
                )
              : (
                <>
                  <button class='iconbtn primary' aria-label={`Play ${d.title || 'this'}`} title='Play' onClick={() => onPlay(d)}>
                    <Play size={18} />
                  </button>
                  <button
                    class='iconbtn danger' aria-label={`Delete ${d.title || 'this'} from this machine`} title='Delete from this machine'
                    onClick={async () => { await api('/api/downloads/remove', { itemId: d.itemId }); setTick(t => t + 1) }}
                  ><Trash size={17} /></button>
                </>
                )}
          </div>
        ))}
      </div>
    </div>
  )
}

// Your open asks, per remote library (phase 2) - made from an empty search on
// a friend's library, watched and withdrawn here. Hidden until there is one.
function RequestsCard ({ remotes }) {
  const [rows, setRows] = useState(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    const load = async () => {
      const out = []
      for (const r of remotes) {
        const res = await api(`/remote/${r.libraryId}/api/requests`).catch(() => null)
        for (const q of res?.items || []) out.push({ ...q, lib: r.libraryId, libraryName: r.libraryName })
      }
      if (live) setRows(out)
    }
    load()
    // An owner answering on their phone shows up here without a page refresh
    // (Tim, 2026-08-17). The answer now ARRIVES - the friend's host pushes it to
    // this machine and the live channel carries it into the page.
    const off = onLive(['request:resolved', 'request:created', 'request:removed'], load)
    // A slow backstop for the seam the channel cannot cover: a withdrawal made
    // on this person's OTHER device is pushed to the library's owners, not to
    // them, so nothing tells this card. Minutes-stale beats wrong, and this is a
    // sixth of the poll it replaces.
    const t = setInterval(load, 60000)
    return () => { live = false; off(); clearInterval(t) }
  }, [remotes.map(r => r.libraryId).join(','), tick])
  if (!rows?.length) return null
  return (
    <div class='card'>
      <h3>Your requests</h3>
      <p class='hint'>
        What you have asked these libraries for. Ask by searching a friend's
        library for something it does not have.
      </p>
      <div class='rootlist'>
        {rows.map(q => (
          <div class='rootrow' key={q.lib + q.id}>
            <span class='rootpath'>
              {q.name} · {q.kind === 'series' ? 'show' : 'film'} · {q.status} · {q.libraryName || 'a library'}
            </span>
            {q.status === 'pending' && (
              <button
                class='iconbtn danger' aria-label={`Withdraw your request for ${q.name}`} title='Withdraw'
                onClick={async () => { await api(`/remote/${q.lib}/api/request/remove`, { id: q.id }); setTick(t => t + 1) }}
              ><Trash size={17} /></button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// CASTING, rebuilt 2026-08-19 around the televisions rather than around the
// plumbing.
//
// It used to be a Home Assistant form with a paragraph about Rokus underneath, and
// that shape carried a real bug rather than only a preference: everything on the page
// was gated on a Home Assistant token, so a person with a Roku and nothing else was
// shown "Casting is off" and an empty page while casting worked perfectly from their
// phone. Their server had found the television. The page never asked.
//
// So the order is now the outcome first and the plumbing second:
//
//   1. THE TELEVISIONS. Always loaded, whatever is or is not configured. One row per
//      television with how it was found, whether it is answering, and one switch.
//   2. HOW THEY ARE FOUND. One row per route with a live status. "On your network" is
//      always on and needs nothing; Home Assistant is optional and folded away until
//      somebody opens it.
//
// The principle underneath, which is also why there is no questionnaire here:
// DISCOVER EVERYTHING DISCOVERABLE, AND ASK ONLY FOR WHAT CANNOT BE. The one thing
// that cannot be discovered is a Home Assistant token.

// What a television's state means to somebody reading it, rather than to Home
// Assistant. A found television that is not answering is almost always one whose
// television is switched off - measured on Tim's stick 2026-08-19: with the set off it
// answers nothing at all, because the stick is powered by the television.
function readableState (t) {
  const s = String(t.state || '').toLowerCase()
  if (s === 'playing') return 'Playing now'
  if (s === 'paused') return 'Paused'
  if (s === 'unavailable' || s === 'off' || s === 'standby') {
    return t.via === 'roku' ? 'Switched off or asleep' : 'Not answering'
  }
  if (s === 'idle' || s === 'on') return 'Ready'
  return t.state || 'Unknown'
}

const isReachable = (t) => !['unavailable', 'off', 'standby'].includes(String(t.state || '').toLowerCase())

function CastPanel () {
  const [cfg, setCfg] = useState(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState(null)
  const [targets, setTargets] = useState(null)
  const [needsChannel, setNeedsChannel] = useState([])
  const [mediaChannel, setMediaChannel] = useState('Media Assistant')
  // Folded away, because most people will never open it. It opens itself when it is
  // already set up, so somebody who configured it is not made to go looking.
  const [haOpen, setHaOpen] = useState(false)

  const readTargets = (r) => {
    if (!r || r.error) return
    setTargets(r.targets || [])
    if (r.needsChannel) setNeedsChannel(r.needsChannel)
    if (r.mediaChannel) setMediaChannel(r.mediaChannel)
  }

  const loadTargets = async () => readTargets(await api('/api/cast/targets'))

  useEffect(() => {
    let live = true
    // BOTH, and neither waits for the other. The televisions are the page.
    loadTargets()
    api('/api/cast').then(r => {
      if (!live || r?.error) return
      setCfg(r)
      setBaseUrl(r.baseUrl || '')
      setHaOpen(!!r.tokenSet)
    })
    return () => { live = false }
  }, [])

  const save = async (enabled) => {
    setBusy(true); setTest(null)
    const r = await api('/api/cast', { enabled, baseUrl, ...(token ? { token } : {}) })
    setBusy(false)
    if (r?.error) return notify('Not saved', r.error)
    setToken('')
    setCfg(r)
    loadTargets()
    notify('Saved', enabled
      ? 'Home Assistant is connected. Its televisions are on the list above.'
      : 'Home Assistant is disconnected. Televisions found on your network are unaffected.')
  }

  // Saved on the spot rather than behind a Save button: it reads as a switch on a row,
  // and a switch that needs a second press somewhere else to mean anything is a switch
  // people get wrong.
  const toggleHidden = async (t) => {
    setBusy(true)
    const r = await api('/api/cast/hidden', { entityId: t.entityId, hidden: !t.hidden })
    setBusy(false)
    if (r?.error) return notify('Not saved', r.error)
    readTargets(r)
  }

  const rescan = async () => {
    setBusy(true)
    const r = await api('/api/cast/rescan', {})
    setBusy(false)
    if (r?.error) return notify('Could not look', r.error)
    readTargets(r)
    notify('Looked again', `${(r.targets || []).filter(x => x.via === 'roku').length} found on your network.`)
  }

  const runTest = async () => {
    setBusy(true)
    const r = await api('/api/cast/test', {})
    setBusy(false)
    setTest(r?.error ? { bad: r.error } : { ok: r.targets })
    if (!r?.error) loadTargets()
  }

  const rows = targets || []
  const viaHa = rows.filter(t => t.via !== 'roku')
  const anyOff = rows.some(t => !isReachable(t))
  const haStatus = cfg?.tokenSet && cfg?.enabled
    ? `connected${viaHa.length ? `, ${viaHa.length} media player${viaHa.length === 1 ? '' : 's'}` : ''}`
    : 'not set up'

  return (
    <div class='card'>
      <h3>Televisions</h3>

      {targets === null && <p class='hint'>Looking…</p>}

      {/* THE ONLY PLACE THE SETUP STORY IS TOLD, because it is the only moment it is
          any use: an empty list is exactly when somebody wants to know what would
          make it not empty. */}
      {targets !== null && rows.length === 0 && (
        <p class='hint'>
          None yet. Your server finds televisions on its own network within a few seconds
          of one being switched on. A Roku also needs the free {mediaChannel} channel
          installed on it, which is the only one that will play a film handed to it.
        </p>
      )}

      {rows.length > 0 && (
        <div class='rootlist'>
          {rows.map(t => (
            <div class='rootrow tvrow' key={t.entityId}>
              <span class='tvname'>
                {t.name}
                <span class='hint'>
                  {readableState(t)}
                  {' · '}
                  {t.via === 'roku' ? 'found on your network' : 'via Home Assistant'}
                  {t.deviceClass && t.deviceClass !== 'tv' ? ` · ${t.deviceClass}` : ''}
                  {t.hidden ? ' · hidden from phones' : ''}
                </span>
              </span>
              <button
                class='iconbtn'
                disabled={busy}
                onClick={() => toggleHidden(t)}
                aria-label={t.hidden ? `Offer ${t.name} when casting` : `Stop offering ${t.name} when casting`}
                title={t.hidden ? 'Offer this one' : 'Hide from phones'}
              >
                {t.hidden ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* SAID ONLY WHEN IT APPLIES. A line about switched-off televisions is noise on
          a page where none of them are. */}
      {anyOff && (
        <p class='hint'>
          A television that is switched off stays on this list and comes back by itself.
        </p>
      )}

      {/* The one thing nobody could work out: a Roku sitting right there, missing from
          the list, because of one free channel. */}
      {needsChannel.length > 0 && (
        <p class='error'>
          {needsChannel.length === 1
            ? `Found ${needsChannel[0].name}, but it has no ${mediaChannel}.`
            : `Found ${needsChannel.length} Rokus with no ${mediaChannel}: ${needsChannel.map(d => d.name).join(', ')}.`}
          {' '}Install it from the Roku channel store, then press Look again.
        </p>
      )}

      {/* HOW THEY ARE FOUND, as a footer rather than a section. Finding is always on
          and needs nothing said about it; Home Assistant is one optional extra, and a
          status plus a way in is the whole of what it needs on screen. */}
      <div class='tvfoot'>
        <button class='ghost' onClick={rescan} disabled={busy}>Look again</button>
        <span class='hint grow'>Home Assistant: {haStatus}</span>
        <button class='ghost' onClick={() => setHaOpen(!haOpen)} disabled={!cfg}>
          {haOpen ? 'Hide' : (cfg?.tokenSet ? 'Change' : 'Set up')}
        </button>
      </div>

      {haOpen && cfg && (
        <>
          <p class='hint'>
            Only for televisions your server cannot find on its own: a Chromecast, a
            Google TV, a television with Cast built in. Make a long-lived access token on
            your Home Assistant profile page.
          </p>
          <div class='field'>
            <label>Home Assistant address</label>
            <input
              type='text' value={baseUrl} placeholder='http://127.0.0.1:8123'
              onInput={e => setBaseUrl(e.currentTarget.value)}
            />
          </div>
          <div class='field'>
            <label>Access token{cfg.tokenSet ? ' (saved, leave empty to keep it)' : ''}</label>
            <input
              type='password' value={token}
              onInput={e => setToken(e.currentTarget.value)}
            />
          </div>
          {cfg.problem && <p class='error'>{cfg.problem}</p>}
          {test?.bad && <p class='error'>{test.bad}</p>}
          {test?.ok !== undefined && (
            <p class='hint'>
              Connected. Home Assistant knows about {test.ok} media player{test.ok === 1 ? '' : 's'}.
            </p>
          )}
          <div class='actions'>
            <button onClick={() => save(true)} disabled={busy || (!cfg.tokenSet && !token.trim())}>
              {cfg.enabled ? 'Save' : 'Save and connect'}
            </button>
            {cfg.enabled && (
              <button class='ghost' onClick={() => save(false)} disabled={busy}>Disconnect</button>
            )}
            {cfg.tokenSet && (
              <button class='ghost' onClick={runTest} disabled={busy}>Test connection</button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Settings ({ state, reload, remotes = [], onSource = () => {}, source = '', onPlayDownload = () => {} }) {
  const resolveSection = (t, s) => {
    if (t !== 'settings') return null
    if (SETTINGS_SECTIONS.some(([id]) => id === s)) return s
    return MOVED_SECTIONS[s] || null
  }
  const [sec, setSec] = useState(() => resolveSection(...hashParts()) || 'source')
  // The hash can change while Settings is already open - the topbar's
  // download indicator points at settings/remotes - so follow it live rather
  // than only reading it at mount.
  useEffect(() => {
    const follow = () => {
      const next = resolveSection(...hashParts())
      if (next) setSec(next)
    }
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  const [name, setName] = useState(state.library || '')

  const saveName = async () => {
    const res = await api('/api/library', { name })
    if (res.error) return notify('Not renamed', res.error)
    await reload()
    notify('Renamed', 'Every paired phone relabels straight away.')
  }

  return (
    <div class='settings'>
      <nav class='setnav' aria-label='Settings sections'>
        {SETTINGS_SECTIONS.map(([id, label]) => (
          <button key={id} class={sec === id ? 'on' : ''} onClick={() => { setSec(id); location.hash = 'settings/' + id }}>{label}</button>
        ))}
      </nav>

      <div class='setbody'>
        {sec === 'source' && <SourcePanel state={state} reload={reload} />}

        {sec === 'artwork' && <Metadata />}

        {sec === 'library' && (
          <div class='card'>
            <h3>The library's name</h3>
            <p class='hint'>This is the name a phone shows when it is paired with you.</p>
            <div class='field'>
              <input type='text' value={name} maxLength={64} onInput={e => setName(e.currentTarget.value)} />
            </div>
            <div class='actions'>
              <button onClick={saveName} disabled={!name.trim() || name === state.library}>Save</button>
            </div>
          </div>
        )}

        {sec === 'remotes' && (
          <>
            <RemotePanel remotes={remotes} reload={reload} onSource={onSource} source={source} />
            <DownloadsCard remotes={remotes} onPlay={onPlayDownload} />
            <RequestsCard remotes={remotes} />
          </>
        )}

        {sec === 'casting' && <CastPanel />}

        {sec === 'support' && <SupportPanel />}

        {sec === 'host' && <HostPanel state={state} reload={reload} />}

      </div>
    </div>
  )
}

// THIS HOST, the first page rebuilt in the shape the rest of Settings is moving to
// (Tim, 2026-08-19: the Settings pages are busy and not aesthetically pleasing).
//
// It was two nav items and three cards: This host, Security, and the video engine.
// They are one page now, because they are all answers to the same question - what is
// this machine, and what is it allowed to do.
//
// THE LIBRARY'S ADDRESS IS NOT ON IT (Tim, 2026-08-19: "do we even need Address? I
// don't think we even use it anywhere for anything" - he was right). Every other use
// of the host key is one library reaching another, in code; pairing never asks a
// person for it, and nothing on any screen was ever copied from here. If it turns out
// to be wanted for support, the pairing screen is where it belongs.
//
// THREE RULES THIS PAGE IS THE PILOT FOR:
//
//   ONE SETTING PER ROW. What it is on the left, the control on the right, and a
//   sub-line only where the control genuinely needs one. What this replaces is a card
//   per setting with two or three paragraphs above the control, so a page you already
//   understood still made you read it.
//
//   ICONS WHERE A WORD IS NOISE, WORDS WHERE AN ICON IS A GUESS. Copying an address is
//   an icon. "Log out everywhere else" is not, and neither is "Run again" - a rare or
//   irreversible action should never be a pictogram somebody has to interpret.
//
//   THE CARD'S OWN ACTION ROW STAYS CENTERED (Tim's call, 2026-08-15). A control that
//   belongs to one row sits in that row, which is a different thing.
function HostPanel ({ state, reload }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [pwOpen, setPwOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const t = state.transcode || {}
  const c = state.transcodeCap || {}
  const [cap, setCap] = useState(String(c.cap ?? 4))

  const src = state.auth?.passwordSource
  // Only a password this host owns can be changed from here. One set by the platform
  // would be quietly put back on the next restart, which is worse than not offering it.
  const ownPassword = src === 'generated' || src === 'file'

  const savePassword = async () => {
    const res = await api('/api/password', { current: cur, next })
    if (res.error) return notify('Not changed', res.error)
    setCur(''); setNext(''); setPwOpen(false)
    notify('Changed', 'You are still signed in here. Other browsers will need the new one.')
  }

  // THE NUMBER SAVES ITSELF as you change it. It had a Save button, and
  // that button was the only filled amber control on the page, in the only row with two
  // controls, next to the only input - four reasons for one row to shout, stacked (Tim,
  // 2026-08-19, with a screenshot). The same reasoning the casting hide switch already
  // follows: a control that needs a second press somewhere else to mean anything is a
  // control people get wrong.
  const commitCap = async () => {
    const n = Math.trunc(Number(cap))
    // An empty or unusable box is not a request to set anything - put the real value
    // back rather than sending a guess.
    if (cap === '' || !Number.isFinite(n)) return setCap(String(c.cap ?? 4))
    const clamped = Math.max(0, Math.min(16, n))
    setCap(String(clamped))
    if (String(clamped) === String(c.cap)) return

    setBusy(true)
    const res = await api('/api/transcode-cap', { cap: clamped })
    setBusy(false)
    if (res?.error) {
      setCap(String(c.cap ?? 4))
      return notify('Not saved', res.error)
    }
    notify('Saved', clamped === 0
      ? 'Conversions are off. Films stream as they are, and anything a device cannot play is refused honestly.'
      : `Up to ${clamped} conversions will run at once. Running ones finish as they were.`)
    reload()
  }

  // AFTER THE TYPING STOPS, not on every keystroke. Saving per keystroke would set the
  // cap to 1 on the way to typing 16, and a cap of 1 refuses conversions for as long as
  // it stands. Each change cancels the last timer, so only the number somebody settled
  // on is ever sent. Leaving the box or pressing Enter still commits at once, so this is
  // a shortcut rather than the only way out.
  useEffect(() => {
    if (!t.available || cap === '') return
    const n = Math.max(0, Math.min(16, Math.trunc(Number(cap))))
    if (!Number.isFinite(n) || String(n) === String(c.cap)) return
    const timer = setTimeout(commitCap, 700)
    return () => clearTimeout(timer)
  }, [cap])

  const passwordSub = !state.auth?.enabled
    ? 'None. This page is reachable only from this machine.'
    : src === 'explicit'
      ? 'Set by the platform that installed this. Change it there.'
      : 'Other browsers will need the new one.'

  // NO CLAIM ABOUT HARDWARE NOBODY MEASURED. This line used to read "this hardware
  // managed about 10 in testing" on every install, and the 10 is a constant from the
  // N100 this was built against - a number about OUR machine, presented as a number
  // about theirs (Tim, 2026-08-19). What is true everywhere is what zero does.
  // NAMED ONLY WHEN THERE IS A CHOICE. A render node is a graphics card, not a folder -
  // it holds nothing and nothing is written to it - but the raw path reads like a
  // location, and on a machine with one card it changes nothing anyway (Tim, who asked
  // whether it might run out of space, 2026-08-19). With two cards it is the answer to
  // which one is working, so it appears.
  const manyCards = (t.nodes?.length || 0) > 1

  // WHAT THE NUMBER MEANS: how many conversions may run at the same time, and what is
  // doing them. NOT how many this machine could manage - nothing here has ever measured
  // that, and the line that used to claim it was quoting the hardware this was built on.
  // When a host can measure its own engine (TODO), that measurement becomes the field's
  // ceiling rather than another sentence.
  const engineSub = !t.available
    ? (t.probing ? 'Asking the hardware what it can do.' : (t.reason || 'The hardware probe did not pass.'))
    : Number(c.cap) === 0
      ? 'Nothing is converted while this is 0.'
      : `Up to ${c.cap} conversion${Number(c.cap) === 1 ? '' : 's'} run at once${manyCards && t.device ? `, on ${t.device}` : ''}. Setting it to 0 turns conversions off.`

  // THE NAME CARRIES THE STATE, not a pill beside it (Tim, 2026-08-19). A chip was one
  // more object on a page whose whole problem was objects, and this row was already the
  // busiest on it.
  //
  // COLOUR IS NEVER THE ONLY CARRIER. The line underneath always states the condition in
  // words - what it is doing, or why it is not - so nobody has to tell green from amber
  // to read this row.
  const engineTone = !t.available
    ? 'dim'
    : Number(c.cap) === 0
      ? 'warn'
      : 'good'

  return (
    <>
      <div class='setpage'><span class='setpagename'>This host</span></div>

      <div class='setrows'>
        <div class='setrow'>
          <span class='rowmain'>
            <span class='rowname'>Password</span>
            <span class='rowsub'>{passwordSub}</span>
          </span>
          {ownPassword && (
            <span class='rowctl'>
              <button class='ghost' onClick={() => setPwOpen(!pwOpen)}>{pwOpen ? 'Cancel' : 'Change'}</button>
            </span>
          )}
        </div>

        {pwOpen && ownPassword && (
          <div class='rowopen'>
            <div class='field'>
              <label>The current one</label>
              <input type='password' value={cur} onInput={e => setCur(e.currentTarget.value)} />
            </div>
            <div class='field'>
              <label>A new one (at least 8 characters)</label>
              <input type='password' value={next} onInput={e => setNext(e.currentTarget.value)} />
            </div>
            <div class='actions'>
              <button onClick={savePassword} disabled={!cur || next.length < 8}>Change it</button>
            </div>
          </div>
        )}

        <div class='setrow'>
          <span class='rowmain'>
            <span class='rowname'>This browser</span>
          </span>
          <span class='rowctl'>
            <button class='ghost' onClick={async () => { await api('/api/logout', {}); location.reload() }}>Sign out</button>
          </span>
        </div>

        {state.auth?.enabled && (
          <div class='setrow'>
            <span class='rowmain'>
              <span class='rowname'>Other browsers</span>
              <span class='rowsub'>Each stays signed in for a week.</span>
            </span>
            <span class='rowctl'>
              <button class='ghost' onClick={async () => {
                const res = await api('/api/logout-everywhere', {})
                if (res?.error) return notify('Not done', res.error)
                notify('Done', res.others === 0
                  ? 'No other browser was signed in.'
                  : `${res.others} other browser${res.others === 1 ? ' was' : 's were'} signed out. This one stays.`)
              }}>Sign out</button>
            </span>
          </div>
        )}

        <div class='setrow'>
          <span class='rowmain'>
            <span class={`rowname ${engineTone}`}>Video engine</span>
            <span class='rowsub'>{engineSub}</span>
          </span>
          {t.available && (
            <span class='rowctl'>
              <input
                type='number' min='0' max='16' step='1' value={cap} disabled={busy}
                aria-label='How many films this host will convert at once'
                onInput={e => setCap(e.currentTarget.value)}
                onBlur={commitCap}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
              />
            </span>
          )}
        </div>

        <div class='setrow'>
          <span class='rowmain'>
            <span class='rowname'>First-time setup</span>
            <span class='rowsub'>Nothing already set is undone.</span>
          </span>
          <span class='rowctl'>
            <button class='ghost' onClick={() => { undismissSetup(); location.reload() }}>Run again</button>
          </span>
        </div>

      </div>
    </>
  )
}

// PearTune's Support Development panel, copied per Tim's 2026-08-15 ask -
// content and rails identical, rendered as a Settings section because that is
// where he placed it here. The QR comes from the host (/api/donate), the same
// way the pairing code does, so the page needs no QR library of its own.
function SupportPanel () {
  const [rails, setRails] = useState(null)
  const [tab, setTab] = useState('ln')

  useEffect(() => {
    let live = true
    api('/api/donate').then(r => { if (live) setRails(r?.rails || null) })
    return () => { live = false }
  }, [])

  const rail = rails?.[tab]
  const copy = async () => {
    if (rail && await copyText(rail.value)) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
  }

  return (
    <div class='card'>
      <h3>Support development</h3>
      <p class='hint' style='text-align:center'>
        No accounts, no servers, no subscriptions. If PearCinema is useful to you, a tip
        helps keep it free, and it is entirely optional.
      </p>
      <div class='seg' style='max-width:22rem;margin:0 auto .9rem'>
        <button class={tab === 'ln' ? 'on' : ''} onClick={() => { setTab('ln'); setCopied(false) }}>Lightning</button>
        <button class={tab === 'onchain' ? 'on' : ''} onClick={() => { setTab('onchain'); setCopied(false) }}>On-chain</button>
        <button class={tab === 'usd' ? 'on' : ''} onClick={() => { setTab('usd'); setCopied(false) }}>USD</button>
      </div>
      {rail
        ? (
          <>
            <div class='donate-qr' dangerouslySetInnerHTML={{ __html: rail.svg }} />
            <div class='donate-cap'>{rail.caption}</div>
            <div class='donate-addr'>{rail.value}</div>
            <div class='actions'>
              <button class='ghost' onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              {tab === 'usd' && (
                <button onClick={() => window.open(rail.value, '_blank', 'noopener')}>Open ↗</button>
              )}
            </div>
          </>
          )
        : <p class='hint' style='text-align:center'>Loading…</p>}
    </div>
  )
}

// The video engine's cap - how many films this box will convert at once.
// Default 4 against a measured ceiling of about 10 on the N100 (DECISIONS
// 2026-08-13), because a box sharing /dev/dri deserves headroom - but a box
// serving one household member should not refuse at a limit sized for
// sharing, which is why this is a field and not just an env var. Zero is the
// off switch: conversions stop being OFFERED (honest refusals), not merely
// refused at the door as busy.

export default function App () {
  const [state, setState] = useState(null)
  const [tab, setTab] = useState(() => {
    const [t] = hashParts()
    return ['watch', 'who', 'settings'].includes(t) ? t : 'watch'
  })
  const [search, setSearch] = useState('')
  const [playing, setPlaying] = useState(null)
  const [queue, setQueue] = useState([])
  const [pairing, setPairing] = useState(false)
  const [wizard, setWizard] = useState(false)
  // Somebody else's libraries this machine is paired to, and which library the
  // watch surface points at ('' is this box's own). Switching swaps the read
  // base and remounts the library - the control plane stays local throughout.
  const [remotes, setRemotes] = useState([])
  const [source, setSource] = useState('')
  // Whether the blend exists - two or more libraries holding anything.
  const [blendOn, setBlendOn] = useState(false)
  // How many downloads are running, for the topbar indicator.
  const [dlBusy, setDlBusy] = useState(0)
  // The theme lives up here now rather than inside Settings: it is a light switch, and
  // a light switch belongs on the wall by the door (PearTune's shape, Tim 2026-08-13).
  const [theme, setTheme] = useState(loadThemePref())
  // Where the library should open when we leave the player by climbing rather than by
  // going all the way out. Held here because the library owns which show and season it
  // is showing, and the player is a sibling of it rather than a child.
  const [startAt, setStartAt] = useState(null)

  // Where this person got to, and what they have finished. SEPARATE from /api/state,
  // which is the operator's view of the box and polls every eight seconds - watch
  // state changes when somebody watches something, not on a timer, and re-reading it
  // eight times a minute would be a scan of the store for nothing.
  const [watch, setWatch] = useState({ watched: [], continue: [], watching: null, choose: [] })
  const reloadWatch = useCallback(async () => {
    const w = await api('/api/watch/state')
    if (!w?.error) setWatch(w)
    return w
  }, [])

  const reload = useCallback(async () => {
    const s = await api('/api/state')
    setState(s)
    api('/api/remote/list').then(r => {
      if (Array.isArray(r?.remotes)) setRemotes(r.remotes)
      // The blend option follows the membership - and asking keeps the index
      // warm, since the ready() behind this is what rebuilds a stale one.
      if ((r?.remotes || []).length) api('/api/blend').then(b => setBlendOn(!!b?.available)).catch(() => {})
      else setBlendOn(false)
    }).catch(() => {})
    // Whether anything is downloading, for the topbar's indicator (Tim,
    // 2026-08-17) - rides the same 8s poll the rest of the bar lives on.
    api('/api/downloads').then(r => setDlBusy((r?.items || []).filter(d => d.downloading).length)).catch(() => {})
    return s
  }, [])

  // DEFINED ABOVE THE MOUNT EFFECT AND THE EARLY RETURN, and that placement
  // is load-bearing: on the very first render the component returns Loading
  // before the consts below the return exist, yet the mount effect's closure
  // has already captured their bindings - touching one from that closure is
  // the temporal dead zone, and it took the whole page down (the third TDZ
  // of 2026-08-17; everything a top-level effect calls now lives above it).
  //
  // '_blend' is the third value of the base trick: '' this box, a libraryId
  // one remote, '_blend' all of them as one collection. The choice is
  // remembered per browser - how somebody likes to look at their libraries
  // is not the host's business.
  const pickSource = (lib) => {
    setSource(lib)
    setRemoteBase(lib === '_blend' ? '/blend' : lib ? '/remote/' + lib : '')
    try { localStorage.setItem('pearcinema.library', lib) } catch {}
    setPlaying(null)
    setSearch('')
    reloadWatch()
  }

  useEffect(() => {
    applyThemePref(loadThemePref())
    // A machine with a REMOTE library is already a client and skips the
    // wizard (approved open question 1 of the desktop-client proposal) - and
    // on a client-only machine the watch surface OPENS on the friend's
    // library, because "No films yet" over an empty local shelf is the wrong
    // greeting for a browser that exists to watch somebody else's. The
    // remote list is asked here directly because reload() fetches it without
    // awaiting, and both decisions need the answer in hand.
    reload().then(async s => {
      const r = await api('/api/remote/list').catch(() => null)
      const remoteLibs = r?.remotes || []
      const b = remoteLibs.length ? await api('/api/blend').catch(() => null) : null
      if (b?.available) setBlendOn(true)

      // Where to open: the remembered choice when it is still valid, else
      // the blend when there is one (All by default, the phone's rule), else
      // the client-only fallback onto the friend's library.
      let stored = null
      try { stored = localStorage.getItem('pearcinema.library') } catch {}
      const storedValid = stored === '' ||
        (stored === '_blend' && b?.available) ||
        remoteLibs.some(x => x.libraryId === stored)
      if (stored !== null && storedValid) {
        if (stored !== '') pickSource(stored)
      } else if (b?.available) {
        pickSource('_blend')
      } else if (s?.source?.kind === 'empty' && remoteLibs.length) {
        pickSource(remoteLibs[0].libraryId)
      }

      if (!needsSetup(s) || setupDismissed()) return
      if (!remoteLibs.length) setWizard(true)
    })
    reloadWatch()
    // The device list changes without us doing anything - a phone pairs, a guest
    // pass expires, somebody comes online. Poll gently rather than leaving a stale
    // roster on screen next to a revoke button.
    const t = setInterval(reload, 8000)
    return () => clearInterval(t)
  }, [])

  if (!state) return <div class='empty'>Loading…</div>

  // What this browser can decode PLUS one fact about the host: whether its hardware
  // probe passed, because a verdict is a promise about what will happen and what
  // happens depends on both ends. Folded into caps rather than passed beside it so
  // every consumer of a verdict gets both halves or neither.
  // Watching a REMOTE library, the transcode promise is the friend's to keep -
  // assume willing and let the remote routes answer honestly (409 with the
  // reason) when it is not, rather than greying films on a guess.
  const caps = { ...CAPS, hostTranscode: source ? true : !!state.transcode?.available }

  const play = (item, list) => { setQueue(list || []); setPlaying(item) }

  // Play a kept copy from the Downloads card: switch to its library so the
  // routes and the shim prefix line up, then open the player on an item built
  // from the download's own stored facts - which is what lets it open with the
  // friend's server off, when the library pages themselves cannot load.
  const playDownload = (row) => {
    pickSource(row.lib)
    setTab('watch')
    setPlaying({
      id: row.itemId,
      type: row.type || 'movie',
      title: row.title || 'Untitled',
      year: row.year || null,
      runtime: row.runtime || null,
      seriesTitle: row.seriesTitle || null,
      seasonNumber: row.seasonNumber ?? null,
      episodeNumber: row.episodeNumber ?? null,
      media: row.media || null
    })
  }

  const online = (state.devices || []).filter(d => d.online && !d.revokedAt).length
  // Searching means something on the library and nowhere else - not on Devices, not on
  // Settings, and not while a film is open.
  // SEARCHING WORKS FROM ANYWHERE. It used to be disabled off the Watch tab, which is
  // a rule about where you happen to be standing rather than about what you want -
  // typing a film's name means "find me this film" wherever you are. So typing carries
  // you to the library and starts filtering (Tim, 2026-08-13).
  const searchable = true
  const onSearch = (v) => {
    setSearch(v)
    if (v && (tab !== 'watch' || playing)) { setTab('watch'); setPlaying(null) }
  }

  return (
    <div class='shell'>
      <div class='topbar'>
        {/* THE NAME IS THE WAY HOME, which is what a logo is for - and it is why the
            tabs could leave the bar at all. */}
        <button
          class='brand'
          onClick={() => { setTab('watch'); setPlaying(null) }}
          aria-label='Back to the library'
          title='Back to the library'
        >
          <Home size={20} />
          {/* ONE ELEMENT, because the row has a `gap` and a gap falls between text
              nodes as readily as between boxes - which is what put a space in the
              middle of the name. */}
          <span class='word'>Pear<span>Cinema</span></span>
        </button>
        {remotes.length > 0 && (
          <select
            class='libpick'
            value={source}
            aria-label='Which library to watch'
            onChange={e => pickSource(e.currentTarget.value)}
          >
            {blendOn && <option value='_blend'>All libraries</option>}
            <option value=''>{state.library || 'My library'}</option>
            {remotes.map(r => (
              <option key={r.libraryId} value={r.libraryId}>
                {r.libraryName || 'Library'}{r.online ? '' : ' (offline)'}
              </option>
            ))}
          </select>
        )}
        {/* THE SEARCH SITS IN THE MIDDLE OF THE BAR AND THE BAR NEVER CHANGES HEIGHT.
            It used to be rendered only on the Watch tab, so opening Devices or Settings
            took the box out and the whole header shrank - the page jumped under the
            pointer every time somebody changed tab (Tim, 2026-08-13). It is always
            here now, and merely INERT where searching means nothing, so the bar keeps
            one height and the middle keeps one thing in it. */}
        <div class='searchslot'>
          {/* ALWAYS THERE, DISABLED WHERE IT MEANS NOTHING. Rendering it only on Watch
              left an empty slot, and an empty slot is not the same height as one with
              a box in it - so the bar still moved when you changed tab. A greyed-out
              box is honest about where searching applies AND keeps the header still. */}
          <div class={'searchbox' + (searchable ? '' : ' off')}>
            <Search size={15} />
            <input
              type='text'
              value={searchable ? search : ''}
              placeholder='Search the library'
              disabled={!searchable}
              aria-label='Search the library'
              onInput={e => onSearch(e.currentTarget.value)}
            />
            {searchable && search && (
              <button class='iconbtn' onClick={() => setSearch('')} aria-label='Clear'><Close size={15} /></button>
            )}
          </div>
        </div>
        {/* THE RIGHT-HAND SIDE IS TOOLS, in PearTune's order and PearTune's shapes:
            the light switch, then the gear. Both are icons because both are things you
            reach for occasionally and neither deserves a word's worth of the bar. */}
        <div class='barright'>
          {/* SOMETHING IS DOWNLOADING (Tim, 2026-08-17): a bar-level light
              while any download runs, one click from its progress - the
              Downloads card under Settings, Remote libraries. */}
          {dlBusy > 0 && (
            <button
              class='iconbtn dlbusy'
              aria-label={dlBusy === 1 ? 'One download running. See its progress' : dlBusy + ' downloads running. See their progress'}
              title={dlBusy === 1 ? 'One download running' : dlBusy + ' downloads running'}
              onClick={() => { location.hash = 'settings/remotes'; setTab('settings'); setPlaying(null) }}
            >
              <DownloadIcon size={18} />
              <span class='dot' aria-hidden='true' />
            </button>
          )}
          <button
            class={'iconbtn' + (tab === 'who' ? ' on' : '')}
            onClick={() => { setTab('who'); setPlaying(null) }}
            aria-label='User access'
            title={online ? `User access - ${online} online` : 'User access'}
          >
            <PeopleIcon size={18} />
            {online > 0 && <span class='dot' aria-hidden='true' />}
          </button>

          <button
            class='iconbtn'
            onClick={() => { const next = resolveTheme(theme) === 'dark' ? 'light' : 'dark'; setTheme(next); applyThemePref(next) }}
            aria-label='Switch theme'
            title={resolveTheme(theme) === 'dark' ? 'Switch to light' : 'Switch to dark'}
          >
            {resolveTheme(theme) === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          <button
            class={'iconbtn' + (tab === 'settings' ? ' on' : '')}
            onClick={() => { setTab('settings'); setPlaying(null) }}
            aria-label='Settings'
            title='Settings'
          ><Gear size={18} /></button>

          <button onClick={() => setPairing(true)}>Pair a device</button>
        </div>
      </div>

      <div class='scroller'>
      <div class='content'>
        {/* FINISHING THE WIZARD LANDS ON THE LIBRARY, always. The hash is
            cleared too: a leftover #settings/... from before the wizard was
            steering fresh installs into Settings after pairing (Tim,
            2026-08-17, dropped onto This host instead of the films). */}
        {wizard && (
          <Wizard
            state={state}
            reload={reload}
            onDone={() => { setWizard(false); location.hash = ''; setTab('watch'); reload() }}
            onRemotePaired={(lib) => { setWizard(false); location.hash = ''; setTab('watch'); reload().then(() => pickSource(lib)) }}
          />
        )}

        {!wizard && tab === 'watch' && (
          playing
            ? (
              <Player
                item={playing}
                caps={caps}
                queue={queue}
                remote={!!source}
                watch={watch}
                onWatchChange={reloadWatch}
                onPlay={setPlaying}
                onUp={(level) => { setStartAt({ level, item: playing }); setPlaying(null); reloadWatch() }}
                // The shelf is rebuilt when the player closes rather than while it
                // runs: a position written every fifteen seconds would otherwise
                // reshuffle the row behind the film somebody is watching.
                onClose={() => { setPlaying(null); reloadWatch() }}
              />
              )
            : (
              <Library
                key={source}
                state={state}
                caps={caps}
                remote={!!source}
                search={search}
                watch={watch}
                startAt={startAt}
                onStarted={() => setStartAt(null)}
                onPlay={play}
                onWatchChange={reloadWatch}
              />
              )
        )}

        {!wizard && tab === 'who' && <People state={state} reload={reload} />}
        {!wizard && tab === 'settings' && <Settings state={state} reload={reload} remotes={remotes} onSource={pickSource} source={source} onPlayDownload={playDownload} />}
      </div>

      </div>

      {pairing && (
        <Modal title='Pair a device' onClose={() => setPairing(false)}>
          <Pair state={state} reload={reload} onClose={() => setPairing(false)} />
        </Modal>
      )}

      <ConfirmHost />
    </div>
  )
}
