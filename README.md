# PearCinema

The films and shows on your own server, or a friend's, playable anywhere. No port forwarding, no VPN, no dynamic DNS, no account, no cloud copy of your files.

PearCinema is a peer-to-peer video player. The library stays on a machine someone owns - an Umbrel, a NAS, an old desktop - and a phone reaches it directly over an encrypted peer-to-peer connection. Nothing is exposed to the internet, and files are never copied to anyone else's server.

That machine does not have to be yours. A library's owner can let a friend or family member in, each as their own person with their own devices, and cut any of them off again in a second.

It is the video sibling of [PearTune](../peartune), and it is built on the same proven host.

## Status

**The host runs, reads a real library and you can watch it in a browser. No phone
client yet.**

Both T3 proposals are approved (`proposals/2026-08-12-video-deltas.md`, merged as PR #1,
and `../proposals/2026-08-12-shared-host.md`, approved verbally). `@peerloom/host` is
extracted and PearCinema is its first consumer, which is what makes it a shared package
rather than a rename.

What works today, proven end to end over a real DHT testnet in `test/first-pair.test.js`:

- The host starts, announces itself, and prints a pairing QR (`npm run host -- --pair`).
- A device pairs, browses the library, fetches an item, searches, and streams bytes -
  **including seeking into a film**, which is free because `media.stream` already carried
  `offset` and `length`.
- Revoke cuts a paired device off mid-connection and refuses to let it back.
- A PearTune phone cannot reach a PearCinema host, and neither app's pairing link parses
  as the other's.

- **Jellyfin and Emby work as a source**, for films, shows, seasons and episodes,
  including subtitle listing and seeking.
- **A plain folder works as a source**, with no server in the path at all. Measured
  against a real 3 TB drive: 2,986 items - 274 films, 29 shows, 2,712 episodes - read
  from filenames and the `.nfo` sidecars already sitting beside the media.
- **A web interface with a player**, password-gated, at `http://localhost:8751`.

What is not built yet:

- The phone client.
- Continue-watching, which is inherited from PearTune's `resume.*` and arrives with the
  shared user-state store.
- Casting, remux and transcode.

Run it:

```
npm install && npm run host
```

Then open `http://localhost:8751`. Point it at a folder or a Jellyfin server from the
first-run screen, and pair a phone by scanning the QR it draws.

The command line still does all of it, which is the right answer over ssh:

```
npm run host -- --folder /media/Movies --folder "/media/TV Shows" --pair
```

```
npm run host -- --jellyfin http://your-server:8096 --user you --pass secret --pair
```

`--test` checks a source without saving it or starting the host.

### The web interface

`http://localhost:8751` by default; `PEARCINEMA_HTTP_HOST`, `PEARCINEMA_HTTP_PORT` and
`PEARCINEMA_PASSWORD` move it and lock it. It does the setup, the library browsing, the
pairing QR, the device and people list with revoke - and it plays.

Two things about it are worth knowing before you judge it:

- **It sits behind the password, not beside it**, because it serves the actual film
  bytes. The host refuses to start if it would listen on anything but loopback without a
  password. A bare Docker or systemd install with no password generates one, saves it
  `0600` next to the identity seed, and prints it once.
- **It repackages what your browser will not open, and browsers disagree about that.**
  Measured rather than assumed: Chromium-based browsers (Chrome, Brave, Edge) do open an
  MKV holding H.264 and AAC, while Safari and iOS do not - and none of them decode HEVC
  or Dolby audio, which between them cover most of a real television library. So
  PearCinema asks each browser what it can open and repackages only what it must, on the
  fly, without ever re-encoding the picture. Anything that genuinely cannot be played
  says which part is the problem instead of showing a black rectangle.

The page counts it for you: above each list it says how many of these files *this*
browser can play. It is a second compatibility engine with published rules, run against
the same library, which turns "which of my files actually work" from an opinion into a
number.

The folder picker browses what the **container** can see and there is no free-text path
box, deliberately: typing the path your other app uses gets you zero files, which is
indistinguishable from an empty library. That mistake cost PearTune an evening.

Rebuild the page after changing anything under `host/ui/app/`, and commit the result:

```
npm run build:dashboard
```

### What is actually in your library?

The reason v1 is direct-play only is that nobody knows which files in a real collection
a real phone can open, and building a transcode pipeline first means building it against
a guess. So before there is a client, there is this:

```
npm run host -- --codec-report
```

It walks both roots - the flat film list and the whole show tree - and prints the
containers, codecs, resolutions and, most importantly, the **combinations** that appear
together. The combination is what decides: MKV plus H.265 plus TrueHD does not direct-play
on iOS at all, and counting those three separately would hide that.

It describes. It does not judge. Which of those a phone can actually open is what the
first client build finds out.

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
│    - the dashboard LOCK (not the page)   │
│  pearcinema video layer  (this repo)     │
│    - Jellyfin / folder video adapters    │
│    - direct play, remux, subtitles       │
│    - the web interface, with a player    │
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
