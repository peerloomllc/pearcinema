'use strict'

// A REVOKED LIBRARY'S FILMS STOP PLAYING, including the ones the phone already holds.
//
// The gap this covers was found filming the App Review video on 2026-08-27: the owner
// revoked the phone mid-film and the film carried on to the end, because the bytes were
// already on the device. The listing promises the opposite in so many words.

const test = require('node:test')
const assert = require('node:assert/strict')

const R = require('../src/revoked')

const LIB = 'g93ynoi4co3fii8rr1sp98e1kniq7uyeibznzeop6ycngcqq3g6o'
const OTHER = 'u9477g7efpk3t37zgawfjfnn8cyywdqfdpo9gxqwthw16sodbqto'

test('the track routes are read in both forms, and nothing else is', () => {
  assert.deepEqual(R.parseTrackUrl('/t/abc123'), { libraryId: null, id: 'abc123' })
  assert.deepEqual(R.parseTrackUrl(`/t/${LIB}/abc123`), { libraryId: LIB, id: 'abc123' })
  assert.deepEqual(R.parseTrackUrl('/t/abc123?x=1'), { libraryId: null, id: 'abc123' })

  // Art, the HLS routes and the demo's own are not track requests.
  assert.equal(R.parseTrackUrl('/art/abc123?s=350'), null)
  assert.equal(R.parseTrackUrl('/hls/abc123.m3u8'), null)
  assert.equal(R.parseTrackUrl('/demo/abc123'), null)
  assert.equal(R.parseTrackUrl('/'), null)
})

test('the owning library is found by URL, then by index, then by what the cache recorded', () => {
  const opts = {
    ownerOf: (id) => (id === 'onshelf' ? LIB : null),
    cacheLibraryOf: (id) => (id === 'ondisk' ? LIB : null)
  }
  assert.equal(R.libraryOf({ libraryId: LIB, id: 'x' }, opts), LIB)
  assert.equal(R.libraryOf({ libraryId: null, id: 'onshelf' }, opts), LIB)
  // THE ONE THAT MATTERS OFFLINE: a film played from disk after a restart has no index
  // behind it and no library in its URL. The cache row is the only thing left that knows.
  assert.equal(R.libraryOf({ libraryId: null, id: 'ondisk' }, opts), LIB)
  assert.equal(R.libraryOf({ libraryId: null, id: 'nobodys' }, opts), null)
})

test('a revoked library is refused, live or from the phone\'s own disk', () => {
  const revoked = new Set([LIB])
  const ownerOf = (id) => (id === 'theirs' ? LIB : id === 'mine' ? OTHER : null)
  const cacheLibraryOf = (id) => (id === 'cached' ? LIB : null)
  const gate = (url) => R.blocked(url, { revoked, ownerOf, cacheLibraryOf })

  assert.equal(gate(`/t/${LIB}/anything`).libraryId, LIB)
  assert.equal(gate('/t/theirs').libraryId, LIB)
  assert.equal(gate('/t/cached').libraryId, LIB, 'a film already on the phone is still theirs')

  // Everything else plays.
  assert.equal(gate('/t/mine'), null)
  assert.equal(gate(`/t/${OTHER}/anything`), null)
  assert.equal(gate('/art/theirs?s=120'), null, 'artwork is not the message')
  assert.equal(gate('/demo/theirs'), null, 'the demo has no host to revoke it')
})

test('nothing is refused when no library has revoked this device', () => {
  const gate = (url) => R.blocked(url, { revoked: new Set(), ownerOf: () => LIB, cacheLibraryOf: () => LIB })
  assert.equal(gate(`/t/${LIB}/x`), null)
  assert.equal(gate('/t/x'), null)
})

test('AN ID WHOSE LIBRARY IS UNKNOWN STILL PLAYS', () => {
  // The unknown case is an ordinary film on a single-host phone before any index exists,
  // and refusing those would break playback for everybody to enforce a rule against a
  // library that has revoked nobody. Deliberate, and the reason `blocked` needs a library
  // to say yes rather than saying yes by default.
  const gate = (url) => R.blocked(url, { revoked: new Set([LIB]), ownerOf: () => null, cacheLibraryOf: () => null })
  assert.equal(gate('/t/whoknows'), null)
})
