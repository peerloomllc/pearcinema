// The two rules that are about VIDEO rather than about storage.
//
// The store is inherited whole from PearTune and tested in @peerloom/host. What is
// decided here is where "the end" is, what counts as having started something, and
// how a show reports itself - and each of those is a judgement that shows up on
// screen as a badge somebody either trusts or stops looking at.

const test = require('node:test')
const assert = require('node:assert/strict')

const watch = require('../host/watch')

// Runtimes are SECONDS everywhere in this app; positions are MILLISECONDS, inherited
// from the donor's rows. A two-hour film.
const FILM = 7200

test('NINETY-FIVE PERCENT IS FINISHED, because nobody watches the credits', () => {
  assert.equal(watch.decide({ positionMs: 6839 * 1000, runtimeSeconds: FILM }).finished, false)
  assert.equal(watch.decide({ positionMs: 6840 * 1000, runtimeSeconds: FILM }).finished, true)

  // A film that stops at 97% and never marks itself is exactly the small lie that
  // makes a badge untrustworthy, and an untrustworthy badge is worse than none.
  assert.equal(watch.decide({ positionMs: 6984 * 1000, runtimeSeconds: FILM }).finished, true)
})

test('FINISHING DROPS THE POSITION, so nothing sits in continue-watching wearing a tick', () => {
  const v = watch.decide({ positionMs: 7000 * 1000, runtimeSeconds: FILM })
  assert.equal(v.finished, true)
  assert.equal(v.positionMs, 0, 'zero is the store\'s delete')
})

test('the player saying `ended` is believed whatever the clock says', () => {
  // A file whose header lies about its duration, or a stream that ends early. The
  // element knows it reached the end; arguing with it would leave the film unfinished
  // forever.
  const v = watch.decide({ positionMs: 12_000, runtimeSeconds: FILM, ended: true })
  assert.equal(v.finished, true)
  assert.equal(v.positionMs, 0)
})

test('THE FIRST MINUTE IS NOT WATCHING IT', () => {
  // Opening something, watching thirty seconds and closing it did not start it. A
  // continue-watching row full of things nobody began is a row people stop reading.
  assert.equal(watch.decide({ positionMs: 30_000, runtimeSeconds: FILM }).positionMs, 0)
  assert.equal(watch.decide({ positionMs: 61_000, runtimeSeconds: FILM }).positionMs, 61_000)
})

test('A POSITION PAST THE END CLAMPS RATHER THAN FAILING', () => {
  // Ids are derived from the path relative to the root, so re-encoding a film IN
  // PLACE keeps its id while changing its length. A position left in the old, longer
  // cut must not read as a lost place - and past the end means finished.
  const v = watch.decide({ positionMs: 9_000_000, runtimeSeconds: FILM })
  assert.equal(v.finished, true)
  assert.equal(v.durationMs, FILM * 1000)
})

test('an unknown runtime remembers the position and claims nothing', () => {
  // A source that reports no duration cannot say where the end is, so nothing is ever
  // finished automatically - the hand mark is what is left, and that is honest.
  const v = watch.decide({ positionMs: 600_000, runtimeSeconds: null })
  assert.equal(v.finished, false)
  assert.equal(v.positionMs, 600_000)
  assert.equal(v.durationMs, null)
})

test('SECONDS AND MILLISECONDS ARE NOT MIXED UP, which would mean nothing is ever finished', () => {
  // The trap: runtime is 7200 and a position near the end is 7,000,000. Comparing
  // them raw makes every film unfinished forever, and it is the kind of bug that
  // looks like "the badge does not work" rather than like a unit error.
  assert.equal(watch.isFinished(7_000_000, 7200), true)
  assert.equal(watch.isFinished(7000, 7200), false, '7 seconds into a two-hour film')
})

// --- a show is derived, never stored --------------------------------------------

const eps = (n) => Array.from({ length: n }, (_, i) => ({ id: 'e' + i }))

test('A SHOW REPORTS WHAT IS LEFT, which is what is actually useful', () => {
  // "3 left" tells somebody to open it; a tick does not. And it is computed rather
  // than stored, so an episode landing in a folder cannot leave a rollup stale.
  const r = watch.rollup(eps(10), new Set(['e0', 'e1', 'e2']))
  assert.equal(r.total, 10)
  assert.equal(r.watched, 3)
  assert.equal(r.unwatched, 7)
  assert.equal(r.complete, false)
})

test('a show is complete only when every episode is', () => {
  assert.equal(watch.rollup(eps(3), new Set(['e0', 'e1', 'e2'])).complete, true)
  assert.equal(watch.rollup(eps(3), new Set(['e0', 'e1'])).complete, false)
})

test('AN EMPTY SHELF IS NOT A WATCHED SHOW', () => {
  // `seen === total` is true for zero, which would put a tick on a show whose files
  // are on a drive that is currently unplugged.
  const r = watch.rollup([], new Set())
  assert.equal(r.complete, false)
  assert.equal(r.unwatched, 0)
})

test('a watched id that is not in this season does not count towards it', () => {
  assert.equal(watch.rollup(eps(2), new Set(['e0', 'somebody-elses-episode'])).watched, 1)
})
