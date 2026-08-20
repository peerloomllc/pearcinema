// THE PAGE ABOUT ONE THING, before anything plays.
//
// Clicking a film used to start it. That is right on a phone in a hurry and wrong
// everywhere else: it is the only chance anybody gets to read what a film is, see how
// long it is, notice they are 41 minutes into it already, or find out that this
// particular file has no soundtrack their browser can decode. A player is a bad place
// to learn any of that, and a grid has room for none of it (Tim, 2026-08-20, with
// Plex's three screens).
//
// The shape is Plex's because it is the right shape and everybody already reads it:
// the poster on the left at the size it was drawn for, and to the right the title,
// one line of facts, the actions, and the summary. What sits under that differs - a
// film says what is actually inside the file, a show lists its seasons.
//
// WHAT WE DO NOT HAVE, and do not pretend to: cast, crew, ratings and reviews. Plex
// buys those from a metadata service. PearCinema asks TMDB for a poster and a summary
// and tells it nothing else (see the artwork panel's privacy sentence), so a page
// here is what the files and the library actually know. An empty "Cast & Crew" rail
// would be worse than none.

import { useState, useEffect } from 'preact/hooks'
import { api, withBase, fmtRuntime, fmtSize, fmtClock } from './api'
import { verdictFor, containerName } from './playback'
import { ArtIcon, Check, Play, Pencil } from './icons'

// The poster, big. Its own component only because the fallback matters: most of a
// hand-built library has no artwork on disk, and a page whose left half is an empty
// box reads as broken rather than as unillustrated.
function BigArt ({ item }) {
  const [bad, setBad] = useState(false)
  if (!item.artId || bad) {
    return <div class='bigart'><ArtIcon type={item.type} size={54} /></div>
  }
  return (
    <div class='bigart'>
      <img
        src={withBase('/api/art?id=' + encodeURIComponent(item.artId) + (item.artBust ? '&v=' + item.artBust : ''))}
        alt=''
        onError={() => setBad(true)}
      />
    </div>
  )
}

// ONE LINE OF FACTS, in the order somebody reads them, and only the ones this
// library actually knows. A year with nothing beside it is a fact; a row of empty
// slots where a rating would be is an apology.
function factLine (item) {
  const bits = []
  if (item.year) bits.push(String(item.year))
  if (item.type === 'movie' && item.runtime) bits.push(fmtRuntime(item.runtime))
  if (item.type === 'series') {
    bits.push(`${item.seasonCount || 0} season${item.seasonCount === 1 ? '' : 's'}`)
    if (item.episodeCount) bits.push(`${item.episodeCount} episode${item.episodeCount === 1 ? '' : 's'}`)
  }
  if (item.genres?.length) bits.push(item.genres.slice(0, 3).join(', '))
  return bits.join(' · ')
}

export function TitleHead ({ item, actions, children }) {
  return (
    <div class='titlehead'>
      <div class='titleart'><BigArt item={item} /></div>
      <div class='titlemain'>
        <h2 class='titlename'>{item.title}</h2>
        <p class='titlefacts'>{factLine(item)}</p>
        <div class='titleacts'>{actions}</div>
        {item.overview
          ? <p class='titlesum'>{item.overview}</p>
          : <p class='hint titlesum'>No summary for this one. Turn artwork on in Settings and PearCinema will ask TMDB for one.</p>}
        {children}
      </div>
    </div>
  )
}

// WHAT IS ACTUALLY INSIDE THE FILE, which is Plex's Video/Audio/Subtitles block and
// the one part of that page we can answer better than they can - because we are
// looking at the operator's own file rather than at a database entry about the film.
//
// It doubles as the honest warning: a file that cannot play in THIS browser says so
// here, before somebody presses play and gets a black rectangle.
export function FilmFacts ({ item, caps }) {
  const [subs, setSubs] = useState(null)
  useEffect(() => {
    let live = true
    api('/api/subtitles?itemId=' + encodeURIComponent(item.id))
      .then(r => { if (live) setSubs(r.items || []) })
      .catch(() => { if (live) setSubs([]) })
    return () => { live = false }
  }, [item.id])

  const m = item.media || {}
  const v = verdictFor(item, caps)
  const playable = subs === null ? [] : subs.filter(s => s.playable)
  const burnable = subs === null ? [] : subs.filter(s => !s.playable && s.burnable)

  const picture = [
    m.height ? `${m.height}p` : null,
    m.videoCodec ? m.videoCodec.toUpperCase() : null
  ].filter(Boolean).join(' · ') || 'not reported'

  const sound = [
    m.audioCodec ? m.audioCodec.toUpperCase() : null,
    m.audioChannels ? `${m.audioChannels} channels` : null
  ].filter(Boolean).join(' · ') || 'not reported'

  return (
    <dl class='titlefacts-grid'>
      <dt>Picture</dt><dd>{picture}</dd>
      <dt>Sound</dt><dd>{sound}</dd>
      <dt>Subtitles</dt>
      <dd>
        {subs === null
          ? 'Looking…'
          : playable.length
            ? `${playable.length} you can turn on` + (burnable.length ? `, ${burnable.length} pressed into the picture` : '')
            : burnable.length
              ? `${burnable.length}, and they are pictures - your box presses them into the film`
              : 'None'}
      </dd>
      <dt>File</dt>
      <dd>
        {containerName(m.container)}
        {m.size ? <span class='hint'> · {fmtSize(m.size)}</span> : null}
      </dd>
      {/* IN WORDS, NOT A BADGE. This is an explanation, and the only reason it earns
          a place is that it answers a real question - why some films take a moment to
          start and others do not (the player's own details sheet says the same). */}
      <dt>How it will play</dt>
      <dd class={v.status === 'refuse' && !v.remuxable ? 'bad' : ''}>
        {v.status === 'play' && 'Straight from the file, exactly as it is on the disk.'}
        {v.status === 'convert' && `Your browser cannot decode ${String(m.videoCodec || '').toUpperCase()} video, so the host converts the picture as it streams.`}
        {v.status === 'nosound' && 'Your browser cannot decode this soundtrack, so it is rebuilt as it streams. The picture is untouched.'}
        {v.status === 'refuse' && (v.remuxable
          ? `Your browser will not open a ${containerName(m.container)} file, so the picture and sound are put, untouched, in one it will.`
          : v.reason)}
        {v.status === 'unknown' && 'Your browser has not said whether it can open this one.'}
      </dd>
    </dl>
  )
}

// THE ACTIONS, and Play is a real button while the rest are not. Everything here is
// reversible and quiet except the one thing somebody came to the page to do.
export function TitleActions ({ item, resumeMs = 0, seen = false, onPlay, onResume = null, onWatched = null, onFix = null, extra = null }) {
  const canResume = resumeMs > 0 && onResume
  return (
    <>
      {canResume
        ? (
          <>
            <button onClick={onResume}><Play size={16} /> Resume at {fmtClock(resumeMs / 1000)}</button>
            <button class='ghost' onClick={onPlay}>Start over</button>
          </>
          )
        : <button onClick={onPlay}><Play size={16} /> Play</button>}
      {onWatched && (
        <button
          class={'icon' + (seen ? ' on' : '')}
          title={seen ? 'Watched. Press to unmark' : 'Mark as watched'}
          aria-label={(seen ? 'Mark as unwatched: ' : 'Mark as watched: ') + item.title}
          aria-pressed={seen}
          onClick={() => onWatched(item, !seen)}
        ><Check size={17} /></button>
      )}
      {onFix && (
        <button
          class='icon'
          title='Fix the match'
          aria-label={'Fix the match for ' + item.title}
          onClick={() => onFix(item)}
        ><Pencil size={16} /></button>
      )}
      {extra}
    </>
  )
}
