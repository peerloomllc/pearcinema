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

An **Android TV / Fire TV build of the client itself** would beat all four on quality. It
is costed in the resolved section below and **scrapped for now** (Tim, 2026-08-12), so
Chromecast is the whole TV story.

## Scope

**In, for v1:**

- **Two sources, in this order.** Jellyfin and Emby first, because the adapter already
  exists in PearTune and reaches first playback in days. **Then the folder adapter, also
  in v1** (Tim, 2026-08-12: "we definitely want folders"). Jellyfin is the fast path to
  first playback, not the product.
- Direct play only. No transcode, no remux.
- Continue watching, via inherited `resume.*`.
- External `.srt` subtitles.
- Chromecast push. **This is the whole TV story for now** (Tim, 2026-08-12).
- **Opt-in online metadata**, default off, sidecar-first. Designed below.
- Android client first, iOS second.

**Out, for v1, deliberately:**

- **Transcoding of any kind.** Named below as the reason.
- Offline downloads. A film is 4 GB where a song is 4 MB, so the pin/LRU cache needs a
  different budget model and UI, not a bigger number.
- **Any relay.** See below.
- DLNA, AirPlay.
- **A TV client. Scrapped for now** (Tim, 2026-08-12), casting only. The costing is kept
  below because it is the reason the decision is safe rather than a guess, and because the
  question will come back once people are using casting and find it awkward.

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

## Resolved: folders are in v1, with opt-in metadata on top

**Answer: both sources in v1, Jellyfin first only because it is faster to first playback.
Metadata is sidecar-first and offline by default, with an opt-in online pull the operator
turns on deliberately.** (Tim, 2026-08-12.)

**This was framed as a product fork in the road in the first draft, and that was wrong.**
It read that way because of an assumption that did not survive checking: that a folder
adapter needs an online metadata service. It mostly does not.

Self-hosted video libraries are overwhelmingly populated by Sonarr and Radarr, or scanned
by Jellyfin, Emby or Kodi. **All of them write metadata to disk beside the media**: Kodi
format `.nfo` XML, plus `poster.jpg`, `fanart.jpg` and `banner.jpg`. So a folder adapter
can have titles, years, synopses, cast, episode ordering and artwork with **zero network
calls, no API key and no third party learning what you own**. That last part matters: a
TMDB dependency would be the first outbound metadata call anywhere in the suite, and it
would undercut the privacy pitch for no good reason.

There is precedent in the donor. PearTune's `FolderAdapter._coverFile` already looks for a
cover image sitting in the album directory. Sidecar metadata is the same pattern with
different filenames.

The fallback for a library with no sidecars is filename parsing, which yields title, year
and `SxxEyy` and nothing else. That is a degraded but genuinely usable library, and it is
honest to say so in the UI: no posters until you run a scanner.

**Why folders are not deferred.** The folder adapter is the moat. If PearCinema only ever
reads Jellyfin, it is a Jellyfin accessory and Jellyfin is free to improve its own remote
access whenever it likes. PearTune works standalone rather than only in front of Navidrome,
and this should too. Jellyfin-first is a sequencing convenience inside v1, not a scope cut.

**What the folder adapter actually costs**, since it is now v1 work and should be costed
honestly rather than waved through. Reusable from PearTune: multi-root support, the
unplugged-drive resilience, the dashboard picker and `visibleMounts()`. New: the
movie/series/season/episode tree, filename parsing, `.nfo` XML parsing and artwork
resolution. Call it the second largest chunk in v1 after the item model itself, and note
that the two overlap.

### Opt-in online metadata

Default **off**. Nothing about the library leaves the host unless the operator switches it
on. Three rules, in order:

1. **Sidecar first, always.** If a `.nfo` and artwork sit beside the file, they win and no
   lookup happens, whatever the setting says. For most libraries this means the online
   path never runs at all.
2. **Opt in per library, in the dashboard**, with the choices pre-filled so the operator
   confirms rather than researches: provider and language already selected, and toggles
   for what to fetch (artwork, synopses, cast) already set to sensible values.
3. **Pre-filled matches, operator confirms.** When the scanner is unsure which film a file
   is, it presents its best candidates already filled in and the operator picks or
   corrects. This is the standard identify flow and it is the difference between a library
   that is 95% right and one that is trusted.

**Say plainly what it does**, in the dashboard and not only in a privacy page: turning
this on means **the host** tells a third party the titles it is trying to identify. Not
the phone, and not the files. It is a real disclosure and the reason the default is off.

**Results cache to `PEARTUNE_DATA`, not into the library.** The library mount is read-only
by design (`:ro` in the Umbrel compose) and writing to someone's media directory is not
ours to do. Offer "also write `.nfo` sidecars" as a separate explicit action for a
writable library, since that benefits their Jellyfin and Kodi too.

**The operator brings their own API key** (Tim, 2026-08-12). PearCinema ships no
credential. Three consequences that follow and are not optional:

- **One provider, not two.** Asking someone to register with two services for one feature
  is how a feature goes unused. **TMDB for both films and TV**, since its key is free and
  self-serve, where TVDB gates parts of its API behind a subscription. This is a direct
  consequence of the bring-your-own decision: a shipped key could have afforded two
  providers, a user-supplied one cannot.
- **No key must not look broken.** Without one the library still works: sidecars where
  they exist, filename parsing where they do not. The absence of a key means no posters
  for unorganised files, and the UI should say exactly that rather than showing an error.
- **The setup step is the whole risk, so it gets real design.** A direct link to the
  provider's key page, a paste field, and a Test button that validates before saving. A
  key that silently does not work is worse than no key, because the library just looks
  wrong.

## Resolved: no TV client, casting only

**Answer: scrapped for now (Tim, 2026-08-12). Chromecast push is the entire TV story.**

The costing is kept below rather than deleted, for two reasons: it is what makes the
decision informed rather than a guess, and the question comes back the moment people use
casting enough to find it awkward. When it does, the answer is "the toolchain is free, the
UI is a second UI", and nobody has to re-derive that.

**What is free or nearly free:**

- **The toolchain is supported and needs no upgrade.** `react-native-tvos` plus the
  `@react-native-tvos/config-tv` Expo config plugin is the documented path, and Expo's own
  docs cover building for TV. PearTune is on **Expo SDK 54 / RN 0.81.5**, and RNTV
  `0.81-stable` is exactly the matching supported pairing, so this rides the stack the
  suite already has rather than forcing an SDK migration.
- **Android TV is arm64 or x86_64 Android**, so the Bare worklet and native addon slices
  are a problem already solved. The x86_64 slice exists for emulators.
- **The host, protocol, pairing, grants and revoke are identical.** Nothing new.
- **Direct play gets EASIER, not harder.** Android TV boxes have far better codec support
  than phones (HEVC routinely, often AV1), so the format problem this app is mostly about
  shrinks on the platform where the files are biggest.

**What it actually costs, and it is one thing:**

- **The UI is a WebView, and that is the entire cost.** D-pad navigation in a WebView is
  not free. Chromium does not ship the CSS spatial-navigation spec, so focus movement has
  to be implemented in JavaScript, either with a spatial-navigation library or hand-rolled
  LRUD. Every screen needs a focus model, visible focus rings and an explicit rule for
  Back. **This is not a port of the phone UI, it is a second UI**, and it should be costed
  as such.
- 10-foot layout on top of that: type sizes, hit targets and overscan margins. Reusing
  phone layouts on a television looks exactly as bad as it sounds.
- Manifest and packaging work, all mechanical: the `android.software.leanback` feature, a
  TV banner asset, a leanback launcher intent filter and
  `android.hardware.touchscreen required="false"`.
- **Separate store listings.** Play Store TV is its own listing with its own review and
  quality checklist. Fire TV is a separate Amazon Appstore submission, though sideloading
  for personal use is trivial and is how this gets tested.
- Testing runs on an Android TV emulator AVD first per suite rule 15, then a cheap Fire TV
  stick for the real thing.

**Sizing.** Everything except the UI is close to free. The TV UI is comparable to building
the phone UI again minus all the plumbing, which makes it the largest single chunk of work
after the host extraction, and still smaller than a correct transcode pipeline with seek.

**Why casting is enough for now.** The security machinery already exists in
`peartune/host/cast.js` and the Default Media Receiver needs no published app, so v1 gets
video onto a television for very little. The cost of stopping here is that the phone is the
remote and all browsing happens on a 6-inch screen while a 55-inch one plays. That is a
real limitation to watch for in feedback, and the trigger to revisit this.

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

Resolved so far: folders are in v1 with opt-in online metadata on top, the TV client is
scrapped in favour of casting alone, and the operator brings their own API key, which
settles the provider question as TMDB-only.

1. **Where does transcode run when the host is a Mac?** Not v1 - there is no transcode in
   v1 - but it shapes the adapter seam, so it should not be discovered late.
   **Recommendation: detect at startup and keep two encoder paths**, VideoToolbox on the
   Mac and VAAPI or QSV through `/dev/dri` on Linux, with software as the last resort.
   `host/detect.js` already establishes the probe-at-startup pattern for music servers, so
   this follows an existing shape rather than inventing one. The real work is that the Mac
   host is a LaunchDaemon and the Linux host is a container needing a device passed in, so
   the packaging differs even where the ffmpeg flags do not.

2. **Does the phone re-serve to a TV when off-LAN?** At a friend's house the host is not
   on the TV's network, so casting there needs the phone as the origin. It composes, since
   the phone already runs an HTTP shim and would just bind it to the LAN under the same
   token discipline. **Recommendation: no, not in v1.** It doubles the bytes through the
   phone, on the connection least able to afford it, and it puts library audio and video on
   a stranger's network in cleartext, which is a materially different security story from
   the home LAN case `cast.js` reasoned about. Treat casting as a same-network feature and
   have the UI say so plainly rather than failing obscurely.

3. **What do we tell Apple and Google?** Both scrutinise apps that play video, for
   copyright reasons, and PearCinema shows a reviewer an empty app because the library is
   behind a pairing wall - the exact situation that made PearTune's iOS review notes
   necessary. Expect to answer "where does this content come from" as well.
   **Recommendation: reuse PearTune's playbook and start now, not at submission.** That
   means review notes giving the exact tap path, an attached video showing pairing, and a
   demo library bundled the way `2026-07-28-app-review-demo.md` did it - which for video
   means public-domain films, and sourcing those is lead time nobody will have at
   submission. The framing that matters: PearCinema is a player for files the user already
   has, it hosts nothing, indexes nothing and has no catalog of its own.

All three carry recommendations, and none of them block approval. Question 3 is the one
with lead time in it, deferred deliberately rather than forgotten: the demo library waits
until there is an app to demo, which means the sourcing has to start before submission and
not at it.
