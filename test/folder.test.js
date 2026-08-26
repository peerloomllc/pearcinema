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

// NO HARDWARE PROBE IN HERE - see dashboard.test.js for why.
process.env.PEARCINEMA_TRANSCODE = 'off'

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

test('TWO HALVES OF ONE FILM ARRIVE SAYING WHICH HALF THEY ARE', async (t) => {
  // The end of the road for Tim's real pair: two files, one title, and the only thing
  // that tells them apart written in the filename. A .nfo beside them describes the
  // FILM, so the marker has to survive the sidecar rather than come from it.
  const { root, dataDir } = await library(t, {
    extra: {
      'Blurays/King Kong - Pt 1.mkv': 'x',
      'Blurays/King Kong - Pt 1.nfo': KING_KONG_NFO,
      'Blurays/King Kong - Pt 2.mkv': 'x',
      'Blurays/King Kong - Pt 2.nfo': KING_KONG_NFO
    }
  })
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const kong = (await a.list({ type: 'movies' })).items.filter(m => m.title === 'King Kong')
  assert.equal(kong.length, 3, 'the whole film and both halves')
  assert.deepEqual(kong.map(m => m.part).sort((x, y) => (x || 0) - (y || 0)), [null, 1, 2])
  // The sidecar still wins the title on all three - which is exactly why the halves
  // need a part at all.
  assert.ok(kong.every(m => m.year === 2005), 'and the .nfo is still read')
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

test('A NEW PARSER REBUILDS THE ROWS AND KEEPS THE PROBES', async (t) => {
  // The half-fix this guards against: a rule changes, every deployed host goes on
  // serving rows built by the old one until something forces a rescan. The index is
  // rejected on its own version now, so the next start rebuilds it - but the probes
  // in the same file are still true, so nothing is read off the disk again.
  const { root, dataDir } = await library(t)

  const first = realAdapter({ root, dataDir })
  await first.scan()
  const before = (await first.list({ type: 'movies' })).total

  const file = first._cacheFile()
  const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.ok(Object.keys(raw.probes).length > 0, 'the probes are in there to begin with')
  const current = raw.indexVersion
  assert.ok(current > 0, 'the cache records which parser wrote it')
  raw.indexVersion = 0 // what a cache written by yesterday's parser looks like
  await fsp.writeFile(file, JSON.stringify(raw))

  // AN FFPROBE THAT CANNOT RUN is how "nothing was read off the disk again" is
  // proven rather than asserted: every file this walk had to probe would come back
  // unreadable and drop out of the library.
  const second = realAdapter({ root, dataDir })
  second.ffprobe = '/nonexistent/ffprobe-must-not-run'
  await second.scan()
  assert.equal((await second.list({ type: 'movies' })).total, before, 'the rows came back')

  const rewritten = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.equal(rewritten.indexVersion, current, 'and the rebuild stamps it with this parser')

  // The other half of the claim: with the probes gone too, that same broken ffprobe
  // empties the library - so the assertion above was about the probes being reused
  // and not about a scan that never happened.
  const stripped = JSON.parse(await fsp.readFile(file, 'utf8'))
  stripped.indexVersion = 0
  stripped.probes = {}
  await fsp.writeFile(file, JSON.stringify(stripped))
  const third = realAdapter({ root, dataDir })
  third.ffprobe = '/nonexistent/ffprobe-must-not-run'
  await third.scan()
  assert.equal((await third.list({ type: 'movies' })).total, 0)
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

// --- what a root HOLDS ------------------------------------------------------
//
// The measured bug this fixes, from the real drive on 2026-08-12: a nested file with
// no parseable episode code fell through to being a film, so 34 of 2,746 television
// files - an MST3K box set numbered `K05` - landed in the Films list. No filename
// rule settles that, because the filename genuinely does not say which episode it is.
// The ROOT does.

// Two roots, the shape a real collection is actually in.
async function split (t, files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-split-'))
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-data-'))

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

function typed ({ roots, dataDir }) {
  return new FolderAdapter({ roots, dataDir, libraryId: LIB, ids: protocol.ids, ffprobe: FAKE_FFPROBE })
}

// The real filenames, verbatim from the box set that produced the bug.
const MST3K = {
  'Shelf/MST3K - Complete 35 DVD Collection/MST3K DVD 18/MST3K - K05 - The Gunslinger.avi': 'x',
  'Shelf/MST3K - Complete 35 DVD Collection/MST3K DVD 18/MST3K - K06 - Gamera.avi': 'x',
  'Shelf/MST3K - Complete 35 DVD Collection/MST3K DVD 19/MST3K - K07 - Superdome.avi': 'x'
}

test('UNTYPED, an unreadable episode filename is still filed as a film', async (t) => {
  // The behaviour being fixed, pinned so the fix is demonstrably a change and not a
  // claim. Nothing about a root called `Shelf` says television.
  const { root, dataDir } = await split(t, MST3K)
  const a = typed({ roots: [path.join(root, 'Shelf')], dataDir })
  await a.scan()

  assert.equal((await a.stats()).movies, 3, 'three episodes, sitting in the film list')
  assert.equal((await a.stats()).episodes, 0)
})

test('A SHOWS ROOT FILES IT AS AN EPISODE OF UNKNOWN NUMBERING, never as a film', async (t) => {
  const { root, dataDir } = await split(t, MST3K)
  const a = typed({ roots: [{ path: path.join(root, 'Shelf'), type: 'shows' }], dataDir })
  await a.scan()

  const stats = await a.stats()
  assert.equal(stats.movies, 0, 'not one of them is a film')
  assert.equal(stats.episodes, 3)
  assert.equal(stats.series, 1, 'all three under the one box set')

  const [show] = (await a.list({ type: 'series' })).items
  assert.match(show.title, /MST3K/)

  const seasons = await a.list({ type: 'seasons', seriesId: show.id })
  // THE DISC FOLDERS STAY APART AND KEEP THEIR NAMES. Collapsing them into one
  // anonymous "Season" would be a different kind of wrong from the one being fixed.
  assert.deepEqual(seasons.items.map(s => s.title), ['MST3K DVD 18', 'MST3K DVD 19'])
  assert.deepEqual(seasons.items.map(s => s.number), [null, null])
  assert.equal(seasons.items[0].episodeCount, 2)

  const eps = await a.list({ type: 'episodes', seasonId: seasons.items[0].id })
  assert.deepEqual(eps.items.map(e => e.title).sort(), ['MST3K - K05 - The Gunslinger', 'MST3K - K06 - Gamera'].sort())
  assert.equal(eps.items[0].episodeNumber, null, 'unknown is null, not an invented number')
})

test('a numbered episode under a shows root is untouched, ids and all', async (t) => {
  // The type must not remint an id: every resume position on every phone is keyed by
  // one. THE SAME FOLDER read twice, untyped and then as shows, because a series id
  // is derived from the root path and two temporary copies would differ for a reason
  // that has nothing to do with the type.
  const { root, dataDir } = await split(t, { 'Shelf/The Wire/Season 01/The Wire - s01e01.mkv': 'x' })
  const at = path.join(root, 'Shelf')

  const plain = typed({ roots: [at], dataDir })
  await plain.scan()
  const before = (await plain.list({ type: 'episodes', seriesId: (await plain.list({ type: 'series' })).items[0].id })).items

  const shows = typed({ roots: [{ path: at, type: 'shows' }], dataDir })
  await shows.scan()
  const after = (await shows.list({ type: 'episodes', seriesId: (await shows.list({ type: 'series' })).items[0].id })).items

  assert.equal(before[0].seasonNumber, 1)
  assert.deepEqual(
    before.map(e => [e.id, e.seriesId, e.seasonId, e.seasonNumber, e.episodeNumber]),
    after.map(e => [e.id, e.seriesId, e.seasonId, e.seasonNumber, e.episodeNumber]),
    'declaring the root changed no id'
  )
})

test('A FILMS ROOT NEVER PRODUCES AN EPISODE, which is the same bug pointing the other way', async (t) => {
  // A number after `Part` is read as an episode when nothing says otherwise, because
  // that fallback exists for shows that never write SxxExx. A films root switches it
  // off along with every other episode rule.
  //
  // `Dune - Part 2.mkv` NO LONGER BITES even on an untyped root: a marker at the very
  // end of a name is the disc convention, and it is read as a film's half. The one
  // that still bites is the shape the fallback was actually derived from, with the
  // episode's own title after the number.
  const { root, dataDir } = await split(t, {
    'Shelf/Dune Part 2/Dune - Part 2.mkv': 'x',
    'Shelf/Band Of Brothers/Band Of Brothers Part 2 Day Of Days.mkv': 'x',
    'Shelf/Blade Runner (1982)/Blade Runner (1982).mkv': 'x'
  })
  const at = path.join(root, 'Shelf')

  const loose = typed({ roots: [at], dataDir })
  await loose.scan()
  const before = await loose.stats()
  assert.equal(before.episodes, 1, 'the fallback bites: Day Of Days became an episode')
  assert.equal(before.movies, 2, 'and the trailing marker did not - it is half of Dune')
  assert.equal((await loose.list({ type: 'movies' })).items.find(m => m.title === 'Dune').part, 2)

  const films = typed({ roots: [{ path: at, type: 'movies' }], dataDir })
  await films.scan()
  const stats = await films.stats()
  assert.equal(stats.episodes, 0)
  assert.equal(stats.movies, 3)
})

test("THE ROOT'S OWN NAME TYPES IT, so a library saved before this fixes itself", async (t) => {
  // Every host in the field saved its roots as bare paths. A folder called `TV Shows`
  // is not a guess about its contents - it is what the person who made it wrote on
  // the front - so an untyped root of that name is read as television with nothing
  // for the operator to do. This is what makes the fix reach the deployed Umbrel.
  const { root, dataDir } = await split(t, {
    'TV Shows/MST3K/MST3K - K05 - The Gunslinger.avi': 'x',
    'Movies/Blade Runner (1982).mkv': 'x'
  })

  const a = typed({ roots: [path.join(root, 'TV Shows'), path.join(root, 'Movies')], dataDir })
  await a.scan()

  const stats = await a.stats()
  assert.equal(stats.movies, 1, 'only the one in Movies')
  assert.equal(stats.episodes, 1, 'and the unreadable filename went under its show')

  // The resolution is VISIBLE rather than silent - the dashboard shows it beside the
  // folder, so nobody has to reverse-engineer why their library sorted itself out.
  assert.deepEqual(a.roots.map(r => [path.basename(r.path), r.type, r.holds]), [
    ['TV Shows', 'auto', 'shows'],
    ['Movies', 'auto', 'movies']
  ])
})

test('A PARENT OF Movies AND TV Shows IS READ, not filed under one series', async (t) => {
  // Somebody typing a path by hand points at the LIBRARY, not at its two halves. The
  // root's own name then says nothing, and before this every episode underneath
  // became an episode of a series called "TV Shows" - because the top folder under a
  // root is where a show's name normally is.
  const { root, dataDir } = await split(t, {
    'PearCinema Library/Movies/Blade Runner (1982).mkv': 'x',
    'PearCinema Library/Movies/Arrival.mkv': 'x',
    'PearCinema Library/TV Shows/Dark/Season 01/Dark - s01e01.mkv': 'x',
    'PearCinema Library/TV Shows/Dark/Season 01/Dark - s01e02.mkv': 'x',
    'PearCinema Library/TV Shows/The Legend of Korra/Legend of Korra - s01e01.mkv': 'x'
  })
  const at = path.join(root, 'PearCinema Library')
  const a = typed({ roots: [at], dataDir })
  await a.scan()

  const stats = await a.stats()
  assert.equal(stats.movies, 2, 'the two films are films')
  assert.equal(stats.series, 2, 'Dark and Korra, not one series called TV Shows')
  assert.equal(stats.episodes, 3)

  const shows = (await a.list({ type: 'series' })).items.map(s => s.title).sort()
  assert.deepEqual(shows, ['Dark', 'The Legend of Korra'])

  // The season came from the folder BELOW the show, not from the show folder itself -
  // which is the half that breaks if only `holds` is fixed and the depth is not.
  const dark = (await a.list({ type: 'series' })).items.find(s => s.title === 'Dark')
  const seasons = (await a.list({ type: 'seasons', seriesId: dark.id })).items
  assert.deepEqual(seasons.map(x => x.number), [1])

  // AND THE ROOT IS STILL THE ROOT. Ids are minted relative to it, so reading a
  // folder underneath must not re-mint them - a phone's resume positions depend on
  // that path never moving.
  assert.equal(a.roots.length, 1)
  assert.equal(a.roots[0].path, at)
  assert.equal(a.roots[0].holds, null, 'the ROOT still says nothing; the folders under it do')
})

test('a top folder that says nothing is still left to the filenames', async (t) => {
  // The descent only applies where the folder name is one of the words that mean
  // something. `Stuff/Blurays/...` is not, and must behave exactly as it did.
  const { root, dataDir } = await split(t, {
    'Stuff/Blurays/Blade Runner (1982).mkv': 'x',
    'Stuff/Blurays/Dark - s01e01.mkv': 'x'
  })
  const a = typed({ roots: [path.join(root, 'Stuff')], dataDir })
  await a.scan()
  const stats = await a.stats()
  assert.equal(stats.movies, 1)
  assert.equal(stats.episodes, 1, 'the filename rules still decide')
  assert.equal((await a.list({ type: 'series' })).items[0].title, 'Blurays', 'including the old shape')
})

test('a folder whose name says nothing is left to the filenames, exactly as before', async (t) => {
  const { root, dataDir } = await split(t, { 'Stuff/Blade Runner (1982).mkv': 'x' })
  const a = typed({ roots: [path.join(root, 'Stuff')], dataDir })
  await a.scan()
  assert.equal(a.roots[0].holds, null)
  assert.equal((await a.stats()).movies, 1)
})

test('A SIDECAR STILL OVERRULES THE UNKNOWN NUMBERING', async (t) => {
  // The MST3K case is precisely the one nfo.js was built for: the filename says K05
  // and nothing can be inferred, so a sidecar that names the season and episode is
  // the only real answer. Typing the root must not shut that out.
  const { root, dataDir } = await split(t, {
    'Shelf/MST3K/MST3K - K05 - The Gunslinger.avi': 'x',
    'Shelf/MST3K/MST3K - K05 - The Gunslinger.nfo':
      '<episodedetails><title>The Gunslinger</title><season>5</season><episode>11</episode></episodedetails>'
  })

  const a = typed({ roots: [{ path: path.join(root, 'Shelf'), type: 'shows' }], dataDir })
  await a.scan()

  const [show] = (await a.list({ type: 'series' })).items
  const seasons = await a.list({ type: 'seasons', seriesId: show.id })
  assert.deepEqual(seasons.items.map(s => s.number), [5], 'the sidecar knew what the filename could not say')

  const eps = await a.list({ type: 'episodes', seasonId: seasons.items[0].id })
  assert.equal(eps.items[0].episodeNumber, 11)
  assert.equal(eps.items[0].title, 'The Gunslinger')
})

test('THE CACHE IS REFUSED WHEN A ROOT CHANGED TYPE', async (t) => {
  // Same paths, same files, read a different way. Serving the old rows would leave an
  // operator having typed their folders and watched nothing happen, which is worse
  // than the minutes a rescan costs.
  const { root, dataDir } = await split(t, MST3K)
  const at = path.join(root, 'Shelf')

  await typed({ roots: [at], dataDir }).scan()

  const after = typed({ roots: [{ path: at, type: 'shows' }], dataDir })
  await after.scan()
  assert.equal((await after.stats()).movies, 0, 'it rescanned rather than trusting the cache')
  assert.equal((await after.stats()).episodes, 3)
})

test('a bare string root is still a valid config, and always will be', async (t) => {
  // Every host in the field saved them this way, and PEARCINEMA_FOLDERS is a
  // colon-separated path list. A config this cannot read is a library gone dark.
  const { root, dataDir } = await split(t, { 'Stuff/Deadpool.mkv': 'x' })
  const a = typed({ roots: path.join(root, 'Stuff'), dataDir })
  await a.scan()
  assert.equal((await a.stats()).movies, 1)
  assert.deepEqual(a.roots.map(r => r.type), ['auto'])
})

test('a nonsense root type is read as "work it out" rather than trusted', async (t) => {
  const { root, dataDir } = await split(t, { 'Stuff/Deadpool.mkv': 'x' })
  const a = typed({ roots: [{ path: path.join(root, 'Stuff'), type: 'films-probably' }], dataDir })
  assert.equal(a.roots[0].type, 'auto')
  await a.scan()
  assert.equal((await a.stats()).movies, 1)
})

// --- ids survive the drive moving -------------------------------------------
//
// The rule the whole id scheme rests on: a leaf id is minted from the path RELATIVE
// to its root, so a drive that mounts at a different letter or mount point does not
// orphan every watch position on every phone. Series and season ids carried the
// ABSOLUTE root until 2026-08-13 and quietly broke it - a film survived a remount and
// a SHOW did not, which is the half that continue-watching would have needed.

// The same library, byte for byte, at two different mount points.
async function twice (t, files) {
  const a = await split(t, files)
  const b = await split(t, files)
  return [a, b]
}

test('A DRIVE THAT MOUNTS SOMEWHERE ELSE KEEPS EVERY ID - films, shows, seasons and episodes', async (t) => {
  const files = {
    'TV Shows/Firefly/Season 01/Firefly - s01e01.mkv': 'x',
    'TV Shows/MST3K/MST3K - K05 - The Gunslinger.avi': 'x',
    'Movies/Blade Runner (1982).mkv': 'x'
  }
  const [one, two] = await twice(t, files)

  const read = async ({ root, dataDir }) => {
    const a = typed({ roots: [path.join(root, 'TV Shows'), path.join(root, 'Movies')], dataDir })
    await a.scan()
    const series = (await a.list({ type: 'series' })).items
    const seasons = (await Promise.all(series.map(s => a.list({ type: 'seasons', seriesId: s.id })))).flatMap(r => r.items)
    const eps = (await Promise.all(seasons.map(s => a.list({ type: 'episodes', seasonId: s.id })))).flatMap(r => r.items)
    return {
      films: (await a.list({ type: 'movies' })).items.map(m => m.id),
      series: series.map(s => s.id),
      seasons: seasons.map(s => s.id),
      episodes: eps.map(e => [e.id, e.seriesId, e.seasonId])
    }
  }

  const first = await read(one)
  const second = await read(two)

  assert.ok(first.series.length && first.seasons.length && first.episodes.length, 'the fixture exercised all three')
  assert.deepEqual(second, first, 'nothing about the mount point may reach an id')
})

test('THE SAME SHOW UNDER TWO ROOTS IS ONE SHOW, which is the point rather than the price', async (t) => {
  // A collection split across two drives is a real shape - one disk filled up and the
  // next seasons went on the next one. Two identical entries in the show list was
  // never the better answer.
  const { root, dataDir } = await split(t, {
    'Disk 1/Firefly/Season 01/Firefly - s01e01.mkv': 'x',
    'Disk 2/Firefly/Season 02/Firefly - s02e01.mkv': 'x'
  })

  const a = typed({ roots: [path.join(root, 'Disk 1'), path.join(root, 'Disk 2')], dataDir })
  await a.scan()

  const series = (await a.list({ type: 'series' })).items
  assert.equal(series.length, 1, 'one Firefly, not two')
  assert.equal(series[0].episodeCount, 2)

  const seasons = await a.list({ type: 'seasons', seriesId: series[0].id })
  assert.deepEqual(seasons.items.map(s => s.number), [1, 2], 'and both its seasons')
})

test('TWO ROOTS HOLDING THE SAME FILE IS REPORTED, not silently one file playing as another', async (t) => {
  // The price of a relative id: two roots with the same relative path mint the same
  // id, and the second would overwrite the first in the path map. Nothing anywhere
  // would say so, and one film would quietly play as another.
  const { root, dataDir } = await split(t, {
    'Copy A/Blade Runner (1982).mkv': 'x',
    'Copy B/Blade Runner (1982).mkv': 'x'
  })

  const a = typed({ roots: [path.join(root, 'Copy A'), path.join(root, 'Copy B')], dataDir })
  await a.scan()
  assert.equal(a.idCollisions, 1, 'the duplicate is counted rather than absorbed')

  const clean = typed({ roots: [path.join(root, 'Copy A')], dataDir })
  await clean.scan({ force: true })
  assert.equal(clean.idCollisions, 0)
})

// --- the Umbrel default -----------------------------------------------------
//
// Two things these have to get right, both learned the hard way in this repo:
//
//   1. A real PearCinemaHost builds a real HyperDHT. Left on the public bootstrap
//      a unit test dials the actual network and keeps the process alive long after
//      the assertions passed. Each gets a private testnet.
//
//   2. THE HOST IS CLOSED INLINE, not in a `t.after` hook. node:test runs
//      after-hooks in REGISTRATION order, and `library()` registers its directory
//      delete first - so a hook-registered close runs after the data directory is
//      already gone, and RocksDB still holding files turns cleanup into an
//      intermittent ENOTEMPTY that points at a directory rather than at anything
//      under test. Exactly the failure first-pair.test.js had.

async function envHost (dataDir) {
  const createTestnet = require('hyperdht/testnet')
  const { PearCinemaHost } = require('../host/server')
  const testnet = await createTestnet(3)
  const host = new PearCinemaHost({ dataDir, bootstrap: testnet.bootstrap, log: () => {} })
  return {
    host,
    async close () {
      await host.close()
      await testnet.destroy()
    }
  }
}

// Set, run, restore - so one test's environment cannot leak into the next.
async function withFolders (value, fn) {
  const before = process.env.PEARCINEMA_FOLDERS
  if (value === null) delete process.env.PEARCINEMA_FOLDERS
  else process.env.PEARCINEMA_FOLDERS = value
  try {
    return await fn()
  } finally {
    if (before === undefined) delete process.env.PEARCINEMA_FOLDERS
    else process.env.PEARCINEMA_FOLDERS = before
  }
}

test('PEARCINEMA_FOLDERS gives a fresh install a library with no dashboard', async (t) => {
  // On Umbrel every install is a fresh one, and without this a brand-new app shows
  // an empty library and looks broken while the files sit right there in the mount.
  const { root, dataDir } = await library(t)

  await withFolders(`${path.join(root, 'Blurays')}:${path.join(root, 'The Legend of Korra')}`, async () => {
    const { host, close } = await envHost(dataDir)
    assert.equal(host.source.kind, 'folder')
    assert.equal(host.source.roots.length, 2)
    await close()
  })
})

test('a folder in the env that this box does not have is dropped, not fatal', async (t) => {
  const { root, dataDir } = await library(t)

  await withFolders(`${path.join(root, 'Blurays')}:/definitely/not/mounted`, async () => {
    const { host, close } = await envHost(dataDir)
    assert.deepEqual(host.source.roots, [path.join(root, 'Blurays')])
    await close()
  })
})

test('NONE of them present falls back to empty rather than a source that throws', async (t) => {
  const { dataDir } = await library(t)

  await withFolders('/nope/one:/nope/two', async () => {
    const { host, close } = await envHost(dataDir)
    assert.equal(host.source.kind, 'empty', 'an empty library is honest; a source that cannot scan is not')
    await close()
  })
})

test('A SAVED SOURCE WINS over the environment', async (t) => {
  // The container still sets the env var it was installed with, so an operator's
  // dashboard choice has to survive a restart.
  const { root, dataDir } = await library(t)
  await fsp.writeFile(
    path.join(dataDir, 'source.json'),
    JSON.stringify({ kind: 'folder', roots: [path.join(root, 'Blurays')] })
  )

  await withFolders(root, async () => {
    const { host, close } = await envHost(dataDir)
    assert.deepEqual(host.source.roots, [path.join(root, 'Blurays')], 'the saved choice, not the env default')
    await close()
  })
})

test('A LIBRARY DOES NOT BECOME EMPTY BY ITSELF', async (t) => {
  // The guard that keeps a missing drive from being written down as an empty library.
  //
  // In a container, a bind mount whose drive has been remounted elsewhere looks
  // exactly like a directory that is present and holds nothing - which happened to
  // Tim's Umbrel on 2026-08-19, when the same disk came back as `Elements` instead of
  // `Elements (3)`. Without this, an auto-rescan walks nothing, saves nothing, and the
  // cache holding thousands of films is replaced by an empty one. The drive coming
  // back does not undo that: every file has to be re-probed, and until it is, every
  // paired phone sees a library that is simply gone.
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })

  const before = await a.scan()
  assert.ok(before > 0)

  // The drive goes away underneath, leaving the mount point itself present - the
  // shape that fools the readable check above.
  for (const entry of await fsp.readdir(root)) {
    await fsp.rm(path.join(root, entry), { recursive: true, force: true })
  }

  await assert.rejects(() => a.scan({ force: true }), /Refusing to replace it with an empty one/)

  // AND THE LIBRARY IS STILL SERVED while it is wrong. Refusing costs nothing: what
  // is already in memory keeps answering, so a rescan that runs at the wrong moment
  // is a message rather than an outage.
  const stats = await a.stats()
  assert.equal(stats.movies, 4)
  assert.equal(stats.episodes, 4)

  // And the cache on disk was not overwritten, so a restart still comes up full.
  const fresh = realAdapter({ root, dataDir })
  assert.ok(await fresh.scan() > 0, 'the saved scan survived the drive going away')
})

test('a library that really is emptied can still be emptied', async (t) => {
  // The guard is about a source that VANISHED, not about a user with no films. A host
  // that has never seen anything has nothing to protect, so it scans to zero happily.
  const { dataDir } = await library(t)
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-empty-'))
  t.after(() => fsp.rm(empty, { recursive: true, force: true }))

  const a = realAdapter({ root: empty, dataDir: await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-d-')) })
  assert.equal(await a.scan(), 0)
  void dataDir
})

test('THE HOST NOTICES ITS DRIVE HAS GONE, without scanning to find out', async (t) => {
  // The failure this exists for is silent. In a container, a bind mount whose disk
  // has been remounted elsewhere leaves a directory that is present, readable and
  // empty - so `ping()` says yes, the host stays green, and every film 404s. That is
  // what happened to Tim's Umbrel on 2026-08-19 and what nothing on any screen said.
  const { root, dataDir } = await library(t)
  const a = realAdapter({ root, dataDir })
  await a.scan()

  assert.deepEqual(await a.health(), { ok: true })

  // The drive goes, leaving the mount point behind - readable, and holding nothing.
  for (const entry of await fsp.readdir(root)) {
    await fsp.rm(path.join(root, entry), { recursive: true, force: true })
  }

  assert.equal((await a.ping()).ok, true, 'the folder is still readable, which is the trap')
  const gone = await a.health()
  assert.equal(gone.ok, false)
  assert.match(gone.detail, /Is the drive still mounted/)

  // ONE MISSING FILM IS A DELETED FILM, not a missing disk. The check only calls the
  // source gone when NONE of the files it knows about are there.
  const { root: root2, dataDir: dataDir2 } = await library(t)
  const b = realAdapter({ root: root2, dataDir: dataDir2 })
  await b.scan()
  const one = [...b._paths.values()][0]
  await fsp.rm(one)
  assert.deepEqual(await b.health(), { ok: true }, 'a gap in the library is not an absent drive')
})

test('a library with nothing scanned yet has nothing to be missing', async (t) => {
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-fresh-'))
  const data = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-fd-'))
  t.after(() => Promise.all([
    fsp.rm(empty, { recursive: true, force: true }),
    fsp.rm(data, { recursive: true, force: true })
  ]))
  const a = realAdapter({ root: empty, dataDir: data })
  assert.deepEqual(await a.health(), { ok: true }, 'a host that has scanned nothing is not a host in trouble')
})

test('A RESCAN RE-READS ONLY WHAT CHANGED, which is why one new episode is not 2,986 probes', async (t) => {
  // Tim, 2026-08-19, on his real library: "Plex is pretty quick to detect new/updated
  // items, takes maybe 10-15 seconds". Ours took minutes because `force` meant do not
  // trust the index and was implemented as do not trust anything - so every file went
  // back through ffprobe to be told what it already knew.
  const { root, dataDir } = await library(t)

  // How many files each scan hands to ffprobe, off the adapter's own plan line.
  let probes = -1
  const watch = (a) => { a.log = (ev, d) => { if (ev === 'folder:probe-plan') probes = d.toProbe }; return a }

  const a = watch(realAdapter({ root, dataDir }))
  await a.scan({ force: true })
  const first = await a.stats()
  assert.ok(first.movies > 0, 'the library scanned')
  assert.ok(probes > 0, 'the first pass reads everything, because it has nothing yet')

  // A second adapter over the same data dir, forced: it reuses the probes the first
  // one wrote, so nothing is handed to ffprobe at all.
  const b = watch(realAdapter({ root, dataDir }))
  await b.scan({ force: true })
  assert.equal(probes, 0, 'nothing changed, so nothing was re-read')
  const second = await b.stats()
  assert.deepEqual({ ...second, scannedAt: 0 }, { ...first, scannedAt: 0 }, 'and the library is identical')

  // One new file, and exactly one file is read.
  await fsp.writeFile(path.join(root, 'Blurays', 'Arrival.mkv'), 'x')
  const c = watch(realAdapter({ root, dataDir }))
  await c.scan({ force: true })
  assert.equal(probes, 1, 'the new one, and only the new one')
  assert.equal((await c.stats()).movies, first.movies + 1)

  // A file that CHANGED is read again: same path, different size and mtime.
  await fsp.writeFile(path.join(root, 'Blurays', 'Deadpool.mkv'), 'xxxxxxxxxx')
  const d = watch(realAdapter({ root, dataDir }))
  await d.scan({ force: true })
  assert.equal(probes, 1, 'the changed one')
})

/* --------------------------------- pointing the library somewhere else -- */
//
// THE HOSTS BELOW ARE CLOSED INLINE, per the note above `envHost`. A `t.after(close)`
// runs AFTER `library()`'s own directory delete - node:test runs after-hooks in
// registration order - so RocksDB is still holding files under a directory that is
// already gone, and the file never exits. Learned here the same way first-pair.test.js
// learned it: 47 tests all green and the runner hanging on the last one.

test('CHANGING THE SOURCE REBUILDS THE BLEND, or every shelf still shows the old library', async (t) => {
  // FOUND ON THE REAL UMBREL, 2026-08-25, the day PearCinema became a store app. The
  // hand-run container had mounted the drive on /library and a store listing cannot know
  // a drive is called "Elements", so the folders were re-picked under /external. The scan
  // ran and found 248 films and 3,215 episodes. Every shelf went on showing 10 and 469.
  //
  // `_scan` has always ended with `blend.buildSoon`; `setSource` never did. The merged
  // index is what phones and dashboards actually read, so scanning the new folder,
  // writing the config and swapping the adapter changed nothing anybody could see - and
  // `rescanIntervalMin` on that box is 360, so the wait for the periodic rescan to put it
  // right was six hours, with nothing on the page saying so.
  const { root, dataDir } = await library(t)
  const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-other-'))
  await fsp.mkdir(path.join(other, 'Movies'), { recursive: true })
  await fsp.writeFile(path.join(other, 'Movies', 'Arrival (2016).mkv'), 'x')

  const { host, close } = await envHost(dataDir)
  const built = []
  host.blend.buildSoon = (reason) => built.push(reason)

  await host.setSource({ kind: 'folder', roots: [{ path: root, type: 'auto' }] })
  assert.deepEqual(built, ['source'], 'the first source change rebuilds it')

  await host.setSource({ kind: 'folder', roots: [{ path: other, type: 'auto' }] })
  assert.deepEqual(built, ['source', 'source'], 'and so does the next one')

  await close()
  await fsp.rm(other, { recursive: true, force: true })
})

test('a source change publishes progress, so the page can say it finished', async (t) => {
  // The other half of the same report: "it doesn't ever tell me it's finished". Reading a
  // real library is minutes - 2,986 files off a USB drive took four of them on the real
  // Umbrel - and `setSource` called the adapter's scan directly, so `scanning` stayed null
  // throughout and the page had nothing to show for any of it. `_scan` had always
  // published it.
  //
  // SAMPLED FROM INSIDE THE SCAN, because before and after prove nothing: the adapter logs
  // as it probes, so the host's own log is the hook that catches the middle.
  const { root, dataDir } = await library(t)
  const createTestnet = require('hyperdht/testnet')
  const { PearCinemaHost } = require('../host/server')
  const testnet = await createTestnet(3)
  const seen = []
  const host = new PearCinemaHost({
    dataDir,
    bootstrap: testnet.bootstrap,
    log: (ev) => { if (String(ev).startsWith('folder:')) seen.push(host.scanning) }
  })

  assert.equal(host.scanning, null, 'nothing is scanning before')
  await host.setSource({ kind: 'folder', roots: [{ path: root, type: 'auto' }] })

  assert.ok(seen.length > 0, 'the adapter reported while it worked')
  assert.ok(seen.some(s => s && typeof s.startedAt === 'number'),
    'and the host was publishing a scan the whole time, which is what the banner reads')
  assert.equal(host.scanning, null, 'cleared afterwards, which is what ENDS the banner')

  await host.close()
  await testnet.destroy()
})

test('a source that throws still clears the scanning banner', async (t) => {
  // The `finally` earns its place: without it a bad path leaves the page saying "reading
  // your library" for good, on a library that is not being read.
  const { dataDir } = await library(t)
  const { host, close } = await envHost(dataDir)

  await assert.rejects(
    host.setSource({ kind: 'folder', roots: [{ path: path.join(os.tmpdir(), 'pearcinema-nope-' + Date.now()), type: 'auto' }] })
  )
  assert.equal(host.scanning, null, 'the banner is gone even though the scan failed')

  await close()
})

/* ------------------------------------------------- an extra is not a season -- */

test('A DOCUMENTARY IN A SHOW FOLDER IS A SPECIAL, not a second nameless season', async (t) => {
  // FOUND ON THE REAL LIBRARY, 2026-08-25, while taking store screenshots. Band Of
  // Brothers rendered Season 1 correctly and, beside it, a second card labelled just
  // "Season" with an initials placeholder where a poster would be.
  //
  // The folder has NO season subdirectories - eleven flat files. Ten are
  // `Band Of Brothers Part N Title.mkv`, which parse as season 1 episodes. One is
  // `Band Of Brothers Documentry 2001.mkv`, which is not an episode at all, so it had no
  // number and no folder to be named after and became a season keyed `unnumbered`.
  //
  // The filenames below are the real ones, spelling included.
  const { root, dataDir } = await library(t, {
    extra: {
      'TV Shows/Band Of Brothers/Band Of Brothers Part 1 Currahee (1080p x265 Joy).mkv': 'x',
      'TV Shows/Band Of Brothers/Band Of Brothers Part 2 Day Of Days (1080p x265 Joy).mkv': 'x',
      'TV Shows/Band Of Brothers/Band Of Brothers Part 3 Carentan (1080p x265 Joy).mkv': 'x',
      'TV Shows/Band Of Brothers/Band Of Brothers Documentry 2001 (1080p x265 Joy).mkv': 'x'
    }
  })
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const series = (await a.list({ type: 'series' })).items
  const bob = series.find(x => /Band Of Brothers/i.test(x.title || ''))
  assert.ok(bob, `the show is in the library: ${JSON.stringify(series.map(x => x.title))}`)

  const titles = (await a.list({ type: 'seasons', seriesId: bob.id })).items.map(x => x.title).sort()

  assert.ok(!titles.includes('Season'), `a nameless "Season" card is back: ${JSON.stringify(titles)}`)
  assert.ok(titles.includes('Specials'), `the extra should be Specials, got ${JSON.stringify(titles)}`)
  assert.ok(titles.includes('Season 1'), `and the real season is untouched, got ${JSON.stringify(titles)}`)

  // And the special really is the documentary, not a real episode swept up with it.
  const specials = (await a.list({ type: 'seasons', seriesId: bob.id })).items.find(x => x.title === 'Specials')
  const eps = (await a.list({ type: 'episodes', seasonId: specials.id })).items
  assert.equal(eps.length, 1, 'exactly the one file that is not an episode')
  assert.match(eps[0].title, /Documentry/i)
})

test('a show whose filenames ALL fail to parse is left alone', async (t) => {
  // The reason the promotion is conditional. A per-file decision cannot see its siblings,
  // and calling every episode of a show a "special" because its naming is unusual would be
  // worse than the nameless shelf it replaced.
  const { root, dataDir } = await library(t, {
    extra: {
      'TV Shows/Some Documentary Series/Some Documentary Series The Beginning.mkv': 'x',
      'TV Shows/Some Documentary Series/Some Documentary Series The Middle.mkv': 'x',
      'TV Shows/Some Documentary Series/Some Documentary Series The End.mkv': 'x'
    }
  })
  const a = realAdapter({ root, dataDir })
  await a.scan()

  const series = (await a.list({ type: 'series' })).items
  const doc = series.find(x => /Some Documentary Series/i.test(x.title || ''))
  if (doc) {
    const titles = (await a.list({ type: 'seasons', seriesId: doc.id })).items.map(x => x.title)
    assert.ok(!titles.includes('Specials'),
      `nothing should be promoted with no real season beside it, got ${JSON.stringify(titles)}`)
  }
})
