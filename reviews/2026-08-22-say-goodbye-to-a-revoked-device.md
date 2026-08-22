# Say goodbye to a revoked device

Shipped 2026-08-22 across PR #165 here and peerloom-host PR #13, against proposal
`proposals/2026-08-22-say-goodbye-to-a-revoked-device.md` (approved by merging PR #164).
Signed off by Tim, who asked for the friend experience to be walked and then for this to
be built. The T3 surface is one auth gate speaking where it was silent: a device holding
a tombstoned grant is told once that its access is gone, while an unknown key is still
told nothing. The property to keep honest is that the goodbye channel carries no method
table, so a revoked device can be told and can do nothing else - asserted by probing it
with `ping`, which the package serves ahead of any app. Verified on the TCL over a real
DHT: one goodbye, no denials after it, and the phone naming the library on screen instead
of blaming the network. Verify green at 879 here and 221 in the package. Rollback is
deleting the farewell path; the gate returns to silence and nothing on disk changes.
