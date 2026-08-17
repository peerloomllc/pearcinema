// The shell.
//
// Three places, and the split is deliberate: WATCH (the library and the player),
// WHO (devices and people, where revoke lives) and SETTINGS (the source, the name,
// the password). PearTune's dashboard had no first tab at all, which is the gap
// this app closes.

import { useState, useEffect, useCallback } from 'preact/hooks'
import { api, copyText, setRemoteBase, fmtSize } from './api'
import { Modal, ConfirmHost, notify, loadThemePref, applyThemePref, resolveTheme } from './ui'
import { needsSetup, setupDismissed, undismissSetup } from './setup'
import { probeCapabilities } from './playback'
// `People` is the devices SCREEN; `PeopleIcon` is the picture of one.
import { Home, Search, Close, Gear, Sun, Moon, People as PeopleIcon, Download as DownloadIcon } from './icons'
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
  ['security', 'Security'],
  ['support', 'Support development'],
  ['remotes', 'Remote libraries'],
  ['casting', 'Casting'],
  ['host', 'This host']
]

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
        open a pairing window and send you the link under the code - paste it here.
        They can cut this machine off any time, and your spot in a film is kept on
        their server like any other device's.
      </p>
      {remotes.length > 0 && (
        <div class='rootlist'>
          {remotes.map(r => (
            <div class='rootrow' key={r.hostKey}>
              <span class='rootpath'>{r.libraryName || 'Library'}{r.online ? '' : ' - offline'}</span>
              <button onClick={() => onSource(source === r.libraryId ? '' : r.libraryId)}>
                {source === r.libraryId ? 'Watching' : 'Watch'}
              </button>
              <button class='ghost' onClick={() => remove(r)}>Remove</button>
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
              ? <button class='ghost' onClick={async () => { await api('/api/downloads/cancel', { itemId: d.itemId }); setTick(t => t + 1) }}>Cancel</button>
              : (
                <>
                  <button onClick={() => onPlay(d)}>Play</button>
                  <button class='ghost' onClick={async () => { await api('/api/downloads/remove', { itemId: d.itemId }); setTick(t => t + 1) }}>Remove</button>
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
    // An owner answering on their phone should show up here without a page
    // refresh (Tim, 2026-08-17). A gentle poll while the card is on screen;
    // real pushes are filed as the proper fix.
    const t = setInterval(load, 10000)
    return () => { live = false; clearInterval(t) }
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
              <button class='ghost' onClick={async () => { await api(`/remote/${q.lib}/api/request/remove`, { id: q.id }); setTick(t => t + 1) }}>Withdraw</button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// Casting to a television (video-deltas §5). The host talks to the Home
// Assistant on THIS machine; paired phones then send films to the TVs it
// knows about, and revoking a phone darkens whatever it started. The token is
// write-only - the page learns one is saved, never what it is.
function CastPanel () {
  const [cfg, setCfg] = useState(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState(null)
  // The media players BY NAME. A count alone cannot say which of seven
  // entities is the television and which are the kitchen speakers (Tim,
  // 2026-08-17) - so once casting is on, the panel lists what Home Assistant
  // actually reports, name, id and state.
  const [targets, setTargets] = useState(null)

  const loadTargets = async () => {
    const r = await api('/api/cast/targets')
    setTargets(r?.error ? [] : (r.targets || []))
  }

  useEffect(() => {
    let live = true
    api('/api/cast').then(r => {
      if (!live || r?.error) return
      setCfg(r)
      setBaseUrl(r.baseUrl || '')
      if (r.enabled && r.tokenSet) loadTargets()
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
    if (r.enabled && r.tokenSet) loadTargets()
    else setTargets(null)
    notify('Saved', enabled
      ? 'Casting is on. Phones paired as owner can now send films to your TVs.'
      : 'Casting is off.')
  }

  const runTest = async () => {
    setBusy(true)
    const r = await api('/api/cast/test', {})
    setBusy(false)
    setTest(r?.error ? { bad: r.error } : { ok: r.targets })
    if (!r?.error) loadTargets()
  }

  if (!cfg) return <div class='card'><h3>Casting</h3><p class='hint'>Loading…</p></div>

  return (
    <div class='card'>
      <h3>Casting</h3>
      <p class='hint'>
        Send films from a phone to a TV - a Chromecast, a Google TV or a
        television with Cast built in. PearCinema reaches them through the Home
        Assistant running on this same machine: paste a long-lived access token
        from your Home Assistant profile page. Only phones paired as owner can
        cast, and cutting a phone off also stops whatever it put on a TV.
      </p>
      <div class='field'>
        <label>Home Assistant address</label>
        <input
          type='text' value={baseUrl} placeholder='http://127.0.0.1:8123'
          onInput={e => setBaseUrl(e.currentTarget.value)}
        />
      </div>
      <div class='field'>
        <label>Access token{cfg.tokenSet ? ' (saved - leave empty to keep it)' : ''}</label>
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
      {targets !== null && (
        <>
          <h3 style='margin-top:1rem'>What Home Assistant reports</h3>
          {targets.length === 0 && <p class='hint'>No media players right now.</p>}
          {targets.length > 0 && (
            <div class='rootlist'>
              {targets.map(t => (
                <div class='rootrow' key={t.entityId}>
                  <span class='rootpath'>
                    {t.name}
                    <span class='hint'> · {t.entityId} · {t.state}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          <p class='hint'>
            Phones offer all of these when casting. Speakers play a film's sound
            only, so aim at the television - one that is off usually shows as
            "off" or "unavailable" here until you turn it on.
          </p>
        </>
      )}
      <div class='actions'>
        <button onClick={() => save(true)} disabled={busy || (!cfg.tokenSet && !token.trim())}>
          {cfg.enabled ? 'Save' : 'Save and turn on'}
        </button>
        {cfg.enabled && (
          <button class='ghost' onClick={() => save(false)} disabled={busy}>Turn off</button>
        )}
        {/* Tests what is SAVED, so it only appears once something is. */}
        {cfg.tokenSet && (
          <button class='ghost' onClick={runTest} disabled={busy}>Test connection</button>
        )}
      </div>
    </div>
  )
}

function Settings ({ state, reload, remotes = [], onSource = () => {}, source = '', onPlayDownload = () => {} }) {
  const [sec, setSec] = useState(() => {
    const [t, s] = hashParts()
    return (t === 'settings' && SETTINGS_SECTIONS.some(([id]) => id === s)) ? s : 'source'
  })
  // The hash can change while Settings is already open - the topbar's
  // download indicator points at settings/remotes - so follow it live rather
  // than only reading it at mount.
  useEffect(() => {
    const follow = () => {
      const [t, s] = hashParts()
      if (t === 'settings' && SETTINGS_SECTIONS.some(([id]) => id === s)) setSec(s)
    }
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  const [name, setName] = useState(state.library || '')
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')

  const src = state.auth?.passwordSource

  const saveName = async () => {
    const res = await api('/api/library', { name })
    if (res.error) return notify('Not renamed', res.error)
    await reload()
    notify('Renamed', 'Every paired phone relabels straight away.')
  }

  const savePassword = async () => {
    const res = await api('/api/password', { current: cur, next })
    if (res.error) return notify('Not changed', res.error)
    setCur(''); setNext('')
    notify('Changed', 'You are still logged in here. Other browsers will need the new one.')
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

        {sec === 'security' && (
          <div class='card'>
            <h3>This page's password</h3>
            {!state.auth?.enabled && (
              <p class='hint'>
                There is no password, because this page is only reachable from the machine it
                runs on. If it is ever opened to the network it will refuse to start without one.
              </p>
            )}
            {src === 'explicit' && (
              <p class='hint'>
                This password comes from the platform that installed PearCinema - on Umbrel it is
                the app password shown next to PearCinema in your app list. Change it there, or a
                restart would quietly put it back.
              </p>
            )}
            {(src === 'generated' || src === 'file') && (
              <>
                <div class='field'>
                  <label>The current one</label>
                  <input type='password' value={cur} onInput={e => setCur(e.currentTarget.value)} />
                </div>
                <div class='field'>
                  <label>A new one (at least 8 characters)</label>
                  <input type='password' value={next} onInput={e => setNext(e.currentTarget.value)} />
                </div>
              </>
            )}
            <div class='actions'>
              {(src === 'generated' || src === 'file') && (
                <button onClick={savePassword} disabled={!cur || next.length < 8}>Change it</button>
              )}
              <button class='ghost' onClick={async () => { await api('/api/logout', {}); location.reload() }}>Log out</button>
              {state.auth?.enabled && (
                <button class='ghost' onClick={async () => {
                  const res = await api('/api/logout-everywhere', {})
                  if (res?.error) return notify('Not done', res.error)
                  notify('Done', res.others === 0
                    ? 'No other browser was logged in.'
                    : `${res.others} other browser${res.others === 1 ? ' was' : 's were'} logged out. This one stays.`)
                }}>Log out everywhere else</button>
              )}
            </div>
            {state.auth?.enabled && (
              <p class='hint'>
                A browser stays logged in for a week. Log out everywhere else is for the
                laptop you handed back - every other browser is out at once, this one stays.
              </p>
            )}
          </div>
        )}

        {sec === 'support' && <SupportPanel />}

        {sec === 'host' && (
          <>
            <div class='card'>
              <h3>This host</h3>
              <p class='hint mono' style='word-break:break-all'>{state.hostKey}</p>
              <p class='hint'>
                That is this library's address on the network PearCinema uses. It is not a
                secret, and it is not enough on its own to get in - a device also needs a
                grant, which only pairing creates.
              </p>
              <div class='actions'>
                <button class='ghost' onClick={() => { undismissSetup(); location.reload() }}>Run first-time setup again</button>
              </div>
            </div>
            <TranscodeCap state={state} reload={reload} />
          </>
        )}
      </div>
    </div>
  )
}

// PearTune's Support Development panel, copied per Tim's 2026-08-15 ask -
// content and rails identical, rendered as a Settings section because that is
// where he placed it here. The QR comes from the host (/api/donate), the same
// way the pairing code does, so the page needs no QR library of its own.
function SupportPanel () {
  const [rails, setRails] = useState(null)
  const [tab, setTab] = useState('ln')
  const [copied, setCopied] = useState(false)

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
        helps keep it free - entirely optional.
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
function TranscodeCap ({ state, reload }) {
  const t = state.transcode || {}
  const c = state.transcodeCap || {}
  const [cap, setCap] = useState(String(c.cap ?? 4))
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    const res = await api('/api/transcode-cap', { cap: Number(cap) })
    setBusy(false)
    if (res?.error) return notify('Not saved', res.error)
    notify('Saved', Number(cap) === 0
      ? 'Conversions are off. Files stream as they are, and anything a device cannot play is refused honestly.'
      : `Up to ${cap} conversions will run at once. Running ones finish as they were.`)
    reload()
  }

  return (
    <div class='card'>
      <h3>The video engine</h3>
      <p class='hint'>
        {t.available
          ? 'This box converts films on its video hardware when a device cannot play them as they are.'
          : `Conversions are not available: ${t.reason || 'the hardware probe did not pass'}.`}
      </p>
      {t.available && (
        <>
          <div class='field'>
            <label>How many films it will convert at once</label>
            <input
              type='number' min='0' max='16' step='1' value={cap}
              style='max-width:6rem'
              onInput={e => setCap(e.currentTarget.value)}
            />
          </div>
          <p class='hint'>
            The measured ceiling on this class of hardware is about {c.measured || 10} at
            once; the default of 4 leaves headroom for whatever else shares the engine.
            0 turns conversions off entirely.
          </p>
          <div class='actions'>
            <button onClick={save} disabled={busy || String(c.cap) === String(cap) || cap === ''}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

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
              aria-label={dlBusy === 1 ? 'One download running - see its progress' : dlBusy + ' downloads running - see their progress'}
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
