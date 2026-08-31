# Library sections: a library's own folders, shown under their own names

Status: PROPOSED. Tier T2: it adds a field to what the wire hands over and changes the
phone's browse screen. It touches nothing on the authorisation surface - a section is a
way of showing what a person can already see, never a way of deciding it.

## Why

Tim, 2026-08-30: a library should be able to have custom sections beyond Films and
Shows, the way his Plex library has four - Movies, Japanese Movies, Television and
Japanese Television. Today PearCinema pools every configured folder into two anonymous
tabs, so a collection organised into named shelves on disk arrives as one undivided
pile.

This is the opposite case from the photos question settled the same day (DECISIONS,
2026-08-30). Photos were refused because nothing this app is built on helps with them.
A section like Japanese Movies is still films with titles and years: the name parser,
the metadata, the transcoder, resume and casting all work on it unchanged. The only
thing missing is that the folder's name is thrown away on the way to the screen.

## What a section is

A section is a configured root, shown under its label. Nothing new is invented:

- Every root already carries a label (the one the sharing tree shows, defaulting to the
  folder's own name) and a `holds` type of films or shows.
- Every item already knows which root it came from - `visibility.js` locates each item
  as `{ root, rel }` for the per-person check.

A section is NOT a folder invented inside the app, separate from the disk. That version
costs a second organisational system, a place to store it and a sync story, and it is
not what the request describes. The disk layout is the sections.

## When sections appear, and when nothing changes

Sections show only when they would mean something: when the items on a tab come from
two or more roots with distinct labels. Otherwise the screen is exactly today's.

- Tim's four folders: the Films tab offers Movies and Japanese Movies, the Shows tab
  offers Television and Japanese Television.
- A library with one root, or one films root and one shows root: no sections, no change.
- The Umbrel's auto-found `external/*/Video` roots share one label, so one distinct
  name, so no sections. Automatic discovery never manufactures shelves nobody named.

## What it looks like on the phone

The two tabs stay. Under the tab bar, a row of chips: All, then the section names in
alphabetical order. Tapping one filters the grid to that section; All is the default
and the choice is remembered. Search and Continue Watching stay global across every
section, because a person looking for a film should not have to know which shelf it is
on. Episodes and seasons follow their show's section.

Chips rather than more tabs, because two tabs are a hand-width and six are not, and
chips degrade to nothing when there is only one section.

## The wire

- Each movie and series gains a `section` field: the label of its root, or for Jellyfin
  the Jellyfin library's name. Episodes inherit their show's.
- `library.list` accepts an optional `section` param that filters to one section, for
  clients that page rather than hold the whole index.
- `library.stats` lists the sections it found: `sections: [{ name, holds }]`.

The phone's merged index needs neither param: it already holds every item, so chips are
a client-side filter in `merge.js`, where the rule is testable.

## Merging across hosts

Sections merge by name. A Japanese Movies folder on the Umbrel and one on the Mac mini
are one chip. When two copies of the same film dedupe across differently named sections,
the merged item counts as belonging to both, so it appears under either chip - a filter
that hides a film somebody owns is worse than one that shows it twice, which is the same
rule search already follows.

## Sharing, narrowing and Jellyfin

- Per-person folders compose for free: a narrowed person's list arrives already
  filtered, so their chips are built from what they can see and never name what they
  cannot.
- Jellyfin libraries already arrive with names and types, so a Jellyfin host gets
  sections with no configuration at all.

## The web player

The dashboard's player gets the same chips, reading the same field. It is the second
opinion from a different engine, and it is cheap because the data is already on the
wire.

## Compat

- An old phone ignores the new field. Nothing breaks.
- An old host sends no field; its items simply appear under All only, and a library
  with no sectioned items shows no chips.
- No config migration: labels and types are already saved on every root in the field.

## Verify

Beyond the suite:

1. A host with four labelled roots: the phone shows the right chips on the right tabs,
   each filters correctly and a show's episodes follow it.
2. A one-root host: no chips, and the screen is pixel-for-pixel today's.
3. Two hosts with a same-named section merge into one chip; a film deduped across two
   differently named sections appears under both.
4. A person narrowed to one folder sees only that folder's chip, or none.
5. A Jellyfin host shows its libraries as sections with no configuration.
6. Old phone against new host and new phone against old host both behave as today.

## Rollback

Stop sending the field and remove the chips. The labels and types were already there
before this proposal and stay after it. No migration in either direction.

## Open questions

1. Chips inside the two tabs, as proposed, or one home screen of shelf rows per section
   the way streaming apps do? Chips are the smaller change and keep the tabs; shelves
   are a bigger redesign that could subsume the tabs entirely.
2. Is one label per root right for both sharing and sections, or should a root's
   section name be settable separately? Proposed: one label, because two names for the
   same folder is a way to confuse the person doing the sharing.
3. Should the remembered chip reset to All when a library changes hosts or a section
   disappears? Proposed: yes, silently.
