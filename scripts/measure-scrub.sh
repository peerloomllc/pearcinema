#!/usr/bin/env bash
# Scrub latency, measured where the player actually feels it.
#
# WHY THIS EXISTS. Dragging the scrubber is not a special operation: the phone
# serves the film to its own video player over a loopback HTTP port, and a seek
# is one fresh Range request to that port. So this forwards the port over USB
# and issues the requests the player would, which measures the real path -
# phone worklet, wire, host disk - without touching the screen or guessing what
# a gesture did. It also measures the thing a gesture cannot: whether the 8 MB
# read window's stop-and-ask loop costs anything, which only shows past 8 MB.
#
# USAGE
#   1. Pair the phone with a library and open the app (foreground: Android
#      freezes background processes, and a frozen worklet serves nothing).
#   2. Get the loopback URL for a film. Over the app's own bridge:
#        stream.url { itemId }  ->  http://127.0.0.1:<port>/t/<track>
#      (scripts/ has no helper for this; the CDP recipe is in the project notes.)
#   3. adb -s <serial> forward tcp:8899 tcp:<port>
#   4. scripts/measure-scrub.sh <label> http://127.0.0.1:8899/t/<track> <bytes>
#
# The file size is the item's media.size, and only bounds where offsets land.
#
# WHAT THE NUMBERS MEAN
#   ttfb64k   time to the first byte of a 64 KB read at a fresh offset. This IS
#             scrub latency: drag, release, wait for picture.
#   read4m    4 MB, inside a single window - throughput with no window boundary.
#   read20m   20 MB, crossing two boundaries. Compare its rate against read4m:
#             the gap is what the serial request-one-window-then-ask loop costs.
#             On a LAN the gap is nothing, because a round trip is nothing. It is
#             off-LAN, where a round trip is tens of milliseconds, that this is
#             worth knowing - which is the measurement still owed.
set -u
if [ $# -lt 3 ]; then
  echo "usage: $0 <label> <loopback-url> <file-size-bytes>" >&2
  exit 2
fi
LABEL="$1"; URL="$2"; SIZE="$3"
OUT="${OUT_DIR:-.}/${LABEL}.tsv"
: > "$OUT"

# Deterministic offsets so two runs ask the same questions of the same bytes.
# The outer 5% is avoided: scrubbing to the very edges is not the normal case
# and the ends of a file behave differently.
OFFSETS=$(python3 -c "
size=$SIZE
lo=int(size*0.05); hi=int(size*0.95)
print(' '.join(str(lo+(hi-lo)*i//11) for i in range(1,11)))
")

# One warmup, discarded. The first request for an item pays an extra round trip
# to learn the file's size, and that is paid once per app run, not once per
# scrub - counting it would libel every later number.
curl -s -o /dev/null --max-time 60 -r 0-65535 "$URL" >/dev/null 2>&1

echo "== $LABEL: scrub latency, 64 KB reads =="
for off in $OFFSETS; do
  r=$(curl -s -o /dev/null --max-time 60 -r "$off-$((off + 65535))" \
      -w "%{time_starttransfer}\t%{time_total}\t%{size_download}\t%{http_code}" "$URL" 2>/dev/null)
  echo -e "ttfb64k\t$off\t$r" >> "$OUT"
  echo "  offset $off -> $(echo "$r" | cut -f1)s to first byte"
done

echo "== $LABEL: sustained read, 4 MB (inside one window) =="
for i in 1 2 3; do
  off=$(( SIZE / 4 + i * 100000000 ))
  r=$(curl -s -o /dev/null --max-time 300 -r "$off-$((off + 4*1024*1024 - 1))" \
      -w "%{time_starttransfer}\t%{time_total}\t%{size_download}\t%{http_code}" "$URL" 2>/dev/null)
  echo -e "read4m\t$off\t$r" >> "$OUT"
  echo "  4 MB in $(echo "$r" | cut -f2)s"
done

echo "== $LABEL: sustained read, 20 MB (crosses two window boundaries) =="
for i in 1 2; do
  off=$(( SIZE / 3 + i * 200000000 ))
  r=$(curl -s -o /dev/null --max-time 600 -r "$off-$((off + 20*1024*1024 - 1))" \
      -w "%{time_starttransfer}\t%{time_total}\t%{size_download}\t%{http_code}" "$URL" 2>/dev/null)
  echo -e "read20m\t$off\t$r" >> "$OUT"
  echo "  20 MB in $(echo "$r" | cut -f2)s"
done

echo
echo "wrote $OUT"
python3 - "$OUT" <<'PY'
import sys, statistics
rows = [l.split('\t') for l in open(sys.argv[1]) if l.strip()]
def nums(kind, col): return [float(r[col]) for r in rows if r[0] == kind and r[5].strip() == '206']
t = nums('ttfb64k', 2)
if t:
    print(f'scrub latency: median {statistics.median(t)*1000:.0f} ms, '
          f'best {min(t)*1000:.0f}, worst {max(t)*1000:.0f} (n={len(t)})')
for kind, mb in (('read4m', 4), ('read20m', 20)):
    tot = nums(kind, 3)
    if tot:
        rate = [mb / x for x in tot]
        print(f'{kind}: median {statistics.median(tot):.2f}s -> {statistics.median(rate):.1f} MB/s')
PY
