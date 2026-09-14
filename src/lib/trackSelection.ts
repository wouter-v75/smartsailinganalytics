// src/lib/trackSelection.ts
// ─────────────────────────────────────────────────────────────────────────────
// Picking a stretch of the GPS track by dragging along it. The selection is a time
// range, so every chart below the map can show just that part of the session.
//
// A windward-leeward course sails the same water on every lap, so the point under
// the cursor is ambiguous where legs cross. While dragging, the pick stays on the
// leg the drag is already on (the run of nearby points closest in time to the last
// pick), and takes the point nearest the cursor within that leg.
// ─────────────────────────────────────────────────────────────────────────────

export interface ScreenPoint { x: number; y: number }
export type TimeRange = [number, number]

export function nearestTrackIndex(points: ScreenPoint[], p: ScreenPoint, tolPx: number, prefer: number | null = null): number | null {
  const tol2 = tolPx * tolPx
  const d2 = (i: number) => (points[i].x - p.x) ** 2 + (points[i].y - p.y) ** 2
  // Runs of consecutive indices inside the tolerance = one pass of the track past the cursor.
  const runs: number[][] = []
  for (let i = 0; i < points.length; i++) {
    if (d2(i) > tol2) continue
    const last = runs[runs.length - 1]
    if (last && i - last[last.length - 1] <= 2) last.push(i)
    else runs.push([i])
  }
  if (!runs.length) return null
  const runDist = (run: number[]) => (prefer == null ? 0 : Math.min(...run.map(i => Math.abs(i - prefer))))
  const nearestIn = (run: number[]) => run.reduce((a, b) => (d2(b) < d2(a) ? b : a))
  if (prefer == null) return nearestIn(runs.map(nearestIn))
  return nearestIn(runs.reduce((a, b) => (runDist(b) < runDist(a) ? b : a)))
}

// Start before end, whichever way the drag went.
export const orderedRange = (a: number, b: number): TimeRange => (a <= b ? [a, b] : [b, a])

export const inRange = (utc: number, range: TimeRange | null | undefined) =>
  !range || (utc >= range[0] && utc <= range[1])

// A 30 s phase belongs to the selection when its midpoint does.
export const phaseInRange = (p: { utc: number; endUtc: number }, range: TimeRange | null | undefined) =>
  inRange((p.utc + p.endUtc) / 2, range)
