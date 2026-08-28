// The subtitles inside a file.
//
// The measurement that makes this worth its own suite (DECISIONS 2026-08-12): the
// two halves of a real collection fail in opposite ways and neither is exotic.
//
//   MOVIES   232 image tracks across 240 films, and only 57 text ones
//   TV     1,429 image against 2,715 TEXT
//
// So on the films the answer is nearly always "these are pictures and here is why
// you cannot have them", and on the television it is 2,715 perfectly good text
// tracks that were invisible while only files on disk were read.
//
// The real-ffmpeg tests here are the ones that matter, for the same reason they were
// in remux: the bugs in this area are all in the bytes, and everything that only
// inspects an argv passes.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const { execFile } = require('child_process')

const subtitles = require('../host/subtitles')

// EVERY ffmpeg HERE IS BOUNDED, and that is not defensive programming - it is the
// difference between a release that fails and a release that never returns.
//
// ffmpeg deadlocked building the four-second fixture below during the v1.1.0 release
// (2026-08-27): zero CPU, blocked on a futex, and it stayed that way. An identical one
// from a run the day before was still wedged 24 hours later. Because `execFile` had no
// timeout, the whole verify gate waited on it for ever, so the release neither passed
// nor failed - it just stopped, several minutes into a step that normally takes one.
//
// The deadlock itself is ffmpeg's (8.1.2, `-shortest` across sparse subtitle inputs) and
// it is a RACE: the same command run six times in a row by hand succeeded every time. It
// shows under the load of `--test-concurrency=4` on a busy machine, which is exactly the
// condition a release runs in.
//
// SIGKILL rather than the default SIGTERM, because a process stuck in a futex wait is not
// reliably reachable by a catchable signal - the wedged one had ignored everything short
// of -9.
const RUN_TIMEOUT_MS = 60_000

const run = (cmd, args, { timeout = RUN_TIMEOUT_MS } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) =>
    err ? reject(err) : resolve({ stdout, stderr }))
})

async function haveFfmpeg () {
  try {
    await run('ffmpeg', ['-version'])
    return true
  } catch {
    return false
  }
}

async function collect (stream) {
  const chunks = []
  for await (const c of stream) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString('utf8')
}

// --- the rules, without a file ------------------------------------------------

test('TEXT IS SHOWABLE AND PICTURES ARE NOT, and the difference is said in words', () => {
  assert.equal(subtitles.reasonFor('subrip'), null)
  assert.equal(subtitles.reasonFor('mov_text'), null, "MP4's own flavour is still text")
  assert.equal(subtitles.reasonFor('ass'), null)

  // The common case on a film collection, and the message has to explain rather than
  // refuse: somebody looking at a disabled row wants to know what would fix it.
  const pgs = subtitles.reasonFor('pgssub')
  assert.match(pgs, /pictures rather than text/)
  assert.match(pgs, /re-encode/)
  assert.equal(subtitles.reasonFor('dvd_subtitle'), pgs, 'DVD subtitles are the same problem')

  assert.match(subtitles.reasonFor('something-new'), /unsupported subtitle format/)
})

test('BOTH SPELLINGS OF PGS, because the two sources do not agree on the word', () => {
  // Found on the real library, minutes after this first ran there: the list was
  // inherited from the Jellyfin adapter, which sees `PGSSUB`, while ffprobe calls the
  // same track `hdmv_pgs_subtitle`. 53 of 58 film tracks fell through to "unsupported
  // subtitle format: hdmv_pgs_subtitle" - technically true, useless to read, and
  // exactly the silence this feature exists to replace.
  const plain = /pictures rather than text/
  for (const codec of ['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'dvb_subtitle', 'xsub']) {
    assert.match(subtitles.reasonFor(codec), plain, codec)
  }
  assert.equal(subtitles.IMAGE_SUBTITLE_CODECS.has('hdmv_pgs_subtitle'), true,
    'the spelling a real ffprobe actually returns')
})

test('a track is named from whatever the file bothered to record', () => {
  assert.equal(subtitles.titleFor({ title: 'English (SDH)', language: 'eng' }), 'English (SDH)')
  assert.equal(subtitles.titleFor({ language: 'fre' }), 'FRE')
  assert.equal(subtitles.titleFor({}), 'Subtitles')
  assert.equal(subtitles.titleFor({ language: 'eng', forced: true }), 'ENG forced')
  // Not twice. A file whose track is already called "Forced" must not become
  // "Forced forced", which is the kind of thing nobody notices until it is on screen.
  assert.equal(subtitles.titleFor({ title: 'Forced', forced: true }), 'Forced')
})

// --- a real file, real bytes ---------------------------------------------------

// A short MKV carrying two subtitle tracks, which is the shape the television half
// of the real library is in.
async function clip (t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-subs-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))

  const en = path.join(dir, 'en.srt')
  const fr = path.join(dir, 'fr.srt')
  await fsp.writeFile(en, '1\n00:00:00,500 --> 00:00:02,000\nHello there\n\n2\n00:00:02,500 --> 00:00:03,500\nSecond line\n')
  // BOTH FILES RUN THE FULL LENGTH. `-shortest` below takes the shortest of every
  // input including these, so a two-second French track would silently truncate the
  // English one to two seconds - which looked exactly like a bug in the extraction.
  await fsp.writeFile(fr, '1\n00:00:00,500 --> 00:00:02,000\nBonjour\n\n2\n00:00:02,500 --> 00:00:03,500\nDeuxieme\n')

  const file = path.join(dir, 'An Episode - s01e01.mkv')
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=12:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-i', en, '-i', fr,
    '-map', '0:v', '-map', '1:a', '-map', '2', '-map', '3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=fre',
    '-shortest', file, '-y'
  ]

  // ONE RETRY, because the deadlock above is a race rather than a broken command. The
  // same argv succeeds by hand every time and wedged twice under a concurrent run, so a
  // second attempt on a fresh process is the honest response - where failing the release
  // would blame the change being released for something ffmpeg did.
  //
  // Exactly one. A retry loop would turn a genuinely broken ffmpeg into a slow hang
  // again, which is the failure this whole block exists to remove.
  try {
    await run('ffmpeg', args)
  } catch (first) {
    await fsp.rm(file, { force: true })
    try {
      await run('ffmpeg', args)
    } catch (second) {
      // BOTH failures reported. The first is the interesting one when this is the race;
      // the second is the interesting one when the command is actually wrong, and a
      // reader cannot tell which they have without seeing both.
      second.message = `building the subtitle fixture failed twice.\nfirst:  ${first.message}\nsecond: ${second.message}`
      throw second
    }
  }
  return { dir, file }
}

test('A TEXT TRACK COMES OUT OF A REAL FILE AS WEBVTT', async (t) => {
  if (!await haveFfmpeg()) return t.skip('no ffmpeg on this machine')

  const { file } = await clip(t)
  const out = await collect(subtitles.extractSubtitle({ input: file, index: 0 }))

  // A <track> element accepts WebVTT and nothing else, so the header is the whole
  // point - and the timestamps must have become dots, not commas.
  assert.match(out, /^WEBVTT/)
  assert.match(out, /Hello there/)
  // ffmpeg writes WebVTT's short timestamp form, MM:SS.mmm. What matters is the DOT:
  // a SubRip comma makes every cue unparseable to a <track> element.
  assert.match(out, /00:00\.500 --> 00:02\.000/)
  assert.match(out, /Second line/, 'every cue, not just the first')
  assert.doesNotMatch(out, /,\d{3} -->/, 'a SubRip comma would make every cue unparseable')
})

test('THE INDEX PICKS THE TRACK, and it counts within the subtitles rather than the file', async (t) => {
  if (!await haveFfmpeg()) return t.skip('no ffmpeg on this machine')

  // The trap this pins: the video and audio streams come first in the file, so an
  // index taken from ffprobe's own `index` field would be off by two and hand back
  // the wrong language - or fail outright.
  const { file } = await clip(t)

  const first = await collect(subtitles.extractSubtitle({ input: file, index: 0 }))
  const second = await collect(subtitles.extractSubtitle({ input: file, index: 1 }))

  assert.match(first, /Hello there/)
  assert.match(second, /Bonjour/)
  assert.doesNotMatch(second, /Hello there/)
})

test('probe reports the tracks with enough to name them', async (t) => {
  if (!await haveFfmpeg()) return t.skip('no ffmpeg on this machine')

  const { probeFile } = require('../host/probe')
  const { file } = await clip(t)
  const info = await probeFile(file)

  assert.equal(info.subtitles.length, 2)
  assert.deepEqual(info.subtitles.map(s => s.index), [0, 1], 'numbered for -map 0:s:N')
  assert.deepEqual(info.subtitles.map(s => s.language), ['eng', 'fre'])
  assert.equal(info.subtitles[0].codec, 'subrip')

  // The old field is still there, and still the shape the codec report reads. That
  // report is cited in DECISIONS, so breaking it would quietly invalidate a
  // measurement rather than fail a test.
  assert.deepEqual(info.subtitleCodecs, ['subrip', 'subrip'])
})

test('a file with no subtitles at all reports none, rather than nothing', async (t) => {
  if (!await haveFfmpeg()) return t.skip('no ffmpeg on this machine')

  const { probeFile } = require('../host/probe')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-nosubs-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'Bare.mkv')
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=12:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file, '-y'
  ])

  const info = await probeFile(file)
  assert.deepEqual(info.subtitles, [])
})

test('subtitle.list marks burnable image tracks, and only when the host can burn', async () => {
  const { createMethods } = require('../host/methods')
  const subtitles = require('../host/subtitles')
  const rows = [
    { id: 'pgs1', codec: 'hdmv_pgs_subtitle', external: false, playable: false },
    { id: 'srt1', codec: 'subrip', external: false, playable: true },
    { id: 'ext1', codec: 'dvd_subtitle', external: true, playable: false }
  ]
  const adapter = { subtitles: async () => rows }
  const ctx = { params: { itemId: 'x' }, badParams: (m) => new Error(m) }

  // An engine that proved itself: the embedded image track is offered, the
  // text track is not (it plays free) and the external image file is not
  // (there is nothing inside the video to overlay from).
  const can = createMethods({
    getAdapter: () => adapter,
    getLibraryName: () => 'L',
    media: { canBurn: (codec) => subtitles.burnable(codec) }
  })
  const out = await can['subtitle.list'](ctx)
  assert.deepStrictEqual(out.items.map(t => t.burnable), [true, false, false])

  // No engine: nothing is offered, so a phone never shows a burn the segment
  // path would silently drop.
  const cant = createMethods({
    getAdapter: () => adapter,
    getLibraryName: () => 'L',
    media: { canBurn: () => false }
  })
  assert.deepStrictEqual((await cant['subtitle.list'](ctx)).items.map(t => t.burnable), [false, false, false])
})

// THE SUBTITLE CALLS MUST ASK THE HOST THAT HOLDS THE FILE, not whichever host the
// phone happens to have a connection to.
//
// Found on a four-host bench, 2026-08-21: a film on the Mac was opened while the
// phone's live connection was to the Windows host (the merged view filters by
// library, it does NOT reconnect), and the detail sheet said "Subtitles: None".
// The Mac's own dashboard said three. The wire method answers an EMPTY LIST rather
// than an error when it does not know the item, so a routing mistake here is
// invisible - it reads as a fact about the film.
//
// src/bare.js cannot be required outside the Bare runtime (it is a top-level script
// with side effects and `Bare` globals), so this pins the invariant at the source.
// `clientForId` is the helper `library.get` and `library.siblings` already use.
test('subtitle.list and subtitle.get route by item, not by connection', async () => {
  const src = await fsp.readFile(path.join(__dirname, '..', 'src', 'bare.js'), 'utf8')

  for (const method of ['subtitle.list', 'subtitle.get']) {
    const at = src.indexOf(`'${method}':`)
    assert.ok(at > 0, `${method} is gone from the worklet's method table`)
    // TO THE NEXT METHOD KEY, not a fixed number of characters. It was 400 of them
    // until 2026-08-26, when the demo library's branch went in at the top of both
    // methods and pushed the line this looks for past the window - so the guard failed
    // on code that still holds the invariant it guards.
    const rest = src.slice(at + method.length + 3)
    const next = rest.search(/\n {2}'[a-z][a-zA-Z.]*': /)
    const body = next === -1 ? rest : rest.slice(0, next)
    assert.match(
      body,
      /clientForId\(args\.itemId\)/,
      `${method} must resolve the host from the itemId, or a merged-view lookup asks the wrong host`
    )
    assert.doesNotMatch(
      body,
      /\(await connected\(\)\)\.request/,
      `${method} must not go straight to the connected host`
    )
  }
})
