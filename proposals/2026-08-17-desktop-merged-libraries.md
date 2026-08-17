# Desktop merged libraries - the phone's blend, in the dashboard

**Status**: PROPOSED 2026-08-17. Tim asked for it during the phase 2 review
("can we adopt the mixed/merged libraries approach like we're doing on
mobile?"); the desktop-client proposal had deferred it deliberately ("one
library at a time in v1 - merging desktop-side comes later and follows the
phone's shipped merge").

**Goal**: With two or more libraries reachable - this machine's own and any
paired remotes - the dashboard shows one blended, deduplicated collection.
The switcher gains **All libraries** and it is the default; each library
survives as a filter. Search covers everything, a film on two servers shows
once, a show split across servers reads as one show, and play quietly picks
the best copy for this browser - with the local disk always beating the wire.

**Tier**: **T2.** No wire change: every call the blend makes is one the phone's
shipped merge already makes, against hosts that already answer them. No new
persisted state: the index lives in the host process's RAM and rebuilds from
catalogs. Grants, revoke and the dashboard's auth gate are untouched - each
remote keeps authorizing this machine independently, and revoking it on one
library still kills that library's films and only those. What earns the
proposal is breadth, not risk: a new read surface threaded through routes,
player and shelves, plus the one wrinkle the phone never faced.

**Depends on**: desktop-client phases 1 and 2 (merged: the N-connection
`host/remote.js`, the `/remote/<lib>/` twins, downloads, requests, the
rollups) and the phone's shipped merge engine (`src/merge.js`, plain CJS,
already loadable from the host process - verified).

---

## What we already have (the foundation)

- **The engine, whole.** `src/merge.js` is pure and shared: dedup keys
  (movie = norm(title)|year, series = norm(name), episode =
  seriesKey|season|episode), `buildIndex`, merged season ids, sorting,
  filtering, ranked search, `bestCopy`, request collapsing. The worklet is
  one consumer; the host process becomes the second. No fork.
- **N remote connections with per-call timeouts** (`host/remote.js`), built in
  phase 1 for exactly this shape of growth.
- **A read surface that swaps by base prefix.** The dashboard app reaches
  everything through `withBase()`; phase 1 proved that `/remote/<lib>` could
  stand in for `/api` without the app changing shape. `/blend` is a third
  value of the same variable.
- **Ids namespaced by library**, so a mixed list is representable and owner
  lookup is a map, not a guess - the same property the phone leaned on.
- **Downloads by itemId** (phase 2), which keep serving from disk whatever
  view asked.

## The wrinkle the phone never had: the local library is a member

The phone blends N remote hosts. The desktop blends N remotes **plus the
library on its own disk**. Three consequences, each an answer rather than a
problem:

1. **The local adapter feeds the index directly** - a catalog listing, no
   wire, no timeout. In the index it is just another library (its real
   libraryId), with copies tagged like any other.
2. **The copy pick has a new first rule: LOCAL WINS.** A film on this disk
   and on the Umbrel plays from the disk, always - no wire, no friend's
   engine, real byte-range seek. Only among remote copies does the phone's
   rank apply (direct-plays in this browser beats transcode-on-capable-host
   beats the rest; the filter beats everything when one is chosen).
3. **A client-only machine blends remotes only**, and a machine with no
   remotes never sees the blend at all. The blend exists when TWO OR MORE
   libraries hold anything - the empty local library of a client-only
   desktop does not count as one.

## Design

### 1. The index lives in the host process, beside remote.js

A new `host/blend.js` owns a RAM index built by `merge.buildIndex` over one
catalog per library: the local adapter's full listing plus each connected
remote's (the same full-catalog fetch the worklet does, raced per host so an
offline library is absent, never a hang). Rebuilt on: pair, remove, a remote
reconnect after being away, a local rescan, and a gentle staleness timer.
Nothing is persisted - the process is long-lived and a dashboard reload just
re-asks it, which is the difference from the phone (whose worklet dies with
the app and earned its `_merged` cache dir).

### 2. `/blend/api/...` - the third value of the base prefix

The read twins, one more time: `library/list`, `library/search`, `art`,
`subtitles`, `stream`, `remux`, `watch/*` answered from the index, with each
call dispatched to the owning library - the local adapter in-process, a
remote via `remote.call`. The app changes almost nothing: `setRemoteBase('/blend')`
and the pages already work, exactly the trick phase 1 proved. Merged season
ids ride `merge.mergedSeasonId`/`parseMergedSeasonId` as they do on the phone.

### 3. Copy pick and the player

`pickCopy(itemId)`: local copy if one exists; else `merge.bestCopy` over
connected remote copies with this BROWSER's declared capabilities as the
rank (the phone uses its chip's; same seam, different facts). The player
needs no new modes - the pick resolves to a concrete library and the
existing local or twin routes carry it, including downloads (which only
offer on items with no local copy; downloading what this disk already holds
is a copy for nothing).

### 4. Watch state: read as a union, written to every copy

Reads concatenate per-library answers (continue newest-first, watched as a
union) - server-authoritative on each side, the phone's shipped rule. Writes
fan to every library holding the item, best-effort, ok when any landed -
`writeToCopies`, ported. The seam to state honestly: the LOCAL half writes
under the browser's chosen person (the watcher cookie), the REMOTE halves
under this machine's device grant, exactly as phase 2 writes them today. The
shows/seasons rollups compute over the blended episode lists, reusing the
phase 2 wire-walk with the local adapter folded in.

### 5. Requests fan to remotes

The blend's ask goes to every REMOTE at once (the phone's phase 3 shape,
`collapseRequests` for the list); the local library is never asked - a note
to self is not a request, the rule the local twin already states.

### 6. UI: All libraries, default, remembered

The switcher grows **All libraries** at the top once the blend exists, and
it is the default (the phone's rule: merged by default, source as a
filter). The choice is remembered per browser. The metadata pencil stays
hidden in the blend (a mixed view cannot know whose file it would edit);
filter to My library and it returns.

## What this must NOT touch

- **Grant stores stay host-local, everywhere.** The blend is a read model.
- **Revoke stays per-library and instant** - revoking this machine on one
  library greys that library's copies and the rest keep playing; the phase 2
  acceptance test re-run against the blend.
- **The dashboard auth gate**: `/blend` sits behind the same
  loopback-or-password rule as every twin, and the remote remux path keeps
  its passwordless-loopback requirement.
- **This machine never re-encodes someone else's stream** - the pick may
  change WHERE bytes come from, never who converts them.

## Phasing

- **Phase 1: browse, search and play.** `host/blend.js`, the `/blend` twins,
  the switcher's All entry, local-wins copy pick, per-owner watch writes
  (free once items carry their library) and the concatenated Continue shelf.
- **Phase 2: the unions and the fans.** Merged watched/rollups, fanned
  position/watched/watchlist writes, requests to every remote, downloads
  offered per the local-copy rule.
- **Phase 3: casting from the blend.** The cast listener serves the LOCAL
  adapter today; a blended cast either restricts the TV picker to items
  with a local copy or teaches the listener to proxy a remote copy's bytes.
  Small either way, decided when it is reached - the phone's casting sliver
  waited the same way.

## Verify

- **Unit**: the engine is already covered by the phone's tests; what is new
  is the host-side plumbing. Extend the two-host DHT testnet rig
  (test/remote.test.js) with a LOCAL adapter on the desktop side: blend of
  local + one remote dedupes a shared film, spans a series across the two,
  picks the local copy, falls to the remote when the local lacks it, fans a
  watched write to both and keeps serving local items with the remote dead.
- **Hardware**: this desktop with a small local folder copied from the
  Elements drive (real duplicates), paired to the real Umbrel: All
  libraries blends and dedupes, play picks the disk for shared films
  (verified in which route serves), a remote-only film streams through the
  twin, revoke on the Umbrel greys only Umbrel copies. The puppeteer
  harness clicks through the blended pages the way it now does for
  everything else.

## Open questions

1. **Does All hide the switcher's per-library entries behind a submenu once
   somebody has, say, five libraries?** Recommendation: no - a flat list
   matches the phone's dropdown and five is the realistic ceiling.
2. **Should the blended Continue shelf collapse the SAME film resumed on two
   libraries to one card?** The phone concatenates without collapsing.
   Recommendation: collapse by dedup key, newest position wins - the
   desktop reads better for it, and the fan-out write makes the positions
   converge anyway.
