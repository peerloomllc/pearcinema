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
const { siblings } = require('./siblings')
const { notifyOwners, confirmedClaim } = require('@peerloom/host')

// The most positions one clear will forget. Far above any real shelf - the
// point is that it is bounded rather than an unbounded scan somebody could
// aim at a host.
const CLEAR_MAX = 5000

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
const MUTATING = ['resume.set', 'watched.set', 'device.leave', 'fav.set', 'request.add', 'request.remove', 'request.resolve', 'identity.set', 'avatar.set', 'device.revoke', 'cast.play', 'cast.stop', 'cast.pause', 'cast.resume', 'cast.seek', 'resume.clear']

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
// `events` is the LOCAL twin of the pushes below. notifyOwners reaches paired
// devices over P2P; the operator's own dashboard is not one of them, and it was
// the surface most likely to be open when an ask arrives.
function createMethods ({ getAdapter, getLibraryName, grants = null, getSourceError = () => null, state = null, leave = null, media = null, avatars = null, revoke = null, seen = null, cast = null, events = () => {} }) {
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

    // THE EPISODE ON EITHER SIDE, for the player's next and previous buttons
    // (Tim, 2026-08-15) and for the card that offers the next one when this one
    // ends. The walk itself lives in `host/siblings.js`, because the dashboard
    // asks the same question over HTTP and one copy of the season-boundary rule
    // is one copy that cannot drift.
    'library.siblings': async (ctx) => {
      if (!ctx.params.id) throw ctx.badParams('id required')
      const out = await siblings(getAdapter(), ctx.params.id)
      if (!out) throw ctx.notFound('no such item')
      return out
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

    // --- the phone's transcode path (approved remux proposal, wire section) ---
    //
    // THE HOST DECIDES from what the client declares; a client cannot ask to be
    // transcoded, only describe itself - the same rule every transport follows.
    'media.decide': async (ctx) => {
      if (!media) throw ctx.notFound('this host cannot decide modes')
      if (!ctx.params.itemId) throw ctx.badParams('itemId required')
      const out = await media.decide({ itemId: String(ctx.params.itemId), capabilities: ctx.params.capabilities || {} })
      if (!out) throw ctx.notFound('no such item')
      return out
    },

    'media.playlist': async (ctx) => {
      if (!media) throw ctx.notFound('this host serves no playlists')
      if (!ctx.params.itemId) throw ctx.badParams('itemId required')
      const out = await media.playlist({ itemId: String(ctx.params.itemId), capabilities: ctx.params.capabilities || {} })
      if (!out) throw ctx.notFound('no such item')
      return out
    },

    // One segment's bytes, streamed. Runs on the SAME engine pool as the
    // browser's transcodes, so its cap answers here as a typed BUSY.
    'media.segment': async (ctx) => {
      if (!media) throw ctx.notFound('this host serves no segments')
      if (!ctx.params.itemId) throw ctx.badParams('itemId required')
      let session
      try {
        session = await media.segment({
          itemId: String(ctx.params.itemId),
          seq: ctx.params.seq,
          capabilities: ctx.params.capabilities || {}
        })
      } catch (e) {
        if (e.code === 'BUSY') { ctx.fail('BUSY', e.message); return }
        throw e
      }
      if (!session) throw ctx.notFound('no such segment')
      if (seen) seen(ctx.deviceKey, String(ctx.params.itemId))
      return ctx.stream(session.stdout)
    },

    // The whole converted film, streamed once for keeps - the download side of
    // data saver. The host still decides: an item the device could take as-is
    // answers `direct: true` and the client downloads the original bytes.
    'media.export': async (ctx) => {
      if (!media || !media.export) throw ctx.notFound('this host cannot convert for download')
      if (!ctx.params.itemId) throw ctx.badParams('itemId required')
      let out
      try {
        out = await media.export({
          itemId: String(ctx.params.itemId),
          capabilities: ctx.params.capabilities || {}
        })
      } catch (e) {
        if (e.code === 'BUSY') { ctx.fail('BUSY', e.message); return }
        throw e
      }
      if (!out) throw ctx.notFound('no such item')
      if (out.direct) return { direct: true }
      if (seen) seen(ctx.deviceKey, String(ctx.params.itemId))
      return ctx.stream(out.stream)
    },

    'subtitle.list': async (ctx) => {
      if (!ctx.params.itemId) throw ctx.badParams('itemId required')
      const adapter = getAdapter()
      if (!adapter.subtitles) return { items: [] }
      const items = await adapter.subtitles({ itemId: String(ctx.params.itemId) })
      // `burnable`: an unplayable IMAGE track this host could press into the
      // picture instead - only embedded tracks (the burn resolver refuses the
      // rest) and only when the engine has proven itself, so a phone never
      // offers a burn the segment path would silently drop.
      return {
        items: items.map(t => ({
          ...t,
          burnable: !!(media?.canBurn && !t.playable && !t.external && media.canBurn(t.codec))
        }))
      }
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
      // THE PERSON'S OTHER DEVICES HEAR IT (the donor's exceptSelf shape): put
      // a phone down mid-film and the tablet's Continue shelf already carries
      // the new minute, no reopen needed. The device that wrote is skipped -
      // it is the one place this is not news.
      ctx.pushToOwner('resume:changed', { itemId, finished: verdict.finished })
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

    // EMPTY THE SHELF, and emptying it means letting the places go (Tim,
    // 2026-08-20). The alternative - hide the shelf, keep the positions - reads
    // as two different answers to one question: a shelf somebody has cleared
    // that still makes every film offer to resume.
    //
    // Per PERSON, off the authenticated connection, so a device cannot empty
    // anybody's shelf but its owner's. The zero write IS the delete, the same
    // rule a single row follows, so there is no second deletion path to keep
    // honest.
    'resume.clear': async (ctx) => {
      if (!state) throw ctx.notFound('this host does not keep watch state')
      const rows = await state.listResume(ctx.owner, CLEAR_MAX)
      for (const r of rows) await state.setResume(ctx.owner, r.itemId, 0, null)
      // The person's OTHER devices hear it, same as a single position does -
      // clearing on a phone must not leave the tablet's shelf full.
      ctx.pushToOwner('resume:cleared', { cleared: rows.length })
      return { ok: true, cleared: rows.length }
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
      ctx.pushToOwner('watched:changed', { itemId, watched: on })
      return { ok: true, watched: on }
    },

    // Every id this person has finished. A LIST, not a per-item question: a grid asks
    // about two hundred posters at once and two hundred round trips to draw one
    // screen is the kind of thing that only hurts on somebody else's library.
    'watched.list': async (ctx) => {
      if (!state) return { items: [] }
      return { items: [...await state.watchedSet(ctx.owner)] }
    },

    // --- the watchlist ----------------------------------------------------
    //
    // Rides the inherited favourites store with the video kind vocabulary.
    // Per PERSON via ctx.owner, same as watch state - a watchlist is the same
    // claim: your phone and the dashboard agree on what you saved.

    'fav.set': async (ctx) => {
      if (!state) throw ctx.notFound('no user state on this host')
      const { kind, id, on } = ctx.params
      if (!['movie', 'episode', 'series', 'season'].includes(kind)) throw ctx.badParams('bad kind')
      if (!id) throw ctx.badParams('id required')
      await state.setFav(ctx.owner, String(kind), String(id), !!on)
      // The donor's favorites:changed, with its exceptSelf: your other phones'
      // watchlists follow this one's bookmark, and the phone that tapped it
      // already re-rendered optimistically.
      ctx.pushToOwner('favorites:changed', { kind: String(kind), id: String(id), on: !!on })
      return { ok: true, on: !!on }
    },

    // Resolved to ITEMS, not ids - the same rule resume.list follows: a client
    // rendering a shelf needs titles and artwork, and a saved id whose item has
    // left the library is dropped rather than sent as a card that cannot open.
    'fav.list': async (ctx) => {
      if (!state) return { items: [] }
      const byKind = await state.listFavs(ctx.owner)
      const adapter = getAdapter()
      const out = []
      for (const [kind, ids] of Object.entries(byKind)) {
        for (const id of ids) {
          const item = await adapter.get({ id })
          if (item) out.push({ ...item, kind })
        }
      }
      return { items: out }
    },

    // --- asking for what is not there --------------------------------------

    'request.add': async (ctx) => {
      if (!state) throw ctx.notFound('no user state on this host')
      const { kind, name } = ctx.params
      if (!['movie', 'series'].includes(kind)) throw ctx.badParams('bad kind')
      const request = await state.addRequest(ctx.owner, { kind, name })
      // An operator watching Manage should see the ask arrive, not find it on
      // the next load. A second person asking the same thing folds into the one
      // row and bumps its count, which is still news - push either way.
      const created = { id: request.id, name: request.name || null, kind: request.kind, count: request.count || 1 }
      // Awaited, not fired and forgotten: it reads the grant store to find the
      // owners, and the ask is not really filed until they have been told. The
      // catch keeps a push failure from failing the ask itself.
      await notifyOwners(ctx.presence, grants, 'request:created', created).catch(() => {})
      events('request:created', created)
      return { request }
    },

    'request.list': async (ctx) => {
      if (!state) return { items: [] }
      return { items: await state.listRequests({ requester: ctx.owner }) }
    },

    'request.remove': async (ctx) => {
      if (!state) throw ctx.notFound('no user state on this host')
      const row = await state.getRequest(String(ctx.params.id || ''))
      // Only your own ask - the id is not a capability.
      if (!row || row.requester !== ctx.owner) throw ctx.notFound('no such request')
      await state.deleteRequest(row.id)
      // The other half of the same rule: an ask that leaves should leave the
      // operator's screen too, or they act on something already withdrawn.
      await notifyOwners(ctx.presence, grants, 'request:removed', { id: row.id }).catch(() => {})
      events('request:removed', { id: row.id })
      return { ok: true }
    },

    // --- the owner's view (scope-gated, never parameter-gated) --------------

    'request.all': async (ctx) => {
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!state) return { items: [] }
      return { items: await state.listRequests() }
    },

    'request.resolve': async (ctx) => {
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!state) throw ctx.notFound('no user state on this host')
      const { id, status } = ctx.params
      if (!['added', 'declined'].includes(status)) throw ctx.badParams('bad status')
      const row = await state.resolveRequest(String(id || ''), status)
      if (!row) throw ctx.notFound('no such request')
      // The donor's request:resolved: whoever asked hears the answer wherever
      // they are signed in - the resolver did not make the request, so nobody
      // is skipped.
      if (ctx.presence && row.requester) {
        ctx.presence.notifyOwner(row.requester, 'request:resolved', { id: row.id, title: row.title || null, status })
      }
      events('request:resolved', { id: row.id, title: row.title || null, status })
      return { request: row }
    },

    // --- casting to a television (video-deltas proposal §5) ----------------
    //
    // OWNER only, the donor's phase 1 rule kept with its reasoning: a guest
    // streaming to their own phone is one thing, a guest starting the
    // living-room TV in somebody else's house is another. The scope is also
    // re-checked on every video fetch in host/cast.js, long after this
    // connection's grant was captured.
    //
    // An unconfigured host answers `enabled: false` rather than an error, so
    // the phone can hide the button without treating a normal state as a
    // failure.

    'cast.list': async (ctx) => {
      const casts = cast ? cast() : null
      if (!casts) throw ctx.notFound('casting unavailable')
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!casts.speakers.enabled) return { enabled: false, targets: [] }
      let targets
      try {
        targets = await casts.speakers.list()
      } catch (e) {
        // HA down is a state, not a crash: the phone shows "not reachable"
        // instead of a stack.
        return { enabled: true, targets: [], problem: e.message }
      }
      return {
        enabled: true,
        // `unavailable` means HA cannot reach the device, so offering it is
        // offering a button that does nothing. `hidden` is the operator's own
        // pruning, done in the dashboard's Casting panel - a house has far more
        // media players than televisions, and the picker is for the ones a film
        // can actually appear on.
        targets: targets.filter(t => t.state !== 'unavailable' && !t.hidden),
        active: casts.active(ctx.deviceKey)
      }
    },

    'cast.play': async (ctx) => {
      const casts = cast ? cast() : null
      if (!casts) throw ctx.notFound('casting unavailable')
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!ctx.params.entityId || !ctx.params.itemId) throw ctx.badParams('entityId and itemId required')
      // deviceKey comes from the Noise-authenticated grant, never from params -
      // a device can only ever cast as itself, which is what makes revoke able
      // to find it.
      return casts.play({
        deviceKey: ctx.deviceKey,
        itemId: String(ctx.params.itemId),
        entityId: String(ctx.params.entityId),
        at: Math.max(0, Number(ctx.params.at) || 0)
      })
    },

    'cast.stop': async (ctx) => {
      const casts = cast ? cast() : null
      if (!casts) throw ctx.notFound('casting unavailable')
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!ctx.params.entityId) throw ctx.badParams('entityId required')
      return casts.stop(ctx.deviceKey, String(ctx.params.entityId))
    },

    // Pause and resume the TELEVISION - without these the phone's own controls
    // would drive the phone and put a second copy of the film in the room, the
    // donor's exact bug.
    'cast.pause': async (ctx) => {
      const casts = cast ? cast() : null
      if (!casts) throw ctx.notFound('casting unavailable')
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!ctx.params.entityId) throw ctx.badParams('entityId required')
      await casts.speakers.pause(String(ctx.params.entityId))
      return { ok: true }
    },

    'cast.resume': async (ctx) => {
      const casts = cast ? cast() : null
      if (!casts) throw ctx.notFound('casting unavailable')
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!ctx.params.entityId) throw ctx.badParams('entityId required')
      await casts.speakers.resume(String(ctx.params.entityId))
      return { ok: true }
    },

    // Skip about while a television is playing. The DEVICE is the connection's
    // own, never a parameter, for the same reason cast.play's is: a phone can
    // only ever drive the cast it started.
    'cast.seek': async (ctx) => {
      const casts = cast ? cast() : null
      if (!casts) throw ctx.notFound('casting unavailable')
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!ctx.params.entityId) throw ctx.badParams('entityId required')
      const deltaMs = Number(ctx.params.deltaMs)
      if (!Number.isFinite(deltaMs) || deltaMs === 0) throw ctx.badParams('deltaMs required')
      return await casts.seek({
        deviceKey: ctx.deviceKey, entityId: String(ctx.params.entityId), deltaMs
      })
    },

    // Read-only, so not in MUTATING - but still owner-gated, because what a
    // television is doing is information about somebody's house.
    'cast.state': async (ctx) => {
      const casts = cast ? cast() : null
      if (!casts) throw ctx.notFound('casting unavailable')
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!ctx.params.entityId) throw ctx.badParams('entityId required')
      const entityId = String(ctx.params.entityId)
      // The corrected view first, when this device has a cast running there -
      // a television's own clock is wrong about a generated stream, and the
      // remote showing the wrong minute is worse than showing none.
      const mine = await casts.where({ deviceKey: ctx.deviceKey, entityId })
      if (mine) return mine
      return await casts.speakers.getState(entityId) || { state: 'unknown' }
    },

    'device.list': async (ctx) => {
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!grants) return { items: [] }
      const rows = await grants.list()
      const labels = await grants.personLabels().catch(() => null)
      return {
        items: rows.map((r) => ({
          deviceKey: r.deviceKey,
          label: r.label || null,
          platform: r.platform || null,
          belongsTo: r.personId ? (labels?.get(r.personId) || null) : null,
          grantedAt: r.grantedAt || null,
          expiresAt: r.expiresAt ?? null,
          self: r.deviceKey === ctx.deviceKey
        }))
      }
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

    // A device claiming who it belongs to and what it calls itself. The claim
    // GRANTS NOTHING - the package's setClaim leaves personId untouched, and
    // only the dashboard's confirm flow can move a device to a person. The
    // deviceKey is the connection's own Noise-proven key; nothing to forge.
    // An owner cutting another device off, from the phone - the same teeth as
    // the dashboard's revoke, because it IS the dashboard's revoke. Owner scope
    // comes off the connection's grant, never a parameter; a device cannot
    // revoke ITSELF this way (that is what device.leave is for, and the reply
    // sequencing there exists precisely because the connection dies).
    'device.revoke': async (ctx) => {
      if (!ctx.isOwner) throw ctx.forbidden('owner only')
      if (!revoke) throw ctx.notFound('this host cannot revoke over the wire')
      const target = String(ctx.params.deviceKey || '')
      if (!target) throw ctx.badParams('deviceKey required')
      if (target === ctx.deviceKey) throw ctx.badParams('use device.leave for this device')
      const out = await revoke(target)
      return { ok: true, killed: out?.killed ?? 0 }
    },

    'identity.set': async (ctx) => {
      if (!grants?.setClaim) throw ctx.notFound('this host cannot record claims yet')
      const { userName, deviceName } = ctx.params
      const row = await grants.setClaim(ctx.deviceKey, {
        claimedUser: userName !== undefined ? String(userName || '') : undefined,
        label: deviceName !== undefined ? String(deviceName || '') : undefined
      })
      if (!row) throw ctx.notFound('no live grant for this device')
      return { ok: true, claimedUser: row.claimedUser, deviceName: row.label }
    },

    // This device's own photo, stored host-side so the dashboard can show it
    // and a re-install gets it back. ~25 KB compressed by the phone; capped
    // hard here because a "photo" is client input like any other.
    'avatar.set': async (ctx) => {
      if (!avatars) throw ctx.notFound('this host does not keep photos')
      const b64 = ctx.params.avatar ? String(ctx.params.avatar) : null
      if (b64 && b64.length > 120_000) throw ctx.badParams('photo too large')
      avatars.set(ctx.deviceKey, b64)
      return { ok: true }
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
        // What this device CLAIMED, and whether the operator has confirmed it
        // (a claim with a person assigned reads as confirmed; the phone words
        // the in-between honestly). The photo comes back so a re-install shows
        // your face again.
        userName: row.claimedUser || null,
        // Confirmed means the operator confirmed THIS CLAIM, not merely that the
        // device is assigned to somebody: a device already filed under Me that
        // claims to be Timothy is PENDING, and saying "confirmed" there told the
        // person the exact opposite of the truth (caught live on the TCL).
        //
        // It used to be worked out here by comparing the person's name with the
        // claim, which is what forced a dashboard rename to overwrite the name on
        // somebody's own phone. The package records the answer now and every
        // surface reads the same one (Tim, 2026-08-20).
        confirmed: confirmedClaim(row, person),
        avatar: avatars ? avatars.get(ctx.deviceKey) : null,
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
