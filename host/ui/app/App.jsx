// The shell.
//
// Three places, and the split is deliberate: WATCH (the library and the player),
// WHO (devices and people, where revoke lives) and SETTINGS (the source, the name,
// the password). PearTune's dashboard had no first tab at all, which is the gap
// this app closes.

import { useState, useEffect, useCallback } from 'preact/hooks'
import { api } from './api'
import { Modal, ConfirmHost, notify, loadThemePref, applyThemePref, resolveTheme } from './ui'
import { needsSetup, setupDismissed, undismissSetup } from './setup'
import { probeCapabilities } from './playback'
// `People` is the devices SCREEN; `PeopleIcon` is the picture of one.
import { Home, Search, Close, Gear, Sun, Moon, People as PeopleIcon } from './icons'
import Library from './Library'
import Player from './Player'
import People from './People'
import Pair from './Pair'
import SourcePanel from './SourcePanel'
import Wizard from './Wizard'

// Asked once. canPlayType cannot change while the page is open, and every poster in
// a 274-film grid would otherwise ask again.
const CAPS = probeCapabilities()

function Settings ({ state, reload }) {
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
    <>
      <SourcePanel state={state} reload={reload} />

      <div class='card'>
        <h3>The library's name</h3>
        <div class='row'>
          <input type='text' value={name} maxLength={64} onInput={e => setName(e.currentTarget.value)} />
          <button onClick={saveName} disabled={!name.trim() || name === state.library}>Save</button>
        </div>
      </div>

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
            <button onClick={savePassword} disabled={!cur || next.length < 8}>Change it</button>
          </>
        )}
      </div>

      <div class='card'>
        <h3>This host</h3>
        <p class='hint mono' style='word-break:break-all'>{state.hostKey}</p>
        <p class='hint'>
          That is this library's address on the network PearCinema uses. It is not a
          secret, and it is not enough on its own to get in - a device also needs a
          grant, which only pairing creates.
        </p>
        <button class='ghost' onClick={() => { undismissSetup(); location.reload() }}>Run first-time setup again</button>
        <button class='ghost' style='margin-left:.5rem' onClick={async () => { await api('/api/logout', {}); location.reload() }}>Log out</button>
      </div>
    </>
  )
}

export default function App () {
  const [state, setState] = useState(null)
  const [tab, setTab] = useState('watch')
  const [search, setSearch] = useState('')
  const [playing, setPlaying] = useState(null)
  const [queue, setQueue] = useState([])
  const [pairing, setPairing] = useState(false)
  const [wizard, setWizard] = useState(false)
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
    return s
  }, [])

  useEffect(() => {
    applyThemePref(loadThemePref())
    reload().then(s => { if (needsSetup(s) && !setupDismissed()) setWizard(true) })
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
  const caps = { ...CAPS, hostTranscode: !!state.transcode?.available }

  const play = (item, list) => { setQueue(list || []); setPlaying(item) }

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
        {wizard && <Wizard state={state} reload={reload} onDone={() => { setWizard(false); reload() }} />}

        {!wizard && tab === 'watch' && (
          playing
            ? (
              <Player
                item={playing}
                caps={caps}
                queue={queue}
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
                state={state}
                caps={caps}
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
        {!wizard && tab === 'settings' && <Settings state={state} reload={reload} />}
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
