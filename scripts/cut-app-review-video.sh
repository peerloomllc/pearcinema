#!/usr/bin/env bash
# Cut the App Review video: the phone half this repo records, plus the four takes a
# person has to shoot, into one silent captioned film (docs/app-review-video.md).
#
#   bash scripts/cut-app-review-video.sh
#   TAKES=/somewhere/else bash scripts/cut-app-review-video.sh
#
# WHY A SCRIPT. The phone half is re-recorded whenever the app's screens move
# (scripts/ios-sim-demo-video.sh), and a re-recorded half is worthless if re-cutting the
# whole thing is an afternoon in an editor. Every cut point below is a number in one
# place, so a take that changes costs an edit to a line.
#
# 1080x1080 so a portrait phone and a landscape dashboard sit in one canvas with only
# DOWNSCALING - legibility is the whole constraint. Silent: it is watched by somebody
# reading, and audio in a review video is one more thing to get wrong.
#
# TWO TRAPS PEARTUNE'S EDIT PAID FOR, and this inherits the answers:
#   - captions go in textfile=, because a ':' or ',' inside drawtext's text= breaks
#     filter parsing;
#   - pad rather than a colour source plus overlay, because a second input carries its
#     own duration and silently truncates every clip to one second.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAKES="${TAKES:-$HOME/Videos/Screencasts}"
PHONE="${PHONE:-$REPO/pearcinema-demo-ios.mp4}"
OUT="${OUT:-$REPO/pearcinema-app-review.mp4}"
FONT="${FONT:-/usr/share/fonts/google-noto/NotoSans-Regular.ttf}"
FONT_BOLD="${FONT_BOLD:-/usr/share/fonts/google-noto/NotoSans-SemiBold.ttf}"
BG="0x171410"        # the app's own dark, so the letterboxing is not a black hole
FG="0xefe9df"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# iOS writes .MP4 and Android writes .mp4, and a re-shoot changes which. Resolved rather
# than renamed - somebody's own recordings should not have to be tidied to be usable.
find_take () {
  local base="$1"
  for ext in mp4 MP4 mov MOV webm; do
    [ -f "$TAKES/$base.$ext" ] && { echo "$TAKES/$base.$ext"; return; }
  done
  echo "no take named $base.* in $TAKES" >&2
  exit 1
}
LIBRARY_TAKE="$(find_take library_video)"
PAIRING_TAKE="$(find_take pairing_video)"
PLAYING_TAKE="$(find_take playing_on_phone)"
REVOKE_TAKE="$(find_take revoke_access)"

for f in "$PHONE" "$LIBRARY_TAKE" "$PAIRING_TAKE" "$PLAYING_TAKE" "$REVOKE_TAKE"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done
[ -f "$FONT" ] || { echo "no font at $FONT - set FONT" >&2; exit 1; }

n=0
list="$WORK/list.txt"; : > "$list"

# A CARD: one line of heading, one of body, on the app's own background.
card () {
  local secs="$1" head="$2" body="$3"
  n=$((n + 1)); local out="$WORK/$(printf %02d $n).mp4"
  printf '%s' "$head" > "$WORK/h$n.txt"
  printf '%s' "$body" > "$WORK/b$n.txt"
  ffmpeg -nostdin -v error -y -f lavfi -i "color=c=$BG:s=1080x1080:d=$secs:r=30" \
    -vf "drawtext=fontfile=$FONT_BOLD:textfile=$WORK/h$n.txt:fontcolor=$FG:fontsize=62:x=(w-text_w)/2:y=(h/2)-90,
         drawtext=fontfile=$FONT:textfile=$WORK/b$n.txt:fontcolor=$FG@0.72:fontsize=34:line_spacing=12:x=(w-text_w)/2:y=(h/2)+10" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -an "$out"
  echo "file '$out'" >> "$list"
}

# A CLIP: one window of one take, fitted to the square, with its caption burned along the
# bottom. `crop` is optional and takes ffmpeg's own syntax - the revoke take is a camera
# pointed at a phone on a desk, and the desk is not the shot.
clip () {
  local src="$1" from="$2" to="$3" caption="$4" crop="${5:-}"
  n=$((n + 1)); local out="$WORK/$(printf %02d $n).mp4"
  printf '%s' "$caption" > "$WORK/c$n.txt"
  local pre=""
  [ -n "$crop" ] && pre="crop=$crop,"
  ffmpeg -nostdin -v error -y -ss "$from" -to "$to" -i "$src" \
    -vf "${pre}scale=1080:1080:force_original_aspect_ratio=decrease,
         pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=$BG,fps=30,setsar=1,
         drawtext=fontfile=$FONT:textfile=$WORK/c$n.txt:fontcolor=$FG:fontsize=36:line_spacing=10:
           box=1:boxcolor=0x0d0b09@0.82:boxborderw=22:x=(w-text_w)/2:y=h-text_h-46" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -an "$out"
  echo "file '$out'" >> "$list"
}

say () { printf '  %s\n' "$1"; }
echo "cutting:"

# ── 1. What this is ──────────────────────────────────────────────────────────
say "title"
card 4 "PearCinema" "A film and television library on a machine you own,
played anywhere. No account, and no copy in anyone's cloud."

# ── 2. The half a reviewer can do themselves, on the iPhone ──────────────────
say "the demo path"
clip "$PHONE" 2 9    "The app opens with no server and no account."
clip "$PHONE" 30 38  "Whose library is it? The third answer is \"I don't have one yet\"."
clip "$PHONE" 40 50  "Four public-domain films, inside the app.
No pairing, no server, no network."
clip "$PHONE" 84 90  "Each one says what it is, and how long it runs."
clip "$PHONE" 124 134 "It plays. Subtitles come from a file beside it."

# ── 3. The half they cannot ──────────────────────────────────────────────────
card 3 "With a server" "The part a reviewer cannot try: a machine
somebody runs, in their own house."

say "the library"
clip "$LIBRARY_TAKE" 1 14 "The host reads a library that is already there,
with its own posters and its own seasons."

say "pairing"
clip "$PAIRING_TAKE" 5 14  "Letting a device in is one code on the screen."
clip "$PAIRING_TAKE" 19 28 "It arrives in the owner's list, named,
and can be cut off from there."

say "playing"
# From 4s: the first seconds are Control Centre starting the screen recording.
clip "$PLAYING_TAKE" 4 26 "A film from that machine, on a phone
somewhere else. Nothing is downloaded first."

# The camera take, in two cuts and cropped, for two different reasons.
#
# THE CROP IS ABOUT PRIVACY as much as framing: the top of the frame is a browser with
# its tab bar and bookmarks open, and those are somebody's own - "Birthday Gifts" is not
# for App Review. Taking the top fifth off loses nothing of the dashboard.
#
# THE SECOND CUT skips the few seconds where the camera swings across the whole screen
# and the crop cannot keep up with what is on it.
say "the revoke"
REVOKE_CROP="in_w:in_h*0.80:0:in_h*0.20"
# From 3.5s: the take opens on the phone and the camera then finds the screen. The
# People row - the device, named, and the film it is watching - is legible from there.
clip "$REVOKE_TAKE" 3.5 9 "The owner sees the device, and what it is watching." "$REVOKE_CROP"
clip "$REVOKE_TAKE" 11 22 "They cut it off, and the film stops.
Mid-film, not on next login." "$REVOKE_CROP"

card 4 "peerloomllc.com/pearcinema" "MIT licensed. The host is free,
and so is the app."

echo "joining"
ffmpeg -nostdin -v error -y -f concat -safe 0 -i "$list" -c copy -movflags +faststart "$OUT"

printf '\nwrote %s\n' "$OUT"
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT"
