// The web interface's data layer. One fetch helper, and the small formatters that
// would otherwise be re-invented in four components.

export async function api (path, body) {
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
