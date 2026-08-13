// Where the films come from: a folder on this machine, or a Jellyfin/Emby server.
//
// THE FOLDER PICKER IS NOT A CONVENIENCE. It exists because of a specific bug that
// cost PearTune an evening: the path goes INSIDE THE CONTAINER, nothing said so,
// the operator typed the path their other app uses, and got zero files - which is
// indistinguishable from an empty library, so it reads as "this app is broken".
//
// So there is NO free-text path box here. The operator browses what the container
// can actually see and clicks a folder, and the value we save provably exists.
// (host/browse.js is the other half; it lists directory NAMES only, never files.)
//
// Folders come FIRST in this panel, and that is a product statement rather than
// alphabetical order. Reading only Jellyfin would make PearCinema an accessory to a
// project that can improve its own remote access whenever it likes. Jellyfin is
// listed second because it reaches first playback faster, which is a sequencing
// convenience inside v1 and not the point of the app.

import { useState, useEffect } from 'preact/hooks'
import { api } from './api'
import { notify, askConfirm } from './ui'

function FolderPicker ({ onPick, onClose }) {
  const [at, setAt] = useState('/')
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(true)

  const go = async (path) => {
    setBusy(true); setErr('')
    const res = await api('/api/source/folders?path=' + encodeURIComponent(path))
    setBusy(false)
    if (res.error) return setErr(res.error)
    setData(res); setAt(res.path)
  }

  useEffect(() => { go('/') }, [])

  return (
    <div>
      <p class='hint'>
        These are the folders this host can see. On Umbrel that is only what is mounted
        into the app - which is why picking beats typing.
      </p>

      <div class='picker'>
        <div class='head'>
          <button class='ghost small' disabled={!data?.parent || busy} onClick={() => go(data.parent)}>Up</button>
          <span class='mono' style='flex:1;word-break:break-all'>{at}</span>
        </div>
        <div class='list'>
          {busy && <div class='item'>Reading…</div>}
          {!busy && data?.mounts?.length > 0 && data.mounts.map(m => (
            <button class='item' key={'m' + m} onClick={() => go(m)}>
              <span>💾</span><span class='mono'>{m}</span>
            </button>
          ))}
          {!busy && data?.dirs?.map(d => (
            <button class='item' key={d.path} onClick={() => go(d.path)}>
              <span>{d.video ? '🎬' : '📁'}</span>
              <span style='flex:1'>{d.name}</span>
              {d.video && <span class='chip good'>video</span>}
            </button>
          ))}
          {!busy && data && !data.dirs.length && !data.mounts?.length && (
            <div class='item' style='color:var(--muted)'>Nothing to open in here.</div>
          )}
        </div>
      </div>

      {err && <div class='banner bad' style='margin-top:.7rem'>{err}</div>}

      <div class='confirm-actions'>
        <button class='ghost' onClick={onClose}>Cancel</button>
        <button disabled={busy || !data} onClick={() => { onPick(at); onClose() }}>
          Use {at}
        </button>
      </div>
    </div>
  )
}

export default function SourcePanel ({ state, reload, embedded = false }) {
  const current = state.source || { kind: 'empty' }
  const [kind, setKind] = useState(current.kind === 'jellyfin' ? 'jellyfin' : 'folder')
  const [roots, setRoots] = useState(current.roots?.length ? current.roots : [])
  const [url, setUrl] = useState(current.url || '')
  const [user, setUser] = useState(current.username || '')
  const [pass, setPass] = useState('')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState('')

  const cfg = () => kind === 'folder'
    ? { kind: 'folder', roots }
    : { kind: 'jellyfin', url: url.trim(), username: user.trim(), password: pass }

  const describe = (r) => {
    const bits = []
    if (r.leaves !== undefined) bits.push(`${r.leaves} films and episodes`)
    if (r.movies !== undefined) bits.push(`${r.movies} films`)
    if (r.series) bits.push(`${r.series} shows`)
    if (r.episodes) bits.push(`${r.episodes} episodes`)
    return bits.join(', ') || 'nothing yet'
  }

  const test = async () => {
    setBusy('test')
    const res = await api('/api/source/test', cfg())
    setBusy('')
    if (res.error) return notify('That did not work', res.error)
    notify('Looks good', `Found ${describe(res)}. Nothing has been saved yet - press Save to switch to it.`)
  }

  const save = async () => {
    setBusy('save')
    const res = await api('/api/source', cfg())
    setBusy('')
    if (res.error) {
      return notify('Not saved', res.error + `\n\nYour library is still being served from the old source, so nothing has gone dark.`)
    }
    await reload()
    notify('Saved', `Now serving ${describe(res)}.`)
  }

  const rescan = async () => {
    setBusy('rescan')
    const res = await api('/api/source/rescan', {})
    setBusy('')
    if (res.error) return notify('Rescan failed', res.error)
    await reload()
    notify('Rescanned', `Found ${describe(res)}.`)
  }

  const removeRoot = async (r) => {
    if (roots.length === 1 && !await askConfirm({
      title: 'Remove the only folder?',
      message: 'The library will be empty until you add another one.',
      confirmLabel: 'Remove',
      danger: true
    })) return
    setRoots(roots.filter(x => x !== r))
  }

  const dirty = kind !== current.kind ||
    (kind === 'folder' && JSON.stringify(roots) !== JSON.stringify(current.roots || [])) ||
    (kind === 'jellyfin' && (url.trim() !== (current.url || '') || user.trim() !== (current.username || '') || pass))

  const Body = (
    <>
      <div class='row' style='margin-bottom:.9rem'>
        <button class={kind === 'folder' ? '' : 'ghost'} onClick={() => setKind('folder')}>A folder of films</button>
        <button class={kind === 'jellyfin' ? '' : 'ghost'} onClick={() => setKind('jellyfin')}>Jellyfin or Emby</button>
      </div>

      {kind === 'folder' && (
        <>
          <div class='roots'>
            {roots.map(r => (
              <div class='root' key={r}>
                <span>{r}</span>
                <button class='iconbtn' onClick={() => removeRoot(r)} aria-label={'Remove ' + r}>✕</button>
              </div>
            ))}
            {!roots.length && <p class='hint'>No folders yet. Add the one your films are in.</p>}
          </div>
          <button class='ghost' onClick={() => setPicking(true)}>Add a folder…</button>
          <p class='hint'>
            Add films and TV as separate folders if they live apart - that is the normal
            shape of a collection, and each one is scanned on its own so an unplugged
            drive does not take the rest down.
          </p>
        </>
      )}

      {kind === 'jellyfin' && (
        <>
          <div class='field'>
            <label>Server address</label>
            <input type='text' value={url} placeholder='http://10.0.0.5:8096'
              onInput={e => setUrl(e.currentTarget.value)} />
          </div>
          <div class='field'>
            <label>Username</label>
            <input type='text' value={user} onInput={e => setUser(e.currentTarget.value)} />
          </div>
          <div class='field'>
            <label>Password</label>
            <input type='password' value={pass} placeholder={current.username ? 'unchanged' : ''}
              onInput={e => setPass(e.currentTarget.value)} />
          </div>
          <p class='hint'>
            PearCinema only ever reads. It asks Jellyfin for the original file rather than
            a converted one, which is what makes seeking inside a film work.
          </p>
        </>
      )}

      <div class='row' style='margin-top:.9rem'>
        <button class='ghost' onClick={test} disabled={!!busy}>{busy === 'test' ? 'Checking…' : 'Test'}</button>
        <button onClick={save} disabled={!!busy || !dirty}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        {!embedded && current.kind !== 'empty' && (
          <button class='ghost' onClick={rescan} disabled={!!busy}>{busy === 'rescan' ? 'Rescanning…' : 'Rescan now'}</button>
        )}
      </div>

      {picking && (
        <div class='overlay' onMouseDown={e => { if (e.target === e.currentTarget) setPicking(false) }}>
          <div class='modal'>
            <div class='modal-head'>
              <h3>Pick a folder</h3>
              <button class='iconbtn' onClick={() => setPicking(false)} aria-label='Close'>✕</button>
            </div>
            <FolderPicker
              onPick={(p) => setRoots(roots.includes(p) ? roots : [...roots, p])}
              onClose={() => setPicking(false)}
            />
          </div>
        </div>
      )}
    </>
  )

  if (embedded) return Body

  return (
    <div class='card'>
      <h3>Where the films are</h3>
      {state.sourceError && (
        <div class='banner bad'>
          <b>The source is not answering.</b> {state.sourceError}
          <div class='hint'>Paired devices can still reach this host - they just see an empty library until this is fixed.</div>
        </div>
      )}
      {Body}
    </div>
  )
}

export { FolderPicker }
