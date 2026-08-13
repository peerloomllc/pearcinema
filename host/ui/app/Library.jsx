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

import { useState, useEffect } from 'preact/hooks'
import { api, fmtRuntime, episodeCode } from './api'
import { verdictFor, tally } from './playback'

function Art ({ item }) {
  const [bad, setBad] = useState(false)
  if (!item.artId || bad) {
    return <div class='art'>{item.type === 'movie' ? '🎬' : item.type === 'series' ? '📺' : '🎞'}</div>
  }
  return (
    <div class='art'>
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

function Poster ({ item, caps, onOpen, label = null }) {
  const v = item.media ? verdictFor(item, caps) : null
  const flag = flagFor(v)
  const sub = item.type === 'series'
    ? `${item.seasonCount || 0} season${item.seasonCount === 1 ? '' : 's'}`
    // An episode in a grid needs its NUMBER above all - a wall of thumbnails with
    // only titles under them is unreadable as an episode list.
    : [label, item.year, fmtRuntime(item.runtime)].filter(Boolean).join(' · ')

  return (
    <button class='poster' onClick={() => onOpen(item)}>
      <Art item={item} />
      {flag && <span class={'flag ' + flag.cls}>{flag.text}</span>}
      <div class='t'>{item.title}</div>
      {sub && <div class='s'>{sub}</div>}
    </button>
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

export default function Library ({ state, caps, search, onPlay }) {
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

  useEffect(() => {
    if (!search) { setHits(null); return }
    let live = true
    const t = setTimeout(async () => {
      const res = await api('/api/library/search?q=' + encodeURIComponent(search))
      if (live) setHits(res.items || [])
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [search])

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
              {seasons.items.map(s => <Poster key={s.id} item={s} caps={caps} onOpen={setSeason} />)}
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
                      <button class='eprow' key={e.id} onClick={() => onPlay(e, episodes.items)}>
                        <span class='code'>{episodeCode(e) || '-'}</span>
                        <span class='t'>{e.title}</span>
                        {e.runtime ? <span class='hint'>{fmtRuntime(e.runtime)}</span> : null}
                        {flag && <span class={'chip ' + flag.cls}>{flag.text}</span>}
                      </button>
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
      <div class='row' style='margin-bottom:.6rem'>
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
          <Poster key={i.id} item={i} caps={caps} onOpen={item => {
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
