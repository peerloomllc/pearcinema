# Per-person folders: choose what each person can see

Status: BUILT 2026-08-30 (PR #225, shared host #14). APPROVED the same day by Tim, with
open question 2 answered the other way: any folder depth is tickable from v1.

VERIFIED against a real host over a real folder tree and a real DHT: 28 of 28 checks in
the list below, including every refusal (list, id, search, counts, art, decide, playlist,
export, subtitles and the stream bytes themselves), a narrowing landing on a live
connection with no reconnect, widening back, an unnarrowed second person unaffected, and
revoke still cutting a narrowed device off. Open question 1 (guest windows) and the
pairing-flow choice are NOT built: a person is narrowed after they are let in. Tier T3: it adds a rule to the authorisation surface, and a
rule that lets one film through by mistake is a security bug of the same class as the two
inherited ones in CLAUDE.md.

## Why

A grant today is all or nothing. Let a person in and they see the whole library: every
drive, every folder, the kids' films and everything else. Tim, 2026-08-29: the
possibility of narrowing that per person, at the drive or folder level, by kind, by title
or by rating. Discussed 2026-08-30 and reduced to the first shape, because it is the one
that is always answerable (every file has a path), the one that matches how libraries are
actually organised (a Kids drive, a Family folder) and the one the grant record was
already built to hold: `paths` has been a reserved null on every grant since the store
was designed, "so library-subset scopes are a value change, not a schema migration".

The other shapes are not rejected, only later: an age-rating ceiling needs data most
libraries do not have (`mpaa` arrives only from `.nfo` sidecars today), a films-or-shows
switch is trivial once this plumbing exists, and hand-picked title lists do not scale to
a 16,000-file library. The design below leaves room for the rating layer and says where.

## What it looks like

On the dashboard's People page, each person gets one line under their name:

    Can see: everything

Tapping it opens a tree of the library's roots (each `--folder`, `--movies` and
`--shows` root, by the label the person gave it) and the folders under them, to any
depth, each folder opening on demand. Ticks. A ticked folder covers everything beneath
it. "Everything" is the default and the state of every existing grant. Untick the Kids
drive's sibling and Sam sees the Kids drive only; tick one season folder inside a show
and Sam sees that season.

A guest window and a pairing link can carry the same choice, so a person can be let in
narrowly from the start rather than let in and then narrowed.

The owner's own devices are never filtered, and the People page never offers the control
for them.

The phone sees a smaller library and nothing else. It is not told there is more. A
merged view across libraries simply has fewer copies of things.

## Where the rule lives

On the grant, per person. `grant.paths` becomes either `null` (everything, as today) or a
list of root-relative prefixes: `["kids/", "family/Holiday films/"]`, each anchored to a
root by that root's id so a drive that moves mount point does not silently reopen or
close a person's view. Every device of the person carries the same value, the way scope
does, and the store stays host-local and never replicated.

The check is ONE function in ONE place:

    visibleTo(grant, item) -> boolean

`item` must know where it came from. The folder adapter already keeps `_file` on every
item; this adds a canonical `{ rootId, rel }` pair beside it at scan time, so the check
is a prefix comparison and never touches the disk. `null` paths returns true at once;
owner scope returns true at once.

## The chokepoint, and why it is a list of methods

The rule must hold on every way of reaching content, not just the list, or a hidden film
is still one guessed id away. The wire methods that hand out content today, read off
`host/methods.js`:

    library.stats  library.list  library.search  library.get  library.siblings
    art.get
    media.decide  media.playlist  media.segment  media.init  media.export
    subtitle.list  subtitle.get
    cast.list  cast.play  cast.stop  cast.pause  cast.resume  cast.seek  cast.state
    resume.set  (and the resume, watched, favourite and request lists that ride the
    person's own state: a hidden film's rows are filtered on the way out, never deleted)

And `media.stream`, which is built into `@peerloom/host` and served by `openStream`.

Rather than sprinkle `visibleTo` across twenty handlers, the adapter is wrapped once per
call: `ctx.adapter` becomes a view of the real adapter that applies `visibleTo` to every
`get`, `list`, `search` and `siblings` result and returns "no such item" for a hidden id.
Every handler above already reads items through the adapter, so a hidden film is not
found, not listed, not streamed, not cast and has no art. `openStream` and `openRemux`
take the same wrapped adapter. The counts in `library.stats` come from the filtered list.

Casting is the one path that is not a HyperDHT connection (CLAUDE.md, the third rule).
A cast started before a narrowing keeps playing; the narrowing does not stop it, exactly
as revoke has to stop it actively. This proposal does not stop live casts on narrowing,
and says so: narrowing is not revoke. Revoke still does what it does.

## Downloads already on the phone

A person's phone may hold a downloaded copy of a film that is later hidden from them.
The download plays with no host asked, off disk. Two honest choices:

1. Leave it. The person was allowed the film when they took it.
2. Treat a narrowing like a per-film revoke: the phone learns the hidden ids on its next
   connect and refuses the local copy, the way `revoked.js` refuses a revoked library's.

This proposal takes 1 for v1 and records why: the host cannot reach a phone that is
offline to enforce 2, so 2 is at best eventual, and a rule that is "sometimes" enforced
reads as a bug. The People page says so in one line when a narrowing is saved: "Films
this person has already downloaded stay on their phone." If that turns out to be wrong
in the field, 2 is a follow-up that reuses the revoke plumbing.

## Jellyfin and Emby

A Jellyfin item has no file path the host owns; it has Jellyfin's library and folder ids.
The same `{ rootId, rel }` shape carries them: root is the Jellyfin library
(`Movies`, `Kids`), rel is the item's parent path within it as Jellyfin reports it. The
People page lists Jellyfin libraries the way it lists folder roots. Same check, same
chokepoint.

## The rating layer, designed in and not built

`visibleTo` is the seam. A later `grant.ratingCeiling` is one more clause in the same
function, reading `item.mpaa` where a sidecar supplied it and honouring a per-person
`hideUnrated` switch where it did not. Nothing in this proposal has to change for that;
it is why the check is a function on the grant and not a filter on the folder walk.

## Compat

- `grant.paths` is already a field on every grant, null. Old hosts ignore it, old phones
  never see it. A phone needs no change.
- The dashboard and the pairing flow gain a control; a host without the control (an
  older desktop app) still enforces null, which is everything, which is today.
- The wire shape does not change. A filtered list is a list.

## Verify

Beyond the suite:

1. Two people, one narrowed to `kids/`. Through the narrowed person's device:
   `library.list` shows only kids' films; `library.get` on a hidden id says no such item;
   `media.stream` of a hidden id returns nothing; `art.get` returns nothing;
   `cast.play` of a hidden id is refused; search for a hidden title finds nothing;
   `library.stats` counts only what is visible.
2. The owner's device, same host, sees everything, and the People page offers no control
   for the owner.
3. Narrow while the narrowed person is connected: the next list call is already filtered
   (the wrapped adapter is built per call, not per session).
4. A downloaded copy of a now-hidden film still plays on that phone, and the People page
   said so when the narrowing was saved.
5. A Jellyfin library, narrowed to one Jellyfin library: the same eight checks.
6. The acceptance line from CLAUDE.md still holds: revoke cuts off all new access within
   a second, narrowed or not.

## Rollback

Set every `paths` back to null on the People page, or delete the field: the check
returns true and the host is exactly today's. No migration in either direction.

## Open questions

1. Should a guest window default to narrowed (a guest sees only what was chosen) or to
   everything, as today? Recommendation: everything, and the pairing dialog offers the
   choice, so nobody is surprised by a guest seeing less than they were told.
2. Is the top-level-folder granularity enough, or should any depth be tickable?
   ANSWERED 2026-08-30 (Tim): any depth in v1. The field is a prefix list, so this is
   the tree control opening folders on demand rather than any change to the check.
3. Whether "narrowing is not revoke" for downloads survives the first real use.
