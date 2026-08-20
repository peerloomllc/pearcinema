// Sidecar writing - the explicit action that saves fetched metadata INTO the
// library, as the standard files every scanner reads.
//
// The property that matters most is the ROUND TRIP: what host/sidecars.js
// writes, the folder adapter's own rescan must read back - same titles, same
// pictures, now off disk instead of out of the data dir. A writer that wrote
// names the reader does not look for would pass every unit test and still be
// useless, so the round trip is tested against the real adapter end to end.
//
// The property that matters second is restraint: CREATE ONLY, never replace,
// and uncertain guesses never reach the disk at all.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const { createProtocol } = require('@peerloom/host')
const { FolderAdapter } = require('../host/adapters/folder')
const { Enricher } = require('../host/tmdb')
const sidecars = require('../host/sidecars')
const nfo = require('../host/nfo')

const protocol = createProtocol({ app: 'pearcinema' })
const LIB = protocol.ids.libraryId(require('hypercore-crypto').keyPair().publicKey)
const FAKE_FFPROBE = path.join(__dirname, 'fixtures', 'fake-ffprobe.js')

// An .nfo somebody (or some tool) already wrote. The writer must never beat it.
const EXISTING_NFO = '<movie><title>Blade Runner</title><year>1982</year></movie>'

const TREE = {
  // A film in its own folder, nothing beside it: gets an .nfo and a poster.
  'Movies/Heat (1995)/Heat (1995).mkv': 'x',
  // A flat-shelf film whose match was a GUESS: nothing may be written.
  'Movies/Alien.mkv': 'x',
  // An .nfo already on disk: the poster is written, the .nfo is not.
  'Movies/Blade Runner (1982)/Blade Runner (1982).mkv': 'x',
  'Movies/Blade Runner (1982)/Blade Runner (1982).nfo': EXISTING_NFO,
  // Artwork already on disk: the .nfo is written, the poster is not.
  'Movies/Rocky/Rocky.mkv': 'x',
  'Movies/Rocky/poster.jpg': 'ROCKYART',
  // A show: tvshow.nfo and poster.jpg in the show folder, a Kodi season poster
  // beside them, a thumb beside the episode.
  'TV Shows/The Wire/Season 01/The Wire - S01E01 - The Target.mkv': 'x',
  'TV Shows/The Wire/Season 01/The Wire - S01E02 - The Detail.mkv': 'x'
}

async function library (t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-sidecar-'))
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-sidecardata-'))

  for (const [rel, body] of Object.entries(TREE)) {
    const full = path.join(base, rel)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, body)
  }

  t.after(async () => {
    await fsp.rm(base, { recursive: true, force: true })
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  const a = new FolderAdapter({
    roots: [path.join(base, 'Movies'), path.join(base, 'TV Shows')],
    dataDir,
    libraryId: LIB,
    ids: protocol.ids,
    ffprobe: FAKE_FFPROBE
  })
  await a.scan()
  return { base, dataDir, a }
}

const filmNamed = async (a, title) => (await a.list({ type: 'movies' })).items.find(m => m.title === title)
const showNamed = async (a, title) => (await a.list({ type: 'series' })).items.find(s => s.title === title)

// The enricher, seeded the way a finished TMDB pass leaves it.
async function enriched (a, dataDir) {
  const e = new Enricher({ dataDir })
  const heat = await filmNamed(a, 'Heat')
  const alien = await filmNamed(a, 'Alien')
  const br = await filmNamed(a, 'Blade Runner')
  const rocky = await filmNamed(a, 'Rocky')
  const wire = await showNamed(a, 'The Wire')
  const season = (await a.list({ type: 'seasons', seriesId: wire.id })).items[0]
  const ep = (await a.list({ type: 'episodes', seasonId: season.id })).items
    .find(x => x.episodeNumber === 1)

  // The match title deliberately differs from the filename, so the round-trip
  // test can prove the rescan read the .nfo rather than re-parsed the name.
  e.matched[heat.id] = { tmdbId: 949, title: 'Heat: Definitive Edition', year: 1995, overview: 'Two men, one on each side of it.', poster: true, how: 'auto', at: 1 }
  e.matched[alien.id] = { tmdbId: 348, title: 'Alien', year: 1979, poster: true, how: 'auto', uncertain: true, at: 1 }
  e.matched[br.id] = { tmdbId: 78, title: 'Blade Runner', year: 1982, poster: true, how: 'auto', at: 1 }
  e.matched[rocky.id] = { tmdbId: 1366, title: 'Rocky', year: 1976, poster: true, how: 'auto', at: 1 }
  e.matched[wire.id] = { tmdbId: 1438, title: 'The Wire', year: 2002, poster: true, how: 'auto', at: 1 }
  e.art[season.id] = { from: wire.id, at: 1 }
  e.art[ep.id] = { from: wire.id, at: 1 }

  for (const [id, tag] of [
    [heat.id, 'HEATPOSTER'], [alien.id, 'ALIENPOSTER'], [br.id, 'BRPOSTER'],
    [rocky.id, 'ROCKYFETCHED'], [wire.id, 'WIREPOSTER'],
    [season.id, 'WIRESEASON'], [ep.id, 'WIRESTILL']
  ]) {
    await e._saveImage(id, Buffer.from(tag))
  }

  return { e, heat, alien, br, rocky, wire, season, ep }
}

/* ------------------------------------------------------------------ locate -- */

test('locate places films, episodes, shows and seasons on disk', async (t) => {
  const { base, a } = await library(t)
  const heat = await filmNamed(a, 'Heat')
  const wire = await showNamed(a, 'The Wire')
  const season = (await a.list({ type: 'seasons', seriesId: wire.id })).items[0]
  const ep = (await a.list({ type: 'episodes', seasonId: season.id })).items[0]

  assert.equal(a.locate(heat.id).file, path.join(base, 'Movies/Heat (1995)/Heat (1995).mkv'))
  assert.equal(a.locate(wire.id).dir, path.join(base, 'TV Shows/The Wire'))

  const s = a.locate(season.id)
  assert.equal(s.seriesDir, path.join(base, 'TV Shows/The Wire'))
  assert.equal(s.dir, path.join(base, 'TV Shows/The Wire/Season 01'))
  assert.equal(s.number, 1)

  assert.ok(a.locate(ep.id).file.endsWith('.mkv'))
  assert.equal(a.locate('nope'), null)
})

/* ----------------------------------------------------------------- writing -- */

test('the write pass creates the standard files and holds back what it must', async (t) => {
  const { base, dataDir, a } = await library(t)
  const { e } = await enriched(a, dataDir)

  const out = await sidecars.write({ adapter: a, enricher: e })
  assert.equal(out.supported, true)
  assert.equal(out.failed, 0)

  // Heat: both files, and the .nfo parses back as exactly what was matched.
  const heatNfo = await fsp.readFile(path.join(base, 'Movies/Heat (1995)/Heat (1995).nfo'), 'utf8')
  const parsed = nfo.parseNfo(heatNfo)
  assert.equal(parsed.kind, 'movie')
  assert.equal(parsed.title, 'Heat: Definitive Edition')
  assert.equal(parsed.year, 1995)
  assert.equal(parsed.ids.tmdb, '949')
  // The words too, not just the picture and the name - a copy saved into the
  // library that carried half the match would be half an answer, and <plot> is
  // what our own reader and Kodi, Jellyfin and Plex all take as the summary.
  assert.equal(parsed.plot, 'Two men, one on each side of it.')
  assert.equal(await fsp.readFile(path.join(base, 'Movies/Heat (1995)/Heat (1995)-poster.jpg'), 'utf8'), 'HEATPOSTER')

  // Alien was a guess: NOTHING beside it.
  assert.equal(fs.existsSync(path.join(base, 'Movies/Alien.nfo')), false)
  assert.equal(fs.existsSync(path.join(base, 'Movies/Alien-poster.jpg')), false)
  assert.equal(out.skippedUncertain, 1)

  // Blade Runner had an .nfo: untouched, byte for byte. The poster still lands.
  assert.equal(await fsp.readFile(path.join(base, 'Movies/Blade Runner (1982)/Blade Runner (1982).nfo'), 'utf8'), EXISTING_NFO)
  assert.equal(await fsp.readFile(path.join(base, 'Movies/Blade Runner (1982)/Blade Runner (1982)-poster.jpg'), 'utf8'), 'BRPOSTER')

  // Rocky had artwork on disk: the .nfo lands, no second poster does.
  assert.equal(nfo.parseNfo(await fsp.readFile(path.join(base, 'Movies/Rocky/Rocky.nfo'), 'utf8')).title, 'Rocky')
  assert.equal(fs.existsSync(path.join(base, 'Movies/Rocky/Rocky-poster.jpg')), false)

  // The show: every name the scanner itself looks for.
  const showDir = path.join(base, 'TV Shows/The Wire')
  assert.equal(nfo.parseNfo(await fsp.readFile(path.join(showDir, 'tvshow.nfo'), 'utf8')).kind, 'series')
  assert.equal(await fsp.readFile(path.join(showDir, 'poster.jpg'), 'utf8'), 'WIREPOSTER')
  assert.equal(await fsp.readFile(path.join(showDir, 'season01-poster.jpg'), 'utf8'), 'WIRESEASON')
  assert.equal(await fsp.readFile(path.join(showDir, 'Season 01/The Wire - S01E01 - The Target-thumb.jpg'), 'utf8'), 'WIRESTILL')
})

test('a second pass writes nothing - everything now exists', async (t) => {
  const { dataDir, a } = await library(t)
  const { e } = await enriched(a, dataDir)

  await sidecars.write({ adapter: a, enricher: e })
  const again = await sidecars.write({ adapter: a, enricher: e })

  assert.equal(again.wrote, 0)
  assert.equal(again.failed, 0)
  assert.ok(again.skippedExisting > 0)
})

test('THE ROUND TRIP: a forced rescan reads back exactly what was written', async (t) => {
  const { dataDir, a } = await library(t)
  const { e, heat, wire, season, ep } = await enriched(a, dataDir)

  await sidecars.write({ adapter: a, enricher: e })
  await a.scan({ force: true })

  // The film now carries the MATCHED title, which only the .nfo knew - proof
  // the rescan read the sidecar rather than re-parsing the filename.
  const heatAfter = await a.get({ id: heat.id })
  assert.equal(heatAfter.title, 'Heat: Definitive Edition')

  // And the pictures come off the library disk now, through the adapter's own
  // artwork path, no enricher anywhere in sight.
  const read = async (artId) => {
    const chunks = []
    for await (const c of await a.art({ artId })) chunks.push(c)
    return Buffer.concat(chunks).toString()
  }
  assert.equal(await read(heatAfter.artId), 'HEATPOSTER')

  const wireAfter = await a.get({ id: wire.id })
  assert.equal(await read(wireAfter.artId), 'WIREPOSTER')
  const seasonAfter = (await a.list({ type: 'seasons', seriesId: wire.id })).items.find(s => s.id === season.id)
  assert.equal(await read(seasonAfter.artId), 'WIRESEASON')
  const epAfter = await a.get({ id: ep.id })
  assert.equal(await read(epAfter.artId), 'WIRESTILL')
})

test('a read-only library is one plain verdict, not a page of errors', async (t) => {
  const { base, dataDir, a } = await library(t)
  const { e } = await enriched(a, dataDir)

  // Every directory a write would land in, sealed.
  const dirs = []
  for (const rel of ['Movies/Heat (1995)', 'Movies/Blade Runner (1982)', 'Movies/Rocky', 'Movies', 'TV Shows/The Wire/Season 01', 'TV Shows/The Wire', 'TV Shows']) {
    dirs.push(path.join(base, rel))
  }
  for (const d of dirs) await fsp.chmod(d, 0o555)

  const out = await sidecars.write({ adapter: a, enricher: e })

  // Reopen before asserting, so a failure does not strand an undeletable tree.
  for (const d of dirs) await fsp.chmod(d, 0o755)

  assert.equal(out.wrote, 0)
  assert.ok(out.failed > 0)
  assert.equal(out.readOnly, true)
  // The examples are capped: a big library must not produce hundreds of rows.
  assert.ok(out.errors.length <= 5)
})

test('anything but a folder library is refused, with the reason said', async () => {
  const out = await sidecars.write({ adapter: {}, enricher: new Enricher({ dataDir: os.tmpdir() }) })
  assert.equal(out.supported, false)
  assert.match(out.reason, /folder library/)
})

/* --------------------------------------------------------------------- xml -- */

test('titles with XML in them survive the trip through the .nfo', () => {
  const xml = sidecars.nfoXml('movie', { title: 'Fast & Furious <"Tokyo" Drift>', year: 2006, tmdbId: 9615 })
  const parsed = nfo.parseNfo(xml)
  assert.equal(parsed.title, 'Fast & Furious <"Tokyo" Drift>')
  assert.equal(parsed.year, 2006)
  assert.equal(parsed.ids.tmdb, '9615')
})

test('season poster names follow the Kodi convention, specials included', () => {
  assert.equal(sidecars.seasonPosterName(1), 'season01-poster.jpg')
  assert.equal(sidecars.seasonPosterName(12), 'season12-poster.jpg')
  assert.equal(sidecars.seasonPosterName(0), 'season-specials-poster.jpg')
})
