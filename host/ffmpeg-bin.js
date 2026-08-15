// WHERE ffmpeg AND ffprobe COME FROM - the one resolution point for the two
// binaries this host cannot work without (ffprobe is how the folder adapter
// reads what a file IS; ffmpeg is remux, transcode and subtitle extraction).
//
// The order, decided 2026-08-14 (see DECISIONS):
//
//   1. An explicit setting (PEARCINEMA_FFMPEG / PEARCINEMA_FFPROBE), trusted
//      verbatim - an operator who set a path meant it, and a wrong one should
//      fail loudly at use rather than be silently second-guessed.
//   2. A BUNDLED binary at vendor/ffmpeg/<platform>-<arch>/, the convention
//      the desktop packaging fills. This is what makes the desktop app work
//      on a machine that has never heard of ffmpeg - which is every consumer
//      machine. LGPL builds suffice by design: the transcode proposal forbids
//      software video encoding, so the GPL-triggering encoders are never used.
//   3. The system PATH, verified by actually running `-version` once - the
//      Docker image's distro ffmpeg arrives this way, and so does an
//      operator's own install.
//   4. An honest miss: the name is returned so a later spawn still fails, but
//      `source: 'missing'` lets startup say plainly what is absent and where
//      to put it, instead of a bare "spawn ffmpeg ENOENT" three minutes into
//      a scan.
//
// Resolution is cached per process: the PATH probe costs a process spawn and
// the answer cannot change under a running host in any way we should chase.

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'ffmpeg')

const ENV_VARS = { ffmpeg: 'PEARCINEMA_FFMPEG', ffprobe: 'PEARCINEMA_FFPROBE' }

function runs (bin) {
  try {
    return !spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 10_000 }).error
  } catch {
    return false
  }
}

// Pure resolution, everything injectable for tests. Returns { bin, source }
// where source is 'setting' | 'bundled' | 'system' | 'missing'.
function resolve (name, {
  env = process.env,
  vendorDir = VENDOR_DIR,
  platform = process.platform,
  arch = process.arch,
  probe = runs
} = {}) {
  const explicit = env[ENV_VARS[name]]
  if (explicit) return { bin: explicit, source: 'setting' }

  const exe = platform === 'win32' ? `${name}.exe` : name
  const bundled = path.join(vendorDir, `${platform}-${arch}`, exe)
  if (fs.existsSync(bundled)) return { bin: bundled, source: 'bundled' }

  if (probe(name)) return { bin: name, source: 'system' }

  return { bin: name, source: 'missing' }
}

const cache = new Map()

function resolved (name) {
  if (!cache.has(name)) cache.set(name, resolve(name))
  return cache.get(name)
}

const ffmpeg = () => resolved('ffmpeg').bin
const ffprobe = () => resolved('ffprobe').bin

// One line per binary for the startup log, and the sentence an operator needs
// when one is missing. `missing` is also surfaced so callers can warn early
// instead of letting the first scan fail mid-flight.
function report () {
  const f = resolved('ffmpeg')
  const p = resolved('ffprobe')
  const missing = [f, p].some((r) => r.source === 'missing')
  return {
    ffmpeg: f,
    ffprobe: p,
    missing,
    hint: missing
      ? `install ffmpeg, or set ${ENV_VARS.ffmpeg}/${ENV_VARS.ffprobe}, or place binaries at vendor/ffmpeg/${process.platform}-${process.arch}/ - without them a folder library cannot scan and nothing can be repackaged`
      : null
  }
}

// Tests only: resolution is cached per process and tests need fresh runs.
function _resetCache () { cache.clear() }

module.exports = { resolve, resolved, ffmpeg, ffprobe, report, VENDOR_DIR, ENV_VARS, _resetCache }
