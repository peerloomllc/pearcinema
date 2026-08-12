// Jellyfin / Emby source adapter, for video.
//
// The fast path to first playback, and deliberately not the product. Jellyfin has
// already scanned, matched, fetched artwork and built the series/season/episode
// tree, so this file is mostly mapping - which is why it comes first. The FOLDER
// adapter is the moat: reading only Jellyfin makes PearCinema an accessory to a
// project that can add its own remote access whenever it likes.
//
// It covers EMBY as well as Jellyfin. Jellyfin forked Emby ~2018, so the endpoints
// are the same; only the auth header naming drifted, and _authHeaders() sends both
// flavours so one code path serves both. The server names itself via ProductName
// ("Jellyfin Server" vs nothing at all on Emby).
//
// AUTH: username and password, exchanged ONCE for an access token that does not
// expire until it is revoked. No cloud, no refresh loop, no third party - exactly
// the sentence that could not be written about Plex.
//
// The token is held in memory only. The PASSWORD is what gets persisted, because a
// token we cached and could not refresh would strand the library on the first
// restart after the operator logged us out somewhere else.
//
// WHAT IS DIFFERENT FROM THE DONOR, beyond `Audio` becoming `Movie,Episode`:
//
//   - Two root shapes. A music library is one tree; this is a flat film list AND a
//     three-level show tree, side by side.
//   - Codec facts are carried, because v1 is direct-play only and learning which
//     files a real phone can open IS the point of v1.
//   - Subtitles exist at all, and image-based ones are listed-and-refused rather
//     than hidden.
//   - /Videos/{id}/stream instead of /Audio/{id}/universal.

const crypto = require('crypto')
const items = require('../items')

const CLIENT = 'PearCinema'
const VERSION = '0.1.0'

// Jellyfin's clock is 100-nanosecond ticks (a .NET TimeSpan). A 90-minute film is
// 54,000,000,000 of them. Divide by 10,000,000 for seconds - and SECONDS is the
// unit throughout PearCinema, so a runtime and a resume position never disagree.
const TICKS_PER_SECOND = 10_000_000

// The fields Jellyfin will not send unless asked. `MediaSources` is the
// load-bearing one twice over: it carries the file SIZE, which the phone's loopback
// shim needs as a content-length before a player will let anyone seek, and it
// carries MediaStreams, which is where the container and codec facts live.
const LEAF_FIELDS = 'MediaSources,MediaStreams,ParentId,ProductionYear,Path,DateCreated,Overview,Genres'
const CONTAINER_FIELDS = 'ProductionYear,ChildCount,RecursiveItemCount,ParentId,DateCreated,Overview,Genres'

// Canonical sort key -> Jellyfin SortBy. Every key tie-breaks toward SortName, so a
// year-sorted list is still stable and alphabetical within equal values.
const SORT_BY = {
  title: 'SortName',
  year: 'ProductionYear,PremiereDate,SortName',
  added: 'DateCreated,SortName',
  // Structural orders. Jellyfin indexes a season by IndexNumber and an episode by
  // ParentIndexNumber (its season) then IndexNumber (its slot).
  season: 'IndexNumber,SortName',
  episode: 'ParentIndexNumber,IndexNumber,SortName'
}
const sortOrder = (order) => (order === 'desc' ? 'Descending' : 'Ascending')

// Subtitle codecs we can hand a phone as TEXT. Everything else on a real library is
// image-based, and burning an image track into the picture means a full transcode,
// which v1 does not have.
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'text'])
const IMAGE_SUBTITLE_CODECS = new Set(['pgssub', 'pgs', 'dvdsub', 'dvd_subtitle', 'dvbsub', 'dvb_subtitle', 'xsub'])

class JellyfinAdapter {
  // `ids` is the protocol's id factory (protocol.ids). Passed in rather than
  // imported, so the adapter cannot accidentally mint ids in another app's
  // namespace.
  //
  // `fetchImpl` exists so the tests can drive this against recorded Jellyfin
  // responses instead of a live server. Nothing else should pass it.
  constructor ({ url, username, password, libraryId, ids, log = () => {}, fetchImpl = null }) {
    if (!ids) throw new Error('JellyfinAdapter needs the protocol id factory')

    this.base = String(url || '').replace(/\/+$/, '')
    this.username = username
    this.password = password
    this.libraryId = libraryId
    this.ids = ids
    this.kind = 'jellyfin'
    this.log = log
    this._fetch = fetchImpl || ((...a) => fetch(...a))

    this.token = null
    this.userId = null
    this.scannedAt = null
    this._counts = { movies: 0, series: 0, seasons: 0, episodes: 0 }
    this._serverName = null

    // A STABLE device id. Jellyfin lists every device that has ever authenticated in
    // its dashboard, and a fresh uuid per connection would fill that list with
    // hundreds of ghost PearCinemas. Derived from the library, so it survives a
    // restart and stays unique between two hosts pointed at one Jellyfin.
    this.deviceId = 'pearcinema-' + crypto.createHash('sha256')
      .update(String(libraryId || 'pearcinema'))
      .digest('hex')
      .slice(0, 16)

    // Our id -> Jellyfin's item id. Populated as we list and search; an item we have
    // never seen is looked up on demand (see _remoteId).
    this.remoteIds = new Map()
    this._authing = null
  }

  // --- transport ------------------------------------------------------------

  _identity () {
    return [
      `Client="${CLIENT}"`,
      'Device="PearCinema host"',
      `DeviceId="${this.deviceId}"`,
      `Version="${VERSION}"`
    ]
  }

  // ONE adapter, TWO servers. Jellyfin reads the client identity AND the token from
  // `Authorization: MediaBrowser ...`; Emby reads the identity from
  // `X-Emby-Authorization` and the token from a separate `X-Emby-Token`. Rather than
  // sniff the server and branch, send BOTH on every request - each reads the header
  // it knows and ignores the other.
  _authHeaders () {
    const parts = this._identity()
    const h = {
      authorization: 'MediaBrowser ' + (this.token ? [...parts, `Token="${this.token}"`] : parts).join(', '),
      'x-emby-authorization': 'MediaBrowser ' + parts.join(', ')
    }
    if (this.token) h['x-emby-token'] = this.token
    return h
  }

  // One login, shared. A cold host answering a screen's worth of poster requests
  // would otherwise fire twenty simultaneous logins and get twenty sessions back.
  async _auth () {
    if (this.token) return this.token
    if (this._authing) return this._authing

    this._authing = (async () => {
      const res = await this._fetch(`${this.base}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this._authHeaders() },
        body: JSON.stringify({ Username: this.username, Pw: this.password })
      })

      if (res.status === 401) throw new Error('jellyfin: wrong username or password')
      if (!res.ok) throw new Error(`jellyfin: login failed (HTTP ${res.status})`)

      const body = await res.json()
      if (!body.AccessToken || !body.User?.Id) throw new Error('jellyfin: login returned no token')

      this.token = body.AccessToken
      this.userId = body.User.Id
      this.log('jellyfin:authenticated', { user: body.User.Name })
      return this.token
    })().finally(() => { this._authing = null })

    return this._authing
  }

  _url (route, params = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    return `${this.base}${route}${qs ? '?' + qs : ''}`
  }

  async _call (route, params) {
    await this._auth()
    const opts = { headers: { ...this._authHeaders(), accept: 'application/json' } }
    const res = await this._fetch(this._url(route, params), opts)

    // The token was revoked (the operator logged this device out in Jellyfin's own
    // dashboard). We hold the password, so we can simply log in again - ONCE. A retry
    // loop here would hammer a server that is telling us to go away.
    if (res.status === 401) {
      this.token = null
      await this._auth()
      const again = await this._fetch(this._url(route, params), {
        headers: { ...this._authHeaders(), accept: 'application/json' }
      })
      if (!again.ok) throw new Error(`jellyfin ${route}: HTTP ${again.status}`)
      return again.json()
    }

    if (!res.ok) throw new Error(`jellyfin ${route}: HTTP ${res.status}`)
    return res.json()
  }

  // --- mapping --------------------------------------------------------------

  _ourId (remoteId) {
    const id = this.ids.itemId(this.libraryId, this.kind, remoteId)
    this.remoteIds.set(id, remoteId)
    return id
  }

  // Container, codecs and dimensions off the first media source. THE POINT OF V1:
  // this is the data that tells us which real files a real phone can actually open,
  // and it is why direct-play-only ships first rather than a transcode pipeline
  // built against a guess.
  _media (item) {
    const src = item.MediaSources?.[0] || {}
    const streams = src.MediaStreams || item.MediaStreams || []
    const video = streams.find(s => s.Type === 'Video') || {}
    const audio = streams.find(s => s.Type === 'Audio') || {}

    return items.media({
      container: src.Container || item.Container || null,
      videoCodec: video.Codec || null,
      audioCodec: audio.Codec || null,
      width: video.Width || null,
      height: video.Height || null,
      size: src.Size || null
    })
  }

  _seconds (ticks) {
    return ticks ? Math.round(ticks / TICKS_PER_SECOND) : null
  }

  _artId (item) {
    // Jellyfin serves artwork off the item's own id. A row with no ImageTags has no
    // poster, and the app draws its own placeholder rather than fetching a 404.
    return item.ImageTags?.Primary ? item.Id : null
  }

  _movie (item) {
    return items.movie({
      id: this._ourId(item.Id),
      title: item.Name,
      year: item.ProductionYear,
      runtime: this._seconds(item.RunTimeTicks),
      overview: item.Overview,
      genres: item.Genres,
      artId: this._artId(item),
      media: this._media(item)
    })
  }

  _series (item) {
    return items.series({
      id: this._ourId(item.Id),
      title: item.Name,
      year: item.ProductionYear,
      overview: item.Overview,
      genres: item.Genres,
      artId: this._artId(item),
      // ChildCount on a Series is its seasons; RecursiveItemCount is its episodes.
      seasonCount: item.ChildCount,
      episodeCount: item.RecursiveItemCount
    })
  }

  _season (item) {
    return items.season({
      id: this._ourId(item.Id),
      seriesId: item.SeriesId ? this._ourId(item.SeriesId) : '',
      seriesTitle: item.SeriesName,
      // On a Season, IndexNumber IS the season number. Season 0 is Specials, and
      // `?? null` rather than `|| null` is load-bearing: `0 || null` is null, which
      // would file every special under "no season" and drop them out of the tree.
      number: item.IndexNumber ?? null,
      title: item.Name,
      artId: this._artId(item),
      episodeCount: item.ChildCount
    })
  }

  _episode (item) {
    return items.episode({
      id: this._ourId(item.Id),
      seriesId: item.SeriesId ? this._ourId(item.SeriesId) : '',
      seasonId: item.SeasonId ? this._ourId(item.SeasonId) : '',
      seriesTitle: item.SeriesName,
      // ParentIndexNumber is the SEASON, IndexNumber is the slot within it. Same
      // `?? null` reasoning as above.
      seasonNumber: item.ParentIndexNumber ?? null,
      episodeNumber: item.IndexNumber ?? null,
      title: item.Name,
      year: item.ProductionYear,
      runtime: this._seconds(item.RunTimeTicks),
      overview: item.Overview,
      genres: item.Genres,
      artId: this._artId(item),
      media: this._media(item)
    })
  }

  // Jellyfin's Type -> ours. Anything else in a mixed library (a music album, a
  // photo, a book) is not ours and is dropped rather than mapped into a wrong shape.
  _map (item) {
    switch (item.Type) {
      case 'Movie': return this._movie(item)
      case 'Series': return this._series(item)
      case 'Season': return this._season(item)
      case 'Episode': return this._episode(item)
      default: return null
    }
  }

  // --- the interface --------------------------------------------------------

  async ping () {
    await this._auth()
    return { ok: true, detail: this._serverName || 'jellyfin' }
  }

  async scan () {
    // Jellyfin already scanned. We confirm we can talk to it and cache the counts -
    // failing loudly HERE, at boot or at Save, rather than on a user's first tap.
    await this._auth()

    // The server NAMES ITSELF via System/Info/Public (no auth needed). Jellyfin
    // returns ProductName "Jellyfin Server"; Emby, measured against a real 4.9 box,
    // returns none at all. For this kind, which is only ever one of the two, a
    // reachable server with no ProductName is Emby. That is the only signal we get.
    const info = await this._fetch(`${this.base}/System/Info/Public`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
    this._serverName = info ? (info.ProductName || 'Emby') : null

    const countOf = async (type) => {
      const body = await this._call('/Items', {
        userId: this.userId,
        IncludeItemTypes: type,
        Recursive: true,
        Limit: 0 // the count, not the library
      }).catch(() => null)
      return body?.TotalRecordCount ?? 0
    }

    this._counts = {
      movies: await countOf('Movie'),
      series: await countOf('Series'),
      seasons: await countOf('Season'),
      episodes: await countOf('Episode')
    }

    this.scannedAt = Date.now()
    // LEAVES, which is what "how big is this library" means to someone browsing it.
    // A season is not a thing you watch.
    return this._counts.movies + this._counts.episodes
  }

  async stats () {
    return {
      ...this._counts,
      source: this.kind,
      sourceName: this._serverName || 'Jellyfin',
      root: this.base,
      scannedAt: this.scannedAt
    }
  }

  async list ({ type = 'movies', seriesId = null, seasonId = null, limit = 100, cursor = 0, sort, order } = {}) {
    const offset = Math.max(0, Number(cursor) || 0)
    const size = Math.min(items.PAGE_MAX, Math.max(1, Number(limit) || items.PAGE_DEFAULT))

    const JELLY_TYPE = { movies: 'Movie', series: 'Series', seasons: 'Season', episodes: 'Episode' }
    const jellyType = JELLY_TYPE[type]
    if (!jellyType) return items.page([], {})

    // Scoped lists ask Jellyfin for the CHILDREN of a parent, which is both cheaper
    // and correct: a season's episodes are whatever Jellyfin says they are, not
    // whatever a client-side filter finds.
    const parent = seasonId || seriesId
    const params = {
      userId: this.userId,
      IncludeItemTypes: jellyType,
      Recursive: true,
      SortBy: SORT_BY[sort] || SORT_BY[items.DEFAULT_SORT[type]] || 'SortName',
      SortOrder: sortOrder(order),
      Fields: (type === 'movies' || type === 'episodes') ? LEAF_FIELDS : CONTAINER_FIELDS,
      StartIndex: offset,
      Limit: size
    }
    if (parent) {
      const remote = await this._remoteId(parent)
      // A parent we cannot resolve is an empty list, not the whole library. Falling
      // back to unscoped here would answer "this season's episodes" with every
      // episode on the server.
      if (!remote) return items.page([], {})
      params.ParentId = remote
    }

    const body = await this._call('/Items', params)
    const mapped = (body.Items || []).map(i => this._map(i)).filter(Boolean)
    const total = body.TotalRecordCount ?? mapped.length
    const next = offset + mapped.length

    return {
      items: mapped,
      total,
      cursor: next < total ? next : null
    }
  }

  async get ({ id, type = null } = {}) {
    const remote = await this._remoteId(id)
    if (!remote) return null

    const body = await this._call(`/Users/${this.userId}/Items/${remote}`, {
      Fields: LEAF_FIELDS
    }).catch(() => null)
    if (!body) return null

    const mapped = this._map(body)
    // A type the caller asked for and did not get is a miss, not a surprise object.
    if (mapped && type && mapped.type !== type) return null
    return mapped
  }

  async search ({ q = '', limit = 50 } = {}) {
    if (!q) return { items: [] }

    // ONE call for every kind. /Search/Hints is the other option and it is worse for
    // us: it answers a flattened "hint" shape with no MediaSources, so every film it
    // returned would need a second fetch before it could be played.
    const body = await this._call('/Items', {
      userId: this.userId,
      searchTerm: q,
      IncludeItemTypes: 'Movie,Series,Episode',
      Recursive: true,
      Fields: LEAF_FIELDS,
      Limit: Math.min(items.PAGE_MAX, Number(limit) * 3 || 150)
    })

    const mapped = (body.Items || []).map(i => this._map(i)).filter(Boolean)
    return { items: mapped.slice(0, Math.max(1, Number(limit) || 50)) }
  }

  async art ({ artId, size } = {}) {
    if (!artId) return null
    await this._auth()

    // maxWidth, not fillWidth: fill CROPS to the box, and cropping a film poster to
    // a square tile is a thing to do to a photo, not to a poster.
    const url = this._url(`/Items/${artId}/Images/Primary`, {
      maxWidth: size || undefined,
      quality: 90
    })

    const res = await this._fetch(url, { headers: this._authHeaders() })
    // 404 is the normal answer for an item with no artwork. Not an error - the app
    // draws its own placeholder.
    if (!res.ok) return null
    return res.body
  }

  // --- subtitles ------------------------------------------------------------
  //
  // v1 LISTS WHAT IT CANNOT SERVE rather than hiding it. External .srt and embedded
  // TEXT tracks are cheap. Embedded PGS is image-based, and burning it into the
  // picture means a full transcode, which v1 does not have. Hiding those tracks
  // would leave someone hunting for subtitles the file demonstrably contains.

  async subtitles ({ itemId } = {}) {
    const remote = await this._remoteId(itemId)
    if (!remote) return []

    const body = await this._call(`/Users/${this.userId}/Items/${remote}`, {
      Fields: LEAF_FIELDS
    }).catch(() => null)
    if (!body) return []

    const src = body.MediaSources?.[0] || {}
    const streams = src.MediaStreams || body.MediaStreams || []

    return streams
      .filter(s => s.Type === 'Subtitle')
      .map(s => {
        const codec = String(s.Codec || '').toLowerCase()
        const image = IMAGE_SUBTITLE_CODECS.has(codec)
        const text = s.IsExternal || TEXT_SUBTITLE_CODECS.has(codec)
        return {
          id: `${src.Id || remote}:${s.Index}`,
          language: s.Language || null,
          title: s.DisplayTitle || s.Title || s.Language || 'Subtitle',
          codec,
          external: !!s.IsExternal,
          forced: !!s.IsForced,
          playable: text && !image,
          // Said plainly, because "this subtitle track exists but will not appear" is
          // the kind of thing a user otherwise spends an evening on.
          reason: image
            ? 'image-based subtitles need the video re-encoded to burn them in, which this version does not do'
            : text ? null : `unsupported subtitle format: ${codec || 'unknown'}`
        }
      })
  }

  async subtitle ({ itemId, subtitleId } = {}) {
    const remote = await this._remoteId(itemId)
    if (!remote) return null

    const [sourceId, index] = String(subtitleId).split(':')
    if (!sourceId || index === undefined) return null

    await this._auth()
    // Jellyfin converts a text track to SRT for us. An image track answers an error
    // here, which is why subtitles() marks those unplayable before anyone asks.
    const url = this._url(`/Videos/${remote}/${sourceId}/Subtitles/${index}/Stream.srt`, {})
    const res = await this._fetch(url, { headers: this._authHeaders() })
    if (!res.ok) return null
    return res.body
  }

  // --- streaming ------------------------------------------------------------

  // Range support: for DIRECT PLAY the HTTP Range passes straight through, so
  // seeking inside a two-hour film works exactly as it does with a local file.
  //
  // `static=true` IS THE WHOLE BALLGAME. Without it Jellyfin decides for itself
  // whether to transcode, and the moment it does the bytes stop being the original
  // file - which means there are no stable byte offsets to seek to, because those
  // bytes do not exist until Jellyfin makes them. v1 is direct play only, so we ask
  // for the file and nothing else.
  async stream ({ itemId, offset = 0, length } = {}) {
    const remote = await this._remoteId(itemId)
    if (!remote) return null

    const url = this._url(`/Videos/${remote}/stream`, { static: true })

    const headers = this._authHeaders()
    if (offset > 0 || length) {
      const end = length ? offset + Number(length) - 1 : ''
      headers.range = `bytes=${offset}-${end}`
    }

    const res = await this._fetch(url, { headers })
    if (!res.ok && res.status !== 206) return null
    return res.body
  }

  // --- id resolution --------------------------------------------------------

  // Our ids are hashes, so they cannot be reversed - they can only be recomputed
  // forward. The cache fills as we list and search, which covers everything a user
  // browsed to. It does NOT cover a cold host answering a phone that resumed a film
  // from a paused queue, so walk the leaves once to rebuild it.
  //
  // Slow exactly once per item, and never again. Cheaper here than in the donor: a
  // film library is thousands of leaves where a music library is tens of thousands.
  async _remoteId (ourId) {
    if (!ourId) return null
    const known = this.remoteIds.get(ourId)
    if (known) return known

    // Containers first - a series or season lookup is far more likely to be a browse
    // than a resume, and there are few of them.
    for (const type of ['Movie,Episode', 'Series,Season']) {
      let offset = 0
      for (;;) {
        const body = await this._call('/Items', {
          userId: this.userId,
          IncludeItemTypes: type,
          Recursive: true,
          SortBy: 'SortName',
          StartIndex: offset,
          Limit: 500
        }).catch(() => null)

        const list = body?.Items || []
        if (!list.length) break

        for (const item of list) {
          if (this._ourId(item.Id) === ourId) return item.Id
        }

        offset += list.length
        if (offset >= (body.TotalRecordCount ?? 0)) break
      }
    }

    return null
  }
}

module.exports = { JellyfinAdapter, TEXT_SUBTITLE_CODECS, IMAGE_SUBTITLE_CODECS }
