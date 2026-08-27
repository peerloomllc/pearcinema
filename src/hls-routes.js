'use strict'

// POINTING A HOST'S PLAYLIST AT THE PHONE'S OWN SHIM.
//
// The host names its segments by index and nothing else - `0.ts`, `1.m4s` - because
// it has no idea what the player will be told to fetch. The shim serves them over
// loopback, so every line has to be rewritten into a URL on this phone before the
// player ever sees it.
//
// Pure and beside the worklet rather than inside it, per the rule in CLAUDE.md:
// `src/bare.js` is a top-level Bare script that no test can require, so anything
// with a rule in it lives here where Node can check it.
//
// THERE ARE THREE LINE SHAPES NOW, and the third is why this stopped being a
// one-liner. A fragmented-MP4 playlist - which is what an HEVC film gets, because
// Apple's player draws nothing from an MPEG-TS segment carrying HEVC - also names
// a header through `#EXT-X-MAP`. Miss that line and the player resolves
// `init.mp4` against its own base, fetches nothing, and the film never starts,
// with no error anywhere.

// The header's name, which the host writes and this rewrites. Pinned in the tests
// against `host/hls.js` so the two halves of one contract cannot drift.
const INIT_NAME = 'init.mp4'

// A segment line is an index and an extension, alone on its line. Anchored at both
// ends so a comment or a tag that happens to contain a number is never rewritten.
const SEGMENT_LINE = /^(\d+)\.(ts|m4s)$/gm

// The `#EXT-X-MAP` line's URI, which is always quoted in a playlist the host wrote.
const MAP_URI = new RegExp('URI="' + INIT_NAME.replace('.', '\\.') + '"', 'g')

// The paths the shim answers on. Exported so the routes and the rewrite are read
// off the same strings rather than written twice.
const segmentPath = (itemId, seq, ext) => `/hlsseg/${itemId}/${seq}.${ext}`
const initPath = (itemId) => `/hlsinit/${itemId}/${INIT_NAME}`

function rewritePlaylist (playlist, itemId) {
  return String(playlist == null ? '' : playlist)
    .replace(SEGMENT_LINE, (_, seq, ext) => segmentPath(itemId, seq, ext))
    .replace(MAP_URI, `URI="${initPath(itemId)}"`)
}

module.exports = { rewritePlaylist, segmentPath, initPath, INIT_NAME }
