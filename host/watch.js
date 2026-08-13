// Where you stopped, and whether you have finished it.
//
// Approved as a T2 in proposals/2026-08-13-watch-state.md. The STORE is inherited
// wholesale from PearTune via @peerloom/host - per-person rows, owner derived from
// the authenticated connection, host stamps the clock. What lives here is the part
// that is about VIDEO rather than about storage, and it is two rules and a rollup.

// WHERE "THE END" IS, and it is not the end.
//
// Nobody watches the credits. A film that stops at 97% and never marks itself
// watched is exactly the kind of small lie that makes a badge untrustworthy, and an
// untrustworthy badge is worse than none - the whole reason to have one is to answer
// "have I seen this" without thinking about it.
//
// The same threshold decides the other half: past it, there is nothing to resume, so
// the position is dropped rather than left to put a finished film at the top of
// continue-watching wearing a watched tick.
const FINISHED_AT = 0.95

// Below this, nothing is remembered at all. Somebody who opened a film, watched the
// first minute and closed it did not start it - and a continue-watching row full of
// things nobody actually began is a row people stop looking at.
const STARTED_AFTER_MS = 60_000

// Did this playback finish? Runtime is in SECONDS everywhere in this app (items.js),
// positions are in MILLISECONDS (inherited from the donor's resume rows), and mixing
// those two is a bug that reads as "nothing is ever finished" - so the conversion
// happens HERE, once, rather than at each caller.
function isFinished (positionMs, runtimeSeconds) {
  const durationMs = Number(runtimeSeconds) > 0 ? Number(runtimeSeconds) * 1000 : 0
  if (!durationMs) return false
  return Number(positionMs) >= durationMs * FINISHED_AT
}

// What a write means: keep the position, or treat it as finished.
//
// A position PAST the end is not an error and must not be dropped. A file replaced in
// place keeps its id (ids are derived from the path relative to the root), so a
// re-encoded film can be shorter than the position somebody left in it. Clamping
// rather than failing is what stops that reading as a lost place.
function decide ({ positionMs, runtimeSeconds, ended = false }) {
  const runtime = Number(runtimeSeconds) > 0 ? Number(runtimeSeconds) : 0
  const durationMs = runtime * 1000
  const at = Math.max(0, Math.round(Number(positionMs) || 0))
  const clamped = durationMs ? Math.min(at, durationMs) : at

  if (ended || isFinished(clamped, runtime)) {
    return { finished: true, positionMs: 0, durationMs: durationMs || null }
  }
  if (clamped < STARTED_AFTER_MS) {
    // Not started, so not remembered. Explicitly a zero rather than a skipped write,
    // because the store reads zero as a DELETE - which is what should happen to an
    // older position when somebody restarts something and gives up in the first
    // minute.
    return { finished: false, positionMs: 0, durationMs: durationMs || null }
  }
  return { finished: false, positionMs: clamped, durationMs: durationMs || null }
}

// A SERIES AND A SEASON ARE DERIVED, NEVER STORED.
//
// A show's badge is a count of what you have NOT seen, which is what Plex shows and
// what is actually useful - "3 left" tells you to open it, a tick does not. Storing a
// rollup would mean two sources of truth for the same question and a reconciliation
// job the first time an episode lands in a folder.
//
// `episodes` is the leaves under the container; `watched` is the owner's set.
function rollup (episodes, watched) {
  const total = episodes.length
  let seen = 0
  for (const e of episodes) if (watched.has(e.id)) seen++
  return {
    total,
    watched: seen,
    unwatched: total - seen,
    // A show with no episodes is not a watched show. Said explicitly because
    // `seen === total` is true for zero and would put a tick on an empty shelf.
    complete: total > 0 && seen === total
  }
}

module.exports = { decide, isFinished, rollup, FINISHED_AT, STARTED_AFTER_MS }
