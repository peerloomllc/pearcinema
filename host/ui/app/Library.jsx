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

function Poster ({ item, caps, onOpen }) {
  const v = item.media ? verdictFor(item, caps) : null
  const sub = item.type === 'series'
    ? `${item.seasonCount || 0} season${item.seasonCount === 1 ? '' : 's'}`
    : [item.year, fmtRuntime(item.runtime)].filter(Boolean).join(' · ')

  return (
    <button class='poster' onClick={() => onOpen(item)}>
      <Art item={item} />
      {v && v.status === 'refuse' && <span class='flag bad'>browser: no</span>}
      {v && v.status === 'nosound' && <span class='flag warn'>no sound</span>}
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

function CompatLine ({ list, caps }) {
  const t = tally(list, caps)
  if (!t.total) return null
  if (t.play === t.total) {
    return <p class='hint'>Your browser can play all {t.total} of these.</p>
  }
  return (
    <p class='hint'>
      Your browser can play <b>{t.play}</b> of these {t.total}
      {t.nosound ? `, plus ${t.nosound} with no sound` : ''}
      {t.refuse ? `. ${t.refuse} are in a container it refuses to open - the same refusal an iPhone gives, and what remux is for` : ''}
      {t.unknown ? `. ${t.unknown} did not say what is inside them` : ''}.
    </p>
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

export default function Library ({ state, caps, search, onPlay }) {
  // 'films' | 'shows', and where we are inside the show tree.
  const [root, setRoot] = useState('films')
  const [series, setSeries] = useState(null)
  const [season, setSeason] = useState(null)
  const [hits, setHits] = useState(null)

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
            <h2>{season.title}</h2>
            <CompatLine list={episodes.items} caps={caps} />
            <ArtNote list={episodes.items} source={state.source?.kind} />
            <div class='rows' style='margin-top:.8rem'>
              {episodes.items.map(e => {
                const v = verdictFor(e, caps)
                return (
                  <button class='eprow' key={e.id} onClick={() => onPlay(e, episodes.items)}>
                    <span class='code'>{episodeCode(e) || '-'}</span>
                    <span class='t'>{e.title}</span>
                    {e.runtime ? <span class='hint'>{fmtRuntime(e.runtime)}</span> : null}
                    {v.status === 'refuse' && <span class='chip bad'>browser: no</span>}
                    {v.status === 'nosound' && <span class='chip warn'>no sound</span>}
                  </button>
                )
              })}
            </div>
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
