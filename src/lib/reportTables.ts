// src/lib/reportTables.ts
// ─────────────────────────────────────────────────────────────────────────────
// The KND SailingPerf report tables (Upwind Report, Downwind Report, Loads) built
// from the session's phase averages: each table is a groupPhases() grouping
// (sails × tack, TWS / TWA / heel bands) with KND's columns, in KND's order.
// Values are means of the per-phase means; "max" columns are the highest sample in
// the group. Pure — the UI renders the result, tests compare it with the report.
// ─────────────────────────────────────────────────────────────────────────────

import { groupPhases, type GroupKey, type GroupOpts, type Mode, type PhaseStat } from './phaseStats'

export interface ReportColumn {
  key: string                 // CHANNELS key
  label: string               // KND header
  stat?: 'mean' | 'max'
  decimals: number
}

export interface ReportSpec {
  id: string
  title: string
  modes: Mode[]
  by: GroupKey[]
  columns: ReportColumn[]
}

const col = (key: string, label: string, decimals: number, stat: 'mean' | 'max' = 'mean'): ReportColumn =>
  ({ key, label, decimals, stat })

const TWS = col('tws', 'TWS (kn)', 1)
const BSP = col('bsp', 'BSP (kn)', 2)
const TWA = col('twa', 'TWA (deg)', 1)
const AWA = col('awa', 'AWA (deg)', 1)
const POL = col('bspPol', '%Pol', 1)
const VMG = col('vmgPct', 'VMG%', 1)
const HEEL = col('heel', 'Heel (deg)', 1)
const TRIM = col('trim', 'Trim (deg)', 1)
const RUD = col('rudder', 'Rud (deg)', 1)
const FSTY = col('fsty', 'Fsty (t)', 2)
const MAINSHEET = col('mainsheet', 'Mainsheet (t)', 2)
const UPD = col('upDflct', 'UpDfclt %', 0)
const LWD = col('lwDflct', 'LwDfclt %', 0)
const BSPSOG = col('bspSog', 'BSP/SOG %', 1)
const max = (key: string, label: string) => col(key, label, 2, 'max')

export const REPORTS: Record<'up' | 'down' | 'loads', ReportSpec[]> = {
  up: [
    {
      id: 'up-sails', title: 'Upwind by sail combination and tack', modes: ['up'], by: ['sailCombo', 'tack'],
      columns: [TWS, BSP, TWA, AWA, POL, VMG, HEEL, TRIM, RUD, FSTY, max('fsty', 'Fsty max (t)'),
        col('v1wwd', 'V1_WWD (t)', 2), max('v1wwd', 'V1_WWD max (t)'), col('v1lwd', 'V1_LWD (t)', 2), max('v1lwd', 'V1_LWD max (t)'),
        MAINSHEET, UPD, LWD, BSPSOG],
    },
    {
      id: 'up-tws', title: 'Wind-band matched, Port vs Stbd', modes: ['up'], by: ['twsBand', 'tack'],
      columns: [TWS, BSP, TWA, POL, VMG, HEEL, RUD],
    },
    {
      id: 'up-twa', title: 'VMG by TWA band (both tacks)', modes: ['up'], by: ['twaBand'],
      columns: [TWS, BSP, POL, VMG, HEEL],
    },
    {
      id: 'up-heel', title: 'VMG by heel band and tack', modes: ['up'], by: ['heelBand', 'tack'],
      columns: [TWS, TWA, POL, VMG],
    },
  ],
  down: [
    {
      id: 'down-sails', title: 'Downwind by sail combination and tack', modes: ['down'], by: ['sailCombo', 'tack'],
      columns: [TWS, BSP, TWA, AWA, POL, VMG, HEEL, TRIM, RUD, FSTY,
        col('v1wwd', 'V1_WWD (t)', 2), max('v1wwd', 'V1_WWD max (t)'), col('v1lwd', 'V1_LWD (t)', 2),
        UPD, LWD, BSPSOG],
    },
    {
      id: 'down-twa', title: 'VMG by TWA band', modes: ['down'], by: ['twaBand'],
      columns: [TWS, BSP, POL, VMG, HEEL],
    },
    {
      id: 'down-tws', title: 'Wind-band matched, Port vs Stbd', modes: ['down'], by: ['twsBand', 'tack'],
      columns: [TWS, BSP, TWA, POL, VMG, HEEL],
    },
  ],
  loads: [
    {
      id: 'loads', title: 'Loads by point of sail, sails and tack', modes: ['up', 'reach', 'down'], by: ['mode', 'sailCombo', 'tack'],
      columns: [TWS, BSP, TWA, AWA, VMG, POL, TRIM, HEEL, RUD, FSTY, max('fsty', 'Max Fsty'),
        max('v1wwd', 'Max V1_WWD'), max('v1lwd', 'Max V1_LWD'), max('jibTack', 'Max JibTack'),
        max('cunningham', 'Max Cunningham'), max('mainsheet', 'Max Mainsheet'), max('vang', 'Max Vang'),
        col('upDflct', 'Max UpDfclt%', 0, 'max'), col('lwDflct', 'Max LwDfclt%', 0, 'max')],
    },
  ],
}

export const GROUP_LABELS: Record<GroupKey, string> = {
  mode: 'Mode', tack: 'Tack', sailCombo: 'Sails', race: 'Race',
  twsBand: 'TWS band (kn)', twaBand: 'TWA band (deg)', heelBand: 'Heel band (deg)',
}

const MODE_LABELS: Record<string, string> = { up: 'Upwind', down: 'Downwind', reach: 'Reaching' }
const TACK_LABELS: Record<string, string> = { port: 'Port', stbd: 'Stbd' }

export function groupCellText(key: GroupKey, value: string | undefined): string {
  if (value == null) return ''
  if (key === 'tack') return TACK_LABELS[value] || value
  if (key === 'mode') return MODE_LABELS[value] || value
  return value
}

export interface ReportRow { key: Partial<Record<GroupKey, string>>; n: number; values: (number | null)[] }
export interface ReportTable {
  id: string
  title: string
  by: GroupKey[]
  columns: ReportColumn[]
  rows: ReportRow[]
  total: number   // phases of the table's points of sail
}

export interface BuildOpts extends GroupOpts {
  hasPolar?: boolean  // false → %Pol from the log's PolBsp% column, no VMG%
}

export function buildTable(stats: PhaseStat[], spec: ReportSpec, opts: BuildOpts = {}): ReportTable {
  const sub = stats.filter(s => spec.modes.includes(s.mode))
  const columns = opts.hasPolar === false
    ? spec.columns.filter(c => c.key !== 'vmgPct').map(c => (c.key === 'bspPol' ? { ...c, key: 'logPolPct', label: 'PolBsp% (log)' } : c))
    : spec.columns
  const rows: ReportRow[] = groupPhases(sub, spec.by, { edges: opts.edges }).map(g => ({
    key: g.key,
    n: g.n,
    values: columns.map(c => (c.stat === 'max' ? g.max : g.mean)[c.key] ?? null),
  }))
  // Columns with no value in any row (a channel this boat doesn't log) are dropped.
  const keep = columns.map((_, i) => rows.some(r => r.values[i] != null))
  return {
    id: spec.id,
    title: spec.title,
    by: spec.by,
    columns: columns.filter((_, i) => keep[i]),
    rows: rows.map(r => ({ ...r, values: r.values.filter((_, i) => keep[i]) })),
    total: sub.length,
  }
}

// "-0.0" (a trim of -0.02 rounded) reads as a sign the data doesn't have — print "0.0".
export const formatCell = (v: number | null, decimals: number) =>
  v == null ? '' : v.toFixed(decimals).replace(/^-(0(\.0+)?)$/, '$1')

// Tab-separated, header first — pastes straight into Excel / Sheets.
export function tableToTsv(t: ReportTable): string {
  const header = [...t.by.map(k => GROUP_LABELS[k]), 'n', ...t.columns.map(c => c.label)]
  const lines = t.rows.map(r => [
    ...t.by.map(k => groupCellText(k, r.key[k])), String(r.n), ...r.values.map((v, i) => formatCell(v, t.columns[i].decimals)),
  ])
  return [header, ...lines].map(l => l.join('\t')).join('\n')
}
