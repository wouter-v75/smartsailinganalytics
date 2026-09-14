// src/lib/manoeuvres.ts
// ─────────────────────────────────────────────────────────────────────────────
// Tack & gybe analysis — the KND report's "Points of interest" tables. Finds the
// day's manoeuvres (event file first, TWA sign flips in the log as a fallback),
// decides which ones are racing manoeuvres worth judging, and measures each one.
//
// Definitions were fitted against KND's 11 Sep 2026 tables on the 6 s cloud log
// (see __tests__/manoeuvres.fixture.test.ts):
//   BSP before      mean BSP −40…−10 s                      (tacks ±0.04 kn)
//   Time to 95 %    first sample after the speed low back at 95 % of BSP before (±1.5 s)
//   BSP after       BSP at +20 s (mean of the 17–23 s samples) (±0.4 kn)
//   Turn angle      heading −20…−5 s → +15…+30 s             (±2°)
//   Dist lost       KND's 1 Hz method: VMG (BSP·|cos TWA|) against its mean over the
//                   30 s before (−35…−5 s), summed −20…+60 s. Indicative — KND's own
//                   two methods "do not match closely" (tacks ±6 m, gybes ±45 m).
//   Max rotation    fastest heading change between samples — coarse at 6 s steps.
// "Dist lost over GPS" is not attempted: the cloud log rounds lat/lon to 0.01° (~1 km).
//
// Which manoeuvres are judged (reproduces KND's 13 tacks / 5 gybes on 11 Sep):
//   • in a race: from a gun until 20 min before the next gun, or the event file's day stop;
//   • not a mark rounding: nothing less than 30 s before a mark rounding.
// ─────────────────────────────────────────────────────────────────────────────

import { sailComboLabel, type LogRow, type Tack } from './phaseStats'
import { activeSailsAt } from './scanEnrich'

export type ManoeuvreKind = 'tack' | 'gybe'
export type ManoeuvreContext = 'race' | 'training' | 'pre-start' | 'after'

export interface Manoeuvre {
  utc: number
  kind: ManoeuvreKind
  source: 'event' | 'log'
  context: ManoeuvreContext
  race: number | null            // 1-based race index, null outside a race
  atMark: boolean                // a mark rounding follows within 30 s — this IS the rounding
  intoMark: boolean              // a mark rounding 30–60 s later
  shortHitch: boolean            // previous manoeuvre less than 60 s earlier
  logGap: boolean                // a gap > 15 s in the log around it
  from: Tack | null
  to: Tack | null
  sails: string
  tws: number | null
  bspBefore: number | null
  bspAfter: number | null
  timeTo95: number | null        // s
  distLost: number | null        // m; null when the window is contaminated (hitch, mark, gap)
  maxRotation: number | null     // deg/s
  turnAngle: number | null       // deg
  target: number                 // deg
}

export interface ManoeuvreOpts {
  targets?: Record<ManoeuvreKind, number>  // turn-angle targets (N76: tack 70°, gybe 60°)
  minBsp?: number                          // log fallback ignores flips below this BSP (6 kn)
}

const KN = 0.5144
const MARK_S = 30
const SETTLE_S = 60
const PRESTART_MIN = 20

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const rad = (d: number) => (d * Math.PI) / 180
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const angleDiff = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180)

function circularMean(deg: number[]): number | null {
  if (!deg.length) return null
  let s = 0, c = 0
  for (const d of deg) { s += Math.sin(rad(d)); c += Math.cos(rad(d)) }
  return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360
}

function lowerBound(rows: LogRow[], utc: number): number {
  let lo = 0, hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].utc < utc) lo = mid + 1
    else hi = mid
  }
  return lo
}
const between = (rows: LogRow[], t0: number, a: number, b: number) =>
  rows.slice(lowerBound(rows, t0 + a * 1000), lowerBound(rows, t0 + b * 1000))
const values = (rs: LogRow[], key: string) =>
  rs.map(r => num(r[key])).filter((v): v is number => v != null)

// ── Finding them ────────────────────────────────────────────────────────────

export interface FoundManoeuvre { utc: number; kind: ManoeuvreKind; source: 'event' | 'log' }

// TWA sign flips above `minBsp`: both sides upwind → tack, both downwind → gybe.
export function detectFromLog(rows: LogRow[], minBsp = 6): FoundManoeuvre[] {
  const out: FoundManoeuvre[] = []
  for (let i = 1; i < rows.length; i++) {
    const a = num(rows[i - 1].twa), b = num(rows[i].twa), bsp = num(rows[i - 1].bsp)
    if (a == null || b == null || bsp == null || bsp < minBsp || (a >= 0) === (b >= 0)) continue
    const up = Math.abs(a) < 90 && Math.abs(b) < 90
    const down = Math.abs(a) > 90 && Math.abs(b) > 90
    if (!up && !down) continue
    if (out.length && rows[i].utc - out[out.length - 1].utc < 20_000) continue
    out.push({ utc: rows[i].utc, kind: up ? 'tack' : 'gybe', source: 'log' })
  }
  return out
}

// The event file's tack/gybe list, valid or not (the onboard "valid" flag is about its
// own measurement, not whether the manoeuvre happened). The log fills in only when the
// event file lists none.
export function findManoeuvres(rows: LogRow[], xml: any, minBsp = 6): FoundManoeuvre[] {
  const events: FoundManoeuvre[] = (xml?.tackJibes || [])
    .filter((t: any) => typeof t?.utc === 'number' && Number.isFinite(t.utc))
    .map((t: any) => ({ utc: t.utc, kind: t.isTack ? 'tack' : 'gybe', source: 'event' as const }))
  const found = events.length ? events : detectFromLog(rows, minBsp)
  return found.sort((a, b) => a.utc - b.utc)
}

function contextOf(utc: number, guns: number[], dayStop: number | null): { context: ManoeuvreContext; race: number | null } {
  if (dayStop != null && utc > dayStop) return { context: 'after', race: null }
  if (!guns.length) return { context: 'training', race: null }
  const started = guns.filter(g => g <= utc).length
  if (!started) return { context: 'pre-start', race: null }
  const next = guns[started]
  if (next != null && utc >= next - PRESTART_MIN * 60_000) return { context: 'pre-start', race: null }
  return { context: 'race', race: started }
}

// ── Measuring them ──────────────────────────────────────────────────────────

export function analyseManoeuvres(rows: LogRow[] | null | undefined, xml: any, opts: ManoeuvreOpts = {}): Manoeuvre[] {
  if (!rows?.length) return []
  const targets = opts.targets ?? { tack: 70, gybe: 60 }
  const guns: number[] = (xml?.raceGuns || []).map((g: any) => g?.utc).filter((u: unknown) => typeof u === 'number').sort((a: number, b: number) => a - b)
  const marks: number[] = (xml?.markRoundings || []).map((m: any) => m?.utc).filter((u: unknown) => typeof u === 'number')
  const dayStop = num(xml?.dayStopUtc)
  const found = findManoeuvres(rows, xml, opts.minBsp ?? 6)

  return found.map((f, i) => {
    const t0 = f.utc
    const { context, race } = contextOf(t0, guns, dayStop)
    const atMark = marks.some(mk => mk >= t0 && mk - t0 <= MARK_S * 1000)
    const intoMark = !atMark && marks.some(mk => mk - t0 > MARK_S * 1000 && mk - t0 <= SETTLE_S * 1000)
    const shortHitch = i > 0 && t0 - found[i - 1].utc < SETTLE_S * 1000
    const markInWindow = marks.some(mk => mk - t0 >= -35_000 && mk - t0 <= SETTLE_S * 1000)

    const pre = between(rows, t0, -40, -10)
    const bspBefore = mean(values(pre, 'bsp'))
    const twaBefore = mean(values(pre, 'twa'))
    const twaAfter = mean(values(between(rows, t0, 15, 30), 'twa'))
    const bspAfter = mean(values(between(rows, t0, 17, 23), 'bsp'))

    // Time to 95 %: the speed low is looked for in the first 30 s only (a later lull or
    // the next manoeuvre is not this one's dip), it has to be a real dip below 95 % (after
    // a short hitch "BSP before" can be the previous tack's recovery — 11 Sep 12:52:02),
    // and the log must run unbroken from the manoeuvre to the recovery.
    let timeTo95: number | null = null
    const after = between(rows, t0, 0, 90).filter(r => num(r.bsp) != null)
    if (bspBefore != null && after.length && after[0].utc - t0 <= 10_000) {
      let iMin = 0
      after.forEach((r, k) => { if (r.utc - t0 <= 30_000 && (r.bsp as number) < (after[iMin].bsp as number)) iMin = k })
      const dipped = (after[iMin].bsp as number) < 0.95 * bspBefore
      for (let k = iMin; dipped && k < after.length; k++) {
        if (k > 0 && after[k].utc - after[k - 1].utc > 15_000) break
        if ((after[k].bsp as number) >= 0.95 * bspBefore) { timeTo95 = (after[k].utc - t0) / 1000; break }
      }
    }

    const h1 = circularMean(values(between(rows, t0, -20, -5), 'hdg'))
    const h2 = circularMean(values(between(rows, t0, 15, 30), 'hdg'))
    const turnAngle = h1 != null && h2 != null ? angleDiff(h1, h2) : null

    let maxRotation: number | null = null
    const turn = between(rows, t0, -12, 30)
    for (let k = 1; k < turn.length; k++) {
      const a = num(turn[k - 1].hdg), b = num(turn[k].hdg)
      const dt = (turn[k].utc - turn[k - 1].utc) / 1000
      if (a == null || b == null || dt <= 0 || dt > 10) continue
      const rate = angleDiff(a, b) / dt
      if (maxRotation == null || rate > maxRotation) maxRotation = rate
    }

    const span = between(rows, t0, -35, 60)
    const logGap = span.length < 2 || span[0].utc - t0 > -25_000 || span[span.length - 1].utc - t0 < 50_000 ||
      span.some((r, k) => k > 0 && r.utc - span[k - 1].utc > 15_000)

    let distLost: number | null = null
    if (!shortHitch && !markInWindow && !logGap) {
      const vmg = (r: LogRow) => {
        const bsp = num(r.bsp), twa = num(r.twa)
        return bsp == null || twa == null ? null : bsp * Math.abs(Math.cos(rad(twa)))
      }
      const base = mean(between(rows, t0, -35, -5).map(vmg).filter((v): v is number => v != null))
      if (base != null) {
        const w = between(rows, t0, -20, 60)
        let lost = 0
        for (let k = 1; k < w.length; k++) {
          const v = vmg(w[k - 1])
          const dt = (w[k].utc - w[k - 1].utc) / 1000
          if (v != null && dt > 0) lost += (base - v) * dt * KN
        }
        distLost = lost
      }
    }

    return {
      utc: t0, kind: f.kind, source: f.source, context, race, atMark, intoMark, shortHitch, logGap,
      from: twaBefore == null ? null : twaBefore >= 0 ? 'stbd' : 'port',
      to: twaAfter == null ? null : twaAfter >= 0 ? 'stbd' : 'port',
      sails: sailComboLabel(activeSailsAt(xml, t0)),
      tws: mean(values(pre, 'tws')),
      bspBefore, bspAfter, timeTo95, distLost, maxRotation, turnAngle, target: targets[f.kind],
    }
  })
}

// Racing (or training-day) manoeuvres that aren't mark roundings — the ones KND judges.
export const isJudged = (m: Manoeuvre) => (m.context === 'race' || m.context === 'training') && !m.atMark

export const MANOEUVRE_METRICS = ['timeTo95', 'distLost', 'maxRotation', 'bspBefore', 'bspAfter', 'turnAngle'] as const
export type ManoeuvreMetric = typeof MANOEUVRE_METRICS[number]

export function manoeuvreAverages(list: Manoeuvre[]): Record<ManoeuvreMetric, number | null> {
  const out = {} as Record<ManoeuvreMetric, number | null>
  for (const k of MANOEUVRE_METRICS) out[k] = mean(list.map(m => m[k]).filter((v): v is number => v != null))
  return out
}

export function manoeuvreNote(m: Manoeuvre): string {
  const notes: string[] = []
  if (m.atMark) notes.push('at mark')
  else if (m.intoMark) notes.push('into mark')
  if (m.shortHitch) notes.push('short hitch')
  if (m.logGap) notes.push('log gap')
  if (m.context === 'pre-start') notes.push('pre-start')
  if (m.context === 'after') notes.push('after racing')
  if (m.source === 'log') notes.push('from log')
  return notes.join(' · ')
}
