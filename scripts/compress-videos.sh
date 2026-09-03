#!/usr/bin/env bash
# compress-videos.sh — the middle step of SSA's Save-to-disk → compress → Upload-compressed
# round-trip. Compresses the HD clips you exported with the Videos tab's "↓ Save to disk"
# button, so you can push the small versions back with "↑ Upload compressed".
#
#   ./scripts/compress-videos.sh ~/Desktop/clips            # → ~/Desktop/clips/compressed/*.mp4
#   ./scripts/compress-videos.sh ~/Desktop/clips out_dir    # → out_dir/*.mp4
#   ./scripts/compress-videos.sh --archive ~/Desktop/clips  # smaller/slower (CRF veryslow)
#   ./scripts/compress-videos.sh --out picked a.mp4 b.mp4   # named files → picked/
#
# The file-list form is what select-race-clips.mjs calls, so the encoder settings
# live in exactly one place.
#
# THE ONE RULE: the compressed file must keep the SAME FILENAME STEM as the original —
# "↑ Upload compressed" matches clips to files by stem (Race1 → Race1.mp4). This script
# writes <stem>.mp4 into a separate compressed/ folder, so the stem is preserved exactly.
#
# Needs ffmpeg:  brew install ffmpeg
#
# ── The two profiles ─────────────────────────────────────────────────────────
# default : 720p, H.264, CRF 23, preset medium, faststart — mirrors the app's proxy
#           (video-proxy.ts) but a touch higher quality since it runs on the Mac, not a
#           phone. Fast enough for a bag of clips after a day's sailing.
# --archive: CRF 25, preset veryslow — noticeably smaller for the same look, much slower.
#           Use when you're compressing overnight for storage, not turnaround.

set -uo pipefail

have() { command -v "$1" >/dev/null 2>&1; }
have ffmpeg || { echo "✕ ffmpeg not found — brew install ffmpeg" >&2; exit 1; }

PRESET=medium; CRF=23
OUT=""; SS=""; TT=""; NAME=""; COPY=0
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive) PRESET=veryslow; CRF=25; shift ;;
    --out)     OUT="${2:-}"; [ -n "$OUT" ] || { echo "--out needs a directory" >&2; exit 1; }; shift 2 ;;
    --ss)      SS="${2:-}"; shift 2 ;;
    --t)       TT="${2:-}"; shift 2 ;;
    --name)    NAME="${2:-}"; shift 2 ;;
    --copy)    COPY=1; shift ;;
    *)         ARGS+=("$1"); shift ;;
  esac
done

usage() { echo "usage: $0 [--archive] <folder-of-clips> [out_dir]" >&2
          echo "       $0 [--archive] --out <dir> <file…>" >&2
          echo "       $0 --out <dir> --ss <sec> --t <sec> --name <stem> <file>" >&2
          echo "       $0 --copy --out <dir> --ss <sec> --t <sec> --name <stem> <file>" >&2; exit 1; }
[ "${#ARGS[@]}" -gt 0 ] || usage

# Two shapes: a single folder (the original form), or an explicit list of files.
FILES=()
shopt -s nullglob nocaseglob
if [ "${#ARGS[@]}" -le 2 ] && [ -d "${ARGS[0]}" ]; then
  SRC="${ARGS[0]}"
  [ -n "$OUT" ] || OUT="${ARGS[1]:-$SRC/compressed}"
  for f in "$SRC"/*.mp4 "$SRC"/*.mov "$SRC"/*.m4v; do FILES+=("$f"); done
  LABEL="$SRC"
else
  for f in "${ARGS[@]}"; do
    [ -f "$f" ] || { echo "✕ not a file: $f" >&2; exit 1; }
    FILES+=("$f")
  done
  # --ss/--t/--name cut ONE segment out of ONE clip; select-race-clips.mjs uses this
  # so the encoder settings are not duplicated on the trimming path.
  if [ -n "$SS$TT$NAME" ] && [ "${#FILES[@]}" -ne 1 ]; then
    echo "✕ --ss/--t/--name take exactly one input file" >&2; exit 1
  fi
  [ -n "$OUT" ] || OUT="compressed"
  LABEL="${#FILES[@]} file(s)"
fi
mkdir -p "$OUT"

# In segment mode (--name) the caller is looping and prints its own progress, so
# the banner and the closing advice would repeat once per segment.
QUIET=0; [ -n "$NAME" ] && QUIET=1
if [ "$QUIET" -eq 0 ]; then
  if [ "$COPY" -eq 1 ]; then
    echo "● Copying $LABEL → $OUT   (source resolution · no re-encode)"
  else
    echo "● Compressing $LABEL → $OUT   (720p · H.264 · CRF $CRF · $PRESET)"
  fi
  echo
fi

n=0; done=0
for f in "${FILES[@]}"; do
  # Don't recurse into our own output folder.
  case "$f" in "$OUT"/*) continue ;; esac
  n=$((n+1))
  stem="$(basename "$f")"; stem="${stem%.*}"     # SAME stem — this is what SSA matches on
  [ -n "$NAME" ] && stem="$NAME"                 # …unless a segment name was given
  dst="$OUT/$stem.mp4"
  before=$(du -h "$f" | cut -f1)
  printf '  → %s (%s) … ' "$stem" "$before"
  # -ss BEFORE -i seeks fast; with a re-encode ffmpeg still cuts accurately.
  CUT=(); DUR=()
  [ -n "$SS" ] && CUT+=(-ss "$SS")      # before -i: fast seek
  [ -n "$TT" ] && DUR+=(-t "$TT")       # after -i: output duration
  # -map_metadata 0 carries the capture metadata across. Without it the re-encode
  # zeroes mvhd and Keys:CreationDate, and the clip's start time then rests solely
  # on the filename.
  #
  # A SEGMENT is the exception: it starts somewhere inside its parent, so the
  # parent's creation time describes a moment the segment does not contain — for a
  # cut taken minutes in, it is minutes wrong. Blank it rather than propagate it;
  # the segment's own start is in its filename, which is what SSA reads.
  STAMP=()
  [ -n "$NAME" ] && STAMP=(-metadata creation_time=)
  # ${A[@]+"${A[@]}"} — bash 3.2 (what macOS ships) counts an EMPTY array as unset
  # under `set -u`, so a plain "${CUT[@]}" aborts every non-segment run.
  # --copy: cut at SOURCE resolution without re-encoding. Lossless and near
  # instant, so pulling full-res segments for a debrief costs a file copy rather
  # than an encode. The cut snaps to the nearest keyframe (a second or so), which
  # is immaterial for watching but is why the proxy path re-encodes.
  if [ "$COPY" -eq 1 ]; then
    ENC=(-c copy)
  else
    ENC=(-vf 'scale=-2:720'
         -c:v libx264 -profile:v high -level 4.0 -preset "$PRESET" -crf "$CRF"
         -c:a aac -b:a 96k -pix_fmt yuv420p)
  fi
  if ffmpeg -hide_banner -loglevel error -y ${CUT[@]+"${CUT[@]}"} -i "$f" ${DUR[@]+"${DUR[@]}"} \
       -map_metadata 0 ${STAMP[@]+"${STAMP[@]}"} \
       "${ENC[@]}" -movflags +faststart \
       "$dst"; then
    after=$(du -h "$dst" | cut -f1)
    echo "$after ✓"; done=$((done+1))
  else
    echo "FAILED (skipped)"; rm -f "$dst"
  fi
done

[ "$QUIET" -eq 1 ] && exit 0
echo
if [ "$n" -eq 0 ]; then
  echo "No .mp4/.mov/.m4v files found in $LABEL"
else
  echo "✓ $done/$n compressed → $OUT"
  echo "Now in SSA → Videos: select the same clips, hit ↑ Upload compressed, and pick these files."
fi
