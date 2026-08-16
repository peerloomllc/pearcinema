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
