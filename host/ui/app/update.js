// Should the "a new PearCinema is out" banner show, and has this person already
// hidden it? No DOM, so the rule is unit-testable (test/update-ui.test.js).
// Ported from PearTune's host/ui/app/update.js.

const KEY = 'pearcinema.update.dismissed'

// Hiding is per version: hiding 1.1.5 must not also hide 1.2.0.
export function dismissedVersion () {
  try { return localStorage.getItem(KEY) || null } catch { return null }
}

export function dismissUpdate (version) {
  try { localStorage.setItem(KEY, String(version || '')) } catch {}
}

// `info` is what GET /api/update answered. Not checked yet, GitHub down, a Docker
// install or no version all mean no banner: a wrong banner is worse than none.
export function shouldShowUpdate (info, dismissed = dismissedVersion()) {
  if (!info || info.disabled || !info.available) return false
  if (!info.latest) return false
  return String(info.latest) !== String(dismissed)
}
