// The web interface's data layer. One fetch helper, and the small formatters that
// would otherwise be re-invented in four components.

// Which library the READ surface points at (proposal 2026-08-16-desktop-client):
// '' is this machine's own, '/remote/<lib>' is a paired remote's. Only the
// browse/play/watch routes are rewritten - the control plane (/api/state, the
// source wizard, people and devices) is always about THIS box, whatever is being
// watched. Module-level on purpose: the <img> and <video> tags build URLs
// outside api() and need the same answer.
let remoteBase = ''
// `download\b` is the per-library START and deliberately does not match
// /api/downloads - the finished list is global, one card for every library.
// `requests?\b` covers asking, listing and withdrawing, all per-library.
const REMOTED = /^\/api\/(library\/|art\b|stream\b|remux\b|subtitles?\b|watch\/|download\b|requests?\b)/

export function setRemoteBase (base) { remoteBase = base || '' }
export function isRemote () { return !!remoteBase }
export function withBase (path) {
  return remoteBase && REMOTED.test(path) ? remoteBase + path : path
}

export async function api (path, body) {
  path = withBase(path)
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  // A logged-out session answers the API with 401 (@peerloom/host's dashboard
  // auth). Reload so the server hands back the login page instead of leaving the
  // page spinning on a request that will never succeed.
  if (res.status === 401) { location.reload(); return {} }
  return res.json().catch(() => ({}))
}

// --- news that arrives on its own ------------------------------------------
//
// One EventSource for the whole page, shared by every card that wants it - a
// second one would be a second held-open connection for the same frames. It is
// opened on the first subscriber and never closed: the page IS the session, and
// EventSource reconnects by itself when the host restarts, which is exactly the
// moment a card most wants to hear from it.
//
// ALWAYS about THIS box, so it is deliberately not run through withBase(): the
// live channel carries what reached this machine, including the answers a paired
// library sent it.
let source = null
const live = new Map() // kind -> Set<fn>

export function onLive (kinds, fn) {
  // Anywhere without EventSource - a test DOM, an ancient browser - gets a
  // no-op rather than a throw. This runs inside an effect, and an effect that
  // throws takes the whole page down with it, which is a poor trade for a card
  // that has its own load and its own backstop.
  if (typeof EventSource === 'undefined') return () => {}
  const list = Array.isArray(kinds) ? kinds : [kinds]
  for (const k of list) {
    if (!live.has(k)) live.set(k, new Set())
    live.get(k).add(fn)
  }
  if (!source) {
    source = new EventSource('/api/events')
    source.onmessage = (e) => {
      let m = null
      try { m = JSON.parse(e.data) } catch { return }
      // A handler that throws must not take the other subscribers down with it.
      for (const g of live.get(m?.kind) || []) { try { g(m.data || null) } catch {} }
    }
    // No onerror handler on purpose: the default is to reconnect, and a manual
    // close here would turn a host restart into a page that never updates again.
  }
  return () => { for (const k of list) live.get(k)?.delete(fn) }
}

// The host is served over plain http (an Umbrel LAN address, a laptop on the same
// wifi). navigator.clipboard only exists on a SECURE origin, so a copy button would
// silently do nothing there. Fall back to the old execCommand path.
export async function copyText (text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function ago (ts) {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

export function until (ts) {
  if (!ts) return ''
  const s = Math.floor((ts - Date.now()) / 1000)
  if (s <= 0) return ''
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}

// A guest-pass DURATION in ms as coarse words, for the pairing window.
export function fmtDur (ms) {
  const d = Math.round(ms / 86400000)
  if (d >= 1) return d === 1 ? '24 hours' : d + ' days'
  const h = Math.round(ms / 3600000)
  if (h >= 1) return h === 1 ? '1 hour' : h + ' hours'
  return Math.max(1, Math.round(ms / 60000)) + ' minutes'
}

// RUNTIMES ARE SECONDS, everywhere, and this file used to read them as minutes -
// which showed the 116-minute film 300 as "116h 33m". Tim caught it 2026-08-13.
//
// Seconds is the host's deliberate choice and it is written down in nfo.js: Kodi
// stores runtime in MINUTES and a resume position in seconds, so everything is
// normalised to seconds on the way in and nobody downstream has to remember which is
// which. `probed.duration` from ffprobe is seconds, `_seconds(RunTimeTicks)` from
// Jellyfin is seconds, and `runtimeSeconds()` from a sidecar is seconds. Only the
// display was wrong.
export function fmtRuntime (seconds) {
  if (!seconds) return ''
  const total = Math.round(seconds / 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

// WHICH HALF, for a film that arrived as two files. Only a folder source ever knows
// - the marker is in the filename - so this is empty for almost everything and drops
// out of a facts line on its own.
export function fmtPart (part) {
  return Number(part) > 0 ? `Part ${Number(part)}` : ''
}

// THE WHOLE LENGTH, down to the second, for the details sheet. `fmtRuntime` rounds to
// the nearest minute, which is right on a poster and wrong in a panel somebody opened
// specifically to see the facts about a file (Tim, 2026-08-13).
export function fmtExact (seconds) {
  const total = Math.round(Number(seconds) || 0)
  if (!total) return ''
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = total % 60
  return [h && `${h} h`, (h || m) && `${m} m`, `${s} s`].filter(Boolean).join(' ')
}

export function fmtSize (bytes) {
  if (!bytes) return ''
  const gb = bytes / 1e9
  if (gb >= 1) return gb.toFixed(1) + ' GB'
  return Math.round(bytes / 1e6) + ' MB'
}

export function fmtClock (sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function platformLabel (p) {
  const k = String(p || '').toLowerCase()
  if (k === 'android') return 'Android'
  if (k === 'ios' || k === 'ipados') return 'iOS'
  return p ? p[0].toUpperCase() + p.slice(1) : null
}

// A device's public key, abbreviated. The key is the device's REAL identity - the
// one thing it cannot lie about, since Noise proves it on every connection - while
// labels and claimed names are only what the device said. So when two rows look
// alike, this is what tells them apart for certain.
export function shortKey (k) {
  const s = String(k || '')
  return s.length > 14 ? s.slice(0, 6) + '…' + s.slice(-4) : s
}

export function episodeCode (e) {
  if (!e || e.seasonNumber === null || e.seasonNumber === undefined) return null
  if (e.episodeNumber === null || e.episodeNumber === undefined) return null
  const pad = (n) => String(n).padStart(2, '0')
  return `S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}`
}
