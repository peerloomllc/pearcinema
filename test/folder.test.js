// The folder source, end to end over a real directory tree.
//
// THIS IS THE MOAT. If PearCinema only ever reads Jellyfin it is a Jellyfin
// accessory. So this answers the same interface, in the same shapes, and nothing
// above it learns which adapter is underneath.
//
// The tree built below mirrors Tim's real library, including the parts that are
// awkward: a flat `Blurays/` folder of films with no per-film directory, a show
// whose folder name and filenames disagree, and a season folder that is really a
// disc number.
//
// ffprobe is stubbed. What it returns is exercised by probe.test.js and by the
// real scans; what matters here is the wiring, the cache, the tree and the
// path-resolution guard.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const { createProtocol } = require('@peerloom/host')
const { FolderAdapter } = require('../host/adapters/folder')

const protocol = createProtocol({ app: 'pearcinema' })
const LIB = protocol.ids.libraryId(require('hypercore-crypto').keyPair().publicKey)

// A stand-in ffprobe. Writing a real MKV in a unit test would be testing ffmpeg.
const FAKE_FFPROBE = path.join(__dirname, 'fixtures', 'fake-ffprobe.js')

const KING_KONG_NFO = `\uFEFF<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>King Kong</title>
  <plot>A giant ape.</plot>
  <year>2005</year>
  <runtime>187</runtime>
  <genre>Adventure</genre>
  <art><poster>F:\\Video\\Movies\\King Kong-poster.jpg</poster></art>
</movie>`

async function library (t, { extra = {} } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-folder-'))
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-data-'))

  const files = {
    // A flat shelf of films, exactly like the real `Blurays/` folder.
    'Blurays/Deadpool.mkv': 'x',
    'Blurays/Blade Runner 2049.mkv': 'x',
    'Blurays/King Kong.mkv': 'x',
    'Blurays/King Kong.nfo': KING_KONG_NFO,
    'Blurays/Blade.1998.1080p.BluRay.x265-RARBG.mp4': 'x',

    // A show whose folder and filenames disagree about the article.
    'The Legend of Korra/Season 01/Legend of Korra - s01e01.mkv': 'x',
    'The Legend of Korra/Season 01/Legend of Korra - s01e02.mkv': 'x',
    'The Legend of Korra/Season 02/Legend of Korra - s02e01.mkv': 'x',

    // A season folder that is really a DISC number.
    'MST3K - Complete 35 DVD Collection/MST3K DVD 18/MST3K - S05E11 - The Gunslinger.avi': 'x',

    // Noise that must not become library rows.
    'Blurays/poster.jpg': 'x',
    'Blurays/notes.txt': 'x',
    'The Legend of Korra/Season 01/Extras/Behind the Scenes.mkv': 'x',
    ...extra
  }

  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, body)
  }

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  return { root, dataDir }
}

function adapter ({ root, dataDir, roots = null }) {
  return new FolderAdapter({
    roots: roots || [root],
    dataDir,
    libraryId: LIB,
    ids: protocol.ids,
    ffprobe: process.execPath + ' ' + FAKE_FFPROBE
  })
}

// The fake ffprobe is invoked as an argv0; probe.js calls execFile(cmd, args), so
// a two-word command will not work. Build the adapter with a wrapper script path
// instead and let probe.js exec it directly.
function realAdapter ({ root, dataDir, roots = null }) {
  return new FolderAdapter({
    roots: roots || [root],
    dataDir,
    libraryId: LIB,
    ids: protocol.ids,
    ffprobe: FAKE_FFPROBE
  })
}

test('a folder becomes a library: films flat, shows as a tree', async (t) => {
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })

  const count = await a.scan()
  assert.ok(count > 0)

  const stats = await a.stats()
  assert.equal(stats.source, 'folder')
  assert.equal(stats.movies, 4, 'four films on the flat shelf')
  assert.equal(stats.series, 2, 'Korra and MST3K')
  assert.equal(stats.episodes, 4)

  const films = await a.list({ type: 'movies' })
  const titles = films.items.map(m => m.title)
  assert.ok(titles.includes('Deadpool'))
  assert.ok(titles.includes('Blade Runner 2049'), 'the year trap does not bite here either')
  assert.ok(titles.includes('Blade'))
})

test('NOISE DOES NOT BECOME LIBRARY ROWS', async (t) => {
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const all = [...(await a.list({ type: 'movies' })).items]
  assert.ok(!all.some(m => /poster|notes/i.test(m.title)), 'artwork and text files are not films')

  // An Extras folder is not an episode of the show it sits in.
  const korra = (await a.list({ type: 'series' })).items.find(s => s.title === 'The Legend of Korra')
  assert.equal(korra.episodeCount, 3, 'the behind-the-scenes extra is not an episode')
})

test('THE SIDECAR WINS over the filename, on a real tree', async (t) => {
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const kong = (await a.list({ type: 'movies' })).items.find(m => m.title === 'King Kong')
  assert.ok(kong)
  assert.equal(kong.year, 2005, 'the filename had no year; the sidecar did')
  assert.equal(kong.runtime, 187 * 60, 'and minutes became seconds')
  assert.deepEqual(kong.genres, ['Adventure'])
  assert.equal(kong.overview, 'A giant ape.')
})

test('the show folder names the show, and a DISC folder does not name a season', async (t) => {
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const shows = (await a.list({ type: 'series' })).items
  const korra = shows.find(s => s.title === 'The Legend of Korra')
  assert.ok(korra, 'the folder article survives even though the files drop it')

  const seasons = await a.list({ type: 'seasons', seriesId: korra.id })
  assert.deepEqual(seasons.items.map(s => s.number), [1, 2])

  // MST3K DVD 18 holds S05E11. The filename wins.
  const mst = shows.find(s => s.title.startsWith('MST3K'))
  const mstSeasons = await a.list({ type: 'seasons', seriesId: mst.id })
  assert.deepEqual(mstSeasons.items.map(s => s.number), [5], 'a disc number is not a season')
})

test('episodes come back in structural order under their season', async (t) => {
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const korra = (await a.list({ type: 'series' })).items.find(s => s.title === 'The Legend of Korra')
  const [s1] = (await a.list({ type: 'seasons', seriesId: korra.id })).items
  const eps = await a.list({ type: 'episodes', seasonId: s1.id })

  assert.equal(eps.total, 2)
  assert.deepEqual(eps.items.map(e => e.episodeNumber), [1, 2])
  assert.equal(eps.items[0].seriesTitle, 'The Legend of Korra')
})

// --- streaming and the path guard -------------------------------------------

test('a film streams, and SEEKS, straight off the disk', async (t) => {
  const { root, dataDir } = await library(t, {
    extra: { 'Blurays/Payload.mkv': 'ABCDEFGHIJ' }
  })
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const film = (await a.list({ type: 'movies' })).items.find(m => m.title === 'Payload')
  assert.ok(film)

  const read = (stream) => new Promise((resolve) => {
    let out = ''
    stream.on('data', (d) => { out += d })
    stream.on('end', () => resolve(out))
  })

  assert.equal(await read(await a.stream({ itemId: film.id })), 'ABCDEFGHIJ')
  assert.equal(await read(await a.stream({ itemId: film.id, offset: 4 })), 'EFGHIJ')
  assert.equal(await read(await a.stream({ itemId: film.id, offset: 4, length: 3 })), 'EFG')
})

test('AN ID IS NEVER TREATED AS A PATH', async (t) => {
  // The map is the whole mechanism. A lookup that ever fell back to treating the
  // id AS a path would turn media.stream into arbitrary file read on the host.
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()

  for (const attempt of [
    '/etc/passwd',
    '../../../../etc/passwd',
    path.join(root, 'Blurays', 'Deadpool.mkv'),
    'Blurays/Deadpool.mkv'
  ]) {
    assert.equal(await a.stream({ itemId: attempt }), null, `must refuse: ${attempt}`)
  }
})

test('a file deleted since the scan is a clean miss, not a broken stream', async (t) => {
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const film = (await a.list({ type: 'movies' })).items.find(m => m.title === 'Deadpool')
  await fsp.rm(path.join(root, 'Blurays', 'Deadpool.mkv'))

  assert.equal(await a.stream({ itemId: film.id }), null)
})

test('THE ABSOLUTE PATH NEVER LEAVES THE ADAPTER', async (t) => {
  // It would tell every paired phone the shape of somebody's disk.
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const wire = JSON.stringify([
    await a.list({ type: 'movies' }),
    await a.list({ type: 'series' }),
    await a.stats()
  ])
  assert.ok(!wire.includes(root), 'no host path may appear in anything served')
  assert.ok(!wire.includes('_file'))
})

// --- an unplugged drive -----------------------------------------------------

test('AN UNREADABLE FOLDER IS A THROW, not an empty library', async (t) => {
  // "Your drive is not there" and "your library is empty" are different sentences,
  // and the second one is a lie that sends an operator hunting in the wrong place.
  const { dataDir } = await library(t)
  const a = new FolderAdapter({
    roots: ['/definitely/not/mounted'],
    dataDir,
    libraryId: LIB,
    ids: protocol.ids,
    ffprobe: FAKE_FFPROBE
  })

  await assert.rejects(() => a.scan(), /no configured folder is readable/)
  assert.equal((await a.ping()).ok, false)
})

test('ONE MISSING ROOT DOES NOT TAKE THE OTHERS DOWN', async (t) => {
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir, roots: [root, '/definitely/not/mounted'] })

  const count = await a.scan()
  assert.ok(count > 0, 'the readable root still produced a library')

  const stats = await a.stats()
  assert.match(stats.sourceError, /not readable/, 'and the missing one is reported rather than hidden')

  const health = await a.ping()
  assert.equal(health.ok, true)
  assert.match(health.detail, /1 of 2/)
})

test('no folders configured says so, and does not pretend to be empty', async (t) => {
  const { dataDir } = await library(t)
  const a = new FolderAdapter({ roots: [], dataDir, libraryId: LIB, ids: protocol.ids })
  assert.equal((await a.ping()).detail, 'no folders configured')
  await assert.rejects(() => a.scan(), /no folders configured/)
})

// --- the cache --------------------------------------------------------------

test('THE CACHE SPARES A RESCAN, because 12,000 files is twenty minutes of disk', async (t) => {
  const { root, dataDir } = await library(t)

  const first = realAdapter({ root, dataDir })
  await first.scan()
  const before = (await first.list({ type: 'movies' })).total

  // A fresh adapter on the same data directory loads rather than walks. Proven by
  // making the library unreadable: a walk would throw, a cache load cannot.
  const second = realAdapter({ root, dataDir })
  second.visibleRoots = () => { throw new Error('must not walk') }
  await second.scan()

  assert.equal((await second.list({ type: 'movies' })).total, before)
  assert.ok(second.scannedAt)
})

test('the cache is refused when it describes a DIFFERENT library', async (t) => {
  const { root, dataDir } = await library(t)
  await realAdapter({ root, dataDir }).scan()

  // Different roots, same data directory: the cached rows are about somewhere else.
  const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-other-'))
  t.after(() => fsp.rm(other, { recursive: true, force: true }))

  const a = realAdapter({ root: other, dataDir })
  await a.scan()
  assert.equal((await a.list({ type: 'movies' })).total, 0, 'it rescanned rather than trusting the cache')
})

test('a forced scan ignores the cache', async (t) => {
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()
  const before = (await a.list({ type: 'movies' })).total

  await fsp.writeFile(path.join(root, 'Blurays', 'Newcomer.mkv'), 'x')

  // A fresh adapter reading the cache does NOT see it - that is the point of a
  // cache, and why an explicit rescan exists.
  const cached = realAdapter({ root, dataDir })
  await cached.scan()
  assert.equal((await cached.list({ type: 'movies' })).total, before)

  const fresh = realAdapter({ root, dataDir })
  await fresh.scan({ force: true })
  const after = await fresh.list({ type: 'movies' })
  assert.equal(after.total, before + 1)
  assert.ok(after.items.some(m => m.title === 'Newcomer'))
})

// --- search and get ---------------------------------------------------------

test('search finds films and episodes by title and by show', async (t) => {
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()

  assert.ok((await a.search({ q: 'deadpool' })).items.some(m => m.title === 'Deadpool'))
  assert.ok((await a.search({ q: 'korra' })).items.length > 0)
  assert.deepEqual((await a.search({ q: '' })).items, [])
})

test('get answers by id and misses cleanly', async (t) => {
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const film = (await a.list({ type: 'movies' })).items[0]
  assert.equal((await a.get({ id: film.id })).title, film.title)
  assert.equal(await a.get({ id: 'nope' }), null)
})

test('the adapter refuses to be built without the protocol id factory', () => {
  assert.throws(() => new FolderAdapter({ roots: ['/x'] }), /needs the protocol id factory/)
})
