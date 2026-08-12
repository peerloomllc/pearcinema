# PearCinema

The films and shows on your own server, or a friend's, playable anywhere. No port forwarding, no VPN, no dynamic DNS, no account, no cloud copy of your files.

PearCinema is a peer-to-peer video player. The library stays on a machine someone owns - an Umbrel, a NAS, an old desktop - and a phone reaches it directly over an encrypted peer-to-peer connection. Nothing is exposed to the internet, and files are never copied to anyone else's server.

That machine does not have to be yours. A library's owner can let a friend or family member in, each as their own person with their own devices, and cut any of them off again in a second.

It is the video sibling of [PearTune](../peartune), and it is built on the same proven host.

## Status

**Design stage. No app code yet.**

The T3 proposal is `proposals/2026-08-12-video-deltas.md`. Per the Constitution, approval
is Tim committing that proposal. It depends on `@peerloom/host`, the shared host package
extracted from PearTune, proposed at `../proposals/2026-08-12-shared-host.md`.

## Why a separate app rather than "PearTune plays video too"

Music and video look similar and behave nothing alike:

- **Bitrate.** Music peaks around 1.5 Mbps for FLAC. Video is 4 to 20 Mbps for 1080p and
  25 to 80 for a 4K remux. Home *upload* is the binding constraint, and it decides what
  the product can honestly promise.
- **Transcoding.** An N100 paces 200+ concurrent audio transcodes. The same box does well
  under one software 1080p stream. Video needs hardware acceleration or direct play.
- **Seeking.** Nobody scrubs a song. Everybody scrubs a film, and PearTune's progressive
  no-seek transcode path is fine for the first and unacceptable for the second.
- **Formats.** MKV with H.265 and a TrueHD track is normal in a video library and plays on
  almost nothing without help. Music is mp3, m4a and flac, and those just work.

Bolting all of that onto a shipped music player would make PearTune worse at music. So the
P2P substrate is shared and the media layer is not.

## How it works

The same three-part shape as PearTune, with the host now shared:

```
┌──────────────────────────────────────────┐
│  PHONE / TV                              │
│  React Native shell    app/              │
│  WebView React UI      src/ui/           │
│  Bare worklet          worklet/          │
│    - device identity (@peerloom/core)    │
│    - HyperDHT client -> host             │
│    - local HTTP shim -> video player     │
└──────────────────────────────────────────┘
                    │ HyperDHT, Noise-authenticated
                    │ pearcinema/pair/1, pearcinema/media/1
┌──────────────────────────────────────────┐
│  HOST (Umbrel / NAS / desktop)           │
│  @peerloom/host  (shared with PearTune)  │
│    - hyperdht server + firewall gate     │
│    - grant store (local, NOT replicated) │
│    - pairing, people, revoke             │
│    - Preact dashboard                    │
│  pearcinema video layer  (this repo)     │
│    - Jellyfin / folder video adapters    │
│    - direct play, remux, subtitles       │
└──────────────────────────────────────────┘
```

## The two rules that matter most

Inherited from PearTune unchanged, and still the reason this is T3:

1. **The grant store is host-local and never replicated.** If the allow-list lived in a
   shared ledger, a revoked device could write itself back in.
2. **Revoke must kill live connections, not just future ones.** The acceptance test is
   "revoke cuts off all NEW access within a second".

## No relay

Unlike PearTune, PearCinema ships with **no relay key baked in**. PearTune's relay carried
163 MB in six days; video at 8 Mbps is 3.6 GB per *hour*, and one person watching two hours
a day would cost 216 GB a month on their own. PeerLoom is not paying for that.

The consequence is stated honestly rather than hidden: on a symmetric NAT at both ends there
is no direct path, and PearCinema will not reach that library from outside its LAN. The
answer offered is **bring your own relay** - run the daemon on your own VPS and paste its
public key. It fits the ownership pitch better than a PeerLoom-run relay ever did.

## Licence

MIT, like the rest of the suite. **Do not take a dependency on `holesail`** or any
`@holesail/*` package: they are AGPL-3.0 / GPL-3.0 and would drag copyleft across the app.
`hyperdht` and `hyperswarm` are MIT and give us what we need directly.
