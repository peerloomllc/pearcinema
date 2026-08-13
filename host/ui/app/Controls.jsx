// ONE SET OF CONTROLS FOR EVERY FILM.
//
// The browser's own controls were used at first, with our scrub bar added underneath
// only for repackaged films - because a repackaged film's native timeline is
// meaningless, it knows only the seconds it has actually received. That produced
// exactly the confusion Tim reported: some films had two bars and some had one, and
// the two disagreed with each other.
//
// So the native controls are gone and these replace them everywhere. The user should
// not be able to tell, from the controls, whether a film is being repackaged - that
// is the host's business, not theirs. What differs is only what a seek MEANS:
//
//   playing from the file - set currentTime. Instant, the browser has the whole file.
//   repackaged            - ask the host to start again there. A second's rebuffer.
//
// Both look identical here, which is the point.
//
// It also has to carry what the native controls gave away for free: volume, mute,
// fullscreen and a subtitle picker. Losing the subtitle picker in particular would
// have been a real regression on a library with 383 subtitle files in it.

import { useState, useEffect, useRef } from 'preact/hooks'
import { fmtClock } from './api'
import { Captions, Volume, Muted, Play, Pause, Back10, Forward10 } from './icons'

export default function Controls ({ video, at, duration, onSeek, busy, subs, live }) {
  // FALSE, because nothing starts on its own any more. It used to assume playing,
  // which was true while the element carried `autoplay` and became a lie the moment it
  // did not: a film sitting paused on open showed a pause button (Tim, 2026-08-13).
  // The effect below then keeps it honest off the element's own events.
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [subMenu, setSubMenu] = useState(false)
  const [subOn, setSubOn] = useState(-1)
  const [full, setFull] = useState(false)
  const wrap = useRef(null)

  const el = () => video.current

  // The element is replaced on every seek of a repackaged film (a new src means a
  // new stream), so play state has to be read off events rather than remembered.
  useEffect(() => {
    const v = el()
    if (!v) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    // Read where it actually IS as well as listening for changes. A new element (every
    // seek of a repackaged film is one) fires nothing until something happens to it,
    // so state carried over from the old one would be stale until the first event.
    setPlaying(!v.paused)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.volume = volume
    v.muted = muted
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  })

  useEffect(() => {
    const onFs = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const toggle = () => {
    const v = el()
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }

  const nudge = (by) => onSeek(Math.max(0, Math.min(at + by, duration ? duration - 2 : at + by)))

  // Keyboard, because a film is watched from the sofa and not from the mouse. Skipped
  // while a text field has focus, so typing a search does not pause the film.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle() }
      else if (e.key === 'ArrowRight') nudge(10)
      else if (e.key === 'ArrowLeft') nudge(-10)
      else if (e.key === 'f') fullscreen()
      else if (e.key === 'm') setMute(!muted)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const setVol = (v) => {
    setVolume(v); setMuted(v === 0)
    if (el()) { el().volume = v; el().muted = v === 0 }
  }
  const setMute = (m) => {
    setMuted(m)
    if (el()) el().muted = m
  }

  const fullscreen = () => {
    const target = wrap.current?.closest('.stagewrap') || wrap.current
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else target?.requestFullscreen?.().catch(() => {})
  }

  // Subtitle tracks live on the element rather than in our state, because the browser
  // owns rendering them. -1 is off.
  const pickSub = (i) => {
    setSubOn(i); setSubMenu(false)
    const v = el()
    if (!v) return
    for (let n = 0; n < v.textTracks.length; n++) {
      v.textTracks[n].mode = n === i ? 'showing' : 'disabled'
    }
  }

  const pct = duration ? Math.min(100, (at / duration) * 100) : 0

  return (
    <div class='controls' ref={wrap}>
      {/* ONE BAR, ALWAYS, whatever the host is doing behind it. */}
      <input
        class='scrub'
        type='range'
        min='0'
        max={Math.max(1, Math.floor(duration || 0))}
        value={Math.floor(at)}
        disabled={!duration}
        style={`--played:${pct}%`}
        onInput={e => onSeek(Number(e.currentTarget.value))}
        aria-label='Position'
      />

      <div class='row'>
        <button class='iconbtn big' onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button class='iconbtn' onClick={() => nudge(-10)} aria-label='Back ten seconds'><Back10 size={20} /></button>
        <button class='iconbtn' onClick={() => nudge(10)} aria-label='Forward ten seconds'><Forward10 size={20} /></button>

        <span class='hint mono'>
          {fmtClock(at)}{duration ? ' / ' + fmtClock(duration) : ''}
        </span>

        {busy && <span class='chip accent'>starting…</span>}
        {/* Said once, quietly, rather than as a banner: it explains a second of
            rebuffer after a jump without making the film feel second-class. */}
        {live && !busy && <span class='chip' title='Repackaged as it streams, so a jump takes a moment'>repackaged</span>}

        <div class='spacer' />

        {subs.length > 0 && (
          <div class='submenu'>
            <button class='iconbtn' onClick={() => setSubMenu(!subMenu)} aria-label='Subtitles'><Captions size={19} /></button>
            {subMenu && (
              <div class='menu'>
                <button class={subOn === -1 ? 'on' : ''} onClick={() => pickSub(-1)}>Off</button>
                {subs.map((s, i) => (
                  <button key={s.id} class={subOn === i ? 'on' : ''} onClick={() => pickSub(i)}>
                    {s.title || s.language || 'Subtitles'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button class='iconbtn' onClick={() => setMute(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
          {muted || volume === 0 ? <Muted size={19} /> : <Volume size={19} />}
        </button>
        <input
          class='vol' type='range' min='0' max='1' step='0.05'
          value={muted ? 0 : volume}
          onInput={e => setVol(Number(e.currentTarget.value))}
          aria-label='Volume'
        />

        <button class='iconbtn' onClick={fullscreen} aria-label='Fullscreen'>
          <svg viewBox='0 0 24 24' width='19' height='19' fill='none' stroke='currentColor'
            stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>
            {full
              ? <path d='M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' />
              : <path d='M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' />}
          </svg>
        </button>
      </div>
    </div>
  )
}
