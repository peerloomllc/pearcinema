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
  CheckCircle, DownloadSimple, UsersThree, EnvelopeSimple, CaretLeft, CaretDown, Plus,
  QrCode, Trash, ArrowsLeftRight, SignOut, ShareNetwork, GithubLogo,
  Lightning, Coffee, EnvelopeOpen, CaretRight, SlidersHorizontal,
  ArrowUp, ArrowDown, Palette, Key, Copy, CurrencyBtc, Code, LockKey, DeviceMobile,
  Screencast, Pause, Prohibit, Rewind, FastForward, Broadcast
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
const SHARE_TEXT = 'PearCinema. Your films and TV, from your own machine or a friend\'s, playable anywhere. No port forwarding, no VPN, no account.\n\nhttps://peerloomllc.com/'

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
// A BUTTON INSIDE A PRESSABLE ROW IS NOT PART OF THE ROW, and this is the one place
// that can promise it. A row is driven by pointerdown and pointerup; a button inside it
// stops the CLICK, which happens afterwards - so pressing the delete on a download
// opened the film AND removed it on the way out (Tim, 2026-08-19). The Unmark button on
// the Watched list had the same fault, quietly.
//
// Checked on the event's own target rather than by adding a second listener that stops
// propagation: one rule, in one place, that a new row-button cannot forget to apply.
const insideControl = (e) => !!e.target?.closest?.('button, a, input, select, label')

function usePress (onPress, onLongPress) {
  const timer = useRef(null)
  const fired = useRef(false)
  const skip = useRef(false)
  const start = (e) => {
    skip.current = insideControl(e)
    if (skip.current) return
    fired.current = false
    if (onLongPress) timer.current = setTimeout(() => { fired.current = true; haptic('medium'); onLongPress() }, 450)
  }
  const stop = (go, e) => {
    // A press that STARTED on a control is not this row's press, however it ends.
    if (skip.current || (e && insideControl(e))) { clearTimeout(timer.current); return }
    clearTimeout(timer.current)
    if (go && !fired.current) { haptic('light'); onPress?.() }
  }
  return {
    onPointerDown: start,
    onPointerUp: (e) => stop(true, e),
    onPointerLeave: (e) => stop(false, e),
    onPointerCancel: (e) => stop(false, e),
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

// A real switch: a track the knob slides across, rather than a pill reading On or Off.
// One component so every setting flips the same way and feels the same doing it.
//
// The haptic is HERE rather than left to the app-wide click handler, which fires the same
// light tap on every button in the app. A switch is a state change rather than a
// navigation, so it gets the heavier impact - and it fires on the way in, before the
// re-render, so the tap lands with the knob's movement rather than after it.
function Switch ({ on, onChange, label }) {
  return (
    <button
      className={'switch' + (on ? ' on' : '')}
      role='switch'
      aria-checked={on}
      aria-label={label}
      onClick={() => { haptic('medium'); onChange(!on) }}
    >
      <span className='knob' />
    </button>
  )
}

// How much of this phone the films may use. Ascending, because a slider's axis has to mean
// something, and a film is a thousand times a song - PearTune's 512 MB floor would hold
// about one film and evict it on the next play.
const FILM_CAPS = [
  { value: 1024 * 1024 * 1024, label: '1 GB', desc: 'About one film kept at a time' },
  { value: 2 * 1024 * 1024 * 1024, label: '2 GB' },
  { value: 5 * 1024 * 1024 * 1024, label: '5 GB' },
  { value: 10 * 1024 * 1024 * 1024, label: '10 GB' },
  { value: 0, label: 'No limit', desc: 'Keep every film until you clear it yourself' }
]

// A discrete slider over an ordered list, ported from PearTune (Tim, 2026-08-18: "we have
// several sliders for data storage... we should probably copy this").
//
// Built on <input type=range> rather than a hand-rolled div: that buys correct touch
// handling, tap-to-position, keyboard arrows and a real slider role for free, none of
// which are the interesting part and all of which are easy to get subtly wrong.
//
// The value commits on CHANGE (pointer up), not on INPUT. Dragging across four stops would
// otherwise fire four writes, and each one can trigger an eviction pass - so a drag from
// No limit down to 1 GB would start deleting films at every stop on the way past.
function StepSlider ({ options, value, onChange, ariaLabel }) {
  const at = Math.max(0, options.findIndex((o) => o.value === value))
  // A local index so the label follows the finger while the committed value has not moved.
  const [draft, setDraft] = useState(null)
  const i = draft ?? at
  const cur = options[i] || options[0]
  useEffect(() => { setDraft(null) }, [value])

  return (
    <div className='stepslider'>
      <input
        type='range' min={0} max={options.length - 1} step={1} value={i}
        aria-label={ariaLabel}
        // The number means nothing to a screen reader; the label is the actual value.
        aria-valuetext={cur.label}
        onInput={(e) => {
          const n = Number(e.currentTarget.value)
          if (n !== i) haptic('light') // a detent per stop, so a drag feels like steps
          setDraft(n)
        }}
        onChange={(e) => {
          const n = Number(e.currentTarget.value)
          setDraft(n)
          if (options[n] && options[n].value !== value) onChange(options[n].value)
        }}
      />
      <div className='stepslider-ticks' aria-hidden='true'>
        {options.map((o, n) => <span key={String(o.value)} className={n <= i ? 'on' : ''} />)}
      </div>
      <div className='stepslider-read'>
        <span className='stepslider-name'>{cur.label}</span>
        {cur.desc && <span className='stepslider-desc'>{cur.desc}</span>}
      </div>
    </div>
  )
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

// HOW MANY PLACES THE CONTINUE LIST SHOWS before the rest go behind Show all.
// Twelve is comfortably more than anybody is part way through at once.
const SHELF_MAX = 12

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

// How far a skip on the cast bar moves. Thirty rather than the player's ten:
// a converted cast skips by re-minting the stream, so a jump costs a real
// pause, and ten seconds is a poor trade for one. Ten is right in the phone's
// own player, where it is free.
const SKIP_MS = 30000

const TABS = [
  { key: 'library', label: 'Library', Icon: FilmStrip },
  { key: 'you', label: 'You', Icon: Heart },
  { key: 'watchlist', label: 'Watchlist', Icon: BookmarkSimple },
  { key: 'settings', label: 'Settings', Icon: Gear },
  { key: 'about', label: 'About', Icon: Info }
]

function NavBar ({ active, onTab, saved = 0, busy = 0 }) {
  return (
    <nav className='navbar'>
      {TABS.map(({ key, label, Icon }) => {
        const onNow = active === key
        const badge = key === 'watchlist' && saved > 0 ? saved : null
        // A light rather than a count, matching the desktop topbar: progress
        // lives in You, Downloads, the tab only says "look there".
        const dot = key === 'you' && busy > 0
        const dotLabel = busy === 1 ? 'One download running' : `${busy} downloads running`
        return (
          <button
            key={key} className={onNow ? 'on' : ''} onClick={() => onTab(key)}
            aria-current={onNow ? 'page' : undefined}
            aria-label={dot ? `${label}. ${dotLabel}` : label}
          >
            <span className='ic'>
              <Icon size={22} weight={onNow ? 'fill' : 'regular'} />
              {badge && <span className='badge'>{badge > 99 ? '99+' : badge}</span>}
              {dot && <span className='dot' aria-hidden='true' />}
            </span>
            <span>{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

// A poster that is still arriving must not look like a poster that is missing, and
// neither may look like a bug (Tim, 2026-08-18, watching a library load over a relay:
// "a bunch of empty posters with the badges"). Artwork crosses the relay one file at a
// time, so on a slow link every tile was an empty box with a badge floating on it.
//
// So the initials are ALWAYS drawn, and the image fades in on top once it has actually
// decoded. A tile therefore starts as a deliberate-looking placeholder and becomes a
// poster - never a hole. The grid still appears the instant the titles do: waiting for
// every poster before showing anything would trade a scruffy library for a blank screen,
// which on a big library over a relay is minutes of nothing.
function Cover ({ src, title, onArt = null }) {
  const [loaded, setLoaded] = useState(false)
  const img = useRef(null)
  // A CACHED IMAGE CAN FINISH BEFORE THE HANDLER IS ATTACHED, and then `load` never
  // fires for it - so the poster sat at opacity 0 over its own initials and the tile
  // read as artwork-less (Tim, 2026-08-20: 300 had its poster in the library and a
  // placeholder on its title page).
  //
  // WHY IT ONLY SHOWED UP ON THE SECOND SCREEN. The first request for a cover crosses
  // P2P and takes long enough that the element is listening by the time it lands. The
  // shim then holds it in RAM, on disk and behind a day of `cache-control`, so every
  // later request for that exact URL is answered instantly - and instantly is what
  // beats the listener. The library grid is almost always somebody's first sight of a
  // poster and the title page is almost always their second, which is why it looked
  // like the page was broken rather than the component.
  //
  // Asking the element whether it is already done is the fix, and it costs one check
  // per render of a tile.
  useEffect(() => {
    setLoaded(false)
    const el = img.current
    if (el && el.complete && el.naturalWidth > 0) {
      setLoaded(true)
      if (onArt) onArt()
    }
  }, [src])
  // `onArt` fires on SETTLED, not on success: a tile with no artwork at all, or one whose
  // poster fails, has finished as far as a screen waiting on it is concerned.
  useEffect(() => { if (onArt && !src) onArt() }, [src])
  return (
    <div className='cover ph'>
      <span className='blank'>{(title || '?').slice(0, 2)}</span>
      {src && (
        <img
          ref={img}
          src={src} loading='lazy' alt='' draggable={false} className={'poster' + (loaded ? ' in' : '')}
          onLoad={() => { setLoaded(true); if (onArt) onArt() }}
          // A poster that 404s or dies mid-transfer leaves the initials showing rather
          // than a broken-image glyph.
          onError={() => { setLoaded(false); if (onArt) onArt() }}
        />
      )}
    </div>
  )
}

function Tile ({ item, artBase, saved, onOpen, onLong, onSave, list = false, onArt = null, unreachable = false }) {
  const press = usePress(() => onOpen(item), () => onLong(item))
  // DIM MEANS THERE IS NO WAY TO PLAY THIS ONE: no library that has it is answering,
  // and this phone is not holding a copy. A film that is downloaded, or that a second
  // library also has, is not dim and opens normally - see reach() above.
  const cls = 'album' + (unreachable ? ' unreachable' : '')
  if (list) {
    // The donor's list row: same .album, flexed sideways by .grid.aslist. The
    // bookmark swallows pointer events so saving never also opens.
    const swallow = { onPointerDown: (e) => e.stopPropagation(), onPointerUp: (e) => e.stopPropagation() }
    return (
      <div className={cls} {...press}>
        <Cover src={item.artId && artBase ? `${artBase}${encodeURIComponent(item.artId)}?s=120` : null} title={item.title} onArt={onArt} />
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
    <div className={cls}>
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
        <Cover src={item.artId && artBase ? `${artBase}${encodeURIComponent(item.artId)}?s=350` : null} title={item.title} onArt={onArt} />
        <div className='t'>{item.title}</div>
        <div className='sub'>{[item.year, fmtRuntime(item.runtime)].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  )
}

// HOW MANY POSTERS COUNT AS "the first screenful", and how long they get.
//
// Tim, 2026-08-18: the shelf should not appear half-drawn while artwork is still crossing
// a relay. It also must not become a blank screen for minutes, which waiting for a whole
// library would be - so the wait is only for what a person can actually see, and it is
// capped by a timer that always fires.
//
// Six is two columns by three rows, which is about what a phone shows before a scroll.
// The timeout is the load-bearing half: one poster that 404s, or a host that stalls on
// the fourth of six, must never hold the library hostage. It ends the wait and the rest
// fade in behind the placeholders as they arrive.
const FIRST_SCREENFUL = 6
const ART_WAIT_MS = 6000

function Grid ({ items, artBase, savedSet, onOpen, onLong, onSave, cols = 2, onArtReady = null, isUnreachable = null }) {
  const list = cols === 'list'
  return (
    <div className={'grid' + (list ? ' aslist' : '')} style={{ '--cols': list ? 1 : cols }}>
      {items.map((i, idx) => (
        <Tile
          key={i.id} item={i} artBase={artBase} list={list}
          unreachable={isUnreachable ? isUnreachable(i) : false}
          saved={savedSet?.has(i.id)} onOpen={onOpen} onLong={onLong} onSave={onSave}
          // Only the tiles being waited on report back - a 200-film library must not
          // fire two hundred state updates as it scrolls.
          onArt={onArtReady && idx < FIRST_SCREENFUL ? onArtReady : null}
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

function ActionSheet ({ item, saved, watched, downloaded, onClose, onPlay, onSave, onWatched, onDownload, onCast = null, libraryNames = null }) {
  const playable = item.type === 'movie' || item.type === 'episode'
  // The dedup made inspectable (proposal §3): a merged entry says which
  // servers hold it, so a collapse is never silent.
  const copyLibs = Array.isArray(item.copies) && item.copies.length > 1
    ? [...new Set(item.copies.map((c) => (libraryNames && libraryNames.get(c.libraryId)) || null).filter(Boolean))]
    : []
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={(e) => e.stopPropagation()}>
        <h3>{item.title}</h3>
        {copyLibs.length > 1 && <p className='muted sm'>On {copyLibs.length} servers: {copyLibs.join(', ')}</p>}
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
          {playable && onCast && (
            <button onClick={() => { onClose(); onCast(item) }}>
              <Screencast size={18} /> Play on TV
            </button>
          )}
          <button className='ghost' onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// Which television (video-deltas §5). The worklet already filtered the
// targets to libraries that hold a copy of this film, and each row remembers
// whose Home Assistant reported it - the cast must stream from that host.
function CastSheet ({ sheet, hostCount, onPick, onClose }) {
  return (
    <div className='sheetwrap' onClick={onClose}>
      <div className='sheet' onClick={(e) => e.stopPropagation()}>
        <h3>Play on a TV</h3>
        {sheet.targets === null && <p className='muted center-p'>Looking for TVs…</p>}
        {sheet.targets !== null && !sheet.enabled && (
          <p className='muted'>
            No TVs are set up. Casting is turned on at the library's dashboard,
            under Settings, Casting. It needs the Home Assistant on that machine.
          </p>
        )}
        {sheet.targets !== null && sheet.enabled && sheet.targets.length === 0 && (
          <p className='muted'>Home Assistant reports no TVs right now.</p>
        )}
        <div className='acts'>
          {(sheet.targets || []).map((t) => (
            <button key={t.libraryId + t.entityId} onClick={() => onPick(sheet.item, t)}>
              <Screencast size={18} /> {t.name}{hostCount > 1 ? ` · ${t.libraryName || 'Library'}` : ''}
            </button>
          ))}
          <button className='ghost' onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// WHAT WENT WRONG, IN A SENTENCE SOMEBODY CAN ACT ON. The parser is deliberately
// strict - a PearTune link, a PearCal join URL and a wifi QR must all fail to parse as
// a PearCinema pairing link (peerloom-host protocol/link.js) - and it throws in the
// vocabulary of a parser: "invalid PearCinema pairing link", lower case, no advice.
// That is right for a log and wrong on a phone, where it is what somebody sees after
// pointing a camera at the wrong square. Seen 2026-08-20 by scanning a code that was
// not a pairing code.
//
// Only the two failures a person can actually cause are rewritten; anything else keeps
// the message it came with rather than being flattened into a shrug.
function pairingProblem (message) {
  const m = String(message || '')
  if (/invalid .* pairing link/i.test(m)) {
    return 'That is not a PearCinema pairing code. Open the dashboard on the server you want to add and press "Pair a device" to show its code.'
  }
  if (/unsupported pairing link version/i.test(m)) {
    return 'That pairing code was made by a newer PearCinema than this phone is running. Update the app and try again.'
  }
  return m
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
    } catch (e) { setError(pairingProblem(e.message)) }
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
          <div><FilmStrip size={18} weight='bold' /><span>Plays straight off a computer you or a friend owns: an Umbrel, a NAS, an old desktop.</span></div>
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
                      Install the PearCinema host on that computer and open its dashboard. It walks you
                      through naming the library, pointing it at your films and showing a pairing code.
                      Then come back here and scan it, or copy the pairing link under the code and paste
                      it instead, at the pairing step.
                    </p>
                  : <p className='sm'>
                      Ask them to open their PearCinema dashboard and press <b>Pair a device</b>. If you are
                      with them, scan the QR code it shows. If you are not, they can copy the pairing link
                      underneath it and send it to you. You can paste that instead of scanning, at the
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
          ? 'Open the PearCinema dashboard on the server you want to add, yours or a friend\'s, and show its pairing code.'
          : owner === 'friend'
            ? 'Scan the pairing code from their dashboard, or paste the link they sent you.'
            : 'Show the pairing code on the server\'s dashboard and scan it, or paste the link under it.'}
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
  // The merged view's filter chip ('_all' or a libraryId) and a tick that
  // bumps when the worklet rebuilds the blend, so the lists refetch.
  const [mergedFilter, setMergedFilter] = useState('_all')
  // The header title IS the library menu (PearTune's shape, replacing the chip
  // row - Tim, 2026-08-16): tap it to pick the blend or one library, or to add
  // a library without a trip to Settings.
  const [libMenuOpen, setLibMenuOpen] = useState(false)
  const [mergedTick, setMergedTick] = useState(0)
  // Pull to refresh. Declared with the rest of the screen's state rather than
  // beside its handlers, because those sit below the Loading and Onboarding
  // early returns and a hook cannot.
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const pullStartY = useRef(null)
  const [items, setItems] = useState(null)
  const [cursor, setCursor] = useState(null)
  // Waiting on the first screenful of artwork before revealing the shelf (Tim,
  // 2026-08-18). Counted rather than timed: `artSeen` climbs as the first few posters
  // settle, and `artWaitOver` is the timer that guarantees the wait ends whatever the
  // network does. Both reset when the person moves to a different shelf, not when more
  // pages of the SAME shelf arrive - a "More" press must not hide what is on screen.
  const [artSeen, setArtSeen] = useState(0)
  const [artWaitOver, setArtWaitOver] = useState(false)
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
  // The relay: on unless the person turns it off, and their own relay key if they run
  // one. Off means pure peer-to-peer, including the case where that means a network
  // which cannot punch simply will not connect - which is the honest trade, said plainly
  // in the Connection section rather than buried.
  const [useRelay, setUseRelay] = useState(true)
  const [ownRelayKey, setOwnRelayKey] = useState('')
  const [relayKeySaved, setRelayKeySaved] = useState(true)
  // The one-time question before a film crosses a relay, and the libraries currently
  // reaching us that way. `relayAsk` holds the film that is waiting on the answer, so a
  // Yes plays it rather than making the person press the poster twice.
  const [relayAsk, setRelayAsk] = useState(null)
  const [relayLibs, setRelayLibs] = useState([])
  // What the relay has carried for this phone this month, and the nudge once that is a
  // heavy share. A nudge, never a stop: a film in progress is never interrupted.
  const [relayUsage, setRelayUsage] = useState(null)
  // What this phone is holding: films kept from playback and downloads, and the posters
  // saved so browsing does not re-fetch them.
  const [storage, setStorage] = useState(null)
  // The player skins - cosmetic overlays drawn by the shell, PearTune's
  // Winamp-toggle pattern. The 35mm skin's tone is the exception: a phone
  // cannot repaint a native video surface, so a tone rides the capability
  // declaration and the BOX presses it into the picture.
  const [playerSkin, setPlayerSkin] = useState('off')
  const [playerTone, setPlayerTone] = useState('off')
  // PLAY THE NEXT EPISODE BY ITSELF. The card is drawn by the SHELL, because the
  // film is a native view covering this page - but the preference belongs here
  // with every other setting, and rides the same shell.navSet the buttons do.
  // Absent means on, which is what a television does.
  const [autoplayNext, setAutoplayNext] = useState(true)
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
  // The device a revoke sheet is open for (Tim, 2026-08-17, replacing the
  // donor's armed two-tap text swap): confirmation belongs in the app's own
  // bottomsheet idiom, not in a button that changes its words - a WebView's
  // confirm() is still at the shell's mercy, so the sheet is ours.
  const [revoking, setRevoking] = useState(null)
  // The Continue list keeps every place there is, so a year of half-started
  // films buried the one thing actually being watched (Tim, 2026-08-19). The
  // cap is on what is SHOWN; the rest is one press away rather than gone.
  // THE FILM YOU ARE LOOKING AT. Tapping one in the library used to start it, which
  // is the phone's oldest shortcut and its worst: the only chance anybody gets to
  // read what a film is, see how long it is, or notice they are 41 minutes in
  // already (Tim, 2026-08-20, with Plex's phone screen). Nothing is fetched to open
  // it - the item is already on screen - so the page costs a tap and no round trip.
  const [title, setTitle] = useState(null)
  const [titleSubs, setTitleSubs] = useState(null)
  const [titleResume, setTitleResume] = useState(null)
  const [showAllContinue, setShowAllContinue] = useState(false)
  const [clearAsk, setClearAsk] = useState(false)
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
  // Casting (video-deltas §5): the sheet that picks a TV, and the live cast
  // this phone is remote for. The HOST owns the session - this is only what
  // the bar at the bottom needs to say and where to send stop.
  const [castSheet, setCastSheet] = useState(null)
  const [casting, setCasting] = useState(null)
  // Whether there is a television to offer at all - the player's cast button
  // rides on this, and a button that opens an empty picker is worse than none.
  // Declared up here with the rest of the cast state on purpose: reload() and
  // play() both touch it, and both sit above where it would otherwise land.
  const [canCast, setCanCast] = useState(false)
  // Where the film on the television has got to. Null until the first answer,
  // and the bar simply says less until then rather than showing a made-up zero.
  const [castAt, setCastAt] = useState(null)
  const castingRef = useRef(null)
  castingRef.current = casting
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
  // The player's cast button reaches the picker through this, the same shape as
  // playRef: the handler is wired on mount and openCast is declared hundreds of
  // lines below it, so a direct reference would be both stale and a TDZ risk.
  const castRef = useRef(null)
  const uiRef = useRef({})
  const toastTimer = useRef(null)

  const say = (msg) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }

  // Which libraries are reaching us through a relay right now, and what each was told
  // about it. Asked rather than pushed: the answer changes only when a connection is
  // made or lost, and both of those already call this.
  const refreshRelay = useCallback(() => {
    call('relay.status').then((r) => {
      setRelayLibs(r?.libraries || [])
      setRelayUsage(r?.usage || null)
    }).catch(() => {})
  }, [])

  const reload = useCallback(async () => {
    const s = await call('app.state')
    setState(s)
    setMergedFilter(s.merged?.filter || '_all')
    if (s.active) {
      const b = await call('art.base').catch(() => null)
      if (b) setArtBase(b.base)
      call('identity.get').then(setIdent).catch(() => {})
      call('fav.list').then((r) => {
        setSaved(new Set((r.items || []).map((i) => i.id)))
        setSavedItems(r.items || [])
      }).catch(() => {})
      call('watched.list').then((r) => setWatchedIds(new Set(r.items || []))).catch(() => {})
      // Seed the running list so the navbar's download light is truthful after
      // a WebView reload mid-download; events alone only cover this page-load.
      call('download.list').then((r) => setDlRunning(r.running || [])).catch(() => {})
      // Is there a television to offer at all? Asked once here rather than as
      // the player opens, because that path deliberately does nothing that
      // could delay first frames. Refreshed whenever the picker actually runs,
      // so configuring Home Assistant shows up without a reinstall.
      call('cast.list').then((r) => setCanCast(!!r?.enabled && (r.targets || []).length > 0)).catch(() => {})
      refreshRelay()
      call('storage.stats').then(setStorage).catch(() => {})
    }
    return s
  }, [])

  useEffect(() => {
    reload().catch((e) => setErr(e.message))
    const offs = [
      on('pair-link', (url) => { setPairLink(url); setAddingLibrary(true) }),
      on('hosts:changed', () => reload().catch(() => {})),
      on('merged:changed', () => setMergedTick((t) => t + 1)),
      on('host:connected', () => { setLinkUp(true); refreshRelay() }),
      on('host:disconnected', () => { setLinkUp(false); refreshRelay() }),
      // A punch that landed late moved a live connection off the relay. The marker and
      // the ceiling notice have to go with it, or the app keeps claiming a relay that is
      // no longer in the path.
      on('relay:changed', () => refreshRelay()),
      on('download:progress', (d) => {
        setDlRunning((rows) => {
          const rest = rows.filter((r) => r.itemId !== d.itemId)
          return [...rest, d]
        })
      }),
      on('download:done', (d) => {
        setDlRunning((rows) => rows.filter((r) => r.itemId !== d.itemId))
        say('Downloaded. It plays with no connection now')
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
        if (m?.kind === 'request:created' || m?.kind === 'request:removed') {
          // The operator's side of the same conversation. Only an owner is sent
          // these, and only the Manage list shows them, so refresh it in place
          // rather than announcing an ask over whatever is on screen.
          if (u.tab === 'you' && u.youView === 'manage') loadYouRef.current?.('manage')
        }
        if (m?.kind === 'cast:ended' && m.data) {
          // The TV ran out of film. Only this phone's own cast clears the bar -
          // the host pushes to the device that started it.
          const c = castingRef.current
          if (c && c.entityId === m.data.entityId) {
            setCasting(null)
            say('The TV finished playing')
          }
        }
      }),
      // The player handed the film to a television. The shell has already closed
      // itself and written the resume; what is left is the picker, opened on the
      // film that was playing and carrying the minute it reached.
      on('player:cast', async (d) => {
        if (!d?.itemId) return
        const item = await call('library.get', { id: d.itemId }).catch(() => null)
        if (!item) return setErr('That film could not be found to send to a TV')
        castRef.current?.(item, { atMs: Number(d.positionMs) || 0 })
      }),
      on('player:tick', (d) => {
        if (d?.itemId && d.positionMs > 0) call('resume.set', { itemId: d.itemId, positionMs: d.positionMs }).catch(() => {})
      }),
      // The autoplay switch, thrown on the card the shell drew. It is saved
      // HERE so the Settings row and the card are one preference rather than
      // two that agree until they do not.
      on('player:autoplay', (d) => {
        const on = !!d?.on
        setAutoplayNext(on)
        call('setSettings', { autoplayNext: on }).catch(() => {})
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
          const [next, prior] = await Promise.all([
            call('stream.url', { itemId: target.id }),
            call('resume.get', { itemId: target.id }).catch(() => null)
          ])
          // A prompt cannot be answered from under the native player, so the next
          // episode simply does not roll. In practice the first film in this library
          // already answered it - this is the case where the link dropped to a relay
          // mid-session, and the honest move is to stop rather than to ask invisibly.
          if (next?.needsRelayConsent) return setErr('The next one needs your say-so first. Close the player and press play on it.')
          const url = next.url
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
          const burnt = await call('stream.url', {
            itemId: d.itemId,
            ...(d.subtitleId ? { burnSubtitleId: d.subtitleId } : {})
          })
          if (burnt?.needsRelayConsent) return setErr('Subtitles need a fresh stream, and this library has not been cleared for the relay yet.')
          const url = burnt.url
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
          const retry = await call('stream.url', { itemId: d.itemId, deviceRefusedVideo: true })
          const { url, mode } = retry
          if (retry?.needsRelayConsent) setErr('This one needs converting, and this library has not been cleared for the relay yet.')
          else if (mode === 'transcode') await call('shell.play', { itemId: d.itemId, url, title: d.title || '', startMs: d.positionMs || 0 })
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
      if (u.title) return setTitle(null)
      if (u.season) return setSeason(null)
      if (u.series) return setSeries(null)
      if (u.tab !== 'library') return setTab('library')
      call('shell.exit').catch(() => {})
    }
    return () => { offs.forEach((f) => f()); offTheme(); document.removeEventListener('click', feel, true) }
  }, [])

  uiRef.current = { youView, sheet: !!sheet, donate, showDisplay, resumeOffer: !!resumeOffer, addingLibrary, title: !!title, season: !!season, series: !!series, tab }

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
  }, [state?.active?.hostKey, root, series?.id, season?.id, sortField, sortOrder, mergedFilter, mergedTick])

  // IS THE LIBRARY'S OWN DISK STILL THERE? The host has always answered this on
  // library.stats and nothing here has ever asked, so a library whose drive had been
  // unplugged or remounted arrived as an ordinary empty shelf - and an empty shelf
  // reads as "there is nothing in this library", which is a lie about somebody's
  // films (Tim's Umbrel lost its drive on 2026-08-19 and nothing on this side said a
  // word).
  //
  // Asked with the list rather than on a timer of its own: the moment worth catching
  // is somebody opening the app to a shelf that should not be empty.
  // EVERY CONNECTED LIBRARY, not just the active one. The first cut asked
  // library.stats, which answers for the active host - and on a phone with more than
  // one library the merged shelf shows films from all of them, so the host that lost
  // its drive is very often not the one being asked. That is exactly how this read as
  // working on the TCL and silent on Tim's Pixel on the same build.
  const [lostLibs, setLostLibs] = useState([])

  // CAN THIS FILM ACTUALLY BE PLAYED, and if so from where. Two things the first cut
  // got wrong, both found by using it (Tim, 2026-08-19):
  //
  //   A FILM IN TWO LIBRARIES IS NOT LOST WHEN ONE OF THEM IS. A merged item carries
  //   every copy of itself, and the primary is chosen for completeness rather than for
  //   being reachable - so his Arrival greyed out because the copy that won was on the
  //   library that had gone, while another library had it all along.
  //
  //   AND A DOWNLOAD DOES NOT NEED ITS LIBRARY. Keeping the tile pressable was right
  //   for those and wrong for everything else: 2001 was not downloaded, the tap still
  //   offered to resume it, and Resume opened a player that could never start.
  const reach = useCallback((i) => {
    if (!i) return { openable: false, openId: null }
    const lost = new Set(lostLibs.map((l) => l.libraryId))
    const copies = (i.copies && i.copies.length) ? i.copies : [{ libraryId: i.libraryId, id: i.id }]

    // The item's own copy first, so nothing moves while every library is healthy.
    const ordered = [{ libraryId: i.libraryId, id: i.id }, ...copies]
    const live = ordered.find((c) => c.id && !(c.libraryId && lost.has(c.libraryId)))
    if (live) return { openable: true, openId: live.id }

    // Every library that has it is out, so the only way left is a copy this phone is
    // already holding.
    const held = ordered.find((c) => c.id && dlIds.has(c.id))
    if (held) return { openable: true, openId: held.id }

    return { openable: false, openId: null, lostName: lostLibs.find((l) => l.libraryId === i.libraryId)?.libraryName || null }
  }, [lostLibs, dlIds])
  useEffect(() => {
    if (!state?.active) return setLostLibs([])
    call('library.sources')
      .then((r) => setLostLibs(r?.items || []))
      .catch(() => setLostLibs([]))
  }, [state?.active?.hostKey, mergedFilter, mergedTick, items])

  // The chip is a persisted preference the worklet applies server-side of the
  // IPC line, so a change is a write plus a refetch (the dep above).
  const pickFilter = (lib) => {
    setMergedFilter(lib)
    call('merged.filter', { libraryId: lib }).catch(() => {})
  }

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
  }, [state?.active?.hostKey, mergedFilter, mergedTick])

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
      if (typeof s?.autoplayNext === 'boolean') setAutoplayNext(s.autoplayNext)
      // Absent means on: a phone that has never opened Settings should still be able to
      // reach its library from a network that cannot punch.
      if (typeof s?.useRelay === 'boolean') setUseRelay(s.useRelay)
      if (typeof s?.ownRelayKey === 'string') setOwnRelayKey(s.ownRelayKey)
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

  // A cast outlives the app on purpose - the HOST owns the session. Reopening
  // re-attaches this phone as the remote for whatever it left on a TV.
  useEffect(() => {
    if (!state?.active) return
    let live = true
    call('cast.list').then(async (r) => {
      if (!live) return
      const a = (r?.active || [])[0]
      if (!a) return
      const t = (r.targets || []).find((x) => x.entityId === a.entityId && x.libraryId === a.libraryId)
      const item = await call('library.get', { id: a.itemId }).catch(() => null)
      if (!live) return
      setCasting((cur) => cur || {
        entityId: a.entityId,
        libraryId: a.libraryId,
        name: t?.name || 'the TV',
        itemId: a.itemId,
        title: item?.title || 'A film',
        paused: false
      })
    }).catch(() => {})
    return () => { live = false }
  }, [state?.active?.hostKey])

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
    try { await call('shell.play', { itemId: item.id, url, title: item.title, startMs, skin: playerSkin, canCast }) } catch (e) { setErr(e.message); return }
    // Episode neighbours arrive AFTER playback starts, so the lookup never
    // delays first frames. Offline or on a film the catch leaves the buttons
    // off, which is the honest answer in both cases.
    if (item.type !== 'episode') { navRef.current = null; return }
    try {
      const { prev, next } = await call('library.siblings', { id: item.id })
      navRef.current = (prev || next) ? { itemId: item.id, prev, next } : null
      if (navRef.current) {
        await call('shell.navSet', {
          itemId: item.id,
          hasPrev: !!prev,
          hasNext: !!next,
          autoplayNext,
          // WHAT THE CARD AT THE END SAYS, sent WITH the buttons rather than
          // asked for when the film ends - a card that has to fetch its own
          // words appears blank at the exact moment somebody is looking at it.
          next: next
            ? {
                title: next.title || '',
                seriesTitle: next.seriesTitle || '',
                label: next.episodeNumber != null ? `Episode ${next.episodeNumber}` : '',
                runtime: next.runtime || null,
                overview: next.overview || '',
                artUrl: next.artId && artBase ? `${artBase}${encodeURIComponent(next.artId)}?s=350` : null
              }
            : null
        })
      }
    } catch { navRef.current = null }
  }
  playRef.current = play

  // A FILM IS A PLACE NOW. An EPISODE is not: it is reached from its season, where
  // the list around it already says what it is, and the thing somebody wants from an
  // episode row is the episode.
  const open = async (i) => {
    if (i.type === 'series') { setTab('library'); return setSeries(i) }
    if (i.type === 'season') { setTab('library'); return setSeason(i) }
    if (i.type === 'movie') {
      setTab('library')
      setTitleSubs(null)
      setTitleResume(null)
      setTitle(i)
      return
    }
    return watch(i)
  }

  const watch = async (i) => {
    // BEFORE THE RESUME PROMPT, not after. Asking "carry on from 41 minutes?" about a
    // film that cannot start is a worse failure than refusing plainly, because the
    // person says yes and then watches an empty player.
    const { openable, openId, lostName } = reach(i)
    if (!openable) {
      return setErr(`${lostName || 'That library'} cannot reach this film, and it is not downloaded to this phone.`)
    }

    try {
      const [res, prior] = await Promise.all([
        call('stream.url', { itemId: openId }),
        call('resume.get', { itemId: openId }).catch(() => null)
      ])
      // The film is reachable only through a relay and this library has never been
      // asked. No url came back, deliberately, so there is nothing to play by accident.
      if (res?.needsRelayConsent) return setRelayAsk({ item: i, ...res })
      const startMs = prior?.resume?.positionMs > 0 ? prior.resume.positionMs : 0
      if (startMs > 0) return setResumeOffer({ item: i, url: res.url, positionMs: startMs })
      await play(i, res.url, 0)
    } catch (e) { setErr(e.message) }
  }

  // What the page needs beyond the item it already has: where you got to, and what
  // subtitles the file carries. Both are cheap, both are asked for once, and neither
  // blocks the page from drawing - it is on screen before either answers.
  useEffect(() => {
    if (!title) return
    let live = true
    const id = reach(title).openId || title.id
    call('resume.get', { itemId: id }).then((r) => { if (live) setTitleResume(r?.resume || null) }).catch(() => {})
    call('subtitle.list', { itemId: id })
      .then((r) => { if (live) setTitleSubs((r?.items || [])) })
      .catch(() => { if (live) setTitleSubs([]) })
    return () => { live = false }
  }, [title?.id])

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

  // Keeping a copy on this phone, from wherever it is asked for - the long-press
  // sheet and the film's own page. One copy of the words, one copy of the rule.
  const toggleDownload = (i, want) => {
    if (want) {
      call('download.start', { itemId: i.id })
        .then(() => { setDlIds((x) => new Set(x).add(i.id)); say('Downloading. Watch it in You, Downloads') })
        .catch((e) => setErr(e.message))
    } else {
      call('download.remove', { itemId: i.id })
        .then(() => { setDlIds((x) => { const n = new Set(x); n.delete(i.id); return n }); say('Removed from this phone') })
    }
  }

  const markWatched = async (i, on) => {
    try {
      await call('watched.set', { itemId: i.id, watched: on })
      setWatchedIds((s) => { const n = new Set(s); on ? n.add(i.id) : n.delete(i.id); return n })
      say(on ? 'Marked watched' : 'Marked unwatched')
      if (youView === 'watched') loadYou('watched')
    } catch (e) { setErr(e.message) }
  }

  // A ZERO POSITION IS THE DELETE, the same write the host makes when a film
  // finishes - so forgetting one place travels the identical path, fan-out to
  // every library holding a copy included, rather than being a second way to
  // remove a row that has to be kept honest separately.
  const forgetPlace = async (i) => {
    setContinueRows((rows) => (rows || []).filter((r) => r.id !== i.id))
    try {
      await call('resume.set', { itemId: i.id, positionMs: 0 })
      say('Removed from Continue watching')
    } catch (e) { setErr(e.message); loadYou('continue') }
  }

  const clearContinue = async () => {
    setClearAsk(false)
    try {
      await call('resume.clear')
      setContinueRows([])
      setShowAllContinue(false)
      say('Continue watching cleared')
    } catch (e) { setErr(e.message) }
  }

  const longPress = (i) => setSheet(i)

  // --- casting (video-deltas §5) --------------------------------------------

  // atMs is the LIVE position when this came from the player's own cast button,
  // and null when it came from the long-press sheet - where the stored resume is
  // the right answer and is read at pick time instead.
  const openCast = async (item, { atMs = null } = {}) => {
    setCastSheet({ item, targets: null, enabled: false, atMs })
    try {
      const r = await call('cast.list', { itemId: item.id })
      setCanCast(!!r?.enabled && (r.targets || []).length > 0)
      setCastSheet((s) => (s && s.item.id === item.id
        ? { ...s, targets: r?.targets || [], enabled: !!r?.enabled }
        : s))
    } catch (e) {
      setCastSheet(null)
      setErr(e.message)
    }
  }
  castRef.current = openCast

  const castTo = async (item, t) => {
    try {
      // The TV starts where this person is - a generated stream begins there
      // outright, a direct one lets the TV seek itself.
      //
      // A cast STARTED FROM THE PLAYER carries its own minute, and that beats
      // the stored resume: the phone writes resume on a 15s tick and at close,
      // so reading the store here would quietly rewind the film by up to a
      // quarter of a minute at the exact moment somebody is watching it move
      // from their hand to the wall.
      let at = castSheet?.atMs > 0 ? Math.floor(castSheet.atMs / 1000) : 0
      if (!at) {
        const prior = await call('resume.get', { itemId: item.id }).catch(() => null)
        at = prior?.resume?.positionMs > 0 ? Math.floor(prior.resume.positionMs / 1000) : 0
      }
      await call('cast.play', { entityId: t.entityId, libraryId: t.libraryId, itemId: item.id, at })
      setCastSheet(null)
      setCasting({ entityId: t.entityId, libraryId: t.libraryId, name: t.name, itemId: item.id, title: item.title, artId: item.artId || null, paused: false })
      haptic('success')
      say(`Playing on ${t.name}`)
    } catch (e) {
      setCastSheet(null)
      setErr(e.message)
    }
  }

  // ASKED FOR AS A STATE, not as a toggle. The button in the app knows what it is
  // looking at; a lock-screen Play does not - it is a play button, and answering it by
  // flipping whatever we last believed would pause a film that was already playing.
  const setCastPaused = async (want) => {
    const c = castingRef.current
    if (!c || !!c.paused === !!want) return
    try {
      await call(want ? 'cast.pause' : 'cast.resume', { entityId: c.entityId, libraryId: c.libraryId })
      setCasting((s2) => (s2 && s2.entityId === c.entityId ? { ...s2, paused: !!want } : s2))
      readCastAt()
    } catch (e) { setErr(e.message) }
  }

  const toggleCastPause = () => setCastPaused(!castingRef.current?.paused)

  // Where the film is, while this phone is the remote. Asked of the host every
  // few seconds rather than tracked locally: the television is the thing
  // actually playing, somebody may pause it with its own remote, and a clock
  // this phone ran itself would drift away from the room.
  //
  // Only while a cast is live AND the app is in front - a bar nobody is looking
  // at should not keep a link busy. The interval is deliberately slower than
  // the host's own 2s poll of Home Assistant: this is a readout, not a
  // stopwatch, and every tick is a round trip over the wire.
  // ASKED FOR ON DEMAND AS WELL AS ON THE CLOCK. A skip is the one moment the readout
  // is certainly wrong, and waiting up to five seconds to find out where the film went
  // is five seconds of a number that is a lie (Tim, 2026-08-19).
  const readCastAt = useCallback(async () => {
    const c = castingRef.current
    if (!c) return
    try {
      const r = await call('cast.state', { entityId: c.entityId, libraryId: c.libraryId })
      if (r?.positionMs == null) return
      const now = castingRef.current
      if (!now || now.entityId !== c.entityId) return
      setCastAt({ positionMs: r.positionMs, durationMs: r.durationMs || null, at: Date.now() })
      if (r.state === 'paused' || r.state === 'playing') {
        const want = r.state === 'paused'
        setCasting((s2) => (s2 && s2.entityId === c.entityId && !!s2.paused !== want && !s2.seeking ? { ...s2, paused: want } : s2))
      }
    } catch { /* a television that stops answering just stops updating */ }
  }, [])

  useEffect(() => {
    const c = casting
    setCastAt(null) // a different television, or none, is not where the last one was
    if (!c) return
    let live = true
    const read = async () => {
      if (!live || document.hidden) return
      try {
        const r = await call('cast.state', { entityId: c.entityId, libraryId: c.libraryId })
        if (!live || r?.positionMs == null) return
        setCastAt({ positionMs: r.positionMs, durationMs: r.durationMs || null, at: Date.now() })
        // AND WHETHER IT IS PAUSED, from the television rather than from what this
        // screen last did. Somebody may have paused it with its own remote, or from
        // the lock screen while this WebView was frozen - both leave the bar in here
        // showing the wrong button until it asks.
        if (r.state === 'paused' || r.state === 'playing') {
          const want = r.state === 'paused'
          setCasting((s2) => (s2 && s2.entityId === c.entityId && !!s2.paused !== want && !s2.seeking ? { ...s2, paused: want } : s2))
        }
      } catch { /* a television that stops answering just stops updating */ }
    }
    read()
    const t = setInterval(read, 5000)
    const wake = () => { if (!document.hidden) read() }
    document.addEventListener('visibilitychange', wake)
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', wake) }
  }, [casting?.entityId, casting?.libraryId])

  // Skipping is asked for as a DIRECTION, not a destination: the host is the
  // one that knows where the film is, and it is the only place that gets a
  // generated stream's offset right. A phone computing an absolute position
  // from whatever it last heard would land the film somewhere nobody chose.
  //
  // A converted stream is re-minted at the new point, so there is a real pause
  // before picture returns; the button locks while that happens rather than
  // letting an impatient second tap skip twice from a position that has not
  // settled.
  const castSkip = async (deltaMs) => {
    const c = casting
    if (!c || c.seeking) return
    setCasting({ ...c, seeking: true })
    try {
      const r = await call('cast.seek', { entityId: c.entityId, libraryId: c.libraryId, deltaMs })
      setCasting((s) => (s && s.entityId === c.entityId ? { ...s, seeking: false, paused: false } : s))
      if (r?.restarted) say(deltaMs > 0 ? 'Skipped forward' : 'Skipped back')
      haptic()
      // WHERE IT IS GOING, said at once. Asking the television instead means asking a
      // television that has not started the new stream yet - a converted skip re-cuts
      // the film and takes seconds to come back - so it answers with the old minute and
      // the number sits wrong until the next poll (Tim, 2026-08-20). The host's own
      // answer already carries the destination; the polls that follow correct it if the
      // television lands anywhere else.
      if (r?.positionMs != null) {
        setCastAt((a) => ({ positionMs: r.positionMs, durationMs: a?.durationMs || null, at: Date.now() }))
      }
      readCastAt()
      setTimeout(readCastAt, 2500)
    } catch (e) {
      // A television that cannot be told to jump says so once, and then stops
      // offering - a button that always fails is worse than no button. A Roku
      // playing a file direct is the case this exists for.
      const cannot = /cannot skip/i.test(e.message || '')
      setCasting((s) => (s && s.entityId === c.entityId ? { ...s, seeking: false, noSkip: cannot || s.noSkip } : s))
      setErr(cannot ? 'This TV cannot skip while playing this film' : e.message)
    }
  }

  // THE MINUTE MOVES BETWEEN READINGS, which is what makes this bar and the lock
  // screen agree (Tim, 2026-08-19: "is there no way to get the onscreen timestamp and
  // app timestamp to match?"). They could not: the notification advances itself at
  // playing speed from the last reading, and this bar showed the reading itself - a
  // number that sat still for five seconds and then jumped, always behind by however
  // long ago it was asked for. Now both count from the same instant at the same rate,
  // and every reading re-anchors them together.
  const [castTick, setCastTick] = useState(0)
  useEffect(() => {
    if (!casting || casting.paused || !castAt) return
    const t = setInterval(() => setCastTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [casting?.entityId, casting?.paused, !!castAt])
  const castShownMs = castAt
    ? castAt.positionMs + (casting?.paused ? 0 : Math.max(0, (castTick || Date.now()) - (castAt.at || 0)))
    : null

  // THE REMOTE ON THE LOCK SCREEN. The bar inside the app is unchanged; this is the
  // same three controls where somebody can actually reach them, because answering a
  // message meant unlocking, finding the app and waiting for it to come back before
  // the room could be paused (Tim, 2026-08-19).
  //
  // Pushed on every change rather than on a timer: the notification's own scrubber
  // advances itself between updates, so this only has to say what changed - a pause,
  // a skip, a different film - and the five-second readout it rides on is the one this
  // screen was already doing.
  useEffect(() => {
    const c = casting
    if (!c) {
      call('shell.castRemote', { show: false }).catch(() => {})
      return
    }
    call('shell.castRemote', {
      show: true,
      // THE SHELL ACTS ALONE, so it needs everything it takes to act: Android freezes
      // this WebView with the screen, and a button pressed on the lock screen that
      // waits for the app to be reopened is a button that does not work. PearTune found
      // the same thing and moved cast control into its shell for the same reason
      // (proposal 2026-08-02-cast-control-lives-in-the-shell).
      entityId: c.entityId,
      libraryId: c.libraryId,
      skipMs: SKIP_MS,
      title: c.title || 'Playing',
      subtitle: 'on ' + (c.name || 'the television'),
      artUrl: c.artId && artBase ? `${artBase}${encodeURIComponent(c.artId)}?s=350` : null,
      paused: !!c.paused,
      // A television that cannot skip does not get buttons that pretend it can - the
      // same honesty the in-app bar already keeps.
      canSkip: !c.noSkip,
      positionMs: castAt?.positionMs || 0,
      durationMs: castAt?.durationMs || 0
    }).catch(() => {})
  }, [casting?.entityId, casting?.title, casting?.artId, casting?.paused, casting?.noSkip, castAt?.positionMs, castAt?.durationMs, artBase])

  // AND THE PRESS COMES BACK AS NEWS, not as an instruction. The shell has already
  // told the television - it has to, because this WebView is frozen whenever the screen
  // is - so acting on it again here would send everything twice, and a skip twice is
  // sixty seconds when somebody asked for thirty. All this does is keep the bar in the
  // app agreeing with the room.
  useEffect(() => on('cast:control', (d) => {
    const what = d?.action
    if (what === 'stop') setCasting(null)
    else if (what === 'play' || what === 'pause') {
      setCasting((s2) => (s2 ? { ...s2, paused: what === 'pause' } : s2))
    }
    if (what !== 'stop') { readCastAt(); setTimeout(readCastAt, 1500) }
    // A skip changes where the film is, so ask - the shell has already told the
    // television and this screen may have been asleep when it did.
    //
    // 'seek' is never sent at all: the session does not advertise seek-to, because the
    // host takes a DIRECTION and not a destination, and a scrubber that lands the film
    // somewhere nobody chose is worse than a scrubber that does not move.
  }), [])

  const stopCast = async () => {
    const c = casting
    if (!c) return
    setCasting(null)
    try { await call('cast.stop', { entityId: c.entityId, libraryId: c.libraryId }) } catch (e) { setErr(e.message) }
  }

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

  // In merged mode the header names the blend, or the one library the chip
  // narrowed to. Single host keeps its own name, exactly as before.
  const mergedOn = !!state.merged?.on
  const filterName = mergedOn && mergedFilter !== '_all'
    ? (state.hosts.find((h) => h.libraryId === mergedFilter)?.libraryName || 'Library')
    : null

  const libTitle = mergedOn ? (filterName || 'All libraries') : (state.active.libraryName || 'Library')
  const canSwitch = mergedOn && state.hosts.length >= 2

  // PULL TO REFRESH, by hand: this is a WebView, so there is no RefreshControl
  // to borrow. The donor's shape, and its two hard-won details - only arm when
  // the page is ALREADY at the top, or the gesture fights every upward scroll
  // in a long grid; and damp the pull by half, because 1:1 feels like the page
  // has come unstuck.
  //
  // It is worth more here than it was in the donor. A library is a machine in
  // someone's house: it gets turned off, rebooted, carried to another room, and
  // Android drops the link whenever this app sits in the background. The host
  // pushes nothing when its own library changes either - somebody drops a film
  // on the drive and the shelf would go on showing yesterday's until the app
  // was killed. This is the gesture people already reach for, and it covers
  // both: reconnect, then re-read.
  const PULL_TRIGGER = 60

  const refreshLibrary = async () => {
    setErr('')
    // The connection first. Every read below rides connected(), which redials a
    // dropped link on demand - so a reload here is what turns "cannot reach the
    // host" back into a shelf, which is the reason somebody pulled.
    await reload().catch(() => {})
    // In merged mode the blend is a built index, not a live query: rebuilding it
    // is what folds in a library that has come back since launch.
    if (mergedOn) await call('merged.refresh').catch(() => {})
    // Bumping the tick re-runs the grid and the recent shelf, which both watch
    // it - one lever rather than four reloads that could disagree.
    setMergedTick((t) => t + 1)
  }

  const onPullStart = (e) => {
    pullStartY.current = window.scrollY <= 0 && !refreshing ? e.touches[0].clientY : null
  }
  const onPullMove = (e) => {
    if (pullStartY.current == null) return
    const dy = e.touches[0].clientY - pullStartY.current
    if (dy > 0) setPull(Math.min(90, dy * 0.5))
  }
  const onPullEnd = async () => {
    if (pullStartY.current == null) return
    const reached = pull >= PULL_TRIGGER
    pullStartY.current = null
    setPull(0)
    if (!reached) return
    haptic('light')
    setRefreshing(true)
    try { await refreshLibrary() } finally { setRefreshing(false) }
  }

  const ptr = refreshing ? 44 : pull

  // Which shelf is on screen. A change here is a NEW wait; another page of the same
  // shelf is not.
  const shelfKey = `${root}|${mergedFilter}|${series?.id || ''}|${season?.id || ''}|${results ? 'q' : ''}`
  useEffect(() => {
    setArtSeen(0)
    setArtWaitOver(false)
    const t = setTimeout(() => setArtWaitOver(true), ART_WAIT_MS)
    return () => clearTimeout(t)
  }, [shelfKey])

  // Reveal when the first screenful has settled, or when the timer says enough. Episodes
  // in a season are a text list with no posters to wait for, so they never wait.
  const artTarget = Math.min(FIRST_SCREENFUL, (results || items || []).length)
  const waitingArt = !season && artTarget > 0 && !artWaitOver && artSeen < artTarget
  const noteArt = useCallback(() => setArtSeen((n) => n + 1), [])

  // THE PAGE ABOUT ONE FILM, and its own screen rather than a sheet: a sheet is for
  // a handful of actions on something you can still see, and this is the thing
  // itself. Plex's phone shape - the picture, the name, one line of facts, one big
  // Watch, a row of quiet round actions under it, then what it is about and what is
  // actually in the file.
  const titleScreen = title && (
    <div className='app titlescreen'>
      {/* A BARE ARROW, no box (Tim, 2026-08-20: the pill was large and ugly). There is
          exactly one place to go back to and the arrow says so - a word and a border
          around it is chrome above the thing somebody came to look at. The touch
          target stays finger-sized; only the paint goes. */}
      <button className='backarrow' onClick={() => setTitle(null)} aria-label='Back to the library'>
        <CaretLeft size={22} />
      </button>

      {err && <div className='error'>{err}</div>}

      <div className='tposter'>
        <Cover src={title.artId && artBase ? `${artBase}${encodeURIComponent(title.artId)}?s=350` : null} title={title.title} />
      </div>

      <h2 className='ttitle'>{title.title}</h2>
      <p className='tfacts'>
        {[title.year, fmtRuntime(title.runtime), (title.genres || []).slice(0, 2).join(', ')].filter(Boolean).join(' · ')}
      </p>

      {/* ONE BIG WATCH, because that is what somebody came for - and it says the
          minute when there is one to carry on from, since "resume" without a number
          is a promise nobody can check. */}
      <button className='twatch' onClick={() => { setTitle(null); watch(title) }}>
        <Play size={18} weight='fill' />
        {titleResume?.positionMs > 0 ? ` Resume at ${fmtClock(titleResume.positionMs)}` : ' Watch'}
      </button>
      {/* START OVER IS THE PLAYER'S OWN QUESTION, asked over the picture where it
          belongs - so this opens the film exactly as Watch does and the player
          offers both answers. Asking it twice would be one question too many. */}

      <div className='tacts'>
        <button onClick={() => toggleSave(title)}>
          <span className='tcirc'><BookmarkSimple size={20} weight={saved.has(title.id) ? 'fill' : 'regular'} /></span>
          <span>{saved.has(title.id) ? 'Saved' : 'Watchlist'}</span>
        </button>
        <button onClick={() => markWatched(title, !watchedIds.has(title.id))}>
          <span className='tcirc'><CheckCircle size={20} weight={watchedIds.has(title.id) ? 'fill' : 'regular'} /></span>
          <span>{watchedIds.has(title.id) ? 'Watched' : 'Mark watched'}</span>
        </button>
        <button onClick={() => toggleDownload(title, !dlIds.has(title.id))}>
          <span className='tcirc'><DownloadSimple size={20} weight={dlIds.has(title.id) ? 'fill' : 'regular'} /></span>
          <span>{dlIds.has(title.id) ? 'Downloaded' : 'Download'}</span>
        </button>
        {canCast && (
          <button onClick={() => openCast(title)}>
            <span className='tcirc'><Screencast size={20} /></span>
            <span>Play on TV</span>
          </button>
        )}
      </div>

      {title.overview && <p className='tsum'>{title.overview}</p>}

      {/* WHAT IS ACTUALLY IN THE FILE. The one part of this page nobody else can
          answer as well, because it is the operator's own file rather than a
          database entry about the film. */}
      <dl className='tspecs'>
        <dt>Picture</dt>
        <dd>{[title.media?.height ? `${title.media.height}p` : null, (title.media?.videoCodec || '').toUpperCase() || null].filter(Boolean).join(' · ') || 'not reported'}</dd>
        <dt>Sound</dt>
        <dd>{[(title.media?.audioCodec || '').toUpperCase() || null, title.media?.audioChannels ? `${title.media.audioChannels} channels` : null].filter(Boolean).join(' · ') || 'not reported'}</dd>
        <dt>Subtitles</dt>
        <dd>
          {titleSubs === null
            ? 'Looking…'
            : titleSubs.length
              ? `${titleSubs.length} available`
              : 'None'}
        </dd>
        {title.media?.size ? <><dt>File</dt><dd>{fmtBytes(title.media.size)}</dd></> : null}
      </dl>
    </div>
  )

  const libraryScreen = (
    <div
      className='app'
      onTouchStart={onPullStart}
      onTouchMove={onPullMove}
      onTouchEnd={onPullEnd}
      onTouchCancel={onPullEnd}
    >
      <div className='ptr' style={{ height: ptr }}>
        {ptr > 0 && (
          <ArrowsClockwise
            size={18}
            className={refreshing ? 'spin' : ''}
            // During the PULL the icon turns with the gesture. Once REFRESHING
            // the inline transform is dropped so `.spin` owns it: an inline
            // transform becomes the animation's implicit start, so the spin
            // would sweep from wherever the pull left it and snap back every
            // cycle. That was a real, visible hitch in the donor.
            style={{
              opacity: Math.min(1, ptr / PULL_TRIGGER),
              ...(refreshing ? {} : { transform: `rotate(${ptr * 3}deg)` })
            }}
          />
        )}
      </div>
      <header>
        {/* The title IS the library menu: the blend, one library, or Add a
            library - with a single library it is just the Add row, so a solo
            user can still add a second from here. */}
        <div className='libhead'>
          <button
            className={'libpick' + (libMenuOpen ? ' open' : '')}
            onClick={() => { haptic('light'); setLibMenuOpen((o) => !o) }}
            aria-haspopup='menu'
            aria-expanded={libMenuOpen}
          >
            <h1>{libTitle}</h1>
            <CaretDown size={16} weight='bold' className='libcaret' />
          </button>

          {libMenuOpen && (
            <>
              <div className='libmenu-backdrop' onClick={() => setLibMenuOpen(false)} />
              <div className='libmenu' role='menu'>
                {canSwitch && (
                  <>
                    <button
                      role='menuitem'
                      className={mergedFilter === '_all' ? 'on' : ''}
                      onClick={() => { pickFilter('_all'); setLibMenuOpen(false) }}
                    >
                      All libraries
                    </button>
                    {state.hosts.map((h) => (
                      <button
                        key={h.libraryId}
                        role='menuitem'
                        className={(mergedFilter === h.libraryId ? 'on' : '') + (h.online === false && !h.inMerge ? ' off' : '')}
                        onClick={() => { pickFilter(h.libraryId); setLibMenuOpen(false) }}
                        title={h.online === false && !h.inMerge ? 'Offline' : undefined}
                      >
                        {h.libraryName || 'Library'}
                      </button>
                    ))}
                    <div className='libmenu-sep' />
                  </>
                )}
                <button
                  role='menuitem'
                  className='libmenu-add'
                  onClick={() => { setLibMenuOpen(false); setAddingLibrary(true) }}
                >
                  <Plus size={15} weight='bold' /> Add a library
                </button>
              </div>
            </>
          )}
        </div>
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

      {/* The same arrow inside a show, so leaving a screen looks the same wherever
          you are. The header above it already names where that is. */}
      {series && (
        <button
          className='backarrow'
          onClick={() => (season ? setSeason(null) : setSeries(null))}
          aria-label={season ? 'Back to the show' : 'Back to Shows'}
        ><CaretLeft size={22} /></button>
      )}

      {err && <div className='error'>{err}</div>}

      {/* THE LIBRARY IS NOT EMPTY, IT IS UNREACHABLE, and those look identical from
          here. Said above the shelf rather than in place of it, because whatever was
          already loaded still plays - a download on this phone does not need the
          host's disk at all. */}
      {lostLibs.map((l) => (
        <div className='error' key={l.libraryId}>
          <b>{l.libraryName} cannot reach its films.</b> {l.sourceError}
        </div>
      ))}

      {/* The marker. Nobody should discover after the fact that their films took the
          long way round, and the quality drop is a fact worth explaining before it is
          noticed rather than after. One line, and only while it is true. */}
      {relayLibs.some((l) => l.relayed) && (
        <div className='relaybar'>
          <Broadcast size={15} weight='fill' />
          <span>
            {relayLibs.filter((l) => l.relayed).length > 1
              ? 'Some of your libraries are coming through a relay, so films are capped near 2.5 Mbps.'
              : `${relayLibs.find((l) => l.relayed)?.libraryName || 'This library'} is coming through a relay, so films are capped near 2.5 Mbps.`}
            {relayUsage?.warning && ' ' + relayUsage.warning.message}
          </span>
        </div>
      )}

      {(items == null && !results) || waitingArt ? <Loading connecting={!linkUp} /> : null}

      {/* Rendered but held back while the first screenful of artwork settles: hidden with
          opacity rather than display, or the browser would never start the very image
          loads being waited on. Pointer events go too, so nothing can be tapped through
          the spinner. */}
      <div className={waitingArt ? 'artwait' : ''}>

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
            ? <Grid items={results} artBase={artBase} savedSet={saved} onOpen={open} onLong={longPress} onSave={toggleSave} cols={cols} onArtReady={noteArt} isUnreachable={(i) => !reach(i).openable} />
            : <p className='muted center-p'>Nothing matches "{query}".</p>)
        : season
          ? (
            <ul className='tracks'>
              {items.map((e) => (
                <ItemRow
                  key={e.id} item={e} onOpen={open} onLong={longPress}
                  // `episodeNumber` is what the item model has always called it
                  // (items.js). This read `e.episode`, which is a SORT key's
                  // name and not a field, so no episode row has ever shown its
                  // number - found writing the next-up card, which needs the
                  // same words.
                  sub={[e.episodeNumber != null ? `Episode ${e.episodeNumber}` : null, fmtRuntime(e.runtime)].filter(Boolean).join(' · ')}
                  right={watchedIds.has(e.id) ? <CheckCircle size={18} weight='fill' className='muted' /> : null}
                />
              ))}
            </ul>
            )
          : <Grid items={items} artBase={artBase} savedSet={saved} onOpen={open} onLong={longPress} onSave={!series ? toggleSave : null} cols={cols} onArtReady={noteArt} isUnreachable={(i) => !reach(i).openable} />)}

      {!results && cursor && (
        <button
          className='ghost' style={{ margin: '0.8rem auto', display: 'block' }}
          onClick={() => fetchList(season ? { type: 'episodes', seasonId: season.id, limit: 200, cursor } : series ? { type: 'seasons', seriesId: series.id, limit: 100, cursor } : { type: root, limit: 100, cursor, sort: sortField || 'title', order: sortOrder }, true)}
        >More</button>
      )}
      </div>
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
          : <Grid items={savedItems} artBase={artBase} savedSet={saved} onOpen={open} onLong={longPress} onSave={toggleSave} cols={cols} isUnreachable={(i) => !reach(i).openable} />}
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
              <>
                <ul className='tracks'>
                  {(showAllContinue ? continueRows : continueRows.slice(0, SHELF_MAX)).map((r) => (
                    <ItemRow
                      key={r.id} item={r} onOpen={open} onLong={longPress}
                      sub={`${fmtClock(r.resume?.positionMs || 0)} in${r.runtime ? ` · ${fmtRuntime(r.runtime)}` : ''}`}
                      // FORGETTING IS NOT FINISHING. Marking something watched
                      // already takes it off this list, and for anything
                      // abandoned rather than finished that is a lie which then
                      // shows up as a tick everywhere else.
                      right={(
                        <button
                          className='rowicon' aria-label='Remove from Continue watching' title='Remove from Continue watching'
                          onClick={(e) => { e.stopPropagation(); forgetPlace(r) }}
                        ><Trash size={18} /></button>
                      )}
                    />
                  ))}
                </ul>
                {continueRows.length > SHELF_MAX && (
                  <button className='ghost' style={{ margin: '1.2rem auto 0.4rem', display: 'block' }} onClick={() => setShowAllContinue((v) => !v)}>
                    {showAllContinue ? 'Show fewer' : `Show all ${continueRows.length}`}
                  </button>
                )}
                {/* THE ONE THAT KEEPS ITS WORDS, and only its words. Every button in a
                    ROW is a mark, because a row is read at a glance; this one is not in a
                    row and empties the whole list, so it is plain text - and no icon
                    beside it, or the same bin means two different sizes of act on one
                    screen (Tim, 2026-08-21). It stands well clear of the last row, so
                    nobody reaches for it while aiming at one film. */}
                <button className='danger' style={{ margin: '1.6rem auto 1rem', display: 'block' }} onClick={() => setClearAsk(true)}>
                  Clear list
                </button>
              </>
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
                    right={(
                      <button
                        className='rowicon' aria-label='Mark as not watched' title='Mark as not watched'
                        onClick={(e) => { e.stopPropagation(); markWatched(r, false) }}
                      ><Trash size={18} /></button>
                    )}
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
                        <button
                          className='rowicon' aria-label='Withdraw this request' title='Withdraw this request'
                          onClick={() => call('request.remove', { id: r.id, refs: r.refs }).then(() => loadYou('requests'))}
                        ><Trash size={16} /></button>
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
                  <button
                    className='rowicon' aria-label='Cancel this download' title='Cancel this download'
                    onClick={() => call('download.cancel', { itemId: r.itemId })}
                  ><Trash size={18} /></button>
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
                  <p className='sm'>Hold a film and choose Download. It plays with no connection once it is here.</p>
                </div>
                )
              : (
                <ul className='tracks'>
                  {dlRows.map((r) => (
                    <ItemRow
                      key={r.id} item={r} onOpen={open} onLong={longPress}
                      sub={`${fmtBytes(r._dlSize)} on this phone`}
                      right={(
                        <button
                          className='rowicon' aria-label='Remove from this phone' title='Remove from this phone'
                          onClick={(e) => { e.stopPropagation(); call('download.remove', { itemId: r.id }) }}
                        ><Trash size={18} /></button>
                      )}
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
                      {/* A PAIR, so they read as a pair: tick and cross, the shape every
                          accept-or-refuse row in the world uses. Both carry their words
                          for a screen reader, and the sub-line already says what is being
                          answered - which is what lets the answer be two marks. */}
                      <div className='rowacts'>
                        <button
                          className='rowicon' aria-label={'Mark "' + r.name + '" as added'} title='I have added this'
                          onClick={() => call('request.resolve', { id: r.id, status: 'added', refs: r.refs }).then(() => loadYou('manage'))}
                        ><CheckCircle size={17} /></button>
                        <button
                          className='rowicon' aria-label={'Decline "' + r.name + '"'} title='Decline this'
                          onClick={() => call('request.resolve', { id: r.id, status: 'declined', refs: r.refs }).then(() => loadYou('manage'))}
                        ><X size={17} /></button>
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
                    {!d.self && (
                      <button
                        className='rowicon'
                        aria-label={'Cut off ' + (d.label || 'device')}
                        onClick={() => setRevoking(d)}
                      ><Prohibit size={17} /></button>
                    )}
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
              ? `The server still has this device down as ${ident.belongsTo}. It is waiting to confirm you are ${ident.userName}. Only the person running it can move a device to someone else.`
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
            <button className='libact' aria-label='Pair as owner' title='Pair as owner. Manage a server you run' onClick={() => setAddingLibrary(true)}>
              <UsersThree size={22} weight='bold' />
              <span>Pair as owner</span>
            </button>
          </div>
          {hosts.map((h) => {
            const online = h.active && linkUp
            const desc = h.active
              ? (linkUp ? 'Active, connected' : 'Active, connecting…')
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
          {/* THE OVERRIDE HAS TO BE SAID HERE (Tim, 2026-08-18, watching a relayed film
              with Full quality still selected). The cap is forced in the worklet and this
              control is the person's PREFERENCE, which is why the dot does not move - but
              a screen that shows Full quality while the film is capped reads as a broken
              cap rather than as a working one. So the section says which is in force. */}
          {relayLibs.some((l) => l.relayed) && (
            <div className='relaybar' style={{ marginBottom: '.6rem' }}>
              <Broadcast size={15} weight='fill' />
              <span>
                Capped near 2.5 Mbps right now, whichever of these is picked, because a library is
                coming through a relay. Your choice below comes back the moment it connects directly.
              </span>
            </div>
          )}
          <OptionList
            options={[
              { value: 'auto', label: 'Full quality', desc: 'The file as it is; your box converts only when this phone cannot play it' },
              { value: 'saver', label: 'Data saver', desc: 'Capped near 2.5 Mbps. Your box converts bigger films down, for cellular and slow links.' }
            ]}
            value={dataSaver ? 'saver' : 'auto'}
            onChange={(v) => { setDataSaver(v === 'saver'); call('setSettings', { dataSaver: v === 'saver' }).catch(() => {}) }}
          />
          <p className='desc' style={{ marginTop: '.6rem' }}>Downloads always take the full file, whatever is picked above.</p>

          {/* STORAGE, PearTune's shape (Tim, 2026-08-18). Films and artwork are separated
              because they behave differently: films are big and deliberate, artwork is
              small and automatic. Clearing films is about space; refreshing artwork is
              about a poster being wrong, and costs only a re-download. */}
          <div className='label' style={{ marginTop: '1rem' }}>Keep films on this phone up to</div>
          <div className='desc'>
            Films you play are kept for a while so watching one again does not download it twice.
            A film you downloaded on purpose is never cleared by this.
          </div>
          <StepSlider
            options={FILM_CAPS}
            value={storage?.films?.cap ?? 2 * 1024 * 1024 * 1024}
            ariaLabel='Keep films on this phone up to'
            onChange={(bytes) => {
              call('storage.setCap', { bytes })
                .then((r) => setStorage((s) => ({ ...(s || {}), films: { ...(s?.films || {}), ...r.films, cap: r.cap } })))
                .catch(() => {})
            }}
          />
          <div className='row' style={{ marginTop: '.6rem' }}>
            <div><div className='label'>Films using</div></div>
            <span className='val'>
              {fmtBytes(storage?.films?.bytes || 0)}
              {storage?.films?.count ? ` · ${storage.films.count} film${storage.films.count === 1 ? '' : 's'}` : ''}
            </span>
          </div>
          <button
            className='wide' style={{ marginTop: '.4rem' }}
            disabled={!storage?.films?.count}
            onClick={() => {
              call('storage.clearFilms')
                .then((r) => {
                  setStorage((s) => ({ ...(s || {}), films: { ...(s?.films || {}), ...r.films } }))
                  say(r.removed ? 'Cleared what playback left behind' : 'Nothing to clear')
                })
                .catch((e) => setErr(e.message))
            }}
          ><Trash size={16} weight='bold' /> Clear kept films
          </button>

          <div className='label' style={{ marginTop: '.9rem' }}>Artwork</div>
          <div className='desc'>
            Posters are saved on this phone the first time they load, so browsing does not fetch them
            again. If a poster looks wrong or out of date, fetch them again.
          </div>
          <div className='row'>
            <div><div className='label'>Artwork using</div></div>
            <span className='val'>
              {fmtBytes(storage?.art?.bytes || 0)}
              {storage?.art?.count ? ` · ${storage.art.count} poster${storage.art.count === 1 ? '' : 's'}` : ''}
            </span>
          </div>
          <button
            className='wide' style={{ marginTop: '.4rem' }}
            onClick={() => {
              call('storage.refreshArt')
                .then((r) => {
                  // The new base is what makes the WebView's own cache miss, so taking it
                  // back is the whole point - without it the old posters keep rendering
                  // and a refresh looks like it did nothing.
                  if (r.base) setArtBase(r.base)
                  setStorage((s) => ({ ...(s || {}), art: r.art }))
                  say('Posters will be fetched again')
                })
                .catch((e) => setErr(e.message))
            }}
          ><ArrowsClockwise size={16} weight='bold' /> Refresh artwork
          </button>
        </Section>

        {/* The relay, said plainly. Two things a person deserves to know before this is
            on: their films may pass through a PeerLoom server on the way, and turning it
            off can mean not connecting at all from some networks. Both are here rather
            than in a privacy page nobody opens. */}
        <Section id='connection' title='Connection' Icon={Broadcast} open={settingsOpen === 'connection'} onToggle={toggleSection}>
          <div className='row'>
            <div>
              <div className='label'>Connect through a relay when needed</div>
              <div className='desc'>
                Some networks, mobile data especially, will not let two devices talk directly. A relay
                is a middleman that passes the film along when that happens. It cannot see what you are
                watching. Films that arrive this way are capped near 2.5 Mbps to keep the relay affordable.
              </div>
            </div>
            <Switch
              on={useRelay}
              label='Connect through a relay when needed'
              onChange={(next) => { setUseRelay(next); call('setSettings', { useRelay: next }).catch(() => {}) }}
            />
          </div>
          {!useRelay && (
            <p className='desc' style={{ marginTop: '.6rem' }}>
              With this off, nothing ever leaves your own network. On a connection that cannot reach your
              library directly, that means it will not open at all.
            </p>
          )}
          <div className='label' style={{ marginTop: '.9rem' }}>Your own relay</div>
          <div className='desc'>
            If you run your own relay, paste its key here and yours is used instead of ours. Leave it empty
            unless you know you have one.
          </div>
          <input
            className='profile-name' style={{ marginTop: '.5rem' }} value={ownRelayKey}
            placeholder='Relay key (optional)' maxLength={64} aria-label='Your own relay key'
            onInput={(e) => { setOwnRelayKey(e.currentTarget.value); setRelayKeySaved(false) }}
          />
          {relayUsage && (
            <>
              <div className='label' style={{ marginTop: '.9rem' }}>This month through the relay</div>
              {/* The figure is the thing being looked FOR, so it is read at a glance
                  rather than found inside a paragraph (Tim, 2026-08-18). */}
              <div className='usagefig'>
                {relayUsage.bytes > 0
                  ? (relayUsage.bytes >= 1e9
                      ? (relayUsage.bytes / 1e9).toFixed(1) + ' GB'
                      : Math.max(1, Math.round(relayUsage.bytes / 1e6)) + ' MB')
                  : 'Nothing yet'}
              </div>
              <div className='desc'>
                The relay is shared with everyone using PearCinema, so this counts towards the same
                monthly allowance they use. Nothing is ever cut off part way through a film.
              </div>
            </>
          )}
          {relayLibs.length > 0 && (
            <>
              <div className='label' style={{ marginTop: '.9rem' }}>Your libraries</div>
              {relayLibs.map((l) => (
                <div className='row' key={l.libraryId}>
                  <div>
                    <div className='label'>{l.libraryName || 'A library'}</div>
                    <div className='desc'>
                      {l.relayed ? 'Coming through a relay right now. ' : 'Connected directly. '}
                      {l.consent === 'allow' && 'Films may use the relay.'}
                      {l.consent === 'deny' && 'You said no to films over the relay.'}
                      {l.consent === 'ask' && 'You will be asked once, the first time a film needs it.'}
                    </div>
                  </div>
                  {l.consent !== 'ask' && (
                    <button
                      className='ghost'
                      onClick={async () => {
                        await call('relay.consent.set', { libraryId: l.libraryId, decision: 'ask' }).catch(() => {})
                        refreshRelay()
                        say('You will be asked again next time')
                      }}
                    >Ask again</button>
                  )}
                </div>
              ))}
            </>
          )}
          {!relayKeySaved && (
            <button
              className='profile-save'
              onClick={async () => {
                await call('setSettings', { ownRelayKey: ownRelayKey.trim() }).catch(() => {})
                setRelayKeySaved(true)
                haptic('success')
                say(ownRelayKey.trim() ? 'Your relay will be used from the next connection' : 'Back to the PeerLoom relay')
              }}
            >Save
            </button>
          )}
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
            <Switch
              on={showRecent}
              label='Recently added row'
              onChange={(next) => setDisplay({ showRecent: next })}
            />
          </div>

          <div className='row' style={{ marginTop: '.7rem' }}>
            <div>
              <div className='label'>Play the next episode</div>
              <div className='desc'>
                When an episode ends, the next one starts after a ten second
                countdown you can stop.
              </div>
            </div>
            <Switch
              on={autoplayNext}
              label='Play the next episode'
              onChange={(next) => {
                setAutoplayNext(next)
                call('setSettings', { autoplayNext: next }).catch(() => {})
              }}
            />
          </div>

          <div className='label' style={{ marginTop: '.7rem' }}>Player skin</div>
          <div className='seg'>
            {[['off', 'None'], ['film', '35mm film'], ['mst3k', 'Riff mode']].map(([k, l]) => (
              <button
                key={k} className={playerSkin === k ? 'on' : ''}
                aria-pressed={playerSkin === k}
                onClick={() => { setPlayerSkin(k); call('setSettings', { playerSkin: k }).catch(() => {}) }}
              >{l}</button>
            ))}
          </div>
          <div className='desc'>
            A look laid over the player: sprocket holes and a film border, or
            riff mode. IFKYK. Just for fun, off by default.
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
          already live on (an Umbrel, a NAS, an old desktop) over an encrypted
          peer-to-peer connection. No port forwarding, no VPN, no dynamic DNS, no
          account, and no copy of your library in anyone's cloud.
        </p>
        <p>
          The machine does not have to be yours. Whoever runs a library can let a
          friend or family member in, each as their own person with their own
          devices, watchlist and resume points. No login to pass around, and no
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
      {tab === 'library' && (titleScreen || libraryScreen)}
      {tab === 'you' && youScreen}
      {tab === 'watchlist' && watchlistScreen}
      {tab === 'settings' && settingsScreen}
      {tab === 'about' && aboutScreen}

      {/* The dock is the donor's fixed bottom container; the cast bar rides
          above the navbar the way the donor's mini-player did - the phone is
          the remote while a TV plays, and the remote should be one glance and
          one tap from anywhere. */}
      <div className='dock'>
        {casting && (
          <div className='castbar'>
            <Screencast size={20} />
            <div className='meta'>
              <div className='t'>{casting.title}</div>
              {/* The television's name gives way, the minute does not: a long
                  name must not push the one changing number off the bar, and
                  the total is left to the progress line rather than said twice. */}
              <div className='sub muted sm'>
                <span className='where'>on {casting.name}</span>
                {castShownMs != null && <span className='at'> · {fmtClock(castShownMs)}</span>}
              </div>
            </div>
            <div className='acts'>
              {!casting.noSkip && (
                <button aria-label='Back thirty seconds' disabled={casting.seeking} onClick={() => castSkip(-SKIP_MS)}>
                  <Rewind size={19} />
                </button>
              )}
              <button aria-label={casting.paused ? 'Resume the TV' : 'Pause the TV'} onClick={toggleCastPause}>
                {casting.paused ? <Play size={20} /> : <Pause size={20} />}
              </button>
              {!casting.noSkip && (
                <button aria-label='Forward thirty seconds' disabled={casting.seeking} onClick={() => castSkip(SKIP_MS)}>
                  <FastForward size={19} />
                </button>
              )}
              <button aria-label='Stop the TV' onClick={stopCast}><X size={20} /></button>
            </div>
            {/* The same fact as the numbers, in the form you can read without
                reading - it sits on the bar's own bottom edge. */}
            {castAt?.durationMs > 0 && (
              <div className='castprog' aria-hidden='true'>
                <i style={{ width: `${Math.max(0, Math.min(100, (castShownMs / castAt.durationMs) * 100))}%` }} />
              </div>
            )}
          </div>
        )}
        <NavBar
          active={tab} saved={saved.size} busy={dlRunning.length}
          onTab={(k) => {
            // The dot's tap-through: entering You while downloads run lands on
            // the Downloads view they point at. Moving WITHIN You stays free.
            if (k === 'you' && tab !== 'you' && dlRunning.length > 0) setYouView('downloads')
            setTab(k); setErr('')
          }}
        />
      </div>

      {sheet && (
        <ActionSheet
          item={sheet} saved={saved.has(sheet.id)} watched={watchedIds.has(sheet.id)}
          downloaded={dlIds.has(sheet.id)}
          libraryNames={new Map((state?.hosts || []).map((h) => [h.libraryId, h.libraryName || 'Library']))}
          onClose={() => setSheet(null)} onPlay={open} onSave={toggleSave} onWatched={markWatched} onCast={openCast}
          onDownload={toggleDownload}
        />
      )}

      {castSheet && (
        <CastSheet
          sheet={castSheet}
          hostCount={(state?.hosts || []).length}
          onPick={castTo}
          onClose={() => setCastSheet(null)}
        />
      )}

      {revoking && (
        <div className='sheetwrap' onClick={() => setRevoking(null)}>
          <div className='sheet' onClick={(e) => e.stopPropagation()}>
            <h3>Cut off {revoking.label || 'this device'}?</h3>
            <p className='muted sm'>
              Access ends within the second. Anything it is streaming stops, and anything it put
              on a TV goes dark. Pairing again is the only way back in.
            </p>
            <div className='acts'>
              <button
                className='danger'
                onClick={() => {
                  const d = revoking
                  setRevoking(null)
                  call('device.revoke', { deviceKey: d.deviceKey })
                    .then(() => { say('Cut off within the second'); loadYou('manage') })
                    .catch((e) => setErr(e.message))
                }}
              ><Prohibit size={18} /> Cut off</button>
              <button className='ghost' onClick={() => setRevoking(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Clearing FORGETS the places rather than hiding the list (Tim,
          2026-08-20), so it says so and asks - the app's own sheet, for the
          same reason revoke's is: a WebView's confirm() is at the shell's
          mercy. */}
      {clearAsk && (
        <div className='sheetwrap' onClick={() => setClearAsk(false)}>
          <div className='sheet' onClick={(e) => e.stopPropagation()}>
            <h3>Clear Continue watching?</h3>
            <p className='muted sm'>
              Every place you are part way through will be forgotten, and those films
              will start from the beginning again. This cannot be undone.
            </p>
            <div className='acts'>
              <button className='danger' onClick={clearContinue}>Clear it</button>
              <button className='ghost' onClick={() => setClearAsk(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Asked ONCE per library, before a film crosses a relay. Not a warning dialog:
          browsing already came this way and nobody was asked, because it was kilobytes.
          A film is the first thing worth stopping for, and the answer is remembered. */}
      {relayAsk && (
        <div className='sheetwrap' onClick={() => setRelayAsk(null)}>
          <div className='sheet' onClick={(e) => e.stopPropagation()}>
            <h3>Play over a relay?</h3>
            <p className='muted sm'>
              This network will not let your phone reach {relayAsk.libraryName || 'this library'} directly, so
              the film would come by way of a relay - a middleman that passes it along without being able to
              see what you are watching. It arrives at a lower quality to keep the relay affordable.
              {' '}Answered once, and remembered for this library.
            </p>
            <div className='acts'>
              <button
                onClick={async () => {
                  const ask = relayAsk
                  setRelayAsk(null)
                  try {
                    await call('relay.consent.set', { libraryId: ask.libraryId, decision: 'allow' })
                    const res = await call('stream.url', { itemId: ask.item.id })
                    if (res?.url) await play(ask.item, res.url, 0)
                  } catch (e) { setErr(e.message) }
                }}
              ><Play size={18} weight='fill' /> Play it</button>
              <button
                className='ghost'
                onClick={async () => {
                  const ask = relayAsk
                  setRelayAsk(null)
                  await call('relay.consent.set', { libraryId: ask.libraryId, decision: 'deny' }).catch(() => {})
                  say('Films from this library will not use a relay')
                }}
              >Not over a relay</button>
            </div>
          </div>
        </div>
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
                .then(() => { setAskTitle(false); say('Asked. The owner will see it'); loadYou('requests') })
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
                    aria-label={sortOrder === 'asc' ? 'Ascending. Tap for descending' : 'Descending. Tap for ascending'}
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
