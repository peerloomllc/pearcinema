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
import { Home, Search, Close, Gear, Sun, Moon, People as PeopleIcon, Download as DownloadIcon, Trash, Play, Eye, EyeOff, Spinner, Bell, Check } from './icons'
import Library from './Library'
import Player from './Player'
import People from './People'
import Pair from './Pair'
import SourcePanel, { SourceBanners, describeSource } from './SourcePanel'
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
// FIVE PAGES, DOWN FROM EIGHT (Tim, 2026-08-19). Grouped by what somebody is thinking
// about rather than by which file the code lives in:
//
//   Library      the collection - its name, where the films are, artwork
//   Sharing      was Remote libraries - libraries, downloads, requests
//   Casting      televisions and speakers, and how they are found
//   This host    this machine - password, sessions, the video engine
//   Support      unchanged
//
// Source, Artwork and Library were three nav items for one subject, and two of them
// held a single control each.
// CASTING, NOT TELEVISIONS (Tim, 2026-08-19, asking to change it back). The page was
// rebuilt around televisions and took their name with it, but it also lists the
// speakers Home Assistant knows about - and calling a speaker a television is simply
// wrong. Casting is the one word that covers everything on the page and it is the verb
// people use for the action.
// THE ORDER IS HOW OFTEN, AND WHAT ABOUT (Tim, 2026-08-19). Library and Sharing are
// both about the collection and the people who see it, and Sharing is where a request
// waiting for an answer lives - the light on the top bar points at it. Casting and This
// host are things set up once, so they sit below.
const SETTINGS_SECTIONS = [
  ['library', 'Library'],
  ['sharing', 'Sharing'],
  // WHO CAN REACH THIS LIBRARY, beside who else's libraries this machine reaches -
  // the two pages about other people sit together (Tim, 2026-08-20). It was its own
  // tab until then; the topbar keeps its icon as a shortcut straight here, so the
  // live dot and one-press revoke both survive the move.
  ['people', 'People'],
  ['casting', 'Casting'],
  ['host', 'This host'],
  ['support', 'Support development']
]

// PAGES THAT WENT SOMEWHERE ELSE. A section that moves must not turn every link and
// bookmark to it into a silent fall back to the first page - which is what an unknown
// section did. The topbar's download indicator points at the old remotes address, so
// this is load-bearing inside the app and not only for bookmarks.
const MOVED_SECTIONS = {
  security: 'host',
  // '#who' was a TAB rather than a section, so this entry is what keeps an old
  // bookmark - or the topbar icon of an older build - landing on the page it names.
  who: 'people',
  source: 'library',
  artwork: 'library',
  televisions: 'casting',
  remotes: 'sharing'
}

// The hash names the page - #settings/source opens Settings on Source - so a
// section is linkable, refreshable and reachable by anything that can only
// load a URL (a bookmark, a support reply, a headless screenshot).
const hashParts = () => String(location.hash || '').replace(/^#/, '').split('/')

// Somebody else's libraries (proposal 2026-08-16-desktop-client): paste the
// pairing link from their dashboard - the QR always carries its link underneath
// for machines without a camera - and their films play in these same pages.
function RemotePanel ({ remotes, reload, onSource, source, embedded = false }) {
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
    <div class={embedded ? '' : 'card'}>
      {!embedded && <h3>Remote libraries</h3>}

      {/* SAID ONLY WHERE IT IS ANY USE. With libraries on the list, the rows are the
          explanation; without any, this is the whole page. */}
      {remotes.length === 0 && (
        <p class='hint'>
          Watch a library on somebody else's server. Ask them to open a pairing window
          on their dashboard and send you the link under the code.
        </p>
      )}

      {remotes.length > 0 && (
        <div class='setrows'>
          {remotes.map(r => (
            <div class='setrow' key={r.hostKey}>
              <span class='rowmain'>
                {/* Online or not is the row's whole condition, so the name carries it -
                    and the line below says it in words. */}
                <span class={'rowname ' + (r.online ? 'good' : 'warn')}>{r.libraryName || 'Library'}</span>
                <span class='rowsub'>
                  {r.online ? 'Online' : 'Offline'}
                  {source === r.libraryId ? ' · the one you are watching' : ''}
                </span>
              </span>
              {/* NO WATCH BUTTON. Which library you are looking at is the picker in the
                  header bar, on every screen, and a second way to do it on this page was
                  a control that duplicated one (Tim, 2026-08-19). Removing a library is
                  the only thing this row decides. */}
              <span class='rowctl'>
                <button
                  class='iconbtn danger' onClick={() => remove(r)}
                  aria-label={`Remove ${r.libraryName || 'this library'}`} title='Remove'
                ><Trash size={17} /></button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div class='rowopen'>
        <div class='field'>
          <label>Pairing link</label>
          <input
            type='text' value={link} placeholder='pear://pearcinema/pair?...'
            onInput={e => setLink(e.currentTarget.value)}
          />
        </div>
        {err && <p class='error'>{err}</p>}
        <div class='actions'>
          <button onClick={pair} disabled={busy || !link.trim()}>{busy ? 'Pairing…' : 'Pair'}</button>
        </div>
      </div>
    </div>
  )
}

// Films kept on this machine from friends' libraries (phase 2). Hidden until
// there is one - an empty downloads card is a feature announcement, and the
// place downloads are discovered is the player's details sheet.
function DownloadsCard ({ remotes, onPlay, embedded = false }) {
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
  // AN EMPTY GROUP STILL NEEDS A LINE. This used to hide itself entirely, and the
  // reasoning held while it was a card that would otherwise appear out of nowhere - an
  // empty downloads card is a feature announcement. Under a heading that is already on
  // screen it leaves the heading standing over nothing, which reads as broken (Tim,
  // 2026-08-19).
  if (!items?.length) {
    return embedded
      ? <p class='hint'>Nothing kept on this machine yet.</p>
      : null
  }
  const nameOf = (lib) => remotes.find(r => r.libraryId === lib)?.libraryName || 'a library'
  return (
    <div class={embedded ? '' : 'card'}>
      {!embedded && <h3>Downloads</h3>}
      <p class='hint'>These play here even while the library they came from is offline.</p>
      <div class='setrows'>
        {items.map(d => (
          <div class='setrow' key={d.itemId}>
            <span class='rowmain'>
              <span class='rowname'>{d.title || 'Untitled'}</span>
              {d.downloading
                ? (
                  <span class='rowsub dlline'>
                    <span class='meter dlmeter'>
                      <i style={`width:${d.size ? Math.min(99, Math.round((d.got / d.size) * 100)) : 0}%`} />
                    </span>
                    <span>
                      {d.size ? Math.min(99, Math.round((d.got / d.size) * 100)) : 0}%{d.converting ? ' · being converted' : ''}
                    </span>
                  </span>
                  )
                : <span class='rowsub'>{fmtSize(d.size)} · from {nameOf(d.lib)}</span>}
            </span>
            <span class='rowctl'>
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
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Your open asks, per remote library (phase 2) - made from an empty search on
// a friend's library, watched and withdrawn here. Hidden until there is one.
function RequestsCard ({ remotes, embedded = false }) {
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
  if (!rows?.length) {
    return embedded
      ? <p class='hint'>You have not asked for anything yet. Search a friend's library for something it does not have.</p>
      : null
  }
  return (
    <div class={embedded ? '' : 'card'}>
      {!embedded && <h3>Your requests</h3>}
      <div class='setrows'>
        {rows.map(q => (
          <div class='setrow' key={q.lib + q.id}>
            <span class='rowmain'>
              {/* Answered is green, refused is amber, still waiting is neither - and
                  the word is right there either way. */}
              <span class={'rowname ' + (q.status === 'granted' ? 'good' : q.status === 'refused' ? 'warn' : '')}>{q.name}</span>
              <span class='rowsub'>
                {q.status} · {q.kind === 'series' ? 'show' : 'film'} · {q.libraryName || 'a library'}
              </span>
            </span>
            <span class='rowctl'>
              {q.status === 'pending' && (
                <button
                  class='iconbtn danger' aria-label={`Withdraw your request for ${q.name}`} title='Withdraw'
                  onClick={async () => { await api(`/remote/${q.lib}/api/request/remove`, { id: q.id }); setTick(t => t + 1) }}
                ><Trash size={17} /></button>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// WHAT PEOPLE HAVE ASKED THIS LIBRARY FOR, which had nowhere to appear until now.
// RequestsCard above is the other direction - what this machine asked somebody else's
// library for - and the two were easy to conflate because they are both "requests".
//
// The store and the wire have both had the owner's view all along (listRequests with
// no requester, and `request.all`); only the dashboard never asked. Tim made requests
// from a paired phone on 2026-08-19 and found nowhere they could show up.
function ReceivedCard ({ embedded = false }) {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    const r = await api('/api/asked').catch(() => null)
    setRows(r?.items || [])
  }, [])

  useEffect(() => {
    load()
    // The same live channel the outgoing card uses: an ask arriving from a phone
    // should land on an open page rather than waiting for a reload.
    const off = onLive(['request:created', 'request:removed', 'request:resolved'], load)
    return off
  }, [load])

  // ANSWERED IN PLACE. This used to refetch the whole list and raise a notification,
  // so answering one row redrew the page and threw a modal over it (Tim, 2026-08-19).
  // The row it changed is the only thing that changes.
  const answer = async (q, status) => {
    setBusy(q.id)
    const r = await api('/api/asked/resolve', { id: q.id, status })
    setBusy('')
    if (r?.error) return notify('Not saved', r.error)
    setRows((rs) => (rs || []).map((x) => (x.id === q.id ? { ...x, ...(r.request || { status }) } : x)))
  }

  const forget = async (q) => {
    setBusy(q.id)
    const r = await api('/api/asked/remove', { id: q.id })
    setBusy('')
    if (r?.error) return notify('Not removed', r.error)
    setRows((rs) => (rs || []).filter((x) => x.id !== q.id))
  }

  if (!rows?.length) {
    return embedded
      ? <p class='hint'>Nobody has asked you for anything yet.</p>
      : null
  }

  // Sentence case, because a sub-line is a sentence and these were coming straight
  // off the wire in the store's own lowercase vocabulary (Tim, 2026-08-19).
  const said = { pending: 'Waiting for you', added: 'Added', declined: 'Declined' }

  return (
    <div class={embedded ? '' : 'card'}>
      {!embedded && <h3>Asked of you</h3>}
      <div class='setrows'>
        {rows.map(q => (
          <div class='setrow' key={q.id}>
            <span class='rowmain'>
              <span class={'rowname ' + (q.status === 'added' ? 'good' : q.status === 'declined' ? 'warn' : '')}>
                {q.name || 'Untitled'}
              </span>
              <span class='rowsub'>
                {said[q.status] || q.status}
                {' · '}{q.kind === 'series' ? 'Show' : 'Film'}
                {q.requesterLabel ? ` · asked by ${q.requesterLabel}` : ''}
                {q.count > 1 ? ` · asked ${q.count} times` : ''}
              </span>
            </span>
            <span class='rowctl'>
              {q.status === 'pending'
                ? (
                  <>
                    {/* A TICK AND A CROSS, the one icon pair nobody has to interpret.
                        Both carry their words to a screen reader and to a tooltip. */}
                    <button
                      class='iconbtn primary' disabled={busy === q.id}
                      aria-label={`Mark ${q.name || 'this'} as added`} title='Added it'
                      onClick={() => answer(q, 'added')}
                    ><Check size={18} /></button>
                    <button
                      class='iconbtn danger' disabled={busy === q.id}
                      aria-label={`Decline the request for ${q.name || 'this'}`} title='Decline'
                      onClick={() => answer(q, 'declined')}
                    ><Close size={17} /></button>
                  </>
                  )
                : (
                  <button
                    class='iconbtn' disabled={busy === q.id}
                    aria-label={`Clear the request for ${q.name || 'this'}`} title='Clear from this list'
                    onClick={() => forget(q)}
                  ><Trash size={17} /></button>
                  )}
            </span>
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

// Discovered by this host rather than configured in Home Assistant. Both discovery
// backends mint their own `via`, and anything else came through HA.
const isFound = (t) => ['roku', 'dlna'].includes(t.via)

// A television's name says its condition, the same rule This host follows: green when
// it is ready or playing, amber when it is switched off or asleep and there is nothing
// to do about it from here, muted when it is hidden and will not be offered at all.
// COLOUR IS NEVER THE ONLY CARRIER - readableState puts the same fact in words on the
// line below.
// A capability profile in words. Containers as somebody would name a file and codecs
// as the box they bought calls them - "H.264" rather than "h264".
const CONTAINER_WORDS = { mp4: 'MP4', mov: 'MOV', matroska: 'MKV', mkv: 'MKV', webm: 'WebM' }
const CODEC_WORDS = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', mpeg4: 'MPEG-4' }

function joinWords (list) {
  if (list.length < 2) return list[0] || ''
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]
}

function saysItPlays (accepts) {
  const seen = new Set()
  const containers = []
  for (const c of accepts.containers || []) {
    const w = CONTAINER_WORDS[c] || c.toUpperCase()
    if (!seen.has(w)) { seen.add(w); containers.push(w) }
  }
  const codecs = (accepts.videoCodecs || []).map(c => CODEC_WORDS[c] || c.toUpperCase())
  const parts = []
  if (containers.length) parts.push(joinWords(containers))
  if (codecs.length) parts.push(`in ${joinWords(codecs)}`)
  return parts.join(', ')
}

function toneFor (t) {
  if (t.hidden) return 'dim'
  if (!isReachable(t)) return 'warn'
  return 'good'
}

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
  // FOUND ON THE WIRE IS TWO ROUTES NOW, not one. Written when a Roku was the only
  // thing this host discovered by itself, these counted every DLNA television as one
  // of Home Assistant's - so the network row said "1 television found" over a list of
  // two it had found, and the Home Assistant row claimed a set it has never heard of.
  const viaHa = rows.filter(t => !isFound(t))
  const found = rows.filter(t => isFound(t))
  const anyOff = rows.some(t => !isReachable(t))
  const haStatus = cfg?.tokenSet && cfg?.enabled
    ? `connected${viaHa.length ? `, ${viaHa.length} media player${viaHa.length === 1 ? '' : 's'}` : ''}`
    : 'not set up'

  return (
    <>
      <div class='setpage'><span class='setpagename'>Casting</span></div>

      {/* THE ROUTES COME FIRST (Tim, 2026-08-19). They are the settings on this page -
          the televisions themselves are the RESULT of them - and a result reads better
          under the thing that produced it. Which is also why the list now carries a
          label of its own: sitting unlabelled below "How they are found" it would read
          as part of it. */}
      <div class='setgroup'>How they are found</div>

      <div class='setrows'>
        <div class='setrow'>
          <span class='rowmain'>
            <span class='rowname'>On your network</span>
            <span class='rowsub'>
              {found.length === 0
                ? 'Nothing found yet.'
                : `${found.length} television${found.length === 1 ? '' : 's'} found.`}
            </span>
          </span>
          <span class='rowctl'>
            <button class='ghost' onClick={rescan} disabled={busy}>Look again</button>
          </span>
        </div>

        <div class='setrow'>
          <span class='rowmain'>
            <span class='rowname'>Home Assistant</span>
            <span class='rowsub'>
              {cfg?.tokenSet && cfg?.enabled
                ? `Connected${viaHa.length ? `, ${viaHa.length} media player${viaHa.length === 1 ? '' : 's'}` : ''}.`
                : 'Not set up. Only needed for a television your server cannot find on its own.'}
            </span>
          </span>
          <span class='rowctl'>
            <button class='ghost' onClick={() => setHaOpen(!haOpen)} disabled={!cfg}>
              {haOpen ? 'Hide' : (cfg?.tokenSet ? 'Change' : 'Set up')}
            </button>
          </span>
        </div>
      </div>

      {/* FOLDED, like every other panel a row opens (2026-08-20). It stays in the
          page so it can animate on the way out as well as in. */}
      <div class={'rowfold' + (haOpen && cfg ? ' on' : '')} aria-hidden={!(haOpen && cfg)}>
       <div class='rowfold-in'>
        {cfg && (
        <div class='rowopen'>
          <p class='hint'>Make a long-lived access token on your Home Assistant profile page.</p>
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
        </div>
        )}
       </div>
      </div>

      {/* WHERE YOU CAN CAST, not "your televisions": the same list holds the speakers
          Home Assistant knows about, and one of those is not a television. */}
      <div class='setgroup'>Where you can cast</div>

      {/* THE WAIT BELONGS TO THE LIST, so it waits where the list will be (Tim,
          2026-08-19). Above the routes it read as the whole page loading. */}
      {targets === null && (
        <div class='waiting'>
          <Spinner size={34} class='spin' />
          <span>Looking for televisions…</span>
        </div>
      )}

      {/* SHORT, AND ONLY ON AN EMPTY LIST. This was four lines of prose - the longest
          block left on any Settings page - for a situation most people are never in.
          The Media Assistant fact stays because nobody could guess it; the rest of the
          explanation was the page describing itself. */}
      {targets !== null && rows.length === 0 && (
        <p class='hint'>
          None yet. Your server finds televisions on its own network, and a Roku also
          needs the free {mediaChannel} channel installed on it.
        </p>
      )}

      {rows.length > 0 && (
        <div class='setrows'>
          {rows.map(t => (
            <div class='setrow' key={t.entityId}>
              <span class='rowmain'>
                {/* THE NAME CARRIES THE STATE, the same way the video engine's does on
                    This host - and the words are in the line below, so nobody has to
                    tell green from amber to read the row. */}
                <span class={'rowname ' + toneFor(t)}>{t.name}</span>
                {/* ONE CLAUSE. The state, and then only what is unusual about this
                    television: that it came through Home Assistant rather than being
                    found, or that it is a speaker rather than a screen. Being hidden is
                    not said at all - the eye beside it is already saying it. */}
                <span class='rowsub'>
                  {readableState(t)}
                  {/* FOUND ON THE WIRE OR CONFIGURED, and there are two ways to be found
                      now. This read `via !== 'roku'`, from when there was one, so every
                      television discovered over DLNA claimed to have come through Home
                      Assistant - software its owner may not even have. */}
                  {isFound(t) ? '' : ' · via Home Assistant'}
                  {t.deviceClass && t.deviceClass !== 'tv' ? ` · ${t.deviceClass}` : ''}
                </span>
                {/* WHAT THE TELEVISION ITSELF SAID, asked at discovery and answered in
                    its own words. It is the honest answer to "will my films play on
                    this", and it is what stops a profile measured on one Samsung being
                    every DLNA set's profile - so it belongs on screen rather than only
                    in the decision it feeds. */}
                {t.accepts && <span class='rowsub'>Says it plays {saysItPlays(t.accepts)}.</span>}
              </span>
              <span class='rowctl'>
                <button
                  class='iconbtn'
                  disabled={busy}
                  onClick={() => toggleHidden(t)}
                  aria-label={t.hidden ? `Offer ${t.name} when casting` : `Stop offering ${t.name} when casting`}
                  title={t.hidden ? 'Offer this one' : 'Hide from phones'}
                >
                  {t.hidden ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </span>
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

    </>
  )
}

// WHAT A RUNNING SCAN SAYS, in one clause, in two places: the Rescan row and the top
// bar's light. The total is discovered as the walk goes, so it is 0 for the first
// moments of a scan and the sentence has to work without it.
function scanLine (s) {
  if (!s) return ''
  if (!s.total) return 'Reading the library now.'
  return `Reading the library, ${s.done} of ${s.total}.`
}

// THE COLLECTION, in one page. Source, Artwork and Library were three nav items for
// one subject, and two of them held a single control each.
//
// WHAT THE PICKER IS, and why it is behind a button now. SourcePanel is a small app
// rather than a setting: a folder browser, a roots editor with a type per folder, a
// Jellyfin form, Test and Save. Left open it was the whole page, on a page people
// mostly open to check something. So where the films are is a ROW - what it is, how
// many films it found - and Change opens the app in a window of its own, which is the
// rule this page follows: a small edit happens where you are (the TMDB key), a job
// with steps in it gets a window. The picker itself is untouched: the
// typed-path-inside-the-container trap it was built around is that panel's founding
// scar, not something to reshape casually.
//
// RESCANNING CAME OUT WITH IT, and had to. It is what you came for when a film you
// just copied in is missing, and burying it inside a disclosure would mean opening the
// editor to press a button that has nothing to do with editing. It is two rows: the
// one that runs now, and the schedule.
//
// THE BANNERS STAY AT THE TOP, above everything. A source that has stopped answering
// is the one thing nobody should have to open anything to hear.
function LibraryPanel ({ state, reload }) {
  const [name, setName] = useState(state.library || '')
  const src = state.source || { kind: 'empty' }
  const empty = src.kind === 'empty'
  // NOT OPENED FOR YOU. It was, while the editor lived inside the page - with nothing
  // set there was nothing else on the page for it to be in the way of. A window is
  // different: one that throws itself over the page the moment you arrive is a window
  // you close before you read anything.
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  const saveName = async () => {
    const res = await api('/api/library', { name })
    if (res.error) return notify('Not renamed', res.error)
    await reload()
    notify('Renamed', 'Every paired phone relabels straight away.')
  }

  // It answers at once now and the work carries on behind it, so there is nothing to
  // wait for here - the row below says what is happening, and so does the top bar from
  // wherever you are in the app.
  const rescan = async () => {
    setBusy(true)
    const res = await api('/api/source/rescan', {})
    setBusy(false)
    if (res.error) return notify('Rescan failed', res.error)
    reload()
  }

  // WHERE THE FILMS ARE, in one line: what kind of place it is, and what was found in
  // it. The counts belong on this row rather than in a paragraph under the picker -
  // they are the answer to the question the row asks.
  const roots = src.roots || []
  const place = empty
    ? ''
    : src.kind === 'jellyfin'
      ? `Jellyfin at ${(src.url || '').replace(/^https?:\/\//, '') || 'a server'}`
      : `${roots.length} folder${roots.length === 1 ? '' : 's'} on this machine`

  const sourceSub = empty
    ? 'Nothing set yet. Point this at a folder of films or a Jellyfin server.'
    : state.sourceError
      ? `${place} · not answering`
      : `${place} · ${describeSource(state.stats || {})}`

  const sourceTone = empty || state.sourceError ? 'warn' : 'good'

  const every = Number(state.rescanIntervalMin) || 0
  const autoSub = {
    0: 'Off. New films appear only when you rescan.',
    15: 'Every 15 minutes.',
    30: 'Every 30 minutes.',
    60: 'Every hour.',
    360: 'Every 6 hours.'
  }[every] || `Every ${every} minutes.`

  return (
    <>
      <div class='setpage'><span class='setpagename'>Library</span></div>

      <SourceBanners state={state} />

      <div class='setrows'>
        <div class='setrow'>
          <span class='rowmain'>
            <span class='rowname'>Name</span>
            <span class='rowsub'>What a paired phone calls this library.</span>
          </span>
          <span class='rowctl'>
            <input
              type='text' value={name} maxLength={64}
              aria-label="This library's name"
              onInput={e => setName(e.currentTarget.value)}
              onBlur={() => { if (name.trim() && name !== state.library) saveName() }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            />
          </span>
        </div>

        <div class='setrow'>
          <span class='rowmain'>
            <span class={'rowname ' + sourceTone}>Where the films are</span>
            <span class='rowsub'>{sourceSub}</span>
          </span>
          <span class='rowctl'>
            {/* It said Cancel while the editor was open, which was right when the
                editor unfolded inside the page. A window has its own way out, and a
                second one on the row behind it is a button nobody can see anyway. */}
            <button class='ghost' onClick={() => setEditing(true)}>
              {empty ? 'Set up' : 'Change'}
            </button>
          </span>
        </div>

        {editing && (
          <SourcePanel
            state={state} reload={reload} editor
            onSaved={() => setEditing(false)}
            onClose={() => setEditing(false)}
          />
        )}

        {!empty && (
          <div class='setrow'>
            <span class='rowmain'>
              <span class={'rowname ' + (state.scanning ? 'warn' : '')}>Rescan</span>
              {/* THE STATE IS IN THE LINE, NOT IN THE BUTTON (Tim, 2026-08-19). A button
                  whose word changes to "Rescanning…" grows wider than every other button
                  on the page, and it was the only thing saying anything at all - so a
                  scan that takes minutes looked identical to one that had wedged. */}
              <span class='rowsub'>
                {state.scanning
                  ? scanLine(state.scanning)
                  : 'Looks for films added or removed.'}
                {state.scanning?.total > 0 && (
                  <span class='meter' style='margin-left:.5rem'>
                    <i style={`width:${Math.round((state.scanning.done / state.scanning.total) * 100)}%`} />
                  </span>
                )}
              </span>
            </span>
            <span class='rowctl'>
              <button class='ghost' onClick={rescan} disabled={busy || !!state.scanning}>Rescan</button>
            </span>
          </div>
        )}

        {!empty && (
          <div class='setrow'>
            <span class='rowmain'>
              <span class='rowname'>Automatic rescan</span>
              <span class='rowsub'>{autoSub}</span>
            </span>
            {/* IT COMMITS ITSELF. A schedule with a Save button beside it is a schedule
                people set and do not save. */}
            <span class='rowctl'>
              <select
                value={every}
                aria-label='How often the library rechecks itself'
                onChange={async e => {
                  const minutes = Number(e.currentTarget.value)
                  const res = await api('/api/rescan-interval', { minutes })
                  if (res?.error) return notify('Not set', res.error)
                  reload()
                }}
              >
                <option value={0}>Off</option>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
                <option value={360}>6 hours</option>
              </select>
            </span>
          </div>
        )}
      </div>

      <div class='setgroup'>Artwork</div>
      <Metadata rows />
    </>
  )
}

function Settings ({ state, reload, remotes = [], onSource = () => {}, source = '', onPlayDownload = () => {} }) {
  const resolveSection = (t, s) => {
    if (t !== 'settings') return null
    if (SETTINGS_SECTIONS.some(([id]) => id === s)) return s
    return MOVED_SECTIONS[s] || null
  }
  // 'library' IS THE FIRST PAGE, and this fallback has to move with the nav: it read
  // 'source' after the five-page consolidation, which is not a section any more, so
  // opening Settings with no hash rendered an empty page.
  const [sec, setSec] = useState(() => resolveSection(...hashParts()) || SETTINGS_SECTIONS[0][0])
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
  return (
    <div class='settings'>
      <nav class='setnav' aria-label='Settings sections'>
        {SETTINGS_SECTIONS.map(([id, label]) => (
          <button key={id} class={sec === id ? 'on' : ''} onClick={() => { setSec(id); location.hash = 'settings/' + id }}>{label}</button>
        ))}
      </nav>

      <div class='setbody'>
        {sec === 'library' && <LibraryPanel state={state} reload={reload} />}

        {sec === 'sharing' && (
          <>
            <div class='setpage'><span class='setpagename'>Sharing</span></div>
            <RemotePanel remotes={remotes} reload={reload} onSource={onSource} source={source} embedded />
            <div class='setgroup'>Downloads</div>
            <DownloadsCard remotes={remotes} onPlay={onPlayDownload} embedded />
            <div class='setgroup'>Asked of you</div>
            <ReceivedCard embedded />
            <div class='setgroup'>Your requests</div>
            <RequestsCard remotes={remotes} embedded />
          </>
        )}

        {sec === 'people' && <People state={state} reload={reload} />}

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

        <div class={'rowfold' + (pwOpen && ownPassword ? ' on' : '')} aria-hidden={!(pwOpen && ownPassword)}>
         <div class='rowfold-in'>
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
         </div>
        </div>

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
  // DECLARED, WHICH IT WAS NOT. `copied` and `setCopied` were used and never created,
  // so this page threw "copied is not defined" the moment the rails arrived and took
  // the whole app down with it - the same shape as the three temporal-dead-zone
  // crashes of 2026-08-17, and invisible to every test in the suite because they all
  // assert on text and this page had none of its own (found 2026-08-19, rebuilding it).
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

  // NO CARD AROUND A PAGE, which is the one Ledger rule this page still broke: it
  // named itself inside a box, so the title sat in a container the other four pages do
  // not have. What it does NOT become is a list of rows - it is a QR code somebody
  // points a phone at, and rows are for settings.
  return (
    <>
      <div class='setpage'><span class='setpagename'>Support development</span></div>
      <p class='hint center'>
        No accounts, no servers, no subscriptions. If PearCinema is useful to you, a tip
        helps keep it free, and it is entirely optional.
      </p>
      {/* WHICH ONE, AND WHICH ONE WE PREFER. Two of the three rails are Bitcoin and
          nothing on the page said so - "Lightning" and "On-chain" are only obvious to
          somebody who already knows what they are (Tim, 2026-08-19). */}
      <p class='hint center'>
        <b>Bitcoin is preferred</b>, over Lightning for a small amount or on-chain for a
        larger one. A card works too.
      </p>
      <div class='seg' style='max-width:22rem;margin:1.5rem auto .9rem'>
        <button class={tab === 'ln' ? 'on' : ''} onClick={() => { setTab('ln'); setCopied(false) }}>Lightning</button>
        <button class={tab === 'onchain' ? 'on' : ''} onClick={() => { setTab('onchain'); setCopied(false) }}>On-chain</button>
        <button class={tab === 'usd' ? 'on' : ''} onClick={() => { setTab('usd'); setCopied(false) }}>Card</button>
      </div>
      {rails === null && (
        <div class='waiting'>
          <Spinner size={34} class='spin' />
          <span>Loading…</span>
        </div>
      )}
      {rails && !rail && <p class='hint center'>That one is not set up on this host.</p>}
      {rail && (
        <>
          <div class='donate-qr' dangerouslySetInnerHTML={{ __html: rail.svg }} />
          <div class='donate-cap'>{rail.caption}</div>
          <div class='donate-addr'>{rail.value}</div>
          {/* One word per button and both the same width, like every other action row.
              "Open ↗" was an arrow doing nothing a word was not already doing. */}
          <div class='actions'>
            <button class='ghost' onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            {tab === 'usd' && (
              <button onClick={() => window.open(rail.value, '_blank', 'noopener')}>Open</button>
            )}
          </div>
        </>
      )}
    </>
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
    // '#who' used to be a tab of its own. It is a Settings page now, so the old
    // address opens Settings there rather than silently landing on the library.
    if (t === 'who') { location.hash = 'settings/people'; return 'settings' }
    return ['watch', 'settings'].includes(t) ? t : 'watch'
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
  // Unanswered requests. COUNTED BY THE SHELL rather than by the panel that lists
  // them: the panel only exists on the Sharing page, so a light that waited for it
  // would appear only once you had already gone looking.
  const [pendingAsks, setPendingAsks] = useState(0)
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
  useEffect(() => {
    let live = true
    const count = async () => {
      const r = await api('/api/asked').catch(() => null)
      if (live) setPendingAsks((r?.items || []).filter(q => q.status === 'pending').length)
    }
    count()
    const off = onLive(['request:created', 'request:removed', 'request:resolved'], count)
    return () => { live = false; off() }
  }, [])

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

  // AND FASTER WHILE SOMETHING IS COUNTING. Eight seconds is right for a roster that
  // changes when somebody pairs; it is wrong for a progress bar, which reads as stuck
  // between ticks. Only while a scan runs, and it stops the moment it ends.
  useEffect(() => {
    if (!state?.scanning) return
    const t = setInterval(reload, 2000)
    return () => clearInterval(t)
  }, [!!state?.scanning])

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
              onClick={() => { location.hash = 'settings/sharing'; setTab('settings'); setPlaying(null) }}
            >
              <DownloadIcon size={18} />
              <span class='dot' aria-hidden='true' />
            </button>
          )}

          {/* THE LIBRARY IS BEING READ (Tim, 2026-08-19), the same shape the downloads
              light uses. A rescan of the real library is minutes of work that used to
              show as a button stuck on "Rescanning…" on one page - so it is a light on
              the bar from anywhere in the app, and pressing it goes to the row that
              says how far through it is. */}
          {state.scanning && (
            <button
              class='iconbtn dlbusy'
              aria-label={'Reading the library. ' + scanLine(state.scanning)}
              title={scanLine(state.scanning)}
              onClick={() => { location.hash = 'settings/library'; setTab('settings'); setPlaying(null) }}
            >
              <Spinner size={18} class='spin' />
              <span class='dot' aria-hidden='true' />
            </button>
          )}

          {/* SOMEBODY IS WAITING FOR AN ANSWER (Tim, 2026-08-19), the same shape the
              downloads light uses: a bar-level mark while any request is unanswered,
              one press from the page that answers it. An ask that nobody notices is an
              ask that never gets answered. */}
          {pendingAsks > 0 && (
            <button
              class='iconbtn dlbusy'
              aria-label={pendingAsks === 1 ? 'One request waiting for an answer' : pendingAsks + ' requests waiting for an answer'}
              title={pendingAsks === 1 ? 'One request waiting' : pendingAsks + ' requests waiting'}
              onClick={() => { location.hash = 'settings/sharing'; setTab('settings'); setPlaying(null) }}
            >
              <Bell size={18} />
              <span class='dot' aria-hidden='true' />
            </button>
          )}
          <button
            class='iconbtn'
            onClick={() => { location.hash = 'settings/people'; setTab('settings'); setPlaying(null) }}
            aria-label='People and devices'
            title={online ? `People and devices - ${online} online` : 'People and devices'}
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
