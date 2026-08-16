# The desktop app is a client as well as a host

**Status**: APPROVED 2026-08-16 (Tim, via PR #64). Both open questions answered the
same day: the fork appears only on truly blank installs (no source and no remote
library), and a client-only desktop writes watch state to the friend's server as
just another device of whoever paired it.

**Goal**: One desktop app, two answers to whose films these are. "My server" is
today's flow - folders, password, pairing devices. "A friend's server" is the
new one: this machine holds nothing, pairs with somebody else's host over the
DHT exactly as a phone does, and browses and plays THEIR library in the same
dashboard pages. Not a separate viewer app - additional functionality in the
existing tray app (Tim, 2026-08-16, refining his 2026-08-13 ask).

**Tier**: **T2.** No wire change - the desktop presents a device key and pairs
like any phone, and the remote host authorizes it with the same host-local
grant it gives every device. What earns the proposal is new persisted state
(a CLIENT identity keypair and a hosts.json on the desktop, the phone's exact
shape) and a new dashboard surface that proxies remote streams. An old host
and a new desktop, or the reverse, keep talking regardless.

**Depends on**: `@peerloom/client` running in Node (landed 2026-08-14, built
for exactly this), the desktop tray app (PR #59) and the dashboard web player.

---

## What exists and what is missing

The dashboard assumes the machine it runs on IS the library: every read goes
straight to its own adapter, every screen is the operator's. The web player,
the capability seam, remux and HLS all work - against local films only.

The phone's worklet already holds the other half: a device identity, a host
list, N connections, per-item routing and a loopback shim that turns P2P
streams into plain HTTP a player will open. `src/bare.js` proved the shape;
`@peerloom/client` was extracted so a Node process could reuse it verbatim.
This proposal is that reuse.

## Design

### 1. The client stack lives in the HOST PROCESS, beside the host

A new `host/remote.js` owns:

- **A client identity** (`remote-identity.json` in the data dir), separate
  from the host's own keys. It is this MACHINE's device key when it knocks on
  someone else's door; losing it means re-pairing, exactly like a phone.
- **The remote host list** (`remote-hosts.json`), via `@peerloom/client/hosts`
  - the same pure bookkeeping the phone persists.
- **Connections on demand**, one per remote library, single-flight, off one
  shared DHT node - `src/bare.js`'s `connectedLib` pattern, in Node.

The tray app changes not at all; the host process simply grows an outbound
side. A desktop with no source configured and one remote library is "just a
client" without ever being a different program.

### 2. The dashboard grows the pairing fork and the remote pages

- **First run** asks the question PearTune's setup asks, wording already
  tested on a real person: **My server** (today's source wizard) or **A
  friend's server** (paste the pairing link - a desktop has no camera, and
  every pairing QR already carries its link underneath for exactly this).
- **Settings › Remote libraries**: paste-to-pair another, rename-follows-host,
  remove (which tells the remote host to drop this machine's grant,
  best-effort, like the phone's leave).
- **Browsing**: the existing library pages render a remote catalog through
  proxy endpoints (`/api/remote/<lib>/...` mirroring the local `/api/...`
  reads). One library at a time in v1 - the switcher names Mine plus each
  remote. Merging desktop-side comes later and follows the phone's shipped
  merge if it comes at all.

### 3. Streaming - the dashboard server becomes the desktop's shim

The web player keeps asking for plain loopback HTTP; new routes on the
dashboard server answer for remote items the way `src/bare.js`'s shim answers
for the phone:

- `/remote/<lib>/stream/<itemId>` - Range honoured, bytes off `streamTo`.
- `/remote/<lib>/hls/<itemId>.m3u8` and its segments - `media.playlist` and
  `media.segment` proxied, capabilities riding every call.
- Art likewise, through the existing content-addressed art cache.

The BROWSER's capabilities drive `media.decide` on the remote host - the same
seam as everywhere: the client states facts, the host holding the file
decides. A remote HEVC film the browser cannot open arrives transcoded by the
FRIEND's hardware, not ours; the desktop never re-encodes someone else's
stream (and has no relay - the no-relay rule is untouched).

### 4. What this must NOT touch

- **The grant store stays host-local on every host.** The friend's host
  authorizes this desktop; nothing replicates.
- **Revoke still kills live connections** - when the friend revokes this
  desktop, the connection dies within a second and the dashboard page says so
  plainly rather than spinning.
- **The dashboard password rules are unchanged.** The remote pages ride the
  same loopback-or-password gate as everything else; a remote library must
  never be reachable to someone the DASHBOARD would refuse.

## Phasing

- **Phase 1 (this proposal)**: the fork, paste-to-pair, browse and play one
  remote library (direct, remux and HLS through the proxy), watch state
  written to the remote host (it is the authority for its own films), remove.
- **Phase 2**: parity extras - downloads to the desktop, requests, the
  friend's-server equivalents of the phone's shelves - each small once the
  connection and routing exist.

## Verify

- **Unit**: remote.js bookkeeping (identity persist, host add/remove, the
  single-flight connect) against a testnet host, the proxy routes against a
  fixture host (the person-sync test rig already spins both ends in-process).
- **Hardware**: pair the Linux desktop app to the Umbrel over the real DHT,
  browse the 3TB library in the dashboard, play an h264 film (direct), an
  HEVC film (transcoded by the Umbrel's N100), seek both; revoke the desktop
  on the Umbrel dashboard and watch the page lose access within a second.

## Open questions

1. **Does the first-run fork gate the wizard even when a source exists?**
   Existing installs (the Umbrel, the Mac) have sources; they should never
   see the fork. Recommendation: the fork appears only when there is no
   source AND no remote library - a machine that is already something skips
   the question.
2. **Watch state for a client-only desktop** - written to the remote host
   under this machine's device identity (recommendation: yes, it is just
   another device of whoever pairs it; the friend's host attributes it to
   the person the grant belongs to, the multi-device model already shipped).
