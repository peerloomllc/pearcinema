# The App Review video

Two and a bit minutes, silent, with captions burned in. It shows a reviewer the half of
PearCinema they cannot try: a server on somebody's own machine, a phone being let into it,
and access being cut off in the middle of a film.

Apple does not require it. It is the fallback if the reviewer never finds the demo path,
and it is the only place the conversion story appears at all, since the demo deliberately
avoids needing a host. PearTune's equivalent (`peartune-app-review.mp4`, 2026-07-28) is the
model, and this follows its shape.

`metadata/ios/review-notes.md` links to it, and `scripts/release.sh` refuses to submit
while that link is still `[VIDEO URL]`.

---

## The phone half is one command

```
bash scripts/ios-sim-demo-video.sh
```

It builds for the simulator, uninstalls whatever is there, drives the demo path with
XCUITest and writes `pearcinema-demo-ios.mp4`. Re-run it whenever the screens change; that
is the whole reason it is a script. `SKIP_BUILD=1` reuses the app already on the Mac.

What it films, in order: the intro card, the name, "I don't have one yet", the library
appearing with its banner, the shows tree, a film's own page, the film playing, and the
captions going on.

If a take lands on the wrong thing, `bash scripts/ios-sim-demo-video.sh --probe` walks the
same path and prints where every element actually is, rather than filming. Three of the
taps are positions rather than labels - the player's CC button and its picker rows carry no
label to address - and positions move when a layout does.

## The dashboard half is yours, in four takes

It has to be a person, because a real pairing needs a real operator: the code on camera
should be the one that was actually used, and a device should genuinely arrive on screen
rather than being cut in.

Set up first:

- The dashboard open on a machine with a real library on it, one with **posters** - the
  grid is the shot.
- Your phone with PearCinema installed and **not** paired to that library.
- The player skin set to **None**. Riff mode must not appear in anything a store sees
  (DECISIONS, 2026-08-25), and this is something a store sees.
- Screen recording at 1080p or better. It is downscaled in the edit, never up.

Then, one take each:

1. **The library.** The dashboard's own grid, scrolling slowly through films and then
   shows. Ten seconds is plenty. This is the "it reads the library you already have" beat,
   so let a few posters and a season list be legible.
2. **The pairing code.** Press *Pair a device*, hold on the QR code. Say when you are ready
   and I will fire the pair from the simulator so a device arrives on camera. Keep filming
   through the arrival - the device appearing in the list IS the shot.
3. **Playing on the phone**, filmed from the phone: open the paired library, open a film,
   press play, let it run a few seconds. This is the beat that shows a real file from a
   real server, which the demo cannot show.
4. **The revoke.** With that film still playing on the phone, revoke the device from the
   dashboard, and keep both in frame if you can. It stops mid-film. That is the point of
   the whole app and it is the last thing the video should show.

Dead air is fine and gets cut. Long QR time in take 2 was cut from PearTune's.

## Then

Hand me the four files. The edit is 1080x1080 so a portrait phone and a landscape dashboard
sit in one canvas with only downscaling, captions burned in, no audio.

Two things PearTune's edit learned the hard way, kept here so the next one does not
rediscover them:

- Captions go in `textfile=` rather than inline: a `:` or a `,` in a `drawtext` string
  breaks filter parsing.
- Pad rather than a colour source plus overlay. A second input carries its own duration and
  silently truncated every clip to one second.

And one about honesty: check the frames of a take before trusting its caption. A clip
captioned "a folder of films" that flicks through the Jellyfin tab contradicts itself, and
nobody notices until it is in front of a reviewer.
