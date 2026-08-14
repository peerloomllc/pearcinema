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
//   - THE CACHE LIVES IN THE DATA DIR, never in the library. The library is mounted
//     `:ro` by design; sidecar-writing would be a separate, explicit action and is
//     deliberately not built here.
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
const IMAGES = 'https://image.tmdb.org/t/p/w500'

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

  async poster (posterPath) {
    const res = await this.fetch(IMAGES + posterPath, { headers: authFor(this.key).headers })
    if (!res.ok) throw new Error(`TMDB image answered ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
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

  _posterFile (itemId) { return path.join(this.postersDir, itemId + '.jpg') }

  // SIDECAR ALWAYS WINS, expressed as: an item that has artwork is returned as it
  // came. Only a gap is filled, and with a copy rather than a mutation, because
  // adapters cache their item objects and a decorated cache would survive the
  // feature being turned off.
  decorate (item) {
    if (!item || item.artId || !this.matched[item.id]?.poster) return item
    return { ...item, artId: 'tmdb:' + item.id }
  }

  // Bytes for a tmdb: art id, same contract as adapter.art.
  art (artId) {
    const itemId = String(artId || '').replace(/^tmdb:/, '')
    if (!this.matched[itemId]?.poster) return null
    const file = this._posterFile(itemId)
    if (!fs.existsSync(file)) return null
    const stream = fs.createReadStream(file)
    stream.contentType = 'image/jpeg'
    return stream
  }

  async _apply (client, item, candidate, how, { uncertain = false } = {}) {
    const bytes = candidate.poster ? await client.poster(candidate.poster) : null
    if (bytes) {
      await fsp.mkdir(this.postersDir, { recursive: true })
      await fsp.writeFile(this._posterFile(item.id), bytes)
    }
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
      let cursor = null
      do {
        const page = await adapter.list({ type, limit: 500, cursor })
        for (const it of page.items || []) {
          if (it.artId) continue
          if (this.matched[it.id]) continue
          if (this.missed[it.id] && !retryMissed) continue
          work.push(it)
        }
        cursor = page.cursor
      } while (cursor)
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
    } finally {
      this.state.lastRun = {
        at: Date.now(),
        looked: work.length,
        matched: Object.keys(this.matched).length,
        uncertain: Object.values(this.matched).filter(m => m.uncertain).length,
        missed: Object.keys(this.missed).length
      }
      this._write()
      this.running = null
    }

    this.log('tmdb:done', this.state.lastRun)
    return this.state.lastRun
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
  // a person chose it.
  async fix ({ itemId, tmdbId, type, key }) {
    const client = new TmdbClient({ key, fetch: this.fetch })
    const candidate = await client.details({ type, tmdbId })
    if (!candidate?.tmdbId) return null
    await this._apply(client, { id: itemId }, candidate, 'fixed')
    this._write()
    return this.matched[itemId]
  }

  // "This is not any of them" - drop the fetched artwork and stop guessing at this
  // item. Recorded in missed so the next automatic pass leaves it alone; "Look
  // again" retries it deliberately.
  async unmatch (itemId) {
    const had = this.matched[itemId]
    if (!had) return false
    delete this.matched[itemId]
    this.missed[itemId] = { title: had.title, unmatched: true, at: Date.now() }
    await fsp.rm(this._posterFile(itemId), { force: true })
    this._write()
    return true
  }

  summary () {
    return {
      running: this.running,
      lastRun: this.state.lastRun || null,
      matched: Object.keys(this.matched).length,
      uncertain: Object.values(this.matched).filter(m => m.uncertain).length,
      missed: Object.keys(this.missed).length
    }
  }
}

module.exports = { TmdbClient, Enricher, bestMatch, normTitle, authFor }
