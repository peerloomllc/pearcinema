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

import { useState, useEffect, useMemo, useRef } from 'preact/hooks'
import { api, withBase, fmtRuntime, episodeCode } from './api'
import { verdictFor, tally } from './playback'
import { ArtIcon, Check, Close, Detail, List, Grid, Pencil } from './icons'
import { notify, askConfirm } from './ui'
import { FixMatch } from './FixMatch'
import { TitleHead, TitleActions, FilmFacts } from './TitlePage'

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
// THE FLAG BELONGS TO THE PICTURE for the same reason (Tim, 2026-08-20, off a
// screenshot): as a child of the tile it sat top-right, which is where the watched
// tick and the "3 left" count live - so an episode this browser cannot play wore its
// warning ON TOP of the tick saying it had been watched, no hover needed. It goes at
// the foot of the picture now, clear of the resume bar, where nothing else sits.
function Art ({ item, started = false, progress = null, flag = null }) {
  const [bad, setBad] = useState(false)
  const inner = (
    <>
      {started && <Ring />}
      {flag && <span class={'flag ' + flag.cls}>{flag.text}</span>}
      {progress !== null && <span class='resumebar'><i style={`width:${progress}%`} /></span>}
    </>
  )

  if (!item.artId || bad) {
    return (
      <div class='art'>
        {inner}
        <ArtIcon type={item.type} />
      </div>
    )
  }
  return (
    <div class='art'>
      {inner}
      <img src={withBase('/api/art?id=' + encodeURIComponent(item.artId) + (item.artBust ? '&v=' + item.artBust : ''))} alt='' loading='lazy' onError={() => setBad(true)} />
    </div>
  )
}

// ONE ROW OF THE DETAIL VIEW: the poster small, the title, what it is and what it is
// about. The thing a grid cannot say - a wall of posters is unanswerable about a film
// nobody recognises the artwork of - and the thing a table has no room for.
//
// The same component for a film and for an episode, because they differ only in what
// their second line says, and that is passed in.
function DetailRow ({ item, caps, meta, watch = null, onOpen, onWatched = null }) {
  const flag = flagFor(item.media ? verdictFor(item, caps) : null)
  const rollup = watch && watch.total !== undefined ? watch : null
  const seen = rollup ? rollup.complete : !!watch?.watched
  const started = !!rollup && !!rollup.started && !rollup.complete
  const progress = rollup
    ? (started ? Math.max(2, Math.round((rollup.watched / rollup.total) * 100)) : null)
    : progressOf({ positionMs: watch?.resume?.positionMs, runtime: item.runtime })

  return (
    <div
      class='detailrow'
      role='button'
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item) } }}
    >
      <span class='dart'><Art item={item} started={started} progress={progress} /></span>
      <span class='dmain'>
        <span class='dtitle'>{item.title}</span>
        <span class='dmeta'>
          {meta}
          {flag && <span class={'chip ' + flag.cls}>{flag.text}</span>}
        </span>
        {/* CLAMPED, NOT CUT. A summary is three lines here and the rest is one click
            away; letting it run makes the rows different heights, which is the thing
            that stops a list being scannable at all. */}
        {item.overview && <span class='dsum'>{item.overview}</span>}
      </span>
      {onWatched && (
        <button
          class={'mark' + (seen ? ' on' : '')}
          title={seen ? 'Mark as unwatched' : 'Mark as watched'}
          aria-label={(seen ? 'Mark as unwatched: ' : 'Mark as watched: ') + item.title}
          onClick={e => { e.stopPropagation(); onWatched(item, !seen) }}
        ><Check size={13} /></button>
      )}
    </div>
  )
}

// THE TABLE. Title and year, one line each, and deliberately nothing else: this view
// answers "do I have it", which on two hundred and forty films is a different question
// from "what shall I watch" and a much faster one. A poster would only slow it down.
//
// A HEADING ROW, because two bare columns of text with no names is a spreadsheet
// somebody has to work out. It is not sortable from here - sorting lives in the
// library's own display options, where it applies to every view.
function TableRows ({ items, caps, seenOf, resumeOf = null, onOpen, onWatched = null, second = 'Year' }) {
  return (
    <div class='tablev' role='table' aria-label='Your library as a list'>
      <div class='trow thead' role='row'>
        <span class='tt' role='columnheader'>Title</span>
        <span class='ts' role='columnheader'>{second}</span>
      </div>
      {items.map(i => {
        const flag = flagFor(i.media ? verdictFor(i, caps) : null)
        const seen = seenOf(i)
        const pct = resumeOf ? progressOf({ positionMs: resumeOf.get(i.id)?.positionMs, runtime: i.runtime }) : null
        return (
          <div
            class={'trow' + (seen ? ' seen' : '')}
            role='row'
            key={i.id}
            tabIndex={0}
            onClick={() => onOpen(i)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(i) } }}
          >
            <span class='tt' role='cell'>{i.title}</span>
            {flag && <span class={'chip ' + flag.cls}>{flag.text}</span>}
            {pct !== null && <span class='rowbar'><i style={`width:${pct}%`} /></span>}
            <span class='ts' role='cell'>{second === 'Year' ? (i.year || '') : (i.runtime ? fmtRuntime(i.runtime) : '')}</span>
            {onWatched && (
              <button
                class={'mark' + (seen ? ' on' : '')}
                title={seen ? 'Mark as unwatched' : 'Mark as watched'}
                aria-label={(seen ? 'Mark as unwatched: ' : 'Mark as watched: ') + i.title}
                onClick={e => { e.stopPropagation(); onWatched(i, !seen) }}
              ><Check size={13} /></button>
            )}
          </div>
        )
      })}
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
function Poster ({ item, caps, onOpen, label = null, watch = null, badge = null, onWatched = null, onFix = null, onForget = null }) {
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
      <Art item={item} started={started} progress={progress} flag={flag} />
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
          ><Check size={13} /></button>
          )
        : (seen && <span class='seen' title='You have watched this'><Check size={13} /></span>)}

      {/* ONLY ONCE SOMETHING IS UNDER WAY. Saying what the number MEANT was
          not enough (Tim, 2026-08-17: a bare count read as "how many episodes
          are in this season", and he doubted the badge helped most people).
          The reason it read that way is that on an untouched show it IS the
          episode count - "24 left" of 24 - so the word "left" was doing no
          work and the tile was carrying a number nobody needed.

          Half way through, the same badge is the whole point: "3 left" tells
          somebody to open it, which is exactly what a tick cannot. So it earns
          its place where it says something and is gone where it did not. A
          finished show already says so with a tick, and left is 0 there. */}
      {started && left > 0 && <span class='left' title={left + ' still to watch'}>{left} left</span>}

      {/* FIX THE MATCH WHERE THE MISTAKE IS VISIBLE (Tim, 2026-08-14, Plex's shape).
          A fetched match is a best guess, and the correction belongs on the tile
          wearing the wrong poster - not in a queue in Settings. WHETHER to offer it
          is the caller's question and not this component's: it is about who owns
          the file, which a tile cannot see (see fixIdOf). This used to hide itself
          on anything with a poster of its own, which took the only way to correct a
          wrong match with it. */}
      {/* TAKE THIS OFF THE SHELF WITHOUT CLAIMING TO HAVE WATCHED IT. Top left,
          which is free on a shelf card: the up-next badge that also lives there
          belongs to items with no position, and the fix-the-match pencil is
          not offered on this row at all. */}
      {onForget && (
        <button
          class='forget'
          title={'Remove ' + item.title + ' from Continue watching'}
          aria-label={'Remove ' + item.title + ' from Continue watching'}
          onClick={e => { e.stopPropagation(); onForget(item) }}
        ><Close size={12} /></button>
      )}

      {onFix && (
        <button
          class='fixmatch'
          title={'Fix the match for ' + item.title}
          aria-label={'Fix the match for ' + item.title}
          onClick={e => { e.stopPropagation(); onFix(item) }}
        ><Pencil size={13} /></button>
      )}

      <div class='t'>{item.title}</div>
      {sub && <div class='s'>{sub}</div>}
    </div>
  )
}

// ASK THE FRIEND FOR IT, from the exact place its absence is discovered - the
// phone's request feature, offered where a search on a remote library came up
// empty. Never on your own library: asking your own machine for a film is a
// note to self. Your open asks live in Settings, Remote libraries.
function AskFor ({ name }) {
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const ask = async (kind) => {
    setErr('')
    const r = await api('/api/request', { kind, name })
    if (r?.error) return setErr(r.error)
    setSent(true)
  }
  if (sent) return <p class='hint'>Asked. Your requests live in Settings, under Remote libraries.</p>
  return (
    <div class='askfor'>
      <p class='hint'>It is not in this library, but you can ask for it.</p>
      <div class='row' style='justify-content:center'>
        <button class='ghost' onClick={() => ask('movie')}>Ask for it as a film</button>
        <button class='ghost' onClick={() => ask('series')}>Ask for it as a show</button>
      </div>
      {err && <p class='error'>{err}</p>}
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

// HOW MANY CARDS THE SHELF SHOWS before the rest go behind Show all. Twelve is
// two full rows on a normal window and comfortably more than anybody is part way
// through at once.
const SHELF_MAX = 12

// PICK UP WHERE YOU LEFT OFF. The row people actually use, so it sits above the
// library rather than inside a tab - and it is only there when it has something in
// it, because an empty shelf labelled "continue watching" is a reproach.
function ContinueRow ({ watch, caps, onOpen, onWatched, onForget, onClear }) {
  // MID-FILM FIRST, then what to start next. Both are "carry on", but one is something
  // somebody literally stopped in the middle of and the other is a suggestion - and
  // burying the first under the second would be wrong.
  const list = [...(watch?.continue || []), ...(watch?.upNext || [])]
  // SHOWN, not held. The shelf keeps every position there is, and a person with a
  // year of half-started films had the one thing they are actually part way
  // through pushed off the end of the row (Tim, 2026-08-19). Newest first is
  // already the store's ordering, so the cap simply cuts the tail - and the tail
  // is one press away rather than gone.
  const [all, setAll] = useState(false)
  useEffect(() => { setAll(false) }, [list.length])
  if (!list.length) return null
  const shown = all ? list : list.slice(0, SHELF_MAX)
  const places = (watch?.continue || []).length
  return (
    <>
      <div class='shelfhead'>
        <h2 class='shelf' id='continue-shelf'>Continue watching</h2>
        {places > 0 && onClear && (
          <button class='ghost' onClick={onClear}>Clear</button>
        )}
      </div>
      <div class='grid'>
        {shown.map(i => (
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
            // FORGETTING IS NOT FINISHING. Marking something watched already takes
            // it off the shelf, and for anything abandoned rather than finished it
            // is a lie that then shows up as a tick everywhere else. Only offered
            // on a real position - an up-next suggestion has nothing to forget.
            onForget={i.resume ? onForget : null}
            onOpen={onOpen}
          />
        ))}
      </div>
      {list.length > SHELF_MAX && (
        <button class='ghost showall' onClick={() => setAll(a => !a)}>
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
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

  const plays = t.play + t.repackaged + t.convert
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
        {t.convert > 0 && (
          <p>{t.convert} hold video your browser cannot decode, so the host converts the
            picture to H.264 on its own video hardware as they stream.</p>
        )}
        {t.refuse > 0 && (
          <p>{t.refuse} will not play here: your browser cannot decode what is inside them.
            Repackaging changes the wrapper and never the picture, so those need re-encoding,
            which this host cannot do. They play on a phone.</p>
        )}
        {t.unknown > 0 && <p>{t.unknown} did not say what is inside them, so they may play.</p>}
      </div>
    </details>
  )
}

// One paged list from the host. `deps` restarts it.
//
// IT LOADS ITSELF. A "Load more" button is a question the page already knows the
// answer to: somebody who has scrolled to the bottom of their films wants the next
// hundred, and making them say so is a click for nothing (Tim, 2026-08-13).
//
// THE GUARD IS ONLY ON THE NEXT PAGE, and getting that wrong cost an empty screen.
//
// A single "one request at a time" ref looked right and was not: opening a season from
// the player mounts this with no season yet, that first request is in flight, and the
// real query - the one with the season on it - arrives a tick later and is DROPPED as
// a duplicate. The page then shows the crumbs, the title and no episodes, which is
// exactly what Tim screenshotted.
//
// So a NEW query always goes, and only a request for the next page of the same query
// can be turned away. Late answers are discarded by sequence number rather than by
// refusing to ask, because the one that matters is usually the newest one.
function useList (query, deps) {
  const [items, setItems] = useState([])
  const [cursor, setCursor] = useState(null)
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState('')
  const paging = useRef(false)
  const seq = useRef(0)

  const fetchPage = async (c) => {
    if (c && paging.current) return
    if (c) paging.current = true
    const mine = ++seq.current
    setBusy(true)

    const res = await api(query + (c ? '&cursor=' + encodeURIComponent(c) : ''))

    // A newer query has been asked since. Its answer is the one that belongs on screen,
    // so this one is dropped rather than overwriting it.
    if (mine !== seq.current) return
    paging.current = false
    setBusy(false)
    if (res.error) return setErr(res.error)
    setErr('')
    setItems(prev => c ? [...prev, ...(res.items || [])] : (res.items || []))
    setCursor(res.cursor || null)
  }

  useEffect(() => { setItems([]); setCursor(null); fetchPage(null) }, deps)

  // Change ONE item where it stands, without a refetch. Fixing a poster must not
  // throw somebody back to the top of a list they had scrolled (Tim, 2026-08-14) -
  // and a refetch empties the array first, which collapses the grid and takes the
  // scroll position with it.
  const patch = (id, changes) => setItems(prev => prev.map(i => (i.id === id ? { ...i, ...changes } : i)))

  // Re-read what is ALREADY on screen, in place: as many items as are loaded, in
  // one call, replacing the array only when the answer arrives - so the grid never
  // collapses and the scroll never moves. This is how a finished artwork pass gets
  // its posters onto the page somebody is looking at.
  const refresh = async () => {
    const n = Math.max(items.length, 100)
    const res = await api(query.replace(/limit=\d+/, 'limit=' + n))
    if (!res.error) { setItems(res.items || []); setCursor(res.cursor || null) }
  }

  return { items, cursor, busy, err, more: () => fetchPage(cursor), patch, refresh }
}

// The bottom of the list, watched. When it comes into view, the next page is asked
// for - with a margin, so the request is already in flight by the time somebody gets
// there and the grid grows without a gap.
//
// A SENTINEL RATHER THAN A SCROLL HANDLER: an IntersectionObserver fires when the
// browser is ready to tell us, where a scroll listener fires on every pixel and has to
// be throttled by hand. It also keeps working inside any scroller, which a listener
// bound to the window does not.
function LoadMore ({ cursor, onMore, busy }) {
  const mark = useRef(null)

  useEffect(() => {
    if (!cursor || !mark.current) return
    const io = new IntersectionObserver(
      es => { if (es.some(e => e.isIntersecting)) onMore() },
      { rootMargin: '600px 0px' }
    )
    io.observe(mark.current)
    return () => io.disconnect()
  }, [cursor, onMore])

  if (!cursor) return null
  return (
    <div class='loadmore' ref={mark}>
      {/* Something has to be here, or there is nothing to come into view - and it may
          as well say what is happening rather than being an empty pixel. */}
      <span class={busy ? 'on' : ''}>Loading more…</span>
    </div>
  )
}

// THREE WAYS TO LOOK AT A LIST, Plex's three (Tim, 2026-08-20, with screenshots):
//
//   grid   - posters, and nothing but. What a shelf of films is FOR.
//   detail - a poster beside the title, the year, the length and what it is about.
//            The one that answers "what is this" without opening anything.
//   table  - title and year, one line each. The one that answers "do I have it",
//            which on 240 films is a different question and a much faster one.
//
// It is a real choice rather than a preference we could pick for people, and the
// same choice on a season's episodes: a table reads best when episodes are titled
// and numbered, which is most television, and a grid reads best when they have
// thumbnails worth looking at.
//
// Remembered in the BROWSER, per list - how somebody likes a list to look is not the
// host's business and does not belong in its data dir, and the answer for a wall of
// posters is not the answer for a season of episodes.
const VIEWS = ['grid', 'detail', 'table']
const EPISODE_VIEW_KEY = 'pearcinema.episodeview'
const LIBRARY_VIEW_KEY = 'pearcinema.libraryview'
const loadView = (key, fallback) => {
  try {
    const v = localStorage.getItem(key)
    // 'list' is what the episode toggle called the compact one before there were
    // three, so a browser that chose it keeps what it chose.
    if (v === 'list') return 'table'
    return VIEWS.includes(v) ? v : fallback
  } catch { return fallback }
}

// ICONS RATHER THAN WORDS, because three labelled buttons is a sentence sitting in a
// toolbar - and because these three are exactly the kind of thing a picture says
// faster than a word does. Each carries its name for anything that cannot see one.
const VIEW_ICONS = {
  grid: { icon: Grid, label: 'Posters' },
  detail: { icon: Detail, label: 'Details' },
  table: { icon: List, label: 'A list' }
}

function ViewToggle ({ view, onChange, what = 'this list' }) {
  return (
    <div class='viewtoggle' role='group' aria-label={`How to show ${what}`}>
      {VIEWS.map(v => {
        const { icon: Icon, label } = VIEW_ICONS[v]
        return (
          <button
            key={v}
            class={view === v ? 'on' : ''}
            onClick={() => onChange(v)}
            title={label}
            aria-label={label}
            aria-pressed={view === v}
          ><Icon size={15} /></button>
        )
      })}
    </div>
  )
}

export default function Library ({
  state, caps, search, onPlay,
  watch = null, onWatchChange = () => {},
  // Where to open, when somebody has climbed out of the player rather than gone all
  // the way back to the library. Consumed once and cleared, so it does not fight with
  // wherever they navigate next.
  startAt = null, onStarted = () => {},
  // Browsing somebody ELSE's library through the /remote twins. The reads are
  // already rewritten by the api layer; what this flag governs is everything
  // that is about THIS box and would be wrong or dishonest on a friend's -
  // the local source's empty/scanning/error states. The metadata pencil used to be
  // one of those and is not any more: it asks per title whether THIS box holds a
  // copy, which is false throughout a friend's library and true of some of the
  // merged one (see fixIdOf).
  remote = false
}) {
  // 'films' | 'shows', and where we are inside the show tree.
  const [root, setRoot] = useState('films')
  const [series, setSeries] = useState(null)
  const [season, setSeason] = useState(null)
  // THE FILM YOU ARE LOOKING AT, which is a place now rather than something that
  // started the moment you touched it (Tim, 2026-08-20). One more level on the same
  // stack the show tree uses, so it slides in and out the same way and Back means
  // the same thing.
  const [film, setFilm] = useState(null)

  // WHICH WAY WE WENT, which is the whole point of the movement (Tim, 2026-08-13,
  // choosing it over a plain cross-fade): deeper comes in from the right, back comes in
  // from the left. A fade says only that something changed; this says where you are.
  //
  // Kept in state and stamped onto the screen's key, so the animation restarts on every
  // move rather than only the first.
  const [dir, setDir] = useState('deeper')
  const go = (fn, way = 'deeper') => { setDir(way); fn() }

  useEffect(() => {
    if (!startAt?.item) return
    const e = startAt.item
    setDir('back')
    setRoot('shows')
    // Minimal stand-ins: what the crumbs render and what the queries need is an id and
    // a title, and an episode already carries both for its show and its season.
    setSeries({ id: e.seriesId, title: e.seriesTitle || 'Show', type: 'series' })
    setSeason(startAt.level === 'season'
      ? {
          id: e.seasonId,
          type: 'season',
          title: e.seasonNumber === 0
            ? 'Specials'
            : (e.seasonNumber === null || e.seasonNumber === undefined ? 'Season' : 'Season ' + e.seasonNumber)
        }
      : null)
    onStarted()
  }, [startAt])
  const [hits, setHits] = useState(null)
  // Two remembered choices, not one: a season of episodes and a wall of films are
  // different questions and people answer them differently.
  const [view, setView] = useState(() => loadView(EPISODE_VIEW_KEY, 'table'))
  const [libView, setLibView] = useState(() => loadView(LIBRARY_VIEW_KEY, 'grid'))

  const chooseView = (v) => {
    setView(v)
    try { localStorage.setItem(EPISODE_VIEW_KEY, v) } catch {}
  }
  const chooseLibView = (v) => {
    setLibView(v)
    try { localStorage.setItem(LIBRARY_VIEW_KEY, v) } catch {}
  }

  const stats = state.stats || {}
  const depth = hits ? 'search' : film ? 'film' : season ? 'season' : series ? 'series' : root

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

  // A ZERO POSITION IS THE DELETE, the same write the host uses when a film is
  // finished - so forgetting one place travels the identical path (and the
  // identical write fan on a merged library) rather than being a second way to
  // remove a row that has to be kept honest separately.
  // THE EPISODE YOU ARE UP TO. Asked for only when somebody presses Play on a show,
  // because answering it means listing the whole show's episodes - free on a folder
  // source and one HTTP call on a Jellyfin one, which is why nothing else on this
  // page does it. The rule itself is the shelf's: the first one not finished, skipping
  // nothing, so a gap in the middle is where you go rather than the end.
  const playNextEpisode = async () => {
    const res = await api('/api/library/list?type=episodes&seriesId=' + encodeURIComponent(series.id) + '&limit=1000')
    const eps = res.items || []
    if (!eps.length) return notify('Nothing to play', 'This show has no episodes on the disk.')
    const next = eps.find(e => !seen.has(e.id) || resumeOf.get(e.id)?.positionMs > 0) || eps[0]
    onPlay(next, eps)
  }

  const forget = async (item) => {
    await api('/api/watch/position', { itemId: item.id, positionMs: 0 })
    onWatchChange()
  }

  const clearShelf = async () => {
    const ok = await askConfirm({
      title: 'Clear Continue watching?',
      message: 'Every place you are part way through will be forgotten, and those films will start from the beginning again. This cannot be undone.',
      confirmLabel: 'Clear it',
      danger: true
    })
    if (!ok) return
    const r = await api('/api/watch/clear', {})
    if (r?.needsPerson) return notify('Nobody is watching', 'Choose who is watching before clearing the shelf.')
    onWatchChange()
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

  // THE TILE IS THE PLACE A MATCH GETS FIXED. `fixItem` is the tile whose pencil
  // was pressed.
  const [fixItem, setFixItem] = useState(null)

  // WHOSE FILM IS IT, which is the whole question the pencil turns on - and two
  // older rules were answering a different one, so it was missing everywhere it
  // was most wanted (Tim, 2026-08-20: "in merged library view I don't seem to have
  // the ability to edit title metadata/artwork. If I switch to Tim's Umbrel then I
  // only have it on some, not all, titles - I can edit Annihilation but not 300").
  //
  //  1. ALL LIBRARIES OFFERED IT ON NOTHING, because it is a remote view and the
  //     fix routes only know this box. True of a friend's library and false of the
  //     blend, which is this library plus others: the copies on this disk are as
  //     correctable there as anywhere. What is NOT ours is a friend's copy.
  //  2. A FILM WITH A POSTER ON THE DISK OFFERED IT ON NOTHING EITHER, on the rule
  //     that artwork beside the file is not this feature's to change. Right about
  //     the picture, wrong about the MATCH: a film matched to the wrong TMDB entry
  //     has the wrong summary and year whatever is on the disk. The dialog says
  //     the disk still wins the picture rather than the control disappearing.
  //
  // So: this box holds a copy, and the answer is the id THIS library knows it by -
  // which in the blend is not the id on the tile, because a merged row wears the
  // primary copy's id and that copy can be a friend's.
  const metadataOn = !!(state.metadata?.enabled && state.metadata?.hasKey)
  const fixIdOf = (item) => {
    if (!metadataOn || !item) return null
    if (item.type !== 'movie' && item.type !== 'series') return null
    if (!remote) return item.id
    const mine = (item.copies || []).find(c => c.libraryId === state.libraryId)
    return mine ? mine.id : null
  }
  const fixOn = (item) => (fixIdOf(item) ? setFixItem : null)
  const artRunning = remote ? null : (state.metadata?.running || null)

  const films = useList('/api/library/list?type=movies&limit=100', [root])
  const shows = useList('/api/library/list?type=series&limit=100', [root])

  // A finished artwork pass refreshes the lists IN PLACE - stale-while-refetch, so
  // the grid never collapses and the scroll never moves - and says what it found.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !artRunning) {
      films.refresh(); shows.refresh()
      api('/api/metadata').then(m => {
        if (m?.error) return
        notify('Artwork fetched', `${m.matched} title${m.matched === 1 ? ' has' : 's have'} posters now` +
          (m.uncertain ? `, ${m.uncertain} matched from several possibilities. Hover a tile and use the pencil to correct one` : '') + '.')
      })
    }
    wasRunning.current = !!artRunning
  }, [artRunning])

  // One fix, applied to every copy of the item on screen: the grid it lives in and
  // the search results when there are any. No refetch anywhere - see useList.patch.
  const patchItem = (id, changes) => {
    films.patch(id, changes)
    shows.patch(id, changes)
    if (hits) setHits(prev => (prev || []).map(i => (i.id === id ? { ...i, ...changes } : i)))
  }

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
  // THE LOCAL SOURCE'S STATES DO NOT APPLY TO A FRIEND'S LIBRARY. A client-only
  // desktop has no source at all, and gating the remote pages on it showed
  // "No films yet" over somebody's 240 films. The remote routes answer their
  // own errors honestly per request.
  if (!remote && state.scanning) {
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

  if (!remote && state.source?.kind === 'empty') {
    return (
      <div class='empty'>
        <h2>No films yet</h2>
        <p>Tell PearCinema where your collection is, in Settings.</p>
      </div>
    )
  }

  if (!remote && state.sourceError) {
    return (
      <>
        <div class='banner bad'>
          <b>The source is not answering.</b> {state.sourceError}
          <div class='hint'>This is usually an unplugged drive or a server that has moved. Devices can still reach this host.</div>
        </div>
      </>
    )
  }

  // THE FIX DIALOG RENDERS OUTSIDE THE ANIMATED SCREEN, and that placement is a
  // bug fix rather than taste (Tim, 2026-08-14: "the modal pops up at a fixed
  // space at the top of the list"). The depth-slide animation runs with
  // `fill-mode: both` on a transform, and an ancestor whose transform an animation
  // still APPLIES TO is a containing block for position: fixed - so the overlay
  // was centring on the tall scrolled list rather than on the viewport. Outside
  // the .screen there is no transformed ancestor and fixed means the viewport
  // again.
  const fixModal = fixItem && (
    <FixMatch
      item={fixItem}
      targetId={fixIdOf(fixItem)}
      onClose={() => setFixItem(null)}
      onFixed={(changes) => patchItem(fixItem.id, changes)}
    />
  )

  // --- search wins over everything, because that is what the box is for ---
  if (hits) {
    return (
      <>
      <div class={'screen ' + dir} key={depth}>
        <h2>{hits.length} result{hits.length === 1 ? '' : 's'} for “{search}”</h2>
        <CompatLine list={hits.filter(h => h.media)} caps={caps} />
        <div class='grid' style='margin-top:1rem'>
          {hits.map(h => (
            <Poster key={h.id} item={h} caps={caps} onFix={fixOn(h)} onOpen={i => {
              // A RESULT IS A PLACE TOO. Searching for a film and having it start
              // is the same surprise the grid used to give, one screen further in.
              if (i.type === 'series') go(() => { setHits(null); setRoot('shows'); setSeries(i) })
              else if (i.type === 'movie') go(() => { setHits(null); setRoot('films'); setFilm(i) })
              else onPlay(i, hits.filter(x => x.type === i.type))
            }} />
          ))}
        </div>
        {!hits.length && (
          <div class='empty'>
            Nothing matched.
            {remote && search.trim() && <AskFor key={search.trim()} name={search.trim()} />}
          </div>
        )}
      </div>
      {fixModal}
      </>
    )
  }

  // --- one film ---
  //
  // Everything a grid cannot say, before anything starts: how long it is, what it is
  // about, whether this browser can actually play this file, and whether you are
  // already forty minutes into it.
  if (film) {
    const r = resumeOf.get(film.id)
    const start = () => { setFilm(null); onPlay(film, films.items) }
    return (
      <div class={'screen ' + dir} key={depth}>
        <div class='crumbs'>
          <button onClick={() => go(() => setFilm(null), 'back')}>Films</button>
          <span>/</span>
          <span>{film.title}</span>
        </div>

        <TitleHead
          item={film}
          actions={
            <TitleActions
              item={film}
              resumeMs={r?.positionMs || 0}
              seen={seen.has(film.id)}
              onPlay={start}
              // RESUMING IS THE PLAYER'S OWN QUESTION, and it asks it: the card over
              // the picture is where "carry on from 41 minutes?" belongs, and asking
              // it twice would be one question too many. Pressing Resume here simply
              // opens the film, which then offers the same position.
              onResume={start}
              onWatched={mark}
              onFix={fixOn(film)}
            />
          }
        >
          <FilmFacts item={film} caps={caps} />
        </TitleHead>
        {fixModal}
      </div>
    )
  }

  // --- inside a show ---
  if (root === 'shows' && series) {
    return (
      <div class={'screen ' + dir} key={depth}>
        <div class='crumbs'>
          <button onClick={() => go(() => { setSeries(null); setSeason(null) }, 'back')}>Shows</button>
          <span>/</span>
          {season
            ? <><button onClick={() => go(() => setSeason(null), 'back')}>{series.title}</button><span>/</span><span>{season.title}</span></>
            : <span>{series.title}</span>}
        </div>

        {!season && (
          <>
            <TitleHead
              item={series}
              actions={
                <TitleActions
                  item={series}
                  seen={!!shows_[series.id]?.complete}
                  // A SHOW'S PLAY IS THE EPISODE YOU ARE UP TO, not its first: on a
                  // show three seasons in, starting at the pilot is never what
                  // anybody meant. Off the same rule the up-next shelf uses.
                  onPlay={playNextEpisode}
                  onWatched={mark}
                  onFix={fixOn(series)}
                />
              }
            />
            <h3 class='setgroup' style='margin-top:1.4rem'>Seasons</h3>
            <div class='grid'>
              {seasons.items.map(s => (
                <Poster
                  key={s.id}
                  item={s}
                  caps={caps}
                  watch={seasonRollups[s.id]}
                  onWatched={mark}
                  onOpen={x => go(() => setSeason(x))}
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
              <ViewToggle view={view} onChange={chooseView} what='these episodes' />
            </div>
            <CompatLine list={episodes.items} caps={caps} />
            <ArtNote list={episodes.items} source={remote ? 'remote' : state.source?.kind} />

            {view === 'grid' && (
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
            )}

            {/* AN EPISODE'S DETAIL ROW LEADS WITH ITS SLOT, not its year. S01E03 is
                how anybody refers to one, and the summary underneath is the thing
                the compact list has never had room for. */}
            {view === 'detail' && (
              <div class='rows' style='margin-top:.8rem'>
                {episodes.items.map(e => (
                  <DetailRow
                    key={e.id}
                    item={e}
                    caps={caps}
                    watch={badge(e)}
                    meta={[episodeCode(e), fmtRuntime(e.runtime)].filter(Boolean).join(' · ')}
                    onWatched={mark}
                    onOpen={() => onPlay(e, episodes.items)}
                  />
                ))}
              </div>
            )}

            {view === 'table' && (
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
                        {/* HOW FAR THROUGH, IN THE LIST TOO. The grid has said this
                            since the shelf existed and the list said nothing, so the
                            same episode looked untouched in one view and half-watched
                            in the other (Tim, 2026-08-13). A bar along the bottom edge
                            of the row rather than beside the text: it is the same
                            language as the poster's, and it does not push the title
                            around when it appears. */}
                        {progressOf({ positionMs: resumeOf.get(e.id)?.positionMs, runtime: e.runtime }) !== null && (
                          <span class='rowbar'>
                            <i style={`width:${progressOf({ positionMs: resumeOf.get(e.id)?.positionMs, runtime: e.runtime })}%`} />
                          </span>
                        )}
                        {e.runtime ? <span class='hint'>{fmtRuntime(e.runtime)}</span> : null}
                        {flag && <span class={'chip ' + flag.cls}>{flag.text}</span>}
                        <button
                          class={'mark' + (seen.has(e.id) ? ' on' : '')}
                          title={seen.has(e.id) ? 'Mark as unwatched' : 'Mark as watched'}
                          aria-label={(seen.has(e.id) ? 'Mark as unwatched: ' : 'Mark as watched: ') + e.title}
                          onClick={ev => { ev.stopPropagation(); mark(e, !seen.has(e.id)) }}
                        ><Check size={13} /></button>
                      </div>
                    )
                  })}
                </div>
            )}
            {episodes.busy && !episodes.items.length && <div class='empty'>Loading…</div>}
            <LoadMore cursor={episodes.cursor} onMore={episodes.more} busy={episodes.busy} />
          </>
        )}
      </div>
    )
  }

  const showing = root === 'films' ? films : shows

  // WHAT STAYS PUT AND WHAT MOVES. The shelf and the Films/Shows switch are not part of
  // the thing being switched - sliding them out and back when somebody presses Shows
  // makes the page look like it reloaded, and it takes the switch they just pressed
  // away from under the pointer (Tim, 2026-08-13). So only what is BELOW them animates,
  // keyed on which root is showing.
  return (
    <>
      <ContinueRow
        watch={watch}
        caps={caps}
        onWatched={mark}
        onForget={forget}
        onClear={clearShelf}
        // THE SHELF STILL PLAYS STRAIGHT AWAY, and that is the point of it: a row
        // called Continue watching is somebody saying carry on, not somebody asking
        // what a film is. The library grid is where the question gets asked.
        onOpen={i => onPlay(i, [...(watch.continue || []), ...(watch.upNext || [])])}
      />

      {/* FROZEN AT THE TOP while the library scrolls (Tim, 2026-08-14): three
          hundred tiles down is exactly where somebody decides they wanted Shows
          instead, and the way back up to the shelf rides along as its own button -
          freezing the shelf ITSELF would spend a third of the viewport on it. */}
      {/* Continue watching sits LEFT of the categories with a divider between
          (Tim, 2026-08-14): it is a place to go back to, not a third category, and
          the divider keeps that reading as categories are added. No counts on the
          buttons - the number of films you own is not a decision anybody is making
          here. */}
      <div class='row pickrow'>
        <WatchingAs watch={watch} onChange={onWatchChange} />
        {((watch?.continue || []).length > 0 || (watch?.upNext || []).length > 0) && (
          <>
            <button class='ghost' onClick={() => document.getElementById('continue-shelf')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              Continue watching
            </button>
            <span class='vdiv' aria-hidden='true' />
          </>
        )}
        <button class={root === 'films' ? '' : 'ghost'} onClick={() => go(() => setRoot('films'), 'back')}>Films</button>
        <button class={root === 'shows' ? '' : 'ghost'} onClick={() => go(() => setRoot('shows'))}>Shows</button>
        {/* FAR RIGHT, away from the categories: which films you are looking at and
            how they are drawn are two different questions, and putting them side by
            side reads as five things to press (Plex's placement too). */}
        <span class='grow' />
        <ViewToggle view={libView} onChange={chooseLibView} what='your library' />
      </div>

      <div class={'screen ' + dir} key={root}>

      {root === 'films' && <CompatLine list={films.items} caps={caps} />}
      <ArtNote list={showing.items} source={remote ? 'remote' : state.source?.kind} />

      {/* THE PASS IS VISIBLE WHERE ITS RESULT LANDS (Tim, 2026-08-14). Progress in a
          Settings panel nobody is looking at is progress nobody sees; the posters
          arrive on THIS page, so this page says they are coming - with a bar, not a
          sentence pretending to be one. */}
      {artRunning && (
        <div class='banner artfetch' style='margin-top:.6rem'>
          <span>Fetching artwork - <b>{artRunning.done}</b> of {artRunning.total}. Posters appear as they land.</span>
          <span class='meter'><i style={`width:${artRunning.total ? Math.round((artRunning.done / artRunning.total) * 100) : 0}%`} /></span>
        </div>
      )}

      {showing.err && <div class='banner bad'>{showing.err}</div>}

      {(() => {
        const open = (item) => {
          if (item.type === 'series') go(() => setSeries(item))
          // A FILM GETS A PAGE. An episode does not: it is reached from its season,
          // where the list around it already says what it is, and the thing somebody
          // wants from an episode row is the episode.
          else if (item.type === 'movie') go(() => setFilm(item))
          else onPlay(item, films.items)
        }
        if (libView === 'grid') {
          return (
            <div class='grid' style='margin-top:.8rem'>
              {showing.items.map(i => (
                <Poster key={i.id} item={i} caps={caps} watch={i.type === 'series' ? shows_[i.id] : badge(i)} onWatched={mark} onFix={fixOn(i)} onOpen={open} />
              ))}
            </div>
          )
        }
        if (libView === 'detail') {
          return (
            <div class='rows' style='margin-top:.8rem'>
              {showing.items.map(i => (
                <DetailRow
                  key={i.id}
                  item={i}
                  caps={caps}
                  watch={i.type === 'series' ? shows_[i.id] : badge(i)}
                  // A SHOW'S SECOND LINE IS NOT A FILM'S. How many seasons it has is
                  // the useful fact about a show; a film has a year and a length.
                  meta={i.type === 'series'
                    ? `${i.seasonCount || 0} season${i.seasonCount === 1 ? '' : 's'}`
                    : [i.year, fmtRuntime(i.runtime)].filter(Boolean).join(' · ')}
                  onWatched={mark}
                  onOpen={open}
                />
              ))}
            </div>
          )
        }
        return (
          <div style='margin-top:.8rem'>
            <TableRows
              items={showing.items}
              caps={caps}
              seenOf={i => (i.type === 'series' ? !!shows_[i.id]?.complete : seen.has(i.id))}
              resumeOf={resumeOf}
              onWatched={mark}
              onOpen={open}
            />
          </div>
        )
      })()}

      {showing.busy && !showing.items.length && <div class='empty'>Loading…</div>}
      {!showing.busy && !showing.items.length && (
        <div class='empty'>
          Nothing here yet. {root === 'films' ? 'Films' : 'Shows'} will appear once the source has been scanned.
        </div>
      )}
      <LoadMore cursor={showing.cursor} onMore={showing.more} busy={showing.busy} />
      </div>

      {fixModal}
    </>
  )
}
