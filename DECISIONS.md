# PearCinema decisions

Append-only, newest on top. Per Constitution §4.

## 2026-08-14 (latest) - THE MOBILE APP STARTS WITH AN EXTRACTION, not a copy: @peerloom/client is APPROVED
Tier: T3 (client-side pairing and connection code moves into a shared package)
Context: Tim said "let's work on the mobile app". The 2026-08-14 survey of PearTune's
phone stack found ~2,300 lines of app-agnostic client plumbing - the pairing client,
the localhost streaming shim, the host list, reconnect, the offline write queue -
duplicated per app and packaged nowhere. PearCinema would have been the third copy of
security-critical client code.

Choice: extract `@peerloom/client` first, PearCinema as first consumer, exactly the
shared-host playbook. Proposal at `../proposals/2026-08-14-shared-client.md`, approved
by Tim the same day, verbally per the suite-root convention. The parts that matter:

- **The wire protocol is not copied even into the package** - `@peerloom/client`
  depends on `@peerloom/host`'s existing `./protocol` export, so the suite keeps ONE
  implementation of the wire format.
- **PearTune is untouched** and migrates on a branch later, after the iOS 1.0.0 review
  outcome - the same posture the host extraction took, with brand-compat pins so the
  eventual migration cannot silently orphan a paired phone.
- **Bare AND Node, deliberately**, because the package running in Node IS the plan for
  the desktop-as-client roadmap item: the desktop app consumes this same package
  rather than growing a second DHT client.
- Rejected: copy-and-adapt (fastest to first pixel, and the fourth copy-fork of the
  suite on the code where divergence is a security problem) and copy-now-extract-later
  (later never came for @peerloom/core's donors).

## 2026-08-14 - ARTWORK APPLIES ITS BEST GUESS, and the correction lives on the tile
Tier: T1 (matching policy and dashboard flow; no wire change)
Context: Tim ran the caution-first cut against his real library and rejected the
process: 79 titles held back as a homework list of prompts in Settings, before any of
their artwork appeared. His words - best effort the matching, notice that some may be
wrong, and "on the artwork/tiles there should be an edit icon/button in the corner" -
with Plex's Fix Match named as the reference.

**Supersedes the previous entry's matching section.** Every lookup now applies its
best candidate - exact-title-with-year first, then exact title, then TMDB's own first
result - and records `uncertain` where it was a guess. The panel and the notice count
the guesses honestly; nobody is quizzed. On his library: the 79 held-back titles
resolved to guesses in one pass, 237 matched in all, 27 with nothing.

**The fix is where the mistake is visible.** A pencil in the tile's corner (opposite
the watched tick, hover-revealed like it) opens a fix-match dialog: the lookup rerun,
optionally with the operator's own words - the filename being wrong is usually the
whole problem - a pick applied, or the fetched artwork dropped. The chosen poster is
fetched fresh by TMDB id; nothing from the page is trusted but the id. A fixed match
is never `uncertain`, because a person chose it. An unmatched item is remembered so
the next automatic pass does not re-guess it.

**The candidates are picked BY EYE, and their thumbnails come through the host.**
The poster is the thing being chosen, so the dialog shows posters rather than a text
list asking somebody to recognise a film by its year. The thumbnails are RELAYED by
the host (`/api/metadata/preview`, path shape pinned to TMDB's own), because the
panel's promise is that the HOST talks to TMDB - a page that hotlinked
image.tmdb.org would make every operator's browser talk to them too.

**Progress is where the result lands.** The pass reports on the LIBRARY page - the
page whose posters are filling in - riding the /api/state poll that already exists,
and the lists refetch when the pass completes so posters arrive while somebody
watches. The pencil only shows where artwork came from the lookup or is absent:
a poster beside the file on disk is not this feature's to change.

**And the step joined the first-run wizard** (Tim, same day), right after the source:
the moment somebody points at their films is the moment a wall of grey placeholders
is coming. Skippable, embedded from the same panel Settings uses.

## 2026-08-13 - ONLINE ARTWORK IS BUILT CAUTION-FIRST, and the key question is REOPENED
Tier: T1 (host-local cache and routes; no wire change, no Hyperbee change)
Context: the opt-in TMDB item, whose design calls were fixed 2026-08-12: operator's own
key, TMDB only, sidecar always wins, default off, cache in the data dir, the dashboard
saying plainly that the host tells a third party what titles it is identifying.

**Matching applies itself only when it cannot be wrong.** An exact normalised title
with the year agreeing (rips are routinely off by one), or a search returning exactly
one thing. Everything else - the two films called Crash, the two called Solaris -
becomes a PENDING match holding the candidates, for the operator to pick from or
dismiss. A wrong poster on somebody's film is worse than a placeholder, and a
filename is not always what a film is called.

**Sidecar-wins is enforced structurally, not by policy.** The enrichment is a Proxy
over the adapter that fills `artId` ONLY where there is none, with a copy rather
than a mutation (adapters cache their item objects, and a poisoned cache would
survive the feature being turned off). Both transports see the same decorated
adapter, so a browser and a phone cannot disagree about which films have posters.
The pass itself walks the INNER adapter, so "has artwork" means artwork on disk
rather than artwork the last pass invented.

**Both credential shapes work without asking which.** TMDB's key page offers a short
v3 key and a long v4 token; the long one is a JWT so it starts with `eyJ`, and that
is the whole detection. Asking an operator which kind they copied is a support
ticket.

**The pass is remembered, including its failures.** Matched, pending, dismissed and
missed all persist, so a restart re-fetches nothing and a dismissed row stays
dismissed. "Look again" retries the misses explicitly. The whole store is
disposable - deleting it costs a re-fetch and nothing else.

### The key model is REOPENED (Tim, 2026-08-13)

Tim asked whether a shared key he obtains - shipped with the app, used by every
install - would be easier than bring-your-own. The honest facts: TMDB is free for
this use and rate-limits per network address, so installs do not share a bucket;
embedding an application key is normal practice among open-source media apps. The
two real costs of a shared key: it is public forever once shipped, and a TMDB
revocation blacks out artwork for every install at once, with his account on the
hook. **Undecided: Tim is obtaining a key himself first to feel the signup
friction before choosing.** The build works for either outcome - a shipped default
key would be additive and the override field already exists.

## 2026-08-13 - MEASURED: the N100's video engine holds ten 1080p HEVC transcodes, and the FREE driver is enough
Tier: T2 (a measurement that sizes a proposed T3; no code change)
Context: the hardware transcode TODO item said to measure concurrent 1080p HEVC to H.264
on this hardware before promising anything, because the capacity doc's audio-era numbers
do not transfer and say so. Taken 2026-08-13 in a throwaway container built from the
shipped PearCinema image with `/dev/dri` passed in, against real episodes off the
Elements drive, on the loaded box with its usual containers running.

**The driver gap is smaller than the TODO believed.** The item said the image was missing
`iHD_drv_video.so` and named the non-free package as the likely fix. Measured: the FREE
`intel-media-va-driver` from Debian main is sufficient on the N100 - full decode and
encode entrypoints including HEVC Main 10 decode and H.264 encode, 7.7x realtime. The
image needs one package from a component it already uses, no non-free apt source.

**The library's HEVC is 10-bit.** Every x265 episode sampled is Main 10 `yuv420p10le`.
Any transcode path that only handled 8-bit would miss the common case, not the edge. The
VAAPI pipeline converts 10-bit to 8-bit on the engine as part of the scale stage
(`scale_vaapi=format=nv12`), measured working.

The numbers, 1080p 10-bit HEVC in, H.264 at 6 Mbps out, full-hardware pipeline:

```
1 stream    7.3x realtime
2 streams   all realtime, aggregate 10.4x
4 streams   all realtime, aggregate 10.7x
8 streams   all realtime (300s of content in 227.6s), aggregate 10.5x
software    1.02x realtime for ONE stream, the whole 4-core CPU
```

The engine saturates at roughly **10.5x realtime aggregate and holds it flat from 2
streams to 8**, so the practical ceiling is about ten concurrent 1080p transcodes. CPU
during the 8-stream run was about a third of one core - the video engine does the work
and the host's Node loop is undisturbed.

**The software row is the design rule.** A CPU encode of the same file barely keeps one
viewer at realtime with nothing left for the host itself, on the strongest box this is
likely to run on. That is why the proposal this sizes makes "software encoding never
starts" a hard rule rather than a default.

Recorded alongside `proposals/2026-08-13-hardware-transcode.md`, which carries the five
start rules these numbers shaped.

## 2026-08-13 - THE LOOK MOVES TOWARD PEARTUNE, and the movement says which way you went
Tier: T1 (appearance and navigation; no stored data, no wire change)
Context: Tim, having spent an afternoon looking at this UI - four asks at once. Move the
look toward PearTune; load lists by scrolling rather than a button; animate between
screens; and give an episode a way back up its own hierarchy.

**The palette is PearTune's on a darker ground.** Its amber and terracotta, its warm greys,
its radial glow at the top of the page - so the two read as one suite at a glance, which is
what a companion app is for. What is deliberately not copied is the LIGHTNESS: PearTune's
ground is a warm near-black for a dashboard you glance at, and this one sits behind a film,
so it goes darker and lets the picture be the brightest thing on screen.

Token NAMES stay as PearCinema had them rather than being renamed to PearTune's. A rename
touches every rule in the file for no visible gain, and shared ground belongs in the
extracted package rather than in a copied stylesheet.

**The emoji are gone.** Every platform draws its own, in its own colours, at its own weight,
so a page that mixes them with real interface reads as half-finished. Inline SVG at
`currentColor` - inline rather than a font because the dashboard is one self-contained file
by design, and an icon font is a second asset plus a flash of nothing while it loads. The
set is small on purpose: an icon that has to be explained is worse than the word it replaced.

The MARK is drawn rather than borrowed - a pear with a film frame's perforations. PearTune's
mark is PearTune's, and a companion app wearing it would be claiming to be the same app.

### The movement says which way you went

Chosen by Tim from four options in a clickable prototype rather than from a description,
because motion cannot be judged from prose. **Deeper slides in from the right, back slides
in from the left.** A cross-fade says only that something changed; this says where you are,
which is the actual difficulty in a library four levels deep - and it is the idiom a phone
already uses, so it will still be right when there is a phone app.

The runner-up, and worth recording because it will come up again: the clicked poster flying
out and becoming the screen. More film-like, and it answers "which one did I click" during
the wait. It costs measurement of a live element and a fixed overlay, and it is the one that
looks worst when a machine is slow.

### The list loads itself

A "Load more" button asks a question the page already knows the answer to. An
IntersectionObserver on a marker at the bottom, with a 600px margin so the next page is
already in flight before anybody reaches the end. Guarded by a REF rather than the busy
flag: state is asynchronous, and two observer callbacks in one frame would both read
`false` and fetch the same page twice.

### An episode can climb out one level at a time

A film has one place to go and "back to the library" says it. An episode is four levels
down, and offering only the way to the very top means anybody who wanted the rest of the
season walks back in from Shows. The player now draws the same crumbs the library does, and
they put the library back where they left it.

## 2026-08-13 - A SEASON GETS A BADGE TOO, and marking by hand lives on the thing itself
Tier: T1 (an existing rollup applied to a second level, and an existing write reached from
more places)
Context: Tim, on reading the up-next work - "what about an indicator on the season tile to
say if all have been watched and also to show one that is in progress? Additionally, would
be nice to have the capability to manually mark something as watched/unwatched, like in
Plex."

Both were real gaps. The rollup existed and was only ever applied to a SHOW, and marking by
hand existed but only inside the player, which is the one place somebody is not when they
realise the badge is wrong.

**A season now answers the same question a show does** - a count of what is left, or a tick
when there is nothing left to say. It is asked for while a show is open, the same shape and
for the same reason as the show rollup: computing it walks episodes, which is free on a
folder source and one HTTP call per season on a Jellyfin one.

**Nothing is reported before anybody has watched anything.** A brand-new library would
otherwise put "24 left" on every season the day it is installed, which is noise rather than
information.

### Marking a CONTAINER marks its episodes, because that is all it could mean

A show is not watched in its own right - it is watched when its episodes are. A flag on the
container would be a second source of truth that disagrees with the count on its own tile
the first time an episode lands in a folder. So marking a season or a show writes every
episode underneath, and unmarking clears them all.

### The tile stopped being a `<button>`, and that is not cosmetic

A button inside a button is invalid HTML and browsers do not agree about which one a click
reaches. The tick is now a real control sitting on the poster, so the poster became a `div`
with the keyboard behaviour a button had. The alternative - a context menu - is a second
interaction to discover, for something that should cost one click.

### The one you are in the middle of, and the bug in the first attempt

A count of what is left cannot say which season somebody is watching: an untouched season
and a half-done one both just show a number. So a started-and-unfinished container is marked
on the tile.

**The first attempt got it wrong in the way that mattered most.** It computed "started" from
the WATCHED set alone - and Tim found it immediately by starting the X-Files pilot: the
episode was on the continue-watching shelf, and Season 1 said nothing at all. A season
somebody is half way through episode one of has **no finished episodes**, so a rollup
counting only those reports the exact season they are watching as untouched.

The rollup now takes the resume ids as well and carries `inProgress` and `started` beside
the counts. `unwatched` still means what it always meant - how many you have not FINISHED -
so a part-watched episode is not quietly counted as done.

### Three visual corrections, and one process lesson worth more than them

The marker took four passes, all of them found by Tim looking at it rather than by a test:
a box-shadow that enclosed the caption, a conic gradient whose bright arc vanished at each
corner (a gradient sweeps by ANGLE; a rounded rectangle's edge does not), a ring with no
positioning context so it sized itself to the whole tile again, and an outline a pixel shy
of the artwork because `overflow: hidden` clips to the padding box. It is now a dash
travelling a real rounded-rectangle path with `pathLength=100`, and the artwork's own border
steps aside so the ring IS the edge.

**The lesson is about the preview, not the CSS.** I hand-copied a slice of the stylesheet
into a standalone page to show him, and wrote `position: relative` into that copy without
noticing it was missing from the real one - so the preview looked perfect while the app was
broken, and he found it. A preview built from a subset of the thing it previews is not a
preview. It is generated from the whole stylesheet now, unedited.

### Verified on the real library

```
Tim's own state, after he reported it:
  pilot on the shelf   Season 1  started, 1 in progress, 0 watched, 24 left
                       Season 2  not started
                       The X-Files  started

Season 1 (24 episodes)  mark watched -> 24 items, complete
Season 2                             -> untouched, 25 left
The X-Files                          -> 24 of 201 watched
up next                              -> "little green men", season 2 episode 1
unmark the season                    -> 24 unwatched again
```

### And the test suite was hanging, which was not a leak

`npm test` stalled about one run in three, and every test that ran passed - the last files
scheduled simply never reported. **`node --test` defaults to one worker per core** (12 on
this machine) and several files spawn real ffmpeg processes and real 3-node HyperDHT
testnets. Twelve at once is several times oversubscribed, and the DHT ones are timing
sensitive enough to stop making progress altogether.

Capped at four workers: **14 seconds against a run that looked hung.** Worth recording
because it presented as a hang rather than a failure, and the reflex there is to raise a
timeout rather than to look.

## 2026-08-13 - UP NEXT: finish an episode and the next one is waiting
Tier: T1 (a lookup over data that already exists, on an existing route)
Context: open question 4 of the watch-state proposal, which recommended leaving it out of
that cut - "it needs the next-episode lookup rather than the resume store, and folding it in
is how a two-week piece becomes a month". Built straight after, on Tim's call.

**Choice: the first UNWATCHED episode of a show somebody recently finished something in.**

Three rules, each of which stops a wrong card going up:

- **The same episode is never offered twice.** Half way through S01E02 it is already on the
  shelf under its own name with a bar showing how far through; a "Next: S01E02" card beside
  it is worse than offering nothing.
- **A gap is not skipped.** Somebody who watched 1 and 3 has not seen 2, and calling 4 the
  next one quietly writes off an episode they never saw.
- **A finished show stops appearing** rather than looping back to episode one.

### Bounded by RECENCY, not by the library

Answering "what is next" for every show would walk every series' episodes - free on a folder
source, one HTTP call per show on a Jellyfin one. So it looks only at shows the person
recently finished something in, which is a handful rather than the twenty-eight on the real
drive, and it needed one new thing in the store: `recentWatched`, because a Set of watched
ids cannot answer "which show did they just finish an episode of".

### Verified on the real library

```
before finishing  -> continue: [deep throat, 2001]   up next: []
after finishing   -> continue: [2001]                up next: [squeeze]
```

`deep throat` was half-watched, so it was on the shelf under its own name and nothing was
offered. Finishing it moved it off and put episode three up.

## 2026-08-13 - CONTINUE WATCHING, and a watched badge, per person
Tier: T2 (new Hyperbee keys, new methods, and an identity the browser did not have)
Context: approved as `proposals/2026-08-13-watch-state.md`, requested by Tim - watched
indicators like Plex keeps, **per user rather than per device**, the way PearTune already
holds favourites and playlists.

The store came across whole from PearTune (`@peerloom/host` phase 3). What was decided here
is the part that is about video rather than about storage.

### Watched is a FLAG at 95%, not a play count and not 100%

PearTune increments a count when a track STARTS. A film that starts is not a film that has
been watched, and a badge is only worth having if it is trustworthy - the whole point is to
answer "have I seen this" without thinking about it. So it is a flag, and it is set at 95%
of the runtime or when the player says `ended`.

Ninety-five rather than a hundred because **nobody watches the credits**. A film that stops
at 97% and never marks itself is exactly the small lie that makes people stop trusting the
tick.

The same threshold decides the other half: past it there is nothing to resume, so the
position is dropped. A finished film sitting at the top of continue-watching wearing a
watched badge is the state this avoids, and it falls out of the store's inherited
delete-at-zero rule rather than needing a rule of its own.

**And it can be taken back by hand.** "No, I have not seen this" is the affordance everybody
reaches for when a housemate watched an episode, and a count cannot honestly be
un-incremented. `auto` records who decided, so a later change to where the end is cannot
silently overrule somebody's own mark.

### The first minute is not watching it

Below 60 seconds nothing is remembered. A continue-watching row full of things nobody
actually began is a row people stop reading.

### A series and a season are DERIVED, never stored

A show's badge is a count of what is LEFT - "3 left" tells somebody to open it, a tick does
not. Storing a rollup would mean two sources of truth for the same question and a
reconciliation job the first time an episode lands in a folder.

It is answered by its own route rather than folded into the call every library page makes,
because computing it walks every series' episodes: free on a folder library, one HTTP call
per show on a Jellyfin one. So it is asked for only while the shows list is on screen.

### THE BROWSER NOW WATCHES AS A PERSON, and that revisits an earlier decision

DECISIONS 2026-08-13 settled deliberately that the web interface is the operator's dashboard
with playback added, **not a second client** - no accounts, no per-user state. Per-person
watch state is the first thing that needed that revisited rather than merely extended.

**Choice: the dashboard watches as one of the `person:` rows the operator already manages.**
Auto-created on first use and named "Me", so a household of one is never asked a question
with one answer; a "Watching as" control appears only once a second person exists (Tim's
call). Several people and no choice made means it ASKS - filing a film under the wrong
person is worse than filing it under nobody.

**It is not authentication and must not be dressed up as one.** Anybody with the dashboard
password already sees the whole library; choosing a person only decides whose history a
position lands in. The cookie selects an existing person and never becomes one, so there is
no second identity system - and it is separate from the session cookie, because logging out
should not forget who was watching.

**The rejected alternative** was a per-browser cookie identity, which is cheap and is exactly
the per-device state the request asked not to have: a laptop and a phone belonging to one
person would disagree about a film they were watching together.

**A consequence that had to be built:** people only existed once a paired device claimed a
name. That is fine while a person is a way to group devices and wrong the moment watch state
is per person - a household watching on one laptop could never make a second person, so the
chooser could never appear. The operator can now add one directly.

### Verified against the real library

Not on this laptop. On the Umbrel, through the dashboard, on a real 48-minute episode:

```
8 minutes in     -> continue watching shows it at 480000 ms
97% of runtime   -> watched, and the shelf drops it
a second episode -> the shelf shows that one instead
The X-Files      -> 201 episodes, 1 watched, 200 left
two people       -> Me sees 1 watched, Ben sees 0, same browser same password
```

The cache was **not** touched: watch state lives in the host's own Hyperbee beside the
grants, so this forced no rescan of the 3 TB drive - unlike the three cache versions burned
earlier the same day.

**What is NOT proven yet, and cannot be:** that one PERSON's two DEVICES share a position.
Two people on one browser proves the rows are independent; picking a phone up where a laptop
stopped needs a phone. The design makes it free - both devices resolve to the same
`ownerId` against the same store - but free is not the same as demonstrated.

## 2026-08-13 - THE SUBTITLES INSIDE THE FILE, and the two halves of a library fail in opposite ways
Tier: T2 (a new ffmpeg path on the host, and a third cache version in one day)
Context: TODO carried this as "expect the PGS refusal to be the COMMON case on films - make
sure the UI reaches for the external `.srt` files FIRST". Half of that was already shipped:
the player has sorted external before embedded since PR #10. The other half turned out to
be that **the folder adapter never read inside a file at all.** It listed what sat beside a
film on disk and nothing within it.

The measurement (DECISIONS 2026-08-12) says why that matters, and why it matters differently
on each half of a collection:

```
MOVIES   232 image tracks across 240 films, and only 57 text
TV     1,429 image against 2,715 TEXT
```

- **On the films, the answer is almost always no.** A PGS track is a sequence of pictures
  and showing one means drawing it into the video - a full re-encode, which is rung three.
  Those films were showing an EMPTY subtitle panel with no explanation, which reads as "this
  app cannot do subtitles" rather than the truthful "those particular ones are pictures".
- **On the television it is 2,715 perfectly good text tracks that were invisible.** Reading
  one out is `ffmpeg -map 0:s:N -f webvtt` - kilobytes of text, no decoding, nothing written
  to disk. It is safe on a Pi-class box in a way the video path deliberately is not.

**Choice: list both, files on disk FIRST, and extract a text track on demand.**

The ordering is expressed by concatenation rather than by a sort key, so nothing downstream
can reverse it by accident. It is a measurement rather than a preference: 232 image tracks
against 383 usable `.srt` files means leading with what is inside the file makes most of a
film collection look broken.

### Three things that only a real file could have settled

**1. A narrow `-show_entries` drops tags and disposition SILENTLY.** The probe asked for
`stream=codec_type,codec_name,width,height,channels`, so every subtitle stream came back
with no language and no forced flag - present, and anonymous. Both are now asked for by
name. Still narrow: a full `-show_streams` on 2,986 files is megabytes of encoder strings
nothing reads.

**2. The index is within the SUBTITLE streams, not within the file.** `-map 0:s:N` counts
subtitle tracks; ffprobe's own `index` counts everything. On a normal file the video and
audio come first, so using `index` would be off by two and hand back the wrong language or
fail outright. Recorded as `index` in probe.js for exactly this reason, with a test that
pins the second track really is the second language.

**3. `-shortest` truncated a test fixture and looked exactly like a bug in the extraction.**
A two-second French subtitle input cut the four-second English track down to one cue, so a
correct extraction returned half a file. Worth writing down because the same trap is
waiting in any future fixture built from several inputs.

### Cost, accepted

Cache version 5, so the drive is walked again - the third time today. A version 4 cache
holds only the files found beside a film, so a host loading one would show an empty panel on
2,715 episodes that have perfectly good text tracks, which is the exact complaint this
answers.

## 2026-08-13 - NOTHING ABSOLUTE IN AN ID: a show survives a remount, the same way a film always did
Tier: T2 (an id scheme change, which reminst every series and season once)
Context: found while testing root types, by an assertion that compared two copies of the
same library and failed for a reason that had nothing to do with the change under test.

`_identify` mints an item id from the path RELATIVE to its root, with a comment saying
exactly why: **a drive that mounts at a different letter or mount point must not orphan
every resume position on every phone.** Six lines later the series and season ids
interpolated the ABSOLUTE root. So a film survived the drive being plugged in somewhere
else and a show did not.

Nothing has broken yet because there is no phone and no `resume.*`. That is precisely why
it is worth doing now: continue-watching is the next feature that consumes these, and after
it lands a change here costs somebody their television history rather than nothing.

**Choice: the series and season preimages are the show folder relative to its root**, the
same portable name the item id is built from.

### The consequence is wanted rather than tolerated

The absolute root was doing one job: keeping two roots' identically-named shows apart. Drop
it and **the same show under two roots becomes ONE show with both sets of seasons**. That
is the better answer. A collection split across two drives is a real shape - one disk
filled up and the next seasons went on the next one - and two identical entries in the show
list was never what anybody wanted to see.

### The price, which was already being paid silently

A relative id means **two roots holding the same relative path mint the same id**. One drive
being a copy of another, or one root sitting inside another, and the second file overwrites
the first in the path map - one film quietly plays as another, with nothing anywhere saying
so. That was true before this change and equally true after it; what is new is that it is
COUNTED and reported, in the log, in `stats.duplicates` and as a banner on the source panel
naming what to do about it.

Not repaired, deliberately. The library is mounted `:ro` by design and renaming somebody's
files is not this program's business. The fix is to drop one of two roots that hold the same
collection, and that is the operator's call to make.

### Cost, accepted

The scan cache goes to version 4 and the drive is walked again - four minutes, the second
time today. A version 3 cache holds ids minted the old way and they are internally
consistent, so serving it looks fine right up until the drive moves and the shows a phone
remembers are gone. **The portability is the whole point; a cached set of ids that does not
have it is the bug rather than a saving.**

## 2026-08-13 - A FOLDER SAYS WHAT IT HOLDS, and a folder's own NAME counts as saying it
Tier: T2 (a classification change that reaches every existing install without being asked
for, plus a latent bug in the item model)
Context: measured against the real drive on 2026-08-12 and logged as its own TODO item. A
nested file with no parseable episode code fell through to being a film, so **34 of Tim's
2,746 television files** - an MST3K box set numbered `K05` - sat in the Films list. No
filename rule settles that, because `MST3K - K05 - The Gunslinger.avi` genuinely does not
say which episode it is. The adapter already knew the roots were given separately
(`--folder .../Movies --folder .../TV Shows`); it just did not know what either one WAS.

**Choice: a root carries a type - `movies`, `shows` or `auto` - and `auto` resolves from
the root's own folder name.**

- **`shows`**: everything under it is television. A file with no code is an episode of
  UNKNOWN numbering filed under its show, never a film.
- **`movies`**: everything under it is a film, with no episode parsing at all. This is the
  same bug pointing the other way and it was live too: `Shelf/Dune Part 2/Dune - Part 2.mkv`
  became episode 2 of itself, via the loose `Part N` fallback that exists for shows which
  never write SxxExx.
- **`auto`**: nobody said. `TV Shows` and `Movies` are read as what they say; a name that
  says nothing (`Video`, `Elements (3)`, `Stuff`) falls back to the per-file rules exactly
  as before.

### Why the name counts, when this repo's instinct is to distrust inference

Because it is not inference. A folder called `TV Shows` is not a guess about its contents,
it is what the person who made it wrote on the front - and the source DETECTOR has always
matched on exactly those words to offer a drive in the first place. It was computing the
answer and throwing it away one line later. The rule now lives in `names.rootTypeFromName`
and both callers share it, so an offered root and a scanned root cannot disagree.

Two things keep it honest, and neither is optional:

- **It is deliberately narrow.** `Movies|Films|Cinema` and `TV Shows|Series|Television`,
  nothing else. A folder called `Video` holding somebody's phone recordings is not a film
  library - the same restraint the detector already exercises for the same reason.
- **The resolution is SHOWN, not silent.** The dashboard sends what was declared AND what
  it resolved to, and the control reads "Work it out (tv shows)". A classification the
  operator cannot see is one they cannot correct.

The payoff is that this reaches the deployed Umbrel with nothing for anybody to do: its
roots are `/library/Movies` and `/library/TV Shows`, saved as bare strings from the
environment, and they type themselves on the next scan.

### An unnumbered season is named after its folder

The obvious version of this fix files all 34 files under one anonymous "Season", which is a
different kind of wrong. `MST3K DVD 18` and `MST3K DVD 19` are two shelves and stay two:
where the number is unknown, the season is keyed by its folder and titled with it. Numbered
seasons keep the exact id preimage they always had - a test pins that declaring a root
remints nothing, because every resume position on every phone is keyed by one.

### The latent bug this uncovered: `Number(null)` is 0, and 0 is Specials

`items.episode()` read a season number with `Number.isInteger(Number(v))`. Nothing had ever
passed it a null, so nothing had noticed that null coerces to zero - and zero is not "no
season", it is **Specials**. The first unnumbered episode in the world went straight into
the Christmas specials of a show that may not have any. Fixed at the model with an explicit
null check, which also covers a Jellyfin row whose `ParentIndexNumber` is missing.

This is the second time a real library has found a bug that every synthetic case passed
over. It is worth stating the pattern plainly: **the numbers 0 and null are different
answers and JavaScript is happy to conflate them**, so any check that means "was a number
given" has to test for the absence before it converts.

### Cost, accepted

The scan cache goes to version 3, so the first start after this walks the whole drive
again - four minutes on the real 3 TB library. Serving the version 2 rows would show an
operator who had just typed their folders precisely nothing changing, which is worse than
the wait.

## 2026-08-13 - DEPLOYED TO THE UMBREL, against the real 3 TB library, and it found four bugs
Tier: T2 (measurements and a port reallocation that affect every install)
Context: Tim's call, and it was right. "There are only MP4 files on this host. If there
are HEVC files they are on the Elements drive attached to the Umbrel. If you're basing
everything on that full library then we should be building and testing the Host server
dashboard as an Umbrel app from the Umbrel where it can actually see those files."

Everything before this had been developed against a folder of two files on a laptop,
which tests the mechanism perfectly and tests nothing about the library.

**The image had never actually run.** It was accepted in PR #9 because it BUILT.

### Four bugs, none of which any test could have found

**1. The container died at startup, every time.** `@peerloom/host` declares its runtime
packages as devDependencies plus peerDependencies, and the Dockerfile installed them with
`--omit=dev` - which installed nothing. The first `require` out of the package was
MODULE_NOT_FOUND. It works in a checkout because npm links the `file:` dependency and
Node resolves through the symlink into a directory where a plain `npm install` HAS put
them. Fixed by not omitting dev there, with the reasoning written down.

**2. PORT 8742 WAS ALREADY PEARTUNE'S.** PearCinema chose it on the reasoning that
"PearTune has 8741". PearTune binds BOTH: `host/cast.js` runs its Chromecast media server
on 8742. So the host came up, scanned the whole library, and died with EADDRINUSE. The
suite now has a written port map rather than a next-free-number habit:

```
8731  PearCircle seeder
8741  PearTune dashboard      8742  PearTune cast
8751  PearCinema dashboard    8752  PearCinema cast (reserved)
```

**3. The page did not exist until the scan finished** - about four minutes for 2,986
files on a USB drive. `ready()` scanned and THEN listened, so a fresh install answered
nothing at all for minutes, which is indistinguishable from a broken one and is exactly
the experience this app works hard to avoid everywhere else. Now it listens first and
scans after, reporting progress, and **a phone can pair while it works** - which is the
moment somebody is most likely to try.

**4. A deploy that failed printed a cheerful "open http://..." underneath a stack
trace.** The check looked for any 200; something else on the box answered 8742 with a 404
while our container crash-looped. It now looks for OUR page and exits non-zero.

### What the real library actually looks like to a player

274 films, 29 shows, 160 seasons, 2,712 episodes. Sampled through the running host:

```
FILMS (274)                        EPISODES (902 sampled)
182  matroska/h264/aac             315  matroska/hevc/aac
 40  avi/mpeg4/mp3                 211  matroska/hevc/ac3
 18  mov/h264/aac                  138  mov/h264/aac
 14  matroska/h264/dts              87  mov/hevc/aac
  5  matroska/hevc/aac              76  matroska/h264/aac
  5  matroska/h264/truehd           75  matroska/hevc/eac3
  3  matroska/h264/ac3
```

**HEVC is 76% of the sampled television**, which confirms the earlier 64% figure and
sharpens it. And that single fact splits the two clients completely:

- **An iPhone gets essentially all of it after remux.** iOS decodes HEVC and Dolby, so
  every episode above is a container rewrite; only the 40 AVI films are out of reach.
  Verified on real files: a `matroska/hevc/ac3` episode remuxed with the audio COPIED.
- **A desktop browser gets about a quarter of the television.** No browser measured
  decodes HEVC, and repackaging cannot change the picture. Verified: the same episode
  answered `refuse` with "this client cannot decode HEVC video".

So the web player is excellent for FILMS - Tim's Brave opens MKV, so 200 of 274 play
untouched and the DTS and TrueHD ones now get rebuilt sound - and it is weak for his
television, permanently, until something re-encodes video. **That is a finding about
browsers, not about PearCinema**, and it makes the phone client more clearly the product
than any argument had.

## 2026-08-13 - CORRECTION: Chromium-based browsers DO open Matroska
Tier: T2 (a measurement that corrects a claim repeated across this repo's docs)
Context: Tim played his own 2.5 GB MKV of 2001 in the new web player and it said
"straight from the file" rather than "repackaged" - and played perfectly. That should
have been impossible under the claim this repo had been making.

**The claim was too strong.** Measured against a real browser on 2026-08-13:

```
Brave / Chromium 149      video/x-matroska                          -> maybe
                          video/x-matroska; codecs="avc1,mp4a"      -> probably
                          video/mp4; codecs="hvc1..."  (HEVC)       -> NO
                          audio/mp4; codecs="ac-3"                  -> NO
                          video/x-msvideo (AVI)                     -> NO
```

So **Chrome, Brave and Edge open an MKV holding H.264 and AAC**, and Tim's 2001 is
exactly that. Safari and iOS do not, which is where the original claim came from. Firefox
was not measured - it would not report headlessly - so nothing is claimed about it.

**The code was already right, and that is the point worth keeping.** `playback.js` probes
`canPlayType` rather than hard-coding a table, so it correctly sent the file untouched.
Had it assumed the Chrome-refuses-Matroska claim, PearCinema would have spent a child
process repackaging a film that was already playing perfectly. **Ask the engine, do not
model the engine.**

### What this does and does not change about remux

It does NOT shrink the case for remux; it changes its shape.

- Container refusals are fewer than believed **on Chromium**, and unchanged on Safari and
  iOS - which is the platform remux was always principally for.
- **The codec refusals are what remain, and they are large.** No measured browser decodes
  HEVC, and HEVC is 64% of the real television library. Those files are not remuxable
  either, because repackaging cannot change the picture - they are rung three.
- **Dolby audio is refused by every browser measured**, so an AC-3 film in Chromium plays
  the picture and nothing else. That was being reported as "picture only" and accepted.

### The gap it exposed, now fixed

A soundtrack the browser cannot decode is **cheap to rebuild** - that is rung two, and per
the same day's measurement it is a rounding error of the library. Reporting a silent film
rather than fixing one was leaving the easiest win on the table. A `nosound` verdict is
now repackaged with the audio rebuilt and the picture untouched, and says so.

## 2026-08-13 - remux ships as a PIPE, not as HLS, and three real-file traps
Tier: T2 (a mechanism change inside an approved T3, recorded rather than made quietly)
Context: `proposals/2026-08-13-remux.md` chose HLS with an on-disk rolling segment window,
because a `<video>` element and AVPlayer both seek by BYTE range and generated bytes have
no stable byte offsets. Building it produced a simpler answer for the client that exists.

**Choice: ffmpeg's output goes straight down the socket. Nothing is written to disk.**
Seeking is the player asking the host to start again at a new time, with the offset added
to the element's own clock.

Why this is not the option the proposal rejected. It rejected restart-at-seek on the
grounds that a NATIVE player seeks by byte range and would need a byte-to-time map faked
from average bitrate. That is still true and still disqualifying - **for a native player**.
The browser's player is OURS: it can intercept a scrub and re-source. So the objection
applies to the phone, which does not exist yet, and not to the client that does.

What it buys, and it is not small: **the proposal's hardest constraint disappears rather
than being managed.** There is no segment cache, so there is no cap to enforce, no rolling
window to get wrong, no disk to fill, and no cleanup path that can leak a gigabyte per
abandoned session on a box whose root filesystem filling up is a brick. The section of the
proposal that worried most is answered by there being nothing to worry about.

**HLS is still the plan for the phone**, unchanged, and this is a deviation to record
rather than a decision to reverse. The seam is right for it: `decide()` already answers
what a client needs, and a playlist path is additive next to a pipe path.

Cost, accepted: a moment's rebuffer on every seek, and the host cannot resume a stream it
has already produced - it produces it again. Remux is cheap enough that this is measured in
seconds. On Tim's real 2.5 GB copy of 2001, seeking an hour in delivered playable bytes in
**3.5 seconds**.

### Three traps that only a real file could have found

**1. `delay_moov`, and its absence is SILENT.** Copying AC-3 into a streamed fragmented
MP4 produced a file ffmpeg was perfectly happy to write, exited 0 on, and nothing could
open: `invalid size 0 in stsd`. An AC-3 track's `stsd` entry needs a `dac3` box whose
contents come from the first audio frame, and `empty_moov` writes the header before a
single packet has been read. The same copy into a normal seekable MP4 worked perfectly -
which is exactly why the earlier Dolby measurement, done with files on disk, could not
have caught it. **This very nearly cost the entire Dolby win**, the ~620 files that are
the reason rung two shrank to 19.

**2. Chapters become a phantom `bin_data` track.** ffmpeg copies chapters by default and
the MP4 muxer writes them as a third stream. Tim's copy of 2001 carries 34 chapter marks,
so the output had three streams in a fragmented MP4 where a strict player has every right
to object. Invisible to every synthetic clip, because a clip ffmpeg just made has no
chapters. Now `-map_chapters -1`.

**3. `mkv` and `matroska` are the same container and the two sources disagree.** ffprobe
says `matroska`, Jellyfin says `mkv`, and ffprobe collapses the whole ISO base media
family to `mov`. A client declaring one spelling against a file carrying the other means
remuxing files it could already open. Aliased in one table.

The general lesson, and it is the third time this repo has learned it: **the tests that
found these were the ones that produced actual bytes.** Everything that only inspected an
argv passed.

## 2026-08-13 - MEASURED: Dolby Digital survives a plain rewrap into MP4, DTS does not
Tier: T2 (a measurement that decides how much of the remux proposal has to be built)
Context: open question 1 of `proposals/2026-08-13-remux.md`. The repair ladder puts ~650
files on rung two, "container rewrite PLUS an audio re-encode", almost all of it HEVC +
AC-3 television. Apple documents Dolby Digital support in MP4, which would move most of
that bucket down to rung one and make it free rather than merely cheap. The proposal said
find out with a real file before building the audio path, because it changes what gets
built. This is that.

**Method.** Ten-second clips, H.264 video plus one audio codec each, muxed in Matroska -
the shape the real library is in - then remuxed with `ffmpeg -c copy` into MP4 and served
over HTTP to Mobile Safari, which reports its own decoder's verdict.

### First: what ffmpeg will even mux into MP4 with `-c copy`

```
aac     MUXED     eac3    MUXED
ac3     MUXED     dts     MUXED
truehd  REFUSED - "truehd in MP4 support is experimental"
```

TrueHD needs `-strict -2` to mux at all, which is ffmpeg telling us not to.

### Then: what iOS actually does with them

Mobile Safari, iOS 18.7 runtime, `canPlayType` plus a real load and play:

| codec | canPlayType | loaded | played |
| --- | --- | --- | --- |
| AAC | probably | yes | yes |
| **AC-3** | **probably** | **yes** | **yes** |
| **E-AC-3** | **probably** | **yes** | **yes** |
| DTS | **""** | yes | yes, **and that is the trap** |

**Dolby Digital and Dolby Digital Plus pass straight through.** So the ~620 AC-3 and
E-AC-3 files in the measured library are a CONTAINER REWRITE and nothing else - rung one,
not rung two. Rung two shrinks to DTS (14 files) and TrueHD (5), which is 19 files out of
2,986, and TrueHD cannot be muxed into MP4 at all so it needs the re-encode regardless.

**The DTS row is the one to read carefully.** `canPlayType` answered `""` - no - and yet
the file loaded, played and the clock advanced. iOS did not refuse it; it played the
picture and dropped the audio track. That is exactly the "picture, no sound" outcome the
web player's `verdictFor` already models as its own status rather than folding into a
refusal, and this is independent confirmation that the distinction is real rather than
theoretical. A player that treated `canPlayType` as a yes/no would have shown a silent
film with no explanation.

### Which device this was, and why the answer is safe anyway

**This was the iOS SIMULATOR, not the iPhone SE** (rule 7 says say which). Safari was
launched on the SE over USB but `devicectl` has no way to hand it a URL, so the page never
loaded there. The Simulator runs on the Mac's decoders and can in principle be optimistic
about codecs, so this is not the last word.

It is good enough to plan on, for a reason that is structural rather than hopeful: **the
remux design has the CLIENT declare its capabilities and the HOST decide the mode.** An
iPhone that turns out to refuse AC-3 simply does not declare it, and the host re-encodes
the audio for that client. So a wrong answer here costs some wasted CPU on one device
class, not a silent film - and the real device answer arrives for free the moment there is
an iOS client to ask. Do not spend more effort on it before then.

### What this changes in the plan

- Rung two is **19 files, not ~650**. The audio re-encode path is a rounding error and
  can be built last, or skipped for a long time.
- **Rung one now covers essentially the whole of the 83%.** Container rewrite alone is the
  release.
- TrueHD is the one codec that must be re-encoded to be carried at all, and there are five
  of them.

## 2026-08-13 - the web interface is the operator's dashboard WITH playback, and the player is one transport rather than a second implementation
Tier: T2
Context: the TODO item asked the question outright and said to answer it before
building: is this the operator's dashboard with playback added, or a genuine second
client? And a player needs bytes, which the phone already has a path for.

**Choice (a): the dashboard with playback added.** No accounts, no per-user state, no
resume, no separate client identity. The browser is the OPERATOR - the person holding the
dashboard password - not a device with a grant.

Why: the cheap answer is also the correct one here, and the expensive one would have been
wrong rather than merely dear. A "second client" implies a subject: somebody whose
watch state, permissions and revocability are tracked. Every one of those already has an
owner in this system (the grant store, `resume.*`, the pairing windows) and duplicating
them for browsers would mean two answers to "who is watching" - which is precisely the
kind of divergence the shared-host extraction exists to prevent.

**The consequence to keep in view: revoke does not reach a browser, and is not supposed
to.** A browser holds a session cookie, not a grant, so the revoke-kills-live-connections
rule says nothing about it. Anyone reading "revoke cuts access within a second" should
read it as being about paired devices. Logged in TODO as a question worth revisiting, not
as a bug.

**Choice (b): `/api/stream` is HTTP wrapped around the SAME `host.openStream` the phone's
`media.stream` calls.** Not an adapter call of its own.

Why: the range arithmetic is the part that decides whether seeking inside a two-hour film
works, and the id-to-path guard is the part that decides whether `media.stream` is a media
server or arbitrary file read. Two copies of either is one copy that gets fixed and one
that does not. A test asserts the browser's `Range` header reaches the adapter as the same
`{offset, length}` the P2P path produces, so the claim is pinned rather than intended.

**Choice (c): a built Preact app, not a hand-written page.** The donor's dashboard was a
700-line template literal until a syntax error inside the string produced a completely
blank control plane that every test passed - because a string is a string, and nothing
ever parsed it. Building catches that class at build time. It does NOT catch a runtime
error in the first render, which is the same blank page from a different cause, so there
is now a test that loads the committed HTML into a real DOM and clicks through it.
Preact rather than React purely on size: 49 kb against the donor's 440 kb, same escaping
behaviour, and the host had no other client-side dependency pulling React in.

### The finding that makes this more than a convenience: a browser is a second compatibility engine

The player refuses most of a real collection. That is not a defect in it - Chrome and
Safari will not open Matroska, and per the measurement below 83% of the library is
Matroska. **Two independent engines, a browser and an iPhone, refusing the same 83% of
files at the container for the same reason is evidence rather than a prediction**, and it
is the strongest argument yet that remux is the release and not an optimisation.

So the refusal is treated as a FEATURE OF THE UI rather than something to hide:

- Every list carries a count of how many of these files *this* browser can play, computed
  from `canPlayType` rather than from our own opinion of what browsers do.
- Every refusal names the container, says the file is fine, and points at remux.
- A codec the browser cannot decode is a refusal; an AUDIO codec it cannot decode is
  "picture, no sound" and still plays. Those are genuinely different outcomes and
  collapsing them would have hidden DTS and TrueHD files that are perfectly watchable.
- "Play anyway" is always offered, because `canPlayType` answers about a codec family and
  can be wrong in both directions. A wrong refusal should cost one click.

The rules live in `host/ui/app/playback.js` with the browser injected, so they are unit
tested against what Chrome would answer and what Edge would answer without opening either.

## 2026-08-12 - THE WHOLE LIBRARY, 12,197 files: iOS NEEDS REMUX, it is not optional
Tier: T2 (a measurement that revises build order and one of the proposal's framings)
Context: the Jellyfin measurement below was 25 files. This is Tim's actual collection on
the Elements drive, scanned file by file with ffprobe by `host/probe.js` - no Jellyfin in
the path, because the collection was never in Jellyfin.

**Read the folder split before the totals, because the totals lie.**

| Folder | Files | Size |
| --- | --- | --- |
| Home Videos | 9,211 | ~1 TB |
| TV Shows | 2,746 | 2.0 TB |
| Movies | 240 | 1.0 TB |

The first pass reported the whole tree at once and produced a cheerful "76% is
mov/h264/aac". **That was home videos** - phone recordings, uniformly the friendliest
format there is - drowning out the actual library three to one. A media player's
compatibility question is about the media library, so the numbers below exclude Home
Videos and cover the **2,986 films and episodes**.

### The container is the problem, and it is nearly everything

```
MOVIES (240)                       TV SHOWS (2,746)
matroska  220 (92%)                matroska  2262 (82%)
mov        20 (8%)                 mov        266 (10%)
                                   avi        218 (8%)
```

**83% of the media library is in a container an iPhone will not open.** Not a codec it
cannot decode - a box it cannot unwrap.

### What that means per platform

- **Android direct-plays essentially all of it.** ExoPlayer handles Matroska, AVI, HEVC and
  MPEG-4 Part 2. The genuine misses are DTS (14 files) and TrueHD (5), and AC-3/E-AC-3
  (~620) is device-dependent. Call it 99%.
- **iOS direct-plays about 10%** - the 286 `mov` files and nothing else.

**A direct-play-only iOS build would show a user one tenth of their own collection.**
That is not a shippable iOS experience, and it is the finding that matters most here.

### The repair ladder, cheapest first

- **Remux only** (rewrap, no re-encode): the large majority. Every Matroska file whose
  streams an iPhone already accepts - H.264 or HEVC video with AAC audio - which is 190 of
  the movies and 1,635 of the episodes. **~61% of the library is a container rewrite and
  nothing else.**
- **Remux plus AUDIO-only re-encode**: ~650 files, dominated by HEVC+AC-3 television.
  Audio is a rounding error against video to encode, so this is still cheap. **Uncertain by
  how much**: Apple does support Dolby Digital and Dolby Digital Plus in MP4, so a good part
  of this bucket may survive a plain remux. The client settles it; do not plan around either
  answer.
- **Full video transcode**: the 218 AVI/MPEG-4-Part-2 files, 7% of the library, all in TV
  Shows. The only bucket that needs a real encoder.

**Consequence: remux is not an optimisation, it is the iOS release.** The order is
container first, audio second, video encoding last - and video encoding could be skipped
entirely for a long time without most of the library noticing.

### HEVC was underestimated, exactly as the proposal warned

**HEVC is 64% of the television library** (1,766 of 2,746). The proposal named it as the
underestimated one and it was right. It is not a problem for Android or for iOS-in-MP4;
it is a problem for anything that assumed H.264 and for any transcode sizing done on
audio-era numbers.

### Subtitles: the image-based case is common, not exotic

```
MOVIES: 232 PGS tracks across 240 films - about one per film, and only 57 SRT
TV:     1,429 PGS against 2,715 SRT
```

The proposal said embedded PGS is image-based and forces a full transcode to burn in, so
v1 lists it and refuses it. **On the Movies collection that refusal is the common case, not
the edge case** - most film subtitle tracks here are the unusable kind. The saving grace is
383 external `.srt` files on disk, which the folder adapter can serve directly and which do
not need any of this.

### And the bandwidth assumption was pessimistic

44% of the whole tree is SD and exactly ONE file is 4K. The no-relay arithmetic assumed
8 Mbps throughout. That assumption is safe as a worst case and wrong as a typical one,
which is worth knowing before anyone sizes anything on it.

### Do not over-read this either

One person's collection. It skews toward television, and its Movies folder is small and
disc-ripped where its TV is downloaded. What it does establish beyond argument is that
**the container question dominates**, and that an iOS build without remux is not a product.

## 2026-08-12 - FIRST MEASUREMENT (25 files, superseded above): direct-play-only is well founded, and remux beats transcode
Tier: T2 (a measurement that shapes build order, not a change of scope)
Context: v1 ships direct-play only precisely so this could be measured instead of guessed.
Run against Tim's Umbrel Jellyfin (10.11.11): **1 film + 24 episodes, 30.1 GB**, one series
across four seasons.

```
mp4 / h264 / aac    24 (96%)
mkv / h264 / aac     1 (4%)
```

100% H.264, 100% AAC, 100% 1080p.

What it says, taking Android's ExoPlayer and iOS's AVPlayer as the two targets:

- **Android direct-plays 100% of it.** ExoPlayer handles both combinations, MKV
  included. The proposal's Android-first sequencing is validated by data rather than by
  convenience.
- **iOS direct-plays 96%.** The single miss is `mkv / h264 / aac`, and it fails on the
  **container only** - the streams inside are already exactly what an iPhone wants.

**Consequence for build order: remux earns its place before transcode**, and by a wide
margin. Not one file in this library needs an encoder. The only miss needs a container
rewrite, which is cheap enough to run on a Pi-class box and is not what the capacity doc's
warnings are about. Building the transcode pipeline first would have been building the
expensive thing for zero percent of a real library.

**The negative result matters as much.** No H.265, no TrueHD, no DTS anywhere - the exact
combination the proposal named as the underestimated one (`MKV + H.265 + TrueHD does not
direct-play on iOS at all`) does not appear once.

**Do not over-read this.** One series and one film is a small sample, and it is downloaded
content rather than ripped discs. Tim has confirmed his wider collection also has MKV.
Ripped Blu-rays are exactly where H.265, TrueHD, DTS and PGS subtitles live, so this does
not retire the worry - it says his current library does not exercise it, and a client built
against this data will meet the hard cases later rather than never.

### Two findings that came out of running it, not out of reasoning about it

**The first run reported 16 films and zero episodes, and that was the SERVER, not us.**
Jellyfin had one library, typed `movies`, holding both the film and the show, so it
classified every IT Crowd episode as a Movie and PearCinema faithfully repeated it. The
files were named perfectly (`The IT Crowd/Season 01/The IT Crowd - S01E01 - ....mp4`) -
Jellyfin simply never looked for a series. Fixed on the server by splitting Movies and
Shows libraries, after which the tree came back flawless: 1 series, 4 seasons, 6 episodes
each, correct numbering throughout.

This is the strongest available argument for the folder adapter. A source can be confidently
wrong about its own library, and there is a whole second question - whether PearCinema
should ever second-guess a server that calls `S01E01` a film - logged in TODO.md.
**Recommendation there: no for a server source** (Jellyfin is the authority on its own
library and disagreeing would give two contradictory UIs on one machine), **yes for the
folder adapter**, which has no server to defer to.

**Resolution was being named by HEIGHT, and that filed most of cinema as 720p.** The 1080p
copy of 2001 is 1918x864 - scope ratio, bars cropped rather than encoded - so it read
"864p". Television is 16:9 and reads identically either way, which is why height looked
correct right up until the library was films. Now named by width, and the library correctly
reads 100% 1080p. Fixed in `items.resolutionLabel`, which the codec report defers to so the
two can never disagree.

## 2026-08-12 - the operator brings their own metadata API key
Tier: T2
Context: the opt-in online metadata pull needs a credential. Ship a PeerLoom one, or ask
the operator for theirs.
Choice: **the operator brings their own.** PearCinema ships no credential.
Why: a shipped key in an MIT repo is extractable and its rate limit is shared across every
install, and it would have been the first credential the suite ships.
Three consequences that are NOT optional and follow directly:
- **TMDB only, one provider.** A shipped key could have afforded two providers; a
  user-supplied one cannot, because asking for two registrations kills the feature. TMDB's
  key is free and self-serve where TVDB gates parts of its API behind a subscription.
- **No key must not look broken.** Sidecars and filename parsing still produce a working
  library. Missing key means no posters for unorganised files, said plainly, not an error.
- **The setup step is the whole risk.** Direct link to the key page, paste field, and a
  Test button that validates before saving. A key that silently fails is worse than none,
  because the library just looks wrong.
Also decided: the App Store demo library (public-domain films) WAITS until there is an app
to demo. Deferred deliberately, with the note that sourcing has lead time and must start
before submission rather than at it.

## 2026-08-12 (later) - folders in v1, no TV client, casting only
Tier: T2
Context: Tim read the two resolved questions and adjusted both.
Choice: (a) the folder adapter moves INTO v1 rather than v2, with Jellyfin first only as
the faster path to first playback. (b) On top of sidecar metadata, an OPT-IN online
metadata pull, default off, with pre-filled provider config and pre-filled match candidates
the operator confirms. (c) The Android TV client is scrapped for now. Chromecast push is
the entire TV story.
Why: "we definitely want folders" - the folder adapter is the moat and deferring it read as
optional. The opt-in pull covers libraries with no sidecars, which filename parsing alone
serves badly, without making a third-party lookup the default. Results cache to the data
dir and not into the library, which is mounted read-only by design. On the TV client: the
costing stands and is kept in the proposal, because the question returns once casting's
browse-on-a-phone limitation is felt in real use.
Superseded: the parts of the two 2026-08-12 entries below that scheduled folders and a TV
client for v2. The reasoning in them still holds and is why these calls are safe.

## 2026-08-12 - the folder adapter reads sidecar metadata, not TMDB
Tier: T2
Context: open question #2 of the video-deltas proposal asked whether PearCinema is
Jellyfin-only forever. It was framed as a product fork in the road on the assumption that a
folder adapter needs an online metadata service.
Choice: Jellyfin and Emby for v1, folder adapter committed for v2, reading **local sidecar
files**: Kodi-format `.nfo` XML plus `poster.jpg` / `fanart.jpg` / `banner.jpg`.
Why: the assumption was wrong, which collapses the fork into a sequencing question.
Self-hosted video libraries are overwhelmingly populated by Sonarr/Radarr or scanned by
Jellyfin/Emby/Kodi, all of which write metadata to disk beside the media. So a folder
library gets titles, synopses, cast, episode ordering and artwork with zero network calls,
no API key and nothing learning what you own - a TMDB dependency would have been the first
outbound metadata call anywhere in the suite. PearTune's `FolderAdapter._coverFile` already
does this shape for album art. Fallback with no sidecars is filename parsing, which yields
title, year and SxxEyy, and the UI should say so rather than look broken.
The part of the original question that SURVIVES: the folder adapter is the moat. Reading
only Jellyfin makes PearCinema an accessory to a project that can improve its own remote
access whenever it likes. Deferring is fine, dropping is not.

## 2026-08-12 - Android TV client is v2, Chromecast ships in v1
Tier: T2
Context: open question #1 asked whether a TV client beats casting, and whether it is
cheaper than the transcode pipeline.
Choice: build it, in v2. Chromecast push still ships in v1.
Why: the toolchain is free - `react-native-tvos` plus the `@react-native-tvos/config-tv`
Expo plugin is the documented path, and PearTune's existing Expo SDK 54 / RN 0.81.5 stack
is exactly the supported pairing with RNTV 0.81-stable, so no SDK migration. Android TV is
arm64/x86_64 Android, so the worklet and addon slices are already-solved problems, and
direct play gets EASIER because TV boxes have better codec support than phones.
**The whole cost is the UI.** PearCinema's UI is a WebView, Chromium does not ship the CSS
spatial-navigation spec, so D-pad focus has to be implemented in JavaScript, with a focus
model and visible focus rings on every screen. That is a second UI, not a port, and it is
the largest chunk after the host extraction - still smaller than a correct transcode
pipeline with seek. Chromecast ships first because the security machinery already exists in
`peartune/host/cast.js` and the Default Media Receiver needs no published app; it is just a
worse product, since browsing happens on a 6-inch screen while a 55-inch one plays.

## 2026-08-12 - the name is PearCinema
Tier: T0 (but expensive to change later)
Context: Tim proposed "PearTube" for the video sibling of PearTune.
Choice: PearCinema.
Why: PearTube is a YouTube trademark risk - Google enforces the "-tube" suffix against
app-store listings. PearFlix fails the same way against Netflix. PearVideo is already a
shipped app with 1M+ downloads (`com.pearvideo.tec.android`). PearScreen collides with
PearGuard, which is the screen-time app. PearReel runs into Instagram Reels regardless of
the word predating it by a century. PearCinema is clear, unused, and says what it is.

## 2026-08-12 - no relay key, ever, and bring-your-own instead
Tier: T3
Context: PearTune ships a PeerLoom-run blind relay as the off-LAN backstop for users whose
hole-punch never lands. Tim asked for the relay off by default, or absent entirely.
Choice: bake in NO relay key. Offer a settings field for a relay the user runs themselves.
Why: PearTune's relay carried 163 MB in six days against a 500 GB/month tier. Video at
8 Mbps is 3.6 GB per HOUR, so one user watching two hours a day costs 216 GB/month alone.
That is an unbounded bill scaling with adoption. Mechanically free to do:
`relayThroughFor` only returns a key when `(force || randomized) && useRelay && relayKey`.
Cost, accepted and to be stated in the store listing rather than hidden: users on
symmetric NAT at both ends have no direct path and cannot reach their library off-LAN.

## 2026-08-12 - extract @peerloom/host, do not fork PearTune's
Tier: T3
Context: roughly two thirds of PearTune's host is media-agnostic. The obvious move was a
copy-fork, which is what the suite did for the seeder, `release.sh` and the release library.
Choice: extract `@peerloom/host` first. PearCinema is its first consumer. PearTune migrates
onto it on a branch, merged only after the iOS 1.0.0 App Review outcome is known.
Why: all three previous copy-forks are still open TODO items and the seeder had already
diverged by the time it was written down. This fork would be ten times the size and covers
the firewall gate, the grant store and the revoke path, where two divergent copies is a
security problem rather than a tidiness one. `@peerloom/core` is the cautionary case here,
not the model: its donor apps were never migrated.

## 2026-08-12 - v1 is direct-play only
Tier: T2
Context: video needs transcoding far more than music does, and PearTune's measured
capacity numbers (200+ concurrent audio transcodes on an N100) do not survive the move.
Choice: ship v1 with Jellyfin as the only source, direct play only, no transcode, no remux.
Why: the expensive and genuinely uncertain part of this app is which files in a real
library actually play on a real phone. Direct-play-only answers that with data in days.
Building a transcode pipeline first means building it against a guess.
