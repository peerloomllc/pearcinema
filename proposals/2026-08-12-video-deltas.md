# PearCinema - video deltas on PearTune's wire protocol

**Status**: Draft 2026-08-12. Awaiting approval.

**Goal**: Define what PearCinema changes relative to PearTune, so a video library is
reachable from anywhere with no VPN, no port forwarding and no account, without
re-deriving the P2P layer that already works.

**Tier**: **T3.** New pairing topics, a new media method table, and a cast path that
serves library bytes to a device on the LAN. The grant model and revoke semantics are
inherited unchanged, and keeping them unchanged is itself a security claim that has to be
verified rather than assumed.

**Depends on**: `../../proposals/2026-08-12-shared-host.md` (`@peerloom/host`). That is a
**prerequisite**, chosen by Tim on 2026-08-12 over forking PearTune's host. No app code
here starts before it.

---

## This is not a v1 wire protocol

PearTune's `2026-07-13-wire-protocol.md` had to invent pairing, framing, the firewall and
revoke. **None of that is reopened.** This document is only the deltas, and it should be
read next to that one rather than instead of it.

Unchanged and inherited wholesale: Noise-authenticated HyperDHT connections, the
host-local non-replicated grant store, revoke killing live connections, per-person grants,
the pairing QR and link, `resume.*`, `fav.*`, `count.*`, `playlist.*`, `session.*`,
`identity.*` and `owner.*`.

## What actually changes

### 1. Topics

`pearcinema/pair/1` and `pearcinema/media/1`. Different topics so the two apps never
collide on the DHT and a PearTune phone cannot half-connect to a PearCinema host.

### 2. The item model

PearTune's `track / album / artist` becomes `movie / episode / season / series`. This is
the largest single piece of new code and it is not a rename: a film is a leaf, a series is
a three-level tree, and "continue watching" is a flat list cutting across both.

`resume.get` / `resume.set` **already exists in PearTune and is exactly "continue
watching"**. It is inherited as-is, and it is the single biggest free win in this
proposal.

### 3. `media.stream` gains a video shape

PearTune's `media.stream` already takes `offset` and `length`, and `FolderAdapter.stream`
already does real byte-range reads. **Direct-play seeking therefore works on day one with
no protocol change**, which is why v1 is direct-play only.

What is added later, not in v1:

- `mode: 'direct' | 'remux' | 'transcode'`, so the client can say what it can play.
- `capabilities` on the request: container, video codec, audio codec, max resolution. The
  host decides. Guessing client-side is how this goes wrong.

### 4. Subtitles

New: `subtitle.list` and `subtitle.get`. External `.srt` and embedded text tracks are
cheap. **Embedded PGS is image-based and forces a full transcode to burn in**, so v1 lists
it and refuses it rather than pretending.

### 5. Cast to a TV

The mechanism PearTune already built for Google speakers is the video cast path. Per
`peartune/host/cast.js`, Home Assistant hands the URL straight to the Chromecast, which
fetches it itself, so the listener already answers the LAN behind 32-byte capability
tokens, re-reads the live grant on every fetch, and actively stops the device on revoke.

Targets, in order of how well they work with **no app to install on the TV**:

1. **Chromecast / Google TV / Cast-built-in TVs.** The Default Media Receiver plays H.264
   and HEVC in MP4 with no published receiver app and no developer registration. This is
   the one worth building.
2. **DLNA / UPnP** via `SetAVTransportURI`, which covers Samsung and LG where Cast usually
   does not. Format support is whatever the TV happens to have, which is a lottery.
3. **AirPlay**, close to free on iOS through AVPlayer's native route picker. Unavailable
   from Android.
4. **Roku**, which really wants a published channel. Not worth it.

An **Android TV / Fire TV build of the client itself** beats all four on quality and is
worth costing separately.

## Scope

**In, for v1:**

- Jellyfin and Emby as the source. The adapter already exists in PearTune and filters
  `IncludeItemTypes: 'Audio'`; movies and episodes are the same API with different
  parameters and a different stream endpoint.
- Direct play only. No transcode, no remux.
- Continue watching, via inherited `resume.*`.
- External `.srt` subtitles.
- Chromecast push.
- Android client first, iOS second.

**Out, for v1, deliberately:**

- **Transcoding of any kind.** Named below as the reason.
- The folder adapter. Video metadata from filenames needs TMDB, which is a network
  dependency the suite does not currently have anywhere.
- Offline downloads. A film is 4 GB where a song is 4 MB, so the pin/LRU cache needs a
  different budget model and UI, not a bigger number.
- **Any relay.** See below.
- DLNA, AirPlay, a TV client.

**Why direct-play-only is the right v1 and not a cop-out.** The expensive, uncertain part
of this app is which files in a real library actually play on a real phone. Shipping
direct-play-only against Tim's own Jellyfin answers that with data in days. Building a
transcode pipeline first means building it against a guess about which formats need it.

## No relay, by design

PearCinema bakes in **no relay key**. Mechanically free: `protocol/relay.js:relayThroughFor`
returns a key only when `(force || randomized) && useRelay && relayKey`.

The arithmetic that decides it: PearTune's live relay carried **163 MB in six days**
against a 500 GB/month tier. Video at 8 Mbps is **3.6 GB per hour**. One person watching
two hours a day is 216 GB/month by themselves, and two such users blow the tier.

**The honest cost.** PearTune measured the hole-punch at 12% per attempt on Google Fi,
which retries turn into "usually within a minute". A user on symmetric NAT at both ends
sits near 0%, and for them there is no direct path at all. With no relay, PearCinema does
not work off their own LAN. That is a real group of people and the store listing must not
pretend otherwise.

**The answer offered**: bring your own relay. A settings field for a relay public key the
user runs on their own VPS. The daemon is ~150 lines, already app-agnostic by design, and
already documented for systemd and Docker in `peartune/relay/README.md`. It fits the
ownership pitch better than a PeerLoom-run relay ever did.

## The capacity claim, restated for video

`peartune/docs/transcode-capacity.md` measured 200+ concurrent audio transcodes on an
N100 and concluded transcode CPU is almost never the bottleneck. **That conclusion does
not survive the move to video** and must not be cited here. The same box does well under
one software 1080p stream.

Video transcode needs hardware acceleration, which on Umbrel means passing `/dev/dri` into
the container alongside the existing `network_mode: host`. Out of scope for v1, and the
capacity doc needs a video section written from fresh measurements before anyone promises
a number.

## Compat

- **Old peers**: none exist. Greenfield.
- **PearTune**: unaffected. Different topics, different app id, separate host process. A
  box can run both.
- **Forward compat**: the method table follows PearTune's rule that an unknown method
  returns a typed `NO_METHOD` error and the channel survives, so an old host degrades in
  front of a newer client rather than wedging it. `mode` and `capabilities` on
  `media.stream` are additive and absent means direct play.
- **Umbrel**: needs `/media` and `/mnt` mounted with `propagation: rslave` for external
  drives, which is the same gap already logged against PearTune. Fix it there first.

## Verify

1. `npm run verify` green.
2. **Pair, browse, play a film, seek, revoke mid-playback.** Within a second: reconnect
   denied, browse and next-item and art all fail. Inherited acceptance test, and it must
   be re-run here rather than assumed from PearTune, because a different method table is
   a different set of ways to leak access.
3. **Against a real Jellyfin with a real library**, not a synthetic one. The whole point
   of v1 is learning which files direct-play, and a curated test library answers a
   question nobody asked.
4. **Cast to a Chromecast, then revoke.** The room must go dark. Per `cast.js`, a cast
   target is not a HyperDHT connection, so `connections.kill()` cannot reach it and the
   active stop is what does the work. **Look at the TV, not at the log line saying stop
   was sent.** PearTune's 2026-08-08 lesson: verifying the readback is not verifying the
   claim.
5. **Off-LAN over cellular with no relay configured**, so the actual no-relay failure mode
   is observed rather than theorised.

## Rollback

No users, no shipped artifact, no wire in the field. Rollback at this stage is stopping.
The first thing that needs a real rollback plan is the first release, and that plan is the
one PearTune already uses: a host image pinned by digest in `umbrel/docker-compose.yml`,
reverted by re-pinning the previous digest.

## Open questions

1. **Android TV client: v1.5 or v2?** It may be a better product than casting and cheaper
   than the transcode pipeline. Worth costing before committing to the cast path as the
   primary TV story.
2. **Jellyfin-only forever, or a folder adapter later?** Jellyfin-only makes PearCinema a
   remote-access layer for Jellyfin rather than a standalone server, which is a smaller
   and more honest product. It also means no library works without installing Jellyfin
   first. Genuine product fork in the road.
3. **Where does transcode run when the host is a Mac?** PearTune's Mac host is a
   LaunchDaemon and VideoToolbox is excellent, but the packaging differs enough from the
   Linux `/dev/dri` path to need its own answer.
4. **Does the phone re-serve to a TV when off-LAN?** At a friend's house the host is not
   on the TV's LAN, so casting there needs the phone as the origin. It composes, since the
   phone already runs an HTTP shim, but it doubles the bandwidth through the phone.
5. **Store listings.** Apple and Google both scrutinise apps that stream video for
   copyright reasons. PearTune's App Review notes had to explain a pairing wall; this will
   likely have to explain provenance too. Worth drafting early rather than at submission.
