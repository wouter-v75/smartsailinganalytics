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
import { median } from './seasonCurves'

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

export function hasLidar(stats: PhaseStat[], sail: LidarSail): boolean {
  return stats.some(p => LIDAR_VARS.some(({ v }) => LIDAR_HEIGHTS.some(h => p.mean[measKey(sail, v, h)] != null)))
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

export type LidarFormat = 'text' | 'int' | 'num1' | 'pct1'
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

export function lidarTables(stats: PhaseStat[], sail: LidarSail): LidarTable[] {
  const vars = LIDAR_VARS.flatMap(variable => LIDAR_HEIGHTS.map(h => ({ variable, h, ...lidarGaps(stats, sail, variable, h) })))

  // 1. Measured vs target by mode and tack — groups of fewer than 2 phases get no row.
  const byModeTack: LidarTable = {
    id: `lidar-${sail}-mode-tack`,
    title: '1. Measured vs target by mode and tack',
    columns: [
      { label: 'Mode', format: 'text' }, { label: 'Tack', format: 'text' }, { label: 'n', format: 'int' },
      ...vars.flatMap(({ variable, h }) => [
        { label: `${variable.short}${h}`, format: 'num1' as const },
        { label: `d${variable.short}${h}`, format: 'num1' as const },
      ]),
    ],
    rows: MODES.flatMap(([mode, modeLabel]) => TACKS.flatMap(([tack, tackLabel]) => {
      const n = stats.filter(p => p.mode === mode && p.tack === tack).length
      if (n < 2) return []
      return [[modeLabel, tackLabel, n, ...vars.flatMap(({ valid }) => {
        const g = valid.filter(x => x.phase.mode === mode && x.phase.tack === tack)
        return g.length < 2 ? [null, null] : [r1(mean(g.map(x => x.meas))), r1(mean(g.map(x => x.gap)))]
      })]]
    })),
  }

  // 2. Overall % difference vs target (all phases).
  const overall: LidarTable = {
    id: `lidar-${sail}-overall`,
    title: '2. Overall % difference vs target (all phases)',
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

  return [byModeTack, overall, byPointOfSail]
}

export function formatLidarCell(v: string | number | null, format: LidarFormat, blank = ''): string {
  if (v == null) return format === 'pct1' ? 'n/a' : blank
  if (typeof v === 'string') return v
  if (format === 'int') return String(v)
  const s = v.toFixed(1).replace(/^-(0\.0)$/, '$1')
  return format === 'pct1' ? `${v > 0 ? '+' : ''}${s}%` : s
}

export function lidarTableToTsv(t: LidarTable): string {
  return [t.columns.map(c => c.label), ...t.rows.map(r => r.map((v, i) => formatLidarCell(v, t.columns[i].format)))]
    .map(l => l.join('\t')).join('\n')
}
