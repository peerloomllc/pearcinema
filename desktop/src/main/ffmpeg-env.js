// Point the host at the ffmpeg/ffprobe binaries the desktop packaging ships.
//
// host/ffmpeg-bin.js resolves in this order: explicit env setting, then a
// bundled binary at <host>/../vendor/ffmpeg/<platform>-<arch>/, then the system
// PATH. Inside a packaged Electron app the middle rung is useless twice over:
// the vendored host lives inside app.asar, where a binary cannot be spawned,
// and its relative vendor/ path lands in the wrong place anyway. So the
// binaries are staged OUTSIDE the asar (electron-builder extraResources, at
// resources/ffmpeg/<platform>-<arch>/) and the env setting - the rung that is
// trusted verbatim - is set to point at them.
//
// Set only when the binary actually exists: ffmpeg-bin trusts a setting without
// checking it, so pointing at a path that is not there would turn a machine
// with a perfectly good system ffmpeg into a "spawn ENOENT" mid-scan. And an
// operator's own PEARCINEMA_FFMPEG always wins - never overwrite one.
//
// Shared by the tray app (resourcesPath from Electron) and the service entry
// (resources derived from its own location), which is why it is its own module.

const path = require('path')
const fs = require('fs')

function pointAtBundledFfmpeg (resourcesDir, env = process.env) {
  if (!resourcesDir) return
  const dir = path.join(resourcesDir, 'ffmpeg', `${process.platform}-${process.arch}`)
  const exe = (name) => process.platform === 'win32' ? `${name}.exe` : name
  for (const [name, envVar] of [['ffmpeg', 'PEARCINEMA_FFMPEG'], ['ffprobe', 'PEARCINEMA_FFPROBE']]) {
    if (env[envVar]) continue
    const bin = path.join(dir, exe(name))
    if (fs.existsSync(bin)) env[envVar] = bin
  }
}

module.exports = { pointAtBundledFfmpeg }
