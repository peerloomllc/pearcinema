'use strict'

// WHAT A REVOKED DEVICE MAY STILL BE SERVED, which is nothing from that library.
//
// The inherited rule is that revoke kills LIVE connections rather than only future ones
// (CLAUDE.md, from PearTune), and the App Store listing says it out loud: the owner can
// cut a device off "in a second - mid-film, not on next login". Hanging up the socket is
// not enough to make that true, and Tim found the gap filming the revoke for App Review
// on 2026-08-27: the film carried on to the end.
//
// TWO REASONS IT CARRIED ON, and they need different answers:
//
//   1. THE PLAYER HAD ALREADY BEEN HANDED THE BYTES. On a home network a film is fetched
//      far ahead of what is being watched - often all of it - so there is nothing left to
//      cut off. The answer is the app stopping the player when the goodbye arrives, which
//      is in src/ui/App.jsx, not here.
//   2. THE PHONE HAD KEPT THE BYTES. Playback writes through to the cache, so a film
//      watched once plays again from disk with no host involved at all. That is the point
//      of the cache and it is exactly wrong for a library that has just said no. This
//      module is the gate for that: every request the shim serves passes through it
//      first, and one belonging to a revoked library is refused.
//
// Tim chose the strict reading on 2026-08-27: what a revoked library gave this phone
// stops playing at the revoke, rather than expiring on a lease the way PearTune's
// downloads do. Nothing is deleted - a library that lets the device back in works again
// on the next dial - but nothing of theirs plays while the device is out.
//
// Pure, because the alternative is a rule that only a phone can check.

// The shim's track routes, in both forms: `/t/<id>` and the merged `/t/<libraryId>/<id>`.
// Art is deliberately NOT gated. A poster is a thumbnail the phone already holds, and a
// grid of grey rectangles teaches somebody nothing about why their library stopped
// working - the film refusing to play is the message.
const TRACK_2 = /^\/t\/([a-z0-9]+)\/([a-z0-9]+)(?:\?|$)/i
const TRACK_1 = /^\/t\/([a-z0-9]+)(?:\?|$)/i

// Returns { libraryId, id } for a track request, or null for anything else.
function parseTrackUrl (url = '') {
  const u = String(url)
  let m = TRACK_2.exec(u)
  if (m) return { libraryId: m[1], id: m[2] }
  m = TRACK_1.exec(u)
  if (m) return { libraryId: null, id: m[1] }
  return null
}

// WHICH LIBRARY A REQUEST BELONGS TO, asked three ways because no one of them always
// knows: the merged URL carries it, the merged index's ownership map knows it for
// anything on a shelf, and a cache entry records the library its bytes came from - which
// is the only one that still answers for a film played offline after a restart.
function libraryOf ({ libraryId = null, id = null }, { ownerOf = () => null, cacheLibraryOf = () => null } = {}) {
  return libraryId || ownerOf(id) || cacheLibraryOf(id) || null
}

// Should this request be refused? Only for a library that has told this device it is out.
//
// An id whose library cannot be worked out at all is SERVED. That is deliberate: the
// unknown case is a film from the one library this phone is paired with, played before
// any index was built, and refusing those would break ordinary playback to enforce a rule
// against a library that has not revoked anybody.
function blocked (url, { revoked = new Set(), ownerOf, cacheLibraryOf } = {}) {
  const parsed = parseTrackUrl(url)
  if (!parsed) return null
  const lib = libraryOf(parsed, { ownerOf, cacheLibraryOf })
  if (!lib || !revoked.has(lib)) return null
  return { libraryId: lib, id: parsed.id }
}

module.exports = { parseTrackUrl, libraryOf, blocked }
