# The requester closes the ask

**Status**: PROPOSED 2026-08-22. **The shape is Tim's call, made the same day**:
the requesting device is the coordinator. Nothing is built; merging this PR is the
approval.

**Goal**: Make an answered request stop being pending on every OTHER library it
was filed with, without hosts having to talk to each other.

**Tier**: **T3.** It moves an auth gate. `request.resolve` is owner-only today
and this lets the person who filed the ask resolve their own copy of it, which is
a change to who may write what on somebody else's host. Everything else about it
is small.

## What is wrong

A request is filed with EVERY reachable host on purpose - none of them has the
film, so any of their owners might add it. `src/bare.js` `request.add` fans out,
and the lists collapse the per-host rows back to one ask.

Resolving is where the symmetry stops. `host/methods.js` `request.resolve` writes
the row on the host it was called on and tells exactly one party: the REQUESTER,
via `presence.notifyOwner(row.requester, 'request:resolved', ...)`. The sibling
hosts holding their own copy of the same ask are never told, so their owners keep
seeing it in the queue as pending, and can add a film somebody already added.

IT IS ONLY CLOSED WHEN THE PHONE DOES IT. The worklet's own `request.resolve` fans
out across `merge.requestTargets`, so an owner answering from their phone does
close every pending copy. That is why this never shows up from a phone and always
shows up from a dashboard - and two owners on two machines is exactly the case the
app is for, so the dashboard path is not the rare one.

## The shape

The requesting device coordinates, because it is the only party that knows every
copy of the ask exists. It already holds them: `merge.collapseRequests` puts every
per-host `(libraryId, id, status)` on the collapsed row as `refs`, which is what
lets REMOVE delete an ask everywhere today.

1. A host resolves. It pushes `request:resolved` to the requester exactly as it
   does now - no protocol change, no new event.
2. The requester's device notices that one copy of its ask says `added` while
   others still say `pending`, and closes those.
3. It heals rather than fires once: the same check runs whenever the requester
   lists their own requests, so a device that was asleep when the answer came
   settles it the next time the app is opened.

### Why the auth gate has to move

Step 2 is a write to a host where the requester may be a GUEST, and
`request.resolve` refuses anyone who is not the library's owner. So the rule
becomes: the library's owner may resolve any row, **and the person who filed a row
may resolve that row**.

This is strictly less power than the requester already has. `request.remove`
allows exactly this test today - `row.requester !== ctx.owner` - and DELETES the
row, which takes it off the owner's queue entirely. A guest who can already make
an ask vanish is not newly dangerous for being able to mark it answered.

### Only `added` travels

A decline is one owner's answer about their own library, not everybody's. Another
owner may still want to add the film, so a `declined` on host A must leave host B
pending. `requestTargets` already refuses to rewrite a copy another owner
declined; this is the same rule from the other end.

The consequence, said out loud rather than discovered: declining from a dashboard
still has to be done per library. Answering from a phone, where the person is the
owner of all of them, already fans out both verdicts and is unchanged.

## Scope

- `host/methods.js` - `request.resolve` fetches the row first and admits the
  owner OR that row's requester.
- `src/bare.js` - the requester's list reconciles: any collapsed ask that is
  `added` somewhere and `pending` elsewhere closes the pending copies, fire and
  forget. `request:resolved` triggers a refresh so it happens at once rather than
  at next open.
- NOT the store, and NOT `@peerloom/host`. No new field, no migration.
- NOT host-to-host. Nothing on host A learns that host B exists.
- NOT the dashboard's own queue, which keeps showing that host's rows.

## Compat

An OLD host with a new phone refuses the requester's close with `owner only`; the
phone swallows it and that host stays pending - exactly today's behaviour, so a
mixed fleet degrades to the bug rather than to an error.

A NEW host with an old phone is unchanged: nothing calls the relaxed path, and the
owner-only case behaves identically.

No stored shape changes, so there is nothing to migrate and nothing to roll
forward.

## Verify

Automated: a requester may resolve their own row; a person who is neither owner
nor requester may not; an owner still may. Plus the reconcile itself - an ask
`added` on one library and `pending` on another ends with both closed, and a
`declined` does not travel.

On hardware, the case that started it: file a request from the TCL against the
Umbrel and the Mac mini, answer it on the UMBREL'S DASHBOARD, and watch the Mac
mini's copy go from pending to added without anybody touching the Mac.

## Rollback

Put the `isOwner` check back. The reconcile then fails harmlessly against every
host and the app is where it is today; nothing on disk needs undoing.
