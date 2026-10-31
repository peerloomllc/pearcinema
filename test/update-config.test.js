'use strict'

// The desktop update checker must recognise PearCinema's own release files on
// every platform. A pattern that matched nothing would still announce updates,
// but one that matched the wrong file (an arm64 dmg on an Intel Mac) or an older
// one would hide or misreport them. The names are 1.1.4's, as published.

const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluateRelease } = require('@peerloom/host/update-check')
const { selectAsset } = require('@peerloom/host/update-apply')
const config = require('../desktop/src/main/update-config')

const NAMES = [
  'PearCinema-1.1.4-arm64.dmg',
  'PearCinema-1.1.4.AppImage',
  'PearCinema-1.1.4.dmg',
  'pearcinema-desktop_1.1.4_amd64.deb',
  'PearCinema-Setup-1.1.4.exe',
  'pearcinema-v1.1.4.apk'
]
const release = (v, names = NAMES) => ({
  tag_name: 'v' + v,
  html_url: 'https://github.com/peerloomllc/pearcinema/releases/tag/v' + v,
  assets: names.map((n) => ({ name: n.replace(/1\.1\.4/, v), browser_download_url: 'https://x/' + n }))
})
const pick = (opts) => (selectAsset(release('1.1.4').assets, { config, ...opts }) || {}).name

test('each platform picks its own file', () => {
  assert.equal(pick({ platform: 'win32', arch: 'x64' }), 'PearCinema-Setup-1.1.4.exe')
  assert.equal(pick({ platform: 'darwin', arch: 'arm64' }), 'PearCinema-1.1.4-arm64.dmg')
  assert.equal(pick({ platform: 'darwin', arch: 'x64' }), 'PearCinema-1.1.4.dmg')
  assert.equal(pick({ platform: 'linux', arch: 'x64', appImage: '/home/me/PearCinema.AppImage' }), 'PearCinema-1.1.4.AppImage')
  assert.equal(pick({ platform: 'linux', arch: 'x64', appImage: null }), 'pearcinema-desktop_1.1.4_amd64.deb')
})

test('a newer release is announced, with its page', () => {
  const r = evaluateRelease(release('1.1.5'), '1.1.4', { config, platform: 'linux', arch: 'x64', appImage: null })
  assert.equal(r.available, true)
  assert.equal(r.latest, '1.1.5')
  assert.match(r.htmlUrl, /releases\/tag\/v1\.1\.5$/)
  assert.equal(evaluateRelease(release('1.1.4'), '1.1.4', { config, platform: 'linux', arch: 'x64' }).available, false)
})

test('a release that did not rebuild this platform is not offered here', () => {
  // A phone-only release carrying 1.1.4's desktop files forward.
  const rel = release('1.1.5')
  rel.assets = rel.assets.map((a) => a.name.endsWith('.apk') ? a : { ...a, name: a.name.replace('1.1.5', '1.1.4') })
  const r = evaluateRelease(rel, '1.1.4', { config, platform: 'win32', arch: 'x64' })
  assert.equal(r.available, false)
  assert.equal(r.reason, 'no-build-for-platform')
})
