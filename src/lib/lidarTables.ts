// src/lib/lidarTables.ts
// ─────────────────────────────────────────────────────────────────────────────
// The KND "Main Lidar" / "Jib Lidar" report tables from phase stats: measured sail
// shape (camber CA, draft DR, twist TW at 25 / 50 / 75 % height) against the targets
// logged beside it (T_MN_*, T_JIB_*, T_SPI_*).
//
// KND's filtering, reproduced:
//   • samples outside CA 0–20, DR 20–80, TW 0–60 are ignored before a phase is
//     averaged, min 5 valid samples            → phaseStats (lidar channel caps)
//   • a target below its floor (CA 3, DR 20, TW 2) means the target channel is not
//     tracking — that phase is dropped for that variable
//   • outliers removed by 1.5 × IQR on the per-phase gaps. KND's note says "gaps"; its
//     11 Sep Main + Jib tables are matched far better by the % gaps with QUARTILE.EXC
//     quartiles (n off by 21 phases over 18 rows, against 39 for raw gaps + QUARTILE.INC)
//   • fewer than 2 valid phases → blank / n/a
//   • % diff is the average of the per-phase % gaps, not the gap of the averages.
// ─────────────────────────────────────────────────────────────────────────────

import type { Mode, PhaseStat, Tack } from './phaseStats'
import { isMainsail } from './phaseStats'
import { median } from './seasonCurves'
import { activeSailsAt } from './scanEnrich'

export type LidarSail = 'mn' | 'jib' | 'spi'

export const LIDAR_SAILS: { sail: LidarSail; label: string }[] = [
  { sail: 'mn', label: 'Main' },
  { sail: 'jib', label: 'Jib' },
  { sail: 'spi', label: 'Spinnaker' },
]

export const LIDAR_VARS = [
  { v: 'Ca', short: 'CA', label: 'Camber', floor: 3 },
  { v: 'Dr', short: 'DR', label: 'Draft', floor: 20 },
  { v: 'Tw', short: 'TW', label: 'Twist', floor: 2 },
] as const
export type LidarVar = typeof LIDAR_VARS[number]
export const LIDAR_HEIGHTS = [25, 50, 75] as const

const up1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
export const measKey = (sail: LidarSail, v: string, h: number) => `${sail}${v}${h}`
export const targKey = (sail: LidarSail, v: string, h: number) => `t${up1(sail)}${v}${h}`

const phaseHasLidar = (p: PhaseStat, sail: LidarSail) =>
  LIDAR_VARS.some(({ v }) => LIDAR_HEIGHTS.some(h => p.mean[measKey(sail, v, h)] != null))

export function hasLidar(stats: PhaseStat[], sail: LidarSail): boolean {
  return stats.some(p => phaseHasLidar(p, sail))
}

// ── Sails ────────────────────────────────────────────────────────────────────
// Sail type of an inventory name: MAIN_B 2026 → main, A2+B / S2 / Code 0 → spinnaker,
// J4_A / genoa / staysail → jib.
export function sailKindOf(name: string): LidarSail {
  if (isMainsail(name)) return 'mn'
  if (/^\s*[AS]\d|\bcode\s*0\b|^\s*C0\b|\bFR0\b|\bMH0\b|gennaker|kite|spinn?aker/i.test(name)) return 'spi'
  return 'jib'
}

// The sail of one kind that was up in a phase, at its midpoint. Stored phases carry no sail
// list, so the event file answers for them.
export function phaseSailName(p: PhaseStat, kind: LidarSail, xml?: any): string | null {
  const up: string[] = p.sails?.length ? p.sails : xml ? activeSailsAt(xml, (p.utc + p.endUtc) / 2) : []
  return up.find(s => sailKindOf(s) === kind)?.trim() ?? null
}

// The sails of one kind in use while `lidarSail` shape was captured, with their phase counts.
export function lidarSailOptions(stats: PhaseStat[], kind: LidarSail, xml: any, lidarSail: LidarSail): { name: string; n: number }[] {
  const counts = new Map<string, number>()
  for (const p of stats) {
    if (!phaseHasLidar(p, lidarSail)) continue
    const name = phaseSailName(p, kind, xml)
    if (name) counts.set(name, (counts.get(name) || 0) + 1)
  }
  return Array.from(counts, ([name, n]) => ({ name, n })).sort((a, b) => a.name.localeCompare(b.name))
}

export interface LidarGap { phase: PhaseStat; meas: number; tgt: number; gap: number; pct: number }

// Quantile of sorted values at rank (n + 1)·p, clamped to the ends (Excel QUARTILE.EXC).
function quantile(sorted: number[], p: number): number {
  const i = Math.min(Math.max((sorted.length + 1) * p - 1, 0), sorted.length - 1)
  const lo = Math.floor(i), hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

export function lidarGaps(stats: PhaseStat[], sail: LidarSail, variable: LidarVar, h: number): { valid: LidarGap[]; dropped: number } {
  const cand: LidarGap[] = []
  for (const p of stats) {
    const meas = p.mean[measKey(sail, variable.v, h)]
    const tgt = p.mean[targKey(sail, variable.v, h)]
    if (meas == null || tgt == null || tgt < variable.floor) continue
    cand.push({ phase: p, meas, tgt, gap: meas - tgt, pct: (100 * (meas - tgt)) / tgt })
  }
  let valid = cand
  if (cand.length >= 4) {
    const g = cand.map(c => c.pct).sort((a, b) => a - b)
    const q1 = quantile(g, 0.25), q3 = quantile(g, 0.75), iqr = q3 - q1
    valid = cand.filter(c => c.pct >= q1 - 1.5 * iqr && c.pct <= q3 + 1.5 * iqr)
  }
  return { valid, dropped: stats.length - valid.length }
}

export type LidarFormat = 'text' | 'int' | 'num1' | 'pct1' | 'time'
export interface LidarTable {
  id: string
  title: string
  columns: { label: string; format: LidarFormat }[]
  rows: (string | number | null)[][]
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10)

const MODES: [Mode, string][] = [['up', 'Upwind'], ['down', 'Downwind'], ['reach', 'Reaching']]
const TACKS: [Tack, string][] = [['stbd', 'Stbd'], ['port', 'Port']]

export interface LidarTableOpts {
  xml?: any                                            // event file: which sails were up (stored phases carry none)
  filter?: Partial<Record<LidarSail, string | null>>   // only the phases with these sails up
}

const SAIL_LABEL: Record<LidarSail, string> = { mn: 'Main', jib: 'Jib', spi: 'Spinnaker' }

export function lidarTables(allStats: PhaseStat[], sail: LidarSail, opts: LidarTableOpts = {}): LidarTable[] {
  const nameOf = (p: PhaseStat, kind: LidarSail = sail) => phaseSailName(p, kind, opts.xml)
  const picks = (Object.entries(opts.filter || {}) as [LidarSail, string | null][]).filter(([, name]) => !!name)
  const stats = picks.length ? allStats.filter(p => picks.every(([kind, name]) => nameOf(p, kind) === name)) : allStats
  const vars = LIDAR_VARS.flatMap(variable => LIDAR_HEIGHTS.map(h => ({ variable, h, ...lidarGaps(stats, sail, variable, h) })))
  const lidarPhases = stats.filter(p => phaseHasLidar(p, sail))
  const names = Array.from(new Set(lidarPhases.map(p => nameOf(p)))).sort((a, b) => (a ?? '').localeCompare(b ?? ''))
  const modeLabel = Object.fromEntries(MODES) as Record<Mode, string>
  const tackLabel = Object.fromEntries(TACKS) as Record<Tack, string>
  const shapeColumns = vars.flatMap(({ variable, h }) => [
    { label: `${variable.short}${h}`, format: 'num1' as const },
    { label: `d${variable.short}${h}`, format: 'num1' as const },
  ])

  // 1. Measured vs target by mode, tack and sail — groups of fewer than 2 lidar phases get no row.
  const byModeTack: LidarTable = {
    id: `lidar-${sail}-mode-tack`,
    title: '1. Measured vs target by mode and tack',
    columns: [
      { label: 'Mode', format: 'text' }, { label: 'Tack', format: 'text' }, { label: 'Sail', format: 'text' }, { label: 'n', format: 'int' },
      ...shapeColumns,
    ],
    rows: MODES.flatMap(([mode, mLabel]) => TACKS.flatMap(([tack, tLabel]) => names.flatMap(name => {
      const inGroup = (p: PhaseStat) => p.mode === mode && p.tack === tack && nameOf(p) === name
      const n = lidarPhases.filter(inGroup).length
      if (n < 2) return []
      return [[mLabel, tLabel, name ?? '—', n, ...vars.flatMap(({ valid }) => {
        const g = valid.filter(x => inGroup(x.phase))
        return g.length < 2 ? [null, null] : [r1(mean(g.map(x => x.meas))), r1(mean(g.map(x => x.gap)))]
      })]]
    }))),
  }

  // 2. Overall % difference vs target (all phases).
  const known = names.filter((n): n is string => !!n)
  const overall: LidarTable = {
    id: `lidar-${sail}-overall`,
    title: `2. Overall % difference vs target (all phases${known.length ? ` · ${known.join(', ')}` : ''})`,
    columns: [
      { label: 'Variable', format: 'text' }, { label: 'Avg Meas', format: 'num1' }, { label: 'Avg Tgt', format: 'num1' },
      { label: '% Diff', format: 'pct1' }, { label: 'Median %', format: 'pct1' }, { label: 'n', format: 'int' }, { label: 'Dropped', format: 'int' },
    ],
    rows: vars.map(({ variable, h, valid, dropped }) => {
      const ok = valid.length >= 2
      return [
        `${variable.label} ${h}%`,
        ok ? r1(mean(valid.map(x => x.meas))) : null,
        ok ? r1(mean(valid.map(x => x.tgt))) : null,
        ok ? r1(mean(valid.map(x => x.pct))) : null,
        ok ? r1(median(valid.map(x => x.pct))) : null,
        valid.length,
        dropped,
      ]
    }),
  }

  // 3. % difference vs target by point of sail.
  const modeCount = (m: Mode) => stats.filter(p => p.mode === m).length
  const byPointOfSail: LidarTable = {
    id: `lidar-${sail}-point-of-sail`,
    title: '3. % difference vs target by point of sail',
    columns: [
      { label: 'Variable', format: 'text' },
      ...MODES.map(([m, label]) => ({ label: `${label} (n=${modeCount(m)})`, format: 'pct1' as const })),
    ],
    rows: vars.map(({ variable, h, valid }) => [
      `${variable.label} ${h}%`,
      ...MODES.map(([m]) => {
        const g = valid.filter(x => x.phase.mode === m)
        return g.length < 2 ? null : r1(mean(g.map(x => x.pct)))
      }),
    ]),
  }

  // 4. Every lidar phase, tagged with the sails that were up.
  const kinds = (['mn', 'jib', 'spi'] as LidarSail[]).filter(k => k !== 'spi' || lidarPhases.some(p => nameOf(p, 'spi')))
  const gapBy = vars.map(({ valid }) => new Map(valid.map(g => [g.phase.utc, g])))
  const everyPhase: LidarTable = {
    id: `lidar-${sail}-phases`,
    title: '4. Every lidar phase — measured and gap to target (blank gap = phase dropped by the filters)',
    columns: [
      { label: 'Time', format: 'time' },
      ...kinds.map(k => ({ label: SAIL_LABEL[k], format: 'text' as const })),
      { label: 'Mode', format: 'text' }, { label: 'Tack', format: 'text' },
      ...shapeColumns,
    ],
    rows: lidarPhases.map(p => [
      p.utc,
      ...kinds.map(k => nameOf(p, k) ?? '—'),
      modeLabel[p.mode] ?? p.mode, tackLabel[p.tack] ?? p.tack,
      ...vars.flatMap(({ variable, h }, i) => {
        const g = gapBy[i].get(p.utc)
        return g ? [r1(g.meas), r1(g.gap)] : [r1(p.mean[measKey(sail, variable.v, h)] ?? null), null]
      }),
    ]),
  }

  return [byModeTack, overall, byPointOfSail, everyPhase]
}

export function formatLidarCell(v: string | number | null, format: LidarFormat, blank = '', tzOffsetMin = 0): string {
  if (v == null) return format === 'pct1' ? 'n/a' : blank
  if (format === 'time') return typeof v === 'number' ? new Date(v + tzOffsetMin * 60_000).toISOString().slice(11, 19) : String(v)
  if (typeof v === 'string') return v
  if (format === 'int') return String(v)
  const s = v.toFixed(1).replace(/^-(0\.0)$/, '$1')
  return format === 'pct1' ? `${v > 0 ? '+' : ''}${s}%` : s
}

export function lidarTableToTsv(t: LidarTable, tzOffsetMin = 0): string {
  return [t.columns.map(c => c.label), ...t.rows.map(r => r.map((v, i) => formatLidarCell(v, t.columns[i].format, '', tzOffsetMin)))]
    .map(l => l.join('\t')).join('\n')
}
