// src/lib/tagging/gunFromLog.ts
// ─────────────────────────────────────────────────────────────────────────────
// The start gun, read out of the log — for a boat with no event file.
//
// A gun is a sound, so nothing in a track records it, and `race-start` has only
// ever come from the event file's own list. But Expedition's own start timer is
// logged: `TmToGun` is the seconds remaining until the gun, counted on the
// navigator's clock, and the parser now carries it onto the row as `tmGun`.
//
// So the gun is not detected, it is READ:
//
//     gun = row.utc + tmGun × 1000
//
// Every row of the sequence points at the same instant, which is the whole
// trick. It also makes the reading SELF-VERIFYING, and that matters more than
// the arithmetic:
//
//   • the sign convention is checked rather than trusted. If `tmGun` counted UP
//     from the gun instead of down to it, the derived instant would move at
//     twice the clock rate and no two rows would agree — so a wrong assumption
//     produces no gun rather than a wrong one.
//   • a timer somebody left frozen gives an instant that advances with the
//     clock, and agrees with nothing either.
//   • one corrupt row cannot move the answer: the instant is the MEDIAN of the
//     rows that agree, not the mean, and not the first row's claim.
//
// Which is to say the agreement is the evidence. A cluster of rows spanning a
// real stretch of the countdown, all naming one second, is a committee boat
// firing a gun at that second and nothing else looks like it.
//
// What this does NOT know is whether the sequence was for a race or a practice
// start — they are identical in the data, which is why `practice-start` exists
// as a separate tag for the crew to correct it to.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export interface GunRow { utc: number; tmGun?: number | null }

export interface DerivedGun {
  /** The gun, as the agreeing rows name it. */
  utc: number
  /** 1-based, in time order. */
  raceNum: number
  /** How many rows named this instant. */
  rows: number
  /** How far apart their claims were, in ms — the tightness of the agreement. */
  spreadMs: number
  /** Over how long a stretch of the countdown they were watching. */
  spanSec: number
  /** 0–1, two decimals. */
  confidence: number
}

export interface GunFromLogOpts {
  /** Rows whose `tmGun` is outside this window are not part of a sequence.
   *  Default: from 20 min before the gun to 2 min after. */
  maxBeforeSec?: number
  maxAfterSec?: number
  /** How far two rows' claims may differ and still be the same gun (ms). */
  tolMs?: number
  /** Fewest agreeing rows that can name a gun. */
  minRows?: number
  /** Shortest stretch of countdown that can name one (s). A single stationary
   *  second proves nothing; this is what makes the agreement mean something. */
  minSpanSec?: number
  /** Two guns closer than this are one gun seen either side of a log gap (s). */
  mergeSec?: number
}

const DEFAULTS = {
  maxBeforeSec: 20 * 60,
  maxAfterSec: 2 * 60,
  tolMs: 2500,
  minRows: 6,
  minSpanSec: 20,
  mergeSec: 120,
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Guns named by the log's own start timer, in time order.
 *
 * Returns [] for a log with no `tmGun` at all, which is every log before the
 * parser carried it and every boat whose Expedition does not log it — so a
 * caller can treat "no guns" as "nothing to say" rather than as a failure.
 */
export function gunsFromLog(
  rows: readonly GunRow[] | null | undefined,
  opts: GunFromLogOpts = {}
): DerivedGun[] {
  const o = { ...DEFAULTS, ...opts }
  if (!rows?.length) return []

  // Rows that are plausibly inside a start sequence, in clock order.
  const claims: { utc: number; target: number }[] = []
  for (const r of rows) {
    if (!isNum(r?.utc) || !isNum(r?.tmGun)) continue
    const t = r.tmGun as number
    if (t > o.maxBeforeSec || t < -o.maxAfterSec) continue
    claims.push({ utc: r.utc, target: r.utc + t * 1000 })
  }
  if (claims.length < o.minRows) return []
  claims.sort((a, b) => a.utc - b.utc)

  // Walk them, keeping a run of rows whose claims agree. Compared against the
  // run's own median rather than the previous row, so a single wild row does
  // not split a good sequence in two.
  const runs: { utc: number; target: number }[][] = []
  let run: { utc: number; target: number }[] = []
  for (const c of claims) {
    if (!run.length) { run = [c]; continue }
    const ref = median(run.map((x) => x.target))
    if (Math.abs(c.target - ref) <= o.tolMs) run.push(c)
    else { runs.push(run); run = [c] }
  }
  if (run.length) runs.push(run)

  const kept = runs
    .map((r) => {
      const targets = r.map((x) => x.target)
      return {
        utc: median(targets),
        rows: r.length,
        spreadMs: Math.max(...targets) - Math.min(...targets),
        spanSec: Math.round((r[r.length - 1].utc - r[0].utc) / 1000),
      }
    })
    .filter((g) => g.rows >= o.minRows && g.spanSec >= o.minSpanSec)
    .sort((a, b) => a.utc - b.utc)

  // One gun seen either side of a log gap is one gun. The better-attested run
  // names the instant; the rows add up, because they all watched the same
  // countdown.
  const merged: typeof kept = []
  for (const g of kept) {
    const prev = merged[merged.length - 1]
    if (prev && Math.abs(g.utc - prev.utc) <= o.mergeSec * 1000) {
      const best = g.rows > prev.rows ? g : prev
      merged[merged.length - 1] = {
        utc: best.utc,
        rows: prev.rows + g.rows,
        spreadMs: Math.max(prev.spreadMs, g.spreadMs),
        spanSec: prev.spanSec + g.spanSec,
      }
      continue
    }
    merged.push(g)
  }

  return merged.map((g, i) => ({
    ...g,
    raceNum: i + 1,
    confidence: gunConfidence(g.rows, g.spreadMs, g.spanSec),
  }))
}

/**
 * How much to believe a derived gun.
 *
 * Deliberately below the event file's own 0.95: the file records the gun the
 * navigator marked, while this is the gun the navigator's TIMER was set for,
 * and a timer set two seconds late is still two seconds late. High enough that
 * it does not clutter the review queue, low enough that a crew checks it once.
 */
export function gunConfidence(rows: number, spreadMs: number, spanSec: number): number {
  let c = 0.8
  // A whole sequence watched, rather than the last few seconds of one.
  if (spanSec >= 120) c += 0.05
  if (rows >= 60) c += 0.05
  // Agreement to the second is what the arithmetic should give; looser than
  // that means the timer was being adjusted, or the clock wandered.
  if (spreadMs > 1500) c -= 0.1
  if (spanSec < 45) c -= 0.1
  return round2(Math.max(0.3, Math.min(0.9, c)))
}
