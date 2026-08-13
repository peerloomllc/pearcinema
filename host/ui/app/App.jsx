// The shell.
//
// Three places, and the split is deliberate: WATCH (the library and the player),
// WHO (devices and people, where revoke lives) and SETTINGS (the source, the name,
// the password). PearTune's dashboard had no first tab at all, which is the gap
// this app closes.

import { useState, useEffect, useCallback } from 'preact/hooks'
import { api } from './api'
import { Modal, ConfirmHost, notify, loadThemePref, applyThemePref } from './ui'
import { needsSetup, setupDismissed, undismissSetup } from './setup'
import { probeCapabilities } from './playback'
import { Mark, Search, Close } from './icons'
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
  const [theme, setTheme] = useState(loadThemePref())

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
        <h3>Appearance</h3>
        <div class='row'>
          {['system', 'dark', 'light'].map(t => (
            <button key={t} class={theme === t ? '' : 'ghost'} onClick={() => { setTheme(t); applyThemePref(t) }}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
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

  const play = (item, list) => { setQueue(list || []); setPlaying(item) }

  const online = (state.devices || []).filter(d => d.online && !d.revokedAt).length

  return (
    <div class='shell'>
      <div class='topbar'>
        <div class='brand'><Mark size={22} />Pear<span>Cinema</span></div>
        <div class='tabs'>
          <button class={'tab' + (tab === 'watch' ? ' on' : '')} onClick={() => { setTab('watch'); setPlaying(null) }}>Watch</button>
          <button class={'tab' + (tab === 'who' ? ' on' : '')} onClick={() => setTab('who')}>
            Devices{online ? ` · ${online} on` : ''}
          </button>
          <button class={'tab' + (tab === 'settings' ? ' on' : '')} onClick={() => setTab('settings')}>Settings</button>
        </div>
        <div class='spacer' />
        {tab === 'watch' && !playing && (
          <div class='searchbox'>
            <Search size={15} />
            <input
              type='text' value={search} placeholder='Search the library'
              onInput={e => setSearch(e.currentTarget.value)}
            />
            {search && <button class='iconbtn' onClick={() => setSearch('')} aria-label='Clear'><Close size={15} /></button>}
          </div>
        )}
        <button onClick={() => setPairing(true)}>Pair a device</button>
      </div>

      <div class='content'>
        {wizard && <Wizard state={state} reload={reload} onDone={() => { setWizard(false); reload() }} />}

        {!wizard && tab === 'watch' && (
          playing
            ? (
              <Player
                item={playing}
                caps={CAPS}
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
                caps={CAPS}
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

      {pairing && (
        <Modal title='Pair a device' onClose={() => setPairing(false)}>
          <Pair state={state} reload={reload} onClose={() => setPairing(false)} />
        </Modal>
      )}

      <ConfirmHost />
    </div>
  )
}
