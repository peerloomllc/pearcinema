# Say goodbye to a revoked device

**Status**: PROPOSED 2026-08-22, after walking the app as a guest and watching what
being cut off actually looks like. Nothing is built; merging this PR is the approval.

**Goal**: A friend whose access has been withdrawn should be told that, instead of
being told their network is broken.

**Tier**: **T3.** It changes what the auth gate says to a peer it refuses, and
`gate.js` currently says nothing on purpose. Everything else here is small.

## What being cut off looks like today

Walked on the TCL, paired as a guest to a test library, revoked mid-film:

- The film keeps playing from what it already buffered, which is deliberate and
  fine (DECISIONS 2026-08-14).
- The next thing the person touches says **"could not reach the host"**.
- Settings shows the library as **"Active, connecting…"**, for good.
- The phone retries every nine seconds, forever. The ex-owner's log fills with
  `gate:deny {"device":"wphrjt75","reason":"device-revoked"}`, one line per retry,
  and nothing ever stops.

So the person blames their wifi, restarts the app, checks their signal, and
eventually asks the owner why their server is down. The owner, who deliberately
removed them, gets to have that conversation.

**The host knows exactly why.** `decide()` returns `device-revoked` and the log
records it. The phone is told nothing at all.

## The rule that is in the way, and why it does not cover this

`gate.js` says it plainly:

> `reason` is for the host log and the dashboard; it is never sent to the peer,
> because telling an attacker WHY they were refused is free intelligence.

That is right for a stranger. It is not right here, and the difference is provable
rather than a matter of taste: a revoked device has **already proved possession of
a key this host once granted**. It knows the library exists, it knows it had
access, and it has the host key. There is nothing left to leak.

So the line is drawn at the grant, not at the refusal:

| `decide()` reason | Peer is told |
| --- | --- |
| `no-grant` | **nothing**, exactly as today - an unknown key learns nothing |
| `device-revoked` | "this library is no longer shared with you" |
| `person-revoked` | the same |
| `grant-expired` | "your access to this library has ended" |

## Scope

**The host.** A connect from a key with a TOMBSTONED grant is accepted for one
frame and destroyed. Not admitted: accepted, written to, destroyed - a goodbye and
nothing else, on a path that never reaches `serveMedia`, never builds a `ctx`,
never sees the method table.

**REVOKE'S GUARANTEE IS NOT WEAKENED AND THIS IS THE PART TO REVIEW HARDEST.** The
acceptance test is "revoke cuts off all NEW access within a second". A goodbye
connection can browse nothing, stream nothing and call nothing, because the method
table is not on it. The test for this is not "the goodbye arrives" - it is that a
revoked device holding that connection is refused every method it tries.

Bounded, because it is a socket a refused peer can open: one frame, then destroy;
a hard cap on how often one key gets a goodbye (once per minute is generous); and
the whole path is skipped for `no-grant`, so an unknown key still gets silence and
cannot use this to make a host talk.

**The phone.** On a goodbye: stop reconnecting to that library, mark it in the
host list, and say so where the library would be - "Ada's Films is no longer shared
with you", with Remove offered right there. It stays in the list until the person
removes it, because silently deleting somebody's library is worse than the bug.

**The back-off, which is worth having on its own.** Nine seconds forever is wrong
even for a host that is genuinely off: it should decay to a minute or two. That
half needs no protocol change and helps against every old host that will never say
goodbye - which, on the day this ships, is all of them.

## Compat

An old host says nothing and the phone behaves exactly as it does today, minus the
hammering. A new host talking to an old phone sends a frame the phone ignores. No
stored shape changes. Nothing to migrate.

## Verify

Automated: `decide()` still refuses; a goodbye connection cannot reach any method;
`no-grant` gets silence and no goodbye; the goodbye is rate-limited; the phone stops
retrying on one and keeps retrying without one.

On hardware, the walk that found it, repeated: pair the TCL as a guest, revoke it,
and read the screen. The claim is that it says the library is no longer shared, that
Settings does not say "connecting…" for ever, and that the host's log stops filling
with denials.

## Rollback

Delete the goodbye path; the gate returns to silence and the phone to its current
message. The back-off can stay either way.
