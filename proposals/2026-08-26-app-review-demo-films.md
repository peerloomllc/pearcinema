# Candidate films for the demo library, and the evidence for each

Companion to `2026-08-26-app-review-demo.md`, which called the films the lead time
and left "which films" as its first open question. This is that question answered
as far as it can be answered without downloading anything.

**Nothing has been downloaded, trimmed or encoded.** What follows is sourcing and
licence evidence, plus the size arithmetic that the proposal's budget did not
survive contact with.

---

## How each one was checked

Not by reading a collection page. Every entry below was checked against
`https://archive.org/metadata/<identifier>`, which returns the item's own
`licenseurl` and `rights` fields - the per-item statement, which is the only thing
that counts. The Prelinger collection is only about 65% public domain and licences
per item, so a collection-level assumption is exactly the error to avoid.

Checked 2026-08-26. Every value below is quoted from that response.

---

## Verified: US Government works

Public domain by statute, 17 U.S.C. 105, and the archive states it as well. This
is the cleanest evidence available for moving pictures.

| Title | Identifier | Creator, date | Runtime | `licenseurl` |
| --- | --- | --- | --- | --- |
| Duck and Cover | `gov.ntis.ava11109vnb1` | Federal Civil Defense Administration, 1951 | 9:14 | `creativecommons.org/licenses/publicdomain/` |
| The Eagle Has Landed: The Flight of Apollo 11 | `gov.archives.arc.45017` | National Archives (NASA), 1969 | 28:26 | `creativecommons.org/publicdomain/zero/1.0/` |
| Apollo 13: Houston, We've Got a Problem | `gov.archives.arc.1155023` | National Archives (NASA) | 28:21 | `creativecommons.org/publicdomain/zero/1.0/` |
| The Mission of Apollo / Soyuz | `gov.archives.arc.1154974` | National Archives (NASA), ca. 1975 | 29:06 | `creativecommons.org/publicdomain/zero/1.0/` |
| The Pleasure of Your Company: Military Etiquette and Grooming | `gov.ntis.ava20403vnb1` | U.S. Army, 1970 | 13:10 | `creativecommons.org/licenses/publicdomain/` |

**The three Apollo films are a real series**, not three films we would be dressing
up as one: they are part of a NASA documentary series made in the early 1970s and
narrated by Burgess Meredith. That matters, because the demo needs the shows tree
to be honest rather than staged.

Duck and Cover is also on the National Film Registry, which does no legal work but
makes it a recognisable thing to find in a demo library.

## Verified differently: Prelinger

| Title | Identifier | Creator, date | Runtime | Statement |
| --- | --- | --- | --- | --- |
| A Trip Down Market Street Before the Fire (4K scan, 2018) | `MarketStreet19064KScan20181016` | Miles Brothers, 1906 | 6:45 | no `licenseurl`; `rights` reads "Anyone may reproduce or reuse this scan." |

This one is the exception that proves the proposal's second trap. The 1906 film is
long out of copyright, but the thing on offer is a **2018 4K scan**, and a new scan
or restoration can carry its own claim. Here the scanner says outright that anyone
may reuse it - so it is usable, on the strength of that sentence rather than on the
film's age.

**It asks for attribution**: "Please attribute it to its source: Prelinger
Archives." Cheap to honour in About, and it must actually be honoured.

## Rejected on sight

- Any Apollo or Duck and Cover copy uploaded by an individual account rather than
  by NARA or NTIS. Several exist, some with better picture. The licence evidence is
  a stranger's assertion instead of the agency's, and there is no reason to take
  the weaker one when the agency's own copy is right there.
- Feature-length public-domain standards - Night of the Living Dead, Nosferatu, His
  Girl Friday. Not on licence, on size: one of them is the whole budget, and the
  well-known prints are usually restorations with their own rights.

---

## The arithmetic, which the proposal's budget does not survive

The proposal budgeted 100-150 MB total for four to six items, with three of them a
series. The Apollo episodes are 28-29 minutes each, because that is what an episode
of a documentary series is.

At 480p H.264 with AAC audio, archival 4:3 footage:

| Bitrate | Per minute | One 28-min episode | Three of them |
| --- | --- | --- | --- |
| 464 kbps (400 video + 64 audio) | 3.5 MB | 97 MB | 292 MB |
| 314 kbps (250 + 64) | 2.4 MB | 66 MB | 198 MB |
| 250 kbps total | 1.9 MB | 53 MB | 159 MB |

So three episodes alone overrun the budget at every bitrate that flatters the app,
and the bottom row is soft enough that the demo would be arguing against the
product. **The proposal is right about the shape and wrong about the number.**

Three ways out, and this is the decision that needs making before anything is
downloaded:

- **A. Two episodes, not three.** Apollo 11 and Apollo 13 as a two-episode series at
  314 kbps is about 132 MB, plus Duck and Cover and Market Street at about 30 MB
  together: **~162 MB**, four items, still under the 200 MB point where the App
  Store asks before installing over cellular. A two-episode season proves the shows
  tree exactly as well as a three-episode one.
- **B. Three episodes, lower quality.** About 190 MB with the two shorts, leaving no
  room and a picture nobody would choose to show a reviewer.
- **C. Raise the budget to ~300 MB** and accept that a cellular install asks first.
  Buys three episodes at a bitrate that looks good, and a fifth item.

Recommended: **A**. The demo exists to prove the app works, and 162 MB of good
picture does that better than 190 MB of soft picture.

---

## What is still to do, in order

1. Decide A, B or C.
2. Download the chosen items from the identifiers above, from those exact items.
3. Encode to 480p H.264 in MP4 with AAC. Direct-playable, per the proposal: there
   is no host in demo mode and therefore nothing to remux.
4. Write `assets/demo-library/LICENCES.md` with the title, identifier, source URL,
   the licence field as quoted here, the date checked and which print it is.
5. Author an English `.srt` for one of them, ours, so subtitles are demonstrable
   without inheriting anybody else's caption file.
6. Decide the poster question - open question 4 in the proposal. NASA and NARA
   stills are public domain by the same statute, so the Apollo series can have real
   artwork rather than initials placeholders. Market Street and Duck and Cover need
   a frame grab, which is ours to make from a public-domain film.

## Sources

- [Duck and Cover, NTIS copy](https://archive.org/details/gov.ntis.ava11109vnb1)
- [The Eagle Has Landed: The Flight of Apollo 11](https://archive.org/details/gov.archives.arc.45017)
- [Apollo 13: Houston, We've Got a Problem](https://archive.org/details/gov.archives.arc.1155023)
- [The Mission of Apollo / Soyuz](https://archive.org/details/gov.archives.arc.1154974)
- [The Pleasure of Your Company](https://archive.org/details/gov.ntis.ava20403vnb1)
- [A Trip Down Market Street Before the Fire, 4K scan](https://archive.org/details/MarketStreet19064KScan20181016)
- [Prelinger Archive help page, on per-item licensing](https://help.archive.org/help/prelinger-archive/)
