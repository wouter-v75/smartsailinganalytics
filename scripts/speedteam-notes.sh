#!/usr/bin/env bash
# speedteam-notes.sh — record an in-person speed-team meeting, transcribe it locally,
# and have Claude turn it into the three SSA speed-team fields.
#
#   ./scripts/speedteam-notes.sh                    # record → transcribe → summarise
#   ./scripts/speedteam-notes.sh --audio foo.wav    # skip recording
#   ./scripts/speedteam-notes.sh --transcript t.txt # skip straight to the summary
#   ./scripts/speedteam-notes.sh --list-devices     # which mic is which
#
# Everything is written to  ~/SSA/meetings/<date>/  — outside the repo, never committed.
# The AUDIO NEVER LEAVES THE MACHINE: transcription is whisper.cpp running locally. Only
# the finished TEXT transcript is sent to Claude for the summary.
#
# ── One-time setup ───────────────────────────────────────────────────────────
#   brew install ffmpeg whisper-cpp jq
#   mkdir -p ~/.whisper && curl -L -o ~/.whisper/ggml-large-v3-turbo.bin \
#     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
#   export ANTHROPIC_API_KEY=sk-ant-...        (add to ~/.zshrc)
#
# ── The one thing that actually decides quality ──────────────────────────────
# Eight people round a table is a HARD recording. The laptop's built-in mic will give you
# a transcript full of holes, and no amount of AI fixes audio that was never captured.
# A £50 USB conference mic (Jabra Speak, Anker PowerConf) in the middle of the table is
# the difference between a usable transcript and a useless one. Run --list-devices and
# pick it explicitly.

set -uo pipefail

MODEL="${WHISPER_MODEL:-$HOME/.whisper/ggml-large-v3-turbo.bin}"
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-sonnet-4-6}"
OUTDIR_BASE="${SSA_MEETINGS_DIR:-$HOME/SSA/meetings}"
DEVICE="${AUDIO_DEVICE:-:0}"          # ffmpeg avfoundation ":<audio-index>"
LANG="${MEETING_LANG:-en}"

AUDIO=""
TRANSCRIPT=""

die() { echo "✕ $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --audio)        AUDIO="$2"; shift 2 ;;
    --transcript)   TRANSCRIPT="$2"; shift 2 ;;
    --device)       DEVICE="$2"; shift 2 ;;
    --list-devices)
      have ffmpeg || die "ffmpeg not found — brew install ffmpeg"
      echo "Audio inputs (use the number, e.g. --device :1):"
      ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | sed -n '/AVFoundation audio devices/,$p'
      exit 0 ;;
    -h|--help)      sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

DATE=$(date +%Y-%m-%d)
STAMP=$(date +%H%M)
OUTDIR="$OUTDIR_BASE/$DATE"
mkdir -p "$OUTDIR"

# ── 1. RECORD ────────────────────────────────────────────────────────────────
if [ -z "$AUDIO" ] && [ -z "$TRANSCRIPT" ]; then
  have ffmpeg || die "ffmpeg not found — brew install ffmpeg"
  AUDIO="$OUTDIR/meeting-$STAMP.wav"
  echo "● Recording from device $DEVICE"
  echo "  → $AUDIO"
  echo
  echo "  Press Ctrl-C when the meeting ends. (--list-devices to pick another mic.)"
  echo
  # 16 kHz mono is exactly what whisper wants — no resampling later, and an hour is ~110 MB.
  ffmpeg -hide_banner -loglevel error -stats \
         -f avfoundation -i "$DEVICE" \
         -ac 1 -ar 16000 -c:a pcm_s16le \
         "$AUDIO"
  # ffmpeg exits non-zero on Ctrl-C; the file is still good.
  [ -s "$AUDIO" ] || die "nothing was recorded — check the device with --list-devices"
  echo
  echo "✓ Recorded $(du -h "$AUDIO" | cut -f1)"
fi

# ── 2. TRANSCRIBE (locally) ──────────────────────────────────────────────────
if [ -z "$TRANSCRIPT" ]; then
  have whisper-cli || have whisper-cpp || die "whisper.cpp not found — brew install whisper-cpp"
  [ -f "$MODEL" ] || die "model not found at $MODEL
  Download it once:
    mkdir -p ~/.whisper && curl -L -o $MODEL \\
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"

  WHISPER=$(command -v whisper-cli || command -v whisper-cpp)
  BASE="${AUDIO%.*}"
  echo "◐ Transcribing locally (nothing is uploaded)…"
  "$WHISPER" -m "$MODEL" -f "$AUDIO" -l "$LANG" -otxt -of "$BASE" -pp 2>/dev/null \
    || die "transcription failed"
  TRANSCRIPT="$BASE.txt"
  [ -s "$TRANSCRIPT" ] || die "transcript came out empty — was anything actually recorded?"
  WORDS=$(wc -w < "$TRANSCRIPT" | tr -d ' ')
  echo "✓ Transcript: $TRANSCRIPT ($WORDS words)"
fi

# ── 3. SUMMARISE ─────────────────────────────────────────────────────────────
have jq || die "jq not found — brew install jq"
[ -n "${ANTHROPIC_API_KEY:-}" ] || die "ANTHROPIC_API_KEY is not set (add it to ~/.zshrc)"

SUMMARY="$OUTDIR/speedteam-notes-$STAMP.md"

# The three fields are EXACTLY the ones in SSA (Campaign → Day → Speed-team meeting):
#   speed_learnings · speed_focus_today · speed_long_term
read -r -d '' PROMPT <<'EOF'
You are summarising a sailing team's SPEED TEAM meeting for a performance-analysis app.

The transcript is from a live, in-person meeting of about eight people. It is a raw
machine transcript: it has no speaker labels, it will contain mishearings (especially of
sail names, boat parts and numbers), and people talk over each other. Work with what is
actually there.

Produce EXACTLY three sections, in this order, using these headings:

## Learnings
What the team established about boat speed and setup — what was fast, what was slow, and
why. Concrete and specific: sail combinations, rig settings, modes, conditions, numbers.

## Focus for today
What they decided to test, try or watch on the water next. Actionable items only.

## Long-term development
Bigger themes: gear to change, data to gather, questions to resolve over the campaign.

RULES — these matter:
- Use ONLY what is in the transcript. Do not invent numbers, sail names or conclusions.
- If a section has nothing in the transcript, write "Nothing recorded." under it. Do not
  pad it out. An empty section is information; a fabricated one is a liability.
- Where the transcript is garbled but the meaning is clear, use the meaning. Where the
  meaning is NOT clear, say so briefly, e.g. "(unclear — check the recording ~12:30)".
- Keep sailing terminology as the team used it. Do not translate jargon into plain English.
- Bullet points. Terse. This is a working note, not prose.
- Do not attribute statements to individuals — the transcript has no reliable speaker labels.
EOF

echo "◐ Summarising with $CLAUDE_MODEL…"

REQ=$(jq -n \
  --arg model "$CLAUDE_MODEL" \
  --arg system "$PROMPT" \
  --arg text "$(cat "$TRANSCRIPT")" \
  '{
     model: $model,
     max_tokens: 2000,
     system: $system,
     messages: [ { role: "user", content: ("Here is the meeting transcript:\n\n" + $text) } ]
   }')

RESP=$(curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "$REQ")

ERR=$(printf '%s' "$RESP" | jq -r '.error.message // empty')
[ -z "$ERR" ] || die "Claude: $ERR"

printf '%s' "$RESP" | jq -r '.content[0].text // empty' > "$SUMMARY"
[ -s "$SUMMARY" ] || die "no summary came back"

# Clipboard, ready to paste into Campaign → Day → Speed-team meeting.
pbcopy < "$SUMMARY"

echo
echo "──────────────────────────────────────────────────────────────────────────"
cat "$SUMMARY"
echo "──────────────────────────────────────────────────────────────────────────"
echo
echo "✓ Summary   $SUMMARY   (copied to the clipboard)"
echo "✓ Transcript $TRANSCRIPT"
[ -n "${AUDIO:-}" ] && echo "✓ Audio      $AUDIO"
echo
echo "Paste into SSA → Campaign → Day → Speed-team meeting."
echo "Read it against the transcript before you save it — it is a summary of a rough"
echo "recording, not a record of what was said."
