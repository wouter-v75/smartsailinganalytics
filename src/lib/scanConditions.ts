// src/lib/scanConditions.ts
// ─────────────────────────────────────────────────────────────────────────────
// Compute the boat state around a SailScan capture: a ±window average and a
// downsampled time series from the day's log, centred on the scan's UTC time.
// Pure — the API route supplies the log rows and the capture instant.
//
// Averaged fields: TWS, TWA, AWS, AWA, PolarBSP%, Forestay, Rake, JibTackLoad,
// CunninghamLoad. Graphed fields: TWS, TWA, AWS, AWA, PolarBSP%.
// ─────────────────────────────────────────────────────────────────────────────

export interface LogRowLike {
  utc: number
  tws?: number | null
  twa?: number | null
  aws?: number | null
  awa?: number | null
  polarBspPct?: number | null
  forestay?: number | null
  rake?: number | null
  jibTackLoad?: number | null
  cunninghamLoad?: number | null
  // flat-CSV logs expose polar % under a different key
  vsPerfPct?: number | null
}

const AVG_FIELDS = ['tws', 'twa', 'aws', 'awa', 'polarBspPct', 'forestay', 'rake', 'jibTackLoad', 'cunninghamLoad'] as const
const SERIES_FIELDS = ['tws', 'twa', 'aws', 'awa', 'polarBspPct'] as const
type AvgField = (typeof AVG_FIELDS)[number]
type SeriesField = (typeof SERIES_FIELDS)[number]

export interface ScanWindow {
  centerUtc: number
  windowSec: number
  count: number
  averages: Record<AvgField, number | null>
  series: { utc: number[] } & Record<SeriesField, (number | null)[]>
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

// flat-CSV logs put polar% in vsPerfPct; raw logs in polarBspPct.
const polarOf = (r: LogRowLike): number | null =>
  r.polarBspPct != null ? r.polarBspPct : r.vsPerfPct != null ? r.vsPerfPct : null

export function computeScanWindow(
  rows: LogRowLike[],
  centerUtc: number,
  windowSec = 120,
  maxPoints = 60
): ScanWindow | null {
  if (!Array.isArray(rows) || !rows.length || !Number.isFinite(centerUtc)) return null
  const halfMs = (windowSec / 2) * 1000
  const win = rows.filter((r) => r && Number.isFinite(r.utc) && Math.abs(r.utc - centerUtc) <= halfMs)
  if (!win.length) return null

  const valOf = (r: LogRowLike, f: AvgField): number | null => (f === 'polarBspPct' ? polarOf(r) : (r as any)[f] ?? null)

  const averages = {} as Record<AvgField, number | null>
  for (const f of AVG_FIELDS) {
    averages[f] = mean(win.map((r) => valOf(r, f)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))
  }

  // Downsample evenly to <= maxPoints for the graphs.
  const stride = Math.max(1, Math.ceil(win.length / maxPoints))
  const pts = win.filter((_, i) => i % stride === 0)
  const series = { utc: pts.map((r) => r.utc) } as ScanWindow['series']
  for (const f of SERIES_FIELDS) {
    series[f] = pts.map((r) => {
      const v = valOf(r, f)
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    })
  }

  return { centerUtc, windowSec, count: win.length, averages, series }
}
