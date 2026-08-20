// The phone's HLS transcode path: the playlist is arithmetic, the segments are
// argv - both pure, both pinned here. The live pipeline's verify is the real
// device against the real host, per the approved proposal's wire section.

const test = require('node:test')
const assert = require('node:assert/strict')

const hls = require('../host/hls')

test('THE PLAYLIST IS ARITHMETIC: runtime in, a full VOD playlist out', () => {
  const item = { runtime: 10 } // 2.5 segments at 4s
  const p = hls.playlistFor(item)

  assert.match(p, /#EXT-X-PLAYLIST-TYPE:VOD/)
  assert.match(p, /#EXT-X-ENDLIST/)
  assert.match(p, /#EXT-X-TARGETDURATION:4/)
  // Three segments: 4 + 4 + 2 seconds. The last EXTINF carries the remainder,
  // because a player that is told 4 and given 2 ends every film with a stall.
  assert.equal((p.match(/#EXTINF/g) || []).length, 3)
  assert.match(p, /#EXTINF:2\.000,\n2\.ts/)
  assert.equal(hls.segmentCount(10), 3)

  // No runtime, no playlist - the refusal is the caller's to phrase.
  assert.equal(hls.playlistFor({ runtime: 0 }), null)
  assert.equal(hls.segmentCount(0), 0)
})

test('a segment\'s argv seeks precisely, offsets its timestamps and stays an array', () => {
  const nasty = '/library/TV/MST3K; rm -rf $HOME/"quoted".mkv'
  const args = hls.segmentArgs({
    input: nasty,
    seq: 300,
    media: { videoCodec: 'hevc', width: 1920 },
    device: '/dev/dri/renderD128',
    hwDecode: true,
    bitrate: '6M'
  })

  // The filename is exactly one element - the same shell-injection rule every
  // ffmpeg argv in this repo follows.
  assert.equal(args.filter((a) => a === nasty).length, 1)

  // Segment 300 starts at 1200s: the seek and the timestamp offset must agree,
  // or the player's clock and the film part ways at the first generated segment.
  assert.equal(args[args.indexOf('-ss') + 1], '1200')
  assert.equal(args[args.indexOf('-output_ts_offset') + 1], '1200')
  assert.equal(args[args.indexOf('-t') + 1], String(hls.SEGMENT_SECONDS))

  // The engine pipeline, MPEG-TS out, AAC always - the least surprising pairing
  // for an HLS demuxer.
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi')
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
  assert.equal(args[args.indexOf('-f') + 1], 'mpegts')
  assert.equal(args.includes('-hwaccel'), true)

  // Software decode for the codecs the engine cannot take - the encode is on the
  // engine either way.
  const sw = hls.segmentArgs({ input: '/x.avi', seq: 0, media: { videoCodec: 'mpeg4' }, device: '/dev/dri/renderD128', hwDecode: false, bitrate: '1500k' })
  assert.equal(sw.includes('-hwaccel'), false)
  assert.equal(sw[sw.indexOf('-vf') + 1], 'format=nv12,hwupload')
  // Segment zero seeks nowhere and offsets nothing.
  assert.equal(sw.includes('-ss'), false)
})

test('BURN-IN rewires the graph: software decode, pad back to the canvas, overlay by subtitle-relative index', () => {
  // A scope rip: 1920x816 picture, subtitles authored against the disc's full
  // 1920x1080 frame with the dialogue in the letterbox bar. Without the pad
  // the text clips at the picture's bottom edge - seen on the TCL.
  const args = hls.segmentArgs({
    input: '/library/Movies/A New Hope.mkv',
    seq: 150,
    media: { videoCodec: 'h264', width: 1920, height: 816 },
    device: '/dev/dri/renderD128',
    hwDecode: true,
    bitrate: '6M',
    burn: { index: 1, canvasWidth: 1920, canvasHeight: 1080 }
  })

  // SOFTWARE decode, deliberately, even though the codec is hw-decodable: the
  // engine's own compositor segfaults on real discs (DECISIONS 2026-08-15).
  assert.equal(args.includes('-hwaccel'), false)
  assert.equal(args[args.indexOf('-vaapi_device') + 1], '/dev/dri/renderD128')

  // Pad to the canvas, overlay by 0:s:N (probe.js's own vocabulary), then up
  // to the engine for the encode.
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.match(graph, /\[0:v:0\]pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2\[p\];\[p\]\[0:s:1\]overlay/)
  assert.match(graph, /format=nv12,hwupload\[out\]/)
  assert.equal(args[args.indexOf('-map') + 1], '[out]')

  // One graph, not two: -vf must not also appear, and the seek arithmetic is
  // untouched by burning.
  assert.equal(args.includes('-vf'), false)
  assert.equal(args[args.indexOf('-ss') + 1], String(150 * hls.SEGMENT_SECONDS))
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi')

  // A full-height film needs no pad: canvas and picture agree.
  const full = hls.segmentArgs({
    input: '/x.mkv',
    seq: 0,
    media: { videoCodec: 'h264', width: 1920, height: 1080 },
    device: '/dev/dri/renderD128',
    hwDecode: true,
    bitrate: '6M',
    burn: { index: 0, canvasWidth: 1920, canvasHeight: 1080 }
  })
  assert.match(full[full.indexOf('-filter_complex') + 1], /^\[0:v:0\]\[0:s:0\]overlay/)

  // An older cache with no recorded canvas: pad to 1920x1080, what HD discs
  // author against, rather than clipping.
  const unknown = hls.segmentArgs({
    input: '/x.mkv',
    seq: 0,
    media: { videoCodec: 'h264', width: 1920, height: 800 },
    device: '/dev/dri/renderD128',
    hwDecode: true,
    bitrate: '6M',
    burn: { index: 0 }
  })
  assert.match(unknown[unknown.indexOf('-filter_complex') + 1], /pad=1920:1080/)

  // No burn asked, nothing changes: the plain path still hw-decodes and -vf's.
  const plain = hls.segmentArgs({ input: '/x.mkv', seq: 0, media: { videoCodec: 'h264' }, device: '/dev/dri/renderD128', hwDecode: true, bitrate: '6M' })
  assert.equal(plain.includes('-filter_complex'), false)
  assert.equal(plain.includes('-hwaccel'), true)
})

test('A TONE takes the software lane and its filter is a lookup, alone or over a burn', () => {
  const base = { input: '/x.mkv', seq: 0, media: { videoCodec: 'h264', width: 1920, height: 1080 }, device: '/dev/dri/renderD128', hwDecode: true, bitrate: '6M' }

  const bw = hls.segmentArgs({ ...base, tone: 'bw' })
  assert.equal(bw.includes('-hwaccel'), false, 'software decode, same reasoning as burn')
  assert.equal(bw[bw.indexOf('-vf') + 1], 'hue=s=0,format=nv12,hwupload')

  const sepia = hls.segmentArgs({ ...base, tone: 'sepia' })
  assert.match(sepia[sepia.indexOf('-vf') + 1], /^colorchannelmixer=/)

  // Tone over a burn: one graph, the tone after the overlay.
  const both = hls.segmentArgs({ ...base, tone: 'bw', burn: { index: 1, canvasWidth: 1920, canvasHeight: 1080 } })
  assert.match(both[both.indexOf('-filter_complex') + 1], /overlay\[ov\];\[ov\]hue=s=0,format=nv12,hwupload\[out\]/)

  // Junk never reaches argv - the lookup is the whole gate.
  const junk = hls.segmentArgs({ ...base, tone: 'vivid; rm -rf /' })
  assert.equal(junk.includes('-hwaccel'), true, 'unknown tone means the plain hardware path')
})

// --- the copy engine ---------------------------------------------------------
//
// Segmenting a film WITHOUT re-encoding its picture. Every number pinned here was
// measured against real films on the Umbrel on 2026-08-19 and then played on Tim's
// Roku; the reasoning lives in host/hls.js and DECISIONS.

test('A COPY PLAN CUTS ON KEYFRAMES, and its segments are honestly uneven', () => {
  // A keyframe list with the shape a real film has: irregular gaps, because
  // encoders put keyframes on scene cuts. Measured on the test episode at 0.96 s
  // to 10.43 s apart, so an even grid is not an approximation of this - it is a
  // different set of times entirely.
  const times = [0, 2.1, 4.9, 6.6, 8.6, 10.7, 13.7, 15.1, 19.9, 26.3, 31.4]
  const plan = hls.copyPlan(times, { runtime: 40, reorderDelay: 0.083 })

  assert.equal(plan.engine, 'copy')
  // Every start is a real keyframe, never a multiple of four.
  for (const start of plan.starts) assert.ok(times.includes(start), `${start} is a keyframe`)
  // Each one is at least the target past the last, and it is the FIRST such
  // keyframe - a plan that skipped one would make segments longer than they need
  // to be for no reason.
  assert.deepEqual(plan.starts, [0, 4.9, 10.7, 15.1, 19.9, 26.3, 31.4])

  // The playlist's durations are the real ones. A player takes the film's length
  // from their sum, so an even 4.000 everywhere would be a lie about a copy.
  const durations = hls.durationsOf(plan)
  assert.equal(durations.length, plan.starts.length)
  assert.ok(durations.some(d => Math.abs(d - 4) > 0.5), 'uneven by nature')
  const total = durations.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 40) < 1e-9, 'the durations sum to the film')

  const playlist = hls.playlistFor({ runtime: 40 }, { plan })
  assert.match(playlist, /#EXTINF:4\.900,\n0\.ts/)
  assert.match(playlist, /#EXT-X-TARGETDURATION:9/, 'the ceiling of the longest, not the target')
  assert.equal((playlist.match(/#EXTINF/g) || []).length, 7)
})

test('a keyframe with no room to aim at is not offered as a cut point', () => {
  // ffmpeg's backward seek lands on the keyframe STRICTLY BEFORE the time asked
  // for, so a cut point has to be aimed at from inside its own group of pictures.
  // A group too short to aim into would be cut on the keyframe before it, and the
  // segment would open with seconds that belong to the previous one.
  const times = [0, 5, 5.05, 10, 15]
  const plan = hls.copyPlan(times, { runtime: 20 })
  assert.equal(plan.starts.includes(5), false, 'a 0.05 s group is skipped')
  assert.deepEqual(plan.starts, [0, 5.05, 10, 15])

  // The seek aims INSIDE the group, never at its edge, and never further than
  // halfway - so a short group is still aimed at with room on both sides.
  const seeks = plan.seeks
  for (let k = 0; k < plan.starts.length; k++) {
    assert.ok(seeks[k] > plan.starts[k], 'past the keyframe')
    assert.ok(seeks[k] - plan.starts[k] >= hls.SEEK_HEADROOM || seeks[k] < plan.starts[k] + 2.5)
  }

  // Too few cut points to make a plan out of is not a plan.
  assert.equal(hls.copyPlan([0], { runtime: 20 }), null)
  assert.equal(hls.copyPlan([0, 4, 8], { runtime: 0 }), null)
  assert.equal(hls.copyPlan(null, { runtime: 20 }), null)
})

test('A COPIED SEGMENT NEVER TOUCHES THE PICTURE, and its cut is exact', () => {
  const nasty = '/library/TV/MST3K; rm -rf $HOME/"quoted".mkv'
  const plan = hls.copyPlan([0, 5, 10.5, 16, 22], { runtime: 30, reorderDelay: 0.083 })
  const args = hls.copySegmentArgs({ input: nasty, seq: 2, plan, audio: 'aac', audioChannels: 2 })

  // The picture is copied. Nothing hardware, no filter, no bitrate - that is the
  // whole point, and a stray encoder flag here is a full transcode nobody asked for.
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy')
  assert.equal(args.includes('h264_vaapi'), false)
  assert.equal(args.includes('-vaapi_device'), false)
  assert.equal(args.includes('-vf'), false)
  assert.equal(args.includes('-b:v'), false)

  // The soundtrack IS rebuilt, mixed to the client's speaker count - the reason a
  // film with a perfect picture is being touched at all.
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
  assert.equal(args[args.indexOf('-ac') + 1], '2')

  // The three flags that make the cut exact, each measured. Dropping any one of
  // them puts overlapping seconds at every join.
  assert.ok(args.includes('-copyts'))
  assert.ok(args.includes('-noaccurate_seek'))
  assert.equal(args[args.indexOf('-avoid_negative_ts') + 1], 'disabled')

  // -ss aims INSIDE the group at 10.5, and -to is the NEXT boundary's decode time:
  // 16 less the reorder delay less a millisecond.
  assert.equal(Number(args[args.indexOf('-ss') + 1]), 10.5 + hls.SEEK_HEADROOM)
  assert.equal(Number(args[args.indexOf('-to') + 1]).toFixed(3), (16 - 0.083 - 0.001).toFixed(3))

  // The filename is exactly one element, the same shell-injection rule every
  // ffmpeg argv in this repo follows.
  assert.equal(args.filter(a => a === nasty).length, 1)
  assert.equal(args[args.length - 1], 'pipe:1')

  // The FIRST segment is not seeked at all: there is no keyframe before zero to
  // fall back onto, so a seek could only land it wrong.
  const first = hls.copySegmentArgs({ input: '/x.mkv', seq: 0, plan })
  assert.equal(first.includes('-ss'), false)
  // And the LAST runs to the end of the film, with no reorder correction to make.
  const last = hls.copySegmentArgs({ input: '/x.mkv', seq: plan.starts.length - 1, plan })
  assert.equal(Number(last[last.indexOf('-to') + 1]), 30)
})

test('a soundtrack MPEG-TS can carry is copied; one it cannot is rebuilt', () => {
  const plan = hls.copyPlan([0, 5, 10, 15], { runtime: 20 })
  const of = (audio, audioCodec) => hls.copySegmentArgs({ input: '/x.mkv', seq: 1, plan, audio, audioCodec })

  assert.equal(of('copy', 'ac3')[of('copy', 'ac3').indexOf('-c:a') + 1], 'copy')
  // TRUEHD is a real thing in a real library and MPEG-TS will not carry it, so
  // "the client can take this soundtrack" is not on its own a reason to copy it.
  assert.equal(of('copy', 'truehd')[of('copy', 'truehd').indexOf('-c:a') + 1], 'aac')
  assert.equal(of('aac', 'eac3')[of('aac', 'eac3').indexOf('-c:a') + 1], 'aac')
})

test('the encode engine is untouched: an even grid, and its old arithmetic', () => {
  const grid = hls.gridPlan(10)
  assert.equal(grid.engine, 'encode')
  assert.deepEqual(grid.starts, [0, 4, 8])
  assert.equal(grid.seeks, null)
  assert.deepEqual(hls.durationsOf(grid), [4, 4, 2])

  // playlistFor with no plan still builds the grid itself, so every caller that
  // predates the copy engine keeps working unchanged.
  assert.equal(hls.playlistFor({ runtime: 10 }), hls.playlistFor({ runtime: 10 }, { plan: grid }))
  assert.equal(hls.segmentCount(grid), 3)
})

// --- how many speakers to encode for -------------------------------------------

test('the speaker count is the smaller of what the client takes and what the film has', () => {
  // `-ac 6` against a stereo source does not leave it alone, it UPMIXES: six channels
  // of a two channel film, at six channels' worth of bitrate, for nothing. So widening
  // a television to 5.1 must not start inflating the stereo films going to it.
  assert.equal(hls.channelsFor(6, 2), 2)
  assert.equal(hls.channelsFor(6, 6), 6)
  assert.equal(hls.channelsFor(2, 6), 2, 'and a stereo television still gets a mixdown')

  // Absent on either side means the old behaviour: a film scanned before channels were
  // recorded is not guessed at, and a client that said nothing gets stereo.
  assert.equal(hls.channelsFor(6, 0), 6)
  assert.equal(hls.channelsFor(0, 6), 2)
})

test('a converted picture does not cost a television its surround', () => {
  // The copy engine already asked for the client's count. The encode engine hardcoded
  // two, so a film converted for a set that takes 5.1 arrived in stereo - which is the
  // same fault this work is about, one path along.
  const args = hls.segmentArgs({
    input: '/x.mkv', seq: 0, media: { videoCodec: 'hevc' }, device: '/dev/dri/renderD128',
    hwDecode: true, bitrate: '6M', audioChannels: 6
  })
  assert.equal(args[args.indexOf('-ac') + 1], '6')

  // And the default is what it always was.
  const plain = hls.segmentArgs({ input: '/x.mkv', seq: 0, media: { videoCodec: 'h264' }, device: '/dev/dri/renderD128', hwDecode: true, bitrate: '6M' })
  assert.equal(plain[plain.indexOf('-ac') + 1], '2')
})
