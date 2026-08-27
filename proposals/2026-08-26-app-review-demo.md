# A demo library, so App Review can actually use PearCinema

**Goal** - give an App Store reviewer, and anyone who installs before they run a
host, a PearCinema that plays something without a server.

**Status** - **APPROVED 2026-08-26** (PR #191, merged). Code may start.

**Tier** - **T2.** App-only. No wire change, no host change, nothing near grants,
pairing or the security boundary. It earns T2 on shipping video inside the binary
and on adding a first-run path that bypasses onboarding.

---

## Why this blocks a submission

PearCinema has no account and no cloud. A reviewer installs it, opens it and is
asked to pair with a dashboard on a machine they do not own. There is nothing to
log into and nothing to press. That is **Guideline 2.1, App Completeness**, the
most common rejection there is, and from where the reviewer sits it is a fair
reading: the app does nothing.

PearCinema is worse off than PearTune here rather than better. `src/ui/App.jsx`
says so at the point where its onboarding diverges from the donor's: the
whose-library card offers the two real answers and no third one, because there is
no demo library to offer. The store listings already match that, and
`test/app-config.test.js` (`THE LISTINGS DO NOT OFFER A DEMO THAT DOES NOT EXIST`)
holds them to it.

### A pairing link in the review notes cannot work, and the reason is in the code

The obvious fix is to paste a pairing link into App Store Connect. It fails for
two reasons that are facts about this codebase rather than opinions:

- `PAIR_TTL_MS` is **5 minutes** (`peerloom-host/src/protocol/constants.js`).
- The window **closes on the first successful pair** (`peerloom-host/src/pair.js`,
  `this.close('paired')`).

A link is short-lived AND single-use. A reviewer opening the app the next day has
nothing; two reviewers, or one retrying after a rejection, and the second has
nothing even inside the window.

### And the fix for that is worse than the problem

Making a link work would need a standing invite: long-lived, multi-use. That is
the negation of what the pairing window is for - there is nothing yet to check a
newcomer against, so trust reduces to "the operator opened a session just now, and
this device holds the token from that session". The code path would exist in every
host, including the ones strangers run for their friends, to solve a problem in
Apple's review queue. **Rejected deliberately**, and written down here so it is not
re-proposed as an easy win. PearTune reached the same conclusion on 2026-07-28.

---

## What to build

**A "Look around without a server" path on the onboarding intro card**, playing a
handful of short films shipped inside the app. No pairing, no host, no network, no
grant.

It is not a review trick. Somebody who installs PearCinema before setting up a
host currently sees a wall, and this gives them the app working in their hand while
they decide whether to run a library. That is the honest argument, and the reason
it stays in the product afterwards rather than being stripped before release.

### The one thing that differs from PearTune, and it decides the whole shape

**Video is three orders of magnitude bigger than music.** PearTune bundles five
CC0 tracks at about 4 MB each and calls 18 MB acceptable for a music app. A feature
film is 1-4 GB, and the App Store's hard ceiling is 4 GB uncompressed for the whole
app. Even a heavily compressed feature would dominate the download.

So the demo is **short films, not features**:

- Four to six shorts, 5-20 minutes each, **480p H.264 in MP4**, targeting about
  25 MB apiece and **100-150 MB in total**.
- That sits under the 200 MB threshold where the App Store asks before downloading
  over cellular, which keeps a first install ordinary rather than a decision.
- Three of them are grouped as a series with episode numbers, so the SHOWS half of
  the app is demonstrable and not just the films grid. PearCinema's browse is two
  trees and a demo that exercises one of them proves half an app.

**They must be direct-playable, and that is a constraint rather than a preference.**
There is no host in demo mode, so there is nothing to remux or convert. H.264 in
MP4 with AAC audio plays on every target directly. Shipping an MKV to show off the
container story would produce a demo that cannot play its own films.

**One of them carries a sidecar `.srt`**, because subtitles are a headline feature
and cost nothing to demonstrate.

### The constraint that decides the films

Every bundled film must be licensed for redistribution **inside a shipped binary**,
verified per item and recorded next to the file. Never Tim's own collection, never
"it is old so it is fine".

Two traps, and the second one is the one that catches people:

1. **A film being old is not the test.** US public domain turns on publication
   date, notice and renewal rather than on age alone.
2. **A restoration or a re-score carries its own rights.** The 1922 film may be
   free while the 2015 restoration with a new orchestral track is not. The print
   matters as much as the title.

Sources in order of how safe they are:

- **US Government works** - NASA, NARA, LoC-produced material. Public domain by
  statute (17 U.S.C. 105), which is the cleanest answer available.
- **Prelinger Archives on the Internet Archive.** About 65% public domain, and the
  licence is stated **per item** rather than across the collection - so the item
  page is the evidence, and a collection-level assumption is exactly the error to
  avoid.
- **Library of Congress National Screening Room** items marked no known
  restrictions.

Whatever is chosen, `assets/demo-library/LICENCES.md` records for each file: the
title, the source URL, the licence as stated on that page, the date checked and
which print it is.

**This is the lead time.** Start it before a submission is scheduled, not at it.

### Shape, traced against this codebase

- The demo library is **read-only and unmistakably labelled**. It must never look
  like a paired library: no revoke, no requests and no favourites syncing anywhere. The library
  switcher names it "Demo library".
- Leaving the demo is a first-class action, not a reinstall. Pairing a real library
  from inside it must work and must retire the demo from the merged index at that
  point.
- Nothing about it may touch the grant store, the identity keypair or the pairing
  window.
- It follows the existing branch shape rather than sitting beside it. Every browse
  method in `src/bare.js` already has a merged-mode branch and a host branch; the
  demo is a third branch taken first.
- Playback goes through the local HTTP shim that already serves cached downloads
  from disk, so range requests, seeking and backpressure come free. The demo files
  are installed as pinned cache entries and the lease check has to answer true for
  demo ids, since a demo film has no host and therefore no lease that could be
  fresh.

### What changes together

`test/app-config.test.js` currently PROVES the listings offer no demo. When the
demo ships, that test and both store descriptions change in the same commit - and
the sentence that must survive is the one about content: PearCinema hosts nothing,
indexes nothing and has no way to obtain a film. A demo of six public-domain
shorts does not weaken that and must not be written as though it does.

---

## Also required, whatever else is decided

**A video in the review notes** showing the real flow end to end: install the host,
open the dashboard, pair a phone, browse, play and revoke. Apple accepts a video for
apps that need hardware or a service a reviewer cannot have. It costs about an
hour, it is the fallback if the reviewer never finds the demo path, and it is the
only place the container and conversion story can be shown at all, since the demo
deliberately avoids needing it.

**Review notes that say the quiet part plainly**: no account by design, the app
plays files the user already owns from a machine they run, here is the demo path,
here is the video.

**The notes get re-walked against the build being submitted.** PearTune's scar is
sending a reviewer to a button that had since moved, which is itself a 2.1
rejection. A tap path written from this proposal and not re-checked against the
shipped build is the same mistake with a different cause.

---

## Compat

Nothing crosses a wire. No Hyperbee key, no IPC shape, no topic and no persisted
field changes for an existing user, and a host never learns the demo exists. An
old host talking to a new phone is unaffected because the demo path never reaches
a host at all.

The one persisted addition is app-local: which demo files have been installed into
the cache directory, and a flag for whether the demo has been retired. A phone that
downgrades afterwards sees an unknown cache entry, which the cache already tolerates.

---

## Verify

Beyond `npm run verify`:

- Install on a device with **no** pairings and confirm the demo plays **in airplane
  mode**. That is the honest test, because it proves no host is involved.
- Pair a real library from inside the demo and confirm the demo leaves the merged
  index without taking anything real with it.
- Confirm the licence file lists every shipped file and that each entry names a
  source page which states the licence.
- Re-walk the review notes against the exact build being submitted.

---

## Open questions

1. **Which films.** Needs sourcing and per-item licence verification. The lead
   time, and the reason this proposal exists now rather than at submission.
2. **Whether the demo survives after pairing** - a "show me the demo again"
   affordance, or strictly a first-run state that retires for good.
3. **Whether Play gets it too, and on Android it does not simply fit** (measured
   2026-08-26, after the library was built). Apple is what forces this feature - the
   2.1 rejection risk is theirs, and Play's equivalent is milder. But the files are
   ordinary assets in one codebase, so they ship in BOTH builds unless something
   deliberately excludes them, and Android has the harder ceiling: Play caps the
   compressed download of an app bundle's base module at **200 MB**, and 164 MB of
   film on top of the app exceeds it. Apple's 200 MB is only the point where a
   cellular install asks first.
   **DECIDED 2026-08-26: iOS only.** The films go into the Apple build and the Android
   build leaves them out, which is where the reason for having them is weakest anyway.
   The two rejected options are a Play **asset pack**, which lifts the ceiling and is
   real build machinery to set up and keep working, and a smaller Android library,
   which is two versions of the same thing to keep straight.
   WHAT THAT BINDS: the exclusion has to be a build rule rather than a habit, and
   `android/` is generated by `expo prebuild`, so it belongs in a config plugin or in
   `app.json` - anything edited into the generated tree is gone at the next prebuild
   (suite rule 5). And a test should assert the Android artefact does not contain the
   films, because the failure mode is silent until Play refuses the upload.
   IT ALSO SPLITS THE ONBOARDING. The "look around without a server" card can only
   appear where the films exist, so on Android the intro keeps offering the two real
   answers exactly as it does today. That is a branch in the UI, not just in the build.
4. **Whether the shorts should be dressed with poster art**, which the films grid
   is built around. A grid of initials placeholders demonstrates the app looking
   worse than it is, and public-domain stills are their own sourcing job.
