// OPT-IN online artwork, from TMDB, with the operator's own key.
//
// The decisions this file implements were taken 2026-08-12 and live in DECISIONS.md;
// they are constraints here, not preferences:
//
//   - THE OPERATOR BRINGS THEIR OWN KEY. PearCinema ships no credential - a key in
//     an MIT repo is extractable and its rate limit is shared by every install. TMDB
//     only, because a user-supplied key cannot afford a second registration.
//   - SIDECAR ALWAYS WINS. An item that already has artwork is never touched, so for
//     a well-kept library this never runs at all. Online fills gaps, it does not
//     compete.
//   - DEFAULT OFF, and the dashboard says plainly that the HOST tells a third party
//     what titles it is identifying. That sentence is the price of the feature and
//     it is said, not buried.
//   - THE CACHE LIVES IN THE DATA DIR, never in the library. Nothing here writes
//     into anybody's collection; sidecar-writing is the separate, explicit action
//     it was always meant to be, and it lives in host/sidecars.js.
//
// MATCHING IS BEST-EFFORT, WITH HONESTY ABOUT DOUBT (Tim, 2026-08-14, revising the
// first cut). The first build held every ambiguous name back for the operator to
// settle, which on a real library meant a homework list of prompts before any
// artwork appeared. Plex's shape is better and Tim named it: apply the best guess,
// SAY that some guesses were made, and put a fix control on the tile itself - so
// the cost of a wrong poster is one click on the thing that is wrong, not a queue
// standing between the operator and all the right ones.

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const API = 'https://api.themoviedb.org/3'
const IMAGES = 'https://image.tmdb.org/t/p/'

// Both shapes of TMDB credential work, because the key page offers both and asking
// somebody to know which one they copied is a support ticket: the short v3 key rides
// as a query parameter, the long v4 token (a JWT, so it starts with eyJ) as a Bearer
// header.
function authFor (key) {
  const k = String(key || '').trim()
  if (k.startsWith('eyJ')) return { headers: { authorization: `Bearer ${k}` }, query: '' }
  return { headers: {}, query: `api_key=${encodeURIComponent(k)}` }
}

// The comparison form of a title: lower-cased, diacritics folded, punctuation gone.
// "WALL·E", "Wall-E" and "WALL-E (2008)" have already diverged by the time they are
// filenames, and the year is compared separately.
function normTitle (s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

class TmdbClient {
  constructor ({ key, fetch = globalThis.fetch } = {}) {
    this.key = String(key || '').trim()
    this.fetch = fetch
  }

  async _get (pathname, params = {}) {
    const auth = authFor(this.key)
    const q = new URLSearchParams(params).toString()
    const sep = [auth.query, q].filter(Boolean).join('&')
    const res = await this.fetch(`${API}${pathname}${sep ? '?' + sep : ''}`, { headers: auth.headers })
    if (res.status === 401) {
      const e = new Error('TMDB did not accept this key')
      e.code = 'BAD_KEY'
      throw e
    }
    if (!res.ok) throw new Error(`TMDB answered ${res.status}`)
    return res.json()
  }

  // The Test button. Asks for the one thing every valid key can read, so a typo'd
  // key fails HERE rather than as a library that quietly stays bare.
  async test () {
    try {
      await this._get('/configuration')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.code === 'BAD_KEY' ? 'TMDB did not accept this key' : e.message }
    }
  }

  // Candidates for one item. A film and a show are different TMDB endpoints with
  // different field names, mapped onto one shape here so nothing downstream cares.
  async search ({ type, title, year = null }) {
    const tv = type === 'series'
    const params = { query: title, include_adult: 'false' }
    if (year) params[tv ? 'first_air_date_year' : 'year'] = String(year)

    let out = await this._get(tv ? '/search/tv' : '/search/movie', params)
    // A year narrows; a wrong year (rips are often off by one) empties. Retry once
    // without it rather than reporting a miss for a film TMDB knows perfectly well.
    if (!out.results?.length && year) {
      delete params[tv ? 'first_air_date_year' : 'year']
      out = await this._get(tv ? '/search/tv' : '/search/movie', params)
    }

    return (out.results || []).slice(0, 5).map(r => ({
      tmdbId: r.id,
      title: tv ? r.name : r.title,
      year: Number(String(tv ? r.first_air_date : r.release_date || '').slice(0, 4)) || null,
      poster: r.poster_path || null,
      overview: r.overview || ''
    }))
  }

  // `size` is a TMDB rendition name: w500 for the poster that is kept, w185 for
  // the thumbnails the fix dialog picks from by eye.
  async poster (posterPath, size = 'w500') {
    const res = await this.fetch(IMAGES + size + posterPath, { headers: authFor(this.key).headers })
    if (!res.ok) throw new Error(`TMDB image answered ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  // One SEASON of a matched show: its own poster, and a still from every episode -
  // one call returns the lot, which is why season art costs a call per season
  // rather than one per episode.
  async season ({ tmdbId, seasonNumber }) {
    const r = await this._get(`/tv/${Number(tmdbId)}/season/${Number(seasonNumber)}`)
    return {
      poster: r.poster_path || null,
      episodes: (r.episodes || []).map(e => ({ episode: e.episode_number, still: e.still_path || null }))
    }
  }

  // One title by its TMDB id, for the fix flow: the operator picked a candidate and
  // the poster path is fetched fresh by id rather than trusted from the page.
  async details ({ type, tmdbId }) {
    const tv = type === 'series'
    const r = await this._get(`${tv ? '/tv' : '/movie'}/${Number(tmdbId)}`)
    return {
      tmdbId: r.id,
      title: tv ? r.name : r.title,
      year: Number(String(tv ? r.first_air_date : r.release_date || '').slice(0, 4)) || null,
      poster: r.poster_path || null,
      overview: r.overview || ''
    }
  }
}

// The best candidate, and whether it was a GUESS. An exact normalised title with
// the year agreeing (rips are routinely off by one), or the only thing the search
// returned, is sure. Anything else still picks - exact-with-year first, then exact,
// then TMDB's own first result - but says `sure: false`, which is what the
// dashboard's "some of these were guesses" notice and the tile's fix control key
// off. The two films called Solaris both ship a poster; one of them may need the
// pencil.
function bestMatch (item, candidates) {
  if (!candidates.length) return null
  const want = normTitle(item.title)
  const yearOk = (c) => !item.year || !c.year || Math.abs(c.year - item.year) <= 1
  const exact = candidates.filter(c => normTitle(c.title) === want)
  const exactYear = exact.filter(yearOk)
  if (exactYear.length === 1) return { candidate: exactYear[0], sure: true }
  if (candidates.length === 1) return { candidate: candidates[0], sure: true }
  return { candidate: exactYear[0] || exact[0] || candidates[0], sure: false }
}

// Every page of one list. The adapter paginates; the pass wants the lot.
async function listAll (adapter, params) {
  const out = []
  let cursor = null
  do {
    const page = await adapter.list({ ...params, limit: 500, cursor })
    out.push(...(page.items || []))
    cursor = page.cursor
  } while (cursor)
  return out
}

// The store and the pass. Persisted as one JSON file plus a folder of posters in
// the DATA dir - disposable by design, so deleting it costs a re-fetch and nothing
// else, and nothing of the library's is ever written.
class Enricher {
  constructor ({ dataDir, fetch = globalThis.fetch, log = () => {} } = {}) {
    this.dir = path.join(dataDir, 'tmdb')
    this.postersDir = path.join(this.dir, 'posters')
    this.fetch = fetch
    this.log = log
    this.running = null
    this.state = this._read()
  }

  _file () { return path.join(this.dir, 'state.json') }

  _read () {
    try {
      return JSON.parse(fs.readFileSync(this._file(), 'utf8')) || {}
    } catch {
      return {}
    }
  }

  _write () {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this._file(), JSON.stringify(this.state, null, 2))
  }

  get matched () { return this.state.matched || (this.state.matched = {}) }
  get missed () { return this.state.missed || (this.state.missed = {}) }
  // Season posters and episode stills, keyed by ITEM id and remembering which show
  // they rode in on (`from`), so unmatching or re-fixing a show can take its
  // seasons' pictures with it rather than leaving the wrong programme's stills up.
  get art () { return this.state.art || (this.state.art = {}) }

  _posterFile (itemId) { return path.join(this.postersDir, itemId + '.jpg') }

  // The cached poster's path, for sidecar writing to copy OUT of the data dir
  // (host/sidecars.js). Null when this item has none on disk.
  posterPath (itemId) {
    const file = this._posterFile(String(itemId))
    return fs.existsSync(file) ? file : null
  }

  async _saveImage (itemId, bytes) {
    await fsp.mkdir(this.postersDir, { recursive: true })
    await fsp.writeFile(this._posterFile(itemId), bytes)
  }

  // SIDECAR ALWAYS WINS, expressed as: an item that has artwork is returned as it
  // came. Only a gap is filled, and with a copy rather than a mutation, because
  // adapters cache their item objects and a decorated cache would survive the
  // feature being turned off.
  decorate (item) {
    if (!item || item.artId) return item
    if (!this.matched[item.id]?.poster && !this.art[item.id]) return item
    return { ...item, artId: 'tmdb:' + item.id }
  }

  // Bytes for a tmdb: art id, same contract as adapter.art.
  artStream (artId) {
    const itemId = String(artId || '').replace(/^tmdb:/, '')
    if (!this.matched[itemId]?.poster && !this.art[itemId]) return null
    const file = this._posterFile(itemId)
    if (!fs.existsSync(file)) return null
    const stream = fs.createReadStream(file)
    stream.contentType = 'image/jpeg'
    return stream
  }

  async _apply (client, item, candidate, how, { uncertain = false } = {}) {
    const bytes = candidate.poster ? await client.poster(candidate.poster) : null
    if (bytes) await this._saveImage(item.id, bytes)
    this.matched[item.id] = {
      tmdbId: candidate.tmdbId,
      title: candidate.title,
      year: candidate.year,
      poster: !!bytes,
      how,
      ...(uncertain ? { uncertain: true } : {}),
      at: Date.now()
    }
    delete this.missed[item.id]
  }

  // The pass. Films and shows only - an episode's thumbnail is a different feature
  // with a different cost, and a show's poster is what its tiles actually want.
  //
  // `adapter` must be the INNER adapter, not the decorated one, so "has artwork"
  // means artwork on disk rather than artwork this pass invented last time.
  async run (adapter, { key, retryMissed = false } = {}) {
    if (this.running) return this.running
    if (!key) throw new Error('no TMDB key is saved')

    // The first cut held ambiguous names in a `pending` queue; anything a previous
    // build left there is simply looked up again under the new rules.
    delete this.state.pending

    const client = new TmdbClient({ key, fetch: this.fetch })
    const work = []
    for (const type of ['movies', 'series']) {
      for (const it of await listAll(adapter, { type })) {
        if (it.artId) continue
        if (this.matched[it.id]) continue
        if (this.missed[it.id] && !retryMissed) continue
        work.push(it)
      }
    }

    this.running = { done: 0, total: work.length, startedAt: Date.now() }
    this.log('tmdb:run', { items: work.length })

    try {
      for (const item of work) {
        try {
          const candidates = await client.search({ type: item.type, title: item.title, year: item.year })
          const best = bestMatch(item, candidates)
          if (best) {
            await this._apply(client, item, best.candidate, 'auto', { uncertain: !best.sure })
          } else {
            this.missed[item.id] = { title: item.title, at: Date.now() }
          }
        } catch (e) {
          // A bad key fails the whole pass loudly - every further call would fail
          // the same way. Anything else (one flaky lookup) costs that item only.
          if (e.code === 'BAD_KEY') throw e
          this.missed[item.id] = { title: item.title, error: e.message, at: Date.now() }
        }
        this.running.done++
      }

      // SEASONS AND EPISODES ride on the show matches (Tim, 2026-08-14). One TMDB
      // call per season brings that season's poster AND a still from every episode,
      // so a 165-season library is 165 calls, not 2,700. Only gaps are fetched, so
      // a second pass over a fully-pictured library does nothing. The progress
      // total grows as this work is discovered, which the bar handles honestly.
      const tick = {
        add: (n) => { this.running.total += n },
        done: (n) => { this.running.done += n }
      }
      for (const s of await listAll(adapter, { type: 'series' })) {
        const m = this.matched[s.id]
        if (m?.tmdbId) await this._fetchSeasonArt(adapter, client, s.id, m.tmdbId, tick)
      }
    } finally {
      this.state.lastRun = {
        at: Date.now(),
        looked: work.length,
        matched: Object.keys(this.matched).length,
        uncertain: Object.values(this.matched).filter(m => m.uncertain).length,
        pictures: Object.keys(this.art).length,
        missed: Object.keys(this.missed).length
      }
      this._write()
      this.running = null
    }

    this.log('tmdb:done', this.state.lastRun)
    return this.state.lastRun
  }

  // Season posters and episode stills for ONE show, filling only what is missing.
  // A season with no number cannot be addressed at TMDB and is skipped; an episode
  // TMDB has no still for is skipped silently rather than swelling `missed` by
  // hundreds of specials - the next pass asks its season again, one cheap call.
  async _fetchSeasonArt (adapter, client, seriesId, seriesTmdbId, tick = null) {
    for (const season of await listAll(adapter, { type: 'seasons', seriesId })) {
      // A SEASON item carries `number`, not `seasonNumber` - that name lives on
      // EPISODES (host/items.js). Found the expensive way: a fake adapter written
      // with the wrong field passed every test while the real library skipped
      // every season it had.
      const n = season.number ?? season.seasonNumber ?? null
      if (n === null || n === undefined) continue
      const eps = await listAll(adapter, { type: 'episodes', seasonId: season.id })
      const needSeason = !season.artId && !this.art[season.id]
      const needEps = eps.filter(e => !e.artId && !this.art[e.id] && e.episodeNumber !== null && e.episodeNumber !== undefined)
      if (!needSeason && !needEps.length) continue

      tick?.add(1 + needEps.length)
      try {
        const data = await client.season({ tmdbId: seriesTmdbId, seasonNumber: n })
        if (needSeason && data.poster) {
          await this._saveImage(season.id, await client.poster(data.poster))
          this.art[season.id] = { from: seriesId, at: Date.now() }
        }
        tick?.done(1)

        const stills = new Map(data.episodes.map(x => [x.episode, x.still]))
        for (const e of needEps) {
          const still = stills.get(e.episodeNumber)
          if (still) {
            try {
              // w300: a still is a thumbnail in a grid, not a poster on a shelf.
              await this._saveImage(e.id, await client.poster(still, 'w300'))
              this.art[e.id] = { from: seriesId, at: Date.now() }
            } catch {}
          }
          tick?.done(1)
        }
      } catch (e) {
        if (e.code === 'BAD_KEY') throw e
        tick?.done(1 + needEps.length)
      }
    }
  }

  // Drop every season poster and episode still that rode in on one show's match -
  // called when the show is unmatched or re-matched, because the old programme's
  // pictures under the new programme's name is the worst version of wrong.
  async _dropSeasonArt (seriesId) {
    for (const [id, a] of Object.entries(this.art)) {
      if (a.from !== seriesId) continue
      delete this.art[id]
      await fsp.rm(this._posterFile(id), { force: true })
    }
  }

  // Candidates for ONE item, for the fix flow on the tile. `q` lets the operator
  // retype the title - the whole reason a match went wrong is usually that the
  // filename is not what the film is called.
  async search ({ item, q = null, key }) {
    const client = new TmdbClient({ key, fetch: this.fetch })
    return client.search({ type: item.type, title: q || item.title, year: q ? null : item.year })
  }

  // The operator picked the right one from the tile. The poster is fetched fresh by
  // id rather than trusted from the page, and a fixed match is never uncertain -
  // a person chose it. Re-matching a SHOW swaps its seasons' pictures too: the old
  // ones are dropped as stale and the new show's fetched, best effort.
  async fix ({ itemId, tmdbId, type, key, adapter = null }) {
    const client = new TmdbClient({ key, fetch: this.fetch })
    const candidate = await client.details({ type, tmdbId })
    if (!candidate?.tmdbId) return null
    if (type === 'series') await this._dropSeasonArt(itemId)
    await this._apply(client, { id: itemId }, candidate, 'fixed')
    if (type === 'series' && adapter) {
      await this._fetchSeasonArt(adapter, client, itemId, candidate.tmdbId).catch(() => {})
    }
    this._write()
    return this.matched[itemId]
  }

  // "This is not any of them" - drop the fetched artwork and stop guessing at this
  // item. Recorded in missed so the next automatic pass leaves it alone; "Look
  // again" retries it deliberately. A show takes its seasons' pictures with it.
  async unmatch (itemId) {
    const had = this.matched[itemId]
    if (!had) return false
    delete this.matched[itemId]
    this.missed[itemId] = { title: had.title, unmatched: true, at: Date.now() }
    await fsp.rm(this._posterFile(itemId), { force: true })
    await this._dropSeasonArt(itemId)
    this._write()
    return true
  }

  // WHICH ONES FOUND NOTHING, not just how many (Tim, 2026-08-19: a count you cannot
  // act on is a count). Resolved against the LIBRARY rather than read straight out of
  // the store, so every entry carries the title and the type the fix dialog needs, and
  // a file that has since been deleted or matched by hand drops off the list instead of
  // haunting it. The store keeps only ids and a reason; the library is what knows what
  // an id currently is.
  // AND IT PRUNES AS IT READS. The count on the settings row comes from the store and
  // the list comes from the library, so anything the store still holds that the library
  // has answered for makes the two disagree - "1 came back with nothing" over an empty
  // list (Tim, 2026-08-19, looking at exactly that). Whatever is no longer missing is
  // dropped here, which is the one place that can tell.
  async missedList (adapter, { limit = 500 } = {}) {
    const ids = this.missed
    if (!Object.keys(ids).length) return []
    const out = []
    const alive = new Set()
    for (const type of ['movies', 'series']) {
      for (const it of await listAll(adapter, { type })) {
        const m = ids[it.id]
        if (!m) continue
        // Something else answered for it since - artwork on disk, or a hand-picked
        // match - so it is not missing any more whatever the store still says.
        if (it.artId || this.matched[it.id]) continue
        alive.add(it.id)
        if (out.length >= limit) continue
        out.push({ id: it.id, title: it.title, year: it.year || null, type: it.type, reason: m.error || null })
      }
    }
    let pruned = 0
    for (const id of Object.keys(ids)) {
      // An id the library no longer has at all - a deleted file - goes too.
      if (alive.has(id)) continue
      delete ids[id]
      pruned++
    }
    if (pruned) {
      if (this.state.lastRun) this.state.lastRun.missed = Object.keys(ids).length
      this._write()
      this.log('tmdb:missed-pruned', { pruned, left: Object.keys(ids).length })
    }
    return out
  }

  summary () {
    return {
      running: this.running,
      lastRun: this.state.lastRun || null,
      matched: Object.keys(this.matched).length,
      uncertain: Object.values(this.matched).filter(m => m.uncertain).length,
      pictures: Object.keys(this.art).length,
      missed: Object.keys(this.missed).length
    }
  }
}

module.exports = { TmdbClient, Enricher, bestMatch, normTitle, authFor }
