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

// WHAT A FOLDER HOLDS, in the words somebody would use about their own shelves.
//
// It is not a tidiness setting. A file in a TV folder whose name carries no S01E01 -
// a box set numbered `K05`, a disc rip, anything hand-named - has nothing in it for a
// filename rule to read, so before this it landed in the Films list. Saying what the
// folder holds is the only thing that settles it, and on the real library it was 34
// television files sitting among the films.
const TYPE_LABEL = { auto: 'Work it out', movies: 'Films', shows: 'TV shows' }
const TYPE_ORDER = ['auto', 'movies', 'shows']

// A root as the panel holds it. The host sends `{ path, type, holds }`; older saved
// configs are bare path strings, and a fake state in a test may be either.
const asRoot = (r) => (typeof r === 'string' ? { path: r, type: 'auto' } : { ...r })
// What the operator PICKED, without the host's resolution of it - the pair that gets
// saved, and the pair the dirty check compares.
const picked = (r) => ({ path: r.path, type: r.type || 'auto' })

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

// WHAT WE FOUND ON THIS MACHINE, offered before either manual path.
//
// This is the shortest route from a fresh install to a working library, and on the
// boxes PearCinema ships to it usually gets it right in one click: a Jellyfin on
// localhost, or an external drive with Movies and TV Shows on it.
//
// The Plex row is the interesting one. Plex is the likeliest thing to be running
// next to this and it CANNOT be read - it has its own API and needs its own reader -
// so it is shown, disabled, with the reason and with the thing to do instead. Hiding
// it would look like PearCinema had failed to notice the media server sitting right
// there, which is worse than an honest no.
function Detected ({ onFolders, onServer }) {
  const [found, setFound] = useState(null)

  useEffect(() => {
    let live = true
    api('/api/source/detect').then(r => { if (live) setFound(r || {}) })
    return () => { live = false }
  }, [])

  if (!found) return <p class='hint'>Looking for films on this machine…</p>

  const servers = found.servers || []
  const folders = found.folders || []
  if (!servers.length && !folders.length) return null

  return (
    <div style='margin-bottom:1rem'>
      <h3>Already on this machine</h3>

      {folders.map(f => (
        <div class='dev' key={f.at}>
          <span>🎬</span>
          <div class='who'>
            <b>{f.label}</b>
            {/* The detector matched these folders BY NAME, so it already knows which
                is films and which is television. Showing that here is what makes
                "Use these" a one-click typed library rather than a path list. */}
            {f.roots.map(r => (
              <div class='mono' key={r.path}>{r.path} <span class='chip'>{TYPE_LABEL[r.type] || TYPE_LABEL.auto}</span></div>
            ))}
          </div>
          <button class='small' onClick={() => onFolders(f.roots)}>Use these</button>
        </div>
      ))}

      {servers.map(sv => (
        <div class='dev' key={sv.url}>
          <span>{sv.usable ? '🖥' : '🚫'}</span>
          <div class='who'>
            <b>{sv.name}</b>
            <div>{sv.usable ? sv.url : sv.reason}</div>
          </div>
          {sv.usable
            ? <button class='small' onClick={() => onServer(sv)}>Use this</button>
            : <span class='chip'>not readable</span>}
        </div>
      ))}
    </div>
  )
}

export default function SourcePanel ({ state, reload, embedded = false }) {
  const current = state.source || { kind: 'empty' }
  const [kind, setKind] = useState(current.kind === 'jellyfin' ? 'jellyfin' : 'folder')
  const [roots, setRoots] = useState((current.roots || []).map(asRoot))
  const [url, setUrl] = useState(current.url || '')
  const [user, setUser] = useState(current.username || '')
  const [pass, setPass] = useState('')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState('')

  const cfg = () => kind === 'folder'
    ? { kind: 'folder', roots: roots.map(picked) }
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
    setRoots(roots.filter(x => x.path !== r.path))
  }

  const setRootType = (r, type) => setRoots(roots.map(x => (x.path === r.path ? { path: x.path, type } : x)))

  const addRoots = (list) => {
    const next = [...roots]
    for (const r of list.map(asRoot)) {
      // A folder already on the list keeps whatever the operator set it to. Re-adding
      // it must not quietly overwrite a type they chose by hand.
      if (!next.some(x => x.path === r.path)) next.push(r)
    }
    setRoots(next)
  }

  // Compared on what was PICKED. The host adds its own resolution of an `auto` root,
  // and treating that as a change would leave Save lit up on a page nobody touched.
  const dirty = kind !== current.kind ||
    (kind === 'folder' && JSON.stringify(roots.map(picked)) !== JSON.stringify((current.roots || []).map(asRoot).map(picked))) ||
    (kind === 'jellyfin' && (url.trim() !== (current.url || '') || user.trim() !== (current.username || '') || pass))

  const Body = (
    <>
      <Detected
        onFolders={(rs) => {
          setKind('folder')
          addRoots(rs)
        }}
        onServer={(sv) => {
          setKind('jellyfin')
          setUrl(sv.url)
        }}
      />

      <div class='row' style='margin-bottom:.9rem'>
        <button class={kind === 'folder' ? '' : 'ghost'} onClick={() => setKind('folder')}>A folder of films</button>
        <button class={kind === 'jellyfin' ? '' : 'ghost'} onClick={() => setKind('jellyfin')}>Jellyfin or Emby</button>
      </div>

      {kind === 'folder' && (
        <>
          <div class='roots'>
            {roots.map(r => (
              <div class='root' key={r.path}>
                <span>{r.path}</span>
                <select
                  value={r.type || 'auto'}
                  aria-label={'What is in ' + r.path}
                  onChange={e => setRootType(r, e.currentTarget.value)}
                >
                  {TYPE_ORDER.map(t => (
                    // "Work it out" says what it worked OUT, when the folder's own
                    // name settled it. Silently reading `TV Shows` as television and
                    // showing nothing would be a decision the operator cannot see.
                    <option value={t} key={t}>
                      {t === 'auto' && r.holds ? `${TYPE_LABEL.auto} (${TYPE_LABEL[r.holds].toLowerCase()})` : TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
                <button class='iconbtn' onClick={() => removeRoot(r)} aria-label={'Remove ' + r.path}>✕</button>
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
          {/* SAYING WHAT A FOLDER HOLDS IS NOT TIDINESS. Some files are named in a way
              nothing can read - a box set numbered K05, a disc rip - and without this
              they end up in the wrong list. On the real library that was 34 television
              files sitting among the films. */}
          <p class='hint'>
            Say what each folder holds and nothing has to be guessed from the file names.
            In a TV folder, an episode whose name does not say which one it is still goes
            under its show instead of turning up as a film. Leave it on "work it out" and
            a folder called Movies or TV Shows is taken at its word.
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
              // A folder picked by hand starts at "work it out", where its own name
              // may still settle it. addRoots leaves an already-listed folder alone,
              // so re-picking one cannot wipe a type the operator chose.
              onPick={(p) => addRoots([p])}
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
