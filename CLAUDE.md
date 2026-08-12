# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

Constitution applies. See `/home/tim/peerloomllc/CONSTITUTION.md` for risk tiers, proposal gate, DECISIONS convention, verify gate, and wiki-sync rules.

## Project Overview

PearCinema is a peer-to-peer **video** player for a self-hosted library. It is the sibling of PearTune (`../peartune`), and the pitch is the same one word changed: **your film and TV collection, playable anywhere, without exposing your server to the internet.**

The library owner can let a friend or family member in, each as their own person holding their own devices, revocable in a second. Copy anywhere in the app, the dashboard, the README or the store listings must not frame a library as your-own-machine-only (Tim, 2026-07-24, inherited from PearTune).

## STATUS: DESIGN STAGE. NO APP CODE YET.

Two proposals gate this repo, and **both must be committed by Tim before app code starts**:

1. `proposals/2026-08-12-video-deltas.md` (T3) - this app.
2. `../proposals/2026-08-12-shared-host.md` (T3) - `@peerloom/host`, the shared host
   package extracted from PearTune. **This is a prerequisite, not a follow-up.** Tim chose
   extract-first on 2026-08-12 specifically to avoid a fourth copy-fork.

If you are asked to "start building PearCinema" and neither proposal is committed, say so
rather than starting. Approval = Tim commits the proposal. No ceremony (Constitution §3).

## The name

**PearCinema.** Decided 2026-08-12 after rejecting:

- **PearTube** - Tim's original. YouTube's "-tube" suffix is aggressively enforced against
  app-store listings.
- **PearFlix** - Netflix enforces "-flix" just as hard.
- **PearVideo** - already a shipped app with 1M+ downloads (`com.pearvideo.tec.android`).
- **PearScreen** - collides conceptually with PearGuard, which is the screen-time app.
- **PearReel** - Instagram Reels is heavily enforced regardless of the word's history.

Do not reopen this without a new reason.

## What is inherited and what is new

**Inherited from PearTune via `@peerloom/host`** - do not reimplement any of this:
the wire protocol shape, pairing, the Noise firewall, the host-local grant store,
revoke-kills-live-connections, people and grants, the Preact dashboard, Umbrel/Start9/Mac
packaging, update check/apply, and on the phone `hosts`, `failover`, `link-health`,
`session`, `merge`, `outbox`, `retry` and the local HTTP shim.

**New, and the entire real cost of this app:**

- Container and codec compatibility (the underestimated one - MKV + H.265 + TrueHD does
  not direct-play on iOS at all).
- Transcode with working seek (HLS or restart-at-seek; PearTune's progressive
  `accept-ranges: none` is unacceptable for a two-hour film).
- Hardware acceleration, which means `/dev/dri` passed in alongside `network_mode: host`.
- Subtitles, including the fact that embedded PGS forces a full transcode to burn in.
- A GB-scale rather than MB-scale offline cache.
- Metadata, since video files carry a filename and not tags.

## Two inherited rules that are security bugs if broken

1. **The grant store is host-local and never replicated.**
2. **Revoke must kill live connections, not just future ones.** Acceptance test: revoke
   cuts off all NEW access within a second.

Casting adds a third, already solved in PearTune's `host/cast.js` and worth re-reading
before touching the cast path: **a cast target is not a HyperDHT connection**, so
`connections.kill()` does not silence it. Revoke must ALSO actively stop the device.

## No relay, by design

PearCinema bakes in **no relay key**. `relayThroughFor` only returns a key when
`(force || randomized) && useRelay && relayKey`, so a null key kills the path with no
architectural change. The arithmetic: PearTune's relay carried 163 MB in six days against a
500 GB/month tier, and video at 8 Mbps is 3.6 GB per hour.

The honest cost is that ~0%-punch users (symmetric NAT both ends) get no off-LAN path.
The answer is **bring your own relay**, a settings field for the user's own VPS relay key.

## Suggested v1 scope

Jellyfin source only, direct play only, no transcode, no relay, LAN plus punched DHT,
Chromecast push. Discover the codec problem against real libraries instead of guessing at
it. Folder source, remux, hardware transcode and subtitles come after.

## Branch Strategy

Always create a branch before starting work. Never commit directly to master. Merge via PR.

## Licensing note

MIT. **Do not take a dependency on `holesail`, `holesail-server`, `holesail-client`,
`@holesail/invite` or `@holesail/protocol`** - they are AGPL-3.0 / GPL-3.0 and would drag
copyleft across the app.
