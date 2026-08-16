# PearCinema Desktop

The PearCinema HOST wrapped in a tray / menu-bar app, so a Mac, Windows or Linux
machine can serve a film library without a terminal. Ported from PearTune's
desktop app, which proved the pattern on hardware.

There is no in-app window. The tray manages the host's lifecycle (run at login,
stay alive, quit); "Open dashboard" opens http://127.0.0.1:8751 in your real
browser. The dashboard binds loopback with no password - only this machine can
reach the control plane. The P2P host announces on the DHT regardless, so phones
pair and stream exactly as against a server install.

## Dev launch

```
npm install && npm start
```

`postinstall` vendors `../host` into `vendor/` and replaces the `@peerloom/host`
symlink with a real copy (see `scripts/prepack.js`).

## ffmpeg

The packaged app ships its own ffmpeg/ffprobe under `resources/ffmpeg/`, staged
from `../vendor/ffmpeg/<platform>-<arch>/` at build time. Populate that first:

```
bash scripts/fetch-ffmpeg.sh
```

LGPL builds only - see `../vendor/ffmpeg/README.md`. darwin binaries have no
trustworthy prebuilt LGPL source and must be built or sourced deliberately. A
build without staged binaries still works but leans on a system-installed
ffmpeg, which no consumer machine has.

## Builds

```
npm run build:linux      # AppImage + .deb, natively on this box
npm run build:windows    # NSIS installer, cross-built here (needs wine)
npm run build:mac        # .dmg, driven remotely on the mac-mini
```

## Always-on (Linux and macOS)

The tray app is a login item, so the library goes offline at logout. For a real
always-on host:

- The .deb installs and starts a systemd user service (plus linger) in postinst.
- An AppImage user runs `PearCinema.AppImage --install-service`.
- On macOS, `sudo /Applications/PearCinema.app/Contents/MacOS/PearCinema --install-service`
  registers a system LaunchDaemon that runs as the user.

When a service owns the host, a manually launched tray app notices the port is
already served and runs as a client - two processes never fight over one data
dir. Windows has no service slice yet; the login item covers it.
