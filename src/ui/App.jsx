// The PearCinema phone UI, in PearTune's form. Five tabs on a bottom nav -
// Library, You, Watchlist, Settings, About - PearTune's shell copied as close
// as the vocabulary allows (Tim, 2026-08-14: near one-for-one, minor changes
// only where a film app genuinely differs from a music app). The donor's
// stylesheet rides along verbatim, so the classes here ARE its classes.
//
// What is PearCinema's own and must not regress: the native player handoff
// (shell.play), the resume offer, the lying-chip retry, the pairing overlay
// with the scanner, and the watch-state heartbeats. Runtimes are SECONDS,
// positions MILLISECONDS, the suite convention.

import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import jsQR from 'jsqr'
import {
  FilmStrip, Heart, BookmarkSimple, Gear, Info, X, Play,
  CheckCircle, DownloadSimple, UsersThree, EnvelopeSimple, CaretLeft, Plus,
  QrCode, Trash, ArrowsLeftRight, SignOut, ShareNetwork, GithubLogo,
  Lightning, Coffee, EnvelopeOpen, CaretRight, SlidersHorizontal
} from '@phosphor-icons/react'
import { call, on } from './bridge'
import { loadThemePref, applyThemePref, onSystemThemeChange } from './theme'

const APP_VERSION = '0.1.0'
const LIGHTNING_ADDRESS = 'peerloomllc@strike.me'
const STRIKE_TIP_URL = 'https://strike.me/peerloomllc/'
const BUYMEACOFFEE_URL = 'https://buymeacoffee.com/peerloomllc'
const GITHUB_URL = 'https://github.com/peerloomllc/pearcinema'
const CONTACT_EMAIL = 'peerloomllc@proton.me'
const SHARE_TEXT = 'PearCinema - your films and TV, from your own machine or a friend\'s, playable anywhere. No port forwarding, no VPN, no account.\n\nhttps://peerloomllc.com/'

const fmtRuntime = (s) => {
  const n = Number(s) || 0
  if (!n) return ''
  const h = Math.floor(n / 3600); const m = Math.round((n % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

// Exact, not rounded - somebody deciding whether to resume is looking for the
// moment they stopped (the dashboard's rule).
const fmtClock = (ms) => {
  const s = Math.floor((Number(ms) || 0) / 1000)
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60)
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s % 60).padStart(2, '0')
}

// Tap vs hold, the donor's shape: a hold opens the action sheet, a tap opens
// the thing.
function usePress (onPress, onLongPress) {
  const timer = useRef(null)
  const fired = useRef(false)
  const start = () => {
    fired.current = false
    if (onLongPress) timer.current = setTimeout(() => { fired.current = true; onLongPress() }, 450)
  }
  const stop = (go) => {
    clearTimeout(timer.current)
    if (go && !fired.current) onPress?.()
  }
  return {
    onPointerDown: start,
    onPointerUp: () => stop(true),
    onPointerLeave: () => stop(false),
    onPointerCancel: () => stop(false),
    onContextMenu: (e) => e.preventDefault()
  }
}

// The donor's avatar pipeline: any picked image becomes a small square jpeg
// before it ever leaves the phone, so a 12 MP photo costs ~25 KB on the wire.
function readFileDataUrl (file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('could not read that file'))
    r.readAsDataURL(file)
  })
}

async function compressToAvatarB64 (dataUrl, size = 256) {
  const img = new Image()
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = () => reject(new Error('not an image'))
    img.src = dataUrl
  })
  const c = document.createElement('canvas')
  c.width = size; c.height = size
  const ctx = c.getContext('2d')
  const s = Math.min(img.width, img.height)
  ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size)
  return c.toDataURL('image/jpeg', 0.82).split(',')[1]
}

// The donor's collapsible settings section, one open at a time.
function Section ({ id, title, Icon, open, onToggle, children }) {
  return (
    <div className='card tight acc'>
      <button onClick={() => onToggle(id)} aria-expanded={open}>
        <span className='accleft'>
          <Icon size={17} weight='regular' />
          {title}
        </span>
        <CaretRight size={15} weight='regular' className={'caret' + (open ? ' open' : '')} />
      </button>
      <div className={'body' + (open ? ' open' : '')}>
        <div className='inner'>{children}</div>
      </div>
    </div>
  )
}

const TABS = [
  { key: 'library', label: 'Library', Icon: FilmStrip },
  { key: 'you', label: 'You', Icon: Heart },
  { key: 'watchlist', label: 'Watchlist', Icon: BookmarkSimple },
  { key: 'settings', label: 'Settings', Icon: Gear },
  { key: 'about', label: 'About', Icon: Info }
]

function NavBar ({ active, onTab, saved = 0 }) {
  return (
    <nav className='navbar'>
      {TABS.map(({ key, label, Icon }) => {
        const onNow = active === key
        const badge = key === 'watchlist' && saved > 0 ? saved : null
        return (
          <button
            key={key} className={onNow ? 'on' : ''} onClick={() => onTab(key)}
            aria-current={onNow ? 'page' : undefined} aria-label={label}
          >
            <span className='ic'>
              <Icon size={22} weight={onNow ? 'fill' : 'regular'} />
              {badge && <span className='badge'>{badge > 99 ? '99+' : badge}</span>}
            </span>
            <span>{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

function Cover ({ src, title }) {
  return (
    <div className='cover'>
      {src ? <img src={src} loading='lazy' alt='' /> : <span className='blank'>{(title || '?').slice(0, 2)}</span>}
    </div>
  )
}

function Tile ({ item, artBase, saved, onOpen, onLong, onSave }) {
  const press = usePress(() => onOpen(item), () => onLong(item))
  return (
    <div className='album'>
      {onSave && (
        <button
          className={'tileheart' + (saved ? ' on' : '')}
          aria-label={saved ? 'Remove from watchlist' : 'Add to watchlist'}
          onClick={(e) => { e.stopPropagation(); onSave(item) }}
        >
          <BookmarkSimple size={16} weight={saved ? 'fill' : 'bold'} />
        </button>
      )}
      <div {...press}>
        <Cover src={item.artId && artBase ? `${artBase}${encodeURIComponent(item.artId)}?s=350` : null} title={item.title} />
        <div className='t'>{item.title}</div>
        <div className='sub'>{[item.year, fmtRuntime(item.runtime)].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  )
}

function Grid ({ items, artBase, savedSet, onOpen, onLong, onSave, cols = 2 }) {
  return (
    <div className='grid' style={{ '--cols': cols }}>
      {items.map((i) => (
        <Tile
          key={i.id} item={i} artBase={artBase}
          saved={savedSet?.has(i.id)} onOpen={onOpen} onLong={onLong} onSave={onSave}
        />
      ))}
    </div>
  )
}

function ItemRow ({ item, sub, onOpen, onLong, right = null }) {
  const press = usePress(() => onOpen(item), onLong ? () => onLong(item) : null)
  return (
    <li className='track' {...press}>
      <div className='meta'>
        <div className='t'>{item.title}</div>
        {sub && <div className='sub muted sm'>{sub}</div>}
      </div>
      {right}
    </li>
  )
}

function ActionSheet ({ item, saved, watched, onClose, onPlay, onSave, onWatched }) {
  const playable = item.type === 'movie' || item.type === 'episode'
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={(e) => e.stopPropagation()}>
        <h3>{item.title}</h3>
        <div className='acts'>
          {playable && <button onClick={() => { onClose(); onPlay(item) }}><Play size={18} /> Play</button>}
          <button onClick={() => { onClose(); onSave(item) }}>
            <BookmarkSimple size={18} /> {saved ? 'Remove from watchlist' : 'Add to watchlist'}
          </button>
          <button onClick={() => { onClose(); onWatched(item, !watched) }}>
            <CheckCircle size={18} /> {watched ? 'Mark unwatched' : 'Mark watched'}
          </button>
          <button className='ghost' onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function Scanner ({ onScan, onCancel }) {
  const video = useRef(null)
  const canvas = useRef(null)
  const [msg, setMsg] = useState('Point at the pairing code')

  useEffect(() => {
    let stream = null
    let raf = null
    let done = false
    ;(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This device will not give the app a camera.')
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (done) return s.getTracks().forEach((t) => t.stop())
        stream = s
        video.current.srcObject = s
        video.current.play()
        tick()
      } catch (e) {
        setMsg(`Camera unavailable (${e.message}). Paste the link instead.`)
      }
    })()
    function tick () {
      if (done) return
      const v = video.current; const c = canvas.current
      if (v && c && v.readyState === v.HAVE_ENOUGH_DATA) {
        c.width = v.videoWidth; c.height = v.videoHeight
        const ctx = c.getContext('2d')
        ctx.drawImage(v, 0, 0, c.width, c.height)
        const img = ctx.getImageData(0, 0, c.width, c.height)
        const code = jsQR(img.data, img.width, img.height)
        if (code?.data) { done = true; onScan(code.data); return }
      }
      raf = requestAnimationFrame(tick)
    }
    return () => {
      done = true
      if (raf) cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className='scanner'>
      <video ref={video} playsinline muted />
      <canvas ref={canvas} style={{ display: 'none' }} />
      <div className='overlay'>
        <p>{msg}</p>
        <button className='ghost' onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function Pairing ({ onPaired, initialLink = '', onCancel = null }) {
  const [link, setLink] = useState(initialLink)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (initialLink) setLink((cur) => cur || initialLink)
  }, [initialLink])

  const pairWith = async (raw) => {
    setBusy(true); setErr('')
    try {
      const out = await call('pair', { link: String(raw || '').trim(), label: 'phone' })
      onPaired(out)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  const scan = async () => {
    await call('shell.cameraPermission').catch(() => {})
    setScanning(true)
  }

  if (scanning) {
    return <Scanner onScan={(t) => { setScanning(false); setLink(t); pairWith(t) }} onCancel={() => setScanning(false)} />
  }

  return (
    <div className='pairing'>
      <h1>Pear<span>Cinema</span></h1>
      <p>Your films, from your own machine, anywhere - no port forwarding, no VPN, no account.</p>
      <p className='hint'>On your library's dashboard press <b>Pair a device</b>, then scan the QR it shows - or paste the link it carries here.</p>
      <button onClick={scan}><QrCode size={18} /> Scan the code</button>
      <textarea placeholder='pear://pearcinema/pair?...' value={link} onInput={(e) => setLink(e.currentTarget.value)} />
      {err && <div className='bad'>{err}</div>}
      <button disabled={busy || !link.trim()} onClick={() => pairWith(link)}>{busy ? 'Pairing…' : 'Pair with this library'}</button>
      {onCancel && <button className='ghost' onClick={onCancel}>‹ Back</button>}
    </div>
  )
}

// --- the app -----------------------------------------------------------------

export default function App () {
  const [state, setState] = useState(null)
  const [tab, setTab] = useState('library')

  // Library tab.
  const [root, setRoot] = useState('movies')
  const [items, setItems] = useState([])
  const [cursor, setCursor] = useState(null)
  const [series, setSeries] = useState(null)
  const [season, setSeason] = useState(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  // The donor's display options: how the shelf is sorted and how dense the
  // grid is. Persisted in the worklet's settings so they survive a restart.
  const [sortKey, setSortKey] = useState('title-asc')
  const [cols, setCols] = useState(2)
  const [showDisplay, setShowDisplay] = useState(false)
  const SORT_PARAM = {
    'title-asc': { sort: 'title', order: 'asc' },
    'title-desc': { sort: 'title', order: 'desc' },
    'year-desc': { sort: 'year', order: 'desc' },
    'year-asc': { sort: 'year', order: 'asc' }
  }
  const setDisplay = (patch) => {
    if (patch.sortKey) setSortKey(patch.sortKey)
    if (patch.cols) setCols(patch.cols)
    call('setSettings', { sortKey: patch.sortKey ?? sortKey, cols: patch.cols ?? cols }).catch(() => {})
  }

  // Cross-tab data.
  const [artBase, setArtBase] = useState('')
  const [ident, setIdent] = useState(null)
  const [saved, setSaved] = useState(new Set())
  const [savedItems, setSavedItems] = useState(null)
  const [watchedIds, setWatchedIds] = useState(new Set())
  const [youView, setYouView] = useState('continue')
  const [continueRows, setContinueRows] = useState(null)
  const [watchedRows, setWatchedRows] = useState(null)
  const [requests, setRequests] = useState(null)
  const [allRequests, setAllRequests] = useState(null)
  const [devices, setDevices] = useState(null)
  const [themePref, setThemePref] = useState(loadThemePref())
  const [settingsOpen, setSettingsOpen] = useState(null)
  const toggleSection = (id) => setSettingsOpen((cur) => (cur === id ? null : id))

  // The profile header's editable claim. Seeded from identity.get; dirty when
  // either field departs from what the server answered.
  const [profName, setProfName] = useState('')
  const [profDev, setProfDev] = useState('')
  const [avatar, setAvatar] = useState(null)
  const [profSaving, setProfSaving] = useState(false)
  const fileRef = useRef(null)
  useEffect(() => {
    setProfName(ident?.userName || ident?.belongsTo || '')
    setProfDev(ident?.deviceName || 'phone')
    setAvatar(ident?.avatar || null)
  }, [ident])
  const profDirty = ident && (profName !== (ident.userName || ident.belongsTo || '') || profDev !== (ident.deviceName || 'phone'))

  // Overlays.
  const [sheet, setSheet] = useState(null)
  const [askTitle, setAskTitle] = useState(false)
  const [addingLibrary, setAddingLibrary] = useState(false)
  const [resumeOffer, setResumeOffer] = useState(null)
  const [pairLink, setPairLink] = useState('')
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')

  const retried = useRef(new Set())
  const uiRef = useRef({})
  const toastTimer = useRef(null)

  const say = (msg) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }

  const reload = useCallback(async () => {
    const s = await call('app.state')
    setState(s)
    if (s.active) {
      const b = await call('art.base').catch(() => null)
      if (b) setArtBase(b.base)
      call('identity.get').then(setIdent).catch(() => {})
      call('fav.list').then((r) => {
        setSaved(new Set((r.items || []).map((i) => i.id)))
        setSavedItems(r.items || [])
      }).catch(() => {})
      call('watched.list').then((r) => setWatchedIds(new Set(r.items || []))).catch(() => {})
    }
    return s
  }, [])

  useEffect(() => {
    reload().catch((e) => setErr(e.message))
    const offs = [
      on('pair-link', (url) => { setPairLink(url); setAddingLibrary(true) }),
      on('hosts:changed', () => reload().catch(() => {})),
      on('shim:ready', () => reload().catch(() => {})),
      on('player:tick', (d) => {
        if (d?.itemId && d.positionMs > 0) call('resume.set', { itemId: d.itemId, positionMs: d.positionMs }).catch(() => {})
      }),
      on('player:closed', (d) => {
        if (d?.itemId && d.positionMs > 0) call('resume.set', { itemId: d.itemId, positionMs: d.positionMs }).catch(() => {})
        setContinueRows(null)
      }),
      on('player:error', async (d) => {
        if (!d?.itemId) return
        if (retried.current.has(d.itemId)) {
          setErr('This one failed to play on this device, even with the host helping.')
          return
        }
        retried.current.add(d.itemId)
        try {
          const { url, mode } = await call('stream.url', { itemId: d.itemId, deviceRefusedVideo: true })
          if (mode === 'transcode') await call('shell.play', { itemId: d.itemId, url, title: d.title || '', startMs: d.positionMs || 0 })
          else setErr('This one failed to play on this device, and the host cannot convert it.')
        } catch (e) { setErr(e.message) }
      })
    ]
    call('shell.pendingLink').then((url) => { if (url) { setPairLink(url); setAddingLibrary(true) } }).catch(() => {})
    const offTheme = onSystemThemeChange(() => applyThemePref(loadThemePref(), { persist: false }))
    window.__pearBack = () => {
      const u = uiRef.current
      if (u.sheet) return setSheet(null)
      if (u.showDisplay) return setShowDisplay(false)
      if (u.resumeOffer) return setResumeOffer(null)
      if (u.addingLibrary) return setAddingLibrary(false)
      if (u.season) return setSeason(null)
      if (u.series) return setSeries(null)
      if (u.tab !== 'library') return setTab('library')
      call('shell.exit').catch(() => {})
    }
    return () => { offs.forEach((f) => f()); offTheme() }
  }, [])

  uiRef.current = { sheet: !!sheet, showDisplay, resumeOffer: !!resumeOffer, addingLibrary, season: !!season, series: !!series, tab }

  // --- library data ---------------------------------------------------------

  const fetchList = useCallback(async (params, append = false) => {
    try {
      const page = await call('library.list', params)
      setItems((prev) => (append ? [...prev, ...(page.items || [])] : (page.items || [])))
      setCursor(page.cursor || null)
      setErr('')
    } catch (e) { setErr(e.message) }
  }, [])

  useEffect(() => {
    if (!state?.active) return
    setItems([]); setCursor(null)
    if (season) fetchList({ type: 'episodes', seasonId: season.id, limit: 200 })
    else if (series) fetchList({ type: 'seasons', seriesId: series.id, limit: 100 })
    else fetchList({ type: root, limit: 100, ...SORT_PARAM[sortKey] })
  }, [state?.active?.hostKey, root, series?.id, season?.id, sortKey])

  // The saved display prefs, once the worklet answers.
  useEffect(() => {
    call('getSettings').then((s) => {
      if (s?.sortKey && SORT_PARAM[s.sortKey]) setSortKey(s.sortKey)
      if ([2, 3, 4].includes(s?.cols)) setCols(s.cols)
    }).catch(() => {})
  }, [])

  // Search rides the library tab from anywhere in it, the donor's rule.
  useEffect(() => {
    if (!query.trim()) { setResults(null); return }
    const t = setTimeout(() => {
      call('library.search', { q: query.trim(), limit: 60 })
        .then((r) => setResults(r.items || []))
        .catch(() => setResults([]))
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  // --- per-tab loads --------------------------------------------------------

  useEffect(() => {
    if (!state?.active) return
    if (tab === 'watchlist') {
      call('fav.list').then((r) => {
        setSavedItems(r.items || [])
        setSaved(new Set((r.items || []).map((i) => i.id)))
      }).catch(() => {})
    }
    if (tab === 'you') loadYou(youView)
  }, [tab, youView, state?.active?.hostKey])

  const loadYou = async (view) => {
    try {
      if (view === 'continue') setContinueRows((await call('resume.list', { limit: 30 })).items || [])
      if (view === 'watched') {
        const ids = [...new Set((await call('watched.list')).items || [])].slice(0, 60)
        const rows = await Promise.all(ids.map((id) => call('library.get', { id }).catch(() => null)))
        setWatchedRows(rows.filter(Boolean))
      }
      if (view === 'requests') setRequests((await call('request.list')).items || [])
      if (view === 'manage') {
        setDevices((await call('device.list')).items || [])
        setAllRequests((await call('request.all')).items || [])
      }
    } catch (e) { setErr(e.message) }
  }

  // --- actions --------------------------------------------------------------

  const play = async (item, url, startMs) => {
    try { await call('shell.play', { itemId: item.id, url, title: item.title, startMs }) } catch (e) { setErr(e.message) }
  }

  const open = async (i) => {
    if (i.type === 'series') { setTab('library'); return setSeries(i) }
    if (i.type === 'season') { setTab('library'); return setSeason(i) }
    try {
      const [{ url }, prior] = await Promise.all([
        call('stream.url', { itemId: i.id }),
        call('resume.get', { itemId: i.id }).catch(() => null)
      ])
      const startMs = prior?.resume?.positionMs > 0 ? prior.resume.positionMs : 0
      if (startMs > 0) return setResumeOffer({ item: i, url, positionMs: startMs })
      await play(i, url, 0)
    } catch (e) { setErr(e.message) }
  }

  const toggleSave = async (i) => {
    const kind = ['movie', 'episode', 'series', 'season'].includes(i.type) ? i.type : (i.kind || 'movie')
    const on = !saved.has(i.id)
    setSaved((s) => { const n = new Set(s); on ? n.add(i.id) : n.delete(i.id); return n })
    if (!on) setSavedItems((rows) => (rows || []).filter((r) => r.id !== i.id))
    try {
      await call('fav.set', { kind, id: i.id, on })
      say(on ? 'Added to your watchlist' : 'Removed from your watchlist')
      if (on) call('fav.list').then((r) => setSavedItems(r.items || [])).catch(() => {})
    } catch (e) { setErr(e.message) }
  }

  const markWatched = async (i, on) => {
    try {
      await call('watched.set', { itemId: i.id, watched: on })
      setWatchedIds((s) => { const n = new Set(s); on ? n.add(i.id) : n.delete(i.id); return n })
      say(on ? 'Marked watched' : 'Marked unwatched')
      if (youView === 'watched') loadYou('watched')
    } catch (e) { setErr(e.message) }
  }

  const longPress = (i) => setSheet(i)

  if (!state) return <div className='center'><p className='muted'>Starting…</p></div>
  if (!state.active) return <Pairing initialLink={pairLink} onPaired={() => reload()} />

  if (addingLibrary) {
    return (
      <Pairing
        initialLink={pairLink}
        onPaired={() => { setAddingLibrary(false); setPairLink(''); setSeries(null); setSeason(null); reload() }}
        onCancel={() => { setAddingLibrary(false); setPairLink('') }}
      />
    )
  }

  // --- screens --------------------------------------------------------------

  const libraryScreen = (
    <div className='app'>
      <header>
        <h1>{state.active.libraryName || 'Library'}</h1>
        {series && <p className='muted sm'>{season ? `${series.title} · ${season.title}` : series.title}</p>}
      </header>

      {!series && (
        <div className='sticky'>
          {/* Search first - it is global, so it sits ABOVE the browse picker,
              the donor's order (Tim, 2026-08-15). Both are direct children of
              the sticky, so their widths match exactly. */}
          <div className='searchbar'>
            <input className='search' placeholder='Search your library' value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
            {query ? <button className='searchclear' onClick={() => setQuery('')} aria-label='Clear search'><X size={14} /></button> : null}
          </div>
          <div className='pickrow'>
            <div className='seg'>
              <button className={root === 'movies' ? 'on' : ''} onClick={() => setRoot('movies')}>Films</button>
              <button className={root === 'series' ? 'on' : ''} onClick={() => setRoot('series')}>Shows</button>
            </div>
            <button className='dispbtn' aria-label='Sort and layout' onClick={() => setShowDisplay(true)}>
              <SlidersHorizontal size={18} />
            </button>
          </div>
        </div>
      )}

      {series && (
        <div className='pickrow'>
          <button className='ghost' onClick={() => (season ? setSeason(null) : setSeries(null))}><CaretLeft size={16} /> Back</button>
        </div>
      )}

      {err && <div className='error'>{err}</div>}

      {results
        ? (results.length
            ? <Grid items={results} artBase={artBase} savedSet={saved} onOpen={open} onLong={longPress} onSave={toggleSave} cols={cols} />
            : <p className='muted center-p'>Nothing matches "{query}".</p>)
        : season
          ? (
            <ul className='tracks'>
              {items.map((e) => (
                <ItemRow
                  key={e.id} item={e} onOpen={open} onLong={longPress}
                  sub={[e.episode != null ? `Episode ${e.episode}` : null, fmtRuntime(e.runtime)].filter(Boolean).join(' · ')}
                  right={watchedIds.has(e.id) ? <CheckCircle size={18} weight='fill' className='muted' /> : null}
                />
              ))}
            </ul>
            )
          : <Grid items={items} artBase={artBase} savedSet={saved} onOpen={open} onLong={longPress} onSave={!series ? toggleSave : null} cols={cols} />}

      {!results && cursor && (
        <button
          className='ghost' style={{ margin: '0.8rem auto', display: 'block' }}
          onClick={() => fetchList(season ? { type: 'episodes', seasonId: season.id, limit: 200, cursor } : series ? { type: 'seasons', seriesId: series.id, limit: 100, cursor } : { type: root, limit: 100, cursor }, true)}
        >More</button>
      )}
    </div>
  )

  const watchlistScreen = (
    <div className='app'>
      <header>
        <h1>Watchlist</h1>
        <p className='muted sm'>{savedItems?.length ? `${savedItems.length} saved to watch` : 'Saved to watch, synced through your library'}</p>
      </header>
      {savedItems == null
        ? <p className='muted center-p'>Loading…</p>
        : savedItems.length === 0
          ? (
            <div className='center-p muted'>
              <p>Nothing saved yet.</p>
              <p className='sm'>Hold a film, or tap the bookmark on its poster, to put it here.</p>
            </div>
            )
          : <Grid items={savedItems} artBase={artBase} savedSet={saved} onOpen={open} onLong={longPress} onSave={toggleSave} cols={cols} />}
    </div>
  )

  const isOwner = !!ident?.owner
  const youScreen = (
    <div className='app'>
      <header><h1>You</h1><p className='muted sm'>{ident?.belongsTo ? `Watching as ${ident.belongsTo}` : 'This device'}</p></header>
      <div className='sticky'>
        <div className='pickrow'>
          <div className='seg icons'>
            <button className={youView === 'continue' ? 'on' : ''} aria-label='Continue watching' onClick={() => setYouView('continue')}>
              <Play size={17} weight={youView === 'continue' ? 'fill' : 'regular'} />
              {youView === 'continue' && <span>Continue</span>}
            </button>
            <button className={youView === 'watched' ? 'on' : ''} aria-label='Watched' onClick={() => setYouView('watched')}>
              <CheckCircle size={17} weight={youView === 'watched' ? 'fill' : 'regular'} />
              {youView === 'watched' && <span>Watched</span>}
            </button>
            <button className={youView === 'requests' ? 'on' : ''} aria-label='Requests' onClick={() => setYouView('requests')}>
              <EnvelopeSimple size={17} weight={youView === 'requests' ? 'fill' : 'regular'} />
              {youView === 'requests' && <span>Requests</span>}
            </button>
            <button className={youView === 'downloads' ? 'on' : ''} aria-label='Downloads' onClick={() => setYouView('downloads')}>
              <DownloadSimple size={17} weight={youView === 'downloads' ? 'fill' : 'regular'} />
              {youView === 'downloads' && <span>Downloads</span>}
            </button>
            {isOwner && (
              <button className={youView === 'manage' ? 'on' : ''} aria-label='Manage library' onClick={() => setYouView('manage')}>
                <UsersThree size={17} weight={youView === 'manage' ? 'fill' : 'regular'} />
                {youView === 'manage' && <span>Manage</span>}
              </button>
            )}
          </div>
        </div>
      </div>

      {youView === 'continue' && (
        continueRows == null
          ? <p className='muted center-p'>Loading…</p>
          : continueRows.length === 0
            ? <p className='muted center-p'>Nothing in progress. Start a film and your place appears here.</p>
            : (
              <ul className='tracks'>
                {continueRows.map((r) => (
                  <ItemRow
                    key={r.id} item={r} onOpen={open} onLong={longPress}
                    sub={`${fmtClock(r.resume?.positionMs || 0)} in${r.runtime ? ` · ${fmtRuntime(r.runtime)}` : ''}`}
                    right={<Play size={18} className='muted' />}
                  />
                ))}
              </ul>
              )
      )}

      {youView === 'watched' && (
        watchedRows == null
          ? <p className='muted center-p'>Loading…</p>
          : watchedRows.length === 0
            ? <p className='muted center-p'>Nothing finished yet.</p>
            : (
              <ul className='tracks'>
                {watchedRows.map((r) => (
                  <ItemRow
                    key={r.id} item={r} onOpen={open} onLong={longPress}
                    sub={[r.year, fmtRuntime(r.runtime)].filter(Boolean).join(' · ')}
                    right={<button className='ghost' onClick={(e) => { e.stopPropagation(); markWatched(r, false) }}>Unmark</button>}
                  />
                ))}
              </ul>
              )
      )}

      {youView === 'requests' && (
        <div className='reqview'>
          <button onClick={() => setAskTitle(true)}><Plus size={16} /> Ask for a film or show</button>
          {requests == null
            ? <p className='muted center-p'>Loading…</p>
            : requests.length === 0
              ? <p className='muted center-p'>Ask the library's owner for something they do not have, and watch its status here.</p>
              : (
                <ul className='tracks'>
                  {requests.map((r) => (
                    <li className='track' key={r.id}>
                      <div className='meta'>
                        <div className='t'>{r.name}</div>
                        <div className='sub muted sm'>{r.kind === 'series' ? 'Show' : 'Film'} · {r.status}{r.count > 1 ? ` · asked by ${r.count}` : ''}</div>
                      </div>
                      {r.status === 'pending' && (
                        <button className='ghost' aria-label='Withdraw' onClick={() => call('request.remove', { id: r.id }).then(() => loadYou('requests'))}><Trash size={16} /></button>
                      )}
                    </li>
                  ))}
                </ul>
                )}
        </div>
      )}

      {youView === 'downloads' && (
        <div className='center-p muted'>
          <p>Downloads are on their way.</p>
          <p className='sm'>Films you save for offline will live here - the storage side exists, the saving side is next.</p>
        </div>
      )}

      {youView === 'manage' && isOwner && (
        <div className='ownerdevs'>
          <h3>Requests</h3>
          {allRequests == null
            ? <p className='muted sm'>Loading…</p>
            : allRequests.filter((r) => r.status === 'pending').length === 0
              ? <p className='muted sm'>Nothing waiting.</p>
              : (
                <ul className='tracks'>
                  {allRequests.filter((r) => r.status === 'pending').map((r) => (
                    <li className='track' key={r.id}>
                      <div className='meta'>
                        <div className='t'>{r.name}</div>
                        <div className='sub muted sm'>{r.kind === 'series' ? 'Show' : 'Film'}{r.count > 1 ? ` · asked by ${r.count}` : ''}</div>
                      </div>
                      <div className='rowacts'>
                        <button className='ghost' onClick={() => call('request.resolve', { id: r.id, status: 'added' }).then(() => loadYou('manage'))}>Added</button>
                        <button className='ghost' onClick={() => call('request.resolve', { id: r.id, status: 'declined' }).then(() => loadYou('manage'))}>Decline</button>
                      </div>
                    </li>
                  ))}
                </ul>
                )}
          <h3>Devices</h3>
          {devices == null
            ? <p className='muted sm'>Loading…</p>
            : (
              <ul className='tracks'>
                {devices.map((d) => (
                  <li className='track' key={d.deviceKey}>
                    <div className='meta'>
                      <div className='t'>{d.label || 'device'}{d.self ? ' (this phone)' : ''}</div>
                      <div className='sub muted sm'>{[d.platform, d.belongsTo ? `belongs to ${d.belongsTo}` : 'unassigned'].filter(Boolean).join(' · ')}</div>
                    </div>
                  </li>
                ))}
              </ul>
              )}
          <p className='muted sm'>Revoking a device stays on the dashboard for now.</p>
        </div>
      )}
    </div>
  )

  const hosts = state.hosts || []
  const settingsScreen = (
    <div className='app'>
      <header><h1>Settings</h1></header>

      {/* Profile header, the donor's - always visible above the sections: your
          photo, your name, this device. A claim grants nothing until the
          operator confirms it, and the note below says so honestly. */}
      <div className='profile'>
        <button className='profile-av' onClick={() => fileRef.current?.click()} aria-label='Change your photo'>
          {avatar
            ? <img src={'data:image/jpeg;base64,' + avatar} alt='' />
            : <span className='profile-mono'>{((profName || ident?.belongsTo || 'Y')[0] || 'Y').toUpperCase()}</span>}
        </button>
        <input
          ref={fileRef} type='file' accept='image/*' style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.currentTarget.files?.[0]
            e.currentTarget.value = ''
            if (!f) return
            try {
              const b64 = await compressToAvatarB64(await readFileDataUrl(f))
              setAvatar(b64)
              await call('avatar.set', { avatar: b64 })
              say('Photo saved')
            } catch (er) { setErr(er.message) }
          }}
        />
        <div className='profile-fields'>
          <input
            className='profile-name' value={profName} placeholder='Your name' maxLength={64}
            aria-label='Your name' onInput={(e) => setProfName(e.currentTarget.value)}
          />
          <input
            className='profile-dev' value={profDev} placeholder='This device' maxLength={64}
            aria-label='Device name' onInput={(e) => setProfDev(e.currentTarget.value)}
          />
        </div>
        {profDirty && (
          <button
            className='profile-save' disabled={profSaving}
            onClick={async () => {
              setProfSaving(true)
              try {
                await call('identity.set', { userName: profName, deviceName: profDev })
                await call('identity.get').then(setIdent).catch(() => {})
                say('Saved')
              } catch (er) { setErr(er.message) }
              setProfSaving(false)
            }}
          >{profSaving ? '…' : 'Save'}</button>
        )}
      </div>
      {ident?.userName && (
        <div className='profile-note desc'>
          {ident.confirmed
            ? `The server has confirmed this device belongs to ${ident.belongsTo || ident.userName}.`
            : ident.belongsTo
              ? `The server still has this device down as ${ident.belongsTo}. It is waiting to confirm you are ${ident.userName} - only the person running it can move a device to someone else.`
              : `Waiting for the server to confirm you are ${ident.userName}. Until then this is only a label.`}
        </div>
      )}

      <div className='settings-acc'>
        <Section id='library' title={hosts.length > 1 ? 'Libraries' : 'Library'} Icon={FilmStrip} open={settingsOpen === 'library'} onToggle={toggleSection}>
          {hosts.map((h) => (
            <div className='row' key={h.hostKey}>
              <span className='label'>{h.libraryName || 'Library'}{h.active ? ' · playing from' : ''}</span>
              <span className='rowacts'>
                {!h.active && <button className='ghost' aria-label='Switch' onClick={() => call('hosts.setActive', { hostKey: h.hostKey }).then(() => { setSeries(null); setSeason(null); reload() })}><ArrowsLeftRight size={16} /></button>}
                <button className='ghost' aria-label='Leave' onClick={() => call('hosts.remove', { hostKey: h.hostKey }).then(() => reload())}><SignOut size={16} /></button>
              </span>
            </div>
          ))}
          <button onClick={() => setAddingLibrary(true)}><Plus size={16} /> Add a library</button>
        </Section>

        <Section id='streaming' title='Streaming and downloads' Icon={DownloadSimple} open={settingsOpen === 'streaming'} onToggle={toggleSection}>
          <p className='desc'>Full quality, converted by your box only when this phone needs it. A data-saver cap for slow links, and a size cap for downloaded films, arrive with the off-home and offline work.</p>
        </Section>

        <Section id='appearance' title='Appearance' Icon={Gear} open={settingsOpen === 'appearance'} onToggle={toggleSection}>
          <div className='optlist'>
            {['system', 'dark', 'light'].map((p) => (
              <button key={p} className={themePref === p ? 'on' : ''} onClick={() => { setThemePref(p); applyThemePref(p) }}>
                {p === 'system' ? 'Match this phone' : p === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        </Section>

        <Section id='how' title='How it works' Icon={Info} open={settingsOpen === 'how'} onToggle={toggleSection}>
          <p className='desc'>Your films stay on your own machine. This phone connects straight to it over an encrypted pear-to-pear link - no port forwarding, no VPN, no account, and nobody in the middle. What its chip cannot play, your box converts on the fly.</p>
        </Section>

        <Section id='device' title='This device' Icon={UsersThree} open={settingsOpen === 'device'} onToggle={toggleSection}>
          <div className='row'><span className='label'>Library</span><span className='muted sm'>{ident?.libraryName || state.active.libraryName}</span></div>
          {isOwner && <div className='row'><span className='label'>Role</span><span className='muted sm'>Owner</span></div>}
          {ident?.expiresAt && <div className='row'><span className='label'>Guest access</span><span className='muted sm'>until {new Date(ident.expiresAt).toLocaleDateString()}</span></div>}
        </Section>
      </div>
    </div>
  )

  const aboutScreen = (
    <div className='app about'>
      <header><h1>About</h1></header>
      <div className='wordmark'>Pear<span>Cinema</span></div>
      <p className='muted sm version'>Version {APP_VERSION}</p>
      <p>Your film and TV collection, from your own machine or a friend's, playable anywhere. No port forwarding, no VPN, no account - and nobody in the middle.</p>
      <div className='card'>
        <button onClick={() => { (navigator.share ? navigator.share({ text: SHARE_TEXT }) : navigator.clipboard.writeText(SHARE_TEXT).then(() => say('Copied'))) }}>
          <ShareNetwork size={18} /> Share PearCinema
        </button>
        <a className='linkbtn' href={STRIKE_TIP_URL} target='_blank' rel='noreferrer'><Lightning size={18} /> Tip with Strike</a>
        <a className='linkbtn' href={BUYMEACOFFEE_URL} target='_blank' rel='noreferrer'><Coffee size={18} /> Buy us a coffee</a>
        <div className='row'><span className='label'>Lightning</span><span className='muted sm'>{LIGHTNING_ADDRESS}</span></div>
        <a className='linkbtn' href={GITHUB_URL} target='_blank' rel='noreferrer'><GithubLogo size={18} /> GitHub</a>
        <a className='linkbtn' href={`mailto:${CONTACT_EMAIL}?subject=%5BPearCinema%5D%20Feedback`}><EnvelopeOpen size={18} /> {CONTACT_EMAIL}</a>
      </div>
    </div>
  )

  return (
    <div className='shellwrap'>
      {tab === 'library' && libraryScreen}
      {tab === 'you' && youScreen}
      {tab === 'watchlist' && watchlistScreen}
      {tab === 'settings' && settingsScreen}
      {tab === 'about' && aboutScreen}

      {/* The dock is the donor's fixed bottom container; with no mini-player
          above it, the navbar IS the dock. */}
      <div className='dock'>
        <NavBar active={tab} onTab={(k) => { setTab(k); setErr('') }} saved={saved.size} />
      </div>

      {sheet && (
        <ActionSheet
          item={sheet} saved={saved.has(sheet.id)} watched={watchedIds.has(sheet.id)}
          onClose={() => setSheet(null)} onPlay={open} onSave={toggleSave} onWatched={markWatched}
        />
      )}

      {askTitle && (
        <div className='sheetwrap' onClick={() => setAskTitle(false)}>
          <div className='sheet' onClick={(e) => e.stopPropagation()}>
            <h3>Ask for something</h3>
            <form onSubmit={(e) => {
              e.preventDefault()
              const name = e.currentTarget.elements.rq.value.trim()
              const kind = e.currentTarget.elements.kind.value
              if (!name) return
              call('request.add', { kind, name })
                .then(() => { setAskTitle(false); say('Asked - the owner will see it'); loadYou('requests') })
                .catch((er) => setErr(er.message))
            }}>
              <input name='rq' className='search' placeholder='Title' autoFocus />
              <div className='pickrow' style={{ margin: '.6rem 0' }}>
                <label><input type='radio' name='kind' value='movie' defaultChecked /> Film</label>
                <label><input type='radio' name='kind' value='series' /> Show</label>
              </div>
              <div className='btnrow'>
                <button type='submit'>Send</button>
                <button type='button' className='ghost' onClick={() => setAskTitle(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {resumeOffer && (
        <div className='resumeover' onClick={() => setResumeOffer(null)}>
          <div className='card' onClick={(e) => e.stopPropagation()}>
            <h3>Resume at {fmtClock(resumeOffer.positionMs)}?</h3>
            <div className='btnrow'>
              <button onClick={() => { const r = resumeOffer; setResumeOffer(null); play(r.item, r.url, r.positionMs) }}>Resume</button>
              <button className='ghost' onClick={() => { const r = resumeOffer; setResumeOffer(null); play(r.item, r.url, 0) }}>Start Over</button>
            </div>
          </div>
        </div>
      )}

      {showDisplay && (
        <div className='sheetwrap' onClick={() => setShowDisplay(false)}>
          <div className='sheet' onClick={(e) => e.stopPropagation()}>
            <h3>Sort</h3>
            <div className='optlist'>
              {[['title-asc', 'Title, A to Z'], ['title-desc', 'Title, Z to A'], ['year-desc', 'Year, newest first'], ['year-asc', 'Year, oldest first']].map(([k, label]) => (
                <button key={k} className={sortKey === k ? 'on' : ''} onClick={() => setDisplay({ sortKey: k })}>{label}</button>
              ))}
            </div>
            <h3>Layout</h3>
            <div className='optlist'>
              {[[2, 'Comfortable'], [3, 'Compact'], [4, 'Dense']].map(([n, label]) => (
                <button key={n} className={cols === n ? 'on' : ''} onClick={() => setDisplay({ cols: n })}>{label}</button>
              ))}
            </div>
            <button className='ghost' onClick={() => setShowDisplay(false)}>Done</button>
          </div>
        </div>
      )}

      {toast && <div className='toast'>{toast}</div>}
    </div>
  )
}
