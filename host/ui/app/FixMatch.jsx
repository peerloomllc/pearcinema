// FIX THE MATCH: the same choice offered from two places.
//
// It began on the tile wearing the wrong poster, which is where a wrong match is
// visible. It is also what a title that found NOTHING needs - and that list lives in
// Settings, on the Library page - so the dialog is a module of its own now rather than
// a private part of the library grid.
//
// TWO SHAPES, and the difference is not cosmetic. `FixMatch` is the dialog: it wears
// its own window, which is right when it opens from a tile. `FixMatchBody` is the same
// thing with no window at all, for when it is a STEP INSIDE a window that is already
// open - a pop-up on top of a pop-up is the thing to avoid (Tim, 2026-08-19).
//
// The dialog reruns the lookup - with the operator's own words if they retype the
// title, which is usually the whole problem, since a filename is not always what a
// film is called - and applies the pick, or drops the fetched artwork entirely. The
// host fetches the chosen poster fresh by TMDB id; nothing from this page is trusted
// beyond the id itself.

import { useState, useEffect } from 'preact/hooks'
import { api } from './api'
import { Modal } from './ui'
import { ArtIcon } from './icons'

export function FixMatchBody ({ item, onFixed, onDone }) {
  const [q, setQ] = useState(item.title || '')
  const [cands, setCands] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const search = async (query = null) => {
    setBusy(true); setErr('')
    const r = await api('/api/metadata/search', { itemId: item.id, ...(query ? { q: query } : {}) })
    setBusy(false)
    if (r?.error) return setErr(r.error)
    setCands(r.candidates || [])
  }
  useEffect(() => { setCands(null); setQ(item.title || ''); search() }, [item.id])

  // What changed, handed back for an IN-PLACE patch of the tile: the new artId
  // (deterministic - the poster route is keyed by item), and a cache-buster,
  // because the URL does not change when the poster behind it does.
  const use = async (c) => {
    setBusy(true)
    const r = await api('/api/metadata/fix', { itemId: item.id, tmdbId: c.tmdbId, type: item.type })
    setBusy(false)
    if (r?.error) return setErr(r.error)
    onFixed?.({ artId: 'tmdb:' + item.id, artBust: Date.now() })
    onDone?.()
  }

  const drop = async () => {
    await api('/api/metadata/unmatch', { itemId: item.id })
    onFixed?.({ artId: null })
    onDone?.()
  }

  return (
    <div class='fixbody'>
      <p class='hint'>
        Pick the right one and its poster replaces the guess. If the name on the file is
        not what the {item.type === 'series' ? 'show' : 'film'} is really called, search
        by the real name.
      </p>
      <div class='row fixsearch'>
        <input
          type='text'
          value={q}
          aria-label='Search TMDB'
          onInput={e => setQ(e.currentTarget.value)}
          onKeyDown={e => { if (e.key === 'Enter') search(q) }}
        />
        <button class='ghost' disabled={busy || !q.trim()} onClick={() => search(q)}>Search</button>
      </div>
      {err && <div class='banner bad'>{err}</div>}
      {busy && !cands && <p class='hint'>Asking TMDB…</p>}
      {cands && !cands.length && <p class='hint'>TMDB found nothing by that name.</p>}
      {/* PICKED BY EYE (Tim, 2026-08-14). The poster is the thing being chosen, so
          the poster is what the choice shows - a text list asked somebody to
          recognise a film by its year. Thumbnails come THROUGH THE HOST, because
          the promise on the panel is that the host talks to TMDB, not the browser. */}
      <div class='candgrid'>
        {(cands || []).map(c => (
          <button class='cand' key={c.tmdbId} disabled={busy} title={c.overview} onClick={() => use(c)}>
            {c.poster
              ? <img src={'/api/metadata/preview?p=' + encodeURIComponent(c.poster)} alt='' loading='lazy' />
              : <span class='noart'><ArtIcon type={item.type} size={26} /></span>}
            <span class='t'>{c.title}</span>
            {c.year && <span class='s'>{c.year}</span>}
          </button>
        ))}
      </div>
      {String(item.artId || '').startsWith('tmdb:') && (
        <button class='ghost' style='margin-top:.8rem' disabled={busy} onClick={drop}>
          None of these - remove the fetched artwork
        </button>
      )}
    </div>
  )
}

export function FixMatch ({ item, onClose, onFixed }) {
  return (
    <Modal title={'Fix the match: ' + item.title} onClose={onClose} wide>
      <FixMatchBody item={item} onFixed={onFixed} onDone={onClose} />
    </Modal>
  )
}
