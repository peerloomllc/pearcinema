// The player.
//
// A plain <video> pointed at /api/stream, and almost all of the thinking here is
// about the files it CANNOT open rather than the ones it can.
//
// THE STREAM PATH IS NOT NEW CODE. /api/stream is HTTP over host.openStream, which
// is the same call the phone's `media.stream` makes - so the byte-range arithmetic
// that makes seeking work exists once. A second streaming implementation for the
// browser would be a second place for a range bug and a second place to forget that
// an id must never be treated as a path.
//
// WHY IT REFUSES SO MUCH, AND WHY THAT IS THE HONEST ANSWER. 83% of the measured
// real library is Matroska, and Chrome and Safari will not open Matroska - the same
// refusal, for the same reason, that an iPhone gives. So this player shows roughly a
// tenth of a real collection. That is not a defect in this screen; it is the
// clearest available demonstration of why remux is the next thing to build. The one
// thing this screen must never do is fail silently, because a black rectangle sends
// somebody to their router settings.
//
// PLAY ANYWAY IS ALWAYS OFFERED. The verdict comes from canPlayType, which answers
// about a codec family rather than a file, so it can be wrong in both directions. A
// wrong refusal should cost one click.

import { useState, useEffect, useRef } from 'preact/hooks'
import { api, fmtRuntime, fmtSize, fmtClock, episodeCode } from './api'
import { verdictFor, containerName } from './playback'

export default function Player ({ item, caps, queue = [], onPlay, onClose }) {
  const [forced, setForced] = useState(false)
  const [subs, setSubs] = useState([])
  const [failed, setFailed] = useState(null)
  const [at, setAt] = useState(0)
  const video = useRef(null)

  const verdict = verdictFor(item, caps)
  const blocked = verdict.status === 'refuse' && !forced

  useEffect(() => {
    setForced(false); setFailed(null); setAt(0); setSubs([])
    let live = true
    api('/api/subtitles?itemId=' + encodeURIComponent(item.id)).then(res => {
      if (live) setSubs(res.items || [])
    })
    return () => { live = false }
  }, [item.id])

  const idx = queue.findIndex(q => q.id === item.id)
  const next = idx >= 0 && idx + 1 < queue.length ? queue[idx + 1] : null
  const prev = idx > 0 ? queue[idx - 1] : null

  const m = item.media || {}
  const code = episodeCode(item)
  const heading = item.type === 'episode'
    ? [item.seriesTitle, code].filter(Boolean).join(' · ')
    : (item.year ? String(item.year) : '')

  // Text tracks the browser can actually render. The image-based ones are listed
  // below, unplayable and with the reason, rather than hidden - on the measured
  // Movies collection that refusal is the COMMON case (roughly one PGS track per
  // film), and hiding it would leave somebody hunting for subtitles the file
  // demonstrably contains. External .srt comes first for the same reason.
  // EXTERNAL FIRST, and that ordering is a measurement rather than a preference:
  // the real Movies collection carries 232 embedded PGS tracks against 383 `.srt`
  // files on disk. Lead with the embedded one and most films look like they have
  // subtitles that do not work.
  const playableSubs = subs.filter(s => s.playable).sort((a, b) => (b.external ? 1 : 0) - (a.external ? 1 : 0))
  const unplayableSubs = subs.filter(s => !s.playable)

  return (
    <div class='playerwrap'>
      <div>
        <div class='stage'>
          {blocked
            ? (
              <div class='refusal'>
                <div style='font-size:2rem'>🚫</div>
                <h3>This one will not play in a browser</h3>
                <p>{verdict.reason}</p>
                <button class='ghost' onClick={() => { setFailed(null); setForced(true) }}>Play anyway</button>
              </div>
              )
            : (
              <video
                ref={video}
                controls
                autoplay
                playsinline
                src={'/api/stream?id=' + encodeURIComponent(item.id)}
                crossorigin='use-credentials'
                onTimeUpdate={e => setAt(e.currentTarget.currentTime)}
                onError={() => setFailed(
                  'The browser stopped without saying why. That is almost always the container or the codec - ' +
                  'the file itself is fine, and it will play on a phone.'
                )}
              >
                {playableSubs.map(s => (
                  <track
                    key={s.id}
                    kind='subtitles'
                    label={s.title || s.language || 'Subtitles'}
                    srclang={s.language || undefined}
                    src={'/api/subtitle?itemId=' + encodeURIComponent(item.id) + '&subtitleId=' + encodeURIComponent(s.id)}
                  />
                ))}
              </video>
              )}
        </div>

        {failed && <div class='banner bad' style='margin-top:.7rem'>{failed}</div>}
        {!blocked && verdict.status === 'nosound' && (
          <div class='banner warn' style='margin-top:.7rem'>{verdict.reason}</div>
        )}
        {!blocked && verdict.status === 'unknown' && (
          <div class='banner' style='margin-top:.7rem'>{verdict.reason}</div>
        )}

        <div class='row' style='margin-top:.8rem'>
          <button class='ghost' disabled={!prev} onClick={() => prev && onPlay(prev)}>Previous</button>
          <button class='ghost' disabled={!next} onClick={() => next && onPlay(next)}>Next episode</button>
          <div class='spacer' />
          {!blocked && <span class='hint'>{fmtClock(at)}</span>}
          <button class='ghost' onClick={onClose}>Back to the library</button>
        </div>
      </div>

      <div>
        <h2>{item.title}</h2>
        {heading && <p class='hint' style='margin-top:0'>{heading}</p>}

        {item.overview && <p style='font-size:.9rem'>{item.overview}</p>}

        <dl class='meta'>
          {item.runtime ? <><dt>Length</dt><dd>{fmtRuntime(item.runtime)}</dd></> : null}
          <dt>File</dt>
          <dd>
            {[containerName(m.container), m.videoCodec && m.videoCodec.toUpperCase(), m.audioCodec && m.audioCodec.toUpperCase()]
              .filter(Boolean).join(' · ') || 'not reported'}
            {m.size ? <span class='hint'> · {fmtSize(m.size)}</span> : null}
          </dd>
          <dt>In this browser</dt>
          <dd>
            {verdict.status === 'play' && <span class='chip good'>plays</span>}
            {verdict.status === 'nosound' && <span class='chip warn'>picture only</span>}
            {verdict.status === 'refuse' && <span class='chip bad'>will not open</span>}
            {verdict.status === 'unknown' && <span class='chip'>unknown</span>}
          </dd>
        </dl>

        {(playableSubs.length > 0 || unplayableSubs.length > 0) && (
          <>
            <h3>Subtitles</h3>
            <div class='tracklist'>
              {playableSubs.map(s => (
                <div class='sub' key={s.id}>
                  <span>{s.title || s.language || 'Subtitles'}{s.external ? ' (file)' : ''}</span>
                  <span class='chip good'>on the player</span>
                </div>
              ))}
              {unplayableSubs.map(s => (
                <div class='sub off' key={s.id} title={s.reason || ''}>
                  <span>{s.title || s.language || 'Subtitles'}</span>
                  <span class='chip bad'>not available</span>
                </div>
              ))}
            </div>
            {unplayableSubs.length > 0 && (
              <p class='hint'>{unplayableSubs[0].reason}</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
