// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { computePhaseStats, groupPhases, sailComboLabel, bandOf, type PhaseStat } from '../phaseStats'
import { readXlsx } from '../xlsxRead'
import { parsePolarWorkbook, buildPolarData, polarFromData } from '../polarFile'
import { twsBands } from '../phasePlot'
import { REPORTS, buildTable } from '../reportTables'

// Opt-in acceptance check against a REAL day: the Northstar 76 cloud session for
// 2026-09-11 (Maxi Worlds races 5&6) and KND SailingPerf's Phase report for the
// same day. Both are client data, so they live in the gitignored fixtures/local/
// (or point SSA_PERF_FIXTURE_DIR elsewhere):
//   session-2026-09-11.json          { log_data, xml_data, tz_offset_minutes }
//   knd-phase-report-2026-09-11.csv  the report's single sheet, as CSV
const DIR = process.env.SSA_PERF_FIXTURE_DIR || resolve(process.cwd(), 'fixtures/local')
const SESSION = resolve(DIR, 'session-2026-09-11.json')
const REPORT = resolve(DIR, 'knd-phase-report-2026-09-11.csv')
//   ns76-polar-history.xlsx          the boat's polar workbook (KND used v1.6 that day)
const WORKBOOK = resolve(DIR, 'ns76-polar-history.xlsx')
const run = existsSync(SESSION) && existsSync(REPORT) ? describe : describe.skip

interface KndPhase {
  time: string; mode: string; tack: string; sails: string
  vmgPct: number; bspPol: number
  tws: number; bsp: number; twa: number; awa: number; trim: number; heel: number
  rudder: number; fsty: number; v1lwd: number; v1wwd: number; mainsheet: number; upDflct: number
}

const MODE: Record<string, string> = { Upwind: 'up', Downwind: 'down', Reaching: 'reach' }

function parseReport(csv: string): KndPhase[] {
  const out: KndPhase[] = []
  let mode = ''
  for (const line of csv.split(/\r?\n/)) {
    const section = line.match(/^(Upwind|Downwind|Reaching) - /)
    if (section) { mode = MODE[section[1]]; continue }
    if (!line.startsWith('Northstar 76,')) continue
    const c = line.split(',')
    const n = (i: number) => Number(c[i])
    out.push({
      time: c[1], mode, tack: c[4] === 'S' ? 'stbd' : 'port', sails: c[3],
      vmgPct: n(10), bspPol: n(11),
      tws: n(6), bsp: n(7), twa: n(8), awa: n(9), trim: n(12), heel: n(13),
      rudder: n(14), fsty: n(15), v1lwd: n(21), v1wwd: n(23), mainsheet: n(25), upDflct: n(27),
    })
  }
  return out
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

run('phaseStats vs KND phase report, 2026-09-11', () => {
  // Read lazily: vitest evaluates a skipped describe body at collection time.
  let cache: { stats: PhaseStat[]; knd: KndPhase[]; local: (utc: number) => string } | null = null
  const load = () => {
    if (cache) return cache
    const s = JSON.parse(readFileSync(SESSION, 'utf8'))
    const tz = (s.tz_offset_minutes ?? 0) * 60_000
    cache = {
      stats: computePhaseStats(s.log_data.rows, s.xml_data),
      knd: parseReport(readFileSync(REPORT, 'utf8')),
      local: utc => new Date(utc + tz).toISOString().slice(11, 19),
    }
    return cache
  }

  it('finds every report phase with the same mode, tack and sails', () => {
    const { stats, knd, local } = load()
    expect(knd).toHaveLength(139)
    expect(stats).toHaveLength(139)
    const byTime = new Map(stats.map(s => [local(s.utc), s]))
    for (const k of knd) {
      const s = byTime.get(k.time)
      expect(s, k.time).toBeDefined()
      expect([s!.mode, s!.tack], k.time).toEqual([k.mode, k.tack])
      expect(s!.sailCombo, k.time).toBe(sailComboLabel(k.sails.split('/')))
    }
  })

  // The cloud log is ~6 s between rows (5 per phase) where KND reads 1 Hz, so single
  // phases scatter; the group means over 22–50 phases must still agree.
  const TOL: Record<string, number> = {
    tws: 0.2, bsp: 0.05, twa: 0.5, awa: 0.5, heel: 0.5, trim: 0.1,
    fsty: 0.05, rudder: 0.3, v1lwd: 0.1, v1wwd: 0.1, mainsheet: 0.15, upDflct: 1,
  }

  it('matches the group means by mode and tack', () => {
    const { stats, knd } = load()
    for (const g of groupPhases(stats, ['mode', 'tack'])) {
      const ref = knd.filter(k => k.mode === g.key.mode && k.tack === g.key.tack)
      expect(g.n, `${g.key.mode} ${g.key.tack}`).toBe(ref.length)
      if (ref.length < 5) continue
      for (const [key, tol] of Object.entries(TOL)) {
        const want = mean(ref.map(r => (r as any)[key]))
        const got = g.mean[key]
        expect(Math.abs((got ?? NaN) - want), `${g.key.mode} ${g.key.tack} ${key}: ${got} vs ${want}`).toBeLessThanOrEqual(tol)
      }
    }
  })

  it('keeps single phases close to the report', () => {
    const { stats, knd, local } = load()
    const byTime = new Map(stats.map(s => [local(s.utc), s]))
    const d = (key: 'bsp' | 'tws' | 'twa') => median(knd.map(k => Math.abs((byTime.get(k.time)!.mean[key] ?? NaN) - k[key])))
    expect(d('bsp')).toBeLessThan(0.15)
    expect(d('tws')).toBeLessThan(0.5)
    expect(d('twa')).toBeLessThan(1)
  })

  // The band tables of the KND Upwind / Downwind reports for this day.
  const count = (vals: number[], edges: number[]) => {
    const out: Record<string, number> = {}
    for (const v of vals) { const b = bandOf(v, edges)!.label; out[b] = (out[b] || 0) + 1 }
    return out
  }
  const BAND_TABLES = [
    { title: 'upwind TWS band, port', mode: 'up', tack: 'port', key: 'twsBand', ch: 'tws', edges: [21, 23, 25],
      report: { 'under 21': 7, '21-23': 13, '23-25': 23, '25 plus': 7 } },
    { title: 'upwind TWS band, stbd', mode: 'up', tack: 'stbd', key: 'twsBand', ch: 'tws', edges: [21, 23, 25],
      report: { 'under 21': 2, '21-23': 13, '23-25': 14, '25 plus': 10 } },
    { title: 'upwind TWA band', mode: 'up', tack: null, key: 'twaBand', ch: 'twa', edges: [38, 40, 42, 44, 46],
      report: { 'under 38': 23, '38-40': 27, '40-42': 23, '42-44': 12, '44-46': 3, '46 plus': 1 } },
    { title: 'upwind heel band, port', mode: 'up', tack: 'port', key: 'heelBand', ch: 'heel', edges: [20, 22, 24, 26],
      report: { 'under 20': 6, '20-22': 23, '22-24': 14, '24-26': 7 } },
    { title: 'upwind heel band, stbd', mode: 'up', tack: 'stbd', key: 'heelBand', ch: 'heel', edges: [20, 22, 24, 26],
      report: { 'under 20': 1, '20-22': 14, '22-24': 17, '24-26': 6, '26 plus': 1 } },
    { title: 'downwind TWA band', mode: 'down', tack: null, key: 'twaBand', ch: 'twa', edges: [142, 146, 150, 154],
      report: { 'under 142': 7, '142-146': 15, '146-150': 22, '150-154': 5 } },
  ] as const

  it('band labels reproduce the KND report tables from its own phases', () => {
    const { knd } = load()
    for (const t of BAND_TABLES) {
      const ref = knd.filter(k => k.mode === t.mode && (!t.tack || k.tack === t.tack))
      expect(count(ref.map(k => k[t.ch]), [...t.edges]), t.title).toEqual(t.report)
    }
  })

  // Our per-phase TWA / heel come from 5 samples (6 s cloud log) against KND's 30 at
  // 1 Hz: median gap 0.2–0.3°, p90 0.5–0.8°. In 2° TWA bands that moves a few phases
  // over an edge (upwind 42-44: 8 vs 12), so exact counts are the wrong check —
  // each PHASE should land in the report's band. Measured 82–92 % per table.
  it('puts our phases in the same bands as the report', () => {
    const { stats, knd, local } = load()
    for (const t of BAND_TABLES) {
      const ref = knd.filter(k => k.mode === t.mode && (!t.tack || k.tack === t.tack))
      const sub = stats.filter(s => s.mode === t.mode && (!t.tack || s.tack === t.tack))
      const groups = groupPhases(sub, [t.key], { edges: { [t.ch]: [...t.edges] } })
      expect(groups.reduce((n, g) => n + g.n, 0), t.title).toBe(ref.length)
      const ourBand = new Map(groups.flatMap(g => g.phases.map(p => [local(p.utc), g.key[t.key]] as const)))
      const same = ref.filter(k => ourBand.get(k.time) === bandOf(k[t.ch], [...t.edges])!.label).length
      expect(same / ref.length, `${t.title}: ${same}/${ref.length} phases in the report's band`).toBeGreaterThanOrEqual(0.8)
    }
  })

  it('puts our phases in the same 2 kn wind bands as the report (speed vs TWA charts)', () => {
    const { stats, knd, local } = load()
    const ourCentre = new Map(twsBands(stats, 2, 1).flatMap(b => b.phases.map(p => [local(p.utc), b.centre] as const)))
    const same = knd.filter(k => ourCentre.get(k.time) === Math.round(k.tws / 2) * 2).length
    // measured: TWS per phase differs from KND by a median 0.07 kn
    expect(same / knd.length, `${same}/${knd.length} phases in KND's wind band`).toBeGreaterThanOrEqual(0.85)
  })

  it('splits the day into its two races', () => {
    const { stats } = load()
    const races = groupPhases(stats, ['race'])
    expect(races.map(r => r.key.race)).toEqual(['1', '2'])
    expect(races[0].n + races[1].n).toBe(139)
  })

  it('places automatic TWS band edges where the KND upwind report does (21 · 23 · 25)', () => {
    const { stats } = load()
    const up = stats.filter(s => s.mode === 'up')
    expect(groupPhases(up, ['twsBand']).map(g => g.key.twsBand)).toEqual(['under 21', '21-23', '23-25', '25 plus'])
  })

  // "Upwind / Downwind by sail combination and tack" from KND's Upwind + Downwind Report tabs.
  const KND_SAILS: Record<string, Record<string, number>> = {
    'up port': { n: 50, tws: 23.1, bsp: 11.88, twa: 39.7, awa: 26.4, bspPol: 98.2, vmgPct: 96, heel: 21.9, trim: -0.8, rudder: -0.7,
      fsty: 16.16, 'fsty max': 17.15, v1wwd: 9.13, 'v1wwd max': 10.6, v1lwd: 2.64, 'v1lwd max': 4, mainsheet: 2.27, upDflct: 95, lwDflct: 45, bspSog: 103.3 },
    'up stbd': { n: 39, tws: 23.7, bsp: 11.73, twa: 39.1, awa: 26.4, bspPol: 98, vmgPct: 95.5, heel: 22.4, trim: -0.8, rudder: 0.6,
      fsty: 16.2, 'fsty max': 17.22, v1wwd: 9.07, 'v1wwd max': 10.6, v1lwd: 2.56, 'v1lwd max': 3.8, mainsheet: 3.17, upDflct: 96, lwDflct: 45, bspSog: 98.5 },
    'down port': { n: 27, tws: 23.1, bsp: 21.47, twa: 146.2, awa: 80.1, bspPol: 97.6, vmgPct: 95.4, heel: 13.7, trim: 0, rudder: 3.1,
      fsty: 7.75, v1wwd: 11.97, 'v1wwd max': 13.9, v1lwd: 6.32, upDflct: 26, lwDflct: 45, bspSog: 98.3 },
    'down stbd': { n: 22, tws: 23.6, bsp: 21.47, twa: 146.2, awa: 82.3, bspPol: 96.5, vmgPct: 94.5, heel: 10.8, trim: 0.2, rudder: 2.8,
      fsty: 7.59, v1wwd: 11.27, 'v1wwd max': 12.7, v1lwd: 6.65, upDflct: 25, lwDflct: 45, bspSog: 97 },
  }
  // KND prints VMG% and the deflector columns to 0–1 decimals, hence the wider tolerances.
  const TABLE_TOL: Record<string, number> = {
    tws: 0.2, bsp: 0.05, twa: 0.5, awa: 0.5, bspPol: 0.5, vmgPct: 0.6, heel: 0.5, trim: 0.1, rudder: 0.3,
    fsty: 0.05, v1wwd: 0.1, v1lwd: 0.1, mainsheet: 0.15, upDflct: 1, lwDflct: 1, bspSog: 0.3,
  }

  it('builds the "by sail combination and tack" report tables to KND’s numbers', async () => {
    const s = JSON.parse(readFileSync(SESSION, 'utf8'))
    let polar: any = null
    if (existsSync(WORKBOOK)) {
      const v16 = parsePolarWorkbook(await readXlsx(readFileSync(WORKBOOK))).find(v => v.name === '37m-VPP-76 v1.6')
      polar = v16 ? polarFromData(buildPolarData(v16.entries, { name: v16.name })) : null
    }
    const stats = computePhaseStats(s.log_data.rows, s.xml_data, { polar })
    for (const [id, mode] of [['up-sails', 'up'], ['down-sails', 'down']] as const) {
      const spec = [...REPORTS.up, ...REPORTS.down].find(x => x.id === id)!
      const table = buildTable(stats, spec, { hasPolar: !!polar })
      // every KND column this boat logs is present (Bobstay and runners are not in the log)
      expect(table.columns.length, id).toBe((mode === 'up' ? 19 : 16) - (polar ? 0 : 1))
      expect(table.rows.map(r => r.key.tack), id).toEqual(['port', 'stbd'])
      for (const row of table.rows) {
        const ref = KND_SAILS[`${mode} ${row.key.tack}`]
        expect(row.n, `${id} ${row.key.tack} n`).toBe(ref.n)
        table.columns.forEach((c, i) => {
          const want = ref[c.stat === 'max' ? `${c.key} max` : c.key]
          const got = row.values[i]
          if (want == null) return
          const label = `${id} ${row.key.tack} ${c.label}: ${got} vs KND ${want}`
          expect(got, label).not.toBeNull()
          if (c.stat === 'max') {
            // a 6 s cloud log can only miss peaks, never invent them
            expect(got!, label).toBeLessThanOrEqual(want + 0.05)
            expect(got!, label).toBeGreaterThanOrEqual(want - 0.6)
          } else {
            expect(Math.abs(got! - want), label).toBeLessThanOrEqual(TABLE_TOL[c.key] ?? 0.1)
          }
        })
      }
    }
  })

  const withWorkbook = existsSync(WORKBOOK) ? it : it.skip
  withWorkbook('matches BSPpol% and VMG% with polar 37m-VPP-76 v1.6 from the workbook', async () => {
    const versions = parsePolarWorkbook(await readXlsx(readFileSync(WORKBOOK)))
    expect(versions.map(v => v.name)).toContain('37m-VPP-76 v1.6')
    const v16 = versions.find(v => v.name === '37m-VPP-76 v1.6')!
    const polar = polarFromData(buildPolarData(v16.entries, { name: v16.name }))

    const s = JSON.parse(readFileSync(SESSION, 'utf8'))
    const { knd } = load()
    for (const g of groupPhases(computePhaseStats(s.log_data.rows, s.xml_data, { polar }), ['mode', 'tack'])) {
      const ref = knd.filter(k => k.mode === g.key.mode && k.tack === g.key.tack)
      if (ref.length < 5) continue
      const label = `${g.key.mode} ${g.key.tack}`
      expect(Math.abs(g.mean.bspPol! - mean(ref.map(r => r.bspPol))), `${label} BSPpol% ${g.mean.bspPol}`).toBeLessThanOrEqual(0.5)
      expect(Math.abs(g.mean.vmgPct! - mean(ref.map(r => r.vmgPct))), `${label} VMG% ${g.mean.vmgPct}`).toBeLessThanOrEqual(0.5)
    }
  })
})
