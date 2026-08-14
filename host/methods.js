// PearCinema's method table for <app>/media/1.
//
// THE METHOD TABLE IS THE APP. That is the line the shared host extraction was
// drawn along: @peerloom/host owns the channel, the readonly chokepoint,
// backpressure, chunking, the typed-error contract and media.stream's grant
// gating. What the methods MEAN is here, and audio methods are not video methods.
//
// Handlers receive the package's `ctx`, which carries only AUTHENTICATED facts -
// `ctx.grant`, `ctx.scope`, `ctx.owner`, `ctx.deviceKey` all come off the
// Noise-proven remote key. There is no deviceKey parameter to forge, and adding
// one would be the whole vulnerability.
//
// Return a value and it is sent as the response body. Return undefined and the
// handler answered for itself. Throw ctx.notFound()/forbidden()/badParams() for a
// typed code the channel survives.

const items = require('./items')
const watch = require('./watch')

// Methods that mutate, refused for a readonly grant at the package's chokepoint
// rather than inside a handler - so a new mutating method cannot ship without a
// scope check.
//
// The two writes a VIEWER may make. Everything else on this table is a read.
//
// They are listed here rather than checked inside a handler so that a new mutating
// method cannot ship without a scope check - a readonly grant is refused at the
// package's chokepoint before a handler runs. Both write only to the caller's OWN
// per-person rows, keyed by an ownerId the host derives from the connection, so a
// readonly device is being denied its own history rather than anybody else's.
const MUTATING = ['resume.set', 'watched.set', 'device.leave']

// `library.list` types the client may ask for, and which of them need a parent.
// Asking for seasons or episodes unscoped is a bad request rather than a
// full-library dump - a show's episodes only mean anything under their season.
function requireScope (ctx, type) {
  if (type === 'seasons' && !ctx.params.seriesId) throw ctx.badParams('seriesId required for seasons')
  if (type === 'episodes' && !ctx.params.seasonId && !ctx.params.seriesId) {
    throw ctx.badParams('seasonId or seriesId required for episodes')
  }
}

// `getAdapter` is a GETTER, not the adapter itself. A connection outlives a source
// change, and a phone that keeps streaming from the source the operator just
// switched away from is a bug nobody would find for weeks.
//
// `getLibraryName` is a getter for the same reason: the operator can rename the
// library mid-connection, and identity.get hands the CURRENT name back so the
// phone relabels on its next read.
// `grants` is the host's grant store, passed in rather than reached for, so two
// hosts in one process (a test, a box serving two libraries) never share one.
// `state` is the per-person store from @peerloom/host. Null in a cut that has none -
// the handlers below then answer empty rather than throwing, so a host built without
// it still serves a library.
function createMethods ({ getAdapter, getLibraryName, grants = null, getSourceError = () => null, state = null, leave = null }) {
  return {
    // --- the library ------------------------------------------------------

    'library.stats': async () => {
      const stats = await getAdapter().stats()
      return {
        ...stats,
        // A film library's two roots, named plainly, so a client does not have to
        // infer "is this a films library or a shows library" - it is usually both.
        source: getAdapter().kind,
        sourceError: getSourceError()
      }
    },

    'library.list': async (ctx) => {
      const type = String(ctx.params.type || 'movies')
      if (!items.LIST_TYPES.has(type)) throw ctx.badParams(`unknown list type: ${type}`)
      requireScope(ctx, type)

      return getAdapter().list({
        type,
        seriesId: ctx.params.seriesId || null,
        seasonId: ctx.params.seasonId || null,
        limit: ctx.params.limit,
        cursor: ctx.params.cursor,
        sort: ctx.params.sort || items.DEFAULT_SORT[type],
        order: ctx.params.order === 'desc' ? 'desc' : 'asc'
      })
    },

    'library.get': async (ctx) => {
      if (!ctx.params.id) throw ctx.badParams('id required')
      const type = ctx.params.type ? String(ctx.params.type) : null
      if (type && !items.ITEM_TYPES.has(type)) throw ctx.badParams(`unknown item type: ${type}`)

      const item = await getAdapter().get({ id: String(ctx.params.id), type })
      if (!item) throw ctx.notFound('no such item')
      return item
    },

    'library.search': async (ctx) => {
      const q = String(ctx.params.q || '').trim()
      // An empty search is an empty result, not an error and not the whole library.
      if (!q) return { items: [] }
      return getAdapter().search({ q, limit: ctx.params.limit })
    },

    // --- artwork ----------------------------------------------------------

    'art.get': async (ctx) => {
      if (!ctx.params.artId) throw ctx.badParams('artId required')
      const stream = await getAdapter().art({
        artId: String(ctx.params.artId),
        size: ctx.params.size
      })
      if (!stream) throw ctx.notFound('no artwork')
      return ctx.stream(stream)
    },

    // --- subtitles --------------------------------------------------------
    //
    // v1 LISTS what it cannot serve rather than pretending. External .srt and
    // embedded TEXT tracks are cheap. Embedded PGS is image-based and burning it in
    // means a full transcode, which v1 does not have - so it is listed with
    // `playable: false` and a reason. Silently hiding it would leave someone
    // hunting for subtitles the file demonstrably contains.

    'subtitle.list': async (ctx) => {
      if (!ctx.params.itemId) throw ctx.badParams('itemId required')
      const adapter = getAdapter()
      if (!adapter.subtitles) return { items: [] }
      return { items: await adapter.subtitles({ itemId: String(ctx.params.itemId) }) }
    },

    'subtitle.get': async (ctx) => {
      if (!ctx.params.itemId || !ctx.params.subtitleId) {
        throw ctx.badParams('itemId and subtitleId required')
      }
      const adapter = getAdapter()
      if (!adapter.subtitle) throw ctx.notFound('no subtitles')
      const stream = await adapter.subtitle({
        itemId: String(ctx.params.itemId),
        subtitleId: String(ctx.params.subtitleId)
      })
      if (!stream) throw ctx.notFound('no such subtitle')
      return ctx.stream(stream)
    },

    // --- where you stopped, and what you have finished --------------------
    //
    // Approved as a T2 in proposals/2026-08-13-watch-state.md. PER PERSON, NOT PER
    // DEVICE: `ctx.owner` is `p:{personId}` for a device assigned to somebody and
    // `d:{deviceKey}` for one that is not, derived by the package from the
    // Noise-authenticated connection. There is no owner parameter to forge, and
    // adding one would be the whole vulnerability.
    //
    // The consequence is the feature: put a phone down, pick a laptop up, same film
    // same place, because both devices belong to the same person and talk to the
    // same host.

    'resume.set': async (ctx) => {
      if (!state) throw ctx.notFound('this host does not keep watch state')
      if (!ctx.params.itemId) throw ctx.badParams('itemId required')
      const itemId = String(ctx.params.itemId)

      // The RUNTIME comes from the library, never from the client. A client that
      // could name its own duration could mark anything watched by claiming a film
      // is one second long.
      const item = await getAdapter().get({ id: itemId })
      if (!item) throw ctx.notFound('no such item')

      const verdict = watch.decide({
        positionMs: ctx.params.positionMs,
        runtimeSeconds: item.runtime,
        ended: !!ctx.params.ended
      })

      // Finishing is BOTH writes: the tick goes on and the position goes away. A
      // finished film sitting at the top of continue-watching wearing a watched
      // badge is the state this avoids, and it falls out of the store's
      // delete-at-zero rule rather than needing a rule of its own.
      if (verdict.finished) await state.setWatched(ctx.owner, itemId, true, { auto: true })

      const row = await state.setResume(ctx.owner, itemId, verdict.positionMs, verdict.durationMs, {
        // WHEN THE DEVICE WATCHED, not when the write landed. The two differ whenever
        // a write came out of an offline outbox, and continue-watching orders by the
        // first - see the donor's note, which cost a proposal to learn.
        playedAt: Number(ctx.params.playedAt) || 0,
        deviceKey: ctx.deviceKey
      })
      return { ok: true, finished: verdict.finished, positionMs: row?.positionMs || 0 }
    },

    'resume.get': async (ctx) => {
      if (!state) return { resume: null }
      if (!ctx.params.itemId) throw ctx.badParams('itemId required')
      return { resume: await state.getResume(ctx.owner, String(ctx.params.itemId)) }
    },

    // The continue-watching row. Rows first, then the items they point at, because a
    // client rendering a shelf needs titles and artwork rather than ids - and a
    // position whose item has since left the library is dropped rather than sent as
    // a card that cannot be opened.
    'resume.list': async (ctx) => {
      if (!state) return { items: [] }
      const rows = await state.listResume(ctx.owner, Number(ctx.params.limit) || 20)
      const adapter = getAdapter()
      const out = []
      for (const r of rows) {
        const item = await adapter.get({ id: r.itemId })
        if (item) out.push({ ...item, resume: { positionMs: r.positionMs, playedAt: r.playedAt } })
      }
      return { items: out }
    },

    'watched.set': async (ctx) => {
      if (!state) throw ctx.notFound('this host does not keep watch state')
      if (!ctx.params.itemId) throw ctx.badParams('itemId required')
      const itemId = String(ctx.params.itemId)
      const on = ctx.params.watched !== false

      // BY HAND, so `auto` is false: a person saying "no, I have not seen this" must
      // not read as the host's own guess, or a later change to where the end is could
      // quietly overrule them.
      await state.setWatched(ctx.owner, itemId, on, { auto: false })

      // Marking something watched clears its position, for the same reason finishing
      // it does. Marking it UNWATCHED does not invent one - it starts over.
      if (on) await state.setResume(ctx.owner, itemId, 0, null)
      return { ok: true, watched: on }
    },

    // Every id this person has finished. A LIST, not a per-item question: a grid asks
    // about two hundred posters at once and two hundred round trips to draw one
    // screen is the kind of thing that only hurts on somebody else's library.
    'watched.list': async (ctx) => {
      if (!state) return { items: [] }
      return { items: [...await state.watchedSet(ctx.owner)] }
    },

    // --- identity ---------------------------------------------------------
    //
    // THE CALLER IS THE CONNECTION. What a device may read here is fixed by the
    // grant the firewall looked up from its Noise-authenticated key, so a device
    // can only ever learn about ITSELF.

    // A device dropping its OWN access: "remove this library" on the phone must end
    // access HERE, with the same teeth as an operator revoke - not leave a live
    // grant behind a stale UI. The deviceKey is the connection's own Noise-proven
    // key, so a device can only ever leave on its own behalf; there is no parameter
    // to forge. Found missing 2026-08-14 by the first real client smoke test, which
    // got "unknown method" where a PearTune phone gets a goodbye - the donor's copy
    // lives in its unmigrated host, which is exactly the drift the extractions
    // exist to end.
    'device.leave': async (ctx) => {
      if (!leave) throw ctx.notFound('this host cannot process a leave')
      // The goodbye goes out BEFORE the grant dies - the donor's exact sequencing.
      // The leave revokes THIS connection, so a reply queued after the kill never
      // arrives and the phone times out on a leave that worked.
      ctx.reply({ ok: true })
      try { await leave(ctx.deviceKey) } catch {}
    },

    'identity.get': async (ctx) => {
      // RE-READ the row rather than answering off `ctx.grant`. That grant was
      // captured once, when the firewall admitted this connection, so answering
      // from it would report the state as of connect time for the whole life of the
      // connection - it could never see an operator renaming, assigning or
      // promoting on the dashboard. The donor shipped that bug and it left a freshly
      // paired phone stuck on "waiting for your server to confirm you".
      const row = (grants ? await grants.get(ctx.deviceKey) : null) || ctx.grant
      const person = row.personId && grants ? await grants.getPerson(row.personId) : null
      const labels = person && grants ? await grants.personLabels() : null

      return {
        deviceName: row.label || null,
        // Disambiguated where two people share a name, so "belongs to Sam" on the
        // phone names the SAME Sam the dashboard's revoke button does.
        belongsTo: person ? (labels?.get(person.id) || person.name) : null,
        // The library's CURRENT name, so a dashboard rename reaches the phone.
        libraryName: getLibraryName(),
        // The device's own guest expiry (null = permanent), so the phone can show a
        // "guest access expires in X" banner. Read from THIS connection's row,
        // never a param - a device only ever learns its OWN access.
        expiresAt: row.expiresAt ?? null,
        // Off the row's CURRENT scope rather than the connect-time grant, so a
        // dashboard promotion reaches an already-connected phone.
        owner: row.scope === 'owner'
      }
    }
  }
}

module.exports = { createMethods, MUTATING }
