// THE TWO HALVES OF ONE CONTRACT: the host writes a playlist naming segments by
// index, and the phone's shim rewrites every line into a URL on this phone. They
// are in different repositories' worth of code and can only be wrong together, so
// these tests hand a REAL host playlist to the REAL rewrite rather than to a
// string somebody typed.
//
// It matters more since 2026-08-27, when an HEVC film started getting fragmented
// MP4 segments and a third line shape - `#EXT-X-MAP`, naming a header. A missed
// map line is not an error anywhere: the player resolves `init.mp4` against its
// own base, fetches nothing, and sits at 0:00.

const test = require('node:test')
const assert = require('node:assert/strict')

const hls = require('../host/hls')
const routes = require('../src/hls-routes')

const PLAN = { starts: [0, 10, 20], seeks: [0, 10.3, 20.3], ends: [9.999, 19.999, 30], runtime: 30, engine: 'copy' }

test('THE HOST AND THE PHONE AGREE ON WHAT THE HEADER IS CALLED', () => {
  // Two files write this name and neither imports the other - the host cannot
  // require the worklet's tree and the worklet must not pull in the host's. So
  // the check is here, and a rename that touches only one of them fails.
  assert.equal(routes.INIT_NAME, hls.INIT_NAME)
})

test('every segment line in a real MPEG-TS playlist comes back pointed at the shim', () => {
  const playlist = hls.playlistFor({ runtime: 30 }, { plan: PLAN })
  const out = routes.rewritePlaylist(playlist, 'abc123')

  assert.match(out, /^\/hlsseg\/abc123\/0\.ts$/m)
  assert.match(out, /^\/hlsseg\/abc123\/2\.ts$/m)
  // Nothing is left naked, or the player asks its own base for it.
  assert.equal(/^\d+\.ts$/m.test(out), false)
  // A TS playlist has no header, and none is invented.
  assert.equal(out.includes('hlsinit'), false)

  // The tags are untouched. A rewrite that ate `#EXT-X-ENDLIST` turns a finished
  // film into one the player waits forever for more of.
  assert.match(out, /#EXT-X-ENDLIST/)
  assert.match(out, /#EXT-X-PLAYLIST-TYPE:VOD/)
  assert.equal((out.match(/#EXTINF/g) || []).length, 3)
})

test('A FRAGMENTED PLAYLIST HAS ITS HEADER REWRITTEN TOO, which is the line that is easy to miss', () => {
  const playlist = hls.playlistFor({ runtime: 30 }, { plan: PLAN, container: 'fmp4' })
  const out = routes.rewritePlaylist(playlist, 'abc123')

  assert.match(out, /#EXT-X-MAP:URI="\/hlsinit\/abc123\/init\.mp4"/)
  assert.match(out, /^\/hlsseg\/abc123\/0\.m4s$/m)
  assert.match(out, /^\/hlsseg\/abc123\/2\.m4s$/m)

  // The bare name must not survive anywhere: a player resolving it against its
  // own base fetches nothing and never starts, with no error to see.
  assert.equal(/URI="init\.mp4"/.test(out), false)
  assert.equal(/^\d+\.m4s$/m.test(out), false)

  // Both routes the shim answers on, spelled by the same helpers the shim uses.
  assert.ok(out.includes(routes.initPath('abc123')))
  assert.ok(out.includes(routes.segmentPath('abc123', 1, 'm4s')))
})

test('only whole segment lines are rewritten, never a number inside a tag', () => {
  // `#EXT-X-TARGETDURATION:10` and `#EXTINF:10.000,` both contain a number and a
  // dot. An unanchored rewrite would corrupt the playlist's own tags, which is
  // the kind of break that shows up as a film that plays at the wrong speed.
  const playlist = hls.playlistFor({ runtime: 30 }, { plan: PLAN, container: 'fmp4' })
  const out = routes.rewritePlaylist(playlist, 'x1')

  for (const line of out.split('\n')) {
    if (line.startsWith('#')) assert.equal(line.includes('/hlsseg/'), false, line)
  }
  assert.match(out, /#EXT-X-TARGETDURATION:10/)
  assert.match(out, /#EXTINF:10\.000,/)

  // And an empty or missing playlist is a string, not a crash - the shim answers
  // 409 on a refusal, and must not fall over on the way there.
  assert.equal(routes.rewritePlaylist(null, 'x1'), '')
  assert.equal(routes.rewritePlaylist('', 'x1'), '')
})
