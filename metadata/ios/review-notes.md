<!--
THE NOTES THAT GO IN THE "Notes" BOX OF App Review Information, pasted as plain text.
Everything below the marker line is the note itself; this comment is not part of it.

WHY IT IS A FILE. PearTune sent a reviewer to a button that had since moved, which is
itself a 2.1 rejection. A note kept in a file can be diffed, and test/review-notes.test.js
holds every screen name and button label below against the strings actually in
src/ui/App.jsx - so the tap path cannot rot while nobody is looking.

RE-WALK IT ON THE BUILD BEING SUBMITTED. The test proves the words exist, not that the
order is still right.

TWO REJECTIONS ARE ANSWERED HERE AND BOTH SECTIONS MUST SURVIVE AN EDIT. 1.1.1 was
rejected twice: on 2026-08-31 for VPN functionality an automated analysis thought it saw,
and on 2026-09-03 under Guideline 5.2.3 for "downloading of third party videos or shows".
Neither is true of the app, and the answer to each is a section below. THE FILE HAD
DRIFTED: the VPN section was written straight to App Store Connect over the API on
2026-08-31 and never written back here, so the file and the server disagreed for three
days. Push this file to the server rather than editing the Notes box by hand.

Sign-In Required: NO. There is no account in this app and nothing to sign in to.

Attachment: pearcinema-app-review.mp4 in the repo root, cut by
scripts/cut-app-review-video.sh. It goes in the Attachment field of App Review
Information, beside these notes. The notes below say it is attached, so attaching it is
not optional - scripts/release.sh refuses to submit while they still hold a placeholder,
but no script can check that a file was uploaded to Apple.
-->

---

PearCinema plays a film and television collection from a computer the user owns - an
Umbrel, a NAS, an old desktop - running the free, open-source PearCinema host. There is
no account, no cloud, and no catalogue of our own.

WHERE THE VIDEO COMES FROM (GUIDELINE 5.2.3)

There are exactly three sources of video in this app, and no fourth:

1. A PearCinema host the user installs on a computer they own, pointed at their own
   files, or at a Jellyfin or Emby server they already run themselves.
2. A host belonging to somebody they know, who granted that one device access by
   showing them a pairing code.
3. The four public-domain films bundled in the app.

The app has no catalogue, no search outside a library it is paired with, no field for
entering an address of any kind and no connection to any streaming service or public
index. It cannot reach YouTube or any other third-party service, and no code in it fetches
media from anywhere but a paired host. It is MIT licensed and readable in full at
https://github.com/peerloomllc/pearcinema

"Downloads" copies a file from the user's own server to their own device so that it
plays with no connection - the same file, moving between two machines the same person
owns, the way Infuse, VLC, Jellyfin and Plex all do it. There is nowhere else it could
copy from. "Requests" sends the owner of a library a message asking for a title; it
fetches nothing and reaches no third party.

NO VPN FUNCTIONALITY

An automated analysis flagged VPN functionality in an earlier submission. PearCinema has
none: no NetworkExtension API (no NEVPNManager, no NEPacketTunnelProvider), no VPN
entitlement, no VPN configuration ever installed and no traffic carried but its own
video. The direct end-to-end encrypted peer-to-peer connection to the user's own server
(the open-source Hyperswarm/HyperDHT stack, over UDP hole punching) is likely what the
scanner saw. The app collects no user information at all: no accounts, no analytics,
nothing shared with anyone.

PLEASE START HERE: YOU DO NOT NEED A SERVER TO REVIEW THIS APP

The app ships with four short public-domain films so it works with nothing set up. To
reach them:

1. Open the app. On the first screen, tap "Get started".
2. Type any name in "Your name". Dismiss the keyboard, which is covering the button,
   then tap "Continue".
3. The next screen asks whose library it is. Tap "I don't have one yet".
4. The library appears. Tap any film, then tap "Watch".

This works with wifi and mobile data switched off. Nothing is downloaded and no server
is contacted, because the films are inside the app.

WHY THERE IS NO SIGN-IN

The app has no accounts and no server of ours to sign in to. A phone is granted access
by scanning a pairing code shown by the host software on the user's own computer; the
connection itself proves which device is calling. We cannot give you a test account
because none exists, for anyone.

PEARCINEMA PROVIDES NO CONTENT

The app hosts nothing, indexes nothing and has no way to obtain a film. The four demo
films are public domain: two are US federal government works (17 U.S.C. 105), one is a
1906 film whose 2018 scan carries the scanner's written permission to reuse with
attribution, which is given in the app under About. The evidence for each, with its
source and its licence quoted, is at
https://github.com/peerloomllc/pearcinema/blob/master/assets/demo-library/LICENCES.md

THE LOCAL NETWORK PERMISSION

The app asks for local network access on first use so it can reach a library on the same
wifi directly, rather than sending video out to the internet and back. Declining it does
not break the app, and the demo above does not need it.

TO SEE THE FULL FLOW

The part you cannot try - a host running on somebody's own machine, a phone paired to it,
a real library browsed and played from, and the phone cut off mid-film - is shown end to
end in the two-minute video attached to this submission. It is silent, with captions.

CONTACT

theeyeofodinopensup@pm.me
