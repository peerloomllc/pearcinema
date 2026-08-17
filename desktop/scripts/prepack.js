#!/usr/bin/env node
// Makes this Electron subproject fully self-contained for electron-builder.
// Runs from postinstall (dev launch needs vendor/ populated) and each build:*.
// Three jobs:
//
// 1. Copy the host's source (../host) into desktop/vendor/host/. SOURCE only -
//    never node_modules, the Dockerfile, deploy scripts, or host/ui/app/ (the
//    Preact source; the built host/ui/dashboard.html is what the host serves).
//
// 2. Replace the @peerloom/host SYMLINK npm made for the file: dependency with
//    a REAL copy. electron-builder walks node_modules to decide what to pack,
//    and a symlink pointing outside the project is exactly the kind of thing
//    that packs on one machine and silently vanishes on another.
//
// 3. Stage ffmpeg/ffprobe from ../vendor/ffmpeg/ into desktop/ffmpeg-staging/,
//    which package.json maps into resources/ffmpeg/ via extraResources. The
//    staging dir always exists so electron-builder never errors on a missing
//    `from` - empty just means the build ships without bundled ffmpeg and the
//    host falls back to the system PATH (host/ffmpeg-bin.js, rung 3).

const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const desktopDir = path.join(__dirname, '..')
const vendorDir = path.join(desktopDir, 'vendor')

const SKIP_DIRS = new Set(['node_modules', 'app'])
const SKIP_NAMES = new Set([
  'package.json', 'package-lock.json', 'Dockerfile', '.gitignore',
  'build-image.sh', 'redeploy-umbrel.sh'
])

function copyDir (from, to, { skipDirs = SKIP_DIRS, skipNames = SKIP_NAMES } = {}) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue
    if (entry.isFile() && (skipNames.has(entry.name) || entry.name.endsWith('.test.js'))) continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst, { skipDirs, skipNames })
    else if (entry.isFile()) fs.copyFileSync(src, dst)
  }
}

function vendorHost () {
  // Wipe vendor/ first so removed/renamed source doesn't linger in a build.
  if (fs.existsSync(vendorDir)) fs.rmSync(vendorDir, { recursive: true })

  const from = path.join(repoRoot, 'host')
  if (!fs.existsSync(from)) {
    console.error(`[prepack] missing host/ at ${from}`)
    process.exit(1)
  }
  copyDir(from, path.join(vendorDir, 'host'))

  // The blend's engine lives OUTSIDE host/ - src/merge.js, shared with the
  // phone's worklet - and host/blend.js requires it as ../src/merge. Vendored
  // beside host/ so the packaged tree keeps the same shape as the repo.
  // (Learned from the Docker image crash-looping on the same miss, 2026-08-17.)
  const srcDir = path.join(vendorDir, 'src')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.copyFileSync(path.join(repoRoot, 'src', 'merge.js'), path.join(srcDir, 'merge.js'))

  // Sanity: every file the Electron main requires, plus what the host serves at
  // runtime. A miss here is a packaged app that dies on launch with
  // MODULE_NOT_FOUND, which is a far worse place to find out than a failed pack.
  for (const f of ['host/server.js', 'host/index.js', 'host/ffmpeg-bin.js', 'host/ui/server.js', 'host/ui/dashboard.html', 'src/merge.js']) {
    if (!fs.existsSync(path.join(vendorDir, f))) {
      console.error(`[prepack] expected ${f} in vendor/ but it is missing`)
      process.exit(1)
    }
  }
  // host/index.js does require('../package.json').version for the dashboard's
  // version line, which in the repo resolves to the app's own package.json. Give
  // the vendored tree one to find, carrying the DESKTOP version - the desktop
  // rides its own release cadence and that is the version a dashboard on this
  // machine should report.
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))
  fs.writeFileSync(path.join(vendorDir, 'package.json'), JSON.stringify({
    name: 'pearcinema-vendored',
    version: desktopPkg.version,
    private: true
  }, null, 2) + '\n')

  console.log('[prepack] vendored host/ → desktop/vendor/host/')
}

function derefPeerloom (name) {
  const pkgDir = path.join(desktopDir, 'node_modules', '@peerloom', name)
  const source = path.join(repoRoot, '..', 'peerloom-' + name)

  let isLink = false
  try { isLink = fs.lstatSync(pkgDir).isSymbolicLink() } catch {}
  if (!isLink && fs.existsSync(path.join(pkgDir, 'package.json'))) {
    // Already a real copy (a previous prepack run). Refresh it anyway - a stale
    // copy of last week's package is the subtlest possible packaging bug.
    fs.rmSync(pkgDir, { recursive: true })
  } else if (isLink) {
    fs.unlinkSync(pkgDir)
  } else if (!fs.existsSync(path.join(desktopDir, 'node_modules'))) {
    // npm install has not run yet (prepack:vendor called directly in a fresh
    // tree). Nothing to dereference; postinstall will come back through here.
    console.log(`[prepack] no node_modules yet - skipping @peerloom/${name} copy`)
    return
  }

  if (!fs.existsSync(source)) {
    console.error(`[prepack] @peerloom/${name} source missing at ${source}`)
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(pkgDir), { recursive: true })
  copyDir(source, pkgDir, {
    skipDirs: new Set(['node_modules', 'test', '.git']),
    skipNames: new Set(['package-lock.json', '.gitignore', 'CLAUDE.md'])
  })
  console.log(`[prepack] @peerloom/${name} symlink replaced with a real copy`)
}

// Every platform dir the build config references gets created - package.json
// maps each target's extraResources from its own ffmpeg-staging/<plat-arch>/,
// so a Windows build never ships the Linux binaries and vice versa, and a
// missing `from` never fails the pack. An empty dir just means that target
// ships without bundled ffmpeg and leans on the system PATH.
const FFMPEG_PLATFORMS = ['linux-x64', 'win32-x64', 'darwin-arm64', 'darwin-x64']

function stageFfmpeg () {
  const staging = path.join(desktopDir, 'ffmpeg-staging')
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true })

  const source = path.join(repoRoot, 'vendor', 'ffmpeg')
  const staged = []
  for (const plat of FFMPEG_PLATFORMS) {
    const from = path.join(source, plat)
    const to = path.join(staging, plat)
    fs.mkdirSync(to, { recursive: true })
    if (fs.existsSync(from)) {
      copyDir(from, to, { skipDirs: new Set(), skipNames: new Set() })
      staged.push(plat)
    }
  }
  if (staged.length > 0) {
    console.log(`[prepack] staged ffmpeg: ${staged.join(', ')} → desktop/ffmpeg-staging/`)
  } else {
    console.log('[prepack] NO ffmpeg staged (vendor/ffmpeg is empty) - packaged apps will need a system ffmpeg')
  }
  const missing = FFMPEG_PLATFORMS.filter((p) => !staged.includes(p))
  if (missing.length > 0) {
    console.log(`[prepack] ffmpeg absent for: ${missing.join(', ')} (fetch-ffmpeg.sh / build-ffmpeg-mac.sh fill these)`)
  }
}

vendorHost()
derefPeerloom('host')
derefPeerloom('client')
stageFfmpeg()
