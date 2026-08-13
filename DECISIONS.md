# PearCinema decisions

Append-only, newest on top. Per Constitution §4.

## 2026-08-13 (latest) - the web interface is the operator's dashboard WITH playback, and the player is one transport rather than a second implementation
Tier: T2
Context: the TODO item asked the question outright and said to answer it before
building: is this the operator's dashboard with playback added, or a genuine second
client? And a player needs bytes, which the phone already has a path for.

**Choice (a): the dashboard with playback added.** No accounts, no per-user state, no
resume, no separate client identity. The browser is the OPERATOR - the person holding the
dashboard password - not a device with a grant.

Why: the cheap answer is also the correct one here, and the expensive one would have been
wrong rather than merely dear. A "second client" implies a subject: somebody whose
watch state, permissions and revocability are tracked. Every one of those already has an
owner in this system (the grant store, `resume.*`, the pairing windows) and duplicating
them for browsers would mean two answers to "who is watching" - which is precisely the
kind of divergence the shared-host extraction exists to prevent.

**The consequence to keep in view: revoke does not reach a browser, and is not supposed
to.** A browser holds a session cookie, not a grant, so the revoke-kills-live-connections
rule says nothing about it. Anyone reading "revoke cuts access within a second" should
read it as being about paired devices. Logged in TODO as a question worth revisiting, not
as a bug.

**Choice (b): `/api/stream` is HTTP wrapped around the SAME `host.openStream` the phone's
`media.stream` calls.** Not an adapter call of its own.

Why: the range arithmetic is the part that decides whether seeking inside a two-hour film
works, and the id-to-path guard is the part that decides whether `media.stream` is a media
server or arbitrary file read. Two copies of either is one copy that gets fixed and one
that does not. A test asserts the browser's `Range` header reaches the adapter as the same
`{offset, length}` the P2P path produces, so the claim is pinned rather than intended.

**Choice (c): a built Preact app, not a hand-written page.** The donor's dashboard was a
700-line template literal until a syntax error inside the string produced a completely
blank control plane that every test passed - because a string is a string, and nothing
ever parsed it. Building catches that class at build time. It does NOT catch a runtime
error in the first render, which is the same blank page from a different cause, so there
is now a test that loads the committed HTML into a real DOM and clicks through it.
Preact rather than React purely on size: 49 kb against the donor's 440 kb, same escaping
behaviour, and the host had no other client-side dependency pulling React in.

### The finding that makes this more than a convenience: a browser is a second compatibility engine

The player refuses most of a real collection. That is not a defect in it - Chrome and
Safari will not open Matroska, and per the measurement below 83% of the library is
Matroska. **Two independent engines, a browser and an iPhone, refusing the same 83% of
files at the container for the same reason is evidence rather than a prediction**, and it
is the strongest argument yet that remux is the release and not an optimisation.

So the refusal is treated as a FEATURE OF THE UI rather than something to hide:

- Every list carries a count of how many of these files *this* browser can play, computed
  from `canPlayType` rather than from our own opinion of what browsers do.
- Every refusal names the container, says the file is fine, and points at remux.
- A codec the browser cannot decode is a refusal; an AUDIO codec it cannot decode is
  "picture, no sound" and still plays. Those are genuinely different outcomes and
  collapsing them would have hidden DTS and TrueHD files that are perfectly watchable.
- "Play anyway" is always offered, because `canPlayType` answers about a codec family and
  can be wrong in both directions. A wrong refusal should cost one click.

The rules live in `host/ui/app/playback.js` with the browser injected, so they are unit
tested against what Chrome would answer and what Edge would answer without opening either.

## 2026-08-12 - THE WHOLE LIBRARY, 12,197 files: iOS NEEDS REMUX, it is not optional
Tier: T2 (a measurement that revises build order and one of the proposal's framings)
Context: the Jellyfin measurement below was 25 files. This is Tim's actual collection on
the Elements drive, scanned file by file with ffprobe by `host/probe.js` - no Jellyfin in
the path, because the collection was never in Jellyfin.

**Read the folder split before the totals, because the totals lie.**

| Folder | Files | Size |
| --- | --- | --- |
| Home Videos | 9,211 | ~1 TB |
| TV Shows | 2,746 | 2.0 TB |
| Movies | 240 | 1.0 TB |

The first pass reported the whole tree at once and produced a cheerful "76% is
mov/h264/aac". **That was home videos** - phone recordings, uniformly the friendliest
format there is - drowning out the actual library three to one. A media player's
compatibility question is about the media library, so the numbers below exclude Home
Videos and cover the **2,986 films and episodes**.

### The container is the problem, and it is nearly everything

```
MOVIES (240)                       TV SHOWS (2,746)
matroska  220 (92%)                matroska  2262 (82%)
mov        20 (8%)                 mov        266 (10%)
                                   avi        218 (8%)
```

**83% of the media library is in a container an iPhone will not open.** Not a codec it
cannot decode - a box it cannot unwrap.

### What that means per platform

- **Android direct-plays essentially all of it.** ExoPlayer handles Matroska, AVI, HEVC and
  MPEG-4 Part 2. The genuine misses are DTS (14 files) and TrueHD (5), and AC-3/E-AC-3
  (~620) is device-dependent. Call it 99%.
- **iOS direct-plays about 10%** - the 286 `mov` files and nothing else.

**A direct-play-only iOS build would show a user one tenth of their own collection.**
That is not a shippable iOS experience, and it is the finding that matters most here.

### The repair ladder, cheapest first

- **Remux only** (rewrap, no re-encode): the large majority. Every Matroska file whose
  streams an iPhone already accepts - H.264 or HEVC video with AAC audio - which is 190 of
  the movies and 1,635 of the episodes. **~61% of the library is a container rewrite and
  nothing else.**
- **Remux plus AUDIO-only re-encode**: ~650 files, dominated by HEVC+AC-3 television.
  Audio is a rounding error against video to encode, so this is still cheap. **Uncertain by
  how much**: Apple does support Dolby Digital and Dolby Digital Plus in MP4, so a good part
  of this bucket may survive a plain remux. The client settles it; do not plan around either
  answer.
- **Full video transcode**: the 218 AVI/MPEG-4-Part-2 files, 7% of the library, all in TV
  Shows. The only bucket that needs a real encoder.

**Consequence: remux is not an optimisation, it is the iOS release.** The order is
container first, audio second, video encoding last - and video encoding could be skipped
entirely for a long time without most of the library noticing.

### HEVC was underestimated, exactly as the proposal warned

**HEVC is 64% of the television library** (1,766 of 2,746). The proposal named it as the
underestimated one and it was right. It is not a problem for Android or for iOS-in-MP4;
it is a problem for anything that assumed H.264 and for any transcode sizing done on
audio-era numbers.

### Subtitles: the image-based case is common, not exotic

```
MOVIES: 232 PGS tracks across 240 films - about one per film, and only 57 SRT
TV:     1,429 PGS against 2,715 SRT
```

The proposal said embedded PGS is image-based and forces a full transcode to burn in, so
v1 lists it and refuses it. **On the Movies collection that refusal is the common case, not
the edge case** - most film subtitle tracks here are the unusable kind. The saving grace is
383 external `.srt` files on disk, which the folder adapter can serve directly and which do
not need any of this.

### And the bandwidth assumption was pessimistic

44% of the whole tree is SD and exactly ONE file is 4K. The no-relay arithmetic assumed
8 Mbps throughout. That assumption is safe as a worst case and wrong as a typical one,
which is worth knowing before anyone sizes anything on it.

### Do not over-read this either

One person's collection. It skews toward television, and its Movies folder is small and
disc-ripped where its TV is downloaded. What it does establish beyond argument is that
**the container question dominates**, and that an iOS build without remux is not a product.

## 2026-08-12 - FIRST MEASUREMENT (25 files, superseded above): direct-play-only is well founded, and remux beats transcode
Tier: T2 (a measurement that shapes build order, not a change of scope)
Context: v1 ships direct-play only precisely so this could be measured instead of guessed.
Run against Tim's Umbrel Jellyfin (10.11.11): **1 film + 24 episodes, 30.1 GB**, one series
across four seasons.

```
mp4 / h264 / aac    24 (96%)
mkv / h264 / aac     1 (4%)
```

100% H.264, 100% AAC, 100% 1080p.

What it says, taking Android's ExoPlayer and iOS's AVPlayer as the two targets:

- **Android direct-plays 100% of it.** ExoPlayer handles both combinations, MKV
  included. The proposal's Android-first sequencing is validated by data rather than by
  convenience.
- **iOS direct-plays 96%.** The single miss is `mkv / h264 / aac`, and it fails on the
  **container only** - the streams inside are already exactly what an iPhone wants.

**Consequence for build order: remux earns its place before transcode**, and by a wide
margin. Not one file in this library needs an encoder. The only miss needs a container
rewrite, which is cheap enough to run on a Pi-class box and is not what the capacity doc's
warnings are about. Building the transcode pipeline first would have been building the
expensive thing for zero percent of a real library.

**The negative result matters as much.** No H.265, no TrueHD, no DTS anywhere - the exact
combination the proposal named as the underestimated one (`MKV + H.265 + TrueHD does not
direct-play on iOS at all`) does not appear once.

**Do not over-read this.** One series and one film is a small sample, and it is downloaded
content rather than ripped discs. Tim has confirmed his wider collection also has MKV.
Ripped Blu-rays are exactly where H.265, TrueHD, DTS and PGS subtitles live, so this does
not retire the worry - it says his current library does not exercise it, and a client built
against this data will meet the hard cases later rather than never.

### Two findings that came out of running it, not out of reasoning about it

**The first run reported 16 films and zero episodes, and that was the SERVER, not us.**
Jellyfin had one library, typed `movies`, holding both the film and the show, so it
classified every IT Crowd episode as a Movie and PearCinema faithfully repeated it. The
files were named perfectly (`The IT Crowd/Season 01/The IT Crowd - S01E01 - ....mp4`) -
Jellyfin simply never looked for a series. Fixed on the server by splitting Movies and
Shows libraries, after which the tree came back flawless: 1 series, 4 seasons, 6 episodes
each, correct numbering throughout.

This is the strongest available argument for the folder adapter. A source can be confidently
wrong about its own library, and there is a whole second question - whether PearCinema
should ever second-guess a server that calls `S01E01` a film - logged in TODO.md.
**Recommendation there: no for a server source** (Jellyfin is the authority on its own
library and disagreeing would give two contradictory UIs on one machine), **yes for the
folder adapter**, which has no server to defer to.

**Resolution was being named by HEIGHT, and that filed most of cinema as 720p.** The 1080p
copy of 2001 is 1918x864 - scope ratio, bars cropped rather than encoded - so it read
"864p". Television is 16:9 and reads identically either way, which is why height looked
correct right up until the library was films. Now named by width, and the library correctly
reads 100% 1080p. Fixed in `items.resolutionLabel`, which the codec report defers to so the
two can never disagree.

## 2026-08-12 - the operator brings their own metadata API key
Tier: T2
Context: the opt-in online metadata pull needs a credential. Ship a PeerLoom one, or ask
the operator for theirs.
Choice: **the operator brings their own.** PearCinema ships no credential.
Why: a shipped key in an MIT repo is extractable and its rate limit is shared across every
install, and it would have been the first credential the suite ships.
Three consequences that are NOT optional and follow directly:
- **TMDB only, one provider.** A shipped key could have afforded two providers; a
  user-supplied one cannot, because asking for two registrations kills the feature. TMDB's
  key is free and self-serve where TVDB gates parts of its API behind a subscription.
- **No key must not look broken.** Sidecars and filename parsing still produce a working
  library. Missing key means no posters for unorganised files, said plainly, not an error.
- **The setup step is the whole risk.** Direct link to the key page, paste field, and a
  Test button that validates before saving. A key that silently fails is worse than none,
  because the library just looks wrong.
Also decided: the App Store demo library (public-domain films) WAITS until there is an app
to demo. Deferred deliberately, with the note that sourcing has lead time and must start
before submission rather than at it.

## 2026-08-12 (later) - folders in v1, no TV client, casting only
Tier: T2
Context: Tim read the two resolved questions and adjusted both.
Choice: (a) the folder adapter moves INTO v1 rather than v2, with Jellyfin first only as
the faster path to first playback. (b) On top of sidecar metadata, an OPT-IN online
metadata pull, default off, with pre-filled provider config and pre-filled match candidates
the operator confirms. (c) The Android TV client is scrapped for now. Chromecast push is
the entire TV story.
Why: "we definitely want folders" - the folder adapter is the moat and deferring it read as
optional. The opt-in pull covers libraries with no sidecars, which filename parsing alone
serves badly, without making a third-party lookup the default. Results cache to the data
dir and not into the library, which is mounted read-only by design. On the TV client: the
costing stands and is kept in the proposal, because the question returns once casting's
browse-on-a-phone limitation is felt in real use.
Superseded: the parts of the two 2026-08-12 entries below that scheduled folders and a TV
client for v2. The reasoning in them still holds and is why these calls are safe.

## 2026-08-12 - the folder adapter reads sidecar metadata, not TMDB
Tier: T2
Context: open question #2 of the video-deltas proposal asked whether PearCinema is
Jellyfin-only forever. It was framed as a product fork in the road on the assumption that a
folder adapter needs an online metadata service.
Choice: Jellyfin and Emby for v1, folder adapter committed for v2, reading **local sidecar
files**: Kodi-format `.nfo` XML plus `poster.jpg` / `fanart.jpg` / `banner.jpg`.
Why: the assumption was wrong, which collapses the fork into a sequencing question.
Self-hosted video libraries are overwhelmingly populated by Sonarr/Radarr or scanned by
Jellyfin/Emby/Kodi, all of which write metadata to disk beside the media. So a folder
library gets titles, synopses, cast, episode ordering and artwork with zero network calls,
no API key and nothing learning what you own - a TMDB dependency would have been the first
outbound metadata call anywhere in the suite. PearTune's `FolderAdapter._coverFile` already
does this shape for album art. Fallback with no sidecars is filename parsing, which yields
title, year and SxxEyy, and the UI should say so rather than look broken.
The part of the original question that SURVIVES: the folder adapter is the moat. Reading
only Jellyfin makes PearCinema an accessory to a project that can improve its own remote
access whenever it likes. Deferring is fine, dropping is not.

## 2026-08-12 - Android TV client is v2, Chromecast ships in v1
Tier: T2
Context: open question #1 asked whether a TV client beats casting, and whether it is
cheaper than the transcode pipeline.
Choice: build it, in v2. Chromecast push still ships in v1.
Why: the toolchain is free - `react-native-tvos` plus the `@react-native-tvos/config-tv`
Expo plugin is the documented path, and PearTune's existing Expo SDK 54 / RN 0.81.5 stack
is exactly the supported pairing with RNTV 0.81-stable, so no SDK migration. Android TV is
arm64/x86_64 Android, so the worklet and addon slices are already-solved problems, and
direct play gets EASIER because TV boxes have better codec support than phones.
**The whole cost is the UI.** PearCinema's UI is a WebView, Chromium does not ship the CSS
spatial-navigation spec, so D-pad focus has to be implemented in JavaScript, with a focus
model and visible focus rings on every screen. That is a second UI, not a port, and it is
the largest chunk after the host extraction - still smaller than a correct transcode
pipeline with seek. Chromecast ships first because the security machinery already exists in
`peartune/host/cast.js` and the Default Media Receiver needs no published app; it is just a
worse product, since browsing happens on a 6-inch screen while a 55-inch one plays.

## 2026-08-12 - the name is PearCinema
Tier: T0 (but expensive to change later)
Context: Tim proposed "PearTube" for the video sibling of PearTune.
Choice: PearCinema.
Why: PearTube is a YouTube trademark risk - Google enforces the "-tube" suffix against
app-store listings. PearFlix fails the same way against Netflix. PearVideo is already a
shipped app with 1M+ downloads (`com.pearvideo.tec.android`). PearScreen collides with
PearGuard, which is the screen-time app. PearReel runs into Instagram Reels regardless of
the word predating it by a century. PearCinema is clear, unused, and says what it is.

## 2026-08-12 - no relay key, ever, and bring-your-own instead
Tier: T3
Context: PearTune ships a PeerLoom-run blind relay as the off-LAN backstop for users whose
hole-punch never lands. Tim asked for the relay off by default, or absent entirely.
Choice: bake in NO relay key. Offer a settings field for a relay the user runs themselves.
Why: PearTune's relay carried 163 MB in six days against a 500 GB/month tier. Video at
8 Mbps is 3.6 GB per HOUR, so one user watching two hours a day costs 216 GB/month alone.
That is an unbounded bill scaling with adoption. Mechanically free to do:
`relayThroughFor` only returns a key when `(force || randomized) && useRelay && relayKey`.
Cost, accepted and to be stated in the store listing rather than hidden: users on
symmetric NAT at both ends have no direct path and cannot reach their library off-LAN.

## 2026-08-12 - extract @peerloom/host, do not fork PearTune's
Tier: T3
Context: roughly two thirds of PearTune's host is media-agnostic. The obvious move was a
copy-fork, which is what the suite did for the seeder, `release.sh` and the release library.
Choice: extract `@peerloom/host` first. PearCinema is its first consumer. PearTune migrates
onto it on a branch, merged only after the iOS 1.0.0 App Review outcome is known.
Why: all three previous copy-forks are still open TODO items and the seeder had already
diverged by the time it was written down. This fork would be ten times the size and covers
the firewall gate, the grant store and the revoke path, where two divergent copies is a
security problem rather than a tidiness one. `@peerloom/core` is the cautionary case here,
not the model: its donor apps were never migrated.

## 2026-08-12 - v1 is direct-play only
Tier: T2
Context: video needs transcoding far more than music does, and PearTune's measured
capacity numbers (200+ concurrent audio transcodes on an N100) do not survive the move.
Choice: ship v1 with Jellyfin as the only source, direct play only, no transcode, no remux.
Why: the expensive and genuinely uncertain part of this app is which files in a real
library actually play on a real phone. Direct-play-only answers that with data in days.
Building a transcode pipeline first means building it against a guess.
