// The PearCinema phone UI, first cut: pair, browse, play.
//
// Deliberately small. The dashboard's Preact app is the design reference (same
// suite, same palette family) and this will grow toward it; what this cut proves
// is the whole vertical - a pairing link into the worklet, a library over P2P,
// posters off the loopback shim, and a film playing in an HTML5 <video> whose
// bytes ride the live connection. Runtimes are SECONDS, positions MILLISECONDS,
// the suite convention.

import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import jsQR from 'jsqr'
import { call, on } from './bridge'

const fmtRuntime = (s) => {
  const n = Number(s) || 0
  if (!n) return ''
  const h = Math.floor(n / 3600); const m = Math.round((n % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

// The camera pointed at a pairing QR. PearTune's Scanner, ported: getUserMedia
// frames through jsQR on a hidden canvas. The guard on mediaDevices is load-
// bearing - outside a secure context the property is UNDEFINED and reading
// getUserMedia off it throws synchronously inside the effect, which unmounts
// the tree into a black screen with nothing in the log (the donor paid for
// that). This page's origin is http://127.0.0.1, which IS trustworthy, but the
// guard stays so a WebView that disagrees fails with a sentence instead.
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
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('This device will not give the app a camera.')
        }
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
      const v = video.current
      const c = canvas.current
      if (v && c && v.readyState === v.HAVE_ENOUGH_DATA) {
        c.width = v.videoWidth
        c.height = v.videoHeight
        const ctx = c.getContext('2d')
        ctx.drawImage(v, 0, 0, c.width, c.height)
        const img = ctx.getImageData(0, 0, c.width, c.height)
        const code = jsQR(img.data, img.width, img.height)
        if (code?.data) {
          done = true
          onScan(code.data)
          return
        }
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
    <div class='scanner'>
      <video ref={video} playsinline muted />
      <canvas ref={canvas} style={{ display: 'none' }} />
      <div class='overlay'>
        <p>{msg}</p>
        <button class='ghost' onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// `onCancel` makes this screen reachable from a RUNNING app - adding a second
// library, or a pairing link arriving while a host is active, which used to go
// nowhere because this screen only existed when the app had no host at all
// (the gap the 2026-08-14 revoke-restore hit twice).
function Pairing ({ onPaired, initialLink = '', onCancel = null }) {
  const [link, setLink] = useState(initialLink)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [err, setErr] = useState('')

  // The deep link lands AFTER first render on a cold start - the shell forwards
  // it once the WebView is up - and useState captures only the mount-time value.
  // Without this, the field stays empty, the button stays dead, and the tap on a
  // perfectly good link does nothing (found on the first emulator run).
  useEffect(() => {
    if (initialLink) setLink((cur) => cur || initialLink)
  }, [initialLink])

  const pairWith = async (raw) => {
    setBusy(true); setErr('')
    try {
      const out = await call('pair', { link: String(raw || '').trim(), label: 'phone' })
      onPaired(out)
    } catch (e) {
      setErr(e.message)
    }
    setBusy(false)
  }

  const scan = async () => {
    // The shell holds the runtime camera permission; asking is a no-op when it
    // is already granted. The scanner shows its own failure if this is denied.
    await call('shell.cameraPermission').catch(() => {})
    setScanning(true)
  }

  if (scanning) {
    return (
      <Scanner
        onScan={(text) => { setScanning(false); setLink(text); pairWith(text) }}
        onCancel={() => setScanning(false)}
      />
    )
  }

  return (
    <div class='pairing'>
      <h1>Pear<span>Cinema</span></h1>
      <p>Your films, from your own machine, anywhere - no port forwarding, no VPN, no account.</p>
      <p class='hint'>
        On your library's dashboard press <b>Pair a device</b>, then scan the QR
        it shows - or paste the link it carries here.
      </p>
      <button onClick={scan}>Scan the code</button>
      <textarea
        placeholder='pear://pearcinema/pair?...'
        value={link}
        onInput={(e) => setLink(e.currentTarget.value)}
      />
      {err && <div class='bad'>{err}</div>}
      <button disabled={busy || !link.trim()} onClick={() => pairWith(link)}>
        {busy ? 'Pairing…' : 'Pair with this library'}
      </button>
      {onCancel && <button class='ghost' onClick={onCancel}>‹ Back</button>}
    </div>
  )
}

// Every paired library, the active one marked, each leavable - and the way in
// for a second library. Leave is armed by a first tap rather than a confirm()
// dialog, because a WebView's confirm is at the shell's mercy.
function Hosts ({ hosts, onSwitch, onLeave, onAdd, onBack }) {
  const [arming, setArming] = useState(null)
  return (
    <div class='hosts'>
      <div class='crumbs'>
        <button class='ghost' onClick={onBack}>‹ Back</button>
        <span>Libraries</span>
      </div>
      {hosts.map((h) => (
        <div class='hostrow' key={h.hostKey}>
          <div class='meta'>
            <span class='name'>{h.libraryName || 'Library'}</span>
            {h.active && <span class='on'>Playing from this library</span>}
          </div>
          {!h.active && <button class='ghost' onClick={() => onSwitch(h.hostKey)}>Switch</button>}
          {arming === h.hostKey
            ? <button class='danger' onClick={() => { setArming(null); onLeave(h.hostKey) }}>Really leave?</button>
            : <button class='ghost' onClick={() => setArming(h.hostKey)}>Leave</button>}
        </div>
      ))}
      <button class='more' onClick={onAdd}>Add a library</button>
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
  const [pairLink, setPairLink] = useState('')
  const [artBase, setArtBase] = useState('')
  const [err, setErr] = useState('')
  // The two overlay screens a RUNNING app can open: the library list, and the
  // pairing screen for adding (or re-adding) a library.
  const [showHosts, setShowHosts] = useState(false)
  const [addingLibrary, setAddingLibrary] = useState(false)
  // Items already retried after a native player error - one honest retry per
  // item per session, never a loop of failing attempts.
  const retried = useRef(new Set())
  // What the hardware back button should unwind, read at press time.
  const uiRef = useRef({})

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
      // A pairing link while a host is ACTIVE used to go nowhere - the pairing
      // screen only existed when the app had no host (measured 2026-08-14: the
      // revoke restore needed a full app wipe to re-pair). It now opens the
      // pairing screen as an overlay, link filled in.
      on('pair-link', (url) => { setPairLink(url); setAddingLibrary(true) }),
      on('hosts:changed', () => reload().catch(() => {})),
      on('shim:ready', () => reload().catch(() => {})),
      // THE UI OWNS THE WATCH-STATE WRITES; the native player only reports. The
      // host derives the runtime itself, so a position is all that crosses.
      on('player:tick', (d) => {
        if (d?.itemId && d.positionMs > 0) call('resume.set', { itemId: d.itemId, positionMs: d.positionMs }).catch(() => {})
      }),
      on('player:closed', (d) => {
        if (d?.itemId && d.positionMs > 0) call('resume.set', { itemId: d.itemId, positionMs: d.positionMs }).catch(() => {})
      }),
      // The native player refused what the declaration said it could play - the
      // chip lied. Re-describe the device without the codec that just failed
      // and let the host decide again; a transcode verdict resumes the film
      // where it died. One retry per item, then the failure is shown plainly.
      on('player:error', async (d) => {
        if (!d?.itemId) return
        if (retried.current.has(d.itemId)) {
          setErr('This one failed to play on this device, even with the host helping.')
          return
        }
        retried.current.add(d.itemId)
        try {
          const { url, mode } = await call('stream.url', { itemId: d.itemId, deviceRefusedVideo: true })
          if (mode === 'transcode') {
            await call('shell.play', { itemId: d.itemId, url, title: d.title || '', startMs: d.positionMs || 0 })
          } else {
            setErr('This one failed to play on this device, and the host cannot convert it.')
          }
        } catch (e) {
          setErr(e.message)
        }
      })
    ]
    // The stashed link from the shell - a warm pear:// link remounts the whole
    // shell (expo-router navigates on it), so the live pair-link event above is
    // only the fast path; THIS collect is what survives the remount. Opening
    // the overlay here is harmless when no host is active yet: the full-screen
    // pairing render wins in that case.
    call('shell.pendingLink').then((url) => {
      if (url) { setPairLink(url); setAddingLibrary(true) }
    }).catch(() => {})
    // Android back unwinds the UI one level; only with nothing left does the app
    // close. A RUNNING FILM is the shell's to close - it never reaches here.
    window.__pearBack = () => {
      const u = uiRef.current
      if (u.addingLibrary) return setAddingLibrary(false)
      if (u.showHosts) return setShowHosts(false)
      if (u.season) return setSeason(null)
      if (u.series) return setSeries(null)
      call('shell.exit').catch(() => {})
    }
    return () => offs.forEach((f) => f())
  }, [])

  uiRef.current = { addingLibrary, showHosts, season: !!season, series: !!series }

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

  // The overlay screens of a running app. Pairing first: a link that arrived
  // wants acting on even when the library list is also open.
  if (addingLibrary) {
    return (
      <Pairing
        initialLink={pairLink}
        onPaired={() => { setAddingLibrary(false); setShowHosts(false); setPairLink(''); setSeries(null); setSeason(null); reload() }}
        onCancel={() => { setAddingLibrary(false); setPairLink('') }}
      />
    )
  }

  if (showHosts) {
    return (
      <Hosts
        hosts={state.hosts || []}
        onSwitch={async (hostKey) => {
          try { await call('hosts.setActive', { hostKey }); setSeries(null); setSeason(null); setShowHosts(false); await reload() } catch (e) { setErr(e.message) }
        }}
        onLeave={async (hostKey) => {
          try { await call('hosts.remove', { hostKey }); await reload() } catch (e) { setErr(e.message) }
        }}
        onAdd={() => setAddingLibrary(true)}
        onBack={() => setShowHosts(false)}
      />
    )
  }

  // PLAYBACK IS NATIVE - ExoPlayer in the shell, pointed at the shim, because the
  // WebView's own media stack refuses Matroska and Matroska is 83% of a real
  // library. The UI fetches the URL and any saved position, then hands over.
  const open = async (i) => {
    if (i.type === 'series') return setSeries(i)
    if (i.type === 'season') return setSeason(i)
    try {
      const [{ url }, prior] = await Promise.all([
        call('stream.url', { itemId: i.id }),
        call('resume.get', { itemId: i.id }).catch(() => null)
      ])
      const startMs = prior?.positionMs > 0 ? prior.positionMs : 0
      await call('shell.play', { itemId: i.id, url, title: i.title, startMs })
    } catch (e) {
      setErr(e.message)
    }
  }

  return (
    <div class='shell'>
      <div class='top'>
        <span class='brand' onClick={() => { setSeries(null); setSeason(null) }}>Pear<b>Cinema</b></span>
        <span class='lib' onClick={() => setShowHosts(true)}>{state.active.libraryName}</span>
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
