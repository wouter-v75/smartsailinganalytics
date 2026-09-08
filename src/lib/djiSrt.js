// djiSrt.js — the wall clock (and position) DJI writes beside a clip.
//
// WHY: a drone clip's start time is otherwise a guess. On a Mavic 4 Pro the
// filename stamp and the container's creation_time disagree by about a second,
// and NEITHER is the time of the first frame — DJI writes the filename when
// recording is armed and creation_time when the file is closed. The .SRT
// sidecar carries an absolute timestamp per frame, so its first cue IS the
// first frame, and comparing its last cue against its own timecode says
// whether the aircraft's clock ran straight through the recording.
//
// Measured on the 8 Sept 2026 card (13 clips, Porto Cervo): the filename runs
// 0.34–1.30 s EARLY, always early, and intra-clip drift is 0.000–0.001 s. So
// the clock is sound and the sidecar buys sub-second placement, not a rescue.
//
// The sidecar exists only when "Video Captions" is enabled on the aircraft.
// Everything here returns null when it is not, and the caller falls back.

// Wall clock as milliseconds, using the SAME convention as the rest of the
// pipeline: the local reading is stored as if it were UTC, and the true zone is
// applied once, by the caller. Mixing the two is how a clip lands two hours out.
function wallMs(y, mo, d, h, mi, s, ms) {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  if (h > 23 || mi > 59 || s > 59) return null
  return Date.UTC(y, mo - 1, d, h, mi, s, ms || 0)
}

// DJI has shipped several cue layouts. All of them put an absolute date-time on
// its own line; the separators and the fractional part are what move around:
//   2026-09-08 12:11:54.466      (Mavic 4 Pro, Mavic 3, Mini)
//   2019-08-15 10:34:22,123,456  (Phantom / older Mavic — ms,us)
//   2016.06.13 15:23:39          (very old, no fraction)
const STAMP = /(\d{4})[-.](\d{2})[-.](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/

function stampMs(s) {
  const m = STAMP.exec(s)
  if (!m) return null
  const frac = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  return wallMs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], frac)
}

// The cue's own position on the video timeline, "HH:MM:SS,mmm --> ...".
const CUE = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/
function cueSec(s) {
  const m = CUE.exec(s)
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : null
}

// Position, when the firmware writes it. Note `longtitude`: that misspelling is
// DJI's own, and it ships on real firmware, so both spellings are accepted.
const num = (text, key) => {
  const m = new RegExp(`\\[\\s*${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i').exec(text)
  return m ? Number(m[1]) : null
}
function fixOf(block) {
  const lat = num(block, 'latitude')
  const lon = num(block, 'longitude') ?? num(block, 'longtitude')
  return lat == null || lon == null ? null : { lat, lon }
}

/**
 * Read a DJI .SRT. Returns null when the text is not a usable sidecar.
 *   startMs / endMs  wall clock of the first / last frame
 *   spanSec          endMs - startMs, in seconds
 *   timelineSec      the last cue's own position on the video timeline
 *   driftSec         spanSec - timelineSec: how far the aircraft's clock ran
 *                    away from the video's own timebase over the recording
 *   fps              from DiffTime, when present (40ms -> 25)
 *   firstFix/lastFix {lat, lon} when the firmware writes position
 */
export function parseDjiSrt(text) {
  if (!text) return null
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/).filter((b) => b.trim())
  if (!blocks.length) return null

  let first = null, last = null
  for (const b of blocks) {
    const ms = stampMs(b)
    if (ms == null) continue
    if (!first) first = { ms, block: b }
    last = { ms, block: b, cue: cueSec(b) }
  }
  if (!first || !last) return null

  const diff = /DiffTime\s*:\s*(\d+)\s*ms/i.exec(text)
  const spanSec = (last.ms - first.ms) / 1000
  const timelineSec = last.cue

  return {
    startMs: first.ms,
    endMs: last.ms,
    cues: blocks.length,
    spanSec,
    timelineSec,
    driftSec: timelineSec == null ? null : Number((spanSec - timelineSec).toFixed(3)),
    fps: diff ? Math.round(1000 / Number(diff[1])) : null,
    firstFix: fixOf(first.block),
    lastFix: fixOf(last.block),
  }
}

// Sidecar paths to try for a clip. DJI matches the basename and upper-cases the
// extension, but cards get copied through case-preserving and case-folding
// filesystems alike, so try both.
export function srtCandidates(videoPath) {
  const stem = String(videoPath).replace(/\.[^./\\]+$/, '')
  return [`${stem}.SRT`, `${stem}.srt`]
}
