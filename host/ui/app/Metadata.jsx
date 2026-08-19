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
//   - NOBODY IS QUIZZED (Tim, 2026-08-14, revising the first cut, with Plex as the
//     named reference). Every lookup applies its best guess; this panel says how
//     many of those were guesses, and the correction lives where the mistake is
//     visible - a pencil on the tile itself, opening a fix-match dialog.

import { useState, useEffect, useRef } from 'preact/hooks'
import { api } from './api'
import { notify, Modal } from './ui'
import { FixMatchBody } from './FixMatch'

// TWO SHAPES, one panel. `embedded` drops the card chrome so the same panel can sit
// inside the first-run wizard (Tim, 2026-08-14: this step belongs in onboarding, not
// only in Settings), where a paragraph explaining itself is exactly what is wanted.
// `rows` is the Library settings page, where it is a switch, a key and two occasional
// actions - one setting per row, and the setup form only when somebody opens it.
export default function Metadata ({ embedded = false, rows = false, onEnabled = null } = {}) {
  const [meta, setMeta] = useState(null)
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(null)
  const [writing, setWriting] = useState(false)
  const [written, setWritten] = useState(null)
  const [keyOpen, setKeyOpen] = useState(false)
  const [missingOpen, setMissingOpen] = useState(false)
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
    if (enabled) {
      notify('Fetching artwork', 'Watch it fill in on the library page. A best guess is applied where a name is ambiguous, and any tile can be corrected from its pencil.')
      // In the wizard, turning it on IS finishing the step - do not make somebody
      // find a second button (Tim, 2026-08-14).
      onEnabled?.()
    }
  }

  // One press: test, and only then save. A key TMDB refuses never reaches the store,
  // which is the whole reason the Test button existed.
  const saveKey = async () => {
    if (!key) return
    setTesting(true)
    const t = await api('/api/metadata/test', { key })
    setTesting(false)
    setTested(t)
    if (!t?.ok) return
    await save(meta.enabled)
    setKeyOpen(false)
  }

  const writeSidecars = async () => {
    setWriting(true)
    setWritten(await api('/api/metadata/sidecars'))
    setWriting(false)
  }

  const lookAgain = async () => {
    await api('/api/metadata/run', { retryMissed: true })
    reload()
  }

  if (rows) {
    // THE NAME CARRIES THE STATE and the sub-line always says it in words, so nobody
    // has to tell green from grey to know whether this is on.
    const postersSub = meta.running
      ? `Looking up ${meta.running.done} of ${meta.running.total}…`
      : meta.enabled
        ? (meta.lastRun
            ? `On · ${meta.matched} title${meta.matched === 1 ? ' has' : 's have'} artwork`
            : 'On. Nothing has been fetched yet.')
        : meta.hasKey
          ? 'Off. Films show only the artwork found beside them.'
          : 'Off. It needs a free TMDB key first.'

    return (
      <>
        {/* THE ONE THING NOBODY COULD GUESS, said once, above the switch it is about.
            The rest of what this paragraph used to carry - what a key is, where to get
            one, what happens next - lives where it applies: in the key row, and in the
            form that opens when somebody sets one up. */}
        <p class='hint'>
          With this on, the host asks TMDB, a third-party film database, for posters,
          which means <b>this host tells TMDB the titles it is identifying</b>. Nothing
          else is sent, and artwork found beside your own files always wins.
        </p>

        <div class='setrows'>
          <div class='setrow'>
            <span class='rowmain'>
              <span class={'rowname ' + (meta.enabled ? 'good' : 'dim')}>Posters</span>
              <span class='rowsub'>
                {postersSub}
                {meta.running && (
                  <span class='meter' style='margin-left:.5rem'>
                    <i style={`width:${meta.running.total ? Math.round((meta.running.done / meta.running.total) * 100) : 0}%`} />
                  </span>
                )}
              </span>
            </span>
            <span class='rowctl'>
              {meta.enabled
                ? <button class='ghost' onClick={() => save(false)}>Turn off</button>
                : (
                  <button
                    class='ghost'
                    disabled={!meta.hasKey}
                    title={meta.hasKey ? '' : 'Add a TMDB key first'}
                    onClick={() => save(true)}
                  >
                    Turn on
                  </button>
                  )}
            </span>
          </div>

          <div class='setrow'>
            <span class='rowmain'>
              <span class='rowname'>TMDB key</span>
              <span class='rowsub'>{meta.hasKey ? 'Your own key is saved.' : 'Needed before anything can be fetched.'}</span>
            </span>
            <span class='rowctl'>
              <button class='ghost' onClick={() => { setKeyOpen(!keyOpen); setTested(null) }}>
                {keyOpen ? 'Cancel' : (meta.hasKey ? 'Change' : 'Add')}
              </button>
            </span>
          </div>

          {/* THE SAME SHAPE THE PASSWORD FORM HAS on This host: a labelled field and
              ONE button. It had a Test beside the box and a Save under it, which is two
              presses and a decision for something with one possible outcome - so Save
              tests first and refuses out loud with TMDB's own reason. Nothing is saved
              by a button that says it tested. */}
          {keyOpen && (
            <div class='rowopen'>
              <p class='hint'>
                It is free and it takes a minute: create one at{' '}
                <a href='https://www.themoviedb.org/settings/api' target='_blank' rel='noreferrer'>themoviedb.org/settings/api</a>.
              </p>
              <div class='field'>
                <label>{meta.hasKey ? 'A new key, replacing the saved one' : 'Your TMDB key'}</label>
                <input
                  type='password'
                  value={key}
                  onInput={e => { setKey(e.currentTarget.value); setTested(null) }}
                  onKeyDown={e => { if (e.key === 'Enter') saveKey() }}
                />
              </div>
              {tested && !tested.ok && <p class='error'>{tested.error}</p>}
              <div class='actions'>
                <button disabled={!key || testing} onClick={saveKey}>
                  {testing ? 'Checking…' : 'Save key'}
                </button>
              </div>
            </div>
          )}

          {/* SAID ONLY WHERE IT APPLIES. A row about titles that found nothing is noise
              on a library where everything did. */}
          {meta.enabled && !meta.running && meta.missed > 0 && (
            <div class='setrow'>
              <span class='rowmain'>
                <span class='rowname warn'>Titles with no artwork</span>
                <span class='rowsub'>{meta.missed} came back with nothing.</span>
              </span>
              {/* A COUNT YOU CANNOT ACT ON IS A COUNT (Tim, 2026-08-19). The button was
                  Look again, which asks TMDB the same question and gets the same answer
                  for a film whose filename is not its name. This one shows WHICH, and
                  each of them opens the same choices the pencil on a tile gives - as a
                  step inside this window rather than a pop-up over it. */}
              <span class='rowctl'>
                <button class='ghost' onClick={() => setMissingOpen(true)}>Show them</button>
              </span>
            </div>
          )}

          {/* THE EXPLICIT ACTION. Everything fetched lives in this host's own data
              folder, which a reinstall or a moved drive loses. This writes it beside
              the films instead, as the standard files every scanner reads, and it only
              ever creates, never replaces. Folder libraries only: a Jellyfin library is
              that server's to manage. */}
          {meta.canWriteSidecars && meta.matched > 0 && !meta.running && (
            <div class='setrow'>
              <span class='rowmain'>
                <span class='rowname'>Keep artwork with the films</span>
                <span class='rowsub'>
                  Artwork lives in this host's own data folder until you save a copy beside the films.
                </span>
              </span>
              <span class='rowctl'>
                <button class='ghost' disabled={writing} onClick={writeSidecars}>
                  {writing ? 'Saving…' : 'Save a copy'}
                </button>
              </span>
            </div>
          )}
        </div>

        {written && (
          <p class='hint' style={written.readOnly || written.error ? 'color:var(--danger)' : ''}>
            {written.error
              ? written.error
              : written.readOnly
                ? 'Nothing could be written: the library is mounted read-only. On an Umbrel, update the app. Newer versions mount the library writable for exactly this.'
                : sentence(written)}
          </p>
        )}

        {!meta.running && meta.uncertain > 0 && (
          <p class='hint'>
            <b>{meta.uncertain}</b> of them {meta.uncertain === 1 ? 'was' : 'were'} matched from
            several possibilities, so a poster may be wrong here and there. Correcting one is
            the pencil on its tile, in the library.
          </p>
        )}

        {missingOpen && (
          <MissingArtwork
            onClose={() => { setMissingOpen(false); reload() }}
            onLookAgain={async () => { setMissingOpen(false); await lookAgain() }}
          />
        )}
      </>
    )
  }

  return (
    <div class={embedded ? '' : 'card'}>
      {!embedded && <h3>Artwork from the internet</h3>}
      <p class='hint'>
        Most files carry no artwork of their own. With this on, the host asks TMDB, a
        third-party film database, for posters, which means <b>this host tells TMDB the
        titles it is identifying</b>. Nothing else is sent and artwork found beside your
        files always wins. Nothing is written into your library except by the explicit
        save button below. Off by default.
      </p>

      {!meta.hasKey && (
        <p class='hint'>
          It needs your own free TMDB key: create one at{' '}
          <a href='https://www.themoviedb.org/settings/api' target='_blank' rel='noreferrer'>themoviedb.org/settings/api</a>{' '}
          and paste it here.
        </p>
      )}

      {/* Centered with the buttons below it (Tim, 2026-08-15: symmetry) - a
          full-bleed input above centered actions read as two different pages. */}
      <div class='row artkey'>
        <input
          type='password'
          placeholder={meta.hasKey ? 'A key is saved. Paste to replace it' : 'Paste your TMDB key'}
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

      <div class='actions'>
        {!meta.enabled && (
          <button disabled={!meta.hasKey && !(key && tested?.ok)} onClick={() => save(true)}>
            Turn on and fetch artwork
          </button>
        )}
        {meta.enabled && <button class='ghost' onClick={() => save(false)}>Turn it off</button>}
        {meta.enabled && !meta.running && (
          <button class='ghost' onClick={lookAgain}>Look again</button>
        )}
        {key && (
          <button class='ghost' disabled={!tested?.ok} onClick={() => save(meta.enabled)}>Save key</button>
        )}
      </div>

      {meta.running && (
        <div class='artfetch' style='margin-top:.6rem'>
          <span class='hint'>Looking up <b>{meta.running.done}</b> of {meta.running.total}…</span>
          <span class='meter'><i style={`width:${meta.running.total ? Math.round((meta.running.done / meta.running.total) * 100) : 0}%`} /></span>
        </div>
      )}
      {!meta.running && meta.lastRun && (
        <p class='hint'>
          {meta.matched} title{meta.matched === 1 ? ' has' : 's have'} fetched artwork
          {meta.pictures > 0 ? `, plus ${meta.pictures} season and episode pictures` : ''}
          {meta.missed > 0 ? `, and ${meta.missed} came back with nothing` : ''}.
        </p>
      )}
      {!meta.running && meta.uncertain > 0 && (
        <p class='hint'>
          <b>{meta.uncertain}</b> of them {meta.uncertain === 1 ? 'was' : 'were'} matched from
          several possibilities, so a poster may be wrong here and there. Correcting one is
          the pencil on its tile, in the library.
        </p>
      )}

      {/* THE EXPLICIT ACTION. Everything fetched lives in this host's own data
          folder, which a reinstall or a moved drive loses. This writes it beside
          the films instead, as the standard files every scanner reads, and it
          only ever creates, never replaces, so the button is safe to press on a
          library full of hand-made answers. Shown for folder libraries only:
          a Jellyfin library is that server's to manage. */}
      {meta.canWriteSidecars && meta.matched > 0 && !meta.running && (
        <div style='margin-top:.8rem'>
          <p class='hint'>
            The fetched artwork and matches live in this host's own data folder. You can
            save them <b>into the library itself</b>, beside the films, as the standard
            files Kodi and Jellyfin also read, so they survive a reinstall and travel
            with the drive. Only new files are created; anything already beside your
            films is left exactly as it is.
          </p>
          <div class='actions'>
            <button class='ghost' disabled={writing} onClick={writeSidecars}>
              {writing ? 'Saving…' : 'Save into the library'}
            </button>
          </div>
          {written && (
            <p class='hint' style={written.readOnly || written.error ? 'color:var(--danger)' : ''}>
              {written.error
                ? written.error
                : written.readOnly
                  ? 'Nothing could be written: the library is mounted read-only. On an Umbrel, update the app. Newer versions mount the library writable for exactly this.'
                  : sentence(written)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// WHICH TITLES FOUND NOTHING, and the fix for each of them in the same window.
//
// A film TMDB has never heard of is rare. A film whose FILE is not named what the film
// is called is not - and asking TMDB the same question again returns the same nothing,
// which is all the old Look again button could do. Here the answer is a person typing
// the real name, which is exactly what the pencil on a tile already offers.
//
// ONE WINDOW, TWO STEPS. Picking a title replaces the list with the choices for it and
// gives the list back afterwards, rather than opening a second window on top of the
// first (Tim, 2026-08-19).
function MissingArtwork ({ onClose, onLookAgain }) {
  const [items, setItems] = useState(null)
  const [fixing, setFixing] = useState(null)
  // Fixed in this sitting, so a title that has just been given a poster stops looking
  // like one that has not - without re-reading the whole list on every pick.
  const [done, setDone] = useState({})

  useEffect(() => {
    let live = true
    api('/api/metadata/missing').then(r => { if (live) setItems(r?.items || []) })
    return () => { live = false }
  }, [])

  const left = (items || []).filter(i => !done[i.id])

  return (
    <Modal
      title={fixing ? fixing.title : 'Titles with no artwork'}
      onClose={() => (fixing ? setFixing(null) : onClose())}
      closeLabel={fixing ? 'Back' : 'Close'}
      wide
    >
      {fixing
        ? (
          <FixMatchBody
            item={fixing}
            onFixed={() => setDone(d => ({ ...d, [fixing.id]: true }))}
            onDone={() => setFixing(null)}
          />
          )
        : (
          <>
            {items === null && <p class='hint center'>Reading the list…</p>}
            {items !== null && left.length === 0 && <p class='hint center'>All done.</p>}
            {left.length > 0 && (
              <p class='hint center'>
                TMDB found nothing for these. Usually the file is not named what the film
                is called, so picking one and searching by its real name is what fixes it.
              </p>
            )}
            <div class='setrows'>
              {left.map(it => (
                <div class='setrow' key={it.id}>
                  <span class='rowmain'>
                    <span class='rowname'>{it.title}</span>
                    <span class='rowsub'>
                      {it.type === 'series' ? 'TV show' : 'Film'}
                      {it.year ? ` · ${it.year}` : ''}
                      {it.reason ? ` · ${it.reason}` : ''}
                    </span>
                  </span>
                  <span class='rowctl'>
                    <button class='ghost' onClick={() => setFixing(it)}>Find it</button>
                  </span>
                </div>
              ))}
            </div>
            <div class='actions'>
              <button class='ghost' onClick={onLookAgain}>Ask TMDB again</button>
            </div>
          </>
          )}
    </Modal>
  )
}

// One plain sentence per outcome, counts only where they earn their place.
function sentence (w) {
  const bits = []
  bits.push(w.wrote > 0
    ? `Saved ${w.wrote} file${w.wrote === 1 ? '' : 's'} beside your films.`
    : 'Nothing new to save.')
  if (w.skippedExisting > 0) bits.push(`${w.skippedExisting} already had an answer on disk and ${w.skippedExisting === 1 ? 'was' : 'were'} left alone.`)
  if (w.skippedUncertain > 0) bits.push(`${w.skippedUncertain} uncertain guess${w.skippedUncertain === 1 ? ' was' : 'es were'} held back. Confirm them from the pencil on their tiles first.`)
  if (w.failed > 0) bits.push(`${w.failed} could not be written.`)
  return bits.join(' ')
}
