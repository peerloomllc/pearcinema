# Relay for video, or an honest caveat

**Status**: PROPOSED 2026-08-18. Awaiting Tim's decision between the options in
"The fork" below. Nothing is built.

**Goal**: Decide whether PearCinema ships a relay so a phone off wifi can reach
its library at all, and if so, on what terms.

**Tier**: **T3.** It reverses a recorded architectural decision, adds a third
party to the data path, changes what the app promises about privacy, and carries
a running bill that scales with use. Rollback is easy in the code and hard in the
expectations, which is the part that makes it T3 rather than T2.

## Why this is open again

The relay was left out deliberately (`CLAUDE.md`, "No relay, by design") with
arithmetic behind it: PearTune's relay carried 163 MB in six days against a
500 GB/month tier, and video at 8 Mbps is 3.6 GB per hour. The accepted cost was
that users whose network cannot punch get no off-LAN path, and the answer offered
was "bring your own relay".

That was reasoning about a minority. On 2026-08-18 it stopped being a minority
question:

- Tim's Pixel, wifi off, Google Fi LTE, could not reach the Umbrel **at all**.
  Five minutes of attempts, every one
  `connect:dial-failed {"code":"EUNREACHABLE","dhtCode":"PEER_NOT_FOUND"}`.
- **Tim reproduced it independently** on the same day.
So on at least one major carrier, "your film collection, playable anywhere" is
currently "playable on wifi". That is the thing to fix or to say out loud.

### What is actually failing - and a correction

The first run's logs said `PEER_NOT_FOUND` every time, and the first reading of
that was "the DHT cannot even bootstrap on an IPv6-only carrier, so discovery
never happens". **That reading was wrong**, and a second run on the same phone
and network says so plainly - the same failure, but mostly a different code:

```
connect:dial-failed {"code":"EUNREACHABLE","dhtCode":"HOLEPUNCH_ABORTED"}
```

`HOLEPUNCH_ABORTED` means the peer WAS found and the punch was attempted and
failed. So the DHT works on this network; discovery works; what does not work is
the hole punch itself, which is exactly what carrier-grade NAT on one side and a
home router on the other is expected to do. (`PEER_NOT_FOUND` still appears
intermittently, which is a slower lookup rather than a broken one.)

**A relay therefore does fix it, and this is no longer a guess.** Two
independent confirmations on 2026-08-18:

- **Tim tested a relay-enabled build and reached his library over cell.**
- A control run on the same phone, same carrier, same minute: **PearTune**,
  which has the relay baked in, ran normally on mobile data while **PearCinema**
  sat in a loop of `HOLEPUNCH_ABORTED`. Same stack, same network, one difference
  - the relay.

That settles the question this proposal was originally unable to answer. The
remaining decision is not "would a relay work" but "on what terms do we ship
one".

## The fork

**A. Say it plainly.** No relay. The store listing, README and onboarding say
the app is for your own network, and off-LAN works only where the network
allows it. Cheapest, honest, and a real reduction in what the app claims.

**B. Ship the PeerLoom relay, throttled.** Tim's proposal. The relay exists and
is deployed for PearTune; the client policy (`peartune/protocol/relay.js`) is
written, direct-first, with a privacy toggle. PearCinema would bake the same key
and add what video needs and audio did not: a hard bitrate ceiling whenever the
bytes are relayed.

**C. Bring your own relay.** A settings field for the user's own relay key.
No bill, no third party in the path, and useless to anyone who will not run a
VPS. Worth having regardless of A or B.

These are not exclusive. The recommendation below is B **and** C, with A's
honesty applied to whatever B cannot reach.

## The arithmetic, which is the whole argument

Per hour of relayed video, at a 500 GB/month tier:

| Bitrate | Per hour | Hours/month the tier buys, across ALL users |
| --- | --- | --- |
| 8 Mbps (a typical direct-play film) | 3.6 GB | 139 |
| 4 Mbps | 1.8 GB | 278 |
| **2.5 Mbps (today's Data Saver ceiling)** | **1.125 GB** | **444** |
| 1.5 Mbps | 0.675 GB | 740 |

444 hours a month is about 15 hours a day of relayed video for the entire user
base. That is comfortable for a handful of households and gone by the ninth day
if a hundred people each watch half an hour off-LAN. The throttle is not a nice
touch; it is the only thing that makes a relay affordable at all, and even
throttled the tier is a headcount limit rather than a solved problem.

Two consequences worth stating before choosing B:

- **Relayed video must be converted, not direct-played.** A 2.5 Mbps ceiling on
  a 12 Mbps original means the host re-encodes. That is CPU on somebody's home
  machine for the whole time a relayed film plays - the N100 can do it, a Pi
  class box may not.
- **The relay sees traffic volume and timing, not content.** It is a blind
  relay: it cannot read the stream. But "PeerLoom's server was in the path" is a
  different sentence from "nothing leaves your network", and the app currently
  gets to say the second one.

## Scope, if B is chosen

**Changes:**

1. `protocol/relay.js` in this repo, adapted from PearTune's: `RELAY_PUBLIC_KEY`
   baked, `relayThroughFor` unchanged (direct-first: null on the first attempt,
   the key only after `HOLEPUNCH_ABORTED` or on a double-randomized NAT).
2. **A forced ceiling while relayed.** `capsFor` already carries `maxKbps` for
   Data Saver; relayed connections get the same lever applied automatically and
   unconditionally, not as a preference. Design point to settle: whether the
   ceiling is the existing 2500 kbps or lower (Open question 3).
3. **Detection, honestly labelled.** PearTune records that it OFFERED the relay
   at the `relayThrough` call site, because the phone's own `dht.stats.relaying`
   reads 0 while actually relaying and hyperdht keeps the real flag private. So
   "relayed" means "we offered the relay for this connection" and errs towards
   over-reporting. Any UI and any metric must use that word honestly.
4. **Consent, following PearTune's audio shape.** Per library, `ask` by default:
   browse, search and artwork cross the relay unprompted (kilobytes), PLAY asks
   once and remembers. Video makes this more important than it was for audio,
   not less.
5. **A visible marker while relayed**, so nobody is surprised: the cast bar and
   player already have room for one line.
6. **Metrics.** Bytes relayed per session and per month, counted on the phone,
   plus the relay's own totals. Tim asked for this explicitly, and without it
   the tier is a surprise rather than a budget.

**Not changing:** the wire protocol, pairing, grants, revoke. A relayed
connection is the same connection over a different path.

## Compat

Old peers are unaffected: `relayThrough` is a client-side connect option and the
host neither knows nor cares. A phone on an old build simply never relays. A
host on an old build serves a relayed phone exactly as it serves a direct one.
The consent state is new phone-local settings, defaulting to `ask`, so an
upgrade cannot silently start relaying.

## Verify

1. A phone that genuinely cannot punch reaches its library - the case that
   started this, reproduced on cell with wifi off.
2. Relayed playback never exceeds the ceiling: measured, not asserted, with
   `scripts/measure-scrub.sh` against a relayed connection.
3. Scrub latency over the relay, the measurement the LAN half already has.
4. Revoke still cuts a relayed stream within a second. The relay is a path, not
   an authority, but this is the security claim most worth re-proving on a new
   path.
5. Consent: a fresh library asks once before relayed play, remembers, and the
   sticky deny is reversible in that library's settings.
6. Byte counting agrees with the relay's own view, within reason.

## Rollback

Set `RELAY_PUBLIC_KEY_Z` to null. `relayThroughFor` returns null for every call
and the app is exactly as it is today, with no wire change and nothing to
migrate. Users who were relaying lose off-LAN access, which is where they
started. The expectations are the part that does not roll back.

## Open questions

1. ~~**Does a relay even help on the network that failed?**~~ **ANSWERED
   2026-08-18, twice**: Tim reached his library over cell on a relay-enabled
   build, and a same-minute control on the same phone had PearTune (relay baked
   in) working while PearCinema looped on `HOLEPUNCH_ABORTED`. The punch is what
   fails, not discovery, which is precisely the case a relay exists for.
2. **One carrier is one data point.** Confirm on a second network before
   concluding anything about the product. This is now about how WIDESPREAD the
   need is - and therefore about the bill - rather than about whether the relay
   works.
3. **What ceiling?** 2500 kbps matches Data Saver and looks acceptable on a
   phone. Lower stretches the tier and looks worse on a tablet. This is a
   product call, not a technical one.
4. **A per-user monthly cap?** A hard stop protects the tier from one heavy
   user, and is a miserable thing to hit mid-film. Suggested: no cap in v1, but
   ship the metrics first so the decision is made on numbers.
5. **Does relayed casting make sense at all?** A TV pulling a relayed stream is
   the heaviest case there is. Suggested: refuse it in v1 and say why.
