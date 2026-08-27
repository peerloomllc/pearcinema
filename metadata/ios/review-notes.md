<!--
THE NOTES THAT GO IN THE "Notes" BOX OF App Review Information, pasted as plain text.
Everything below the marker line is the note itself; this comment is not part of it.

WHY IT IS A FILE. PearTune sent a reviewer to a button that had since moved, which is
itself a 2.1 rejection. A note kept in a file can be diffed, and test/review-notes.test.js
holds every screen name and button label below against the strings actually in
src/ui/App.jsx - so the tap path cannot rot while nobody is looking.

RE-WALK IT ON THE BUILD BEING SUBMITTED. The test proves the words exist, not that the
order is still right.

Sign-In Required: NO. There is no account in this app and nothing to sign in to.
-->

---

PearCinema plays a film and television collection from a computer the user owns - an
Umbrel, a NAS, an old desktop - running the free, open-source PearCinema host. There is
no account, no cloud, and no catalogue of our own.

PLEASE START HERE: YOU DO NOT NEED A SERVER TO REVIEW THIS APP

The app ships with four short public-domain films so it works with nothing set up. To
reach them:

1. Open the app. On the first screen, tap "Get started".
2. Type any name in "Your name", then tap "Continue".
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

The app hosts nothing, indexes nothing and has no way to obtain a film. It plays files
the user already has on hardware they run. The only exception is the four demo films
above, which are public domain: two are US federal government works (17 U.S.C. 105), one
is a 1906 film whose 2018 scan carries the scanner's own written permission to reuse
with attribution, and the attribution is given in the app under About. The full evidence
for each, with the source and the licence quoted from it, is at
https://github.com/peerloomllc/pearcinema/blob/master/assets/demo-library/LICENCES.md

THE LOCAL NETWORK PERMISSION

The app asks for local network access on first use so it can reach a library on the same
wifi directly, rather than sending video out to the internet and back. Declining it does
not break the app, and the demo above does not need it.

TO SEE THE FULL FLOW

The part a reviewer cannot try - installing the host, pairing a phone to it, browsing a
real library, playing from it and revoking the phone mid-film - is shown end to end in
this video: [VIDEO URL]

CONTACT

theeyeofodinopensup@pm.me
