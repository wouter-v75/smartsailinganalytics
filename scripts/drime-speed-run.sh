#!/usr/bin/env bash
# scripts/drime-speed-run.sh
# ─────────────────────────────────────────────────────────────────────────────
# Fetch the speed-team compilations and documents from the Drime share and
# attach them to each meeting's notes — one meeting date at a time, SMALLEST
# FIRST.
#
#   ./scripts/drime-speed-run.sh /tmp/drime-manifest.json
#
# One date at a time because day-media-upload writes the debrief's documents[]
# once, at the end of a date. Killed halfway through a date, that date's bytes
# are in Bunny but unrecorded and will simply be re-sent next time — wasteful,
# never corrupting. Killed BETWEEN dates, every completed date is safely
# recorded. So the checkpoints are the date boundaries, and doing the cheap
# dates first means an interrupted run (a closing laptop lid, a flight) still
# banks as many of them as possible.
#
# Safe to re-run: the download skips a file already on disk at the right size,
# and the upload skips a document the meeting already has by name.
#
# Must run OUTSIDE Claude Code's Bash sandbox — Node's fetch ignores the proxy.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."

MANIFEST="${1:-/tmp/drime-manifest.json}"
STAGE="$HOME/Downloads/drime-sync"

# Smallest first. Regenerate with:
#   npx vite-node scripts/drime-sync.ts -- --manifest $MANIFEST --kind speed
DATES=(2026-09-09 2026-09-03 2026-09-10 2026-09-08 2026-09-06 2026-09-07 2026-09-13 2026-09-05 2026-09-04)

echo "speed-team sync — $(date '+%H:%M:%S')"
for d in "${DATES[@]}"; do
  echo ""
  echo "════ $d ══════════════════════════════════════════════"
  npx vite-node scripts/drime-sync.ts -- \
      --manifest "$MANIFEST" --kind speed --date "$d" --write 2>&1 | tail -4
  if [ -d "$STAGE/speed/$d" ] && [ -n "$(ls -A "$STAGE/speed/$d" 2>/dev/null)" ]; then
    npm run media:upload -- "$STAGE/speed/$d" --speed "$d" --write 2>&1 | tail -30
  else
    echo "  nothing downloaded for $d — skipping the attach"
  fi
done
echo ""
echo "done — $(date '+%H:%M:%S')"
