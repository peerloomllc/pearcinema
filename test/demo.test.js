'use strict'

// The demo library (proposal 2026-08-26-app-review-demo): the films that ship inside
// the app and play with no host at all.
//
// Everything here runs off a hand-written manifest with no files on disk, which is the
// point of src/demo.js existing as its own module: src/bare.js is a top-level worklet
// script and cannot be required by a test, so the catalog build, the browse answers,
// the watch state and the Range arithmetic all live where they can be checked.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const D = require('../src/demo')
const { createProtocol } = require('@peerloom/host/protocol')

const ids = createProtocol({ app: 'pearcinema' }).ids

const MANIFEST = {
  name: 'Demo library',
  films: [
    {
      file: 'Films/Duck and Cover (1951).mp4',
      poster: 'Films/Duck and Cover (1951).bin',
      title: 'Duck and Cover',
      year: 1951,
      runtime: 554,
      genres: ['Short'],
      overview: 'Bert the Turtle.',
      media: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, width: 720, height: 480 }
    },
    {
      file: 'Films/A Trip Down Market Street (1906).mp4',
      title: 'A Trip Down Market Street',
      year: 1906,
      runtime: 717,
      media: { container: 'mp4', videoCodec: 'h264', width: 640, height: 480 }
    }
  ],
  shows: [
    {
      title: 'The Apollo Missions',
      poster: 'TV Shows/The Apollo Missions/poster.bin',
      year: 1969,
      overview: 'Made for NASA.',
      episodes: [
        { file: 'TV/s01e02.mp4', season: 1, episode: 2, title: 'Houston', runtime: 1701 },
        { file: 'TV/s01e01.mp4', season: 1, episode: 1, title: 'The Eagle Has Landed', runtime: 1706 }
      ]
    }
  ]
}

const build = (over = {}) => D.buildDemoCatalog(MANIFEST, { ids, ...over })

test('the catalog is the two library roots, in the shapes the app already serves', () => {
  const c = build()
  assert.equal(c.movies.length, 2)
  assert.equal(c.series.length, 1)
  assert.equal(c.seasons.length, 1)
  assert.equal(c.episodes.length, 2)

  const m = c.movies.find((x) => x.title === 'Duck and Cover')
  assert.equal(m.type, 'movie')
  assert.equal(m.year, 1951)
  assert.equal(m.runtime, 554)
  assert.equal(m.media.videoCodec, 'h264')
  assert.equal(m.libraryId, c.libraryId)

  const s = c.series[0]
  assert.equal(s.seasonCount, 1)
  assert.equal(s.episodeCount, 2)
  assert.equal(c.seasons[0].title, 'Season 1')
  assert.equal(c.seasons[0].episodeCount, 2)
})

test('episodes come back in airing order however the manifest listed them', () => {
  const c = build()
  assert.deepEqual(c.episodes.map((e) => e.episodeNumber), [1, 2])
  const list = D.demoList(c, { type: 'episodes', seasonId: c.seasons[0].id })
  assert.deepEqual(list.items.map((e) => e.title), ['The Eagle Has Landed', 'Houston'])
})

test('season 0 is Specials, not "no season"', () => {
  const c = D.buildDemoCatalog({
    shows: [{ title: 'Show', episodes: [{ file: 'x.mp4', season: 0, episode: 1, title: 'Extra' }] }]
  }, { ids })
  assert.equal(c.seasons[0].number, 0)
  assert.equal(c.seasons[0].title, 'Specials')
})

test('ids are stable across builds and scoped to the demo library', () => {
  const a = build()
  const b = build()
  assert.deepEqual([...a.paths.keys()], [...b.paths.keys()])
  // A real library pointed at these very files must not collide with the demo: the
  // source kind is part of every id.
  const real = ids.itemId(a.libraryId, 'folder', 'Films/Duck and Cover (1951).mp4')
  const mine = ids.itemId(a.libraryId, 'demo', 'Films/Duck and Cover (1951).mp4')
  assert.notEqual(real, mine)
  assert.ok(a.ids.has(mine))
})

test('a film the shell could not resolve is left out rather than listed unplayably', () => {
  const c = build({ files: { 'Films/Duck and Cover (1951).mp4': '/tmp/x.mp4', 'TV/s01e01.mp4': '/tmp/y.mp4' } })
  assert.deepEqual(c.movies.map((m) => m.title), ['Duck and Cover'])
  assert.equal(c.episodes.length, 1)
  assert.equal(c.series[0].episodeCount, 1)
})

test('a show with no resolvable episodes does not appear at all', () => {
  const c = build({ files: { 'Films/Duck and Cover (1951).mp4': '/tmp/x.mp4' } })
  assert.equal(c.series.length, 0)
  assert.equal(c.seasons.length, 0)
})

test('sizes come off the files when there are files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-'))
  const p = path.join(dir, 'film.mp4')
  fs.writeFileSync(p, Buffer.alloc(4321))
  const stats = D.statDemoFiles({ 'Films/Duck and Cover (1951).mp4': p, 'missing.mp4': '/nope/nothing' })
  assert.equal(stats['Films/Duck and Cover (1951).mp4'].size, 4321)
  assert.equal(stats['missing.mp4'].size, 0)

  const c = D.buildDemoCatalog(MANIFEST, { ids, stats })
  assert.equal(c.movies.find((m) => m.title === 'Duck and Cover').media.size, 4321)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('browse: lists page, get finds every level, search matches shows and episodes', () => {
  const c = build()
  const first = D.demoList(c, { type: 'movies', limit: 1 })
  assert.equal(first.items.length, 1)
  assert.equal(first.total, 2)
  assert.equal(first.cursor, 1)
  assert.equal(D.demoList(c, { type: 'movies', limit: 1, cursor: 1 }).cursor, null)

  assert.equal(D.demoGet(c, c.series[0].id).type, 'series')
  assert.equal(D.demoGet(c, c.seasons[0].id).type, 'season')
  assert.equal(D.demoGet(c, 'nope'), null)

  // The show and both its episodes, because an episode matches on its show's name too -
  // the same rule the merged search follows.
  assert.deepEqual(D.demoSearch(c, 'apollo').items.map((i) => i.type), ['series', 'episode', 'episode'])
  assert.equal(D.demoSearch(c, 'eagle').items[0].title, 'The Eagle Has Landed')
  assert.equal(D.demoSearch(c, '').items.length, 0)
})

test('siblings walk the show and stop at its ends', () => {
  const c = build()
  const [one, two] = c.episodes
  assert.equal(D.demoSiblings(c, one.id).prev, null)
  assert.equal(D.demoSiblings(c, one.id).next.id, two.id)
  assert.equal(D.demoSiblings(c, two.id).next, null)
  assert.deepEqual(D.demoSiblings(c, c.movies[0].id), { prev: null, next: null })
})

test('watch state: the app\'s own started and finished rules, kept on the phone', () => {
  const c = build()
  const film = c.movies.find((m) => m.title === 'Duck and Cover') // 554s
  let st = D.emptyDemoState()

  // Under a minute is not a start, so nothing is remembered.
  st = D.setDemoResume(st, { id: film.id, positionMs: 20_000, runtime: film.runtime })
  assert.equal(D.demoResume(st, film.id).resume, null)

  st = D.setDemoResume(st, { id: film.id, positionMs: 200_000, runtime: film.runtime, now: 5 })
  assert.equal(D.demoResume(st, film.id).resume.positionMs, 200_000)
  assert.equal(D.demoResumeShelf(c, st).items[0].id, film.id)
  assert.equal(D.demoResumeShelf(c, st).items[0].resume.positionMs, 200_000)

  // Past 95% is finished: the place is dropped and the tick goes on.
  st = D.setDemoResume(st, { id: film.id, positionMs: 553_000, runtime: film.runtime })
  assert.equal(D.demoResume(st, film.id).resume, null)
  assert.ok(st.watched.includes(film.id))

  // Marking watched by hand also takes it off the Continue shelf.
  st = D.setDemoResume(st, { id: film.id, positionMs: 200_000, runtime: film.runtime })
  st = D.setDemoWatched(st, film.id, true)
  assert.equal(D.demoResumeShelf(c, st).items.length, 0)
  st = D.setDemoWatched(st, film.id, false)
  assert.equal(st.watched.length, 0)
})

test('the watchlist resolves to items and drops anything not in the library', () => {
  const c = build()
  let st = D.setDemoFav(D.emptyDemoState(), c.series[0].id, true)
  st = D.setDemoFav(st, 'a-film-that-left', true)
  assert.deepEqual(D.demoFavShelf(c, st).items.map((i) => i.title), ['The Apollo Missions'])
  st = D.setDemoFav(st, c.series[0].id, false)
  assert.equal(D.demoFavShelf(c, st).items.length, 0)
})

test('the shelf survives a demo.json written by an older build', () => {
  const c = build()
  assert.deepEqual(D.demoResumeShelf(c, null).items, [])
  assert.deepEqual(D.demoFavShelf(c, { favs: 'nonsense' }).items, [])
  assert.deepEqual(D.setDemoWatched(undefined, 'x', true).watched, ['x'])
})

test('the routes only claim what belongs to the demo', () => {
  assert.equal(D.demoRoute('/demo/abc123'), 'abc123')
  assert.equal(D.demoRoute('/demo/abc123?x=1'), 'abc123')
  assert.equal(D.demoRoute('/t/abc123'), null)
  assert.equal(D.demoRoute('/hls/abc123.m3u8'), null)

  // Art arrives with the cache-busting generation segment and a size, and neither is
  // part of the id.
  assert.equal(D.demoArtRoute('/art/abc123?s=350'), 'abc123')
  assert.equal(D.demoArtRoute('/art/_g2/abc123?s=120'), 'abc123')
  assert.equal(D.demoArtRoute('/t/abc123'), null)
})

test('Range: a plain read, a window, an open end and the suffix iOS asks for', () => {
  const size = 1000
  const plain = D.demoStreamHead({ size })
  assert.equal(plain.status, 200)
  assert.equal(plain.headers['content-length'], '1000')
  assert.equal(plain.headers['accept-ranges'], 'bytes')
  assert.equal(plain.start, 0)
  assert.equal(plain.end, 999)

  const window1 = D.demoStreamHead({ size, range: 'bytes=100-199' })
  assert.equal(window1.status, 206)
  assert.equal(window1.headers['content-range'], 'bytes 100-199/1000')
  assert.equal(window1.headers['content-length'], '100')

  const open = D.demoStreamHead({ size, range: 'bytes=500-' })
  assert.equal(open.headers['content-range'], 'bytes 500-999/1000')

  // THE SUFFIX RANGE IS NOT AN EDGE CASE: iOS asks for the last n bytes to read the
  // moov atom of an MP4 whose index is at the end. Getting it wrong is "the film will
  // not open" rather than "seeking is odd".
  const tail = D.demoStreamHead({ size, range: 'bytes=-200' })
  assert.equal(tail.start, 800)
  assert.equal(tail.end, 999)
  assert.equal(tail.headers['content-range'], 'bytes 800-999/1000')

  // Past the end, backwards, and nonsense are all one answer.
  for (const bad of ['bytes=1000-1200', 'bytes=300-100', 'bytes=-', 'items=0-10', 'bytes=abc']) {
    const r = D.demoStreamHead({ size, range: bad })
    assert.equal(r.status, 416, bad)
    assert.equal(r.headers['content-range'], 'bytes */1000')
  }

  // An end past the file is clamped rather than refused: players ask for more than
  // there is all the time.
  assert.equal(D.demoStreamHead({ size, range: 'bytes=900-5000' }).headers['content-range'], 'bytes 900-999/1000')
})

// A response the route can write to and a test can read back, standing in for the
// shim's. Nothing here fakes the file read: the bytes come off a real file through the
// real function, which is the half that a Range header being one byte out breaks.
function fakeRes () {
  return {
    status: null,
    headers: null,
    chunks: [],
    ended: false,
    writeHead (s, h) { this.status = s; this.headers = h },
    write (c) { this.chunks.push(Buffer.from(c)); return true },
    end () { this.ended = true },
    once () {},
    destroy () { this.destroyed = true },
    get body () { return Buffer.concat(this.chunks) }
  }
}

test('the demo route serves real bytes, and serves the right ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-serve-'))
  const file = path.join(dir, 'film.mp4')
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
  fs.writeFileSync(file, bytes)

  const serve = (range, mime) => new Promise((resolve) => {
    const res = fakeRes()
    const realEnd = res.end.bind(res)
    res.end = () => { realEnd(); resolve(res) }
    D.serveDemoFile({ file, mime, req: { headers: range ? { range } : {} }, res })
  })

  const whole = await serve()
  assert.equal(whole.status, 200)
  assert.equal(whole.headers['content-type'], 'video/mp4')
  assert.equal(whole.body.length, 1000)
  assert.ok(whole.body.equals(bytes))

  const part = await serve('bytes=100-199')
  assert.equal(part.status, 206)
  assert.equal(part.headers['content-range'], 'bytes 100-199/1000')
  assert.ok(part.body.equals(bytes.subarray(100, 200)))

  // The read iOS opens an MP4 with.
  const tail = await serve('bytes=-64')
  assert.ok(tail.body.equals(bytes.subarray(936)))

  const bad = await serve('bytes=2000-3000')
  assert.equal(bad.status, 416)
  assert.equal(bad.body.length, 0)

  const poster = await serve(null, 'image/jpeg')
  assert.equal(poster.headers['content-type'], 'image/jpeg')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a film whose bundle path has moved answers 404 rather than hanging', () => {
  const res = fakeRes()
  D.serveDemoFile({ file: '/nowhere/gone.mp4', req: { headers: {} }, res })
  assert.equal(res.status, 404)
  assert.equal(res.ended, true)
})

test('stats read like any other adapter\'s', () => {
  const s = D.demoStats(build())
  assert.equal(s.demo, true)
  assert.equal(s.source, 'demo')
  assert.equal(s.movies, 2)
  assert.equal(s.episodes, 2)
  assert.equal(s.sourceError, null)
})
