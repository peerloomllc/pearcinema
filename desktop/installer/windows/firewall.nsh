; Ask Windows to let PearCinema accept connections.
;
; WHY. A host that cannot accept an INBOUND connection is not a host, and on
; Windows that permission is not the default. Measured on a fresh Windows 11 box,
; 2026-08-21, with nothing changed but this rule:
;
;   no allow rule   pairing: "no answer from the host (unreachable...)"  after 12 s
;   allow rule      pairing: succeeded                                   in 1 s
;
; Worse, the platform does not merely stay silent - left to itself it WRITES two
; inbound Block rules for the program, because nobody was there to answer a prompt.
; So the failure looks like a broken app rather than a missing permission.
;
; BEST EFFORT, NEVER FATAL - the same rule the Debian postinst follows. This
; installer is per-user and therefore usually NOT elevated, and netsh needs
; administrator rights, so the common case here is a clean failure. That is fine
; and it is why the app checks for itself at startup (src/main/firewall.js) and
; says so in the dashboard with the one line that fixes it. When the user does
; choose "install for all users", the installer IS elevated and this simply works,
; which is the whole reason to try.
;
; Any stale Block rule is removed FIRST, and removed BY PROGRAM rather than by name.
; Windows resolves a tie towards Block, so adding an allow beside a block leaves the
; machine exactly as unreachable as it was - and the operator with a rule that says
; Allow, which is worse than no rule at all because it looks like the job is done.
;
; DELETING BY NAME IS NOT ENOUGH, and this was measured rather than reasoned about
; (2026-08-21): the rules Windows writes for itself are named after the executable
; ("pearcinema.exe"), not after anything we choose, so `delete rule name="PearCinema"`
; leaves them standing. An elevated install then produced exactly the bad state above
; - one Allow, two Block, still unreachable, pairing still timing out at 11 s.
; `name=all ... program="..."` clears every rule pointing at this program, which is
; the only phrasing that catches both ours and theirs.

!macro customInstall
  DetailPrint "Asking Windows to allow PearCinema to accept connections..."

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name=all dir=in program="$INSTDIR\PearCinema.exe"'
  Pop $0

  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="PearCinema" dir=in action=allow program="$INSTDIR\PearCinema.exe" enable=yes profile=any description="Lets PearCinema receive connections from your paired devices."'
  Pop $0

  ${If} $0 == 0
    DetailPrint "Windows will let PearCinema accept connections."
  ${Else}
    ; NOT an error dialog. The app explains this far better than a modal during an
    ; install can, at the moment the person is actually looking at the dashboard.
    DetailPrint "Could not set the firewall permission (this needs administrator rights)."
    DetailPrint "PearCinema will tell you how to set it when you open its dashboard."
  ${EndIf}
!macroend

; Leaving a rule behind for an uninstalled program is untidy at best and a small
; standing permission at worst. Same best-effort terms.
!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name=all dir=in program="$INSTDIR\PearCinema.exe"'
  Pop $0
!macroend
