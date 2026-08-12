# PearCinema decisions

Append-only, newest on top. Per Constitution §4.

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
