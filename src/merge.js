'use strict'

// The merged, deduplicated library index (proposal 2026-08-16-merged-libraries,
// phase 1). Given each paired host's FULL catalog tagged with its libraryId,
// produce ONE blended, deduped index the worklet serves browse/search/sort from
// in memory. Adapted from PearTune's worklet/merge.js, which shipped and holds;
// the vocabulary is films, not tracks, and the copy pick is device-aware.
//
// Everything here is PURE (no fs, no network), because the dedup is LOSSY and
// its keying is the part that most needs exhaustive unit tests: a remake
// sharing a title must not silently collapse with the original unless it also
// shares the year, and a punctuation variant of the same film must.
//
// A merged entity keeps EVERY host copy (`copies[]`, primary first) so playback
// can fail over to another host when the primary is offline. itemId is a
// one-way hash, so the owning libraryId travels on every copy; nothing routes
// without it.

// --- normalization + dedup keys ---------------------------------------------

// Fold a title to its dedup form: lowercase, strip accents, drop a bracketed
// edition qualifier ("(Director's Cut)", "[Extended Edition]", "(Remastered)"),
// punctuation to space, drop a leading article, collapse whitespace.
function norm (s) {
  if (s == null) return ''
  let x = String(s).toLowerCase()
  x = x.normalize('NFKD').replace(/[̀-ͯ]/g, '')
  x = x.replace(/[([][^)\]]*(cut|extended|remaster|edition|version|anniversary|unrated|theatrical|imax)[^)\]]*[)\]]/gi, ' ')
  x = x.replace(/[^a-z0-9]+/g, ' ').trim()
  x = x.replace(/^(the|a|an) /, '')
  return x.replace(/\s+/g, ' ').trim()
}

// A film is its title and year. Two rips of the same film share both; a remake
// differs in year. Null years key as 0 - two undated copies of one title merge,
// which is the right default for a personal library.
function movieKey (m) {
  return [norm(m.title), Number(m.year) || 0].join('|')
}

// A show is its name. Years are NOT in the key: the folder adapter only knows a
// year when the folder name carries one, so "Dark (2017)" on one host and
// "Dark" on the other must still be one show.
function seriesKey (s) {
  return norm(s.title != null ? s.title : s.name)
}

// An episode is its show and its slot. Unnumbered episodes (a box set with no
// S01E01 in the names) fall back to their own title so they never collapse
// into one "episode null of season null".
function episodeKey (e) {
  const sk = norm(e.seriesTitle)
  const sn = e.seasonNumber
  const en = e.episodeNumber
  if (sn == null && en == null) return [sk, 't', norm(e.title)].join('|')
  return [sk, Number(sn) || 0, Number(en) || 0].join('|')
}

// --- merge primitives --------------------------------------------------------

// Group tagged entities by dedup key. Each group keeps its members in
// first-seen order and a chosen `primary` whose display fields win. better(a,
// b) returns true when a should replace b as primary; default keeps the first
// seen, i.e. the first-added host.
function groupByKey (entities, keyFn, better) {
  const byKey = new Map()
  for (const e of entities) {
    const k = keyFn(e)
    let g = byKey.get(k)
    if (!g) { g = { key: k, primary: e, copies: [e] }; byKey.set(k, g); continue }
    g.copies.push(e)
    if (better && better(e, g.primary)) g.primary = e
  }
  return byKey
}

// copies[] with the PRIMARY first, so bestCopy() and any "on 2 servers" UI
// read primary as the head and the rest as fallbacks in first-seen order.
function orderedCopies (group, copyOf) {
  const p = copyOf(group.primary)
  const rest = group.copies.filter((e) => e !== group.primary).map(copyOf)
  return [p, ...rest]
}

// A better film copy to be PRIMARY: one with a poster beats one without, then
// the larger file (a rough quality proxy). Only about which copy's display
// fields and default stream win; every copy stays reachable.
function betterItem (a, b) {
  const artA = !!a.artId
  const artB = !!b.artId
  if (artA !== artB) return artA
  return (Number(a.media?.size) || 0) > (Number(b.media?.size) || 0)
}

function itemCopy (x) {
  return {
    libraryId: x.libraryId,
    id: x.id,
    artId: x.artId || null,
    size: Number(x.media?.size) || 0,
    videoCodec: x.media?.videoCodec || null,
    container: x.media?.container || null
  }
}

function idCopy (x) {
  return { libraryId: x.libraryId, id: x.id, artId: x.artId || null }
}

// --- per-type merges ---------------------------------------------------------

function mergeMovies (movies) {
  const out = []
  for (const g of groupByKey(movies, movieKey, betterItem).values()) {
    const p = g.primary
    out.push({
      type: 'movie',
      id: p.id,
      key: g.key,
      libraryId: p.libraryId,
      title: p.title,
      year: p.year ?? null,
      runtime: p.runtime ?? null,
      overview: p.overview ?? null,
      genres: p.genres || [],
      artId: p.artId || null,
      media: p.media || null,
      // The NEWEST arrival across copies, so the merged Recently Added shelf
      // reflects when a film most recently landed on ANY host.
      addedAt: Math.max(0, ...g.copies.map((c) => Number(c.addedAt) || 0)) || null,
      copies: orderedCopies(g, itemCopy)
    })
  }
  return out
}

function mergeSeries (series) {
  // The most complete copy wins primary (most episodes), a decent proxy for
  // the fuller library. Counts are recomputed from merged episodes in
  // buildIndex, because a spanning series is the UNION, not either host's max.
  const better = (a, b) => (Number(a.episodeCount) || 0) > (Number(b.episodeCount) || 0)
  const out = []
  for (const g of groupByKey(series, seriesKey, better).values()) {
    const p = g.primary
    out.push({
      type: 'series',
      id: p.id,
      key: g.key,
      libraryId: p.libraryId,
      title: p.title,
      year: p.year ?? null,
      overview: p.overview ?? null,
      genres: p.genres || [],
      artId: p.artId || null,
      seasonCount: Number(p.seasonCount) || 0,
      episodeCount: Number(p.episodeCount) || 0,
      copies: orderedCopies(g, idCopy)
    })
  }
  return out
}

function mergeEpisodes (episodes) {
  const out = []
  for (const g of groupByKey(episodes, episodeKey, betterItem).values()) {
    const p = g.primary
    out.push({
      type: 'episode',
      id: p.id,
      key: g.key,
      libraryId: p.libraryId,
      seriesId: p.seriesId,
      seasonId: p.seasonId,
      seriesTitle: p.seriesTitle ?? null,
      seriesKey: norm(p.seriesTitle),
      seasonNumber: p.seasonNumber ?? null,
      episodeNumber: p.episodeNumber ?? null,
      seasonTitle: p.seasonTitle ?? null,
      title: p.title,
      year: p.year ?? null,
      runtime: p.runtime ?? null,
      overview: p.overview ?? null,
      artId: p.artId || null,
      media: p.media || null,
      addedAt: Math.max(0, ...g.copies.map((c) => Number(c.addedAt) || 0)) || null,
      copies: orderedCopies(g, itemCopy)
    })
  }
  return out
}

// --- the index ---------------------------------------------------------------

// Build the merged index from per-host catalogs. Each catalog is
// { libraryId, movies, series, episodes } (any list may be missing). Series
// counts are recomputed from the DEDUPED episode set so a show spanning two
// hosts reports the union - season 1 on the Umbrel plus season 2 on the Mac is
// two seasons, which neither host alone would say.
function buildIndex (catalogs) {
  const list = Array.isArray(catalogs) ? catalogs : []
  const tag = (arr, libraryId) => (Array.isArray(arr) ? arr : []).map((x) => ({ ...x, libraryId }))
  const collect = (field) => list.flatMap((c) => tag(c && c[field], c && c.libraryId))

  const movies = mergeMovies(collect('movies'))
  const series = mergeSeries(collect('series'))
  const episodes = mergeEpisodes(collect('episodes'))

  const bySeries = new Map()
  for (const e of episodes) {
    let s = bySeries.get(e.seriesKey)
    if (!s) { s = { seasons: new Set(), episodes: 0 }; bySeries.set(e.seriesKey, s) }
    s.seasons.add(e.seasonNumber == null ? `t:${e.seasonTitle || ''}` : e.seasonNumber)
    s.episodes++
  }
  for (const s of series) {
    const agg = bySeries.get(s.key)
    if (agg) {
      s.seasonCount = agg.seasons.size
      s.episodeCount = agg.episodes
    }
  }

  return { movies, series, episodes }
}

// --- the merged tree ---------------------------------------------------------

// Synthetic season ids for the merged tree: a season that spans hosts has no
// single real id, so the merged view mints one the list handler can parse
// back. Kept ugly-prefixed so a real host id can never collide.
function mergedSeasonId (seriesKeyStr, seasonNumber, seasonTitle) {
  const slot = seasonNumber == null ? `t:${seasonTitle || ''}` : String(seasonNumber)
  return `_m|${seriesKeyStr}|${slot}`
}

function parseMergedSeasonId (id) {
  const s = String(id || '')
  if (!s.startsWith('_m|')) return null
  const rest = s.slice(3)
  const cut = rest.lastIndexOf('|')
  if (cut < 0) return null
  const seriesKeyStr = rest.slice(0, cut)
  const slot = rest.slice(cut + 1)
  if (slot.startsWith('t:')) return { seriesKey: seriesKeyStr, seasonNumber: null, seasonTitle: slot.slice(2) || null }
  return { seriesKey: seriesKeyStr, seasonNumber: Number(slot), seasonTitle: null }
}

// The season rows for one merged series, derived from the deduped episodes -
// the union across hosts, ordered specials-first-numerically then titled sets.
function seasonsFor (index, seriesKeyStr) {
  const eps = index.episodes.filter((e) => e.seriesKey === seriesKeyStr)
  const groups = new Map()
  for (const e of eps) {
    const slot = e.seasonNumber == null ? `t:${e.seasonTitle || ''}` : e.seasonNumber
    let g = groups.get(slot)
    if (!g) {
      g = {
        type: 'season',
        id: mergedSeasonId(seriesKeyStr, e.seasonNumber, e.seasonTitle),
        seriesId: e.seriesId,
        seriesTitle: e.seriesTitle,
        number: e.seasonNumber ?? null,
        title: e.seasonNumber == null
          ? (e.seasonTitle || 'Season')
          : (e.seasonNumber === 0 ? 'Specials' : `Season ${e.seasonNumber}`),
        artId: e.artId || null,
        episodeCount: 0
      }
      groups.set(slot, g)
    }
    g.episodeCount++
    if (!g.artId && e.artId) g.artId = e.artId
  }
  return [...groups.values()].sort((a, b) => {
    const an = a.number ?? Infinity
    const bn = b.number ?? Infinity
    if (an !== bn) return an - bn
    return String(a.title).localeCompare(String(b.title))
  })
}

// The episodes of one merged season, in airing order across hosts.
function episodesFor (index, seriesKeyStr, seasonNumber, seasonTitle) {
  return index.episodes
    .filter((e) => e.seriesKey === seriesKeyStr &&
      (seasonNumber == null
        ? e.seasonNumber == null && (e.seasonTitle || '') === (seasonTitle || '')
        : e.seasonNumber === seasonNumber))
    .sort((a, b) => (Number(a.episodeNumber) || 0) - (Number(b.episodeNumber) || 0) ||
      String(a.title).localeCompare(String(b.title)))
}

// Every episode of a merged series in watch order - the sibling walk's
// universe. Seasons interleave across hosts (the spanning-series wrinkle);
// unnumbered sets sort after numbered seasons, alphabetically within.
function seriesRun (index, seriesKeyStr) {
  const eps = index.episodes.filter((e) => e.seriesKey === seriesKeyStr)
  return eps.sort((a, b) => {
    const an = a.seasonNumber ?? Infinity
    const bn = b.seasonNumber ?? Infinity
    if (an !== bn) return an - bn
    const at = a.seasonNumber == null ? String(a.seasonTitle || '') : ''
    const bt = b.seasonNumber == null ? String(b.seasonTitle || '') : ''
    if (at !== bt) return at.localeCompare(bt)
    return (Number(a.episodeNumber) || 0) - (Number(b.episodeNumber) || 0) ||
      String(a.title).localeCompare(String(b.title))
  })
}

// --- serve helpers -----------------------------------------------------------

// Sort merged items by a field (new array). Text sorts by normalized form so
// "The Lion King" and "Lion King" order together.
function sortItems (items, key, order = 'asc') {
  const dir = order === 'desc' ? -1 : 1
  const val = (x) => {
    switch (key) {
      case 'year': return Number(x.year) || 0
      case 'added': return Number(x.addedAt) || 0
      case 'runtime': return Number(x.runtime) || 0
      case 'title':
      case 'name':
      default: return norm(x.title != null ? x.title : x.name)
    }
  }
  return [...(items || [])].sort((a, b) => {
    const av = val(a)
    const bv = val(b)
    return av < bv ? -dir : av > bv ? dir : 0
  })
}

// Narrow the merged list to items with a copy on `libraryId`. '_all'/falsy is
// the whole blend. This is why the per-host view is free: it is the merged
// index filtered.
function filterByLibrary (items, libraryId) {
  if (!libraryId || libraryId === '_all') return items || []
  return (items || []).filter(
    (x) => (Array.isArray(x.copies) && x.copies.some((c) => c.libraryId === libraryId)) || x.libraryId === libraryId
  )
}

// Search the merged index: normalized substring match, title-prefix hits
// first, then shows by name, both alphabetical inside their band.
function searchIndex (index, q, limit = 60) {
  const needle = norm(q)
  if (!needle) return { movies: [], series: [], episodes: [] }
  const score = (title) => {
    const t = norm(title)
    if (!t.includes(needle)) return -1
    return t.startsWith(needle) ? 0 : 1
  }
  const pick = (arr, titleOf) => arr
    .map((x) => ({ x, s: score(titleOf(x)) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => a.s - b.s || norm(titleOf(a.x)).localeCompare(norm(titleOf(b.x))))
    .slice(0, limit)
    .map((r) => r.x)
  return {
    movies: pick(index.movies, (m) => m.title),
    series: pick(index.series, (s) => s.title),
    episodes: pick(index.episodes, (e) => `${e.seriesTitle || ''} ${e.title}`)
  }
}

// --- requests across a blended library (phase 2) -----------------------------
//
// In merged mode a request is filed with EVERY connected host - none of them
// has the film, so any of their owners might add it. Each host keeps its own
// row, so the requester's list would show the same ask twice with different
// statuses. Collapse to ONE row per ask carrying the BEST status - if any host
// added it, the film is coming - plus which libraries it went to. The OWNER's
// queue folds the same rows the opposite way (`pendingWins`): that view is a
// to-do list, and an ask still pending on ANY library you own is still work.
// Straight from PearTune's shipped shape; the key drops artist because a film
// request is its kind and its name.
const REQUEST_STATUS_RANK = { added: 3, pending: 2, declined: 1 }
const REQUEST_STATUS_RANK_PENDING_FIRST = { pending: 3, added: 2, declined: 1 }

function collapseRequests (rows, { pendingWins = false } = {}) {
  const rank = pendingWins ? REQUEST_STATUS_RANK_PENDING_FIRST : REQUEST_STATUS_RANK
  const byKey = new Map()
  for (const r of rows || []) {
    if (!r) continue
    const key = `${r.kind}|${norm(r.name)}`
    let g = byKey.get(key)
    // `refs` carries every per-host (libraryId, id, status) this ask lives on,
    // so REMOVE can delete it everywhere and RESOLVE can fan out to just the
    // ones still pending.
    if (!g) { g = { ...r, libraries: [], refs: [], _rank: 0 }; byKey.set(key, g) }
    const n = rank[r.status] || 0
    if (n > g._rank) { g._rank = n; g.status = r.status; g.resolvedAt = r.resolvedAt || null }
    if (r.libraryName && !g.libraries.includes(r.libraryName)) g.libraries.push(r.libraryName)
    if (r.libraryId && r.id) g.refs.push({ libraryId: r.libraryId, id: r.id, status: r.status })
    g.createdAt = Math.max(g.createdAt || 0, r.createdAt || 0)
    g.count = Math.max(g.count || 1, r.count || 1)
  }
  return [...byKey.values()]
    .map(({ _rank, ...r }) => r)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

// The inverse of the collapse: which per-host copies an action should reach.
// Resolve targets only the ones still pending - an "added" fan-out must never
// rewrite a copy another owner already declined. A row with no refs (an old
// shape, or a single-host read) falls back to its own id.
function requestTargets ({ refs, id, libraryId } = {}, { pendingOnly = true, fallbackLibraryId = null } = {}) {
  if (Array.isArray(refs) && refs.length) {
    return refs
      .filter((r) => r && r.libraryId && r.id && (!pendingOnly || !r.status || r.status === 'pending'))
      .map((r) => ({ libraryId: r.libraryId, id: r.id }))
  }
  const lib = libraryId || fallbackLibraryId
  return id && lib ? [{ libraryId: lib, id }] : []
}

// --- the copy pick -----------------------------------------------------------

// The best copy to STREAM, device-aware (proposal §5). `connected` is a Set of
// reachable libraryIds; omit to take the primary. `prefer` is the person's
// filter chip and outranks everything reachable - PearTune learned that
// filtering must scope where the bytes come from, not just what you see.
// `rank` is an optional callback (copy) => number, higher is better, supplied
// by the caller who knows this device's declared codecs and refusals - a copy
// that direct-plays here outranks one that needs the host's engine.
function bestCopy (entity, connected, prefer, rank) {
  if (!entity) return null
  const copies = Array.isArray(entity.copies) && entity.copies.length
    ? entity.copies
    : (entity.libraryId ? [{ libraryId: entity.libraryId, id: entity.id, artId: entity.artId }] : [])
  if (!copies.length) return null
  if (!connected) return copies[0]
  if (prefer) {
    const p = copies.find((c) => c.libraryId === prefer && connected.has(c.libraryId))
    if (p) return p
  }
  const reachable = copies.filter((c) => connected.has(c.libraryId))
  if (!reachable.length) return copies[0]
  if (!rank) return reachable[0]
  // Stable: equal ranks keep first-seen (primary-first) order.
  return reachable
    .map((c, i) => ({ c, i, r: Number(rank(c)) || 0 }))
    .sort((a, b) => b.r - a.r || a.i - b.i)[0].c
}

module.exports = {
  norm,
  movieKey,
  seriesKey,
  episodeKey,
  mergeMovies,
  mergeSeries,
  mergeEpisodes,
  buildIndex,
  mergedSeasonId,
  parseMergedSeasonId,
  seasonsFor,
  episodesFor,
  seriesRun,
  sortItems,
  filterByLibrary,
  searchIndex,
  bestCopy,
  collapseRequests,
  requestTargets
}
