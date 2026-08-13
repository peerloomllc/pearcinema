// Posters and subtitles off the disk.
//
// The last two pieces of the folder adapter, and the ones the web player made
// impossible to ignore: a folder library rendered every film as a grey placeholder
// and showed no subtitles at all, on a real collection that has 383 `.srt` files
// sitting right there beside the media.
//
// Two rules carry most of the weight below:
//
//   1. A GENERIC `poster.jpg` BELONGS TO A FOLDER, NOT TO A FILE. In a per-film
//      directory that is the film's poster. In a flat shelf of 200 films it is
//      nobody's, and using it would put the same wrong picture on all 200. Tim's
//      real `Blurays/` folder is exactly that shape, and so is the fixture.
//   2. An id is never a path. Posters and subtitle files are two more kinds of
//      bytes off somebody's disk, so they go through the same chokepoint the film
//      stream does.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')

const { createProtocol } = require('@peerloom/host')
const { FolderAdapter } = require('../host/adapters/folder')

const protocol = createProtocol({ app: 'pearcinema' })
const LIB = protocol.ids.libraryId(require('hypercore-crypto').keyPair().publicKey)
const FAKE_FFPROBE = path.join(__dirname, 'fixtures', 'fake-ffprobe.js')

const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHello.\n'

// A tree with every artwork and subtitle convention that appears in the wild.
const TREE = {
  // A FLAT SHELF. Its poster.jpg is the folder's, not any one film's.
  'Blurays/Deadpool.mkv': 'x',
  'Blurays/Heat.mkv': 'x',
  'Blurays/poster.jpg': 'JPEGDATA',
  // ...but a film-specific one right beside them still counts.
  'Blurays/Heat.jpg': 'HEATPOSTER',
  'Blurays/Heat.en.srt': SRT,
  'Blurays/Heat.fr.forced.srt': SRT,
  'Blurays/Heat.es.sub': 'imagedata',

  // A FILM IN ITS OWN DIRECTORY. Here folder.jpg IS the film's poster.
  'Blade Runner (1982)/Blade Runner (1982).mkv': 'x',
  'Blade Runner (1982)/folder.jpg': 'BRPOSTER',
  'Blade Runner (1982)/Blade Runner (1982).eng.srt': SRT,

  // A SHOW: poster in the show folder, a Kodi season poster beside it, and an
  // episode thumbnail next to the episode.
  'The Wire/poster.jpg': 'WIREPOSTER',
  'The Wire/season01-poster.jpg': 'WIRES1',
  'The Wire/Season 01/The Wire - S01E01 - The Target.mkv': 'x',
  'The Wire/Season 01/The Wire - S01E01 - The Target.jpg': 'EPTHUMB',
  'The Wire/Season 01/The Wire - S01E01 - The Target.en.srt': SRT,
  'The Wire/Season 01/The Wire - S01E02 - The Detail.mkv': 'x',

  // A SHOW whose season art is inside the season folder instead.
  'Chernobyl/Season 01/poster.jpg': 'CHERNS1',
  'Chernobyl/Season 01/Chernobyl - S01E01 - 1_23_45.mkv': 'x'
}

async function library (t, extra = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-art-'))
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-artdata-'))

  for (const [rel, body] of Object.entries({ ...TREE, ...extra })) {
    const full = path.join(root, rel)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, body)
  }

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  const a = new FolderAdapter({
    roots: [root],
    dataDir,
    libraryId: LIB,
    ids: protocol.ids,
    ffprobe: FAKE_FFPROBE
  })
  await a.scan()
  return { root, dataDir, a }
}

const read = async (stream) => {
  if (!stream) return null
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return Buffer.concat(chunks).toString()
}

const filmNamed = async (a, title) => (await a.list({ type: 'movies' })).items.find(m => m.title === title)

/* ----------------------------------------------------------------- artwork -- */

test('a film with its own poster beside it gets it', async (t) => {
  const { a } = await library(t)
  const heat = await filmNamed(a, 'Heat')
  assert.ok(heat.artId, 'Heat.jpg is unambiguously about Heat')
  assert.equal(await read(await a.art({ artId: heat.artId })), 'HEATPOSTER')
})

test('A FLAT SHELF S poster.jpg IS NOBODY S POSTER', async (t) => {
  const { a } = await library(t)
  const deadpool = await filmNamed(a, 'Deadpool')

  // Two films share that folder, so its poster.jpg describes the folder rather than
  // either of them. Using it would put the same picture on both, which looks like a
  // bug in the scanner and is much worse than a placeholder.
  assert.equal(deadpool.artId, null)
  assert.equal(await a.art({ artId: null }), null)
})

test('a film alone in its own directory DOES take the folder art', async (t) => {
  const { a } = await library(t)
  const br = await filmNamed(a, 'Blade Runner')
  assert.ok(br, 'the year-in-parentheses film parsed')
  assert.ok(br.artId)
  assert.equal(await read(await a.art({ artId: br.artId })), 'BRPOSTER')
})

test('a show, a season and an episode each get their own picture', async (t) => {
  const { a } = await library(t)

  const wire = (await a.list({ type: 'series' })).items.find(s => s.title === 'The Wire')
  assert.ok(wire.artId, 'the show folder poster')
  assert.equal(await read(await a.art({ artId: wire.artId })), 'WIREPOSTER')

  // Kodi and Sonarr write season posters into the SHOW folder as season01-poster.jpg.
  const s1 = (await a.list({ type: 'seasons', seriesId: wire.id })).items[0]
  assert.equal(await read(await a.art({ artId: s1.artId })), 'WIRES1')

  const eps = await a.list({ type: 'episodes', seasonId: s1.id })
  const first = eps.items.find(e => e.episodeNumber === 1)
  assert.equal(await read(await a.art({ artId: first.artId })), 'EPTHUMB')

  // The second episode has no thumbnail of its own, and must NOT inherit the first
  // one - a season folder is not one thing the way a film directory is.
  const second = eps.items.find(e => e.episodeNumber === 2)
  assert.equal(second.artId, null)
})

test('the other season-art convention works too', async (t) => {
  const { a } = await library(t)
  const chern = (await a.list({ type: 'series' })).items.find(s => s.title === 'Chernobyl')
  const s1 = (await a.list({ type: 'seasons', seriesId: chern.id })).items[0]
  assert.equal(await read(await a.art({ artId: s1.artId })), 'CHERNS1', 'poster.jpg inside the season folder')
})

/* --------------------------------------------------------------- subtitles -- */

test('external subtitle files are found, listed and served', async (t) => {
  const { a } = await library(t)
  const heat = await filmNamed(a, 'Heat')

  const subs = await a.subtitles({ itemId: heat.id })
  assert.equal(subs.length, 3)

  const en = subs.find(s => s.language === 'en')
  assert.equal(en.playable, true)
  assert.equal(en.external, true)
  assert.equal(en.reason, null)
  assert.equal(await read(await a.subtitle({ itemId: heat.id, subtitleId: en.id })), SRT)

  const fr = subs.find(s => s.language === 'fr')
  assert.equal(fr.forced, true)
})

test('the ones it cannot show are LISTED with a reason, not hidden', async (t) => {
  const { a } = await library(t)
  const heat = await filmNamed(a, 'Heat')
  const subs = await a.subtitles({ itemId: heat.id })

  const vob = subs.find(s => s.codec === 'sub')
  assert.equal(vob.playable, false)
  assert.match(vob.reason, /image-based/)
  assert.match(vob.reason, /re-encode/)

  // Playable first, so the UI reaching for subs[0] reaches for one that works.
  // On the real Movies collection this ordering is the difference between "most
  // films have working subtitles" and "most films have subtitles that do nothing".
  assert.equal(subs[0].playable, true)
  assert.equal(subs[subs.length - 1].playable, false)
})

test('an episode finds the .srt beside it', async (t) => {
  const { a } = await library(t)
  const wire = (await a.list({ type: 'series' })).items.find(s => s.title === 'The Wire')
  const s1 = (await a.list({ type: 'seasons', seriesId: wire.id })).items[0]
  const eps = await a.list({ type: 'episodes', seasonId: s1.id })

  const one = await a.subtitles({ itemId: eps.items.find(e => e.episodeNumber === 1).id })
  assert.equal(one.length, 1)
  const two = await a.subtitles({ itemId: eps.items.find(e => e.episodeNumber === 2).id })
  assert.deepEqual(two, [], 'and does not borrow its neighbour s')
})

/* ------------------------------------------------------- ids are not paths -- */

test('NEITHER A POSTER NOR A SUBTITLE MAY BE FETCHED BY PATH', async (t) => {
  const { a, root } = await library(t)
  const heat = await filmNamed(a, 'Heat')
  const subs = await a.subtitles({ itemId: heat.id })

  for (const attempt of [
    path.join(root, 'Blurays', 'Heat.jpg'),
    '/etc/passwd',
    '../../../../etc/passwd',
    'Blurays/Heat.en.srt'
  ]) {
    assert.equal(await a.art({ artId: attempt }), null, attempt)
    assert.equal(await a.subtitle({ itemId: heat.id, subtitleId: attempt }), null, attempt)
  }

  // A real subtitle id, asked for against the WRONG item, is refused too.
  const br = await filmNamed(a, 'Blade Runner')
  assert.equal(await a.subtitle({ itemId: br.id, subtitleId: subs[0].id }), null)
})

test('no internal path ever leaves the adapter', async (t) => {
  const { a, root } = await library(t)

  const everything = JSON.stringify([
    await a.list({ type: 'movies' }),
    await a.list({ type: 'series' }),
    await a.stats(),
    await a.subtitles({ itemId: (await filmNamed(a, 'Heat')).id })
  ])

  assert.doesNotMatch(everything, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(everything, /_file|_artFile|_seriesArt|_seasonArt/)
})

/* -------------------------------------------------------------- the cache -- */

test('artwork and subtitles survive a restart from the cache', async (t) => {
  const { root, dataDir, a } = await library(t)
  const before = await filmNamed(a, 'Heat')
  const beforeSubs = await a.subtitles({ itemId: before.id })

  // A second adapter over the same data dir: this is a host restart, and it loads
  // the scan cache rather than walking the disk again. An artId that survives
  // serialisation but whose PATH does not would resolve to nothing here, which is
  // exactly the bug that makes posters vanish after a reboot.
  const b = new FolderAdapter({
    roots: [root], dataDir, libraryId: LIB, ids: protocol.ids, ffprobe: FAKE_FFPROBE
  })
  await b.scan()

  const after = await filmNamed(b, 'Heat')
  assert.equal(after.artId, before.artId, 'ids are stable across a restart')
  assert.equal(await read(await b.art({ artId: after.artId })), 'HEATPOSTER')

  const afterSubs = await b.subtitles({ itemId: after.id })
  assert.deepEqual(afterSubs, beforeSubs)
  assert.equal(await read(await b.subtitle({ itemId: after.id, subtitleId: afterSubs[0].id })), SRT)
})

test('a poster that has been deleted since the scan is null, not a crash', async (t) => {
  const { a, root } = await library(t)
  const heat = await filmNamed(a, 'Heat')
  await fsp.rm(path.join(root, 'Blurays', 'Heat.jpg'))
  assert.equal(await a.art({ artId: heat.artId }), null)
})

test('A RESCAN PICKS UP A POSTER ADDED AFTER THE FIRST SCAN', async (t) => {
  // The user-visible version of this: "I dropped a poster next to my film and
  // nothing changed." The scan cache is deliberately long-lived (12 hours - a
  // rescan of 12,000 files is twenty minutes of a spinning disk), so without a
  // forced walk the new file is invisible and the operator has no way to tell that
  // from a scanner that cannot see it.
  //
  // `--rescan` used to be read ONLY by --codec-report, so `npm run host --rescan`
  // silently did nothing on the path people actually use. It now reaches every scan.
  const { a, root } = await library(t)
  const deadpool = await filmNamed(a, 'Deadpool')
  assert.equal(deadpool.artId, null)

  await fsp.writeFile(path.join(root, 'Blurays', 'Deadpool.jpg'), 'DEADPOOLPOSTER')

  await a.scan()                     // cached: still nothing, and that is correct
  assert.equal((await filmNamed(a, 'Deadpool')).artId, null)

  await a.scan({ force: true })      // what --rescan does
  const after = await filmNamed(a, 'Deadpool')
  assert.ok(after.artId, 'the new poster is found')
  assert.equal(await read(await a.art({ artId: after.artId })), 'DEADPOOLPOSTER')
})

/* ------------------------------------------- the subtitles INSIDE the file -- */
//
// Until 2026-08-13 this adapter read the disk BESIDE a film and nothing within it.
// On the real library that hid 2,715 embedded text tracks across the television, and
// left every film whose only subtitles are PGS showing an empty panel with no
// explanation - which reads as "this app cannot do subtitles" rather than the
// truthful "those ones are pictures".
//
// The fake ffprobe mints tracks from the filename: `.subs-<codec>-<codec>`.

test('THE TRACKS INSIDE A FILE ARE LISTED, and the files beside it still come first', async (t) => {
  const { a } = await library(t, {
    'Tenet/Tenet.subs-subrip-pgssub.mkv': 'x',
    'Tenet/Tenet.subs-subrip-pgssub.en.srt': SRT
  })

  const film = (await a.list({ type: 'movies' })).items.find(m => m.title.startsWith('Tenet'))
  const subs = await a.subtitles({ itemId: film.id })
  assert.equal(subs.length, 3, 'one file on disk plus the two inside the film')

  // ORDER IS THE POINT. A collection whose embedded tracks are mostly pictures looks
  // broken if the panel leads with them.
  assert.equal(subs[0].external, true)
  assert.deepEqual(subs.slice(1).map(s => s.external), [false, false])

  const text = subs.find(s => !s.external && s.codec === 'subrip')
  assert.equal(text.playable, true)
  assert.equal(text.reason, null)
  assert.equal(text.language, 'eng')
  assert.equal(text.title, 'English')

  // And the common case on a film collection, said in words rather than hidden.
  const image = subs.find(s => s.codec === 'pgssub')
  assert.equal(image.playable, false)
  assert.match(image.reason, /pictures rather than text/)
})

test('a film with NOTHING beside it still offers what is inside it', async (t) => {
  const { a } = await library(t, { 'Dune/Dune.subs-subrip.mkv': 'x' })
  const film = (await a.list({ type: 'movies' })).items.find(m => m.title.startsWith('Dune'))
  const subs = await a.subtitles({ itemId: film.id })
  assert.equal(subs.length, 1)
  assert.equal(subs[0].external, false)
  assert.equal(subs[0].playable, true)
})

test('AN UNSHOWABLE TRACK IS NOT SERVED, whatever asks for it', async (t) => {
  // The list is honest about PGS precisely so a client can say why. Handing one over
  // anyway would spawn an ffmpeg to produce nothing and leave a player showing an
  // empty subtitle track with no explanation.
  const { a } = await library(t, { 'Sicario/Sicario.subs-pgssub.mkv': 'x' })
  const film = (await a.list({ type: 'movies' })).items.find(m => m.title.startsWith('Sicario'))
  const [image] = await a.subtitles({ itemId: film.id })

  assert.equal(image.playable, false)
  assert.equal(await a.subtitle({ itemId: film.id, subtitleId: image.id }), null)
})

test('NO TRACK CARRIES A HOST PATH, the same rule the artwork follows', async (t) => {
  const { root, a } = await library(t, { 'Arrival/Arrival.subs-subrip-pgssub.mkv': 'x' })
  const film = (await a.list({ type: 'movies' })).items.find(m => m.title.startsWith('Arrival'))

  const wire = JSON.stringify(await a.subtitles({ itemId: film.id }))
  assert.ok(!wire.includes(root), 'the shape of somebody s disk is not a client s business')
  assert.ok(!wire.includes('_sourceFile'))
  assert.ok(!wire.includes('_embedded'))
})

test('an embedded track cannot be pulled through a DIFFERENT film', async (t) => {
  const { a } = await library(t, {
    'Arrival/Arrival.subs-subrip.mkv': 'x',
    'Sicario/Sicario.subs-subrip.mkv': 'x'
  })
  const films = (await a.list({ type: 'movies' })).items
  const arrival = films.find(m => m.title.startsWith('Arrival'))
  const sicario = films.find(m => m.title.startsWith('Sicario'))

  const [track] = await a.subtitles({ itemId: arrival.id })
  assert.equal(await a.subtitle({ itemId: sicario.id, subtitleId: track.id }), null)
})

test('the tracks inside a file survive a restart from the cache', async (t) => {
  // They are found during the ffprobe pass, so losing them on a cache load would
  // mean a host that shows subtitles until it is restarted - the worst kind of bug
  // to be told about second-hand.
  const { root, dataDir } = await library(t, { 'Tenet/Tenet.subs-subrip-pgssub.mkv': 'x' })

  const b = new FolderAdapter({ roots: [root], dataDir, libraryId: LIB, ids: protocol.ids, ffprobe: FAKE_FFPROBE })
  b.visibleRoots = () => { throw new Error('must not walk') }
  await b.scan()

  const film = (await b.list({ type: 'movies' })).items.find(m => m.title.startsWith('Tenet'))
  const subs = await b.subtitles({ itemId: film.id })
  assert.equal(subs.length, 2)
  assert.equal(subs.filter(s => s.playable).length, 1)
})
