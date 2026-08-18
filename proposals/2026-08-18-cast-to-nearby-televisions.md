# Casting to a television the host has never met

**Status**: PROPOSED 2026-08-18, costed rather than scheduled. Tim's question, asked
while the relay terms were being settled: "Can we cast to devices that are NOT on Home
Assistant but are on the same network as the phone?"

**Short answer**: yes, and the hard parts are solved by other people. But it inverts the
direction the film travels, which is where the whole cost sits - and it costs a security
invariant that today is free.

**CORRECTED 2026-08-18, same day.** Tim named a second case this was quietly folding into
the first: **a library owner who does not run Home Assistant at all.** That is a
completely different feature with a completely different price, and lumping the two
together made the cheap one look expensive. See "Two questions, not one" immediately
below. The recommendation at the bottom changed as a result.

**Tier**: **T3 if built as described.** It makes the phone serve film bytes on the LAN,
which is a new listening surface on a device that today listens to nothing, and it moves
the enforcement point for revoke off the host and onto the phone. Neither is a rollback
you can do quietly.

## Two questions, not one

| | who finds the TV | who serves the film | revoke still works | cost |
| --- | --- | --- | --- | --- |
| **A. No Home Assistant** | the HOST, itself | the host, as today | **yes, unchanged** | moderate |
| **B. A TV only the phone can see** | the phone | the PHONE | weakened, permanently | large |

They feel like one question - "cast to a television that is not in the list" - and they
are not. **A is a dependency problem: casting works, but only for people who already run
Home Assistant.** B is a topology problem, and it is the one the rest of this document
costs.

### A. The host casts without Home Assistant

Today `host/speakers.js` is Home Assistant's REST API and nothing else, so a library owner
with a Chromecast in the living room and no HA has no casting at all - not because
anything technical is missing, but because a fairly involved piece of home-automation
software is in the way. That is a real gate: HA is a reasonable thing for a NAS owner to
run and an unreasonable thing to require.

**Nothing about the topology changes.** The host still discovers, still commands, still
mints its own LAN URL, still serves the film itself, and still stops the television on
revoke. Every invariant in `CLAUDE.md` survives untouched, because the host stays the one
holding both halves.

What it needs is a second backend behind the interface `speakers.js` already defines
(`enabled`, list, `play`, `stop`, `getState`, `canSeek`) - and unlike the phone, **the
host is Node**, where UDP and TLS are ordinary:

- **Discovery**: mDNS for `_googlecast._tcp`, and SSDP for Roku. `bonjour-service` is MIT
  and actively maintained (last published 2026-07-28).
- **Control**: the Cast protocol is TLS + protobuf. `castv2` is MIT but last published in
  2022, which is the risk to weigh - it is a stable protocol and a small surface, but an
  unmaintained dependency in the path of a feature is a thing to accept knowingly rather
  than by omission. Roku's ECP needs no library at all: it is plain HTTP on port 8060.
- **Serving**: already built. `host/cast.js` mints `/v/<token>`, tracks position, reports
  progress and stops the device on revoke, all of it independent of how the command got
  there.

The honest catch: discovery is per-network, so a host that cannot see the television on
its own LAN still cannot cast to it - which is correct, and is exactly the boundary that
makes B a separate feature.

**This is the half worth building**, and it is worth building before anyone asks for B.

## What casting is today, and why the question comes up

The host does the casting. The phone sends a command; Home Assistant, running on the
host's network, tells the television to fetch a URL the host minted for its own LAN
address (`host/cast.js:431`, `castHost()` at `:109`). The film goes host -> television
over their shared network. The phone is a remote control.

That is why relayed casting is nearly free (see `2026-08-18-relay-for-video.md`,
"Casting over the relay"), and it is also exactly why a television standing next to the
phone is invisible:

1. **It is not in the host's Home Assistant**, so it is not in the target list.
2. **Even if it were listed, the URL would not work.** A hotel television, a friend's
   living room, or a stick in a bedroom the owner never added, cannot reach an address on
   the host's home network.

So this is not a missing button. It is a different topology.

## The topology it needs

    today          host --------------- television        (one LAN, phone just asks)
    proposed       host --- phone --- television          (phone in the middle)

The phone must therefore do three things it does not do today: **find** the television,
**speak** to it, and **serve** it the film.

### 1. Finding it - solved, by the platform

Google Cast devices announce over mDNS (`_googlecast._tcp`), Roku over SSDP, AirPlay over
Bonjour. None of that has to be hand-rolled:

- **Android**: the official Google Cast SDK, via `react-native-google-cast`. Discovery,
  the cast button, the session and the media controls, all native.
- **iOS**: the same library, plus **AirPlay is nearly free** - the system video player
  already offers a route picker, so an AirPlay television is reachable with no discovery
  code at all.
- **Roku**, if wanted separately: ECP is plain HTTP on port 8060, no SDK and no TLS.

What it costs: a native module means `expo prebuild` and a config plugin, Google Play
Services on Android, and on iOS the **Local Network permission prompt** - which is the
rule-7 case that cannot be tested on a Simulator at all.

Doing it inside the Bare worklet instead is the wrong path and worth ruling out here: the
worklet has `bare-tcp`, `bare-http1` and `bare-dns`, but **no UDP and no TLS**. mDNS needs
multicast UDP and the Cast protocol (CASTV2) needs TLS, so both would be new native
dependencies before a line of app code. The platform SDK already has them.

### 2. Speaking to it - solved by the same SDK

`loadMedia({ contentUrl, contentType, metadata })` and the transport controls. Nothing to
design. The receiver is the Default Media Receiver, the same one the host already targets,
with the same conservative codec story: **H.264 in MP4, AAC audio**. That matters more
here than it does today, because the phone cannot convert anything - see §4.

### 3. Serving it - THIS is the expensive part

The phone's shim binds `127.0.0.1` and always has (`@peerloom/client/src/shim.js:17`:
"nothing outside the phone can reach it"). A television cannot fetch from that. So the
shim would have to bind the LAN, and the moment it does:

- **It is a media server on somebody's wifi.** On a hotel or cafe network that is every
  other guest. The URL must carry an unguessable per-session token, and the server must
  refuse everything else - the host's own cast server already does exactly this
  (`host/cast.js`, `/v/<token>`), so the shape is known.
- **The bytes cross the phone twice.** Host -> phone -> television. On wifi that is
  invisible; on cellular the phone pays for the entire film in mobile data, and over the
  relay it is the whole film across PeerLoom's allowance rather than the kilobytes a
  command costs today. A two-hour film at the relay's 2500 kbps ceiling is 1.1 GB of
  somebody's data plan.
- **The phone must stay awake and in range** for the whole film. Today a phone can be put
  down, taken out of the house, or run out of battery while the television plays on,
  because the phone was never in the path.

## The invariant this costs, which is the real argument

`CLAUDE.md` carries three inherited rules, and the third is that **revoke must actively
stop a cast**, because a television is not a HyperDHT connection and `connections.kill()`
cannot silence it. Today the host owns both halves: it kills the connection AND tells Home
Assistant to stop the television.

With the phone in the middle, the host can only do the first. It can cut the phone off
mid-film - proven within a second, `test/relay-revoke.test.js` - but the television is
being served **by the phone**, and a phone with a few seconds of film buffered, or a
downloaded copy on disk, can keep playing after its access has ended.

So this feature has to bring its own enforcement: the phone must stop its own cast when it
loses its grant, and that is a promise made by the revoked party about itself. It is
weaker than what exists today and it cannot be made as strong. That is not a reason to
refuse it, but it IS the thing to decide knowingly rather than discover later.

## What it cannot do at all

**Convert anything.** The host transcodes; the phone does not carry ffmpeg and should not.
So a film the television cannot decode natively has to be converted **by the host** before
it reaches the phone - which is a request the phone must make on the television's behalf,
describing a device it has only just met. The declaration plumbing already exists
(`capsFor`, `media.decide`), so this is wiring rather than invention, but it means:

- a film that direct-plays to the phone may need converting for the television, and the
  host does that work while the phone relays it
- the phone must describe the TELEVISION, not itself, which is a third capability
  declaration alongside "this phone" and "downloads"

## The cheap slice, if this is ever wanted

Not everything above is needed to answer the question that started it. In rough order of
value per unit of work:

1. **AirPlay on iOS: nearly free.** The system player's route picker already lists Apple
   TVs and AirPlay televisions on the phone's network. No discovery, no serving, no new
   port - the OS handles the stream. It is not Chromecast, and it is iOS only, but it is
   the one version of this that costs almost nothing.
2. **Roku over ECP**, if a Roku is on the phone's network: plain HTTP, no SDK, no TLS. It
   still needs the LAN-bound shim and its token, so it carries most of §3's cost.
3. **Chromecast via the Cast SDK**: the full feature, the full cost, the prebuild, the
   permission prompt, and the invariant above.

## Recommendation

**Build A. Do not build B yet, and do not promise it.**

A removes a dependency that gates an existing feature behind somebody else's home
automation stack, changes no topology, weakens no invariant, and reuses the serving,
tokening, position-reporting and revoke machinery that already ships. The work is a
discovery module and a control module behind an interface that already exists.

As for B:

**Do not build it yet, and do not promise it.** The relay work just made the current
casting story unusually good - starting a film on the television at home while you are
out costs the relay kilobytes - and this feature is that story's opposite in every
dimension: the phone in the path, the data on somebody's plan, and a weaker revoke.

Revisit when there is a real person with a real television the host cannot see. At that
point start with AirPlay on iOS, because it is the slice that costs almost nothing, and
let it show whether the demand is for "cast to any television" or specifically for
Chromecast.

## Open questions

1. ~~**Is the wanted case a hotel, or a friend's house?**~~ **ANSWERED 2026-08-18: a
   friend's house, AND a library owner who does not run Home Assistant.** The second half
   is feature A above and does not need any of B - it is the case this document was
   originally blind to.
   The friend's house half is still worth stating plainly: somewhere a person RETURNS to
   is usually better answered by giving that friend their own grant, which already works
   and costs nothing new. Their television then talks to the library directly, on the
   host's terms, with revoke intact. B is for the television nobody is coming back to.
2. **Would a downloaded film casting count?** It is the one case with no bandwidth
   argument against it: the film is already on the phone. It is also the case where revoke
   has the least purchase, since nothing has to be fetched for playback to continue.
3. **Does the phone stop its own cast on revoke, on losing its grant, or on both?** The
   answer decides how honest the feature's security story can be.
