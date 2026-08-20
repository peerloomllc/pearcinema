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
// film is called - and applies the pick, or forgets the match entirely. The host
// fetches the chosen poster fresh by TMDB id; nothing from this page is trusted
// beyond the id itself.
//
// WHAT IT FIXES IS THE MATCH, not only the picture (Tim, 2026-08-20). A film with a
// poster.jpg beside it on disk keeps that poster - artwork somebody put there is
// not this feature's to change - but it can still be matched to the wrong TMDB
// entry, and then its summary and its year are about a different film. That is the
// case this dialog now covers, and it says which half it is changing.

import { useState, useEffect } from 'preact/hooks'
import { api } from './api'
import { Modal } from './ui'
import { ArtIcon } from './icons'

// `targetId` is the id THIS box knows the title by, which is not always the id on
// the tile: All libraries shows a merged row wearing the primary copy's id, and
// that copy can live on a friend's machine. The metadata routes are about this
// library only, so they are always asked about the local copy.
export function FixMatchBody ({ item, targetId = null, onFixed, onDone }) {
  const id = targetId || item.id
  const [q, setQ] = useState(item.title || '')
  const [cands, setCands] = useState(null)
  const [matched, setMatched] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // A PICTURE BESIDE THE FILE ALWAYS WINS, and that used to be expressed by hiding
  // this dialog altogether - which also removed the only way to correct a wrong
  // MATCH, and a wrong match is a wrong summary and a wrong year however good the
  // picture is (Tim, 2026-08-20: "I can edit Annihilation but not 300"). So the
  // rule is said out loud instead.
  const diskArt = !!item.artId && !String(item.artId).startsWith('tmdb:')

  const search = async (query = null) => {
    setBusy(true); setErr('')
    const r = await api('/api/metadata/search', { itemId: id, ...(query ? { q: query } : {}) })
    setBusy(false)
    if (r?.error) return setErr(r.error)
    setCands(r.candidates || [])
    setMatched(r.matched || null)
  }
  useEffect(() => { setCands(null); setMatched(null); setQ(item.title || ''); search() }, [id])

  // WHAT THE HOST SAYS IT NOW IS, handed back for an in-place patch of the tile.
  // Read off the host's own answer rather than assumed here: a fix does not always
  // change the picture, and the version of this that assumed it did would have
  // blanked the poster sitting on the disk.
  const patch = (it) => ({
    artId: it?.artId || null,
    artBust: Date.now(),
    overview: it?.overview ?? null
  })

  const use = async (c) => {
    setBusy(true)
    const r = await api('/api/metadata/fix', { itemId: id, tmdbId: c.tmdbId, type: item.type })
    setBusy(false)
    if (r?.error) return setErr(r.error)
    onFixed?.(patch(r?.item))
    onDone?.()
  }

  const drop = async () => {
    const r = await api('/api/metadata/unmatch', { itemId: id })
    onFixed?.(patch(r?.item))
    onDone?.()
  }

  return (
    <div class='fixbody'>
      <p class='hint'>
        {diskArt
          ? <>This {item.type === 'series' ? 'show' : 'film'} has a poster of its own on
            disk and that picture stays. What you pick here fixes the summary and the year.</>
          : <>Pick the right one and its poster replaces the guess.</>}
        {' '}If the name on the file is not what the {item.type === 'series' ? 'show' : 'film'} is
        really called, search by the real name.
      </p>
      {matched && (
        <p class='hint'>
          Matched to <b>{matched.title}</b>{matched.year ? ` (${matched.year})` : ''}.
        </p>
      )}
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
      {/* OFFERED WHEN THERE IS A MATCH TO FORGET, which the host answers rather than
          the tile: a film wearing its own poster off the disk says nothing about
          whether anything was ever matched behind it. */}
      {matched && (
        <button class='ghost' style='margin-top:.8rem' disabled={busy} onClick={drop}>
          None of these - forget the match
        </button>
      )}
    </div>
  )
}

export function FixMatch ({ item, targetId = null, onClose, onFixed }) {
  return (
    <Modal title={'Fix the match: ' + item.title} onClose={onClose} wide>
      <FixMatchBody item={item} targetId={targetId} onFixed={onFixed} onDone={onClose} />
    </Modal>
  )
}
