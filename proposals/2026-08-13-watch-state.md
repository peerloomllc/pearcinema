# Continue watching, and a watched badge, per person

**Goal.** A film or episode remembers where you stopped and whether you have finished it,
for the PERSON rather than the device, so putting a phone down and picking a laptop up
continues the same film.

**Tier: T2.** New Hyperbee keys (`resume:`, `watched:`), new methods on `<app>/media/1`, and
a new persisted identity for the browser. No wire-protocol change: the channel, the framing
and the error contract are untouched, and an old client that never calls the new methods is
unaffected.

Requested by Tim, 2026-08-13: *"there should be watched indicators/badges (similar to how
Plex keeps track). It would be per User (not device), similar to how we are keeping track of
queues/playlists/favorites in PearTune (one user can have multiple devices)."*

---

## What is inherited, and what is genuinely new

**Inherited from PearTune, and it must not be rewritten.** `peartune/host/state.js` already
holds per-person resume positions, keyed the way this needs, with three properties that were
each paid for by a bug:

- **The owner comes from the connection, never from a parameter.** `ownerOf(grant)` is
  `p:{personId}` for a device assigned to a person and `d:{deviceKey}` for one that is not.
  A client cannot write as somebody else because it cannot say who it is.
- **The host stamps `updatedAt`**, so a client cannot backdate a write, and there is exactly
  one writer so there is no conflict resolution to get wrong.
- **`playedAt` is separate from `updatedAt`**, and that distinction came from a real bug
  (`proposal 2026-07-30-one-device-plays`): a phone reconnecting after a flight flushed an
  offline outbox and put its hours-old positions in FRONT of the device playing right now.
  Continue-watching orders by when the device WATCHED, not when the write landed.

**New here, and this is the actual work:**

1. **The extraction itself** - phase 3 of the approved `@peerloom/host` split. The store is
   genuinely shared behaviour wrapped around an app-specific vocabulary (`track`/`album`/
   `artist` becomes `movie`/`episode`/`series`), so it needs the treatment `ids` got rather
   than a straight move.
2. **Watched is not a play count.** PearTune increments a count when a track starts. A film
   that starts is not a film that has been watched, and the whole point of the badge is that
   it is trustworthy.
3. **A show is watched when its episodes are**, which is a rollup over a tree PearTune has
   no equivalent of - a music library has no "3 unwatched" state.
4. **The browser has no identity at all.** Every phone arrives with a grant; the dashboard
   arrives with a password. This is the hard part and it is discussed on its own below.

---

## Scope

### P1 - `@peerloom/host` phase 3: the state store

Move `host/state.js` into the package with the kind vocabulary passed in rather than baked:

```
createState({ bee, kinds: ['movie', 'episode', 'series', 'season'] })
```

`fav:`, `count:`, `playlist:` and the request store come across unchanged in shape even
where PearCinema does not use them yet - splitting the file would leave PearTune's migration
straddling two versions of the same store, which is the divergence the extraction exists to
prevent.

**Not moving:** the Preact dashboard (open question 3 of the shared-host proposal, still
unanswered) and `cast.js`.

**Watch `test/brand-compat.test.js`.** It pins PearTune's protocol strings and id hash
preimages as literals. Breaking them orphans every phone in the field, silently.

### P2 - resume positions

```
resume:{ownerId}:{itemId} -> { itemId, positionMs, durationMs, updatedAt, playedAt, deviceKey }
```

Verbatim from the donor including the delete-at-zero rule: **a position of 0 is a DELETE**,
so finishing something leaves no row and it starts fresh next time.

Methods: `resume.set`, `resume.get`, `resume.list` (the continue-watching row).

`resume.set` is the first entry in `MUTATING`, which `host/methods.js` already predicts by
name. A readonly grant cannot write one, refused at the package's chokepoint rather than
inside a handler.

**The client decides when to write, and the answer is not "on every timeupdate".** A
two-hour film at 4 Hz is 28,800 writes. Every 15 seconds, on pause, and on close.

### P3 - watched

```
watched:{ownerId}:{itemId} -> { itemId, on, at, auto }
```

A flag rather than a count, because **the user must be able to say "no, I have not seen
this"** - Plex's "mark as unwatched" is the affordance people reach for when a housemate
watched an episode on their login. A count cannot be un-incremented honestly.

`auto` records whether the host marked it or a person did, so a future change to the
threshold below can leave hand-marked rows alone.

**What marks something watched:** reaching **95%** of the runtime, or the player firing
`ended`. Not "started". Ninety-five percent rather than a hundred because nobody watches the
credits, and a film that stops at 97% and never marks itself is exactly the kind of small
lie that makes a badge untrustworthy.

**Watching to the end also deletes the resume row**, so a finished film does not sit in
continue-watching wearing a watched badge. That falls out of the donor's delete-at-zero rule
and is worth stating so nobody re-adds it.

**A series and a season are DERIVED, never stored.** A show is watched when every episode
is; the badge on a show is an unwatched COUNT, which is what Plex shows and what is actually
useful. Storing a rollup would mean two sources of truth for the same question and a
reconciliation job the first time an episode is added to a folder.

### P4 - the UI

- A **Continue watching** row at the top of the library, most recent first.
- A **resume bar** across the bottom of a poster, the way Plex draws it.
- A **watched tick** on a finished film or episode, and an **unwatched count** on a show.
- **Mark as watched / unwatched** on any item, because the automatic rule will be wrong
  sometimes and the correction has to be one click.
- Opening something with a resume position offers **Resume** and **Start over**. It does not
  silently jump - a viewer who wanted the beginning should not have to scrub back.

---

## The browser has no identity, and that is the real design question

Every phone arrives with a grant, so `ownerOf` answers for free. The dashboard arrives with
a password and nothing else. DECISIONS 2026-08-13 settled deliberately that **the web
interface is the operator's dashboard with playback added, not a second client** - no
accounts, no per-user state - and this proposal is the first thing that needs that decision
revisited rather than merely extended.

**Recommendation: the dashboard watches AS A PERSON, chosen in the dashboard.**

- The `person:` rows already exist and are already the unit the operator manages.
- On first use, if no person exists, create one from the library owner and select it. A
  household with one person never sees a choice.
- Where several people exist, the dashboard shows a **Watching as** control. That is
  Netflix's "who is watching", and on a shared laptop it is the difference between a useful
  badge and a wrong one.
- The choice is a **cookie on the browser**, not a new stored identity. It selects an
  existing person; it does not become one.

**What this does NOT change**, and the boundary matters:

- **The browser still holds no grant and revoke still does not reach it.** Selecting a
  person to watch as is not authentication. Anyone with the dashboard password can already
  see the whole library; letting them attribute a watch position to a person adds no access.
- **A person's watch state is not private from the operator.** It never was - the operator
  owns the box - and the dashboard must not imply otherwise by dressing the selector up as a
  login.

**The rejected alternative** is a per-browser identity (`b:{cookie}`), which is cheap and
wrong: it is exactly the per-device state Tim asked not to have, and a laptop and a phone
belonging to the same person would disagree about a film they were watching together.

---

## Compat

- **Old clients:** the new methods are additive. A client that never calls `resume.set` gets
  the library it always got. `identity.get` is unchanged, so nothing has to negotiate.
- **Old rows:** there are none. PearCinema has never written state, so this is a clean
  first write rather than a migration. PearTune's rows are in PearTune's own store under its
  own library id and are not read here.
- **The scan cache is untouched.** Watch state lives in the host's Hyperbee beside the
  grants, not in `folder-scan.json`, so adding it forces no rescan of a 3 TB drive. This is
  worth stating because three cache versions were burned in one day for other reasons.
- **Revoke:** watch state SURVIVES a revoke, matching the donor's treatment of counts. It is
  history, not access. A device that comes back to the same person finds its positions.
- **A deleted person** takes their watch state with them. That is the only destructive path
  and it needs the same confirmation the dashboard already uses for revoke.

---

## Verify

- **The unit level:** the store's own tests come across with it, plus new ones for the
  95% rule, the delete-at-zero interaction and the series rollup.
- **The measurement that matters:** against the real library on the Umbrel, watch three
  minutes of an episode in the browser, close the tab, reopen it, and land back at three
  minutes. Then finish it and watch the badge appear and the continue-watching row drop it.
- **The per-person claim** cannot be proven from one browser. It needs the SECOND client to
  exist - so the honest verification is: two browsers, two different people selected,
  watching the same film, and two independent positions. Cross-device-per-person is proven
  properly only when there is a phone, and that is stated rather than papered over.
- **A show's unwatched count** against a real season of 24 episodes, not a fixture of two.

---

## Rollback

The store is additive and nothing reads it unless the UI asks. Backing out is reverting the
UI, which leaves rows nobody queries - harmless and small. The extraction is the piece with
a blast radius, and it rolls back the way phases 1 and 2 did: the package is a `file:`
dependency, so a revert of both repos is one commit each.

---

## Open questions

1. **Does the dashboard get a "Watching as" control in this cut, or only the auto-created
   owner person?** The control is the honest answer for a shared machine and it is a real
   piece of UI. Recommendation: auto-create the owner person now, ship the selector the
   moment a second person exists on the box, so a single-person household never meets it.

2. **Should a guest-scoped device write watch state at all?** A time-limited guest pass
   leaves rows behind that outlive the pass. Recommendation: yes, write them - they are
   keyed to the person and a guest who returns is the same person - but say so in the
   dashboard rather than leaving it as a surprise.

3. **What happens to a resume position when a file is replaced?** Ids are derived from the
   path relative to the root, so re-encoding a film in place keeps its id and its position
   even though the runtime changed. A position past the new end has to clamp rather than
   fail. Recommendation: clamp, and treat a position within 5% of the end as finished.

4. **Does continue-watching cross the film/episode line?** Plex shows "up next" for a show -
   finish S01E01 and S01E02 appears. Recommendation: NOT in this cut. It is a genuinely
   separate feature (it needs the next-episode lookup, not the resume store) and folding it
   in is how a two-week piece becomes a month.
