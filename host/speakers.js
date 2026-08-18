// Home Assistant cast-target control, PearTune's speakers.js trimmed to what
// video needs (no voice control, no HA config writing - those are the Voice
// PE's features and stay in the donor).
//
// The host talks to a Home Assistant instance over its REST API to push a film
// at a `media_player` entity - a Chromecast, a Google TV, a Cast-built-in
// television. HA hands the URL STRAIGHT to the device, which fetches it
// itself; the listener that answers it lives in host/cast.js.
//
// WHY LOOPBACK ONLY, inherited with its reasoning: a non-loopback HA is on
// another machine, and serving it would mean publishing the library to the
// LAN behind a bearer token we cannot rotate. We refuse rather than quietly
// doing that. On the Umbrel, HA and PearCinema share the box, so loopback is
// the normal case rather than a restriction.

const fs = require('fs')
const path = require('path')

const FILE = 'cast.json'
const VERSION = 1

// Same posture as the source config: a secret is never sent to the browser,
// and an empty field on save means "leave it alone" rather than "clear it".
const SECRETS = ['token']
const FIELDS = ['enabled', 'baseUrl', 'token', 'hidden']

// Casting a FILM wants a screen. HA's device_class is the only honest signal
// about which of a house's media players has one, and most of them do not set
// it - so an unclassified entity ranks BETWEEN the screens and the speakers
// rather than being treated as either. Ranked, never filtered: the only thing
// that removes an entity from the phone's picker is the operator saying so.
const CLASS_RANK = { tv: 0, receiver: 1, speaker: 3 }
const UNCLASSED_RANK = 2

// Home Assistant's MediaPlayerEntityFeature.SEEK, bit 1 of supported_features.
// Named rather than written as a bare `& 2` at the call site, because the only
// thing worse than a magic number is a magic number about somebody else's
// enum. The living room supplied the reason this matters: a Roku's media_player
// does not declare SEEK, the same way it does not declare media_stop
// (DECISIONS 2026-08-17), and asking anyway is a 500 rather than a no.
const FEATURE_SEEK = 2

function canSeek (supportedFeatures) {
  return (Number(supportedFeatures) & FEATURE_SEEK) === FEATURE_SEEK
}

function rankOf (t) {
  const r = CLASS_RANK[String(t.deviceClass || '').toLowerCase()]
  return r === undefined ? UNCLASSED_RANK : r
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8123'

// How long we wait on HA. Short: every one of these is on loopback, and a hung
// request would stall a media-channel reply the phone is waiting on.
const TIMEOUT_MS = 5000

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

function isLoopbackUrl (raw) {
  let u
  try {
    u = new URL(String(raw || ''))
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return LOOPBACK.has(h)
}

function requireLoopback (baseUrl) {
  if (isLoopbackUrl(baseUrl)) return null
  return 'Home Assistant must be on this same machine (a loopback address like ' +
    'http://127.0.0.1:8123). A Home Assistant somewhere else on the network would ' +
    'mean publishing your library to it, which PearCinema will not do.'
}

function pathOf (dataDir) {
  return path.join(dataDir, FILE)
}

// Only the fields actually present - an absent field means "leave it alone",
// the donor's lesson about partial updates silently turning the feature off.
function pick (cfg) {
  const out = {}
  for (const f of FIELDS) {
    if (cfg[f] !== undefined && cfg[f] !== null) out[f] = cfg[f]
  }
  if (out.baseUrl != null) out.baseUrl = String(out.baseUrl).trim().replace(/\/+$/, '')
  if (out.token != null) out.token = String(out.token).trim()
  if (out.enabled != null) out.enabled = !!out.enabled
  // An array of entity ids, deduped and cleaned. Anything that is not an array
  // is dropped rather than coerced, so a malformed save cannot empty the list
  // by accident - absent already means "leave it alone".
  if (out.hidden != null) {
    if (!Array.isArray(out.hidden)) delete out.hidden
    else out.hidden = [...new Set(out.hidden.map(x => String(x).trim()).filter(Boolean))].sort()
  }
  return out
}

class Speakers {
  constructor ({ dataDir, log = () => {} } = {}) {
    this.dataDir = dataDir
    this.log = log
    this.config = this._read()
  }

  _read () {
    // Absent file = disabled, which is what every host in the wild has. Never
    // throw on a malformed file either: a broken cast.json must not stop a
    // library from serving films.
    try {
      const raw = JSON.parse(fs.readFileSync(pathOf(this.dataDir), 'utf8'))
      if (!raw || typeof raw !== 'object') return this._blank()
      return { ...this._blank(), ...pick(raw) }
    } catch {
      return this._blank()
    }
  }

  _blank () {
    return { version: VERSION, enabled: false, baseUrl: DEFAULT_BASE_URL, token: '', hidden: [] }
  }

  // What the dashboard is allowed to see. The token becomes a boolean - enough
  // to render "configured", never enough to read back.
  publicConfig () {
    const c = this.config
    return {
      version: VERSION,
      enabled: c.enabled,
      baseUrl: c.baseUrl,
      tokenSet: !!c.token,
      hidden: [...(c.hidden || [])],
      problem: c.enabled ? requireLoopback(c.baseUrl) : null
    }
  }

  save (incoming) {
    const next = { ...this.config, ...pick(incoming || {}) }
    for (const s of SECRETS) {
      if (!incoming || incoming[s] === undefined || incoming[s] === '') next[s] = this.config[s]
    }
    if (!next.baseUrl) next.baseUrl = DEFAULT_BASE_URL
    if (next.enabled) {
      const problem = requireLoopback(next.baseUrl)
      if (problem) throw new Error(problem)
      if (!next.token) throw new Error('a Home Assistant long-lived access token is required')
    }
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(pathOf(this.dataDir), JSON.stringify({ ...next, version: VERSION }, null, 2), { mode: 0o600 })
    this.config = next
    this.log('cast:config-saved', { enabled: next.enabled, baseUrl: next.baseUrl })
    return this.publicConfig()
  }

  get enabled () {
    return !!this.config.enabled && !!this.config.token && isLoopbackUrl(this.config.baseUrl)
  }

  async _call (route, { method = 'GET', body = null } = {}) {
    if (!this.config.token) throw new Error('Home Assistant is not configured')
    const problem = requireLoopback(this.config.baseUrl)
    if (problem) throw new Error(problem)

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(this.config.baseUrl + route, {
        method,
        headers: {
          authorization: 'Bearer ' + this.config.token,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      })
      if (res.status === 401 || res.status === 403) {
        throw new Error('Home Assistant rejected the token')
      }
      if (!res.ok) throw new Error(`Home Assistant returned ${res.status}`)
      const text = await res.text()
      return text ? JSON.parse(text) : null
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Home Assistant did not respond')
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  // Does the token work at all. The dashboard's "Test connection".
  async test () {
    await this._call('/api/')
    const list = await this.list()
    return { ok: true, targets: list.length }
  }

  // Every media_player HA knows about. `supportedFeatures` is HA's live
  // bitmask and DYNAMIC on Cast devices, so nobody caches it as a capability.
  async list () {
    const states = await this._call('/api/states')
    if (!Array.isArray(states)) return []
    return states
      .filter(s => typeof s?.entity_id === 'string' && s.entity_id.startsWith('media_player.'))
      .map(s => ({
        entityId: s.entity_id,
        name: s.attributes?.friendly_name || s.entity_id.slice('media_player.'.length),
        state: s.state,
        supportedFeatures: Number(s.attributes?.supported_features || 0),
        // HA's own word for what the thing IS: 'tv', 'speaker', 'receiver', or
        // nothing at all. Kept rather than discarded so a picker for FILMS can
        // put the screens first. Never used to hide anything on its own - a
        // great many entities declare no class (the Voice PEs among them), and
        // a missing class must not mean a missing television.
        deviceClass: s.attributes?.device_class || null,
        hidden: this.isHidden(s.entity_id)
      }))
      // Screens first, then everything unclassified, then the things that can
      // only make a noise. Alphabetical within each band, so the order is still
      // predictable once the bands are.
      .sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name))
  }

  // Entities the operator has pruned from the roster. Kept as a Set answer
  // rather than an array scan because list() asks it once per entity.
  isHidden (entityId) {
    if (!this._hiddenSet || this._hiddenFor !== this.config.hidden) {
      this._hiddenFor = this.config.hidden
      this._hiddenSet = new Set(this.config.hidden || [])
    }
    return this._hiddenSet.has(entityId)
  }

  async getState (entityId) {
    const s = await this._call('/api/states/' + encodeURIComponent(entityId))
    if (!s) return null
    return {
      entityId: s.entity_id,
      state: s.state,
      // Where the TV actually is in the film, off HA's own attributes. Cast
      // devices report both; passed through rather than faked so a caller can
      // tell "no position information" from "position 0".
      duration: s.attributes?.media_duration ?? null,
      position: s.attributes?.media_position ?? null,
      // HA reports position AS OF this stamp, not live - a Cast device updates
      // it on state changes, so "where is the film now" is position plus the
      // time since, while playing. The caller does that arithmetic.
      positionUpdatedAt: s.attributes?.media_position_updated_at ?? null,
      // Read HERE rather than remembered from the roster: the bitmask is
      // DYNAMIC on Cast devices (the warning on list() above), so whether this
      // television can be told to jump is a question about now, not about when
      // the cast started.
      supportedFeatures: Number(s.attributes?.supported_features || 0)
    }
  }

  // Tell the television to jump, in seconds from the start of what it is
  // playing. Only meaningful for a stream the TV seeks itself - a generated one
  // begins its own clock at zero and is re-cast instead.
  seek (entityId, positionSeconds) {
    return this._service('media_player', 'media_seek', {
      entity_id: entityId, seek_position: Math.max(0, Math.round(positionSeconds))
    })
  }

  _service (domain, service, data) {
    return this._call(`/api/services/${domain}/${service}`, { method: 'POST', body: data })
  }

  // TWO DIALECTS OF "PLAY THIS URL", measured on the living-room hardware
  // (2026-08-17). Google Cast takes media_content_type 'video'. A Roku takes
  // 'url' plus an extra.format hint, delivered through a channel that
  // supports the PlayOnRoku API - on Roku OS 11.5+ the built-in one is gone
  // (ECP answers 404 for input 15985), so the operator installs Media
  // Assistant (channel 782875) and points the HA Roku integration's "Play
  // Media Roku Application ID" option at it. A Roku on the HDMI port is the
  // whole TV story for a Samsung with no Cast built in, the proposal's
  // predicted case.
  //
  // The entity id names the family well enough to pick first; the other
  // dialect is retried once on refusal, so a Roku hiding behind a renamed
  // entity still plays - just one failed call later.
  async play (entityId, url, { title = null, format = 'mp4' } = {}) {
    const rokuShape = {
      entity_id: entityId,
      media_content_id: url,
      media_content_type: 'url',
      // The format hint is load-bearing on a Roku: 'mkv' for a direct
      // Matroska file, 'hls' for a converted stream, 'mp4' otherwise.
      extra: { format, ...(title ? { name: title } : {}) }
    }
    const castShape = {
      entity_id: entityId,
      media_content_id: url,
      media_content_type: 'video'
    }
    const looksRoku = /roku/i.test(entityId)
    const first = looksRoku ? rokuShape : castShape
    const second = looksRoku ? castShape : rokuShape
    try {
      return await this._service('media_player', 'play_media', first)
    } catch (e) {
      this.log('cast:play-shape-retry', { entityId, err: e?.message })
      return this._service('media_player', 'play_media', second)
    }
  }

  // STOP HAS TO WORK ON EVERY FAMILY, because revoke rides it. A Roku's media
  // player has NO media_stop in its feature set (measured: HA answers 500 and
  // the room plays out its buffer - the exact failure the donor's design
  // names), but the same integration ships a remote entity, and Home is how a
  // Roku's film ends. Pause is the last resort: a frozen frame is not dark,
  // but it is silent and it stops the bytes.
  async stop (entityId) {
    try {
      return await this._service('media_player', 'media_stop', { entity_id: entityId })
    } catch (e) {
      this.log('cast:stop-fallback', { entityId, err: e?.message })
      try {
        return await this._service('remote', 'send_command', {
          entity_id: String(entityId).replace(/^media_player\./, 'remote.'),
          command: 'home'
        })
      } catch (e2) {
        this.log('cast:stop-fallback-failed', { entityId, err: e2?.message })
        return this._service('media_player', 'media_pause', { entity_id: entityId })
      }
    }
  }

  pause (entityId) {
    return this._service('media_player', 'media_pause', { entity_id: entityId })
  }

  resume (entityId) {
    return this._service('media_player', 'media_play', { entity_id: entityId })
  }
}

module.exports = { Speakers, isLoopbackUrl, requireLoopback, canSeek, FEATURE_SEEK, DEFAULT_BASE_URL, CAST_CONFIG_FILE: FILE }
