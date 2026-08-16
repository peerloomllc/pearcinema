# Merged libraries - all your servers as one collection

**Status**: APPROVED 2026-08-16 (Tim, via PR #61). Both open questions answered YES
the same day: watchlist/favorite writes route to the owning host in phase 1, and the
Continue shelves concatenate in phase 1.

**Goal**: Connect to every paired host at once and present one blended,
deduplicated library across them. Browse films and shows as if the Umbrel's 240
films and the Mac Mini's sample were a single collection; search hits everything;
tapping play streams from whichever host actually holds the file. PearTune walked
this exact road (proposal 2026-07-19, shipped) and this adapts its design rather
than re-deriving it.

**Tier**: **T3.** It replaces the phone's single-active-connection model with N
concurrent host connections and adds per-item host routing to streaming. It does
NOT touch the wire protocol, the grant store (still host-local, per host) or the
revoke guarantee - each host keeps authorizing this device independently and a
revoke still kills that host's connection and only that host's films. The blast
radius is playback correctness across many connections, which is what earns the
proposal and the phasing.

**Depends on**: PR #59 (the Mac desktop host - the second real library) and
PR #60 (switch drops the old catalog; renames propagate). The two-host test bed
- TCL against Umbrel plus Mac Mini - is live as of 2026-08-16.

---

## What we already have (the foundation)

- **A host list with an active pointer** (`@peerloom/client/hosts`), per-host
  add/remove/switch, aliases and `libraryLabels` for disambiguation.
- **IDs namespaced by library.** `itemId` and `artId` never collide across
  hosts, so a mixed-host list is representable and the art cache is already
  host-agnostic.
- **One warm shared HyperDHT node.** N concurrent client connections come off
  it with no extra bootstrap cost.
- **Server-authority watch state** (DECISIONS 2026-08-15): resume and watched
  live on each host and the phone trusts the server. Merging them is a union
  of authoritative per-host answers, not a sync problem.
- **The capability seam** (`capsFor`): the client states facts, the host
  decides. Nothing about it assumes one host - it just needs to be computed
  against the host that will serve the stream.

## The two hard problems, inherited answers

**1. A globally-sorted, paginated merge across hosts is not expressible on the
wire.** Each host paginates with its own cursor. PearTune's answer transfers
whole: an **in-memory merged index**. Personal video libraries are hundreds of
films and a few thousand episodes, far smaller than PearTune's track counts. On
entering the merged view, fetch each connected host's full catalog once, build
one merged deduped index in the worklet and serve every browse/search/sort from
memory. Persisted to a `_merged` cache dir so a cold launch renders instantly
and refreshes in the background.

**2. You cannot recover an item's host from its id.** So the owning `libraryId`
must be **carried alongside every item** - through the index, the UI rows, the
player and back into the stream URL. Mechanical but wide, and nothing routes
correctly without it.

## Design (phase 1)

### 1. Connect to all hosts - the client singleton becomes a map

`client`/`connecting` in `src/bare.js` become
`hostConns: Map<libraryId, { client, connecting }>`.

- `connected(libraryId)` reconnects one host (single-flight per entry), used by
  streaming a specific item and by per-host writes.
- `connectAll()` connects every paired host in parallel before an index build.
  An offline host is not an error - it is absent from the merge, its items
  greyed until it returns.

### 2. The merged index

Built by `connectAll()` then a full-catalog fetch per host:

```
mergedIndex = {
  movies:   [{ key, title, year, durationMs,
               copies: [{ libraryId, itemId, artId, size, video, audio }] }],
  series:   [{ key, name, copies: [{ libraryId, seriesId, artId }] }],
  episodes: [{ key, seriesKey, season, episode, title,
               copies: [{ libraryId, itemId, artId }] }]
}
```

Rebuilt on launch, on entering merged mode and on a host reconnect or rescan.
Pagination is a slice of a sorted array; sort by any field.

### 3. Dedup keys, video edition

- **movie key** = `norm(title) | year`
- **series key** = `norm(name)`
- **episode key** = `seriesKey | season | episode`

`norm` lowercases, trims and strips punctuation and leading articles - the same
normalization the folder adapter's name cleanup already applies. Copies keep
their per-host probe facts (`video`, `audio`), because the play-time pick wants
them (§5).

**Accepted lossiness, stated plainly:** a remake sharing title and year with
the original, or an extended cut, can collapse into one entry; a retitled rip
can show twice. Nothing is silently wrong - a merged entry with several copies
shows an "on 2 servers" affordance in the details sheet so the dedup is
inspectable. Same deal Tim accepted for PearTune.

**A wrinkle PearTune never had:** a series can SPAN hosts - season 1 on the
Umbrel, season 2 on the Mac. The merged series view interleaves them by season
and episode number, which is exactly what the episode key produces. Phase 1
keeps next/previous episode within the merged, interleaved order; the hop
between hosts at a season boundary is just a normal routed play.

### 4. Per-item `libraryId`, threaded everywhere

Every item handed to the UI gains its owning host tag (a merged entry carries
`copies`; a filtered view carries one `libraryId`). Threads adapter response →
worklet mappers → UI rows → the player args → back into the stream URL.

### 5. Streaming routing - the shim picks the right host, and the right COPY

Loopback URLs gain the library: `/s/<libraryId>/<itemId>` and
`/art/<libraryId>/<artId>`. On a cache hit the shim serves host-agnostically
(ids are already namespaced; downloads keep playing offline). On a miss it
routes to `hostConns.get(libraryId)`, connecting first if needed.

Copy selection is PearCinema-specific and better than "first host wins": pick
the **best connected copy for THIS device**. If the Umbrel holds an HEVC rip
and the Mac holds an H264 of the same film, and this chip refuses HEVC (the
lying-chip net's own vocabulary), prefer the copy that direct-plays over the
one that needs a transcode. Tie-break order: direct-plays here > transcodes on
a host with hardware > anything else, then first-added. `capsFor` is computed
against the CHOSEN host - the capability seam needs no change, only the right
target.

### 6. UI - merged by default, source as a filter

The library home renders the merged index. A filter row - All, then one chip
per host (using the existing `libraryLabels` disambiguation) - narrows to one
host, which is just the index filtered by `libraryId`, so today's per-host view
survives as a filter. Settings › Libraries keeps add/remove/pair; "which is
active" becomes "which filter" and All is the default.

## Phasing

- **Phase 1 (this proposal): read-only merged browse + search + play.** The
  index, N connections, per-item threading, routed streaming with the
  device-aware copy pick and the merged-default UI. Resume writes go to the
  item's owning host (that part is free once §4 exists); the aggregate shelves
  stay per-filter.
- **Phase 2: merged shelves.** Continue, watchlist, favorites and watched as
  unions across hosts; presence pushes already arrive per connection, so the
  live updates compose. Requests route to the owning host.
- **Phase 3: downloads and casting in merged mode.** Download picks a copy the
  way play does and remembers which host it came from; cast routing follows
  the same copy pick. Each is small once §4 and §5 exist, but neither blocks
  watching.

## Security review

- **Grant store stays host-local, per host.** Untouched, no host code changes
  in phase 1 at all.
- **Revoke is unchanged, per-host and instant.** Revoking this device on the
  Umbrel kills the Umbrel connection within a second; its films grey out and
  the Mac's keep playing. The acceptance test becomes per-host: revoke on A
  cuts all NEW access to A within a second while B keeps working.
- **N connections, one identity.** The same device key presented to N hosts,
  all of them Tim's or explicitly paired. No new exposure class.
- **Offline host = absent, not failed-open.** An unreachable host contributes
  nothing; nothing is ever served from the wrong host (cache is
  content-addressed, live path routes by `libraryId`).

## Verify

- **Unit:** dedup keying, table-driven (same film both hosts, remake near-miss,
  punctuation and article variants, the spanning series); index build + sort +
  filter over fixture catalogs from two hosts; copy selection (direct-play
  preferred, primary offline falls to the other copy, refused-video chip
  steers away from HEVC).
- **Hardware (TCL + Umbrel + Mac Mini):** merged home shows both libraries
  blended and deduped (Josee, Moon and Arrival live on both - the sample was
  copied FROM the Elements drive, so the dedup has real duplicates to chew
  on); search hits both; play routes to the right host per item; kill the Mac
  app mid-browse and its items grey while the Umbrel's keep playing; revoke
  the device on one host and only that host's films die.

## Open questions

1. **Watchlist and favorites writes in phase 1** - route to the owning host
   immediately (cheap, since §4 tags every row) or hold all user-state until
   phase 2? Recommendation: route them in phase 1; only the AGGREGATE views
   wait.
2. **The `_merged` continue shelf in phase 1** - the per-host Continue rows
   could simply be concatenated (newest first) without waiting for phase 2.
   Recommendation: yes, concatenate; it is a read-only union of
   server-authoritative answers.
