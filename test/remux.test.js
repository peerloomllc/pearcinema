// Remux: repackaging a film so the client will open it.
//
// Three groups, and the third is the one that earns its runtime.
//
// `decide` is pure and cheap to test, and it is where the money is: it is what
// stops a host re-encoding files that would have played, and what stops it starting
// an encoder it does not have.
//
// `argsFor` is pinned as an ARRAY, because a real library is full of filenames with
// quotes and semicolons in them and this input path comes off somebody's disk.
//
// And then a REAL ffmpeg run, because the worst bug found while building this was
// invisible to every test that did not actually produce bytes: AC-3 copied into a
// streamed fragmented MP4 came out corrupt, ffmpeg exited 0, and the file only
// failed when something tried to open it. The same copy into a normal seekable MP4
// worked, so nothing short of running the real pipeline could have caught it.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const { execFile } = require('child_process')
const { promisify } = require('util')

const remux = require('../host/remux')

const run = promisify(execFile)

const media = (container, videoCodec, audioCodec) => ({ container, videoCodec, audioCodec })

// A browser: MP4 only, H.264 and VP9, no Dolby of any kind.
const CHROME = { containers: ['mp4', 'webm'], videoCodecs: ['h264', 'vp9'], audioCodecs: ['aac', 'mp3', 'opus'] }
// Safari and iOS: MP4, H.264 and HEVC, and Dolby Digital - which the 2026-08-13
// measurement established by playing real remuxed files.
const SAFARI = { containers: ['mp4'], videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3', 'eac3'] }
// Android's ExoPlayer, which opens nearly everything.
const ANDROID = { containers: ['mp4', 'matroska', 'avi'], videoCodecs: ['h264', 'hevc', 'mpeg4', 'av1'], audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'opus'] }

/* ------------------------------------------------------------- the decision -- */

test('DIRECT PLAY ALWAYS WINS WHERE IT WORKS', async () => {
  // Free, exact, and the actual file. A host that remuxed something playable would
  // be spending a child process on nothing.
  assert.equal(remux.decide(media('mp4', 'h264', 'aac'), CHROME).mode, 'direct')
  assert.equal(remux.decide(media('matroska', 'h264', 'aac'), ANDROID).mode, 'direct')
  assert.equal(remux.decide(media('avi', 'mpeg4', 'mp3'), ANDROID).mode, 'direct')

  // ffprobe collapses the whole ISO base media family to `mov`, so an ordinary .mp4
  // arrives named `mov`. Treating that as an unknown container would remux most of
  // the files that already work.
  assert.equal(remux.decide(media('mov', 'h264', 'aac'), CHROME).mode, 'direct')
})

test('THE MKV CASE - 83% of the real library - is a container rewrite and nothing else', async () => {
  const v = remux.decide(media('matroska', 'h264', 'aac'), CHROME)
  assert.equal(v.mode, 'remux')
  assert.equal(v.audio, 'copy', 'nothing is re-encoded')
  assert.match(v.reason, /only the container/)
})

test('Dolby Digital is COPIED for a client that takes it, and rebuilt for one that does not', async () => {
  // The whole point of the 2026-08-13 measurement: ~620 files of the real library
  // are AC-3 or E-AC-3 television, and iOS plays them straight out of an MP4.
  for (const audio of ['ac3', 'eac3']) {
    const ios = remux.decide(media('matroska', 'hevc', audio), SAFARI)
    assert.equal(ios.mode, 'remux')
    assert.equal(ios.audio, 'copy', audio + ' must not be re-encoded for a client that takes it')

    const chrome = remux.decide(media('matroska', 'h264', audio), CHROME)
    assert.equal(chrome.mode, 'remux')
    assert.equal(chrome.audio, 'aac', audio + ' has to be rebuilt for a browser that cannot decode it')
  }
})

test('DTS and TrueHD are the 19 files that need their sound rebuilt', async () => {
  for (const audio of ['dts', 'truehd']) {
    const v = remux.decide(media('matroska', 'h264', audio), SAFARI)
    assert.equal(v.mode, 'remux')
    assert.equal(v.audio, 'aac')
    assert.match(v.reason, /rebuilt/)
  }
})

test('IT REFUSES RATHER THAN BECOMING A TRANSCODER', async () => {
  // Rung three: the 218 AVI / MPEG-4 Part 2 files. Repackaging cannot change the
  // picture, so a host that quietly re-encoded here would be melting a Raspberry Pi
  // on behalf of a user who asked for nothing of the sort.
  const avi = remux.decide(media('avi', 'mpeg4', 'mp3'), CHROME)
  assert.equal(avi.mode, 'refuse')
  assert.match(avi.reason, /cannot decode MPEG4 video/)
  assert.match(avi.reason, /cannot change the picture/)

  // HEVC that the client can decode but only inside a container it cannot open is
  // remuxable; HEVC the client cannot decode at all is not.
  assert.equal(remux.decide(media('matroska', 'hevc', 'aac'), SAFARI).mode, 'remux')
  assert.equal(remux.decide(media('matroska', 'hevc', 'aac'), CHROME).mode, 'refuse')
})

test('a file we know nothing about is direct-played rather than guessed at', async () => {
  assert.equal(remux.decide({}, CHROME).mode, 'direct')
  assert.equal(remux.decide(null, CHROME).mode, 'direct')
})

/* --------------------------------------------------------------- the argv -- */

test('the ffmpeg command is an ARRAY, and a filename cannot become an argument', async () => {
  const nasty = '/library/Movies/Amelie; rm -rf $HOME/"quoted" & (1998).mkv'
  const args = remux.argsFor({ input: nasty, at: 0 })

  assert.ok(Array.isArray(args))
  // The whole path is ONE element. There is no shell, so nothing in it is parsed.
  assert.equal(args.filter(a => a === nasty).length, 1)
  assert.equal(args.indexOf('-i') + 1, args.indexOf(nasty))
})

test('-ss goes BEFORE -i, which is the difference between a seek and a wait', async () => {
  const args = remux.argsFor({ input: '/x.mkv', at: 900 })
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'an output seek would decode 15 minutes and throw it away')
  assert.equal(args[args.indexOf('-ss') + 1], '900')

  // No seek at all when starting from the beginning.
  assert.equal(remux.argsFor({ input: '/x.mkv', at: 0 }).includes('-ss'), false)
})

test('delay_moov is in the flags, and its absence is silent corruption', async () => {
  const args = remux.argsFor({ input: '/x.mkv' })
  const flags = args[args.indexOf('-movflags') + 1]
  assert.match(flags, /empty_moov/, 'a plain MP4 puts its index at the end and cannot be piped')
  assert.match(flags, /delay_moov/, 'without this an AC-3 track gets a zero-size dac3 box and the file will not open')
})

test('one video, one audio, no subtitles - and the audio is optional', async () => {
  const args = remux.argsFor({ input: '/x.mkv' })
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-map'), ['0:v:0', '0:a:0?'])
  // A film with six audio tracks and twelve PGS subtitle tracks would otherwise map
  // all of them, and MP4 cannot carry PGS - the mux fails on a file about to work.
  assert.ok(args.includes('-sn'))
  assert.equal(args.includes('-c:v') && args[args.indexOf('-c:v') + 1] === 'copy', true, 'the picture is never touched')
})

test('the audio fallback rebuilds only the sound', async () => {
  const args = remux.argsFor({ input: '/x.mkv', audio: 'aac' })
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy')
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
})

/* ------------------------------------------------- a real ffmpeg, real bytes -- */

async function haveFfmpeg () {
  try {
    await run('ffmpeg', ['-version'])
    return true
  } catch {
    return false
  }
}

// A short MKV with the exact shape of the real library's biggest bucket.
async function clip (t, audioCodec) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-remux-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'A Film (2024).mkv')
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-g', '24',
    '-c:a', audioCodec, '-ac', '2', '-shortest', file, '-y'
  ])
  return { dir, file }
}

async function collect (stream) {
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return Buffer.concat(chunks)
}

async function probe (buf, dir, name) {
  const out = path.join(dir, name)
  await fsp.writeFile(out, buf)
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,codec_type',
    '-show_entries', 'format=format_name,duration',
    '-of', 'json', out
  ])
  return JSON.parse(stdout)
}

test('AC-3 COPIED INTO A STREAMED MP4 IS ACTUALLY OPENABLE', async (t) => {
  if (!await haveFfmpeg()) return t.skip('no ffmpeg on this machine')

  // THE REGRESSION TEST FOR THE WORST BUG IN THIS FEATURE. Without `delay_moov`,
  // this produced a file ffmpeg was perfectly happy to write and nothing could open:
  // the AC-3 `stsd` entry got a zero-size `dac3` box because the header was written
  // before a single audio packet had been read. Exit code 0, bytes on the wire, and
  // "invalid size 0 in stsd" at the other end.
  const { dir, file } = await clip(t, 'ac3')
  const engine = new remux.Remuxer({ log: () => {} })
  const session = engine.start({ input: file, at: 0, audio: 'copy' })
  t.after(() => engine.killAll())

  const info = await probe(await collect(session.stdout), dir, 'out.mp4')

  assert.match(info.format.format_name, /mp4/)
  const codecs = info.streams.map(s => s.codec_name)
  assert.deepEqual(codecs, ['h264', 'ac3'], 'both streams survive, and neither was re-encoded')
  assert.ok(Number(info.format.duration) > 3.5)
})

test('THE PICTURE IS BIT-FOR-BIT UNTOUCHED', async (t) => {
  if (!await haveFfmpeg()) return t.skip('no ffmpeg on this machine')

  // The claim remux rests on: nothing is re-encoded, so there is no quality loss and
  // no CPU spent on the expensive half. Hashing the copied video stream on both
  // sides is the only way to say that rather than assert it.
  const { dir, file } = await clip(t, 'aac')
  const engine = new remux.Remuxer({ log: () => {} })
  const session = engine.start({ input: file, at: 0, audio: 'copy' })
  t.after(() => engine.killAll())

  const out = path.join(dir, 'copy.mp4')
  await fsp.writeFile(out, await collect(session.stdout))

  const hash = async (f) => (await run('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-'])).stdout.trim()
  assert.equal(await hash(out), await hash(file))
})

test('a seek starts the film where it was asked to', async (t) => {
  if (!await haveFfmpeg()) return t.skip('no ffmpeg on this machine')

  const { dir, file } = await clip(t, 'aac')
  const engine = new remux.Remuxer({ log: () => {} })
  const session = engine.start({ input: file, at: 2, audio: 'copy' })
  t.after(() => engine.killAll())

  const info = await probe(await collect(session.stdout), dir, 'seek.mp4')
  const d = Number(info.format.duration)
  assert.ok(d > 1 && d < 3, `two seconds of a four second clip should remain, got ${d}`)
})

test('the concurrency cap refuses rather than queueing, and killAll leaves nothing behind', async (t) => {
  if (!await haveFfmpeg()) return t.skip('no ffmpeg on this machine')

  const { file } = await clip(t, 'aac')
  const engine = new remux.Remuxer({ maxConcurrent: 2, log: () => {} })
  t.after(() => engine.killAll())

  engine.start({ input: file })
  engine.start({ input: file })
  assert.equal(engine.running, 2)

  // A viewer told the host is busy can try again. A viewer watching a spinner for
  // four minutes assumes it is broken.
  assert.throws(() => engine.start({ input: file }), /already repackaging/)
  try {
    engine.start({ input: file })
  } catch (e) {
    assert.equal(e.code, 'BUSY')
  }

  engine.killAll()
  assert.equal(engine.running, 0)
})

test('killing a session kills its process - an orphaned ffmpeg is the whole box', async (t) => {
  if (!await haveFfmpeg()) return t.skip('no ffmpeg on this machine')

  const { file } = await clip(t, 'aac')
  const engine = new remux.Remuxer({ log: () => {} })
  const session = engine.start({ input: file })
  const pid = session.proc.pid

  session.kill()
  await new Promise(r => setTimeout(r, 300))

  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the process must actually be gone')
})

test('CHAPTERS ARE DROPPED - a ripped film would otherwise grow a phantom data track', async (t) => {
  if (!await haveFfmpeg()) return t.skip('no ffmpeg on this machine')

  // Found on Tim's real copy of 2001, which carries 34 chapter marks: ffmpeg copies
  // chapters by default and the MP4 muxer writes them as a `bin_data` stream, so the
  // output had three streams instead of two. Every synthetic clip missed it, because
  // a clip ffmpeg just made has no chapters to copy.
  const { dir, file } = await clip(t, 'aac')

  const withChapters = path.join(dir, 'chaptered.mkv')
  const meta = path.join(dir, 'chapters.txt')
  await fsp.writeFile(meta, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=One\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=4000\ntitle=Two\n')
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-i', meta, '-map_metadata', '1', '-c', 'copy', withChapters, '-y'])
  assert.ok((await run('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'csv', withChapters])).stdout.trim().length, 'the fixture really has chapters')

  const engine = new remux.Remuxer({ log: () => {} })
  const session = engine.start({ input: withChapters, at: 0, audio: 'copy' })
  t.after(() => engine.killAll())

  const info = await probe(await collect(session.stdout), dir, 'nochapters.mp4')
  assert.deepEqual(info.streams.map(s => s.codec_type), ['video', 'audio'], 'exactly two streams, no bin_data')
})

test('DATA SAVER: a stated budget converts a fat file down, and only with hardware', () => {
  const { decide } = require('../host/remux')
  const { capBitrate } = require('../host/transcode')
  const fat = { container: 'matroska', videoCodec: 'h264', audioCodec: 'aac' }
  const client = { containers: ['matroska', 'mp4'], videoCodecs: ['h264'], audioCodecs: ['aac'], maxKbps: 2500 }

  // Over budget, hardware proven: converted down, even though it direct-plays.
  const v = decide(fat, client, { transcode: true, fileKbps: 3100 })
  assert.strictEqual(v.mode, 'transcode')
  assert.match(v.reason, /2500 kbps/)

  // Under budget (with the slack): the file as it is.
  assert.strictEqual(decide(fat, client, { transcode: true, fileKbps: 2600 }).mode, 'direct')

  // No hardware: a slow stream beats no stream - direct, never software.
  assert.strictEqual(decide(fat, client, { transcode: false, fileKbps: 9000 }).mode, 'direct')

  // No budget stated: nothing changes.
  assert.strictEqual(decide(fat, { ...client, maxKbps: 0 }, { transcode: true, fileKbps: 9000 }).mode, 'direct')

  // The segment bitrate honours the budget, in either notation.
  assert.strictEqual(capBitrate('6M', 2500), '2500k')
  assert.strictEqual(capBitrate('1500k', 2500), '1500k')
  assert.strictEqual(capBitrate('3M', 0), '3M')
})

test('BURN-IN: a chosen image track forces the transcode lane, and only with hardware', () => {
  const { decide } = require('../host/remux')
  const playsFine = { container: 'matroska', videoCodec: 'h264', audioCodec: 'aac' }
  const client = { containers: ['matroska', 'mp4'], videoCodecs: ['h264'], audioCodecs: ['aac'] }

  // The file direct-plays - but the viewer chose picture subtitles, so the
  // host must press them in, which is a re-encode by definition.
  const v = decide(playsFine, client, { transcode: true, burn: true })
  assert.strictEqual(v.mode, 'transcode')
  assert.match(v.reason, /burned into the film/)
  assert.strictEqual(v.audio, 'copy')

  // No proven hardware: the burn request is ignored, never a software encode.
  assert.strictEqual(decide(playsFine, client, { transcode: false, burn: true }).mode, 'direct')

  // No burn asked: nothing changes.
  assert.strictEqual(decide(playsFine, client, { transcode: true }).mode, 'direct')

  // A client that cannot take H.264 cannot take the burned stream either.
  const noH264 = { containers: ['mp4'], videoCodecs: ['hevc'], audioCodecs: ['aac'] }
  assert.notStrictEqual(decide(playsFine, noH264, { transcode: true, burn: true }).reason?.includes('burned'), true)
})
