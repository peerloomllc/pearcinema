# Relay for video, or an honest caveat

**Status**: PROPOSED 2026-08-18. **Option B chosen by Tim on 2026-08-18**, with
C alongside it, and the three open terms settled the same day: a forced
**2500 kbps** ceiling while relayed, relayed **casting allowed**, and **no hard
data cap - metrics plus a warning**. Nothing is built; merging this PR is the
approval.

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

## Relay to start, direct once punched - already built (Tim's question, 2026-08-18)

Tim asked whether the relay could carry only the initial connection, and once
the punch finds a working UDP path, whether we could bind to it, remember it and
drop the relay. **Yes, and hyperdht already does exactly that** - worth writing
down, because it changes the cost model.

Three things are already true in `node_modules/hyperdht`:

1. **Direct is always tried first.** `relayThroughFor` returns null on the
   opening attempt; the relay key is only offered after `HOLEPUNCH_ABORTED`, or
   immediately when the DHT has already established that this NAT can never be
   punched (`dht.randomized`). A relay is never in the path of a connection that
   could have been direct.
2. **The relay keeps a failed connection alive rather than replacing it.**
   `maybeDestroyEncryptedSocket` (`lib/connect.js:763`) returns early on
   `if (c.relaySocket) return // waiting for the relay`. That is precisely why a
   relay-enabled build reaches the library where this one gives up.
3. **The upgrade Tim describes is implemented, and carefully.** In `c.onsocket`
   (`lib/connect.js:498`), if a punch succeeds while the stream is already
   connected through the relay, it calls `rawStream.changeRemote(...)` and then
   `confirmDirectUpgrade` (`lib/relay-connection.js:20`). That sends a
   zero-length UDX probe down the direct path, waits until real data actually
   arrives over it, and only then closes the relay connection. The live stream
   moves across without dropping, and the relay is not abandoned on the strength
   of a hopeful assumption.

**What this changes about the bill.** The relay is not paid for by every user,
only by connections whose punch never lands. Anyone whose punch succeeds late
pays for a few seconds of relayed traffic and then costs nothing. The arithmetic
above is a worst case per hard-NAT user, not a per-user cost.

**What it does not fix, which is Tim's own case.** Remembering a port cannot help
where the punch fails for the reason carrier-grade NAT fails it: the carrier
hands out a DIFFERENT external port per destination, so the port learned through
the DHT is not one that would ever have worked, and there is nothing correct to
remember. His logs show four aborted punches in a row, so those connections would
stay relayed for their whole life.

One honest gap in this reading: the upgrade fires when a punch SUCCEEDS, and I
did not find a periodic re-punch while a connection sits relayed. So it rescues
connections whose punch lands late, not ones where it never lands. Each NEW
connection does try direct first, and the app now reconnects on app resume and on
pull-to-refresh, so there are natural retry points.

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

**Chosen 2026-08-18: B, with C alongside it.** Tim's own phone is the case B
exists for, and C costs a settings field. A's honesty still applies to the
~0%-punch users the relay cannot afford to carry indefinitely.

## The arithmetic, which is the whole argument

The relay is PearTune's deployed box: DigitalOcean's **$4 Basic tier, 500 GB of
transfer a month, overage $0.01/GiB** (peartune `DECISIONS.md`, 2026-07-28
correction). DO bills outbound only, so a relayed film is billed once - the
relay receives from the host for free and sends to the phone for money - and the
table below is the bill rather than half of it.

Per hour of relayed video:

| Bitrate | Per hour | Hours/month the tier buys, across ALL users | Cost per hour past the tier |
| --- | --- | --- | --- |
| 8 Mbps (a typical direct-play film) | 3.6 GB | 139 | ~$0.034 |
| 4 Mbps | 1.8 GB | 278 | ~$0.017 |
| **2.5 Mbps (chosen - today's Data Saver ceiling)** | **1.125 GB** | **444** | **~$0.011** |
| 1.5 Mbps | 0.675 GB | 740 | ~$0.006 |

444 hours a month is about 15 hours a day of relayed video for the entire user
base. That is comfortable for a handful of households and gone by the ninth day
if a hundred people each watch half an hour off-LAN. The throttle is not a nice
touch; it is the only thing that makes a relay affordable at all, and even
throttled the tier is a headcount limit rather than a solved problem.

Overage is worth stating precisely, because it changes the SHAPE of the risk
rather than its size. At a penny a gigabyte, running over is a trickle, not a
cliff: a month at double the tier is about $5 on top of the $4. The reason to
throttle is therefore the phone's experience and the home machine's CPU first,
and the bill second. It is also why a hard per-person cap is hard to justify
(open question 4, answered below) - the thing it protects against costs dollars,
and the way it protects against them stops a film mid-scene.

Two consequences worth stating, both of which survive choosing B:

- **Relayed video must be converted, not direct-played.** A 2.5 Mbps ceiling on
  a 12 Mbps original means the host re-encodes. That is CPU on somebody's home
  machine for the whole time a relayed film plays - the N100 can do it, a Pi
  class box may not.
- **The relay sees traffic volume and timing, not content.** It is a blind
  relay: it cannot read the stream. But "PeerLoom's server was in the path" is a
  different sentence from "nothing leaves your network", and the app currently
  gets to say the second one.

## Scope (B, chosen 2026-08-18)

**Changes:**

1. `protocol/relay.js` in this repo, adapted from PearTune's: `RELAY_PUBLIC_KEY`
   baked, `relayThroughFor` unchanged (direct-first: null on the first attempt,
   the key only after `HOLEPUNCH_ABORTED` or on a double-randomized NAT).
2. **A forced ceiling while relayed: 2500 kbps** (settled 2026-08-18).
   `capsFor` in `src/bare.js` already carries `maxKbps` for Data Saver, set to
   the same `DATA_SAVER_KBPS = 2500`; relayed connections get that lever applied
   automatically and unconditionally, not as a preference, and it wins over a
   Data Saver toggle that is off. Reusing one constant and one seam is most of
   the reason for the number: `capsFor` already rides the capability declaration
   through decide, the playlist and every segment, so there is one path to build
   and one to verify rather than a second parallel ceiling.

   Two notes that follow from picking 2500 rather than something higher:
   - **It forces a re-encode, but so would any ceiling.** A typical film is
     8 Mbps or more, so 4000 would transcode just as surely as 2500 does. The
     home machine's CPU cost is the same either way, which removes the usual
     argument for a higher number.
   - **The ceiling is a cap, not a target.** A film already under 2500 kbps
     relays untouched - `capBitrate` takes the min, so a low-bitrate source is
     not re-encoded UP to the ceiling.
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
6. **Metrics, and a warning rather than a wall** (settled 2026-08-18). Bytes
   relayed per session and per month, counted on the phone, plus the relay's own
   totals. No hard per-person cap: instead the person can see their own month to
   date, and crosses a threshold into a plainly worded warning that they are a
   heavy share of a shared allowance. A film in progress is never cut off. The
   threshold is a phone-side constant so it can move without a release of the
   relay, and the wording is a nudge, not an accusation.
7. **Relayed casting stays on** (settled 2026-08-18), and costs the relay almost
   nothing - see below. No new work beyond letting the existing cast path run
   over a relayed connection and counting its bytes like any other.

**Not changing:** the wire protocol, pairing, grants, revoke. A relayed
connection is the same connection over a different path.

### Casting over the relay, and a correction to what this proposal first assumed

Open question 5 asked whether relayed casting makes sense, and suggested
refusing it because "a TV pulling a relayed stream is the heaviest case there
is". **That premise is wrong for this app**, and the code says so:

- `cast.play` in `src/bare.js` sends a COMMAND to the host. The phone does not
  carry the film to the television.
- The host mints the URL the television fetches:
  `` `http://${castHost()}:${this.port}/v/${token}` `` (`host/cast.js:431`),
  where `castHost()` picks the host's own non-internal IPv4 (`host/cast.js:109`).
  The television is one Home Assistant discovered on the host's network, so it
  pulls the film from the host over the LAN.

So a phone on cell that starts a film on the television at home puts only the
command, the cast list and the position polling across the relay - kilobytes
against the gigabytes it does not carry. Relayed casting is the CHEAPEST thing
the relay does, not the most expensive, and refusing it would have given up the
best-value feature the relay buys.

Two things that do not change: the 2500 kbps ceiling does not apply to a cast
(the bytes are not relayed, so throttling them would degrade a stream for no
saving), and **revoke must still stop the television** - the third inherited
rule in `CLAUDE.md`, unchanged by the path the command arrived on.

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
7. The ceiling is forced, not preferred: relayed play caps at 2500 kbps with
   Data Saver OFF, and a source already below 2500 kbps is not re-encoded up.
8. Casting from off-LAN: a phone on cell starts a film on a television at home,
   and the relay's byte count for that session stays in the kilobytes - the
   claim in "Casting over the relay" measured rather than asserted.
9. The warning fires at the threshold and never interrupts: a session that
   crosses it keeps playing to the end of the film.

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
3. ~~**What ceiling?**~~ **ANSWERED 2026-08-18: 2500 kbps**, forced whenever the
   bytes are relayed. It matches the existing `DATA_SAVER_KBPS`, so one lever
   and one seam cover it; it costs 1.125 GB an hour, about 444 hours a month on
   the tier and about a penny an hour past it; and since any ceiling below a
   typical 8 Mbps film forces a re-encode anyway, a higher number would have
   bought a better picture at the same CPU rather than a cheaper one. A device-
   aware ceiling (higher on a tablet) was considered and rejected as two paths
   to verify for a small saving.
4. ~~**A per-user monthly cap?**~~ **ANSWERED 2026-08-18: no hard cap, but warn
   the person.** They can see their own month to date and get a plainly worded
   nudge past a threshold; a film in progress is never stopped. At $0.01/GiB the
   thing a cap protects against is a few dollars, and the protection would cost
   somebody the end of a film. Revisit once the metrics have a month of real
   numbers behind them.
5. ~~**Does relayed casting make sense at all?**~~ **ANSWERED 2026-08-18: yes,
   allow it - and the question rested on a wrong premise.** The host casts and
   the television pulls from the host's own LAN address, so the relay carries a
   command rather than a film. See "Casting over the relay" above for the code
   that establishes it.
