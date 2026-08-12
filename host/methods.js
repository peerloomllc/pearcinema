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

// Methods that mutate, refused for a readonly grant at the package's chokepoint
// rather than inside a handler - so a new mutating method cannot ship without a
// scope check.
//
// EMPTY IN THIS CUT, and that is a fact about scope rather than an oversight:
// first pair serves a read-only library. `resume.set` is the first entry it gains,
// and resume is inherited wholesale from the donor rather than written here (it
// already IS continue-watching), so it arrives with the state store in phase 3.
const MUTATING = []

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
function createMethods ({ getAdapter, getLibraryName, grants = null, getSourceError = () => null }) {
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

    // --- identity ---------------------------------------------------------
    //
    // THE CALLER IS THE CONNECTION. What a device may read here is fixed by the
    // grant the firewall looked up from its Noise-authenticated key, so a device
    // can only ever learn about ITSELF.

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
