// scripts/lib/joinSegments.mjs
// ─────────────────────────────────────────────────────────────────────────────
// One moment, one clip — even when the drone split the recording through it.
//
// The cutter trims each window to the FILE it came from, which is right: a file
// is the only thing with a timebase to cut against. But a drone writes a new
// file every few GB, and a window straddling that boundary comes out as two or
// three consecutive clips of one rounding. 2 October's start was 118 s + 28 s,
// and one gate was 28 s + 25 s + 1 s — a crew looking at the Videos tab sees the
// same mark listed three times and cannot tell which to open.
//
// So after the jobs are built, consecutive pieces of the SAME window from
// DIFFERENT files are joined into one job with several parts. The encoder cuts
// each part as before; the parts are then concatenated into one file.
//
// What makes two pieces the same moment, all four required:
//   · both are trimmed segments — a whole-clip job has no window to share
//   · the same tags, so a start never absorbs the rounding after it
//   · different source files, since two windows in one file are two moments
//   · contiguous in time, within `joinMs` of each other
//
// `joinMs` is the seam, not a merge distance. A DJI split loses two or three
// seconds; the widest seen is eight. The default is deliberately below the
// shortest real gap between two tagged moments — join too generously and two
// genuinely separate roundings become one clip, which is worse than the problem.
//
// Pure: no I/O, no ffmpeg. The caller encodes.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_JOIN_MS = 15_000

const startMs = (j) => Date.parse(`${j.startWall}Z`)
const endMs = (j) => startMs(j) + (j.durSec || 0) * 1000
const tagKey = (j) => [...new Set(j.tags || [])].sort().join('+')

/** A job that can take part in a join: a trimmed segment with a real start. */
const joinable = (j) => !!j && j.durSec > 0 && !!j.startWall && Number.isFinite(startMs(j))

const union = (a = [], b = []) => [...new Set([...a, ...b])]
const round2 = (n) => Number(n.toFixed(2))

/**
 * Join consecutive pieces of one window that fell across a file boundary.
 *
 * Returns a new list. A joined job keeps the FIRST piece's name, start and
 * `src`/`ssSec` — so anything reading a single-source job still works — and
 * gains `parts`, in order, plus a `durSec` that is the sum of the parts. The
 * seam itself is gone: those two or three seconds were never recorded.
 *
 * Jobs that cannot join (whole clips, untimed ones) are returned untouched, in
 * their original order after the joined ones; the caller sorts for encode order
 * anyway.
 */
export function joinAcrossFiles(jobs, joinMs = DEFAULT_JOIN_MS) {
  const all = Array.isArray(jobs) ? jobs : []
  const can = all.filter(joinable).sort((a, b) => startMs(a) - startMs(b))
  const rest = all.filter((j) => !joinable(j))

  const runs = []
  for (const j of can) {
    const run = runs[runs.length - 1]
    const prev = run?.[run.length - 1]
    const gap = prev ? startMs(j) - endMs(prev) : Infinity
    const fits = prev
      && tagKey(prev) === tagKey(j)
      && prev.src !== j.src
      // A small negative gap is container rounding, not an overlap worth fearing.
      && gap <= joinMs && gap >= -2_000
    if (fits) run.push(j)
    else runs.push([j])
  }

  const joined = runs.map((run) => {
    if (run.length === 1) return run[0]
    const first = run[0]
    return {
      ...first,
      durSec: round2(run.reduce((s, p) => s + p.durSec, 0)),
      labels: run.reduce((s, p) => union(s, p.labels), []),
      kinds: run.reduce((s, p) => union(s, p.kinds), []),
      tags: run.reduce((s, p) => union(s, p.tags), []),
      parts: run.map((p) => ({ src: p.src, ssSec: p.ssSec, durSec: p.durSec })),
      // What the join actually spans, seam included. The duration is what gets
      // encoded; this is where on the water it sits, and the two differ by the
      // seconds the drone dropped.
      spanSec: round2((endMs(run[run.length - 1]) - startMs(first)) / 1000),
    }
  })

  return [...joined, ...rest]
}

/** How many jobs a join saved, for the one line the cutter prints. */
export function joinSummary(before, after) {
  const pieces = after.reduce((n, j) => n + (j.parts ? j.parts.length : 0), 0)
  const joins = after.filter((j) => j.parts).length
  return { joins, pieces, saved: before.length - after.length }
}

// ── the concat itself ────────────────────────────────────────────────────────
// Separated from the cutter so the two things that are easy to get wrong can be
// tested without an encoder: the list file's quoting, and the argument order.

/**
 * The body of ffmpeg's concat list file.
 *
 * `file '<path>'` per line. A single quote inside a path has to be closed,
 * escaped and reopened — `'\''` — because ffmpeg's demuxer takes the quoting
 * literally. A card called "Wouter's SSD" is not exotic, and without this the
 * list silently refers to a file that does not exist.
 */
export function listFileBody(files) {
  return (files || []).map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

/**
 * The ffmpeg arguments that join the pieces.
 *
 * `-c copy`: the pieces have already been encoded with identical settings, so
 * there is nothing to gain from a second pass and a generation to lose. `-safe 0`
 * because the list holds absolute paths. `-y` because the output may be a
 * partial file from an interrupted run.
 */
export function concatArgs(listPath, outPath) {
  return [
    '-nostdin', '-v', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart',
    outPath,
  ]
}
