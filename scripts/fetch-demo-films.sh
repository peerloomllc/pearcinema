#!/usr/bin/env bash
#
# Fetch and encode the demo library - the public-domain films that ship inside the app
# so App Review, and anyone who installs before running a host, has something to play.
#
#   bash scripts/fetch-demo-films.sh            # fetch what is missing, then encode
#   KEEP_SOURCES=1 bash scripts/fetch-demo-films.sh   # keep the downloads for a re-encode
#
# WHY A SCRIPT RATHER THAN COMMITTED VIDEO. PearTune commits its five CC0 tracks because
# 18 MB of music is nothing. The video equivalent is about 160 MB, which every clone of
# this repo would carry for ever and which git stores badly. So the REPO carries the
# identifiers, the licence evidence and the expected output; the bytes are fetched.
#
# The identifiers are the evidence. Each one was checked against
# archive.org/metadata/<identifier> for its own licenceurl and rights fields - see
# proposals/2026-08-26-app-review-demo-films.md, which records what each said and when.
# A collection page is NOT evidence: the Prelinger collection is only about 65% public
# domain and licences per item.
#
# THE ENCODE IS PART OF THE LICENCE STORY TOO. These are re-encodes rather than the
# archive's own files, which public-domain and CC0 terms permit; the Market Street scan
# asks for attribution and gets it in About.
#
# THE OUTPUT MUST BE DIRECT-PLAYABLE - H.264 in MP4 with AAC. There is no host in demo
# mode, so there is nothing to remux and nothing to convert. An MKV here would ship a
# demo that cannot play its own films.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/assets/demo-library"
SRC="${SRC_DIR:-$OUT/.sources}"

# SIZE IS THE BUDGET AND THE BUDGET IS THE DECISION (Tim, 2026-08-26). Two episodes
# rather than three, so the whole library is about 160 MB and a first install stays under
# the 200 MB point where the App Store asks before downloading over cellular. The third
# Apollo film (gov.archives.arc.1154974, Apollo/Soyuz) is verified and deliberately left
# out; it is the one to add if the budget ever moves.
FILM_BITRATE="${FILM_BITRATE:-250k}"      # the shorts, which are the shop window
EP_BITRATE="${EP_BITRATE:-220k}"          # 28 minutes each, so this is where the size is
AUDIO_BITRATE="${AUDIO_BITRATE:-64k}"

# id | archive.org identifier | source file within that item | output path
#
# The source file is named explicitly rather than guessed. The Apollo items offer only a
# 2 GB MPEG-2 above 320x240, so that is what comes down; Market Street's own original is
# a 91 GB 4K scan and its 2K h.264 derivative is the sane input.
ITEMS=(
  "duck-and-cover|gov.ntis.ava11109vnb1|ava11109vnb1.mp4|Films/Duck and Cover (1951).mp4|$FILM_BITRATE"
  "market-street|MarketStreet19064KScan20181016|MarketStreet_4K_to_2K_cropped_higher_contrast.mp4|Films/A Trip Down Market Street (1906).mp4|$FILM_BITRATE"
  "apollo-11|gov.archives.arc.45017|gov.archives.arc.45017.mpeg|TV Shows/The Apollo Missions/Season 01/The Apollo Missions - S01E01 - The Eagle Has Landed.mp4|$EP_BITRATE"
  "apollo-13|gov.archives.arc.1155023|gov.archives.arc.1155023.mpeg|TV Shows/The Apollo Missions/Season 01/The Apollo Missions - S01E02 - Houston, We've Got A Problem.mp4|$EP_BITRATE"
)

say () { printf '\n== %s ==\n' "$1"; }

command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed, and the encode needs it" >&2; exit 1; }
mkdir -p "$SRC" "$OUT/Films" "$OUT/TV Shows"

# The item's file list, so a renamed derivative fails loudly here rather than as a 404
# saved to disk as an HTML error page - which is how a "download" ends up 3 KB long.
resolve () {
  local ident="$1" want="$2"
  curl -sf --max-time 30 "https://archive.org/metadata/$ident" \
    | python3 -c "
import sys, json
want = sys.argv[1]
files = json.load(sys.stdin).get('files', [])
names = [f['name'] for f in files]
if want in names:
    print(want); raise SystemExit
# Fall back to the largest MPEG-2 or MP4, so a rename is survivable rather than fatal.
cands = [f for f in files if f.get('format','').lower() in ('mpeg2','h.264','mpeg4','512kb mpeg4')]
if cands:
    print(max(cands, key=lambda f: int(f.get('size', 0)))['name']); raise SystemExit
sys.stderr.write('no usable video file in %s\n' % sys.argv[2])
raise SystemExit(1)
" "$want" "$ident"
}

for row in "${ITEMS[@]}"; do
  IFS='|' read -r id ident want out bitrate <<< "$row"
  dest="$OUT/$out"
  [ -f "$dest" ] && { echo "already encoded: $out"; continue; }

  say "$id"
  name="$(resolve "$ident" "$want")"
  local_src="$SRC/$id-${name##*/}"

  if [ ! -s "$local_src" ]; then
    echo "  fetching $name from $ident"
    # The progress bar only when somebody is watching. Redirected to a log it writes
    # thousands of carriage-returned percentages, which buries everything else.
    [ -t 1 ] && meter=--progress-bar || meter=--no-progress-meter
    curl -fL --retry 3 "$meter" \
      -o "$local_src" "https://archive.org/download/$ident/$name"
  else
    echo "  already fetched: ${local_src##*/}"
  fi

  # A downloaded error page is small and is NOT a video. Ask ffprobe rather than trusting
  # the exit code of curl, which is happy to save whatever it was given.
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name \
    -of csv=p=0 "$local_src" >/dev/null 2>&1 || {
      echo "  $local_src is not a video - the item's file list may have changed" >&2
      exit 1
    }

  mkdir -p "$(dirname "$dest")"
  echo "  encoding to 480p H.264 at $bitrate"
  # Two passes, because the whole point is a predictable size against a budget. Scaled to
  # 480 high with the width kept even, so 4:3 archival stays 4:3 and nothing is pillarboxed
  # into the file itself.
  pass_log="$SRC/$id-passlog"
  ffmpeg -nostdin -v error -y -i "$local_src" \
    -c:v libx264 -b:v "$bitrate" -pass 1 -passlogfile "$pass_log" \
    -vf "scale=-2:480" -preset slow -an -f mp4 /dev/null
  ffmpeg -nostdin -v error -y -i "$local_src" \
    -c:v libx264 -b:v "$bitrate" -pass 2 -passlogfile "$pass_log" \
    -vf "scale=-2:480" -preset slow \
    -c:a aac -b:a "$AUDIO_BITRATE" -ac 2 \
    -movflags +faststart "$dest"
  rm -f "$pass_log"*

  printf '  %s (%s)\n' "$out" "$(du -h "$dest" | cut -f1)"
done

if [ -z "${KEEP_SOURCES:-}" ]; then
  say "removing the downloads (KEEP_SOURCES=1 to keep them for a re-encode)"
  rm -rf "$SRC"
fi

say "the demo library"
find "$OUT" -name '*.mp4' -printf '%s\t%p\n' | sort -k2 | while IFS=$'\t' read -r size file; do
  printf '  %6s  %s\n' "$(numfmt --to=iec "$size")" "${file#$OUT/}"
done
printf '\n  total: %s\n' "$(du -sh "$OUT" | cut -f1)"
echo
echo "The App Store asks before installing over cellular above 200 MB. Stay under it."
