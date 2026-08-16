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
  FilmStrip, Heart, BookmarkSimple, Gear, Info, X, Play, ArrowsClockwise,
  CheckCircle, DownloadSimple, UsersThree, EnvelopeSimple, CaretLeft, Plus,
  QrCode, Trash, ArrowsLeftRight, SignOut, ShareNetwork, GithubLogo,
  Lightning, Coffee, EnvelopeOpen, CaretRight, SlidersHorizontal,
  ArrowUp, ArrowDown, Palette, Key, Copy, CurrencyBtc, Code, LockKey, DeviceMobile
} from '@phosphor-icons/react'
import { call, on, haptic } from './bridge'
import { loadThemePref, applyThemePref, onSystemThemeChange } from './theme'

const APP_VERSION = '0.1.0'
const LIGHTNING_ADDRESS = 'peerloomllc@strike.me'
const STRIKE_TIP_URL = 'https://strike.me/peerloomllc/'
const BUYMEACOFFEE_URL = 'https://buymeacoffee.com/peerloomllc'
const GITHUB_URL = 'https://github.com/peerloomllc/pearcinema'
const BTC_ONCHAIN_ADDRESS = 'bc1q0kksenz3j4u9ppe6f4krclvzwxk7sjy00cc9cf'
const CONTACT_EMAIL = 'peerloomllc@proton.me'
const CONTACT_URL = `mailto:${CONTACT_EMAIL}?subject=%5BPearCinema%5D%20Feedback`

const openUrl = (url) => { call('shell.openUrl', { url }).catch(() => {}) }
const copyText = (text) => call('shell.clipboard', { text }).catch(() => {})
const SHARE_TEXT = 'PearCinema - your films and TV, from your own machine or a friend\'s, playable anywhere. No port forwarding, no VPN, no account.\n\nhttps://peerloomllc.com/'

const fmtBytes = (n) => {
  const x = Number(n) || 0
  if (x >= 1e9) return (x / 1e9).toFixed(1) + ' GB'
  if (x >= 1e6) return Math.round(x / 1e6) + ' MB'
  return Math.round(x / 1e3) + ' KB'
}

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
    if (onLongPress) timer.current = setTimeout(() => { fired.current = true; haptic('medium'); onLongPress() }, 450)
  }
  const stop = (go) => {
    clearTimeout(timer.current)
    if (go && !fired.current) { haptic('light'); onPress?.() }
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

function OptionList ({ options, value, onChange }) {
  return (
    <div className='optlist'>
      {options.map((o) => (
        <button
          key={String(o.value)} className={'opt' + (value === o.value ? ' on' : '')}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          <span className='opt-main'>
            <span className='opt-name'>{o.label}</span>
            {o.desc && <span className='opt-desc'>{o.desc}</span>}
          </span>
          {value === o.value && <CheckCircle size={19} weight='fill' />}
        </button>
      ))}
    </div>
  )
}

const LAYOUT_OPTS = [
  { value: 'list', label: 'List', desc: 'One per row, with the full title' },
  { value: '2', label: 'Grid, 2 per row', desc: 'Larger posters' },
  { value: '3', label: 'Grid, 3 per row', desc: 'More on screen' }
]

const SORT_LABEL = { title: 'Title', year: 'Year', added: 'Recently added' }

function DonationSheet ({ onClose }) {
  const [hasWallet, setHasWallet] = useState(false)
  const [copied, setCopied] = useState(null)

  useEffect(() => {
    call('shell.canOpenURL', { url: 'lightning:test' })
      .then((r) => setHasWallet(!!r?.can))
      .catch(() => {})
  }, [])

  const copy = (what, value) => {
    copyText(value)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={(e) => e.stopPropagation()}>
        <h1>⚡ Bitcoin Lightning ⚡</h1>
        <p className='muted sm'>
          Support PearCinema with Bitcoin over Lightning (fast and low-fee), or
          on-chain.
        </p>

        {hasWallet && (
          <button
            className='primary wide'
            onClick={() => { openUrl('lightning:' + LIGHTNING_ADDRESS); onClose() }}
          >
            Open in your Lightning wallet
          </button>
        )}

        <h2>Lightning address</h2>
        <div className='key'>{LIGHTNING_ADDRESS}</div>
        <div className='btnrow'>
          <button onClick={() => copy('ln', LIGHTNING_ADDRESS)}>{copied === 'ln' ? 'Copied' : 'Copy'}</button>
          <button onClick={() => openUrl(STRIKE_TIP_URL)}>Pay in a browser ↗</button>
        </div>

        <h2>On-chain Bitcoin</h2>
        <div className='key'>{BTC_ONCHAIN_ADDRESS}</div>
        <div className='btnrow'>
          <button onClick={() => copy('btc', BTC_ONCHAIN_ADDRESS)}>{copied === 'btc' ? 'Copied' : 'Copy'}</button>
        </div>

        <button className='wide' style={{ marginTop: '1rem' }} onClick={onClose}>Close</button>
      </div>
    </div>
  )
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

function Tile ({ item, artBase, saved, onOpen, onLong, onSave, list = false }) {
  const press = usePress(() => onOpen(item), () => onLong(item))
  if (list) {
    // The donor's list row: same .album, flexed sideways by .grid.aslist. The
    // bookmark swallows pointer events so saving never also opens.
    const swallow = { onPointerDown: (e) => e.stopPropagation(), onPointerUp: (e) => e.stopPropagation() }
    return (
      <div className='album' {...press}>
        <Cover src={item.artId && artBase ? `${artBase}${encodeURIComponent(item.artId)}?s=120` : null} title={item.title} />
        <div className='meta'>
          <div className='t'>{item.title}</div>
          <div className='sub'>{[item.year, fmtRuntime(item.runtime)].filter(Boolean).join(' · ')}</div>
        </div>
        {onSave && (
          <button
            className={'tileheart' + (saved ? ' on' : '')} {...swallow}
            aria-label={saved ? 'Remove from watchlist' : 'Add to watchlist'}
            onClick={(e) => { e.stopPropagation(); onSave(item) }}
          >
            <BookmarkSimple size={16} weight={saved ? 'fill' : 'bold'} />
          </button>
        )}
      </div>
    )
  }
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
  const list = cols === 'list'
  return (
    <div className={'grid' + (list ? ' aslist' : '')} style={{ '--cols': list ? 1 : cols }}>
      {items.map((i) => (
        <Tile
          key={i.id} item={i} artBase={artBase} list={list}
          saved={savedSet?.has(i.id)} onOpen={onOpen} onLong={onLong} onSave={onSave}
        />
      ))}
    </div>
  )
}

// The donor's connecting screen, replacing the skeleton placeholders (Tim,
// 2026-08-15): while the library is loading or the P2P link is still waking,
// one spinning circle and a plain word - the way PearTune does it - instead
// of grey tile shapes pretending to be films.
function Loading ({ connecting = false }) {
  return (
    <div className='loadwall'>
      <ArrowsClockwise size={40} weight='thin' className='spin' />
      <h2>{connecting ? 'Connecting…' : 'Loading…'}</h2>
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

function ActionSheet ({ item, saved, watched, downloaded, onClose, onPlay, onSave, onWatched, onDownload }) {
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
          {playable && (
            <button onClick={() => { onClose(); onDownload(item, !downloaded) }}>
              <DownloadSimple size={18} /> {downloaded ? 'Remove download' : 'Download'}
            </button>
          )}
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

// The donor's onboarding: intro -> who are you -> whose library -> pair.
// PearCinema's one divergence is honest: there is no demo library, so the
// whose-card offers the two real answers. The names card feeds identity.set
// the moment pairing succeeds, so the operator's dashboard knows whose phone
// arrived without a second trip through Settings.
// The typed names survive OUTSIDE the component, the donor's rule: a pairing
// link makes the router remount everything (the pendingPairLink scar), and
// what somebody typed must not be eaten by the machinery mid-flow.
let obNames = { userName: '', deviceName: '' }

function Onboarding ({ onPaired, initialLink = '', addHost = false, onCancel = null }) {
  const [phase, setPhase] = useState(addHost ? 'pair' : 'intro')
  const [names, setNamesState] = useState(obNames)
  const setNames = (n) => { obNames = n; setNamesState(n) }
  const [owner, setOwner] = useState(null)
  const [link, setLink] = useState(initialLink)
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pendingLink = initialLink

  const named = names.userName.trim().length > 0
  const ready = (addHost || named) && !busy

  const Wordmark = () => <h1>Pear<span className='tune'>Cinema</span></h1>

  const pairWith = async (raw) => {
    setBusy(true); setError('')
    try {
      const out = await call('pair', { link: String(raw || '').trim(), label: names.deviceName.trim() })
      // The claim rides straight after the grant, so the dashboard's device
      // list names this phone from its first appearance.
      if (names.userName.trim() || names.deviceName.trim()) {
        call('identity.set', {
          userName: names.userName.trim() || undefined,
          deviceName: names.deviceName.trim() || undefined
        }).catch(() => {})
      }
      onPaired(out)
    } catch (e) { setError(e.message) }
    setBusy(false)
  }

  const scan = async () => {
    await call('shell.cameraPermission').catch(() => {})
    setScanning(true)
  }

  if (scanning) {
    return <Scanner onScan={(t) => { setScanning(false); setLink(t); pairWith(t) }} onCancel={() => setScanning(false)} />
  }

  if (phase === 'intro') {
    return (
      <div className='center onboard'>
        <Wordmark />
        <p className='muted'>Your films, or a friend's. Anywhere.</p>
        <div className='namebox obwhy'>
          <div><FilmStrip size={18} weight='bold' /><span>Plays straight off a computer you or a friend owns - an Umbrel, a NAS, an old desktop.</span></div>
          <div><LockKey size={18} weight='bold' /><span>No account, no cloud copy of the files, and nothing on that machine exposed to the internet.</span></div>
          <div><DeviceMobile size={18} weight='bold' /><span>Scan a code once and this phone is allowed in. Whoever runs the library can cut it off any time.</span></div>
        </div>
        <button className='primary' onClick={() => setPhase('names')}>Get started</button>
      </div>
    )
  }

  if (phase === 'names') {
    return (
      <div className='center onboard'>
        <Wordmark />
        <p className='muted'>Who is this?</p>
        <div className='namebox'>
          <label className='muted sm'>Your name</label>
          <input
            value={names.userName}
            onInput={(e) => setNames({ ...names, userName: e.currentTarget.value })}
            placeholder='Your name' maxLength={64}
          />
          <label className='muted sm'>This device</label>
          <input
            value={names.deviceName}
            onInput={(e) => setNames({ ...names, deviceName: e.currentTarget.value })}
            placeholder='This phone' maxLength={64}
          />
          <p className='muted sm hint'>
            Whoever runs the library sees these, so they know whose device this is.
            They confirm your name before it means anything.
          </p>
        </div>
        {pendingLink && (
          <p className='muted sm'>You opened a pairing link. Name yourself and this phone, then tap Pair.</p>
        )}
        {error && <div className='error'>{error}</div>}
        <button
          className='primary'
          onClick={() => { if (pendingLink) pairWith(pendingLink); else setPhase('whose') }}
          disabled={!ready}
        >
          {busy ? 'Pairing…' : pendingLink ? 'Pair' : 'Continue'}
        </button>
        <button onClick={() => setPhase('intro')}>Back</button>
      </div>
    )
  }

  if (phase === 'whose') {
    return (
      <div className='center onboard'>
        <Wordmark />
        <p className='muted'>PearCinema plays from a <b>PearCinema server</b>: a computer with the films on it, running the PearCinema host.</p>
        {!owner
          ? (
            <>
              <button className='primary' onClick={() => setOwner('mine')}>It's mine</button>
              <button onClick={() => setOwner('friend')}>It's a friend's</button>
            </>
            )
          : (
            <>
              <div className='namebox'>
                {owner === 'mine'
                  ? <p className='sm'>
                      Install the PearCinema host on that computer and open its dashboard - it walks you
                      through naming the library, pointing it at your films and showing a pairing code.
                      Then come back here and scan it - or copy the pairing link under the code and paste
                      it instead, at the pairing step.
                    </p>
                  : <p className='sm'>
                      Ask them to open their PearCinema dashboard and press <b>Pair a device</b>. If you are
                      with them, scan the QR code it shows. If you are not, they can copy the pairing link
                      underneath it and send it to you - you can paste that instead of scanning, at the
                      pairing step. Either way it lasts five minutes, and you do not have to be on their
                      wifi.
                    </p>}
              </div>
              {owner === 'mine' &&
                <button onClick={() => openUrl('https://peerloomllc.com/')}>How to set up a server ↗</button>}
              <button className='primary' onClick={() => setPhase('pair')}>Continue</button>
              <button onClick={() => setOwner(null)}>Back</button>
            </>
            )}
        {!owner && <button onClick={() => setPhase('names')}>Back</button>}
      </div>
    )
  }

  return (
    <div className='center onboard'>
      <Wordmark />
      <p className='muted'>
        {addHost
          ? 'Open the PearCinema dashboard on the server you want to add - yours or a friend\'s - and show its pairing code.'
          : owner === 'friend'
            ? 'Scan the pairing code from their dashboard - or paste the link they sent you.'
            : 'Show the pairing code on the server\'s dashboard and scan it - or paste the link under it.'}
      </p>
      {error && <div className='error'>{error}</div>}

      <button className='primary scanbtn' onClick={scan} disabled={!ready}>
        <QrCode size={20} weight='bold' /> Scan QR
      </button>
      <details>
        <summary className='muted sm'>Paste a link instead</summary>
        <input
          value={link}
          onInput={(e) => setLink(e.currentTarget.value)}
          placeholder='pear://pearcinema/pair?…'
          autocapitalize='none' autocorrect='off' autocomplete='off' spellcheck={false}
        />
        <button onClick={() => pairWith(link.trim())} disabled={!ready || !link.trim()}>{busy ? 'Pairing…' : 'Pair'}</button>
      </details>
      {!addHost && <button onClick={() => setPhase('names')}>Back</button>}
      {onCancel && <button onClick={onCancel}>Cancel</button>}
    </div>
  )
}

// --- the app -----------------------------------------------------------------

export default function App () {
  const [state, setState] = useState(null)
  const [tab, setTab] = useState('library')

  // Library tab.
  const [root, setRoot] = useState('movies')
  const [items, setItems] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [series, setSeries] = useState(null)
  const [season, setSeason] = useState(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  // The donor's display options: how the shelf is sorted and how dense the
  // grid is. Persisted in the worklet's settings so they survive a restart.
  const [sortField, setSortField] = useState('')
  const [sortOrder, setSortOrder] = useState('asc')
  const [cols, setCols] = useState(2)
  const [showRecent, setShowRecent] = useState(true)
  const [dataSaver, setDataSaver] = useState(false)
  // The player skins - cosmetic overlays drawn by the shell, PearTune's
  // Winamp-toggle pattern. The 35mm skin's tone is the exception: a phone
  // cannot repaint a native video surface, so a tone rides the capability
  // declaration and the BOX presses it into the picture.
  const [playerSkin, setPlayerSkin] = useState('off')
  const [playerTone, setPlayerTone] = useState('off')
  const [showDisplay, setShowDisplay] = useState(false)
  const setDisplay = (patch) => {
    if ('sortField' in patch) setSortField(patch.sortField)
    if ('sortOrder' in patch) setSortOrder(patch.sortOrder)
    if ('cols' in patch) setCols(patch.cols)
    if ('showRecent' in patch) setShowRecent(patch.showRecent)
    call('setSettings', {
      sortField: patch.sortField ?? sortField,
      sortOrder: patch.sortOrder ?? sortOrder,
      cols: patch.cols ?? cols,
      showRecent: patch.showRecent ?? showRecent
    }).catch(() => {})
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
  const [dlRows, setDlRows] = useState(null)
  const [dlRunning, setDlRunning] = useState([])
  const [dlIds, setDlIds] = useState(new Set())
  // The armed two-tap revoke, the same pattern Leave uses - a WebView's
  // confirm() is at the shell's mercy.
  const [arming, setArming] = useState(null)
  const [themePref, setThemePref] = useState(loadThemePref())
  const [settingsOpen, setSettingsOpen] = useState(null)
  const toggleSection = (id) => setSettingsOpen((cur) => (cur === id ? null : id))
  const [aboutOpen, setAboutOpen] = useState(null)
  const toggleAbout = (id) => setAboutOpen((cur) => (cur === id ? null : id))
  const [donate, setDonate] = useState(false)

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
  const [linkUp, setLinkUp] = useState(false)

  const retried = useRef(new Set())
  // What sits on either side of the playing episode, kept here because the
  // native player's Previous/Next buttons only hand back an intent - the UI
  // owns which episode that intent lands on.
  const navRef = useRef(null)
  const playRef = useRef(null)
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
      on('host:connected', () => setLinkUp(true)),
      on('host:disconnected', () => setLinkUp(false)),
      on('download:progress', (d) => {
        setDlRunning((rows) => {
          const rest = rows.filter((r) => r.itemId !== d.itemId)
          return [...rest, d]
        })
      }),
      on('download:done', (d) => {
        setDlRunning((rows) => rows.filter((r) => r.itemId !== d.itemId))
        say('Downloaded - plays with no connection now')
        loadYou('downloads')
      }),
      on('download:failed', (d) => {
        setDlRunning((rows) => rows.filter((r) => r.itemId !== d.itemId))
        if (d?.reason !== 'cancelled') setErr('Download failed: ' + (d?.reason || 'unknown'))
        loadYou('downloads')
      }),
      on('download:removed', () => loadYou('downloads')),
      on('shim:ready', () => reload().catch(() => {})),
      // News from the host, mostly about THIS PERSON's other devices - the
      // donor's exceptSelf pushes, so what one phone does the others follow
      // without a reopen. Each handler updates the cheap local state from the
      // payload and reloads only a view that is actually on screen.
      on('host:push', (m) => {
        const u = uiRef.current
        if (m?.kind === 'grant:changed') {
          // The operator moved this device to a (different) person - the
          // shelves on screen are somebody else's now.
          setContinueRows(null)
          if (u.tab === 'you') loadYouRef.current?.(u.youView)
        }
        if (m?.kind === 'resume:changed') {
          // Another of this person's devices moved a film. Put a phone down
          // mid-film and this one's Continue shelf already carries the minute.
          setContinueRows(null)
          if (u.tab === 'you' && u.youView === 'continue') loadYouRef.current?.('continue')
        }
        if (m?.kind === 'favorites:changed' && m.data) {
          setSaved((s) => { const n = new Set(s); m.data.on ? n.add(m.data.id) : n.delete(m.data.id); return n })
          if (u.tab === 'watchlist') call('fav.list').then((r) => setSavedItems(r.items || [])).catch(() => {})
        }
        if (m?.kind === 'watched:changed' && m.data) {
          setWatchedIds((s) => { const n = new Set(s); m.data.watched ? n.add(m.data.itemId) : n.delete(m.data.itemId); return n })
          if (u.tab === 'you' && u.youView === 'watched') loadYouRef.current?.('watched')
        }
        if (m?.kind === 'request:resolved' && m.data) {
          say(m.data.status === 'added'
            ? `Your request${m.data.title ? ' for ' + m.data.title : ''} was added`
            : `Your request${m.data.title ? ' for ' + m.data.title : ''} was declined`)
          if (u.tab === 'you' && u.youView === 'requests') loadYouRef.current?.('requests')
        }
      }),
      on('player:tick', (d) => {
        if (d?.itemId && d.positionMs > 0) call('resume.set', { itemId: d.itemId, positionMs: d.positionMs }).catch(() => {})
      }),
      on('player:closed', async (d) => {
        if (d?.itemId && d.positionMs > 0) await call('resume.set', { itemId: d.itemId, positionMs: d.positionMs }).catch(() => {})
        // Refetch the shelf people are LOOKING at. Nulling alone left You >
        // Continue on its skeleton forever when the player was opened from it,
        // because the tab effect only fires on arrival (Tim, 2026-08-15).
        setContinueRows(null)
        if (uiRef.current.tab === 'you') loadYouRef.current?.(uiRef.current.youView)
      }),
      on('player:nav', async (d) => {
        const nav = navRef.current
        if (!nav || nav.itemId !== d?.itemId) return
        const target = d.direction === 'prev' ? nav.prev : nav.next
        if (!target) return
        // The episode being left keeps its place, same contract as closing.
        if (d.positionMs > 0) call('resume.set', { itemId: d.itemId, positionMs: d.positionMs }).catch(() => {})
        try {
          const [{ url }, prior] = await Promise.all([
            call('stream.url', { itemId: target.id }),
            call('resume.get', { itemId: target.id }).catch(() => null)
          ])
          // No resume OFFER here: the native player covers the screen, so a
          // sheet under it would be an invisible question. A part-watched
          // episode just resumes; scrubbing back is one gesture.
          await playRef.current(target, url, prior?.resume?.positionMs > 0 ? prior.resume.positionMs : 0)
        } catch (e) { setErr(e.message) }
      }),
      // The viewer chose image subtitles (or turned them off): the host has to
      // press them into the frames, which is a different stream - so this is a
      // restart at the same position, burned or clean.
      on('player:burn', async (d) => {
        if (!d?.itemId) return
        try {
          const { url } = await call('stream.url', {
            itemId: d.itemId,
            ...(d.subtitleId ? { burnSubtitleId: d.subtitleId } : {})
          })
          await call('shell.play', {
            itemId: d.itemId,
            url,
            title: d.title || '',
            startMs: d.positionMs || 0,
            ...(d.subtitleId ? { burnedSubtitleId: d.subtitleId } : {})
          })
        } catch (e) { setErr(e.message) }
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
    // THE GENERAL RULE (Tim, 2026-08-15): almost everything tappable answers
    // the finger. One capture-phase listener covers every <button> in the app -
    // capture, so a handler's own stopPropagation cannot silence it - and
    // usePress covers the pointer-driven tiles and rows that are not buttons.
    const feel = (e) => { if (e.target?.closest?.('button')) haptic('light') }
    document.addEventListener('click', feel, true)
    const offTheme = onSystemThemeChange(() => applyThemePref(loadThemePref(), { persist: false }))
    window.__pearBack = () => {
      const u = uiRef.current
      if (u.sheet) return setSheet(null)
      if (u.donate) return setDonate(false)
      if (u.showDisplay) return setShowDisplay(false)
      if (u.resumeOffer) return setResumeOffer(null)
      if (u.addingLibrary) return setAddingLibrary(false)
      if (u.season) return setSeason(null)
      if (u.series) return setSeries(null)
      if (u.tab !== 'library') return setTab('library')
      call('shell.exit').catch(() => {})
    }
    return () => { offs.forEach((f) => f()); offTheme(); document.removeEventListener('click', feel, true) }
  }, [])

  uiRef.current = { youView, sheet: !!sheet, donate, showDisplay, resumeOffer: !!resumeOffer, addingLibrary, season: !!season, series: !!series, tab }

  // --- library data ---------------------------------------------------------

  const fetchList = useCallback(async (params, append = false) => {
    try {
      const page = await call('library.list', params)
      setItems((prev) => (append ? [...(prev || []), ...(page.items || [])] : (page.items || [])))
      setCursor(page.cursor || null)
      setErr('')
    } catch (e) {
      // An error ends the skeleton - a placeholder that never resolves reads
      // as a hang, and the error line says what actually happened.
      setItems((prev) => prev || [])
      setErr(e.message)
    }
  }, [])

  useEffect(() => {
    if (!state?.active) return
    setItems(null); setCursor(null)
    if (season) fetchList({ type: 'episodes', seasonId: season.id, limit: 200 })
    else if (series) fetchList({ type: 'seasons', seriesId: series.id, limit: 100 })
    else fetchList({ type: root, limit: 100, sort: sortField || 'title', order: sortOrder })
  }, [state?.active?.hostKey, root, series?.id, season?.id, sortField, sortOrder])

  // The recently-added strip: the newest arrivals by file date, shown only
  // when something actually arrived in the last month - an empty shelf is
  // noise, and a shelf of years-old files is a lie about the word recently.
  const [recentRows, setRecentRows] = useState([])
  useEffect(() => {
    if (!state?.active) return
    call('library.list', { type: 'movies', sort: 'added', order: 'asc', limit: 12 })
      .then((r) => {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
        setRecentRows((r.items || []).filter((i) => i.addedAt && i.addedAt >= cutoff))
      })
      .catch(() => setRecentRows([]))
  }, [state?.active?.hostKey])

  // The saved display prefs, once the worklet answers.
  useEffect(() => {
    call('getSettings').then((s) => {
      if (['title', 'year', 'added', ''].includes(s?.sortField)) setSortField(s.sortField || '')
      if (['asc', 'desc'].includes(s?.sortOrder)) setSortOrder(s.sortOrder)
      if (['list', 2, 3].includes(s?.cols)) setCols(s.cols)
      if (typeof s?.showRecent === 'boolean') setShowRecent(s.showRecent)
      if (typeof s?.dataSaver === 'boolean') setDataSaver(s.dataSaver)
      if (['off', 'film', 'mst3k'].includes(s?.playerSkin)) setPlayerSkin(s.playerSkin)
      if (['off', 'bw', 'sepia'].includes(s?.playerTone)) setPlayerTone(s.playerTone)
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

  const loadYouRef = useRef(null)
  const loadYou = async (view) => {
    try {
      if (view === 'continue') setContinueRows((await call('resume.list', { limit: 30 })).items || [])
      if (view === 'watched') {
        const ids = [...new Set((await call('watched.list')).items || [])].slice(0, 60)
        const rows = await Promise.all(ids.map((id) => call('library.get', { id }).catch(() => null)))
        setWatchedRows(rows.filter(Boolean))
      }
      if (view === 'requests') setRequests((await call('request.list')).items || [])
      if (view === 'downloads') {
        const out = await call('download.list')
        setDlRunning(out.running || [])
        setDlIds(new Set((out.items || []).map((i) => i.itemId)))
        const rows = await Promise.all((out.items || []).map(async (i) => {
          const item = await call('library.get', { id: i.itemId }).catch(() => null)
          // Offline (or a host that dropped the item): the download's own
          // stored meta names the row instead of 'A removed title'.
          return item ? { ...item, _dlSize: i.size } : { id: i.itemId, title: i.title || 'A removed title', year: i.year || null, runtime: i.runtime || null, _dlSize: i.size }
        }))
        setDlRows(rows)
      }
      if (view === 'manage') {
        setDevices((await call('device.list')).items || [])
        setAllRequests((await call('request.all')).items || [])
      }
    } catch (e) { setErr(e.message) }
  }

  loadYouRef.current = loadYou

  // --- actions --------------------------------------------------------------

  const play = async (item, url, startMs) => {
    try { await call('shell.play', { itemId: item.id, url, title: item.title, startMs, skin: playerSkin }) } catch (e) { setErr(e.message); return }
    // Episode neighbours arrive AFTER playback starts, so the lookup never
    // delays first frames. Offline or on a film the catch leaves the buttons
    // off, which is the honest answer in both cases.
    if (item.type !== 'episode') { navRef.current = null; return }
    try {
      const { prev, next } = await call('library.siblings', { id: item.id })
      navRef.current = (prev || next) ? { itemId: item.id, prev, next } : null
      if (navRef.current) await call('shell.navSet', { itemId: item.id, hasPrev: !!prev, hasNext: !!next })
    } catch { navRef.current = null }
  }
  playRef.current = play

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
      haptic('success')
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
  if (!state.active) return <Onboarding initialLink={pairLink} onPaired={() => reload()} />

  if (addingLibrary) {
    return (
      <Onboarding
        initialLink={pairLink} addHost
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

      {items == null && !results && <Loading connecting={!linkUp} />}

      {!series && !results && root === 'movies' && showRecent && recentRows.length > 0 && (
        <div className='shelf'>
          <h2 className='shelf-head'>Recently added</h2>
          <div className='shelf-scroll'>
            <div className='shelf-row'>
              {recentRows.map((i) => (
                <button key={i.id} className='shelf-item' onClick={() => open(i)}>
                  <Cover src={i.artId && artBase ? `${artBase}${encodeURIComponent(i.artId)}?s=200` : null} title={i.title} />
                  <div className='shelf-t'>{i.title}</div>
                  <div className='shelf-a'>{[i.year, fmtRuntime(i.runtime)].filter(Boolean).join(' · ')}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {items != null && (results
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
          : <Grid items={items} artBase={artBase} savedSet={saved} onOpen={open} onLong={longPress} onSave={!series ? toggleSave : null} cols={cols} />)}

      {!results && cursor && (
        <button
          className='ghost' style={{ margin: '0.8rem auto', display: 'block' }}
          onClick={() => fetchList(season ? { type: 'episodes', seasonId: season.id, limit: 200, cursor } : series ? { type: 'seasons', seriesId: series.id, limit: 100, cursor } : { type: root, limit: 100, cursor, sort: sortField || 'title', order: sortOrder }, true)}
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
        ? <Loading connecting={!linkUp} />
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
          ? <Loading connecting={!linkUp} />
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
          ? <Loading connecting={!linkUp} />
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
        <>
          {dlRunning.length > 0 && (
            <ul className='tracks'>
              {dlRunning.map((r) => (
                <li className='track' key={r.itemId}>
                  <div className='meta' style={{ flex: 1 }}>
                    <div className='t'>Downloading…</div>
                    <div className='sub muted sm'>{fmtBytes(r.got)} of {r.approx ? 'about ' : ''}{fmtBytes(r.size)}</div>
                    <div className='bar'><div className='fill' style={{ width: `${Math.min(100, Math.round((r.got / (r.size || 1)) * 100))}%` }} /></div>
                  </div>
                  <button className='ghost' onClick={() => call('download.cancel', { itemId: r.itemId })}>Cancel</button>
                </li>
              ))}
            </ul>
          )}
          {dlRows == null
            ? <Loading connecting={!linkUp} />
            : dlRows.length === 0 && dlRunning.length === 0
              ? (
                <div className='center-p muted'>
                  <p>Nothing saved for offline.</p>
                  <p className='sm'>Hold a film and choose Download - it plays with no connection once it is here.</p>
                </div>
                )
              : (
                <ul className='tracks'>
                  {dlRows.map((r) => (
                    <ItemRow
                      key={r.id} item={r} onOpen={open} onLong={longPress}
                      sub={`${fmtBytes(r._dlSize)} on this phone`}
                      right={<button className='ghost' onClick={(e) => { e.stopPropagation(); call('download.remove', { itemId: r.id }) }}><Trash size={16} /></button>}
                    />
                  ))}
                </ul>
                )}
        </>
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
                    {!d.self && (arming === d.deviceKey
                      ? <button className='danger' onClick={() => { setArming(null); call('device.revoke', { deviceKey: d.deviceKey }).then(() => { say('Cut off - within the second'); loadYou('manage') }).catch((e) => setErr(e.message)) }}>Really cut off?</button>
                      : <button className='ghost' onClick={() => setArming(d.deviceKey)}>Revoke</button>)}
                  </li>
                ))}
              </ul>
              )}
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
              haptic('success')
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
          <div className='libactions'>
            <button className='libact' aria-label='Add a library' title='Add a library' onClick={() => setAddingLibrary(true)}>
              <Plus size={22} weight='bold' />
              <span>Add server</span>
            </button>
            <button className='libact' aria-label='Pair as owner' title='Pair as owner - manage a server you run' onClick={() => setAddingLibrary(true)}>
              <UsersThree size={22} weight='bold' />
              <span>Pair as owner</span>
            </button>
          </div>
          {hosts.map((h) => {
            const online = h.active && linkUp
            const desc = h.active
              ? (linkUp ? 'Active - connected' : 'Active - connecting…')
              : 'Tap to switch to this library'
            return (
              <div
                className='row' key={h.hostKey}
                onClick={() => { if (!h.active) call('hosts.setActive', { hostKey: h.hostKey }).then(() => { setSeries(null); setSeason(null); reload() }) }}
                style={{ cursor: h.active ? 'default' : 'pointer' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className='label'>
                    {h.libraryName || 'Library'}
                    {h.active && (
                      <span className='val' style={{ color: online ? 'var(--color-primary)' : undefined, marginLeft: 8 }}>
                        {online ? '●' : '○'}
                      </span>
                    )}
                  </div>
                  <div className='desc'>{desc}</div>
                </div>
                <div className='rowacts'>
                  <button className='rowremove' aria-label={'Remove ' + (h.libraryName || 'library')} onClick={(e) => { e.stopPropagation(); call('hosts.remove', { hostKey: h.hostKey }).then(() => reload()) }}>
                    <Trash size={19} weight='regular' />
                  </button>
                </div>
              </div>
            )
          })}
        </Section>

        <Section id='streaming' title='Streaming and downloads' Icon={DownloadSimple} open={settingsOpen === 'streaming'} onToggle={toggleSection}>
          <div className='label'>Streaming quality</div>
          <OptionList
            options={[
              { value: 'auto', label: 'Full quality', desc: 'The file as it is; your box converts only when this phone cannot play it' },
              { value: 'saver', label: 'Data saver', desc: 'Capped near 2.5 Mbps - your box converts bigger films down. For cellular and slow links' }
            ]}
            value={dataSaver ? 'saver' : 'auto'}
            onChange={(v) => { setDataSaver(v === 'saver'); call('setSettings', { dataSaver: v === 'saver' }).catch(() => {}) }}
          />
          <p className='desc' style={{ marginTop: '.6rem' }}>Downloads always take the full file. A size cap for them arrives with the offline polish.</p>
        </Section>

        <Section id='appearance' title='Appearance' Icon={Palette} open={settingsOpen === 'appearance'} onToggle={toggleSection}>
          <div className='label'>Theme</div>
          <div className='seg'>
            {[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']].map(([k, l]) => (
              <button
                key={k} className={themePref === k ? 'on' : ''}
                aria-pressed={themePref === k}
                onClick={() => { setThemePref(k); applyThemePref(k) }}
              >{l}</button>
            ))}
          </div>
          <div className='row' style={{ marginTop: '.7rem' }}>
            <div>
              <div className='label'>Recently added row</div>
              <div className='desc'>The row of newest films above your library.</div>
            </div>
            <button
              className={'toggle' + (showRecent ? ' on' : '')} role='switch' aria-checked={showRecent}
              onClick={() => setDisplay({ showRecent: !showRecent })}
            >{showRecent ? 'On' : 'Off'}</button>
          </div>

          <div className='label' style={{ marginTop: '.7rem' }}>Player skin</div>
          <div className='seg'>
            {[['off', 'None'], ['film', '35mm film'], ['mst3k', 'Theater']].map(([k, l]) => (
              <button
                key={k} className={playerSkin === k ? 'on' : ''}
                aria-pressed={playerSkin === k}
                onClick={() => { setPlayerSkin(k); call('setSettings', { playerSkin: k }).catch(() => {}) }}
              >{l}</button>
            ))}
          </div>
          <div className='desc'>
            A look laid over the player - sprocket holes and a film border, or a
            theater row of silhouettes. Just for fun, off by default.
          </div>
          {playerSkin === 'film' && (
            <>
              <div className='label' style={{ marginTop: '.7rem' }}>Film tone</div>
              <div className='seg'>
                {[['off', 'Color'], ['bw', 'Black & white'], ['sepia', 'Sepia']].map(([k, l]) => (
                  <button
                    key={k} className={playerTone === k ? 'on' : ''}
                    aria-pressed={playerTone === k}
                    onClick={() => { setPlayerTone(k); call('setSettings', { playerTone: k }).catch(() => {}) }}
                  >{l}</button>
                ))}
              </div>
              <div className='desc'>
                A tone is pressed into the picture by your box's video hardware, so a
                toned film streams as a conversion and starts a moment slower.
              </div>
            </>
          )}
        </Section>
      </div>

      <div className='version'>v{APP_VERSION}</div>
    </div>
  )

  const aboutScreen = (
    <div className='app'>
      <div className='wordmark'>
        <div className='name'>Pear<span className='tune'>Cinema</span></div>
        <div className='muted sm'>Your films, or a friend's. Anywhere.</div>
      </div>

      <Section id='how' title='How it works' Icon={Info} open={aboutOpen === 'how'} onToggle={toggleAbout}>
        <p>
          PearCinema plays your films and shows straight off the machine they
          already live on - an Umbrel, a NAS, an old desktop - over an encrypted
          peer-to-peer connection. No port forwarding, no VPN, no dynamic DNS, no
          account, and no copy of your library in anyone's cloud.
        </p>
        <p>
          The machine does not have to be yours. Whoever runs a library can let a
          friend or family member in, each as their own person with their own
          devices, watchlist and resume points - no login to pass around, and no
          copy of a single file.
        </p>
        <p>
          The server keeps the list of which devices are allowed in, and can cut one
          off in the middle of a film.
        </p>
        <p>
          PearCinema ships with no relay at all: every stream is a direct
          peer-to-peer connection, and nothing of yours ever crosses a server run
          by anyone else.
        </p>
        <div className='btnrow'>
          <button onClick={() => openUrl('https://pears.com/')}>Learn about P2P ↗</button>
        </div>
      </Section>

      <Section id='device' title='This device' Icon={Key} open={aboutOpen === 'device'} onToggle={toggleAbout}>
        <p>
          The key a library knows this phone by. When someone running a server asks which
          device is yours, or you are deciding what to remove on their dashboard, this is
          the row to look for.
        </p>
        <div className='key'>{state.deviceKey}</div>
        <div className='btnrow'>
          <button onClick={() => { copyText(state.deviceKey); haptic('success'); say('Copied') }}>
            <Copy size={15} /> Copy key
          </button>
        </div>
      </Section>

      <Section id='support' title='Support development' Icon={Heart} open={aboutOpen === 'support'} onToggle={toggleAbout}>
        <p>PearCinema is free and open source. If it brings you value, consider sending a little back.</p>
        <div className='btnrow'>
          <button className='primary' onClick={() => setDonate(true)}>⚡ Bitcoin ⚡</button>
          <button onClick={() => openUrl(BUYMEACOFFEE_URL)}>$ USD $</button>
        </div>
      </Section>

      <Section id='btc' title='Learn about Bitcoin' Icon={CurrencyBtc} open={aboutOpen === 'btc'} onToggle={toggleAbout}>
        <p>
          New to Bitcoin? The Satoshi Nakamoto Institute has a free, concise crash
          course on how it works and why it matters.
        </p>
        <div className='btnrow'>
          <button onClick={() => openUrl('https://nakamotoinstitute.org/crash-course/')}>Bitcoin Crash Course ↗</button>
        </div>
      </Section>

      <Section id='oss' title='Open source' Icon={Code} open={aboutOpen === 'oss'} onToggle={toggleAbout}>
        <p>PearCinema is open source under the MIT license. Read the code, file an issue, or contribute.</p>
        <div className='btnrow'>
          <button onClick={() => openUrl(GITHUB_URL)}>View on GitHub ↗</button>
        </div>
      </Section>

      <Section id='share' title='Share the app' Icon={ShareNetwork} open={aboutOpen === 'share'} onToggle={toggleAbout}>
        <p>
          Know someone with a film collection and no good way to reach it from
          their phone? Share PearCinema.
        </p>
        <div className='btnrow'>
          <button onClick={() => call('shell.share', { title: 'PearCinema', text: SHARE_TEXT }).catch(() => {})}>
            Share PearCinema
          </button>
        </div>
      </Section>

      <Section id='contact' title='Contact' Icon={EnvelopeSimple} open={aboutOpen === 'contact'} onToggle={toggleAbout}>
        <div className='btnrow'>
          <button onClick={() => openUrl(CONTACT_URL)}>Email</button>
          <button onClick={() => openUrl(GITHUB_URL + '/issues')}>Issue</button>
        </div>
      </Section>

      <div className='version'>v{APP_VERSION}</div>
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
          downloaded={dlIds.has(sheet.id)}
          onClose={() => setSheet(null)} onPlay={open} onSave={toggleSave} onWatched={markWatched}
          onDownload={(i, want) => {
            if (want) {
              call('download.start', { itemId: i.id }).then(() => { setDlIds((x) => new Set(x).add(i.id)); say('Downloading - watch it in You, Downloads') }).catch((e) => setErr(e.message))
            } else {
              call('download.remove', { itemId: i.id }).then(() => { setDlIds((x) => { const n = new Set(x); n.delete(i.id); return n }); say('Removed from this phone') })
            }
          }}
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
            <h1>Display</h1>
            <div className='dispsec'>
              <div className='displabel'>Layout</div>
              <OptionList
                options={LAYOUT_OPTS} value={String(cols)}
                onChange={(v) => setDisplay({ cols: v === 'list' ? 'list' : Number(v) })}
              />
            </div>
            <div className='dispsec'>
              <div className='displabel'>
                <span>Sort by</span>
                {sortField && (
                  <button
                    className='dirtoggle'
                    onClick={() => setDisplay({ sortOrder: sortOrder === 'asc' ? 'desc' : 'asc' })}
                    aria-label={sortOrder === 'asc' ? 'Ascending - tap for descending' : 'Descending - tap for ascending'}
                  >
                    {sortOrder === 'desc' ? <ArrowDown size={15} weight='bold' /> : <ArrowUp size={15} weight='bold' />}
                    {sortOrder === 'asc' ? 'Ascending' : 'Descending'}
                  </button>
                )}
              </div>
              <OptionList
                options={[{ value: '', label: 'Default order' }, ...['title', 'year', 'added'].map((k) => ({ value: k, label: SORT_LABEL[k] }))]}
                value={sortField}
                onChange={(v) => setDisplay({ sortField: v, sortOrder: 'asc' })}
              />
            </div>
            <div className='acts'><button className='wide' onClick={() => setShowDisplay(false)}>Done</button></div>
          </div>
        </div>
      )}

      {donate && <DonationSheet onClose={() => setDonate(false)} />}

      {toast && <div className='toast'>{toast}</div>}
    </div>
  )
}
