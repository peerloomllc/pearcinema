# The requester closes the ask

Shipped 2026-08-22, PR #159, against proposal
`proposals/2026-08-22-the-requester-closes-the-ask.md` (approved by merging PR #158).
Signed off by Tim, who chose the shape: the requesting device coordinates, because it
is the only party that knows every copy of an ask exists and hosts do not talk to each
other. The T3 surface is one auth gate - `request.resolve` now admits the person who
FILED a row alongside the library's owner, which is strictly less power than the
`request.remove` they already had. Only `added` travels; a decline stays where it was
made. Verified on Tim's own three hosts, including an ask that had genuinely been
pending on two of them since 2026-08-19, and on the live path with the answer given on
the Umbrel's dashboard and nobody touching the phone. Verify green at 867. Rollback is
putting the `isOwner` check back; nothing on disk changes shape.
