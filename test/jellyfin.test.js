// The Jellyfin adapter.
//
// Driven against RECORDED Jellyfin shapes rather than a live server, so the suite
// runs anywhere and the assertions are about mapping rather than about whose
// server happened to be up. The shapes below are Jellyfin's real ones - ticks,
// ParentIndexNumber, MediaSources.MediaStreams, ImageTags - because getting those
// wrong is exactly the bug class this file exists to catch.
//
// The thing this CANNOT tell us is which files actually direct-play on a real
// phone. That is the whole question v1 exists to answer and it needs Tim's own
// library, not a fixture. It is on the TODO as its own item.

const test = require('node:test')
const assert = require('node:assert/strict')

const { createProtocol } = require('@peerloom/host')
const { JellyfinAdapter } = require('../host/adapters/jellyfin')

const protocol = createProtocol({ app: 'pearcinema', displayName: 'PearCinema' })
const LIB = protocol.ids.libraryId(require('hypercore-crypto').keyPair().publicKey)

// --- recorded server shapes -------------------------------------------------

const TICKS = 10_000_000

const METROPOLIS = {
  Id: 'jf-metropolis',
  Type: 'Movie',
  Name: 'Metropolis',
  ProductionYear: 1927,
  RunTimeTicks: 9180 * TICKS,
  Overview: 'A futuristic city.',
  Genres: ['Science Fiction', 'Drama'],
  ImageTags: { Primary: 'abc' },
  MediaSources: [{
    Id: 'src-metro',
    Container: 'mkv',
    Size: 8_000_000_000,
    MediaStreams: [
      { Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160 },
      { Type: 'Audio', Codec: 'truehd' },
      { Type: 'Subtitle', Index: 2, Codec: 'pgssub', Language: 'eng', DisplayTitle: 'English (PGS)' },
      { Type: 'Subtitle', Index: 3, Codec: 'subrip', Language: 'fra', DisplayTitle: 'French' },
      { Type: 'Subtitle', Index: 4, Codec: 'subrip', Language: 'deu', DisplayTitle: 'German', IsExternal: true }
    ]
  }]
}

const WIRE_SERIES = {
  Id: 'jf-wire',
  Type: 'Series',
  Name: 'The Wire',
  ProductionYear: 2002,
  ChildCount: 5,
  RecursiveItemCount: 60,
  ImageTags: { Primary: 'w' }
}

const WIRE_SPECIALS = {
  Id: 'jf-wire-s0',
  Type: 'Season',
  Name: 'Specials',
  SeriesId: 'jf-wire',
  SeriesName: 'The Wire',
  // The value that breaks a falsy check.
  IndexNumber: 0,
  ChildCount: 2
}

const WIRE_S1 = {
  Id: 'jf-wire-s1',
  Type: 'Season',
  Name: 'Season 1',
  SeriesId: 'jf-wire',
  SeriesName: 'The Wire',
  IndexNumber: 1,
  ChildCount: 13
}

const WIRE_S1E1 = {
  Id: 'jf-wire-s1e1',
  Type: 'Episode',
  Name: 'The Target',
  SeriesId: 'jf-wire',
  SeriesName: 'The Wire',
  SeasonId: 'jf-wire-s1',
  ParentIndexNumber: 1,
  IndexNumber: 1,
  ProductionYear: 2002,
  RunTimeTicks: 3600 * TICKS,
  MediaSources: [{
    Id: 'src-e1',
    Container: 'mp4',
    Size: 1_200_000_000,
    MediaStreams: [
      { Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
      { Type: 'Audio', Codec: 'aac' }
    ]
  }]
}

// Season 0 episode - a special. Its ParentIndexNumber is 0.
const WIRE_SPECIAL_EP = {
  Id: 'jf-wire-sp1',
  Type: 'Episode',
  Name: 'Behind the Scenes',
  SeriesId: 'jf-wire',
  SeriesName: 'The Wire',
  SeasonId: 'jf-wire-s0',
  ParentIndexNumber: 0,
  IndexNumber: 1
}

// A mixed library: a music album Jellyfin also holds. Not ours.
const AN_ALBUM = { Id: 'jf-album', Type: 'MusicAlbum', Name: 'Meddle' }

// --- a fake server ----------------------------------------------------------

function server ({ items = [], info = { ProductName: 'Jellyfin Server' }, counts = {} } = {}) {
  const calls = []

  const json = (body) => ({ ok: true, status: 200, json: async () => body })
  const bytes = (s) => ({ ok: true, status: 200, body: s })
  const notFound = () => ({ ok: false, status: 404, json: async () => ({}) })

  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url)
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers: opts.headers || {} })

    if (u.pathname === '/Users/AuthenticateByName') {
      return json({ AccessToken: 'tok', User: { Id: 'user-1', Name: 'tim' } })
    }
    if (u.pathname === '/System/Info/Public') {
      return info ? json(info) : notFound()
    }
    if (u.pathname.startsWith('/Items/') && u.pathname.includes('/Images/')) {
      return u.pathname.includes('missing') ? notFound() : bytes('IMAGE')
    }
    if (u.pathname.includes('/Subtitles/')) return bytes('SRT')
    if (u.pathname.startsWith('/Videos/') && u.pathname.endsWith('/stream')) return bytes('VIDEO')

    if (u.pathname.startsWith('/Users/') && u.pathname.includes('/Items/')) {
      const id = u.pathname.split('/Items/')[1]
      const hit = items.find(i => i.Id === id)
      return hit ? json(hit) : notFound()
    }

    if (u.pathname === '/Items') {
      const want = String(u.searchParams.get('IncludeItemTypes') || '').split(',').filter(Boolean)
      const parent = u.searchParams.get('ParentId')
      let pool = items.filter(i => !want.length || want.includes(i.Type))
      if (parent) pool = pool.filter(i => i.SeriesId === parent || i.SeasonId === parent)

      const term = u.searchParams.get('searchTerm')
      if (term) pool = pool.filter(i => i.Name.toLowerCase().includes(term.toLowerCase()))

      const total = counts[want.join(',')] ?? pool.length
      const start = Number(u.searchParams.get('StartIndex') || 0)
      const limit = Number(u.searchParams.get('Limit') ?? 100)
      return json({ Items: limit === 0 ? [] : pool.slice(start, start + limit), TotalRecordCount: total })
    }

    return notFound()
  }

  return { fetchImpl, calls }
}

function adapter (opts = {}) {
  const s = server(opts)
  const a = new JellyfinAdapter({
    url: 'http://jelly.local:8096/',
    username: 'tim',
    password: 'pw',
    libraryId: LIB,
    ids: protocol.ids,
    fetchImpl: s.fetchImpl
  })
  return { a, calls: s.calls }
}

const LIBRARY = [METROPOLIS, WIRE_SERIES, WIRE_SPECIALS, WIRE_S1, WIRE_S1E1, WIRE_SPECIAL_EP, AN_ALBUM]

// --- auth -------------------------------------------------------------------

test('logs in ONCE and shares the login across concurrent callers', async () => {
  const { a, calls } = adapter({ items: LIBRARY })
  await Promise.all([a.ping(), a.ping(), a.ping(), a.ping()])
  const logins = calls.filter(c => c.path === '/Users/AuthenticateByName')
  assert.equal(logins.length, 1, 'a cold host must not fire four logins at one server')
})

test('sends BOTH the Jellyfin and the Emby auth headers', async () => {
  const { a, calls } = adapter({ items: LIBRARY })
  await a.scan()
  const call = calls.find(c => c.path === '/Items')
  assert.match(call.headers.authorization, /^MediaBrowser .*Token="tok"/)
  assert.match(call.headers['x-emby-authorization'], /^MediaBrowser Client="PearCinema"/)
  assert.equal(call.headers['x-emby-token'], 'tok')
})

test('a wrong password fails loudly, at scan, not on a user\'s first tap', async () => {
  const a = new JellyfinAdapter({
    url: 'http://jelly.local',
    username: 'tim',
    password: 'wrong',
    libraryId: LIB,
    ids: protocol.ids,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
  })
  await assert.rejects(() => a.scan(), /wrong username or password/)
})

test('a reachable server with no ProductName is Emby', async () => {
  const jelly = adapter({ items: LIBRARY })
  await jelly.a.scan()
  assert.equal((await jelly.a.stats()).sourceName, 'Jellyfin Server')

  const emby = adapter({ items: LIBRARY, info: { ServerName: 'a-container-id' } })
  await emby.a.scan()
  assert.equal((await emby.a.stats()).sourceName, 'Emby')
})

test('the device id is stable, so Jellyfin\'s device list does not fill with ghosts', () => {
  const one = adapter().a
  const two = adapter().a
  assert.equal(one.deviceId, two.deviceId)
  assert.match(one.deviceId, /^pearcinema-[0-9a-f]{16}$/)
})

// --- scan and stats ---------------------------------------------------------

test('scan counts each type and returns LEAVES, because a season is not a thing you watch', async () => {
  const { a } = adapter({
    items: LIBRARY,
    counts: { Movie: 40, Series: 5, Season: 22, Episode: 300 }
  })
  assert.equal(await a.scan(), 340, 'movies + episodes')

  const stats = await a.stats()
  assert.deepEqual(
    { movies: stats.movies, series: stats.series, seasons: stats.seasons, episodes: stats.episodes },
    { movies: 40, series: 5, seasons: 22, episodes: 300 }
  )
  assert.equal(stats.source, 'jellyfin')
  assert.ok(stats.scannedAt)
})

// --- mapping ----------------------------------------------------------------

test('a Movie maps to our leaf, with the codec facts v1 exists to gather', async () => {
  const { a } = adapter({ items: LIBRARY })
  const { items: [film] } = await a.list({ type: 'movies' })

  assert.equal(film.type, 'movie')
  assert.equal(film.title, 'Metropolis')
  assert.equal(film.year, 1927)
  // Ticks to SECONDS, the same unit a resume position uses.
  assert.equal(film.runtime, 9180)
  assert.deepEqual(film.genres, ['Science Fiction', 'Drama'])
  assert.equal(film.artId, 'jf-metropolis')

  // The whole reason for direct-play-only v1: this is a 4K HEVC TrueHD MKV, which
  // is the exact combination that does not direct-play on iOS at all.
  assert.deepEqual(film.media, {
    container: 'mkv',
    videoCodec: 'hevc',
    audioCodec: 'truehd',
    width: 3840,
    height: 2160,
    size: 8_000_000_000
  })
})

test('SEASON 0 SURVIVES the mapping - IndexNumber 0 is Specials, not "no season"', async () => {
  const { a } = adapter({ items: LIBRARY })
  const { items: seasons } = await a.list({ type: 'seasons', seriesId: await ourId(a, 'jf-wire') })

  const specials = seasons.find(s => s.title === 'Specials')
  assert.ok(specials, 'specials must not vanish')
  assert.equal(specials.number, 0)

  const one = seasons.find(s => s.number === 1)
  assert.equal(one.title, 'Season 1')
})

test('an Episode carries its season from ParentIndexNumber and its slot from IndexNumber', async () => {
  const { a } = adapter({ items: LIBRARY })
  const { items: eps } = await a.list({ type: 'episodes', seasonId: await ourId(a, 'jf-wire-s1') })
  const e = eps.find(x => x.title === 'The Target')

  assert.equal(e.type, 'episode')
  assert.equal(e.seriesTitle, 'The Wire')
  assert.equal(e.seasonNumber, 1)
  assert.equal(e.episodeNumber, 1)
  assert.equal(e.runtime, 3600)
  assert.equal(e.media.videoCodec, 'h264')
})

test('a season-0 EPISODE keeps its zero too', async () => {
  const { a } = adapter({ items: LIBRARY })
  const { items: eps } = await a.list({ type: 'episodes', seasonId: await ourId(a, 'jf-wire-s0') })
  assert.equal(eps[0].seasonNumber, 0)
  assert.equal(require('../host/items').episodeCode(eps[0]), 'S00E01')
})

test('a Series carries seasons and episodes off the right two count fields', async () => {
  const { a } = adapter({ items: LIBRARY })
  const { items: [show] } = await a.list({ type: 'series' })
  assert.equal(show.seasonCount, 5)
  assert.equal(show.episodeCount, 60)
})

test('A MIXED LIBRARY IS FILTERED, not mangled', async () => {
  // Jellyfin serves music and photos too. Anything that is not one of our four types
  // is dropped rather than mapped into a wrong shape.
  const { a } = adapter({ items: LIBRARY })
  const all = await a.list({ type: 'movies', limit: 100 })
  assert.ok(!all.items.some(i => i.title === 'Meddle'))
  assert.equal(a._map(AN_ALBUM), null)
})

test('an item with no artwork has no artId, so nobody fetches a 404', async () => {
  const { a } = adapter({ items: [{ ...METROPOLIS, ImageTags: {} }] })
  const { items: [film] } = await a.list({ type: 'movies' })
  assert.equal(film.artId, null)
})

// --- listing ----------------------------------------------------------------

test('a scoped list asks Jellyfin for the CHILDREN of a parent', async () => {
  const { a, calls } = adapter({ items: LIBRARY })
  const seriesId = await ourId(a, 'jf-wire')
  await a.list({ type: 'seasons', seriesId })

  const call = calls.filter(c => c.path === '/Items').pop()
  assert.equal(call.params.ParentId, 'jf-wire')
  assert.equal(call.params.IncludeItemTypes, 'Season')
})

test('AN UNRESOLVABLE PARENT IS AN EMPTY LIST, never the whole library', async () => {
  // Falling back to unscoped here would answer "this season's episodes" with every
  // episode on the server, which reads as a bug in the show rather than in us.
  const { a } = adapter({ items: LIBRARY })
  const res = await a.list({ type: 'episodes', seasonId: 'not-a-real-id' })
  assert.deepEqual(res.items, [])
  assert.equal(res.total, 0)
})

test('each list type gets a structural sort by default, not alphabetical', async () => {
  const { a, calls } = adapter({ items: LIBRARY })

  await a.list({ type: 'episodes', seasonId: await ourId(a, 'jf-wire-s1') })
  assert.equal(calls.filter(c => c.path === '/Items').pop().params.SortBy, 'ParentIndexNumber,IndexNumber,SortName')

  await a.list({ type: 'seasons', seriesId: await ourId(a, 'jf-wire') })
  assert.equal(calls.filter(c => c.path === '/Items').pop().params.SortBy, 'IndexNumber,SortName')

  await a.list({ type: 'movies', sort: 'year', order: 'desc' })
  const last = calls.filter(c => c.path === '/Items').pop()
  assert.equal(last.params.SortBy, 'ProductionYear,PremiereDate,SortName')
  assert.equal(last.params.SortOrder, 'Descending')
})

test('paging walks and stops', async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({
    ...METROPOLIS, Id: `m${i}`, Name: `Film ${i}`
  }))
  const { a } = adapter({ items: many })

  const first = await a.list({ type: 'movies', limit: 100 })
  assert.equal(first.items.length, 100)
  assert.equal(first.total, 250)
  assert.equal(first.cursor, 100)

  const last = await a.list({ type: 'movies', limit: 100, cursor: 200 })
  assert.equal(last.items.length, 50)
  assert.equal(last.cursor, null)
})

// --- get and search ---------------------------------------------------------

test('get resolves our hashed id back to Jellyfin\'s, and type-checks the answer', async () => {
  const { a } = adapter({ items: LIBRARY })
  const id = await ourId(a, 'jf-metropolis')

  const film = await a.get({ id })
  assert.equal(film.title, 'Metropolis')

  // Asking for the wrong type is a miss, not a surprise object.
  assert.equal(await a.get({ id, type: 'episode' }), null)
  assert.equal(await a.get({ id: 'nope' }), null)
})

test('an id NOT in the cache is found by walking - the cold-host resume case', async () => {
  const { a } = adapter({ items: LIBRARY })
  // Compute the id without ever listing, exactly as a phone resuming a paused queue
  // against a freshly restarted host would present it.
  const cold = protocol.ids.itemId(LIB, 'jellyfin', 'jf-wire-s1e1')
  assert.equal(a.remoteIds.has(cold), false)

  const e = await a.get({ id: cold })
  assert.equal(e.title, 'The Target')
})

test('search covers films, shows and episodes in one call, and drops the rest', async () => {
  const { a, calls } = adapter({ items: LIBRARY })
  const res = await a.search({ q: 'wire' })

  const call = calls.filter(c => c.path === '/Items').pop()
  assert.equal(call.params.IncludeItemTypes, 'Movie,Series,Episode')
  assert.ok(res.items.some(i => i.type === 'series'))

  assert.deepEqual((await a.search({ q: '' })).items, [])
})

// --- subtitles --------------------------------------------------------------

test('SUBTITLES ARE LISTED HONESTLY: PGS shows up, marked unplayable, with a reason', async () => {
  // v1 lists what it cannot serve rather than hiding it. Hiding an image-based track
  // would leave someone hunting for subtitles the file demonstrably contains.
  const { a } = adapter({ items: LIBRARY })
  const subs = await a.subtitles({ itemId: await ourId(a, 'jf-metropolis') })

  assert.equal(subs.length, 3)

  const pgs = subs.find(s => s.codec === 'pgssub')
  assert.equal(pgs.playable, false)
  assert.match(pgs.reason, /re-encoded to burn them in/)
  assert.equal(pgs.language, 'eng')

  const srt = subs.find(s => s.language === 'fra')
  assert.equal(srt.playable, true)
  assert.equal(srt.reason, null)

  const external = subs.find(s => s.language === 'deu')
  assert.equal(external.external, true)
  assert.equal(external.playable, true)
})

test('an unknown subtitle codec is refused by name rather than silently', async () => {
  const weird = {
    ...METROPOLIS,
    MediaSources: [{
      Id: 's', Container: 'mkv',
      MediaStreams: [{ Type: 'Subtitle', Index: 0, Codec: 'hdmv_text_something' }]
    }]
  }
  const { a } = adapter({ items: [weird] })
  const [sub] = await a.subtitles({ itemId: await ourId(a, 'jf-metropolis') })
  assert.equal(sub.playable, false)
  assert.match(sub.reason, /unsupported subtitle format: hdmv_text_something/)
})

test('a text subtitle is fetched as SRT', async () => {
  const { a, calls } = adapter({ items: LIBRARY })
  const id = await ourId(a, 'jf-metropolis')
  const body = await a.subtitle({ itemId: id, subtitleId: 'src-metro:3' })
  assert.equal(body, 'SRT')
  assert.match(calls.pop().path, /\/Videos\/jf-metropolis\/src-metro\/Subtitles\/3\/Stream\.srt$/)
})

// --- streaming --------------------------------------------------------------

test('STREAMING ASKS FOR static=true, which is the whole ballgame', async () => {
  // Without it Jellyfin decides for itself whether to transcode, and the moment it
  // does the bytes stop being the original file - so there are no stable byte
  // offsets to seek to, because those bytes do not exist until Jellyfin makes them.
  const { a, calls } = adapter({ items: LIBRARY })
  const id = await ourId(a, 'jf-metropolis')

  assert.equal(await a.stream({ itemId: id }), 'VIDEO')
  const call = calls.pop()
  assert.equal(call.path, '/Videos/jf-metropolis/stream')
  assert.equal(call.params.static, 'true')
  // Not the donor's /Audio/{id}/universal.
  assert.ok(!call.path.includes('universal'))
})

test('a seek passes the HTTP Range straight through', async () => {
  const { a, calls } = adapter({ items: LIBRARY })
  const id = await ourId(a, 'jf-metropolis')

  await a.stream({ itemId: id, offset: 1_000_000 })
  assert.equal(calls.pop().headers.range, 'bytes=1000000-')

  await a.stream({ itemId: id, offset: 1_000_000, length: 65536 })
  assert.equal(calls.pop().headers.range, 'bytes=1000000-1065535')

  await a.stream({ itemId: id })
  assert.equal(calls.pop().headers.range, undefined, 'no range means the whole file')
})

test('an unknown item streams nothing rather than something else', async () => {
  const { a } = adapter({ items: LIBRARY })
  assert.equal(await a.stream({ itemId: 'not-real' }), null)
})

test('artwork asks for maxWidth, because fill CROPS a poster', async () => {
  const { a, calls } = adapter({ items: LIBRARY })
  assert.equal(await a.art({ artId: 'jf-metropolis', size: 400 }), 'IMAGE')
  const call = calls.pop()
  assert.equal(call.params.maxWidth, '400')
  assert.equal(call.params.fillWidth, undefined)

  assert.equal(await a.art({ artId: 'missing' }), null, 'no artwork is not an error')
  assert.equal(await a.art({}), null)
})

test('the adapter refuses to be built without the protocol id factory', () => {
  // Ids are library- AND source-scoped. One minted in the wrong namespace would be an
  // id nothing else in the system agrees with, and it would only show up as a resume
  // position that never matches.
  assert.throws(
    () => new JellyfinAdapter({ url: 'http://x', libraryId: LIB }),
    /needs the protocol id factory/
  )
})

// Resolve a Jellyfin id to ours the way the adapter does, for readable assertions.
async function ourId (a, remote) {
  return protocol.ids.itemId(LIB, 'jellyfin', remote)
}
