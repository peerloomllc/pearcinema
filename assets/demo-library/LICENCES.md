# The demo library, and why each film in it is ours to ship

Every film PearCinema bundles is here, with the evidence that it may be redistributed
inside a shipped binary. The films themselves are not committed - they are fetched and
encoded by `scripts/fetch-demo-films.sh` from the identifiers below. This file is, because
the evidence is the part that must not be re-derived later by somebody hoping it is fine.

**Checked 2026-08-26**, each against `https://archive.org/metadata/<identifier>`, which
returns that item's own `licenseurl` and `rights` fields. A collection page is not
evidence: the Prelinger collection is only about 65 per cent public domain and licences
per item.

Two traps this file exists to keep clear of:

1. **A film being old is not the test.** US public domain turns on publication, notice and
   renewal rather than on age.
2. **A restoration or a new scan can carry its own rights**, even of a film that is
   itself long free. The print matters as much as the title, which is why each entry
   below names the exact item rather than the film.

---

## Films

### Duck and Cover (1951)

- **Identifier**: `gov.ntis.ava11109vnb1`
- **Source**: https://archive.org/details/gov.ntis.ava11109vnb1
- **Creator**: Federal Civil Defense Administration. Produced by Archer Productions.
- **Item's `licenseurl`**: `http://creativecommons.org/licenses/publicdomain/`
- **Also**: a work of the US federal government, so public domain by 17 U.S.C. 105
  independently of what the archive says.
- **Print**: the NTIS copy, in the FedFlix and usgovfilms collections. Runtime 9:14.
- **Attribution required**: no.

### A Trip Down Market Street Before the Fire (1906)

- **Identifier**: `MarketStreet19064KScan20181016`
- **Source**: https://archive.org/details/MarketStreet19064KScan20181016
- **Creator**: Miles Brothers, 1906. Scanned by Internet Archive from 35mm held by
  Prelinger Archives, 11 October 2018.
- **Item's `licenseurl`**: none.
- **Item's `rights`**: "Anyone may reproduce or reuse this scan."
- **Why it is usable anyway**: the film is long out of copyright, but what is on offer is
  a 2018 4K scan and a scan can carry its own claim. The sentence above is the scanner's
  own permission, which is what makes this one safe - not the film's age.
- **Print**: `MarketStreet_4K_to_2K_cropped_higher_contrast.mp4`, the 2K derivative. The
  item's own original is a 91 GB 4K scan.
- **Attribution required**: **yes.** "Please attribute it to its source: Prelinger
  Archives." It is carried in the app's About screen, and that is not optional.

## TV Shows - The Apollo Missions

Three documentaries made for NASA in the early 1970s and narrated by Burgess Meredith.
They are a real series rather than three films grouped to look like one, which is what
makes the shows half of the demo honest. Two of the three ship; the third is verified and
left out for size.

### S01E01 - The Eagle Has Landed: The Flight of Apollo 11 (1969)

- **Identifier**: `gov.archives.arc.45017`
- **Source**: https://archive.org/details/gov.archives.arc.45017
- **Creator**: National Archives and Records Administration, from NASA. Local identifier
  255-HQ-194.
- **Item's `licenseurl`**: `http://creativecommons.org/publicdomain/zero/1.0/` (CC0 1.0)
- **Also**: a US federal government work, public domain by 17 U.S.C. 105.
- **Print**: the NARA MPEG-2, runtime 28:26.
- **Attribution required**: no.

### S01E02 - Apollo 13: Houston, We've Got a Problem (1970)

- **Identifier**: `gov.archives.arc.1155023`
- **Source**: https://archive.org/details/gov.archives.arc.1155023
- **Creator**: National Archives and Records Administration, from NASA. Local identifier
  255-HQa-200.
- **Item's `licenseurl`**: `http://creativecommons.org/publicdomain/zero/1.0/` (CC0 1.0)
- **Also**: a US federal government work, public domain by 17 U.S.C. 105.
- **Print**: the NARA MPEG-2, runtime 28:21.
- **Attribution required**: no.

### Verified but not shipped - The Mission of Apollo / Soyuz (ca. 1975)

- **Identifier**: `gov.archives.arc.1154974`
- **Source**: https://archive.org/details/gov.archives.arc.1154974
- **Item's `licenseurl`**: `http://creativecommons.org/publicdomain/zero/1.0/` (CC0 1.0)
- **Why it is not in the app**: size, not licence. It is 29:06, and a third episode puts
  the library past the point where the App Store asks before installing over cellular
  (Tim, 2026-08-26). It is the first thing to add if that budget ever moves.

---

## What we made ourselves

- **The encodes.** Every file the app ships is a 480p H.264 re-encode rather than the
  archive's own file. Public domain and CC0 both permit that. They must stay
  direct-playable, because demo mode has no host and therefore nothing to remux.
- **Any subtitle file** shipped beside these is written by us, so no third party's caption
  file is inherited along with it.
- **Any poster or frame grab** is taken from these films, which are public domain, or from
  NASA and NARA stills, which are public domain by the same statute.

## The rule for anything added later

An addition to this library is an addition to this file in the same commit, with the same
five things: the identifier, the source URL, the licence field quoted from the item's own
metadata, the date checked and which print it is. If a candidate cannot be given all five,
it does not ship.

Three other files move with it, and `test/demo-build-rule.test.js` fails until they do:
`assets/demo-library/manifest.json` (the catalogue the app builds from),
`scripts/fetch-demo-films.sh` (which produces the bytes and the poster) and
`shell/demo-assets.ios.ts` (which is what puts the file in the iOS build at all).

**And if the new item asks for attribution, the About screen changes too.** The credit
lives in App.jsx as prose, under "The films that come with the app", because it has to
survive the demo being retired - a print that has been played is credited whether or not
the demo is still on. A test cannot tell you that sentence has gone stale.
