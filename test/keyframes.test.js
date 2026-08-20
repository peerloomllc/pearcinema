// Reading a film's cut points out of the container's own index.
//
// The whole value of host/keyframes.js is that it is a seek and a small read where
// the obvious answer is a full-file scan - measured 3 ms against 4.1 s on a 282 MB
// episode, and 348 ms against 2m07s on a 13.6 GB Blu-ray remux, for byte-identical
// timestamps both times. What is pinned here is the parse: the shapes a real
// Matroska file takes, and the answers that must be null rather than wrong.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const keyframes = require('../host/keyframes')

// --- a Matroska file, built by hand ------------------------------------------

// An element id is written as-is: the constants already carry the length marker
// that makes them readable against the spec.
function idBytes (id) {
  const out = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256)
  return Buffer.from(out)
}

// A four-byte size, which is legal for every length this fixture needs and keeps
// the builder from having to choose a width.
function sizeBytes (n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  b[0] |= 0x10
  return b
}

function el (id, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.concat(body)
  return Buffer.concat([idBytes(id), sizeBytes(b.length), b])
}

function uint (id, value) {
  const out = []
  let v = Math.round(value)
  do {
    out.unshift(v % 256)
    v = Math.floor(v / 256)
  } while (v > 0)
  return el(id, Buffer.from(out))
}

const EL = keyframes.EL

function cuePoint (timeMs, track) {
  return el(EL.CUE_POINT, [
    uint(EL.CUE_TIME, timeMs),
    el(EL.CUE_TRACK_POSITIONS, [uint(EL.CUE_TRACK, track)])
  ])
}

function tracks ({ videoTrack = 1, audioTrack = 2 } = {}) {
  return el(EL.TRACKS, [
    el(EL.TRACK_ENTRY, [uint(EL.TRACK_NUMBER, audioTrack), uint(EL.TRACK_TYPE, 2)]),
    el(EL.TRACK_ENTRY, [uint(EL.TRACK_NUMBER, videoTrack), uint(EL.TRACK_TYPE, 1)])
  ])
}

// `points` is [timeMs, track] pairs, in the interleaved order a real Cues element
// has them.
function mkv (points, { videoTrack = 1, scaleNs = 1_000_000, filler = 0, extra = [] } = {}) {
  const body = [
    el(EL.INFO, [uint(EL.TIMESTAMP_SCALE, scaleNs)]),
    tracks({ videoTrack }),
    ...extra,
    // A Cluster standing between Tracks and Cues, which is where every real file
    // keeps its picture. The walk has to step over it by its declared size rather
    // than reading it.
    ...(filler ? [el(0x1F43B675, Buffer.alloc(filler, 0x42))] : []),
    el(EL.CUES, points.map(([t, track]) => cuePoint(t, track)))
  ]
  return Buffer.concat([
    el(0x1A45DFA3, Buffer.alloc(4)),   // the EBML header, contents irrelevant here
    el(EL.SEGMENT, body)
  ])
}

function write (t, buf, name = 'film.mkv') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearcinema-kf-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, buf)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return file
}

test.beforeEach(() => keyframes._clearCache())

test('THE CUT POINTS ARE THE VIDEO TRACK\'S, and the track filter is not optional', async (t) => {
  // A real Cues element holds points for every seekable track interleaved. Read
  // unfiltered, the audio track's points land between the video's and the list
  // stops being a list of places the PICTURE can be cut - which is the only thing
  // it is for. Measured on the test episode: 469 video points and 263 audio ones
  // in one element.
  const file = write(t, mkv([
    [0, 1], [2438, 2], [2106, 1], [4859, 1], [6985, 2], [6569, 1]
  ]))

  const times = await keyframes.matroskaKeyframes(file)
  assert.deepEqual(times, [0, 2.106, 4.859, 6.569])
})

test('the video track is found by TYPE, never by being track one', async (t) => {
  const file = write(t, mkv([[0, 3], [1000, 1], [4000, 3]], { videoTrack: 3 }))
  assert.deepEqual(await keyframes.matroskaKeyframes(file), [0, 4])
})

test('the file\'s own clock scale is honoured', async (t) => {
  // The default is a millisecond per tick and almost every file uses it. A file
  // that says otherwise and is read as if it had not would place every cut point
  // in the wrong minute of the film.
  const file = write(t, mkv([[0, 1], [1_000_000, 1]], { scaleNs: 1000 }))
  assert.deepEqual(await keyframes.matroskaKeyframes(file), [0, 1])
})

test('Cues found past a Cluster, and Cues found through the SeekHead', async (t) => {
  // The walk steps over a Cluster by its declared size. A film's Clusters are the
  // whole film, so reading one to get past it would be the scan this avoids.
  const walked = write(t, mkv([[0, 1], [5000, 1]], { filler: 65_536 }))
  assert.deepEqual(await keyframes.matroskaKeyframes(walked), [0, 5])

  // And the fast path: a SeekHead at the front pointing straight at both elements,
  // which is what a muxer writes and what makes a 25 GB film answer in 144 ms.
  const inner = [
    el(EL.INFO, [uint(EL.TIMESTAMP_SCALE, 1_000_000)]),
    tracks(),
    el(0x1F43B675, Buffer.alloc(4096, 0x42)),
    el(EL.CUES, [cuePoint(0, 1), cuePoint(7000, 1)])
  ]
  // A SeekHead's positions point at elements that come after it, so its own size
  // has to stop mattering: eight fixed bytes per offset, which is what a real
  // muxer does for the same reason.
  const fixed = (id, value) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(value))
    return el(id, b)
  }
  const seek = (id, at) => el(EL.SEEK, [el(EL.SEEK_ID, idBytes(id)), fixed(EL.SEEK_POSITION, at)])
  const head = el(EL.SEEKHEAD, [seek(EL.TRACKS, 0), seek(EL.CUES, 0)])

  let pos = head.length
  let tracksAt = 0
  let cuesAt = 0
  for (const part of inner) {
    if (part.subarray(0, 4).equals(idBytes(EL.TRACKS))) tracksAt = pos
    if (part.subarray(0, 4).equals(idBytes(EL.CUES))) cuesAt = pos
    pos += part.length
  }
  const realHead = el(EL.SEEKHEAD, [seek(EL.TRACKS, tracksAt), seek(EL.CUES, cuesAt)])
  assert.equal(realHead.length, head.length, 'the fixture\'s offsets must not shift the head')
  const indexed = write(t, Buffer.concat([
    el(0x1A45DFA3, Buffer.alloc(4)),
    el(EL.SEGMENT, [realHead, ...inner])
  ]), 'indexed.mkv')
  assert.deepEqual(await keyframes.matroskaKeyframes(indexed), [0, 7])
})

test('NULL IS THE HONEST ANSWER, and the caller\'s fallback is the old path', async (t) => {
  // Every one of these means "no cheap cut points here", which is a normal answer
  // and not an error. A wrong cut point is a broken film; an absent one is only
  // the cost this host paid before the copy engine existed.
  assert.equal(await keyframes.read(null), null)
  assert.equal(await keyframes.read('/no/such/file.mkv'), null)
  assert.equal(await keyframes.read(os.tmpdir()), null, 'a directory is not a film')

  // Not a container this reads at all.
  assert.equal(await keyframes.matroskaKeyframes(write(t, Buffer.alloc(4096), 'x.bin')), null)

  // Matroska with no Cues: legal, and unusable for cutting.
  const noCues = Buffer.concat([
    el(0x1A45DFA3, Buffer.alloc(4)),
    el(EL.SEGMENT, [el(EL.INFO, [uint(EL.TIMESTAMP_SCALE, 1_000_000)]), tracks()])
  ])
  assert.equal(await keyframes.matroskaKeyframes(write(t, noCues, 'nocues.mkv')), null)

  // Cues that name only tracks this file does not have as video.
  const wrongTrack = mkv([[0, 2], [4000, 2]])
  assert.equal(await keyframes.matroskaKeyframes(write(t, wrongTrack, 'audio.mkv')), null)

  // Truncated mid-element, which is what a copy still in flight looks like.
  assert.equal(await keyframes.matroskaKeyframes(write(t, mkv([[0, 1], [4000, 1]]).subarray(0, 20), 'part.mkv')), null)
})

test('the answer is cached against the file\'s identity, not its name', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearcinema-kf-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'film.mkv')
  fs.writeFileSync(file, mkv([[0, 1], [5000, 1], [11000, 1]]))

  // No ffprobe on this machine's PATH in a test run, so the reorder delay reads as
  // zero - which is the right degradation: segments cut one keyframe's decode
  // delay late rather than not at all.
  const first = await keyframes.read(file, { ffprobe: '/nonexistent/ffprobe' })
  assert.deepEqual(first.times, [0, 5, 11])
  assert.equal(first.reorderDelay, 0)
  assert.equal(await keyframes.read(file, { ffprobe: '/nonexistent/ffprobe' }), first, 'the same object, not a re-read')

  // A REPLACED FILE RE-READS. Cutting a new film on the old one's keyframes would
  // be the worst failure this module has, because every segment would look fine
  // and none of them would be.
  await new Promise(resolve => setTimeout(resolve, 10))
  fs.writeFileSync(file, mkv([[0, 1], [6000, 1], [13000, 1]]))
  const second = await keyframes.read(file, { ffprobe: '/nonexistent/ffprobe' })
  assert.deepEqual(second.times, [0, 6, 13])
})


// --- ISO-BMFF: mp4, m4v, mov -------------------------------------------------
//
// The same index in a different shape, and the reason a film that needs its SOUND
// rebuilt was paying for a full hardware transcode where a copy would have done.
// Measured against a full packet scan on twenty real films in the library
// (2026-08-20): byte-identical on nineteen, and the twentieth differs only by a
// frame the edit list trims off the front. 176 ms against 45 s on a 3.16 GB film.

function b32 (n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}

function box (type, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.concat(body)
  return Buffer.concat([b32(b.length + 8), Buffer.from(type, 'latin1'), b])
}

// version, three flag bytes, then the box's own body.
function full (type, version, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.concat(body)
  return box(type, Buffer.concat([Buffer.from([version, 0, 0, 0]), b]))
}

function table (type, entries, { version = 0 } = {}) {
  return full(type, version, Buffer.concat([b32(entries.length), ...entries]))
}

function stts (runs) {
  return table('stts', runs.map(([count, delta]) => Buffer.concat([b32(count), b32(delta)])))
}

function stss (numbers) {
  return table('stss', numbers.map(n => b32(n)))
}

function ctts (runs, { version = 0 } = {}) {
  return table('ctts', runs.map(([count, offset]) => {
    const b = Buffer.alloc(4)
    if (version === 1) b.writeInt32BE(offset)
    else b.writeUInt32BE(offset >>> 0)
    return Buffer.concat([b32(count), b])
  }), { version })
}

function elst (entries, { version = 0 } = {}) {
  return table('elst', entries.map(([duration, mediaTime, rate = 0x00010000]) => {
    const mt = Buffer.alloc(4)
    mt.writeInt32BE(mediaTime)
    return Buffer.concat([b32(duration), mt, b32(rate)])
  }), { version })
}

function mdhd (timescale) {
  return full('mdhd', 0, Buffer.concat([b32(0), b32(0), b32(timescale), b32(0)]))
}

function hdlr (kind) {
  return full('hdlr', 0, Buffer.concat([b32(0), Buffer.from(kind, 'latin1'), Buffer.alloc(12)]))
}

function trak (kind, { timescale = 1000, tables = [], edits = null } = {}) {
  return box('trak', [
    ...(edits ? [box('edts', [edits])] : []),
    box('mdia', [
      mdhd(timescale),
      hdlr(kind),
      box('minf', [box('stbl', tables)])
    ])
  ])
}

// `mdatFirst` puts the film before the index, which is what a muxer writes unless
// it is asked for faststart - so the top-level walk has to step over it.
function mp4 (traks, { timescale = 1000, mdatFirst = 0 } = {}) {
  const moov = box('moov', [
    full('mvhd', 0, Buffer.concat([b32(0), b32(0), b32(timescale), b32(0)])),
    ...traks
  ])
  const parts = [box('ftyp', Buffer.from('isom', 'latin1'))]
  if (mdatFirst) parts.push(box('mdat', Buffer.alloc(mdatFirst, 0x11)))
  parts.push(moov)
  return Buffer.concat(parts)
}

// A film at 25 fps in a 1000-tick clock: 40 ticks a frame.
function film ({ syncs = [1, 51, 101], runs = [[150, 40]], cttsRuns = null, edits = null, cttsVersion = 0 } = {}) {
  const tables = [stts(runs), stss(syncs)]
  if (cttsRuns) tables.push(ctts(cttsRuns, { version: cttsVersion }))
  return mp4([
    trak('soun', { timescale: 48_000, tables: [stts([[100, 1024]])] }),
    trak('vide', { timescale: 1000, tables, edits })
  ])
}

test('THE SAMPLE TABLE IS AN INDEX TOO: sync samples become cut points', async (t) => {
  // stss holds sample NUMBERS, one-based, and stts says what each sample lasts -
  // so sample 51 of a 40-tick-per-frame film starts at 2000 ticks, which is 2 s.
  const file = write(t, film(), 'film.mp4')
  assert.deepEqual(await keyframes.isoKeyframes(file), [0, 2, 4])

  // And the picture's track is found by its HANDLER, never by being first: the
  // sound track above it would answer with a different clock and no sync samples.
  assert.equal(await keyframes.matroskaKeyframes(file), null, 'and it is not Matroska')
})

test('the cut points are PRESENTATION times, which is what ctts is for', async (t) => {
  // A B-frame encode gives every sample a composition offset. Ignoring it puts
  // every cut point in the film one reorder delay early, which is the same
  // duplicated-moment-at-every-join bug the reorder delay exists to prevent.
  const file = write(t, film({ cttsRuns: [[150, 80]] }), 'bframes.mp4')
  assert.deepEqual(await keyframes.isoKeyframes(file), [0.08, 2.08, 4.08])

  // The offsets are SIGNED in a version 1 table, and read as unsigned a negative
  // one lands four thousand million ticks into the film. Sample one comes out
  // BEFORE the presentation starts and is dropped, which is the same thing that
  // happens on a real film whose edit list trims its first frame.
  const signed = write(t, film({ cttsRuns: [[150, -40]], cttsVersion: 1 }), 'signed.mp4')
  assert.deepEqual(await keyframes.isoKeyframes(signed), [1.96, 3.96])
})

test('THE EDIT LIST IS HONOURED, because almost every mp4 has one', async (t) => {
  // The first cut of this parse skipped edit lists on the theory that they were
  // rare. Both files ffmpeg produced to test it came out exactly two frames late:
  // a B-frame encode offsets every sample, and the muxer writes an elst whose
  // media_time cancels it so presentation still starts at zero.
  const file = write(t, film({
    cttsRuns: [[150, 80]],
    edits: elst([[6000, 80]])
  }), 'edited.mp4')
  assert.deepEqual(await keyframes.isoKeyframes(file), [0, 2, 4])

  // An EMPTY edit is a gap at the front and pushes everything later.
  const gap = write(t, film({ edits: elst([[500, -1], [6000, 0]]) }), 'gap.mp4')
  assert.deepEqual(await keyframes.isoKeyframes(gap), [0.5, 2.5, 4.5])

  // A frame the edit list trims off has no presentation time and is dropped
  // rather than clamped: two cut points at zero is a plan with a zero-length
  // segment in it.
  const trimmed = write(t, film({ edits: elst([[6000, 2000]]) }), 'trimmed.mp4')
  assert.deepEqual(await keyframes.isoKeyframes(trimmed), [0, 2])

  // Anything more elaborate than that is a film assembled rather than ripped, and
  // is refused rather than read wrong.
  const spliced = write(t, film({ edits: elst([[2000, 0], [2000, 4000]]) }), 'spliced.mp4')
  assert.equal(await keyframes.isoKeyframes(spliced), null)
  const slow = write(t, film({ edits: elst([[6000, 0, 0x00008000]]) }), 'slow.mp4')
  assert.equal(await keyframes.isoKeyframes(slow), null)
})

test('the sample tables are walked once, however many runs they have', async (t) => {
  // A variable frame rate file has one stts run per rate change, and the sample
  // number a sync sample names has to be resolved across all of them. Walked with
  // a cursor rather than searched per sample: a two-hour film is a quarter of a
  // million samples and this runs on every play request.
  const file = write(t, film({
    syncs: [1, 3, 6],
    runs: [[2, 1000], [3, 500], [10, 100]]
  }), 'vfr.mp4')
  assert.deepEqual(await keyframes.isoKeyframes(file), [0, 2, 3.5])
})

test('the moov is found wherever the muxer put it', async (t) => {
  // ffmpeg writes it AFTER the film unless asked for faststart, so the top-level
  // walk steps over an mdat by its declared size - one hop, not a read.
  const file = write(t, film(), 'atend.mp4')
  const withFilm = write(t, Buffer.concat([
    film().subarray(0, 16),
    Buffer.alloc(0), // the ftyp above, then the mdat and the moov
    film({ }).subarray(16)
  ]), 'same.mp4')
  assert.deepEqual(await keyframes.isoKeyframes(file), [0, 2, 4])
  assert.deepEqual(await keyframes.isoKeyframes(withFilm), [0, 2, 4])

  const big = write(t, mp4([trak('vide', { tables: [stts([[150, 40]]), stss([1, 51])] })], { mdatFirst: 500_000 }), 'big.mp4')
  assert.deepEqual(await keyframes.isoKeyframes(big), [0, 2])
})

test('an mp4 with no sync sample table answers null, not everything', async (t) => {
  // No stss means every sample is a sync sample, which is legal and is what an
  // all-intra master or a fragmented file looks like. Offering two hundred
  // thousand cut points would be worse than offering none.
  const none = write(t, mp4([trak('vide', { tables: [stts([[150, 40]])] })]), 'nostss.mp4')
  assert.equal(await keyframes.isoKeyframes(none), null)

  // No video track at all.
  const sound = write(t, mp4([trak('soun', { tables: [stts([[150, 40]]), stss([1, 51])] })]), 'sound.mp4')
  assert.equal(await keyframes.isoKeyframes(sound), null)

  // A sync sample the time table does not reach: malformed, and guessing at it
  // would put a cut point in the wrong minute.
  const past = write(t, film({ syncs: [1, 900] }), 'past.mp4')
  assert.equal(await keyframes.isoKeyframes(past), null)

  // Truncated part way through, which is what a copy still in flight looks like.
  assert.equal(await keyframes.isoKeyframes(write(t, film().subarray(0, 40), 'part.mp4')), null)
})

// --- checking the ISO answer against ffmpeg ----------------------------------

test('AN ISO ANSWER IS ONLY USED IF FFMPEG AGREES WITH IT', async () => {
  // The Matroska path was measured against a full packet scan on two real films
  // and came back byte-identical twice. The ISO path earns its answer per file
  // instead, out of the probe that was already being run for the reorder delay -
  // and it is what caught the edit list, rather than 80 ms of every film being
  // silently wrong.
  const packets = (times, keys = times) => times.map(t => ({ pts: t, dts: t, key: keys.includes(t) }))

  assert.equal(keyframes.agreesWithProbe([0, 2, 4], packets([0, 2, 4])), true)
  assert.equal(keyframes.agreesWithProbe([0.08, 2.08], packets([0, 2])), false, 'two frames out is out')

  // Only as far as BOTH have seen: the probe stops after 400 packets and our list
  // runs to the end of the film.
  assert.equal(keyframes.agreesWithProbe([0, 2, 4, 600, 900], packets([0, 2, 4])), true)

  // A keyframe ffmpeg reports that we do not is a disagreement.
  assert.equal(keyframes.agreesWithProbe([0, 4], packets([0, 2, 4])), false)

  // EXCEPT before the film starts. An edit list trims the head off the
  // presentation timeline and ffmpeg still reports the trimmed frames, at
  // negative times - Blade's first one is at -0.083 s and its other 1,944 agree
  // to the microsecond. Nothing can be cut there.
  assert.equal(keyframes.agreesWithProbe([10.2, 20.6], packets([-0.083, 10.2, 20.6])), true)

  // No probe at all is not agreement. ffprobe missing or refusing means the check
  // could not be made, and an unchecked ISO answer is not used.
  assert.equal(keyframes.agreesWithProbe([0, 2], []), false)
  assert.equal(keyframes.agreesWithProbe([0, 2], packets([0, 2], [])), false)
})

test('an mp4 whose parse cannot be checked is not used', async (t) => {
  // No ffprobe on this machine, so no check is possible - and where Matroska
  // degrades to a zero reorder delay, ISO degrades to no answer at all.
  const file = write(t, film(), 'unchecked.mp4')
  assert.deepEqual(await keyframes.isoKeyframes(file), [0, 2, 4], 'the parse itself is fine')
  assert.equal(await keyframes.read(file, { ffprobe: '/nonexistent/ffprobe' }), null)
})


// --- a source that is not a file ---------------------------------------------
//
// A Jellyfin library hands out an HTTP URL rather than a path, and every film on
// one was falling back to a full re-encode for want of an index that is sitting
// right there. An HTTP server that serves a film serves Range requests by
// definition, and the index is two or three of them - not a download.

const http = require('http')

// A range server, with a switch for the two ways one can refuse: answering the
// whole file, and answering an error.
async function serve (t, body, { ranges = true, status = 200 } = {}) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers.range || 'none')
    if (status !== 200) { res.writeHead(status); return res.end() }
    if (!ranges || !req.headers.range) {
      res.writeHead(200, { 'content-length': body.length, 'content-type': 'video/x-matroska' })
      return res.end(body)
    }
    const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range)
    const from = Number(m[1])
    const to = Math.min(body.length - 1, m[2] === undefined ? body.length - 1 : Number(m[2]))
    const slice = body.subarray(from, to + 1)
    res.writeHead(206, {
      'content-range': `bytes ${from}-${to}/${body.length}`,
      'content-length': slice.length,
      etag: '"film-1"'
    })
    res.end(slice)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}/film.mkv`, seen }
}

test('A FILM BEHIND AN HTTP URL IS READ THE SAME WAY, in a few Range requests', async (t) => {
  const body = mkv([[0, 1], [4000, 1], [9000, 1]], { filler: 200_000 })
  const { url, seen } = await serve(t, body)

  const src = await keyframes.openSource(url)
  assert.equal(src.size, body.length)
  assert.deepEqual(await keyframes.matroskaKeyframes(url), [0, 4, 9])

  // A DOWNLOAD IS NOT A READ. The whole point is that the index is reachable
  // without pulling the film, so every request has to be a range and there have
  // to be very few of them.
  assert.ok(seen.length <= 12, `${seen.length} requests`)
  assert.ok(seen.every(r => r.startsWith('bytes=')), 'every one of them a range')
  const asked = seen.map(r => Number(/bytes=(\d+)/.exec(r)[1]))
  assert.ok(Math.max(...asked) > 100_000, 'including one past the film itself, where the index is')
})

test('a server that will not do ranges is refused rather than downloaded', async (t) => {
  // Answering 200 with the whole film to a Range request means this cannot read
  // an index cheaply, and reading it expensively is the thing being avoided.
  const whole = await serve(t, mkv([[0, 1], [4000, 1]]), { ranges: false })
  assert.equal(await keyframes.openSource(whole.url), null)
  assert.equal(await keyframes.read(whole.url), null)

  const refused = await serve(t, Buffer.alloc(16), { status: 401 })
  assert.equal(await keyframes.read(refused.url), null, 'and credentials that do not work are not a crash')

  assert.equal(await keyframes.read('http://127.0.0.1:1/gone.mkv'), null, 'nor is a host that is not there')
})

test('the remote answer is cached against what the server calls the film', async (t) => {
  const { url, seen } = await serve(t, mkv([[0, 1], [5000, 1], [11000, 1]]))
  const first = await keyframes.read(url, { ffprobe: '/nonexistent/ffprobe' })
  assert.deepEqual(first.times, [0, 5, 11])
  // ONE REQUEST, NOT NONE, and deliberately so: the identity is what the SERVER
  // says the film is, so asking is also how a replaced film is noticed. Cutting a
  // new film on the old one's keyframes is the worst failure this module has,
  // because every segment would look fine and none of them would be.
  const before = seen.length
  assert.equal(await keyframes.read(url, { ffprobe: '/nonexistent/ffprobe' }), first)
  assert.equal(seen.length, before + 1, 'the index itself is not read again')
})
