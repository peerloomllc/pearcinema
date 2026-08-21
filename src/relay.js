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

// CONSENT, before a film crosses somebody else's server (proposal §4, PearTune's audio
// shape). Per library, `ask` by default. Returns what to DO rather than a boolean,
// because "cannot play" has two very different shapes: one asks the person, the other is
// a standing no they already gave.
//
//   'play'   - stream it
//   'ask'    - prompt once, then remember
//   'refuse' - a sticky deny. Do not prompt again; that library's settings row is where
//              it gets reversed
//
// THIS GATES THE FILM ONLY. Browsing, search, artwork and watch-state cross the relay
// with no prompt - they are kilobytes against a film's gigabytes, and gating them would
// mean someone on a hard-NAT network opens a library to an empty screen and a dialog,
// which moves the problem one step later rather than solving it. That is a DISCLOSED
// trade: the Connection section says films may pass through a relay, and it says it
// before this prompt ever appears. Do not route artwork or metadata through here without
// changing that copy too.
function relayVideoDecision ({ relayed, consent }) {
  if (!relayed) return 'play'
  if (consent === 'allow') return 'play'
  if (consent === 'deny') return 'refuse'
  return 'ask'
}

// A DOWNLOAD IS NEVER RELAYED (Tim, 2026-08-18, settling what the proposal left open).
//
// Playback over a relay is capped and that is the end of it: the session ends and nothing
// is kept. A download does not end - the copy on the phone is what gets watched on a
// television months later, so a moment spent off wifi would follow the film around
// forever at a quality nobody chose. It is also the heaviest thing the relay could carry,
// a whole film at once rather than an hour of it at a time.
//
// Returns what to DO rather than a boolean, and carries the sentence a person sees, so
// the reason and the wording cannot drift apart across the two paths that show it.
const RELAY_DOWNLOAD_REFUSAL =
  'This one needs wifi. You are connected through a relay right now, and a downloaded film should be the full-quality copy.'

function relayDownloadDecision ({ relayed }) {
  return relayed ? { action: 'refuse', message: RELAY_DOWNLOAD_REFUSAL } : { action: 'download', message: null }
}

// --- what it is costing, and the nudge -------------------------------------
//
// Tim's call, 2026-08-18: metrics and a warning, no hard cap. Going over the tier costs
// about a penny a gigabyte, so the thing a cap protects against is a few dollars, and the
// way it protects against them stops a film mid-scene. So this counts, shows, and nudges.
//
// The count is BYTES RECEIVED on the connection's UDX stream, sampled rather than tallied
// per chunk: one read covers playback, artwork, browse and the HLS segments at once.
//
// WHICH BYTES COUNT, and the correction that made this honest. A relayed connection is not
// a separate socket - hyperdht points the SAME udx stream at the relay's address
// (`c.rawStream.connect(socket, remoteId, remotePort, remoteHost)` in lib/connect.js), and
// a late punch repoints it at the peer with `changeRemote`. So counting every byte on a
// connection that was ever relayed counts the direct ones too: on Tim's phone that read
// 867 MB against about a minute of relayed video.
//
// The remote address is therefore the signal, and `relayStillOn` is the test: while the
// stream still points where the relay put it, the bytes are relayed; the moment it points
// somewhere else, the punch landed and this connection is direct - stop counting, lift the
// ceiling, drop the marker. It is a better answer than "we offered a relay" in every
// direction that matters.
function relayStillOn (firstAddr, nowAddr) {
  if (!firstAddr || !nowAddr) return true // nothing to compare yet: assume the relay
  return firstAddr === nowAddr
}

// AND THE OTHER HALF OF THE SAME SIGNAL, found on the TCL 2026-08-21. `relayStillOn` only
// notices a connection that MOVES, so it can never clear a connection that was direct from
// its first byte - and one of those is exactly what a phone at home gets. The phone marks a
// library relayed the moment it OFFERS the relay (peerloom-client sets relayOffered while
// building the dial options, before anything is known about the outcome), so one aborted
// hole-punch on the LAN was enough to flag all three libraries at home, cap the picture at
// 2.5 Mbps and tell Tim his films were coming through a relay. They were not.
//
// A relay is a machine on the public internet. So a stream pointing at a private address is
// proof of a DIRECT connection, whatever was offered. That is the one-way test this is:
// true means certainly direct, false means unknown rather than relayed.
//
// 100.64/10 is deliberately NOT here. It is carrier-grade NAT and it is also every
// Tailscale address, so somebody's own relay could legitimately live there.
function directByAddress (host) {
  const h = String(host || '')
  if (!h) return false
  if (h === '::1' || h.startsWith('127.')) return true                 // loopback
  if (h.startsWith('10.') || h.startsWith('192.168.')) return true     // RFC1918
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true             // RFC1918
  if (h.startsWith('169.254.')) return true                            // link-local
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true                       // IPv6 link-local
  if (/^f[cd][0-9a-f][0-9a-f]:/i.test(h)) return true                  // IPv6 unique-local
  return false
}

// The counter's shape, bumped when a stored total stops meaning what it says. Version 1
// counted every byte on a connection that had EVER been relayed, including the ones that
// flowed after a late punch moved the stream onto a direct path - which on Tim's phone
// read 867 MB against about a minute of relayed video (2026-08-18). A total that is wrong
// by an order of magnitude is worse than no total, so a file at an older version is
// discarded rather than migrated.
const USAGE_VERSION = 2

// A month's worth for one person before they hear about it. 20 GB is roughly 18 hours of
// relayed video, and about 4% of the 500 GB tier - a heavy share for one household rather
// than a limit anybody bumps into by watching normally. Phone-side, so it can move
// without redeploying the relay.
const RELAY_WARN_BYTES = 20 * 1000 * 1000 * 1000

// Which month a moment belongs to, in the phone's own timezone: a person reads "this
// month" off their own calendar, not UTC's.
function monthKey (now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Fold a sample into the running total, rolling over on a new month. Pure: the caller
// does the reading and the writing, so the rollover is testable without waiting for one.
//
// A NEGATIVE delta is dropped rather than subtracted. The counter it comes from lives on
// a UDX stream, so a reconnect starts a fresh one at zero - counting that as -3 GB would
// silently erase a month of real usage.
function addUsage (usage, { bytes, libraryId = null, now = new Date() } = {}) {
  const month = monthKey(now)
  const usable = usage?.v === USAGE_VERSION ? usage : null
  const base = usable?.month === month ? usable : { month, bytes: 0, byLibrary: {} }
  const add = Number(bytes) > 0 ? Math.round(Number(bytes)) : 0
  const byLibrary = { ...(base.byLibrary || {}) }
  if (libraryId) byLibrary[String(libraryId)] = (byLibrary[String(libraryId)] || 0) + add
  return { v: USAGE_VERSION, month, bytes: (base.bytes || 0) + add, byLibrary }
}

// What to tell them, if anything. Returns null when there is nothing worth saying, so a
// caller cannot accidentally render an empty nudge.
function usageWarning (usage, { warnBytes = RELAY_WARN_BYTES, now = new Date() } = {}) {
  if (!usage || usage.v !== USAGE_VERSION || usage.month !== monthKey(now)) return null
  const bytes = Number(usage.bytes) || 0
  if (bytes < warnBytes) return null
  const gb = Math.round(bytes / 1e9)
  return {
    bytes,
    gb,
    // Said as a fact and a suggestion, not an accusation, and it never asks them to stop
    // watching - the relay is shared, so the ask is to use wifi where wifi exists.
    message: `You have watched about ${gb} GB through the relay this month. It is shared with everyone else using PearCinema, so wifi is kinder to it where you have it.`
  }
}

// The standing no, in the words the person sees. Their own earlier answer, so it points
// at where to change it rather than apologising.
const RELAY_PLAY_REFUSAL =
  'You chose not to play films from this library over a relay. You can change that in Settings, under Connection.'

module.exports = {
  relayStillOn,
  directByAddress,
  USAGE_VERSION,
  RELAY_WARN_BYTES,
  monthKey,
  addUsage,
  usageWarning,
  relayVideoDecision,
  RELAY_PLAY_REFUSAL,
  RELAY_DOWNLOAD_REFUSAL,
  relayDownloadDecision,
  RELAY_PUBLIC_KEY,
  RELAY_PUBLIC_KEY_Z,
  RELAY_MAX_KBPS,
  parseRelayKey,
  relayThroughFor,
  capsWithRelayCeiling
}
