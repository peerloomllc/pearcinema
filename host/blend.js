// The blend: the phone's merged index, in the host process (approved proposal
// 2026-08-17-desktop-merged-libraries, phase 1).
//
// One RAM index over one catalog per library - the LOCAL adapter's plus each
// connected remote's - built by the same src/merge.js the worklet rides, so
// the desktop and the phone cannot disagree about what a blend is. The local
// library is just another member with a real libraryId; its one privilege
// lives in pickCopy, where the disk always beats the wire.
//
// Nothing is persisted: the host process is long-lived and a dashboard reload
// re-asks it, which is the difference from the phone (whose worklet dies with
// the app and earned its cache dir).

const merge = require('../src/merge')

// A remote's whole catalog fetch is bounded like the phone bounds it: a
// zombie host black-holes rather than refuses, and one hung member must not
// hang the build.
const CATALOG_TIMEOUT_MS = 30000

// How stale a served index may be before an access queues a background
// rebuild. Catalogs move on scans and pairs, both of which trigger builds
// directly - this is the belt for anything that slips the braces.
const STALE_MS = 5 * 60 * 1000

function raced (p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('catalog fetch timed out')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

class Blend {
  constructor ({ getAdapter, getLibraryId, remote, log = () => {} }) {
    this.getAdapter = getAdapter
    this.getLibraryId = getLibraryId
    this.remote = remote
    this.log = log

    this.index = null
    this.owners = new Map() // any real id -> owning libraryId
    this.artOwners = new Map() // artId -> owning libraryId
    this.contributed = new Set() // libraryIds in the current index
    this.builtAt = 0
    this.flight = null
    this.timer = null
  }

  // The blend exists when TWO OR MORE libraries contributed anything - the
  // empty local library of a client-only desktop does not count as one.
  available () {
    return this.contributed.size >= 2
  }

  localLibraryId () {
    return String(this.getLibraryId() || '')
  }

  // --- building ------------------------------------------------------------

  async _drainLocal () {
    const adapter = this.getAdapter()
    const drain = async (params) => {
      const out = []
      let cursor = 0
      for (;;) {
        const page = await adapter.list({ ...params, limit: 500, cursor })
        out.push(...(page.items || []))
        if (!page.cursor || !(page.items || []).length) break
        cursor = page.cursor
      }
      return out
    }
    const movies = await drain({ type: 'movies' })
    const series = await drain({ type: 'series' })
    const episodes = []
    for (const s of series) {
      episodes.push(...await drain({ type: 'episodes', seriesId: s.id }))
    }
    return { libraryId: this.localLibraryId(), movies, series, episodes }
  }

  async _drainRemote (libraryId) {
    const drain = async (params) => {
      const out = []
      let cursor = 0
      for (;;) {
        const page = await this.remote.call(libraryId, 'library.list', { ...params, limit: 500, cursor })
        out.push(...(page.items || []))
        if (!page.cursor || !(page.items || []).length) break
        cursor = page.cursor
      }
      return out
    }
    const movies = await drain({ type: 'movies' })
    const series = await drain({ type: 'series' })
    const episodes = []
    for (const s of series) {
      episodes.push(...await drain({ type: 'episodes', seriesId: s.id }))
    }
    return { libraryId, movies, series, episodes }
  }

  _adopt (catalogs) {
    this.index = merge.buildIndex(catalogs)
    this.owners = new Map()
    this.artOwners = new Map()
    this.contributed = new Set()
    for (const c of catalogs) {
      this.contributed.add(c.libraryId)
      for (const list of [c.movies, c.series, c.episodes]) {
        for (const x of list || []) {
          this.owners.set(String(x.id), c.libraryId)
          if (x.artId) this.artOwners.set(String(x.artId), c.libraryId)
          if (x.seasonId) this.owners.set(String(x.seasonId), c.libraryId)
          if (x.seriesId) this.owners.set(String(x.seriesId), c.libraryId)
        }
      }
    }
    this.builtAt = Date.now()
  }

  async build (reason) {
    if (this.flight) return this.flight
    this.flight = (async () => {
      const cats = []
      // The local member: absent when empty, a member like any other when not.
      try {
        const local = await this._drainLocal()
        if (local.movies.length || local.series.length) cats.push(local)
      } catch (e) {
        this.log('blend:local-absent', { err: e.message })
      }
      await Promise.all(this.remote.state.hosts.map(async (h) => {
        try {
          cats.push(await raced(this._drainRemote(h.libraryId), CATALOG_TIMEOUT_MS))
        } catch (e) {
          // Offline is absence, not failure - the phone's rule.
          this.log('blend:host-absent', { library: h.libraryName, err: e.message })
        }
      }))
      this._adopt(cats)
      this.log('blend:built', {
        reason,
        libraries: cats.length,
        movies: this.index.movies.length,
        series: this.index.series.length,
        episodes: this.index.episodes.length
      })
    })().finally(() => { this.flight = null })
    return this.flight
  }

  buildSoon (reason) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.build(reason).catch((e) => this.log('blend:build-failed', { err: e.message }))
    }, 800)
    this.timer.unref?.()
  }

  // Every read passes here: first access builds, stale access serves what it
  // has and queues a refresh behind it.
  async ready () {
    if (!this.index) await this.build('first-access')
    else if (Date.now() - this.builtAt > STALE_MS && !this.flight) this.buildSoon('stale')
    return this.index
  }

  // --- reads, the worklet's shapes -----------------------------------------

  list ({ type = 'movies', seriesId = null, seasonId = null, sort, order, limit, cursor } = {}) {
    if (!this.index) return { items: [], cursor: null }
    if (type === 'movies' || type === 'series') {
      const src = type === 'movies' ? this.index.movies : this.index.series
      const sorted = merge.sortItems(src, sort || 'title', order || 'asc')
      const start = Math.max(0, Math.floor(Number(cursor) || 0))
      const size = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)))
      const items = sorted.slice(start, start + size)
      return { items, cursor: start + size < sorted.length ? start + size : null, total: sorted.length }
    }
    if (type === 'seasons') {
      const s = this.seriesFor(seriesId)
      if (s) return { items: merge.seasonsFor(this.index, s.key), cursor: null }
      return null // caller falls through to the owner
    }
    if (type === 'episodes') {
      const parsed = merge.parseMergedSeasonId(seasonId)
      if (parsed) {
        return { items: merge.episodesFor(this.index, parsed.seriesKey, parsed.seasonNumber, parsed.seasonTitle), cursor: null }
      }
      return null
    }
    return { items: [], cursor: null }
  }

  search (q, limit = 60) {
    if (!this.index) return { items: [] }
    const r = merge.searchIndex(this.index, q, Number(limit) || 60)
    return { items: [...r.movies, ...r.series, ...r.episodes].slice(0, Number(limit) || 60) }
  }

  seriesFor (seriesId) {
    if (!this.index) return null
    const id = String(seriesId || '')
    return this.index.series.find((s) => s.copies.some((c) => c.id === id)) || null
  }

  // The episode on either side, answered from the blend's own interleaved run
  // rather than by asking one library - the phone's rule, for the same reason:
  // a series can SPAN hosts, so the season-boundary neighbour may live on the
  // other one. Null when this is not a merged episode at all, which is the
  // caller's signal to fall through to whichever library owns the id.
  siblings (itemId) {
    if (!this.index) return null
    const id = String(itemId || '')
    const ep = this.index.episodes.find((e) => e.copies.some((c) => c.id === id))
    if (!ep) return null
    const run = merge.seriesRun(this.index, ep.seriesKey)
    const at = run.findIndex((e) => e.key === ep.key)
    if (at < 0) return { prev: null, next: null }
    return { prev: run[at - 1] || null, next: run[at + 1] || null }
  }

  entityFor (id) {
    if (!this.index) return null
    const key = String(id || '')
    return this.index.movies.find((m) => m.copies.some((c) => c.id === key)) ||
      this.index.episodes.find((e) => e.copies.some((c) => c.id === key)) || null
  }

  // Any real id, translated to the id the blend SHOWS for it - the primary
  // copy's. What makes a watched mark stored under one library's id light the
  // tick on the merged row.
  primaryIdFor (id) {
    const e = this.entityFor(id) || this.seriesFor(id)
    return e ? String(e.id) : String(id)
  }

  ownerOf (id) {
    return this.owners.get(String(id)) || null
  }

  artOwnerOf (artId) {
    return this.artOwners.get(String(artId)) || null
  }

  // Every library holding a copy, each with its own id - the write fan's
  // address book, phase 2's whole shopping list.
  copyRefs (id) {
    const key = String(id || '')
    const e = this.entityFor(key) ||
      (this.index ? this.index.series.find((s) => s.copies.some((c) => c.id === key)) : null)
    if (!e) {
      const lib = this.ownerOf(key)
      return lib ? [{ libraryId: lib, id: key }] : []
    }
    return e.copies.map((c) => ({ libraryId: c.libraryId, id: c.id }))
  }

  // THE PICK, with the desktop's one new rule first: LOCAL WINS - a copy on
  // this disk plays from this disk, no wire, no friend's engine, real seek.
  // Among remote copies, a copy this BROWSER direct-plays outranks one that
  // would cost a conversion, then primary order (the phone's rank, different
  // facts). Returns { libraryId, id, local } or null.
  pickCopy (itemId, caps = null) {
    const id = String(itemId || '')
    const entity = this.entityFor(id)
    const localId = this.localLibraryId()
    if (!entity) {
      const lib = this.ownerOf(id)
      return lib ? { libraryId: lib, id, local: lib === localId } : null
    }
    const local = entity.copies.find((c) => c.libraryId === localId)
    if (local) return { libraryId: local.libraryId, id: local.id, local: true }
    const rank = caps
      ? (copy) => ((caps.videoCodecs || []).includes(String(copy.videoCodec || '').toLowerCase()) ? 1 : 0)
      : null
    // Every paired library counts as reachable for the RANKING - actual
    // reachability resolves at call time, where the twin revives the
    // connection or answers honestly that it cannot.
    const paired = new Set(this.remote.state.hosts.map((h) => h.libraryId))
    const pick = merge.bestCopy(entity, paired, null, rank) || entity.copies[0]
    return pick ? { libraryId: pick.libraryId, id: pick.id, local: false } : null
  }
}

module.exports = { Blend }
