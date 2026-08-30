// WHAT ONE PERSON MAY SEE OF THE LIBRARY, and the one place that decides it.
//
// proposals/2026-08-30-per-person-folders.md, approved the same day. A grant carries
// `paths`: null for everything (every grant until now) or a list of { root, rel }
// prefixes chosen on the People page. This file turns that into a yes or no per item,
// and wraps an adapter so every wire method that hands out content reads through the
// same view - a hidden film is not listed, not found by id, not searched, not counted.
// The stream, subtitle, cast and resume handlers ask the same view before they act, so
// the film is not one guessed id away either.
//
// Two rules are deliberate and easy to get backwards:
//   - An OWNER is never filtered, whatever the row says. The owner is the library.
//   - An item whose location the adapter cannot name is HIDDEN from a narrowed grant.
//     Failing open would make "narrow" mean "narrow, except for whatever we could not
//     place", which is exactly the silent hole the proposal calls a security bug.
//
// Nothing here touches the disk or the network: an adapter answers `locationOf(id)`
// from what it already knows, and the check is a string prefix comparison.

const path = require('path')

const OWNER = 'owner'

// A prefix that stands for "the root and everything under it" is rel ''. Any other
// rel is a folder path under the root, normalised to forward slashes with no leading
// or trailing separator, so 'kids', 'kids/', '/kids/' and 'kids\\' are one prefix.
function normalRel (rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

// Does a location fall under a prefix? Folder boundaries count: 'kids' covers
// 'kids/Frozen (2013)/Frozen.mkv' and does not cover 'kids2/...'.
function under (loc, prefix) {
  if (!loc || !prefix) return false
  if (loc.root !== prefix.root) return false
  const want = normalRel(prefix.rel)
  if (want === '') return true
  const have = normalRel(loc.rel)
  return have === want || have.startsWith(want + '/')
}

// The question. `grant` is the live grant of the connection; `loc` is what the adapter
// says about the item ({ root, rel } or null).
function visibleTo (grant, loc) {
  if (!grant) return false
  if (grant.scope === OWNER) return true
  const paths = grant.paths
  if (paths === null || paths === undefined) return true
  if (!Array.isArray(paths) || paths.length === 0) return false
  if (!loc) return false
  return paths.some((p) => under(loc, p))
}

// Is this grant narrowed at all? The fast path: an unnarrowed grant gets the real
// adapter back, so the common case costs nothing.
function narrowed (grant) {
  return !!grant && grant.scope !== OWNER && Array.isArray(grant.paths) && grant.paths.length > 0
}

// The adapter as ONE PERSON sees it. Same interface as the adapter it wraps; the
// methods that hand out items are filtered, everything else passes through untouched
// (art, subtitles, stream bytes are gated by the callers that first resolve the item).
//
// `list` asks the adapter to filter with a predicate where it can (the folder adapter
// filters its in-memory pool before paging, so pages stay full), and filters the result
// again regardless - an adapter that ignores the predicate is still correct, only its
// pages come back shorter.
function viewOf (adapter, grant) {
  // An adapter that cannot answer `get` cannot be narrowed and is handed back as it
  // is: a source with no item lookup has nothing this check could filter, and
  // pretending otherwise would break it rather than protect anything.
  if (!adapter || typeof adapter.get !== 'function' || !narrowed(grant)) return adapter
  const see = (item) => {
    if (!item) return false
    const loc = typeof adapter.locationOf === 'function' ? adapter.locationOf(item.id, item) : null
    return visibleTo(grant, loc)
  }
  const view = Object.create(adapter)
  view.visible = see
  view.list = async (args = {}) => {
    const page = await adapter.list({ ...args, visible: see })
    return { ...page, items: (page?.items || []).filter(see) }
  }
  view.get = async (args = {}) => {
    const item = await adapter.get(args)
    return see(item) ? item : null
  }
  view.search = async (args = {}) => {
    const out = await adapter.search(args)
    return { ...out, items: (out?.items || []).filter(see) }
  }
  // Counts come from what is visible, not from the disk. Cheap for the folder adapter
  // (in-memory pools); a server source pays a few list calls, on an owner-rare path.
  view.stats = async () => {
    const base = await adapter.stats()
    const movies = (await view.list({ type: 'movies', limit: 100000 })).items.length
    const seriesRows = (await view.list({ type: 'series', limit: 100000 })).items
    let seasons = 0
    let episodes = 0
    for (const s of seriesRows) {
      const ss = (await view.list({ type: 'seasons', seriesId: s.id, limit: 100000 })).items
      seasons += ss.length
      for (const season of ss) episodes += (await view.list({ type: 'episodes', seasonId: season.id, limit: 100000 })).items.length
    }
    return { ...base, movies, series: seriesRows.length, seasons, episodes, narrowed: true }
  }
  return view
}

// Where a file sits relative to the roots an adapter was given: { root, rel } or null
// when it is under none of them. Shared by the folder adapter and by Jellyfin, whose
// server reports paths the same way.
function locate (file, roots) {
  if (!file) return null
  const at = path.resolve(String(file))
  for (const r of roots || []) {
    const rootPath = typeof r === 'string' ? r : r?.path
    if (!rootPath) continue
    if (at === rootPath) return { root: rootPath, rel: '' }
    if (at.startsWith(rootPath + path.sep)) return { root: rootPath, rel: normalRel(path.relative(rootPath, at)) }
  }
  return null
}

module.exports = { visibleTo, narrowed, viewOf, locate, under, normalRel }
