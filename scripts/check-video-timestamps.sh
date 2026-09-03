#!/usr/bin/env bash
# check-video-timestamps.sh — will SSA get an accurate start time for these clips?
#
# Run this on the Mac BEFORE uploading. It reads exactly what SSA reads, in the same
# order of precedence, and tells you which clips will import cleanly and which will
# land at the wrong time.
#
#   ./scripts/check-video-timestamps.sh ~/Desktop/coach-clips
#   ./scripts/check-video-timestamps.sh IMG_4821.mp4 IMG_4822.mp4
#
# Needs exiftool:   brew install exiftool
#
# ── What SSA looks for, in order ─────────────────────────────────────────────
#  1. Keys:CreationDate  (com.apple.quicktime.creationdate)
#       The recording START, local time WITH its timezone offset. Authoritative.
#       Survives AirDrop of the original. DESTROYED by a re-encode — including
#       QuickTime Player's rotate-and-save.
#  2. A timestamp in the FILENAME (DJI_20260527152016… / VID_20260712_143200…)
#       Also the START — the camera names the file when it opens it.
#  3. mvhd / QuickTime:CreateDate
#       UTC, but on many files this is the FINALISATION time — i.e. the END of the
#       recording, one whole duration late. Only safe when it agrees with (1) or (2).
#
# A clip with none of the above has no recoverable start time: the information is gone
# from the file and you'll have to set it by hand in SSA.

set -uo pipefail

if ! command -v exiftool >/dev/null 2>&1; then
  echo "exiftool not found. Install it with:  brew install exiftool"
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <file-or-folder> [more…]"
  exit 1
fi

# Collect the files.
FILES=()
for arg in "$@"; do
  if [ -d "$arg" ]; then
    while IFS= read -r f; do FILES+=("$f"); done < <(
      find "$arg" -maxdepth 1 -type f \
        \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.m4v' \) | sort
    )
  elif [ -f "$arg" ]; then
    FILES+=("$arg")
  fi
done

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no .mp4/.mov/.m4v files found"
  exit 1
fi

printf '%-34s %-10s %-26s %-10s %s\n' "FILE" "VERDICT" "START SSA WILL USE" "DURATION" "NOTES"
printf '%.0s─' {1..118}; echo

for f in "${FILES[@]}"; do
  base=$(basename "$f")

  keys=$(exiftool -s3 -api QuickTimeUTC=0 -Keys:CreationDate "$f" 2>/dev/null | head -1)
  mvhd=$(exiftool -s3 -api QuickTimeUTC=1 -QuickTime:CreateDate "$f" 2>/dev/null | head -1)
  dur=$(exiftool -s3 -Duration# "$f" 2>/dev/null | head -1)
  dur=${dur:-0}
  dur_s=$(printf '%.0f' "$dur" 2>/dev/null || echo 0)

  # A start timestamp in the filename? (same patterns SSA recognises)
  fname_ts=""
  # Separator class matches the app (extractTimestampFromFilename): a SPACE is a
  # real convention ("20260903 125443.mp4" off the drone/RIB cards), and omitting it
  # made this report those clips RISKY when SSA imports them fine.
  if [[ "$base" =~ ([0-9]{4})([0-9]{2})([0-9]{2})[_\ T-]?([0-9]{2})([0-9]{2})([0-9]{2}) ]]; then
    fname_ts="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}"
  fi

  if [ -n "$keys" ]; then
    verdict="GOOD"
    start="$keys"
    notes="Apple capture date — start, with timezone"
  elif [ -n "$fname_ts" ]; then
    verdict="OK"
    start="$fname_ts (local)"
    notes="from the filename — start"
    if [ -n "$mvhd" ] && [ "$dur_s" -gt 5 ]; then
      notes="$notes; mvhd is ${dur_s}s later = end-of-recording"
    fi
  elif [ -n "$mvhd" ]; then
    verdict="RISKY"
    start="$mvhd (UTC)"
    notes="ONLY mvhd — may be the EDIT/END time, not the recording start"
  else
    verdict="BAD"
    start="—"
    notes="no timestamp at all — set it by hand in SSA"
  fi

  printf '%-34.34s %-10s %-26.26s %-10s %s\n' "$base" "$verdict" "$start" "${dur_s}s" "$notes"
done

cat <<'TIP'

─────────────────────────────────────────────────────────────────────────────
GOOD   → imports at the right time, nothing to do.
OK     → the filename carries the start; SSA uses it and ignores a later mvhd.
RISKY  → the capture metadata has been stripped (a re-encode: QuickTime rotate,
         or a Photos export that transcoded). SSA will fall back to mvhd, which
         is often the END of the recording — expect it to land one duration late.
BAD    → nothing usable in the file; you'll set the start manually in SSA.

To keep clips GOOD:
  • AirDrop the ORIGINAL from the phone (Photos → Share → AirDrop, "All Photos Data").
  • Do NOT rotate in QuickTime Player — it transcodes and strips the capture date.
    Rotate in SSA instead (⟳ in the player); the file is never re-encoded.
TIP
