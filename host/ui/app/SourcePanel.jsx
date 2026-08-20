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
import { notify, askConfirm, Modal } from './ui'
import { Drive, Film, Folder, Server, Blocked, Close, ChevronUp } from './icons'

// WHAT A FOLDER HOLDS, in the words somebody would use about their own shelves.
//
// It is not a tidiness setting. A file in a TV folder whose name carries no S01E01 -
// a box set numbered `K05`, a disc rip, anything hand-named - has nothing in it for a
// filename rule to read, so before this it landed in the Films list. Saying what the
// folder holds is the only thing that settles it, and on the real library it was 34
// television files sitting among the films.
//
// "Work it out" was the first wording and it did not read as a choice - "Work it out
// (tv shows)" left Tim asking what it meant (2026-08-19). What it means is: decide from
// the names, and the row says underneath what it decided.
const TYPE_LABEL = { auto: 'Automatic', movies: 'Films', shows: 'TV shows' }
// The same thing said inside a sentence. Lower-casing the label gave "read as tv
// shows", and TV is capitalised wherever it appears (Tim, 2026-08-19).
const HOLDS_PHRASE = { movies: 'films', shows: 'TV shows', auto: 'films and TV shows' }
const TYPE_ORDER = ['auto', 'movies', 'shows']

// WHAT WAS FOUND, in one phrase, and there is exactly one of these. The panel says it
// after a test, a save and a rescan; the Library page says it on the row that names
// where the films are. Two spellings of the same sentence would drift.
export function describeSource (r = {}) {
  // Counted properly, because this is on the page now and not only in a notification.
  // "1 shows" reads as a bug in the counting rather than a plural nobody bothered with.
  const bits = []
  if (r.leaves !== undefined) bits.push(`${r.leaves} films and episodes`)
  if (r.movies !== undefined) bits.push(`${r.movies} film${r.movies === 1 ? '' : 's'}`)
  if (r.series) bits.push(`${r.series} show${r.series === 1 ? '' : 's'}`)
  if (r.episodes) bits.push(`${r.episodes} episode${r.episodes === 1 ? '' : 's'}`)
  return bits.join(', ') || 'nothing yet'
}

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

  // Why this folder cannot be used, or '' when it can. One clause, and it is also what
  // disables the button - the sentence and the state are the same fact.
  const why = !data || busy
    ? ''
    : data.parent === null
      ? 'Pick one of the folders inside. The whole filesystem is not a library.'
      : (data.here > 0 || (data.dirs || []).some(d => d.video))
          ? ''
          : 'No video in this folder or the few levels under it.'

  return (
    <div>
      <p class='hint'>
        These are the folders this host can see. On Umbrel that is only what is mounted
        into the app - which is why picking beats typing.
      </p>

      <div class='picker'>
        <div class='head'>
          {/* AN ARROW, because "Up" is a word doing an icon's job in the one place
              every file browser ever made has used the same picture (Tim,
              2026-08-19). */}
          <button
            class='iconbtn' disabled={!data?.parent || busy}
            onClick={() => go(data.parent)}
            aria-label='Up one folder' title='Up one folder'
          >
            <ChevronUp size={16} />
          </button>
          <span class='mono' style='flex:1;word-break:break-all'>{at}</span>
        </div>
        {/* KEYED ON WHERE WE ARE, so stepping into a folder replays the fade rather
            than swapping the rows underneath the cursor. The list is a fixed height:
            the window used to grow and shrink with however many folders happened to be
            in one, which threw the buttons around under the pointer. */}
        <div class='list' key={at}>
          {busy && <div class='item'>Reading…</div>}
          {!busy && data?.mounts?.length > 0 && data.mounts.map(m => (
            <button class='item' key={'m' + m} onClick={() => go(m)}>
              <Drive size={16} /><span class='mono'>{m}</span>
            </button>
          ))}
          {!busy && data?.dirs?.map(d => (
            <button class='item' key={d.path} onClick={() => go(d.path)}>
              <span class='ic'>{d.video ? <Film size={16} /> : <Folder size={16} />}</span>
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

      {/* A FOLDER WITH NO FILMS IN IT CANNOT BE CHOSEN (Tim, 2026-08-19). The host
          already answers this question for every folder it lists - it is what puts the
          "video" mark on a row - so the same answer for the folder you are standing in
          is free. Refusing here is worth more than refusing at Save: the mistake is
          made in this window, and this is where somebody can still step into the right
          folder instead.

          THE DETECTOR IS BOUNDED, a few levels deep and a few thousand entries, so it
          can say no about a library buried deeper than that. That is why the line says
          where it looked: the way out is to step in, which is the better root anyway. */}
      {why && <p class='hint'>{why}</p>}

      {/* Centred and the SAME WIDTH. The path lives in the header rather than inside
          the button, which was a button that changed width at every step - and two
          buttons of different widths side by side was the next thing Tim saw. */}
      <div class='confirm-actions'>
        <button class='ghost' onClick={onClose}>Cancel</button>
        <button disabled={busy || !data || !!why} onClick={() => { onPick(at); onClose() }}>
          Use folder
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
// NOT WHAT YOU ARE ALREADY USING (Tim, 2026-08-19: "do we even need the subtitle
// details for the source types at the top since we can see them at the bottom?"). He
// was looking at his own two folders offered back to him above the same two folders.
// A detected source that is already configured is not an offer, it is an echo - so it
// is dropped, and when that is all of them the section goes with it.
//
// The Plex row is the interesting one. Plex is the likeliest thing to be running next
// to this and it CANNOT be read - it has its own API and needs its own reader - so it
// is shown, greyed, in one line. Hiding it would look like PearCinema had failed to
// notice the media server sitting right there, which is worse than an honest no. It is
// a row rather than the paragraph it was; a reader for it is feasible work we have not
// done, not an impossibility that needs explaining.
function Detected ({ onFolders, onServer, have = [], haveUrl = '' }) {
  const [found, setFound] = useState(null)

  useEffect(() => {
    let live = true
    api('/api/source/detect').then(r => { if (live) setFound(r || {}) })
    return () => { live = false }
  }, [])

  if (!found) return <p class='hint center'>Looking for films on this machine…</p>

  const using = new Set(have)
  const servers = (found.servers || []).filter(sv => !sv.usable || sv.url !== haveUrl)
  const folders = (found.folders || []).filter(f => !f.roots.every(r => using.has(r.path)))
  if (!servers.length && !folders.length) return null

  return (
    <>
      <div class='setgroup'>Already on this machine</div>
      <div class='setrows'>
        {/* NAMED BY WHAT IT IS, not by what it is called (Tim, 2026-08-19). The row
            used to be headed "Movies and TV Shows" and "umbrel" - the names of the
            things - which left the one question the row exists to answer, what KIND of
            source this is, to be inferred from an icon. */}
        {folders.map(f => (
          <div class='setrow' key={f.at}>
            <span class='rowmain'>
              <span class='rowname'><Drive size={15} /> Folders</span>
              {/* The detector matched these BY NAME, so it already knows which is films
                  and which is television. What it holds comes first, because that is
                  the part somebody reads; the path is the detail under it. */}
              {f.roots.map(r => (
                <span class='rowsub' key={r.path}>
                  {TYPE_LABEL[r.type] || TYPE_LABEL.auto} · {r.path}
                </span>
              ))}
            </span>
            <span class='rowctl'>
              <button class='ghost' onClick={() => onFolders(f.roots)}>Use</button>
            </span>
          </div>
        ))}

        {servers.map(sv => (
          <div class='setrow' key={sv.url}>
            <span class='rowmain'>
              <span class={'rowname ' + (sv.usable ? '' : 'dim')}>
                {sv.usable ? <Server size={15} /> : <Blocked size={15} />} {sv.server || 'Server'}
              </span>
              <span class='rowsub'>{sv.usable ? `${sv.name} · ${sv.url}` : sv.reason}</span>
            </span>
            <span class='rowctl'>
              {/* ONE WORD, THE SAME WORD. "Use these" beside "Use this" is two labels
                  for one action, and the difference between them carries nothing. */}
              {sv.usable && <button class='ghost' onClick={() => onServer(sv)}>Use</button>}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

// THREE PLACES THIS IS SHOWN, and they differ in two independent ways: whether it
// wears a card, and who owns the controls that keep a working library fresh.
//
//   wizard - the first run. Inline, no chrome, and no rescan controls because there
//            is no library to keep fresh yet.
//   editor - the Library page's window. It wears the overlay and the title bar
//            itself, and it does not own rescanning: the PAGE owns that now, as two
//            rows visible without opening anything.
//   neither - the standalone card, heading and banners included.
//
// Conflating the first two once cost the Settings page its rescan button entirely.
// The invariant that matters is not a prop, it is that the Library page has a rescan
// control somewhere on it, and page-renders.test.js is what holds that.
//
// A WINDOW THAT NEVER OPENS A SECOND WINDOW (Tim, 2026-08-19). Picking a folder is a
// step: it replaces what is in this window and hands it back, rather than stacking a
// pop-up on a pop-up. Inline - the wizard - the picker is still its own overlay,
// because inline there is nothing for it to be a step inside of.
export default function SourcePanel ({ state, reload, editor = false, wizard = false, onSaved = null, onClose = null }) {
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

  const describe = describeSource

  const test = async () => {
    setBusy('test')
    const res = await api('/api/source/test', cfg())
    setBusy('')
    if (res.error) return notify('That did not work', res.error)
    notify('Looks good', `Found ${describe(res)}. Nothing has been saved yet. Press Save to switch to it.`)
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
    // A disclosure that stays open after it has done its job reads as unfinished.
    onSaved?.()
  }

  const rescan = async () => {
    setBusy('rescan')
    const res = await api('/api/source/rescan', {})
    setBusy('')
    if (res.error) return notify('Rescan failed', res.error)
    await reload()
    // It STARTS the scan and answers - a full read of a real library is minutes - so
    // this cannot claim a result it does not have yet.
    notify('Rescanning', 'The library is being read. Progress is on the Library settings page.')
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

  // Who keeps the library fresh. Neither the wizard (no library yet) nor the Library
  // page's disclosure (the page has rescan rows of its own), and never when there is
  // no source to rescan.
  const ownsRescan = !wizard && !editor && current.kind !== 'empty'

  const Body = (
    <>
      <Detected
        have={roots.map(r => r.path)}
        haveUrl={kind === 'jellyfin' ? url.trim() : ''}
        onFolders={(rs) => {
          setKind('folder')
          addRoots(rs)
        }}
        onServer={(sv) => {
          setKind('jellyfin')
          setUrl(sv.url)
        }}
      />

      {/* PearTune's segmented picker, full width - the donor design this whole
          panel copies (Tim, 2026-08-15). */}
      <div class='seg wide' style='margin-bottom:.9rem'>
        <button class={kind === 'folder' ? 'on' : ''} onClick={() => setKind('folder')}>Folders</button>
        <button class={kind === 'jellyfin' ? 'on' : ''} onClick={() => setKind('jellyfin')}>Jellyfin or Emby</button>
      </div>

      {kind === 'folder' && (
        <>
          {/* The parenthetical is not decoration: it is why the path here does not look
              like the path on the box. It is one clause now rather than a line of
              container vocabulary. */}
          <label class='srclabel'>Folders <span class='hint-inline'>- as this app sees them</span></label>
          <div class='rootlist'>
            {roots.map(r => (
              <div class='rootrow' key={r.path}>
                <span class='rowmain'>
                  <span class='rootpath' title={r.path}>{r.path}</span>
                  {/* WHAT AUTOMATIC DECIDED, on its own line rather than folded into the
                      chooser's own label. Reading `TV Shows` as television silently would
                      be a decision the operator cannot see; saying it inside the option
                      made the option unreadable. */}
                  {(!r.type || r.type === 'auto') && r.holds && (
                    <span class='rowsub'>Read as {HOLDS_PHRASE[r.holds] || HOLDS_PHRASE.auto}.</span>
                  )}
                </span>
                <span class='rowctl'>
                  <select
                    value={r.type || 'auto'}
                    aria-label={'What is in ' + r.path}
                    onChange={e => setRootType(r, e.currentTarget.value)}
                  >
                    {TYPE_ORDER.map(t => <option value={t} key={t}>{TYPE_LABEL[t]}</option>)}
                  </select>
                  <button class='iconbtn' onClick={() => removeRoot(r)} aria-label={'Remove ' + r.path}><Close size={15} /></button>
                </span>
              </div>
            ))}
            {!roots.length && <div class='rootrow'><span class='hint-inline'>No folders yet. Add the one your films are in.</span></div>}
          </div>
          {/* The donor has a free-text path box beside Browse. Ours deliberately
              does not - the typed-path-inside-the-container trap is this panel's
              founding scar (see the header comment) - so the row is the picker
              alone, full width like the donor's. */}
          <div class='addfolder'>
            <button class='ghost' onClick={() => setPicking(true)}>Add a folder…</button>
          </div>
          {/* ONE CLAUSE, and only the half nobody could work out. Three of the four
              sentences here explained the control sitting directly above them: "work it
              out" already says what it worked out, in the chooser itself. What it cannot
              say is what saying so BUYS you, which is the episode that would otherwise
              have turned up as a film. */}
          <p class='hint'>
            Saying what a folder holds is what keeps a hand-named episode under its show
            instead of in with the films.
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

      {/* THE ACTION ROW EVERY OTHER PAGE HAS: centred, and each button the same 7.5rem
          minimum. It was two filled buttons stretched to half the width each, which is
          a shape that exists nowhere else in Settings and reads as a form footer from a
          different app. */}
      <div class='actions'>
        <button class='ghost' onClick={test} disabled={!!busy}>{busy === 'test' ? 'Checking…' : 'Test'}</button>
        <button onClick={save} disabled={!!busy || !dirty}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        {ownsRescan && (
          <button class='ghost' onClick={rescan} disabled={!!busy}>Rescan</button>
        )}
      </div>

      {/* Scheduled auto-rescan, the donor's control: pick new files up without a
          manual Rescan. Not offered during first-run setup - there is no library
          to keep fresh yet - and not here on the Library page either, where it is
          a row of its own that does not need this panel opened to be seen. */}
      {ownsRescan && (
        <label class='autoscan'>
          <span>Auto-rescan</span>
          <select
            value={state.rescanIntervalMin || 0}
            onChange={async e => {
              const minutes = Number(e.currentTarget.value)
              const res = await api('/api/rescan-interval', { minutes })
              if (res?.error) return notify('Not set', res.error)
              notify('Auto-rescan', minutes ? `The library rechecks itself every ${minutes >= 60 ? (minutes / 60) + ' hour' + (minutes > 60 ? 's' : '') : minutes + ' minutes'}.` : 'Off. Rescans are manual.')
              reload()
            }}
          >
            <option value={0}>Off</option>
            <option value={15}>Every 15 minutes</option>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Every hour</option>
            <option value={360}>Every 6 hours</option>
          </select>
        </label>
      )}

      {picking && !editor && (
        <div class='overlay' onMouseDown={e => { if (e.target === e.currentTarget) setPicking(false) }}>
          <div class='modal'>
            <div class='modal-head'>
              <h3>Pick a folder</h3>
              <button class='iconbtn' onClick={() => setPicking(false)} aria-label='Close'><Close size={15} /></button>
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

  if (wizard) return Body

  // THE WINDOW, and one step at a time inside it. Closing from the folder browser goes
  // BACK to the source rather than out of the whole thing - it is a step, and a step's
  // way out is the step behind it.
  if (editor) {
    return (
      <Modal
        title={picking ? 'Pick a folder' : 'Where the films are'}
        onClose={() => (picking ? setPicking(false) : onClose?.())}
        closeLabel={picking ? 'Back' : 'Close'}
        wide
      >
        {picking
          ? <FolderPicker onPick={(p) => addRoots([p])} onClose={() => setPicking(false)} />
          : Body}
      </Modal>
    )
  }

  return (
    <div class='card'>
      <h3>Where the films are</h3>
      <SourceBanners state={state} />
      {Body}
    </div>
  )
}

// THE BANNERS ARE NOT PART OF THE EDITOR, and that separation is the point of pulling
// them out: on the Library page the editor lives behind a Change button, and a source
// that has stopped answering is exactly the news nobody should have to open anything
// to hear.
export function SourceBanners ({ state }) {
  return (
    <>
      {state.stats?.duplicates > 0 && (
        <div class='banner bad'>
          <b>Two of these folders hold the same {state.stats.duplicates === 1 ? 'file' : 'files'}.</b>{' '}
          {state.stats.duplicates} {state.stats.duplicates === 1 ? 'file is' : 'files are'} in more than one
          of your folders, so only one copy of each is reachable.
          <div class='hint'>
            Usually one folder is a copy of another, or one sits inside the other. Remove
            whichever you do not want and rescan.
          </div>
        </div>
      )}
      {state.sourceError && (
        <div class='banner bad'>
          <b>The source is not answering.</b> {state.sourceError}
          <div class='hint'>Paired devices can still reach this host. They just see an empty library until this is fixed.</div>
        </div>
      )}
    </>
  )
}

export { FolderPicker }
