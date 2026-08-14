// The PearCinema phone UI, first cut: pair, browse, play.
//
// Deliberately small. The dashboard's Preact app is the design reference (same
// suite, same palette family) and this will grow toward it; what this cut proves
// is the whole vertical - a pairing link into the worklet, a library over P2P,
// posters off the loopback shim, and a film playing in an HTML5 <video> whose
// bytes ride the live connection. Runtimes are SECONDS, positions MILLISECONDS,
// the suite convention.

import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { call, on } from './bridge'

const fmtRuntime = (s) => {
  const n = Number(s) || 0
  if (!n) return ''
  const h = Math.floor(n / 3600); const m = Math.round((n % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

function Pairing ({ onPaired, initialLink = '' }) {
  const [link, setLink] = useState(initialLink)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // The deep link lands AFTER first render on a cold start - the shell forwards
  // it once the WebView is up - and useState captures only the mount-time value.
  // Without this, the field stays empty, the button stays dead, and the tap on a
  // perfectly good link does nothing (found on the first emulator run).
  useEffect(() => {
    if (initialLink) setLink((cur) => cur || initialLink)
  }, [initialLink])

  const pair = async () => {
    setBusy(true); setErr('')
    try {
      const out = await call('pair', { link: link.trim(), label: 'phone' })
      onPaired(out)
    } catch (e) {
      setErr(e.message)
    }
    setBusy(false)
  }

  return (
    <div class='pairing'>
      <h1>Pear<span>Cinema</span></h1>
      <p>Your films, from your own machine, anywhere - no port forwarding, no VPN, no account.</p>
      <p class='hint'>
        On your library's dashboard press <b>Pair a device</b>, then paste the link
        its QR carries here.
      </p>
      <textarea
        placeholder='pear://pearcinema/pair?...'
        value={link}
        onInput={(e) => setLink(e.currentTarget.value)}
      />
      {err && <div class='bad'>{err}</div>}
      <button disabled={busy || !link.trim()} onClick={pair}>
        {busy ? 'Pairing…' : 'Pair with this library'}
      </button>
    </div>
  )
}

function Player ({ item, onClose }) {
  const [src, setSrc] = useState(null)
  const [err, setErr] = useState('')
  const at = useRef(0)
  const video = useRef(null)

  useEffect(() => {
    call('stream.url', { itemId: item.id }).then((r) => setSrc(r.url)).catch((e) => setErr(e.message))
  }, [item.id])

  // The same heartbeat the dashboard writes, into the same per-person store - the
  // claim this app exists to prove.
  useEffect(() => {
    const t = setInterval(() => {
      if (video.current && !video.current.paused) {
        at.current = video.current.currentTime
        call('resume.set', { itemId: item.id, positionMs: Math.round(at.current * 1000), runtimeSeconds: item.runtime }).catch(() => {})
      }
    }, 15000)
    return () => {
      clearInterval(t)
      const ms = Math.round(at.current * 1000)
      if (ms > 0) call('resume.set', { itemId: item.id, positionMs: ms, runtimeSeconds: item.runtime }).catch(() => {})
    }
  }, [item.id])

  return (
    <div class='player'>
      <div class='bar'>
        <button class='ghost' onClick={onClose}>‹ Back</button>
        <span class='t'>{item.title}</span>
      </div>
      {err && <div class='bad'>{err}</div>}
      {src && (
        <video
          ref={video}
          src={src}
          controls
          playsinline
          autoplay
          onTimeUpdate={(e) => { at.current = e.currentTarget.currentTime }}
          onEnded={() => call('resume.set', { itemId: item.id, positionMs: Math.round((item.runtime || 0) * 1000), runtimeSeconds: item.runtime, ended: true }).catch(() => {})}
          onError={(e) => {
            // MediaError codes: 1 aborted, 2 network, 3 decode, 4 src-not-supported.
            // Said ON SCREEN because a WebView's console is invisible in the field
            // and this distinction (container rejected vs bytes unreachable) is the
            // first question every playback report needs answered.
            // MediaError codes: 1 aborted, 2 network, 3 decode, 4 src-not-supported.
            // Shown plainly because a WebView's console is invisible in the field,
            // and code 3 vs 4 is the first question every playback report needs
            // answered (a codec this chip cannot decode vs a container refused).
            const me = e.currentTarget.error
            setErr(`The player refused this one (code ${me?.code ?? '?'}).`)
          }}
        />
      )}
    </div>
  )
}

function Grid ({ items, artBase, onOpen }) {
  return (
    <div class='grid'>
      {items.map((i) => (
        <div class='poster' key={i.id} onClick={() => onOpen(i)}>
          {i.artId
            ? <img src={`${artBase}${encodeURIComponent(i.artId)}?s=350`} loading='lazy' />
            : <div class='noart'>{i.title.slice(0, 2)}</div>}
          <div class='t'>{i.title}</div>
          <div class='s'>{[i.year, fmtRuntime(i.runtime)].filter(Boolean).join(' · ')}</div>
        </div>
      ))}
    </div>
  )
}

export default function App () {
  const [state, setState] = useState(null)
  const [root, setRoot] = useState('movies')
  const [items, setItems] = useState([])
  const [cursor, setCursor] = useState(null)
  const [series, setSeries] = useState(null)
  const [season, setSeason] = useState(null)
  const [playing, setPlaying] = useState(null)
  const [pairLink, setPairLink] = useState('')
  const [artBase, setArtBase] = useState('')
  const [err, setErr] = useState('')

  const reload = useCallback(async () => {
    const s = await call('app.state')
    setState(s)
    if (s.active) {
      const b = await call('art.base').catch(() => null)
      if (b) setArtBase(b.base)
    }
    return s
  }, [])

  useEffect(() => {
    reload().catch((e) => setErr(e.message))
    const offs = [
      on('pair-link', (url) => setPairLink(url)),
      on('hosts:changed', () => reload().catch(() => {})),
      on('shim:ready', () => reload().catch(() => {}))
    ]
    call('shell.pendingLink').then((url) => { if (url) setPairLink(url) }).catch(() => {})
    // Android back unwinds the UI one level; only with nothing left does the app close.
    window.__pearBack = () => {
      setPlaying((p) => {
        if (p) return null
        setSeason((se) => {
          if (se) return null
          setSeries((sr) => {
            if (sr) return null
            call('shell.exit').catch(() => {})
            return null
          })
          return null
        })
        return null
      })
    }
    return () => offs.forEach((f) => f())
  }, [])

  const fetchList = useCallback(async (params, append = false) => {
    try {
      const page = await call('library.list', params)
      setItems((prev) => (append ? [...prev, ...(page.items || [])] : (page.items || [])))
      setCursor(page.cursor || null)
      setErr('')
    } catch (e) {
      setErr(e.message)
    }
  }, [])

  useEffect(() => {
    if (!state?.active) return
    setItems([]); setCursor(null)
    if (season) fetchList({ type: 'episodes', seasonId: season.id, limit: 200 })
    else if (series) fetchList({ type: 'seasons', seriesId: series.id, limit: 100 })
    else fetchList({ type: root, limit: 100 })
  }, [state?.active?.hostKey, root, series?.id, season?.id])

  if (!state) return <div class='empty'>Starting…</div>

  if (!state.active) {
    return <Pairing initialLink={pairLink} onPaired={() => reload()} />
  }

  if (playing) return <Player item={playing} onClose={() => setPlaying(null)} />

  const open = (i) => {
    if (i.type === 'series') setSeries(i)
    else if (i.type === 'season') setSeason(i)
    else setPlaying(i)
  }

  return (
    <div class='shell'>
      <div class='top'>
        <span class='brand' onClick={() => { setSeries(null); setSeason(null) }}>Pear<b>Cinema</b></span>
        <span class='lib'>{state.active.libraryName}</span>
      </div>

      {!series && (
        <div class='tabs'>
          <button class={root === 'movies' ? 'on' : ''} onClick={() => setRoot('movies')}>Films</button>
          <button class={root === 'series' ? 'on' : ''} onClick={() => setRoot('series')}>Shows</button>
        </div>
      )}

      {series && (
        <div class='crumbs'>
          <button class='ghost' onClick={() => (season ? setSeason(null) : setSeries(null))}>‹ Back</button>
          <span>{season ? `${series.title} · ${season.title}` : series.title}</span>
        </div>
      )}

      {err && <div class='bad'>{err}</div>}

      <Grid items={items} artBase={artBase} onOpen={open} />

      {cursor && (
        <button
          class='more'
          onClick={() => {
            const base = season
              ? { type: 'episodes', seasonId: season.id, limit: 200 }
              : series
                ? { type: 'seasons', seriesId: series.id, limit: 100 }
                : { type: root, limit: 100 }
            fetchList({ ...base, cursor }, true)
          }}
        >More</button>
      )}
    </div>
  )
}
