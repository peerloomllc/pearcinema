// The relay: which key to offer, and what a relayed connection is allowed to cost.
//
// Approved 2026-08-18 (proposals/2026-08-18-relay-for-video.md, PR #92). The short
// version of why this exists at all: on a carrier that hands out a different external
// port per destination, the hole-punch cannot land, and a phone off wifi cannot reach its
// library AT ALL. Measured on Tim's Pixel over Google Fi - four HOLEPUNCH_ABORTED in a
// row, while PearTune on the same phone in the same minute worked, its relay baked in.
//
// Everything here is pure. The escalation itself - direct first, the key only after a
// punch has actually failed - belongs to @peerloom/client, which owns the dial; this
// module only answers "which key, if any" and "what does a relayed stream cost".

const z32 = require('z32')

// The deployed PeerLoom relay, shared with PearTune (its droplet, 2026-07-23). The same
// box because it is the same blind relay: it cannot read a stream, so which app's bytes
// it forwards is not a security question, only a capacity one. Its private seed lives on
// the relay box and in Tim's password manager, never here.
const RELAY_PUBLIC_KEY_Z = 'qshao3eawtzecrt5p7buswr4meyyhw6q6b51qtxazd8wwfdp8uqy'

const RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY_Z ? z32.decode(RELAY_PUBLIC_KEY_Z) : null

// Bring your own relay (the proposal's option C). A user who runs their own VPS relay
// pastes its key and no PeerLoom box is ever in their path - no bill, no third party, and
// nothing to trust but themselves. Their key WINS over ours when both exist: someone who
// went to the trouble of running a relay did not do it to keep using ours.
//
// Returns null for anything that is not a 32-byte z-base32 key, so a typo degrades to
// "no relay" rather than throwing inside a dial.
function parseRelayKey (z) {
  if (!z || typeof z !== 'string') return null
  try {
    const key = z32.decode(z.trim())
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

// Which relay key this dial may use, or null for direct-only.
//
//   force      - a previous dial in this connect aborted its hole-punch. The client sets
//                it; see @peerloom/client's ESCALATING_DHT_CODES for why PEER_NOT_FOUND
//                does not count.
//   randomized - our own NAT is double-randomized, so a punch can never work here.
//   useRelay   - the user's toggle (Settings -> Connection, default on). Off means pure
//                peer-to-peer: never touch a relay, and accept that a network which
//                cannot punch simply will not connect.
//   ownKeyZ    - the user's own relay key, if they run one.
//
// The client applies `force || randomized` before ever calling this, so the same test
// here is belt and braces rather than the gate itself. It is kept because this function
// is also the thing a person reads to answer "when does my film cross someone's server",
// and an answer that depends on a caller elsewhere is not an answer.
function relayThroughFor ({ force = false, randomized = false, useRelay = true, ownKeyZ = null } = {}) {
  if (!useRelay) return null
  if (!force && !randomized) return null
  return parseRelayKey(ownKeyZ) || RELAY_PUBLIC_KEY || null
}

// THE CEILING, forced whenever the bytes are relayed (Tim, 2026-08-18).
//
// 2500 kbps is 1.125 GB an hour: about 444 hours a month on the relay's 500 GB tier
// across every user, and about a penny an hour past it. The same number as Data Saver,
// and the same lever - `capsFor` already carries maxKbps through decide, the playlist and
// every segment, so there is one path to build and one to verify.
//
// Not a preference. A relayed connection gets the ceiling whether or not Data Saver is on,
// because the person choosing the quality is not the person paying for the transfer.
const RELAY_MAX_KBPS = 2500

// Apply it to a capability declaration. Returns the SAME object when nothing is relayed,
// so the direct path is untouched by this module existing.
//
// The min is load-bearing: a viewer who has turned Data Saver on has asked for something
// stricter than the relay demands, and a relay must never raise a ceiling the person set
// for themselves.
function capsWithRelayCeiling (caps, relayed) {
  if (!relayed) return caps
  const already = Number(caps?.maxKbps) || 0
  return { ...caps, maxKbps: already ? Math.min(already, RELAY_MAX_KBPS) : RELAY_MAX_KBPS }
}

module.exports = {
  RELAY_PUBLIC_KEY,
  RELAY_PUBLIC_KEY_Z,
  RELAY_MAX_KBPS,
  parseRelayKey,
  relayThroughFor,
  capsWithRelayCeiling
}
