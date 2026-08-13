// The codec report.
//
// The tool that answers the question direct-play-only v1 exists to ask: what is
// actually in a real library. It has to walk BOTH roots - films are a flat list,
// episodes hang under the show tree - or it confidently describes half a
// collection.

const test = require('node:test')
const assert = require('node:assert/strict')

const items = require('../host/items')
const { codecReport, collect, summarize, bucket } = require('../host/codec-report')

// A library with both roots, deep enough to need paging on one of them.
function library () {
  const films = Array.from({ length: 250 }, (_, i) => items.movie({
    id: `film-${i}`,
    title: `Film ${i}`,
    media: i % 3 === 0
      ? { container: 'mkv', videoCodec: 'hevc', audioCodec: 'truehd', height: 2160, size: 8e9 }
      : { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', height: 1080, size: 2e9 }
  }))

  const episodes = Array.from({ length: 26 }, (_, i) => items.episode({
    id: `ep-${i}`,
    seriesId: 'show',
    seasonId: i < 13 ? 'show-s1' : 'show-s2',
    seriesTitle: 'A Show',
    seasonNumber: i < 13 ? 1 : 2,
    episodeNumber: (i % 13) + 1,
    title: `Episode ${i}`,
    media: { container: 'mkv', videoCodec: 'h264', audioCodec: 'ac3', height: 720, size: 5e8 }
  }))

  return {
    kind: 'test',
    async scan () { return films.length + episodes.length },
    async stats () { return { movies: films.length, series: 1, seasons: 2, episodes: episodes.length } },
    async list ({ type, seriesId, seasonId, limit = 100, cursor = 0 }) {
      let pool = []
      if (type === 'movies') pool = films
      else if (type === 'series') pool = [items.series({ id: 'show', title: 'A Show' })]
      else if (type === 'seasons' && seriesId === 'show') {
        pool = [
          items.season({ id: 'show-s1', seriesId: 'show', number: 1 }),
          items.season({ id: 'show-s2', seriesId: 'show', number: 2 })
        ]
      } else if (type === 'episodes' && seasonId) {
        pool = episodes.filter(e => e.seasonId === seasonId)
      }
      return items.page(pool, { limit, cursor })
    }
  }
}

test('the walk covers BOTH roots, films and the whole show tree', async () => {
  const leaves = await collect(library())
  assert.equal(leaves.length, 276, '250 films plus 26 episodes')
  assert.equal(leaves.filter(l => l.type === 'movie').length, 250)
  assert.equal(leaves.filter(l => l.type === 'episode').length, 26)
})

test('the walk PAGES rather than trusting one request to hold the library', async () => {
  // 250 films against a 200-row page. A report that stopped at the first page would
  // silently describe 80% of the collection and look completely plausible.
  const leaves = await collect(library())
  const filmIds = new Set(leaves.filter(l => l.type === 'movie').map(l => l.id))
  assert.equal(filmIds.size, 250)
  assert.ok(filmIds.has('film-249'), 'the last page was fetched')
})

test('the combination is what gets counted, because the combination is what decides', async () => {
  const { summary } = await codecReport(library())

  // MKV + HEVC + TrueHD is the notorious one: it does not direct-play on iOS at all.
  const notorious = summary.combos.find(([k]) => k === 'mkv / hevc / truehd')
  assert.ok(notorious, 'the combination is reported as a combination')
  assert.equal(notorious[1], 84, 'every third film')

  // The same codecs appear in other combinations, which is exactly why counting
  // them separately would mislead.
  const h264 = summary.videoCodecs.find(([k]) => k === 'h264')
  assert.equal(h264[1], 166 + 26)
})

test('RESOLUTION IS BUCKETED BY WIDTH, or every scope film is filed as 720p', () => {
  // Caught on the first real library. A 1080p copy of 2001: A Space Odyssey is
  // 1920x864 - the film is 2.20:1 and the bars are cropped rather than encoded - so
  // a height-based bucket called it 864p and filed it under 720p. It would do that
  // to most of cinema.
  assert.equal(bucket({ width: 1920, height: 864 }), '1080p')
  assert.equal(bucket({ width: 3840, height: 1600 }), '4K')

  // Television is 16:9 and reads the same either way, which is why height LOOKED
  // right until the library was films.
  assert.equal(bucket({ width: 1920, height: 1080 }), '1080p')
  assert.equal(bucket({ width: 1280, height: 720 }), '720p')
  assert.equal(bucket({ width: 720, height: 576 }), 'SD')

  // Height is the fallback for a source that reports only one dimension.
  assert.equal(bucket({ height: 1080 }), '1080p')
  assert.equal(bucket({}), '(unknown)')
  assert.equal(bucket(null), '(unknown)')
})

test('a source that reports NO media facts says so, rather than printing blanks', async () => {
  const blank = {
    async list ({ type, limit = 100, cursor = 0 }) {
      const pool = type === 'movies'
        ? [items.movie({ id: 'a', title: 'A' }), items.movie({ id: 'b', title: 'B' })]
        : []
      return items.page(pool, { limit, cursor })
    }
  }
  const { summary, text } = await codecReport(blank)
  assert.equal(summary.total, 2)
  assert.equal(summary.unknownMedia, 2)
  assert.match(text, /cannot answer the direct-play question/)
})

test('THE REPORT DESCRIBES, IT DOES NOT JUDGE', async () => {
  // A verdict here would answer the question the report exists to ask. The honest
  // answer only arrives once a phone has tried.
  const { text, summary } = await codecReport(library())
  assert.match(text, /This is a description, not a verdict/)
  assert.ok(!/\bplayable\b/i.test(text), 'no playability claim anywhere in the output')
  assert.equal('playable' in summary, false)
  assert.equal('directPlay' in summary, false)
})

test('the rendered report leads with the shape of the collection', async () => {
  const { text } = await codecReport(library())
  assert.match(text, /276 items - 250 films, 26 episodes/)
  assert.match(text, /CONTAINERS/)
  assert.match(text, /COMBINATIONS/)
  // Sizes in something a person reads.
  assert.match(text, /\d+\.\d GB/)
})

test('an empty library reports emptily rather than dividing by zero', async () => {
  const empty = { async list () { return items.page([], {}) } }
  const { summary, text } = await codecReport(empty)
  assert.equal(summary.total, 0)
  assert.ok(text.includes('0 items'))
})

test('summarize is pure, so the numbers can be checked without a source', () => {
  const s = summarize([
    items.movie({ id: 'a', title: 'A', media: { container: 'mkv', videoCodec: 'hevc', audioCodec: 'eac3', height: 2160, size: 1e9 } }),
    items.movie({ id: 'b', title: 'B', media: { container: 'mkv', videoCodec: 'hevc', audioCodec: 'eac3', height: 2160, size: 1e9 } })
  ])
  assert.equal(s.total, 2)
  assert.equal(s.bytes, 2e9)
  assert.deepEqual(s.containers, [['mkv', 2]])
  assert.deepEqual(s.combos, [['mkv / hevc / eac3', 2]])
  assert.deepEqual(s.resolutions, [['4K', 2]])
})
