// The entry the SERVICE runs - systemd user unit on Linux, LaunchDaemon on
// macOS - under ELECTRON_RUN_AS_NODE, which turns the installed Electron binary
// into plain Node with asar support.
//
// It exists for one reason: the bundled ffmpeg lives at resources/ffmpeg/,
// outside app.asar, and the host's own resolution cannot find it from inside
// the archive (see ffmpeg-env.js). The tray app fixes that up from Electron's
// process.resourcesPath; a plain-Node service has no such thing, so this shim
// derives resources/ from its own location and then hands over to the host's
// normal CLI entry.
//
// The layout this counts on: packed, this file is at
// resources/app.asar/src/main/service-entry.js, so three levels up is
// resources/. In the dev tree it is desktop/src/main/, three up is desktop/,
// where no ffmpeg/ dir exists - the setter checks existence, so dev runs simply
// fall through to the system PATH.

const path = require('path')
const { pointAtBundledFfmpeg } = require('./ffmpeg-env')

pointAtBundledFfmpeg(path.resolve(__dirname, '..', '..', '..'))

// The host CLI only self-starts when it IS the main module (require.main
// guard), and under this shim it is not - so start it explicitly.
require('../../vendor/host/index.js').main().catch((e) => {
  process.stderr.write(`host failed to start: ${e.stack || e.message}\n`)
  process.exit(1)
})
