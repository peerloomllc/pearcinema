// Browsing the collection.
//
// Two roots side by side, because a film list and a show tree are different shapes
// and pretending otherwise is what makes media UIs confusing: films are leaves, a
// show is series -> season -> episode. The item model already draws that line
// (host/items.js), and this follows it rather than inventing a third arrangement.
//
// It reads the SAME adapter the phone reads, through /api/library/*. There is no
// second model of the library here, so a browser and a phone cannot disagree about
// what is in the collection.
//
// The compatibility line above the grid is not a garnish. It is a real measurement
// from a real engine - this browser, asked about these files - and on a normal
// collection it says something uncomfortable and true.

import { useState, useEffect, useMemo } from 'preact/hooks'
import { api, fmtRuntime, episodeCode } from './api'
import { verdictFor, tally } from './playback'

// How far through, as a percentage, or null when there is nothing to say.
//
// Runtimes are SECONDS here and positions are MILLISECONDS - see host/watch.js, where
// mixing the two would mean nothing is ever finished. The floor of 2% is so something
// only just begun shows a sliver rather than an empty groove that reads as a fault.
function progressOf ({ positionMs, runtime }) {
  const total = Number(runtime) > 0 ? Number(runtime) * 1000 : 0
  if (!total || !(positionMs > 0)) return null
  return Math.max(2, Math.min(100, Math.round((positionMs / total) * 100)))
}

// The ring that says "this is the one you are in the middle of".
//
// INSIDE THE ART, not around the whole tile: the tile is a picture with a caption
// under it, and an outline around both draws a square box around the words as well.
//
// A STROKED PATH, not a spinning gradient. The gradient version fell apart exactly
// where it was hardest to notice in a screenshot and impossible to miss in motion -
// the bright arc thinned and vanished at each corner, because a conic gradient sweeps
// by ANGLE while a rounded rectangle's edge does not, and the rim it was masked into
// was a square inner box against rounded outer corners.
//
// A dash travelling along the real rounded-rectangle path has neither problem. It
// follows the corners because it IS the corners, and `pathLength=100` normalises the
// perimeter so the dash is a fixed fraction of it and moves at one speed the whole way
// round, whatever shape the tile ends up.
//
// The stroke is 4 wide CENTRED on a path inset by 2, so its outer edge lands exactly on
// the viewBox edge - which is the tile's edge, once the artwork's own border has got
// out of the way. `rx` is 14 of 200 to match the artwork's 10px corner at the size these
// are usually drawn.
function Ring () {
  return (
    <svg class='ring' viewBox='0 0 200 300' aria-hidden='true' focusable='false'>
      <rect class='base' x='2' y='2' width='196' height='296' rx='14' pathLength='100' />
      <rect class='dash' x='2' y='2' width='196' height='296' rx='14' pathLength='100' />
    </svg>
  )
}

// THE BAR BELONGS TO THE PICTURE, not to the tile. Rendered here rather than beside
// `<Art>` because as a child of `.poster` it spanned the whole tile - a couple of
// pixels wider than the ring on each side, and placed vertically by guessing at the
// caption's height (Tim, 2026-08-13, with a screenshot of it poking out).
function Art ({ item, started = false, progress = null }) {
  const [bad, setBad] = useState(false)
  const inner = (
    <>
      {started && <Ring />}
      {progress !== null && <span class='resumebar'><i style={`width:${progress}%`} /></span>}
    </>
  )

  if (!item.artId || bad) {
    return (
      <div class='art'>
        {inner}
        {item.type === 'movie' ? '🎬' : item.type === 'series' ? '📺' : '🎞'}
      </div>
    )
  }
  return (
    <div class='art'>
      {inner}
      <img src={'/api/art?id=' + encodeURIComponent(item.artId)} alt='' loading='lazy' onError={() => setBad(true)} />
    </div>
  )
}

// A BADGE IS A PROMISE ABOUT WHAT WILL HAPPEN, not a note about what the browser
// alone could do. Once a verdict is `remuxable` the host fixes it and the film plays,
// so flagging it "no sound" or "browser: no" is simply wrong - Tim hit exactly this
// on The Batman, which wore a "no sound" badge and then played with sound.
//
// Only genuinely unplayable files get a flag now.
function flagFor (v) {
  if (!v || v.remuxable) return null
  if (v.status === 'refuse') return { cls: 'bad', text: 'cannot play' }
  if (v.status === 'nosound') return { cls: 'warn', text: 'no sound' }
  return null
}

// HOW FAR THROUGH, drawn across the bottom of the poster the way every player of the
// last decade has drawn it. A number would be exact and useless; the bar is read
// without being looked at.
function Poster ({ item, caps, onOpen, label = null, watch = null, badge = null, onWatched = null }) {
  const v = item.media ? verdictFor(item, caps) : null
  const flag = flagFor(v)

  // A CONTAINER SAYS WHAT IS LEFT; A LEAF SAYS WHETHER IT IS DONE.
  //
  // Both a show and a season get a rollup - `{ total, watched, unwatched, complete }` -
  // computed by the host from the episodes underneath, never stored. "3 left" tells
  // somebody to open it where a tick does not, and a finished one gets the tick
  // because at that point there is nothing left to say.
  const rollup = watch && watch.total !== undefined ? watch : null
  const seen = rollup ? rollup.complete : !!watch?.watched
  const left = rollup && !rollup.complete ? rollup.unwatched : 0
  const resume = rollup ? null : watch?.resume

  // WHICH ONE AM I IN THE MIDDLE OF. A count of what is left cannot answer that: a
  // season nobody has touched and a season half done both say "24 left" and "12 left"
  // in the same voice, and the one somebody is actually watching is the one they came
  // to the page for. So it is marked on the tile itself rather than by reading numbers
  // (Tim, 2026-08-13).
  // `started` comes from the HOST, which knows about episodes somebody is part way
  // through as well as ones they finished. Recomputing it here from `watched` alone
  // is the bug this replaced: a season with one half-watched episode in it has no
  // finished episodes and would have reported itself untouched.
  const started = !!rollup && !!rollup.started && !rollup.complete

  // ONE BAR, TWO MEANINGS, which are the same meaning at different scales: minutes on
  // a film, episodes on a season.
  const progress = rollup
    ? (started ? Math.max(2, Math.round((rollup.watched / rollup.total) * 100)) : null)
    : progressOf({ positionMs: resume?.positionMs, runtime: item.runtime })

  const sub = item.type === 'series'
    ? `${item.seasonCount || 0} season${item.seasonCount === 1 ? '' : 's'}`
    // An episode in a grid needs its NUMBER above all - a wall of thumbnails with
    // only titles under them is unreadable as an episode list.
    : [label, item.year, fmtRuntime(item.runtime)].filter(Boolean).join(' · ')

  // A DIV RATHER THAN A BUTTON, and only because of the tick in the corner: a button
  // inside a button is invalid, and the browsers that tolerate it do not agree on
  // which one a click reaches. The whole tile is still one click target, with the
  // keyboard behaviour a button would have had.
  const open = () => onOpen(item)
  return (
    <div
      class={'poster' + (started ? ' started' : '')}
      role='button'
      tabIndex={0}
      onClick={open}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
    >
      <Art item={item} started={started} progress={progress} />
      {flag && <span class={'flag ' + flag.cls}>{flag.text}</span>}
      {badge && <span class='next'>{badge}</span>}

      {/* THE AUTOMATIC RULE WILL BE WRONG SOMETIMES - a film watched on another
          device, an episode somebody else put on - so correcting it is one click on
          the thing itself rather than a trip into the player. On a show or a season
          it marks every episode underneath, because that is the only thing it could
          honestly mean. */}
      {onWatched
        ? (
          <button
            class={'mark' + (seen ? ' on' : '')}
            title={seen ? 'Mark as unwatched' : 'Mark as watched'}
            aria-label={(seen ? 'Mark as unwatched: ' : 'Mark as watched: ') + item.title}
            onClick={e => { e.stopPropagation(); onWatched(item, !seen) }}
          >✓</button>
          )
        : (seen && <span class='seen' title='You have watched this'>✓</span>)}

      {left > 0 && <span class='left' title={left + ' still to watch'}>{left}</span>}

      <div class='t'>{item.title}</div>
      {sub && <div class='s'>{sub}</div>}
    </div>
  )
}

// WHO THIS BROWSER IS WATCHING AS.
//
// Only ever shown once a SECOND person exists on the box (Tim, 2026-08-13): a
// household of one should never be asked a question with one answer. It is not a
// login and must not look like one - anybody with the dashboard password already
// sees the whole library, and this only decides whose history a position lands in.
function WatchingAs ({ watch, onChange }) {
  if (!watch?.choose?.length) return null
  return (
    <div class='watchas'>
      <span class='hint'>Watching as</span>
      <select
        value={watch.watching?.id || ''}
        aria-label='Who is watching'
        onChange={async e => { await api('/api/watch/as', { personId: e.currentTarget.value }); onChange() }}
      >
        {!watch.watching && <option value=''>Choose…</option>}
        {watch.choose.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  )
}

// PICK UP WHERE YOU LEFT OFF. The row people actually use, so it sits above the
// library rather than inside a tab - and it is only there when it has something in
// it, because an empty shelf labelled "continue watching" is a reproach.
function ContinueRow ({ watch, caps, onOpen, onWatched }) {
  // MID-FILM FIRST, then what to start next. Both are "carry on", but one is something
  // somebody literally stopped in the middle of and the other is a suggestion - and
  // burying the first under the second would be wrong.
  const list = [...(watch?.continue || []), ...(watch?.upNext || [])]
  if (!list.length) return null
  return (
    <>
      <h2 class='shelf'>Continue watching</h2>
      <div class='grid'>
        {list.map(i => (
          <Poster
            key={i.id}
            item={i}
            caps={caps}
            label={i.type === 'episode' ? episodeCode(i) : null}
            watch={{ resume: i.resume }}
            // A card for an episode nobody has started yet says so, rather than
            // looking like something abandoned half way.
            badge={i.upNext ? 'Next' : null}
            // Markable from the shelf too. "I finished this on the telly" is exactly
            // the thought somebody has while looking at a card offering to resume it.
            onWatched={onWatched}
            onOpen={onOpen}
          />
        ))}
      </div>
    </>
  )
}

// A grid of grey rectangles is indistinguishable from a broken scanner, and the
// first thing anyone does about it is assume the app is broken rather than that
// their files have no pictures beside them. So say which it is.
//
// PearCinema never fetches artwork from the internet unless the operator turns that
// on and supplies their own key - a library populated by hand, rather than by
// Sonarr or Radarr, genuinely has nothing on disk to show.
function ArtNote ({ list, source }) {
  if (source !== 'folder' || !list.length) return null
  if (list.some(i => i.artId)) return null
  return (
    <p class='hint'>
      No posters: these files have no artwork saved next to them on disk. PearCinema
      only reads what is already there, so nothing is missing or broken. Drop a
      <span class='mono'> poster.jpg </span> in a film's folder, or name it after the
      film, and it appears on the next scan.
    </p>
  )
}

// WHAT WILL ACTUALLY PLAY, which is not the same as what the browser alone can open -
// a file the host repackages plays, and counting it as a failure would tell somebody
// their library is broken while they are watching it.
//
// FOLDED AWAY BY DEFAULT. This started as three lines of explanation above every
// grid, which is a paragraph about codecs standing between somebody and their films
// (Tim, 2026-08-13). The number is genuinely useful and the reasoning behind it is
// only useful once, so the number stays and the reasoning is one click away. `details`
// rather than a tooltip, because a tooltip is unreachable on a phone.
function CompatLine ({ list, caps }) {
  const t = tally(list, caps)
  if (!t.total) return null

  const plays = t.play + t.repackaged
  // Nothing to report when everything works. Silence is the right amount of interface
  // for good news.
  if (plays === t.total && !t.unknown) return null

  return (
    <details class='compat'>
      <summary>
        <b>{plays}</b> of {t.total} play in this browser
      </summary>
      <div class='hint'>
        {t.repackaged > 0 && (
          <p>{t.repackaged} of them are repackaged as they stream, because your browser will
            not open the file as it is on disk. The picture is never re-encoded.</p>
        )}
        {t.refuse > 0 && (
          <p>{t.refuse} will not play here: your browser cannot decode what is inside them.
            Repackaging changes the wrapper and never the picture, so those need re-encoding,
            which this version does not do. They play on a phone.</p>
        )}
        {t.unknown > 0 && <p>{t.unknown} did not say what is inside them, so they may play.</p>}
      </div>
    </details>
  )
}

// One paged list from the host, with Load more. `deps` restarts it.
function useList (query, deps) {
  const [items, setItems] = useState([])
  const [cursor, setCursor] = useState(null)
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState('')

  const fetchPage = async (c) => {
    setBusy(true)
    const res = await api(query + (c ? '&cursor=' + encodeURIComponent(c) : ''))
    setBusy(false)
    if (res.error) return setErr(res.error)
    setErr('')
    setItems(prev => c ? [...prev, ...(res.items || [])] : (res.items || []))
    setCursor(res.cursor || null)
  }

  useEffect(() => { setItems([]); setCursor(null); fetchPage(null) }, deps)

  return { items, cursor, busy, err, more: () => fetchPage(cursor) }
}

const VIEW_KEY = 'pearcinema.episodeview'
const loadView = () => {
  try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list' } catch { return 'list' }
}

// List or grid for a season's episodes, and it is a real choice rather than a
// preference we could pick for people: a list reads best when episodes are titled
// and numbered, which is most television, and a grid reads best when they have
// thumbnails worth looking at. Remembered in the BROWSER - how somebody likes a list
// to look is not the host's business and does not belong in its data dir.
function ViewToggle ({ view, onChange }) {
  return (
    <div class='viewtoggle' role='group' aria-label='How to show episodes'>
      <button class={view === 'list' ? 'on' : ''} onClick={() => onChange('list')} aria-label='List'>☰ List</button>
      <button class={view === 'grid' ? 'on' : ''} onClick={() => onChange('grid')} aria-label='Grid'>▦ Grid</button>
    </div>
  )
}

export default function Library ({ state, caps, search, onPlay, watch = null, onWatchChange = () => {} }) {
  // 'films' | 'shows', and where we are inside the show tree.
  const [root, setRoot] = useState('films')
  const [series, setSeries] = useState(null)
  const [season, setSeason] = useState(null)
  const [hits, setHits] = useState(null)
  const [view, setView] = useState(loadView)

  const chooseView = (v) => {
    setView(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch {}
  }

  const stats = state.stats || {}

  // An array on the wire, a Set here. A grid asks "has this been watched" once per
  // poster and a linear scan per poster is the kind of thing that only bites on
  // somebody else's library.
  const seen = useMemo(() => new Set(watch?.watched || []), [watch])
  const resumeOf = useMemo(() => {
    const m = new Map()
    for (const i of (watch?.continue || [])) m.set(i.id, i.resume)
    return m
  }, [watch])
  const badge = (item) => ({ watched: seen.has(item.id), resume: resumeOf.get(item.id) })

  // One toggle for every grid on the page, so a film, an episode, a season and a show
  // all behave the same way and there is one place for the reload to happen.
  const mark = async (item, on) => {
    await api('/api/watch/watched', { itemId: item.id, watched: on })
    onWatchChange()
    setSeasonRollups({})
  }

  useEffect(() => {
    if (!search) { setHits(null); return }
    let live = true
    const t = setTimeout(async () => {
      const res = await api('/api/library/search?q=' + encodeURIComponent(search))
      if (live) setHits(res.items || [])
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [search])

  // WHAT IS LEFT OF EACH SHOW, asked for only while the shows list is on screen -
  // answering it walks every series' episodes, which is free on a folder library and
  // one HTTP call per show on a Jellyfin one.
  const [shows_, setShows_] = useState({})
  const [seasonRollups, setSeasonRollups] = useState({})
  useEffect(() => {
    if (root !== 'shows') return
    let live = true
    api('/api/watch/shows').then(r => { if (live && r?.shows) setShows_(r.shows) })
    return () => { live = false }
  }, [root, watch])

  // AND WHAT IS LEFT OF EACH SEASON, while a show is open. Same shape and same reason
  // as the shows call above: computing it walks episodes, so it is asked for when the
  // seasons are actually on screen rather than folded into every library page load.
  useEffect(() => {
    if (!series?.id) return
    let live = true
    api('/api/watch/seasons?seriesId=' + encodeURIComponent(series.id))
      .then(r => { if (live && r?.seasons) setSeasonRollups(r.seasons) })
    return () => { live = false }
  }, [series?.id, watch])

  const films = useList('/api/library/list?type=movies&limit=100', [root])
  const shows = useList('/api/library/list?type=series&limit=100', [root])
  const seasons = useList(
    '/api/library/list?type=seasons&limit=100&seriesId=' + encodeURIComponent(series?.id || ''),
    [series?.id]
  )
  const episodes = useList(
    '/api/library/list?type=episodes&limit=200&seasonId=' + encodeURIComponent(season?.id || ''),
    [season?.id]
  )

  // READING THE LIBRARY takes minutes on a real drive - measured at about four for
  // 2,986 films and episodes on a USB disk. The host now serves this page while it
  // works rather than after, so this is what fills the gap. Without it the grid is
  // simply empty, which reads as broken.
  if (state.scanning) {
    const { done = 0, total = 0 } = state.scanning
    return (
      <div class='empty'>
        <h2>Reading your library…</h2>
        <p>
          {total
            ? <>Looked at <b>{done.toLocaleString()}</b> of {total.toLocaleString()} files.</>
            : <>Walking the folders.</>}
        </p>
        <p class='hint'>
          Every file is opened to see what is actually inside it, which is what makes the
          library know a film from an episode and an MKV from an MP4. It happens once -
          the result is remembered, so restarts are instant. You can pair a phone while
          this runs.
        </p>
      </div>
    )
  }

  if (state.source?.kind === 'empty') {
    return (
      <div class='empty'>
        <h2>No films yet</h2>
        <p>Tell PearCinema where your collection is, in Settings.</p>
      </div>
    )
  }

  if (state.sourceError) {
    return (
      <>
        <div class='banner bad'>
          <b>The source is not answering.</b> {state.sourceError}
          <div class='hint'>This is usually an unplugged drive or a server that has moved. Devices can still reach this host.</div>
        </div>
      </>
    )
  }

  // --- search wins over everything, because that is what the box is for ---
  if (hits) {
    return (
      <>
        <h2>{hits.length} result{hits.length === 1 ? '' : 's'} for “{search}”</h2>
        <CompatLine list={hits.filter(h => h.media)} caps={caps} />
        <div class='grid' style='margin-top:1rem'>
          {hits.map(h => (
            <Poster key={h.id} item={h} caps={caps} onOpen={i => {
              if (i.type === 'series') { setHits(null); setRoot('shows'); setSeries(i) } else onPlay(i, hits.filter(x => x.type === i.type))
            }} />
          ))}
        </div>
        {!hits.length && <div class='empty'>Nothing matched.</div>}
      </>
    )
  }

  // --- inside a show ---
  if (root === 'shows' && series) {
    return (
      <>
        <div class='crumbs'>
          <button onClick={() => { setSeries(null); setSeason(null) }}>Shows</button>
          <span>/</span>
          {season
            ? <><button onClick={() => setSeason(null)}>{series.title}</button><span>/</span><span>{season.title}</span></>
            : <span>{series.title}</span>}
        </div>

        {!season && (
          <>
            <h2>{series.title}</h2>
            {series.overview && <p class='hint'>{series.overview}</p>}
            <div class='grid' style='margin-top:1rem'>
              {seasons.items.map(s => (
                <Poster
                  key={s.id}
                  item={s}
                  caps={caps}
                  watch={seasonRollups[s.id]}
                  onWatched={mark}
                  onOpen={setSeason}
                />
              ))}
            </div>
            {seasons.busy && <div class='empty'>Loading…</div>}
          </>
        )}

        {season && (
          <>
            <div class='row' style='justify-content:space-between'>
              <h2>{season.title}</h2>
              <ViewToggle view={view} onChange={chooseView} />
            </div>
            <CompatLine list={episodes.items} caps={caps} />
            <ArtNote list={episodes.items} source={state.source?.kind} />

            {view === 'grid'
              ? (
                <div class='grid' style='margin-top:.8rem'>
                  {episodes.items.map(e => (
                    <Poster
                      key={e.id}
                      item={e}
                      caps={caps}
                      label={episodeCode(e)}
                      watch={badge(e)}
                      onWatched={mark}
                      onOpen={() => onPlay(e, episodes.items)}
                    />
                  ))}
                </div>
                )
              : (
                <div class='rows' style='margin-top:.8rem'>
                  {episodes.items.map(e => {
                    const flag = flagFor(verdictFor(e, caps))
                    return (
                      <div
                        class={'eprow' + (seen.has(e.id) ? ' seen' : '')}
                        key={e.id}
                        role='button'
                        tabIndex={0}
                        onClick={() => onPlay(e, episodes.items)}
                        onKeyDown={ev => { if (ev.key === 'Enter') onPlay(e, episodes.items) }}
                      >
                        <span class='code'>{episodeCode(e) || '-'}</span>
                        <span class='t'>{e.title}</span>
                        {e.runtime ? <span class='hint'>{fmtRuntime(e.runtime)}</span> : null}
                        {flag && <span class={'chip ' + flag.cls}>{flag.text}</span>}
                        <button
                          class={'mark' + (seen.has(e.id) ? ' on' : '')}
                          title={seen.has(e.id) ? 'Mark as unwatched' : 'Mark as watched'}
                          aria-label={(seen.has(e.id) ? 'Mark as unwatched: ' : 'Mark as watched: ') + e.title}
                          onClick={ev => { ev.stopPropagation(); mark(e, !seen.has(e.id)) }}
                        >✓</button>
                      </div>
                    )
                  })}
                </div>
                )}
            {episodes.busy && <div class='empty'>Loading…</div>}
            {episodes.cursor && <button class='ghost' onClick={episodes.more} style='margin-top:1rem'>Load more</button>}
          </>
        )}
      </>
    )
  }

  const showing = root === 'films' ? films : shows

  return (
    <>
      <ContinueRow
        watch={watch}
        caps={caps}
        onWatched={mark}
        onOpen={i => onPlay(i, [...(watch.continue || []), ...(watch.upNext || [])])}
      />

      <div class='row' style='margin-bottom:.6rem'>
        <WatchingAs watch={watch} onChange={onWatchChange} />
        <button class={root === 'films' ? '' : 'ghost'} onClick={() => setRoot('films')}>
          Films {stats.movies ? <span class='chip'>{stats.movies}</span> : null}
        </button>
        <button class={root === 'shows' ? '' : 'ghost'} onClick={() => setRoot('shows')}>
          Shows {stats.series ? <span class='chip'>{stats.series}</span> : null}
        </button>
      </div>

      {root === 'films' && <CompatLine list={films.items} caps={caps} />}
      <ArtNote list={showing.items} source={state.source?.kind} />

      {showing.err && <div class='banner bad'>{showing.err}</div>}

      <div class='grid' style='margin-top:.8rem'>
        {showing.items.map(i => (
          <Poster key={i.id} item={i} caps={caps} watch={i.type === 'series' ? shows_[i.id] : badge(i)} onWatched={mark} onOpen={item => {
            if (item.type === 'series') setSeries(item)
            else onPlay(item, films.items)
          }} />
        ))}
      </div>

      {showing.busy && <div class='empty'>Loading…</div>}
      {!showing.busy && !showing.items.length && (
        <div class='empty'>
          Nothing here yet. {root === 'films' ? 'Films' : 'Shows'} will appear once the source has been scanned.
        </div>
      )}
      {showing.cursor && <button class='ghost' style='margin-top:1rem' onClick={showing.more}>Load more</button>}
    </>
  )
}
