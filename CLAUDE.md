# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

Constitution applies. See `/home/tim/peerloomllc/CONSTITUTION.md` for risk tiers, proposal gate, DECISIONS convention, verify gate and wiki-sync rules.

## Project Overview

PearCinema is a peer-to-peer **video** player for a self-hosted library. It is the sibling of PearTune (`../peartune`), and the pitch is the same one word changed: **your film and TV collection, playable anywhere, without exposing your server to the internet.**

The library owner can let a friend or family member in, each as their own person holding their own devices, revocable in a second. Copy anywhere in the app, the dashboard, the README or the store listings must not frame a library as your-own-machine-only (Tim, 2026-07-24, inherited from PearTune).

## Status: SHIPPING. Both gating proposals were approved on 2026-08-12.

There is a phone app, four running hosts and 873 tests (2026-08-22). `proposals/2026-08-12-video-deltas.md`
and the shared-host proposal were both approved that day, and `@peerloom/host` was extracted
into its own repo at `../peerloom-host`. Nothing gates code any more; the Constitution's
proposal gate still applies to new T2/T3 work.

Newest decisions are in `DECISIONS.md`, shipped work in `DONE.md` (dated, newest first) and
open items in `TODO.md`. Both tracking files are gitignored, so read them rather than the
git log for where things stand.

## Where things are

- `host/` - the daemon. `server.js` (PearCinemaHost), `methods.js` (the wire method table,
  which is where "what this app means" lives), `adapters/` (folder and Jellyfin), the
  transcode/remux/HLS path, casting and `ui/` - the Preact dashboard, which is also a
  working web PLAYER.
- `src/` - the phone. `bare.js` is the worklet (a top-level script with Bare globals: it
  cannot be `require`d in a test, so pure logic belongs beside it, not in it), `merge.js`
  is the merged-library index and every rule that must be testable, `ui/App.jsx` is the
  WebView app.
- `desktop/` - the Electron tray host, which is how the Mac and Windows machines run.
- `umbrel/` - the community-store app definition.
- `android/` is GENERATED and gitignored, per suite rule 5 - `app.json` plus `plugins/` are
  the source. (PearTune commits its native trees; this repo does not, which is the suite
  default.) There is no committed `ios/` tree either: `scripts/ios-sim-build.sh` prebuilds
  one on the Mac mini when it is needed, Simulator-first per rule 7.

## Verify, and how the hosts are updated

`npm run verify` is the gate: the tests, then the dashboard build, then the phone UI build.
Both builds write files the app actually loads, so a UI change that is not rebuilt is a
change the tests cannot see - `test/phone-renders.test.js` and `test/page-renders.test.js`
read the BUILT page.

- **Umbrel** - `rsync` the tree to `~/pearcinema-src/` and run `bash host/redeploy-umbrel.sh`
  on the box. It builds the image there, finds the library under `external/*/Video` rather
  than naming a path and reuses `/home/umbrel/pearcinema-data`, so pairings survive.
- **Mac mini and the Windows VM** - the packaged desktop app, rebuilt and installed.
- The phone - `npm run build:bare` then `assembleDebug`; the debug APK EMBEDS the JS, so
  Metro is never involved and an unbuilt bundle is a stale app rather than an error.

## The name

**PearCinema.** Decided 2026-08-12 after rejecting:

- **PearTube** - Tim's original. YouTube's "-tube" suffix is aggressively enforced against
  app-store listings.
- **PearFlix** - Netflix enforces "-flix" just as hard.
- **PearVideo** - already a shipped app with 1M+ downloads (`com.pearvideo.tec.android`).
- **PearScreen** - collides conceptually with PearGuard, which is the screen-time app.
- **PearReel** - Instagram Reels is heavily enforced regardless of the word's history.

Do not reopen this without a new reason.

## What was inherited, and what this app actually cost

**Inherited from PearTune via `@peerloom/host`** - do not reimplement any of this: the wire
protocol shape, pairing, the Noise firewall, the host-local grant store,
revoke-kills-live-connections, people and grants, update check/apply, plus on the phone
`hosts`, `failover`, `link-health`, `session`, `merge`, `outbox`, `retry` and the local HTTP
shim.

**What was new, and is now built** - the list below was the estimate on 2026-08-12 and every
line of it turned out to be real work rather than a paragraph:

- Container and codec compatibility. Remux where the streams are already fine, transcode
  where they are not, decided per device from a capability declaration the phone sends.
- Hardware video engines: VAAPI, NVENC, VideoToolbox on macOS, Quick Sync and AMF on
  Windows. A host measures its own engine rather than assuming one.
- Subtitles, including embedded PGS forcing a burn-in.
- A GB-scale offline cache, with downloads that can be kept converted.
- Metadata, because a video file carries a filename and not tags - a folder name parser
  derived from a real 12,197-file library, sidecar `.nfo` first, TMDB optional.
- Casting to Roku, DLNA and Chromecast televisions, plus a lock-screen remote.
- A web player in the dashboard, which is a second compatibility opinion from a completely
  different engine.

## Two inherited rules that are security bugs if broken

1. **The grant store is host-local and never replicated.**
2. **Revoke must kill live connections, not just future ones.** Acceptance test: revoke
   cuts off all NEW access within a second.

Casting adds a third, already solved in PearTune's `host/cast.js` and worth re-reading
before touching the cast path: **a cast target is not a HyperDHT connection**, so
`connections.kill()` does not silence it. Revoke must ALSO actively stop the device.

## The relay ships, and that reverses an earlier decision

This file used to say "no relay, by design", with arithmetic behind it. **That was reversed
on 2026-08-18** (`proposals/2026-08-18-relay-for-video.md`), because the cost of being right
about the arithmetic was that Tim's own phone could not reach his own library on cellular at
all - four aborted hole-punches in a row, while PearTune on the same phone in the same minute
worked, its relay baked in.

So `src/relay.js` carries the PeerLoom relay key, shared with PearTune because a blind relay
cannot read a stream. The terms Tim set the same day: **direct first** (the key is only
offered after a punch has actually failed, or where our own NAT makes one impossible), a
forced **2500 kbps ceiling** while relayed, relayed casting allowed and **no hard cap** -
metrics and a warning instead. A user may paste **their own** relay key, and theirs wins.

## Two calls that are easy to get backwards

Both are Tim's, from 2026-08-12, and both have survived contact with the work:

- **Folders are not deferred, and are not second.** Jellyfin came first only because it
  reached first playback faster. The folder adapter is the moat: reading only Jellyfin makes
  this an accessory to a project that can add its own remote access whenever it likes.
- **No TV client. Casting only.** The costing for an Android TV build is kept in the proposal
  because the question returns once casting's browse-on-a-phone limitation is felt, not
  because it is scheduled.

## Testing, and what only hardware can answer

Suite rule 15 applies: an emulator or a Simulator first, hardware only for what needs it.
When hardware is warranted the TCL is the target and the Pixel is observe-only.

Two things worth knowing here specifically:

- **Drive the phone over CDP, not by tapping.** `adb forward` to the WebView's devtools
  socket, then read `document.getElementById('root').innerText` and call worklet methods
  through `window.ReactNativeWebView.postMessage`. It is cheaper than screenshots, it is
  exact and it works on a phone nobody should be poking.
- **A second host is a real host.** Tim runs four - the Umbrel, the Mac mini, a Windows VM
  and a Debian VM - and merged-library behaviour, requests and copy-picking are only honest
  against more than one.

## Branch Strategy

Always create a branch before starting work. Never commit directly to master. Merge via PR.

## Licensing note

MIT. **Do not take a dependency on `holesail`, `holesail-server`, `holesail-client`,
`@holesail/invite` or `@holesail/protocol`** - they are AGPL-3.0 / GPL-3.0 and would drag
copyleft across the app.
