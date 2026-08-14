// Artwork from the internet, opt in.
//
// The rules this panel wears on its face, because they ARE the feature:
//
//   - It is OFF until the operator turns it on, and the sentence about what
//     turning it on means - the host telling a third party which titles it is
//     identifying - is said plainly, above the switch, not in a tooltip.
//   - The key is the operator's own. The panel links to where one is made, takes
//     the paste, and TESTS it before anything is saved - a key that silently fails
//     is a library that quietly looks wrong.
//   - Only the uncertain matches ask for a click. The sure ones applied themselves;
//     what is listed here is the handful where a filename could honestly be more
//     than one thing, with the candidates to pick from.

import { useState, useEffect, useRef } from 'preact/hooks'
import { api } from './api'
import { notify } from './ui'

export default function Metadata () {
  const [meta, setMeta] = useState(null)
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(null)
  const timer = useRef(null)

  const reload = async () => {
    const m = await api('/api/metadata')
    if (!m?.error) setMeta(m)
    return m
  }

  // Poll only WHILE a pass runs, so the counter moves - and stop the moment it is
  // done, because an idle panel asking every two seconds is a scan of the store
  // for nothing.
  useEffect(() => {
    reload()
    return () => clearTimeout(timer.current)
  }, [])
  useEffect(() => {
    if (!meta?.running) return
    timer.current = setTimeout(reload, 2000)
    return () => clearTimeout(timer.current)
  }, [meta])

  if (!meta) return null

  // The wire is not trusted to be complete: a host one version behind answers this
  // route with less than the panel expects, and a missing list must degrade to an
  // empty one rather than taking the whole Settings screen down with it.
  const pending = meta.pending || []

  const test = async () => {
    setTesting(true)
    const t = await api('/api/metadata/test', { key })
    setTesting(false)
    setTested(t)
  }

  const save = async (enabled) => {
    const res = await api('/api/metadata', { ...(key ? { key } : {}), enabled })
    if (res?.error) return notify('Not saved', res.error)
    setKey(''); setTested(null)
    await reload()
    if (enabled) notify('Fetching artwork', 'The sure matches apply themselves; anything uncertain will wait for you below.')
  }

  const confirm = async (itemId, tmdbId) => {
    await api('/api/metadata/confirm', { itemId, tmdbId })
    reload()
  }
  const dismiss = async (itemId) => {
    await api('/api/metadata/dismiss', { itemId })
    reload()
  }

  return (
    <div class='card'>
      <h3>Artwork from the internet</h3>
      <p class='hint'>
        Most files carry no artwork of their own. With this on, the host asks TMDB - a
        third-party film database - for posters, which means <b>this host tells TMDB the
        titles it is identifying</b>. Nothing else is sent, nothing is written into your
        library, and artwork found beside your files always wins. Off by default.
      </p>

      {!meta.hasKey && (
        <p class='hint'>
          It needs your own free TMDB key: create one at{' '}
          <a href='https://www.themoviedb.org/settings/api' target='_blank' rel='noreferrer'>themoviedb.org/settings/api</a>{' '}
          and paste it here.
        </p>
      )}

      <div class='row'>
        <input
          type='password'
          placeholder={meta.hasKey ? 'A key is saved - paste to replace it' : 'Paste your TMDB key'}
          value={key}
          onInput={e => { setKey(e.currentTarget.value); setTested(null) }}
        />
        <button class='ghost' disabled={!key || testing} onClick={test}>{testing ? 'Testing…' : 'Test'}</button>
      </div>
      {tested && (
        <p class={'hint'} style={tested.ok ? 'color:var(--ok)' : 'color:var(--danger)'}>
          {tested.ok ? 'TMDB accepted the key.' : tested.error}
        </p>
      )}

      <div class='row' style='margin-top:.5rem'>
        {!meta.enabled && (
          <button disabled={!meta.hasKey && !(key && tested?.ok)} onClick={() => save(true)}>
            Turn on and fetch artwork
          </button>
        )}
        {meta.enabled && <button class='ghost' onClick={() => save(false)}>Turn it off</button>}
        {meta.enabled && !meta.running && (
          <button class='ghost' onClick={async () => { await api('/api/metadata/run', { retryMissed: true }); reload() }}>
            Look again
          </button>
        )}
        {key && (
          <button class='ghost' disabled={!tested?.ok} onClick={() => save(meta.enabled)}>Save key</button>
        )}
      </div>

      {meta.running && (
        <p class='hint'>Looking up {meta.running.done} of {meta.running.total}…</p>
      )}
      {!meta.running && meta.lastRun && (
        <p class='hint'>
          Last pass: {meta.lastRun.looked} looked up, {meta.matched} with artwork,{' '}
          {pending.length} waiting for you, {meta.missed} not found.
        </p>
      )}

      {pending.length > 0 && (
        <>
          <h3 style='margin-top:1rem'>Which one is it?</h3>
          <p class='hint'>
            These names could honestly be more than one thing, and a wrong poster is
            worse than none - so nobody guessed. Pick, or dismiss.
          </p>
          {pending.slice(0, 20).map(p => (
            <div class='field' key={p.id}>
              <label>{p.title}{p.year ? ` (${p.year})` : ''}</label>
              <div class='row' style='flex-wrap:wrap;gap:.35rem'>
                {p.candidates.map(c => (
                  <button class='ghost' key={c.tmdbId} title={c.overview} onClick={() => confirm(p.id, c.tmdbId)}>
                    {c.title}{c.year ? ` (${c.year})` : ''}
                  </button>
                ))}
                <button class='ghost' onClick={() => dismiss(p.id)}>None of these</button>
              </div>
            </div>
          ))}
          {pending.length > 20 && <p class='hint'>…and {pending.length - 20} more after these.</p>}
        </>
      )}
    </div>
  )
}
