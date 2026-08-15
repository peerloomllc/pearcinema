// The one resolution point for ffmpeg and ffprobe. The order IS the contract:
// an explicit setting wins outright, a bundled binary beats the system PATH,
// the PATH is verified by running rather than assumed, and a miss stays
// honest - the name comes back so a spawn still fails where it fails today,
// but `source: 'missing'` is what lets startup print a sentence instead of
// the operator meeting "spawn ffprobe ENOENT" mid-scan.

const test = require('node:test')
const assert = require('node:assert')
const os = require('os')
const fs = require('fs')
const path = require('path')

const bin = require('../host/ffmpeg-bin')

function vendorWith (platform, arch, names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-vendor-'))
  const plat = path.join(dir, `${platform}-${arch}`)
  fs.mkdirSync(plat, { recursive: true })
  for (const n of names) fs.writeFileSync(path.join(plat, n), '#!/bin/sh\n')
  return dir
}

test('an explicit setting wins outright and is never second-guessed', () => {
  const out = bin.resolve('ffmpeg', {
    env: { PEARCINEMA_FFMPEG: '/opt/weird/ffmpeg5' },
    vendorDir: vendorWith('linux', 'x64', ['ffmpeg']),
    platform: 'linux',
    arch: 'x64',
    probe: () => true
  })
  assert.deepStrictEqual(out, { bin: '/opt/weird/ffmpeg5', source: 'setting' })
})

test('a bundled binary beats the system PATH', () => {
  const vendorDir = vendorWith('linux', 'x64', ['ffmpeg'])
  const out = bin.resolve('ffmpeg', {
    env: {},
    vendorDir,
    platform: 'linux',
    arch: 'x64',
    probe: () => true
  })
  assert.strictEqual(out.source, 'bundled')
  assert.strictEqual(out.bin, path.join(vendorDir, 'linux-x64', 'ffmpeg'))
})

test('windows binaries carry the .exe suffix', () => {
  const vendorDir = vendorWith('win32', 'x64', ['ffprobe.exe'])
  const out = bin.resolve('ffprobe', {
    env: {},
    vendorDir,
    platform: 'win32',
    arch: 'x64',
    probe: () => false
  })
  assert.strictEqual(out.source, 'bundled')
  assert.ok(out.bin.endsWith(path.join('win32-x64', 'ffprobe.exe')))
})

test('the PATH is verified by running, not assumed', () => {
  const empty = vendorWith('linux', 'x64', [])
  const found = bin.resolve('ffmpeg', { env: {}, vendorDir: empty, platform: 'linux', arch: 'x64', probe: () => true })
  assert.deepStrictEqual(found, { bin: 'ffmpeg', source: 'system' })

  const missing = bin.resolve('ffmpeg', { env: {}, vendorDir: empty, platform: 'linux', arch: 'x64', probe: () => false })
  assert.deepStrictEqual(missing, { bin: 'ffmpeg', source: 'missing' })
})

test('a wrong-platform bundle does not count', () => {
  const vendorDir = vendorWith('darwin', 'arm64', ['ffmpeg'])
  const out = bin.resolve('ffmpeg', {
    env: {},
    vendorDir,
    platform: 'linux',
    arch: 'x64',
    probe: () => false
  })
  assert.strictEqual(out.source, 'missing')
})

test('the report names both binaries and speaks plainly about a miss', () => {
  // The real environment of THIS test machine: both binaries exist (the whole
  // suite spawns them), so the cached report must find them and carry no hint.
  bin._resetCache()
  const r = bin.report()
  assert.ok(['setting', 'bundled', 'system'].includes(r.ffmpeg.source), `ffmpeg resolved via ${r.ffmpeg.source}`)
  assert.ok(['setting', 'bundled', 'system'].includes(r.ffprobe.source))
  assert.strictEqual(r.missing, false)
  assert.strictEqual(r.hint, null)
})
