# PearCinema

Your film and television collection, playable anywhere, without exposing your server to
the internet. No port forwarding, no VPN, no dynamic DNS, no account, no cloud copy of
your files.

The library stays on a machine somebody owns - an Umbrel, a NAS, an old desktop - and a
phone reaches it directly over an encrypted peer-to-peer connection. Nothing is published
to the internet and no file is ever copied to anybody else's server.

**That machine does not have to be yours.** A library's owner can let a friend or a family
member in, each as their own person holding their own devices, and cut any of them off
again within seconds.

It is the video sibling of [PearTune](../peartune) and shares its proven host.

## What you need

- A computer to keep the films on. Anything that runs Docker or Node 20 will do; an Intel
  N100 mini PC is plenty, and that is what most of this was measured on.
- The films themselves, in folders, or a Jellyfin or Emby server you already run.
- A phone, a browser, or both.

## Getting the server running

### On an Umbrel, from the app store

The easiest way, and the one to prefer: the platform installs it, keeps it running and
updates it.

In umbrelOS, add the PeerLoom community app store
(`https://github.com/peerloomllc/peerloom-umbrel-app-store`), then install **PearCinema**
from it. The dashboard's password is the one umbrelOS shows next to the app.

It looks for films in the Umbrel's own `Downloads` folder to begin with. Most film
libraries are on an external drive instead, so open Settings and pick the folder under
`/external` - every drive plugged into the box appears there, including one plugged in
after the app started.

Moving over from a hand-run container? `host/migrate-to-umbrel-app.sh` carries the
identity, the grants and the scan across, so nothing has to pair again. It MOVES the data
rather than copying it, deliberately: the store refuses to open a copy, because two copies
of one library on a machine would corrupt each other.

### With Docker

```
docker run -d --name pearcinema-host --restart unless-stopped --network host --device /dev/dri:/dev/dri -e PEARCINEMA_HTTP_HOST=0.0.0.0 -e PEARCINEMA_PASSWORD=choose-one -e PEARCINEMA_DATA=/data -e "PEARCINEMA_FOLDERS=/library/Movies:/library/TV Shows" -v /path/to/pearcinema-data:/data --mount "type=bind,source=/path/to/media,target=/library,bind-propagation=rslave" ghcr.io/peerloomllc/pearcinema-host:0.1.6
```

There is deliberately no `latest` tag. A version is what an install can be reproduced
from and rolled back to, and `umbrel/docker-compose.yml` goes further and pins the digest.
Published tags are listed at
[ghcr.io/peerloomllc/pearcinema-host](https://github.com/orgs/peerloomllc/packages/container/package/pearcinema-host).

Build that image yourself with `bash host/build-image.sh <version>`, which works with
docker or podman and always builds x86 and arm64 together.
`umbrel/docker-compose.yml` is the same thing as compose, with the reasoning behind every
line written into it, and `host/redeploy-umbrel.sh` is that run command with a drive that
moves and a container that has to survive it.

Two of those flags are load-bearing and worth not "simplifying" away:

- **`--network host`.** Docker's own bridge is a second layer of NAT and peer-to-peer
  connections do not survive it. Measured twice on a real Umbrel: under the default bridge
  the phone is admitted and the connection dies before it can pair.
- **`--device /dev/dri`.** That is the machine's graphics chip, which is what converts a
  film your phone cannot play. Leave it out and everything still works, minus converting.
  On an NVIDIA machine pass `--gpus all` instead, with the NVIDIA Container Toolkit
  installed.

### From source

```
npm install && npm run host
```

Then open `http://localhost:8751` and point it at a folder or a Jellyfin server on the
first-run screen. The command line does all of it too, which is the right answer over ssh:

```
npm run host -- --folder /media/Movies --folder "/media/TV Shows" --pair
```

```
npm run host -- --jellyfin http://your-server:8096 --user you --pass secret --pair
```

`--test` checks a source without saving it or starting the host, and `--pair` prints a
pairing code as a QR in the terminal.

### As a desktop app

`desktop/` is the same host wrapped in a tray or menu-bar app for Mac, Windows and Linux,
so a laptop can serve a library without a terminal. See `desktop/README.md`.

## Getting the app

**Android**: install it from [Zapstore](https://zapstore.dev/apps/com.pearcinema), or
take the `.apk` from the [latest release](https://github.com/peerloomllc/pearcinema/releases/latest).

**iPhone**: with Apple review. **Google Play**: on the way.

**A browser**: no app needed at all. The dashboard at `http://localhost:8751` plays the
library itself, on the machine or across the house.

To build either app yourself:

- **Android**: `npx expo prebuild` then `cd android && ./gradlew assembleDebug`, and
  install the APK.
- **iOS**: `bash scripts/ios-sim-build.sh` for a Simulator, or
  `bash scripts/ios-device-build.sh` for a signed build on a real iPhone. Both build on a
  Mac over ssh; read the headers, which carry everything the first attempt got wrong.

## Pairing a phone

Open the dashboard, press **Pair a device**, and scan the code with the app. That is the
whole ceremony. A pairing code works once, and the phone that used it is remembered by its
own key rather than by a password anybody can pass on.

Every device belongs to a **person**, and a person's devices follow each other: stop a film
on the phone, and the place is waiting on the desktop. The owner can move a device to a
different person, hide a television from somebody's phones, or cut a device off entirely.

**Cutting a device off takes effect immediately.** It does not wait for the film to end or
for the connection to drop, and it stops a television the phone had already started.

## What it can play

Your server decides, per film and per device, and it always takes the cheapest honest
route:

1. **Play it as it is**, whenever the device says it can open that file. Nothing is
   touched and seeking is instant.
2. **Repackage it**, when the picture and the sound are fine and only the wrapper is
   wrong. Nothing is re-encoded.
3. **Convert it**, when there is no other way, on the machine's graphics chip - Intel and
   AMD through VAAPI, NVIDIA through NVENC. There is no software conversion anywhere, on
   purpose: an N100 manages one software stream and eight hardware ones.

Nothing about that is guessed. Each device says what it can open - an Android phone asks
its own chip, a browser asks itself, a television is asked over the network - and the
server answers what it was actually told. Where a device says nothing, the conservative
answer wins, because a wasted conversion costs some electricity and a wrong guess costs
somebody a black screen.

The dashboard can **measure your machine** rather than quoting somebody else's: it converts
a real film from your library at rising concurrency for about a minute and reports how many
streams your box keeps up with, then uses that as the ceiling on the setting.

Subtitles come along, including the picture-based kind from discs, which have to be pressed
into the film to travel at all.

## Watching on a television

The phone can send a film to a television and then act as its remote, from the lock screen
if you like. Two kinds are found on your own network with no configuration: **Rokus** and
**DLNA televisions** (most Samsungs, LGs and Sonys). Anything else your server cannot find
by itself can come through **Home Assistant**, if you run it.

A Roku also needs the free **Media Assistant** channel from the Roku channel store, which is
what lets it be told to play. Until it is installed the Roku is found but not offered, and
both the dashboard's Casting page and the phone's television picker name it and say so.

Each television is asked what it plays and what it takes for sound, and remembered, so a
film that suits it goes untouched rather than being converted for a device that never
needed it.

## Away from home

On the same network it is direct. Away from home, the two ends punch through their routers
and connect directly, which works for most people and not for everybody: some routers,
at both ends at once, leave no direct path.

**When there is no direct path, PearCinema falls back to a relay** run by PeerLoom, which
forwards encrypted data it cannot read and keeps no copy of it. It is offered only after a
direct connection has actually failed, or where our own network makes one impossible - so
the ordinary case never touches it. A relayed film is held near 2.5 Mbps, the app says so
while it lasts, and it shows what has crossed this month.

This reverses an earlier decision, and the arithmetic behind that one still stands: video
at 8 Mbps is 3.6 GB an hour, and a service quietly paying for that is a service that
eventually stops. What the arithmetic missed was that being right about it meant a phone on
mobile data could not reach its own library at all. So there is no hard cap, and you can
**bring your own relay** instead: run the daemon on a VPS you control and paste its key
into the app, and yours is the one that gets used.

## Where your library lives

- **Your files never leave your machine.** They are read where they are, and streamed to a
  device that asked for them.
- **Nothing is published.** There is no port to open and no address to hand out. Devices
  find each other on a distributed hash table by keys they exchanged when you paired them.
- **The allow-list lives on your server and is never shared.** That is what makes cutting
  somebody off final rather than advisory.
- **Artwork and summaries are opt-in.** PearCinema reads what is already beside your files
  first; asking TMDB for the rest is a switch you turn on, with your own key.

## Status

**Released, on one store of three.** 1.1.0 is on
[Zapstore](https://zapstore.dev/apps/com.pearcinema) and on
[GitHub](https://github.com/peerloomllc/pearcinema/releases/latest) with the Android app
and desktop installers for Linux, Windows and macOS. The iPhone build is with Apple
review; Google Play is on the way.

The server runs a real 3,000-item library on a real Umbrel; there are Android, iOS and
desktop clients, a browser player, casting, downloads for offline, subtitles, multiple
libraries blended into one, and hardware conversion on three vendors' chips.

It is a real Umbrel app rather than a hand-run container, published for both x86 and
arm64, so the platform owns it and brings it back after a restart.

`TODO.md` is the honest list of what is still open.

## Developing

```
npm install
npm run verify        # tests, then rebuild both bundles
```

`npm run verify` runs the tests BEFORE it rebuilds, so rebuild, then verify, then trust
it. The web pages are built artefacts and committed:

```
npm run build:dashboard   # the server's own page
npm run build:ui          # the phone's page
npm run build:icons       # every shipped icon, from assets/icon.svg
```

The layout:

```
host/          the server: sources, streaming, casting, conversion, the dashboard
src/           the phone app's UI and its Bare worklet
app/           the React Native shell around it
desktop/       the tray app
umbrel/        the container packaging
scripts/       build and measurement tooling
```

`@peerloom/host` is the shared peer-to-peer half, and PearCinema is its first consumer
besides PearTune. `CLAUDE.md` carries the working rules, `DECISIONS.md` the reasoning
behind the choices that were hard, and `proposals/` the two designs this app was built
from.

## Why not just add video to PearTune

Music and video look similar and behave nothing alike. Music peaks near 1.5 Mbps and video
runs 4 to 80. An N100 paces 200 concurrent audio conversions and well under one software
video conversion. Nobody scrubs a song and everybody scrubs a film. Music is mp3, m4a and
flac, which play everywhere; video is Matroska and HEVC and Dolby, which play almost
nowhere without help. Bolting all of that onto a shipped music player would make PearTune
worse at music, so the peer-to-peer substrate is shared and the media layer is not.

## Licence

MIT, like the rest of the suite. Do not take a dependency on `holesail` or any
`@holesail/*` package: they are AGPL-3.0 or GPL-3.0 and would drag copyleft across the
app. `hyperdht` and `hyperswarm` are MIT and give us what we need directly.
