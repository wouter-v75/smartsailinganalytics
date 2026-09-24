// src/lib/seasonCurves.ts
// ─────────────────────────────────────────────────────────────────────────────
// Season reference curves — the KND report's "upbsp-25 / upbsp-26" lines. Every
// session's phase averages are stored (session_phase_stats, migration 0060) in a
// compact form; a season curve is the MEDIAN of a channel per 1 kn TWS bin over all
// of that season's phases of one point of sail, drawn on the X-Y plots as the
// boat's own baseline to judge a day against.
// Pure — used by the API routes (store / aggregate) and tests.
// ─────────────────────────────────────────────────────────────────────────────

import { CHANNELS, type Mode, type PhaseStat, type Tack } from './phaseStats'
import type { Manoeuvre } from './manoeuvres'

// Bump when phaseStats / CHANNELS change the numbers a phase produces, so stored
// rows are recomputed instead of mixing old and new maths in one curve. Adding a
// channel doesn't need a bump: existing numbers are unchanged, and older rows simply
// lack the new key until they are next recomputed.
// 2 — stored phases carry their maxima (x); rows carry manoeuvres + log resolution (0061).
// 3: the five minutes before a start gun count as that race (src/lib/phaseStats.ts).
// Stored rows carry `race`, so rows written under the old rule are rebuilt.
// Still 3 after TOE-IN joined CHANNELS (24 Sep 2026), deliberately. The version
// means THE STORED NUMBERS ARE WRONG, and adding a channel changes none of them —
// a v3 row is not wrong, it is incomplete. A bump would have been actively worse:
// only 13 of the 33 stored days can be rebuilt from the cloud log, because five
// hold stats computed from a ~1 s device log that the ~2-6 s cloud copy must not
// overwrite (11 Sep among them, the day validated against the KND report) and
// eight have no event-file phases in the cloud session at all. Since Ask reads
// only rows AT the current version, bumping would have hidden twenty days to add
// one channel. `npm run stats:backfill -- --missing toeIn` fills in what it can;
// the tools report the coverage of what it cannot.
export const STATS_VERSION = 3

export interface StoredSummary { stats_version: number; polar_id: string | null; computed_at: string }

// A stored row is current when it was computed by this STATS_VERSION, with the boat's
// active polar, and AFTER the session last changed. sessions.updated_at moves on every
// update (trigger sessions_touch, 0003), so a log or event file uploaded later — e.g. a
// day whose event file came in before its log — makes the row stale.
export function statsAreCurrent(
  row: StoredSummary | null | undefined,
  now: { polarId: string | null; sessionUpdatedAt: string | null }
): boolean {
  if (!row || row.stats_version !== STATS_VERSION) return false
  if ((row.polar_id ?? null) !== (now.polarId ?? null)) return false
  if (!now.sessionUpdatedAt) return true
  const computed = Date.parse(row.computed_at)
  const updated = Date.parse(now.sessionUpdatedAt)
  return Number.isFinite(computed) && Number.isFinite(updated) && updated <= computed
}

// One stored phase: utc, end, mode, tack, sails, race, samples, channel means (v) and
// maxima (x — absent on version-1 rows).
export interface StoredPhase {
  u: number
  e: number
  m: Mode
  t: Tack
  s: string
  r: number | null
  n: number
  v: Record<string, number>
  x?: Record<string, number>
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

const compactValues = (rec: Record<string, number | null>) => {
  const out: Record<string, number> = {}
  for (const [k, x] of Object.entries(rec)) if (x != null && Number.isFinite(x)) out[k] = round3(x)
  return out
}

export function compactPhases(stats: PhaseStat[]): StoredPhase[] {
  return stats.map(p => ({
    u: p.utc, e: p.endUtc, m: p.mode, t: p.tack, s: p.sailCombo, r: p.race, n: p.n,
    v: compactValues(p.mean), x: compactValues(p.max),
  }))
}

// Stored phases back into the shape the charts and report tables take.
export function expandPhases(stored: StoredPhase[] | null | undefined): PhaseStat[] {
  return (stored || []).map(p => ({
    utc: p.u, endUtc: p.e, mode: p.m, tack: p.t, sails: [], sailCombo: p.s, race: p.r, n: p.n,
    mean: { ...p.v }, max: { ...(p.x || {}) },
  }))
}

// Manoeuvres are stored as they are, numbers rounded to 3 decimals.
export function compactManoeuvres(list: Manoeuvre[]): Manoeuvre[] {
  return list.map(m => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(m)) out[k] = typeof v === 'number' && !Number.isInteger(v) ? round3(v) : v
    return out as unknown as Manoeuvre
  })
}

// Median seconds between log rows — ≈1 for a full log, ≈6 for the cloud copy.
export function medianInterval(rows: { utc: number }[] | null | undefined): number | null {
  if (!rows || rows.length < 2) return null
  const step = Math.max(1, Math.floor(rows.length / 2000))   // sample long logs
  const gaps: number[] = []
  for (let i = step; i < rows.length; i += step) {
    const d = (rows[i].utc - rows[i - step].utc) / 1000 / step
    if (d > 0) gaps.push(d)
  }
  return gaps.length ? round3(median(gaps)) : null
}

export interface StoredRowSummary extends StoredSummary { resolution_s: number | null }

// Clearly finer = at most two-thirds of the stored interval (1 s vs 6 s, not 5.8 vs 6).
const FINER = 0.67

// Does a new computation at `incomingRes` seconds replace the stored row? Out-of-date
// rows are always replaced; a current row only by clearly finer data, so the cloud's
// 6 s copy never overwrites stats computed from the full log.
export function shouldReplace(
  existing: StoredRowSummary | null | undefined,
  incomingRes: number | null,
  now: { polarId: string | null; sessionUpdatedAt: string | null }
): boolean {
  if (!existing || !statsAreCurrent(existing, now)) return true
  if (existing.resolution_s == null) return incomingRes != null
  return incomingRes != null && incomingRes <= existing.resolution_s * FINER
}

// Should the charts use the stored stats instead of computing from the log on this
// device? Only when stored came from clearly finer data with the same polar.
export function preferStored(
  stored: { stats_version: number; polar_id: string | null; resolution_s: number | null } | null | undefined,
  localRes: number | null,
  polarId: string | null
): boolean {
  if (!stored || stored.stats_version !== STATS_VERSION || stored.resolution_s == null) return false
  if ((stored.polar_id ?? null) !== (polarId ?? null)) return false
  return localRes == null || stored.resolution_s <= localRes * FINER
}

export interface SeasonRow { date: string; phases: StoredPhase[] }
export interface CurvePoint { x: number; y: number; n: number }
export type ModeCurves = Partial<Record<Mode, Record<string, CurvePoint[]>>>

export interface SeasonCurvesResult {
  curves: Record<string, ModeCurves>              // season ("2026") → mode → channel → points
  sessions: Record<string, number>                // season → sessions that contributed
  phases: Record<string, number>                  // season → phases that contributed
}

export interface SeasonCurveOpts {
  binWidth?: number    // kn, bins centred on multiples of it (default 1)
  minPhases?: number   // a bin needs at least this many phases (default 4)
  exclude?: string[]   // dates left out — e.g. the session being judged
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function seasonCurves(rows: SeasonRow[], opts: SeasonCurveOpts = {}): SeasonCurvesResult {
  const width = opts.binWidth ?? 1
  const minPhases = opts.minPhases ?? 4
  const exclude = new Set(opts.exclude || [])
  const keys = CHANNELS.map(c => c.key).filter(k => k !== 'tws')

  // season → mode → bin centre → channel → values
  const acc = new Map<string, Map<Mode, Map<number, Map<string, number[]>>>>()
  const sessions: Record<string, number> = {}
  const phases: Record<string, number> = {}

  for (const row of rows) {
    if (exclude.has(row.date) || !row.phases?.length) continue
    const season = row.date.slice(0, 4)
    sessions[season] = (sessions[season] || 0) + 1
    for (const p of row.phases) {
      const tws = p.v?.tws
      if (tws == null || !Number.isFinite(tws)) continue
      phases[season] = (phases[season] || 0) + 1
      const bin = Math.round(tws / width) * width
      if (!acc.has(season)) acc.set(season, new Map())
      const byMode = acc.get(season)!
      if (!byMode.has(p.m)) byMode.set(p.m, new Map())
      const byBin = byMode.get(p.m)!
      if (!byBin.has(bin)) byBin.set(bin, new Map())
      const byKey = byBin.get(bin)!
      for (const k of keys) {
        const x = p.v[k]
        if (x == null || !Number.isFinite(x)) continue
        if (!byKey.has(k)) byKey.set(k, [])
        byKey.get(k)!.push(x)
      }
    }
  }

  const curves: Record<string, ModeCurves> = {}
  for (const [season, byMode] of Array.from(acc.entries())) {
    curves[season] = {}
    for (const [mode, byBin] of Array.from(byMode.entries())) {
      const out: Record<string, CurvePoint[]> = {}
      for (const [bin, byKey] of Array.from(byBin.entries()).sort((a, b) => a[0] - b[0])) {
        for (const [k, xs] of Array.from(byKey.entries())) {
          if (xs.length < minPhases) continue
          ;(out[k] ||= []).push({ x: bin, y: round3(median(xs)), n: xs.length })
        }
      }
      curves[season][mode] = out
    }
  }
  return { curves, sessions, phases }
}
