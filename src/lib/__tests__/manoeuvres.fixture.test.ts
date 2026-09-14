// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { analyseManoeuvres, isJudged, type Manoeuvre } from '../manoeuvres'

// Opt-in check against the KND "Points of interest" tables for 2026-09-11 (Northstar 76),
// using the gitignored cloud session in fixtures/local/ (see phaseStats.fixture.test.ts).
const DIR = process.env.SSA_PERF_FIXTURE_DIR || resolve(process.cwd(), 'fixtures/local')
const SESSION = resolve(DIR, 'session-2026-09-11.json')
const run = existsSync(SESSION) ? describe : describe.skip

// time, t95 (s), dist lost wind (m), max rotation (deg/s), BSP before, BSP after, turn (deg), source
type Row = [string, number | null, number | null, number | null, number | null, number | null, number | null, 'exp' | '1hz' | 'gap']
const KND_TACKS: Row[] = [
  ['12:23:19', 26, 18, 9, 11.45, 9.86, 81.1, '1hz'],
  ['12:24:10', 21, null, 8.4, 11.1, 10.76, 93.2, '1hz'],   // short hitch
  ['12:26:01', null, 25.9, 7.6, 12.59, 10.02, 71.5, '1hz'],
  ['12:28:08', 27, 16.8, 9.3, 11.72, 10.18, 74.5, '1hz'],
  ['12:30:47', 27, -4.7, 8.2, 11.95, 10.39, 81.6, 'exp'],
  ['12:51:16', 28, 10.3, 9.6, 11.33, 9.39, 66.7, '1hz'],
  ['12:52:02', null, null, null, null, null, null, 'gap'],   // KND: "in 90 s log gap"
  ['12:58:42', 34, 1.2, 8.7, 11.48, 9.3, 71.3, 'exp'],
  ['13:08:51', 28, null, 8.1, 12.36, 10.52, 80, '1hz'],     // into mark
  ['14:06:40', 25, 18.4, 9.8, 11.8, 10.72, 75.5, 'exp'],
  ['14:17:57', 22, 30.6, 10.1, 11.46, 10.84, 77.2, '1hz'],
  ['14:36:44', 33, 67, 9, 11.89, 9.43, 83.6, 'exp'],
  ['14:46:21', 40, 25.3, 9.6, 11.74, 10.36, 73.3, '1hz'],
]
const KND_GYBES: Row[] = [
  ['12:44:25', 31, 22.2, 4, 21.38, 15.98, 58, 'exp'],
  ['13:13:49', 45, 170, 4.5, 20.93, 13.42, 58.5, 'exp'],
  ['13:19:19', 32, 64.7, 3.8, 21.97, 16.26, 59.5, '1hz'],
  ['14:24:54', 39, 36.8, 3.6, 22.05, 15.35, 54.3, 'exp'],
  ['14:52:27', 38, 135.9, 4.5, 22.6, 15.54, 59.4, '1hz'],
]

run('manoeuvres vs KND points of interest, 2026-09-11', () => {
  let cache: { list: Manoeuvre[]; local: (u: number) => string } | null = null
  const load = () => {
    if (cache) return cache
    const s = JSON.parse(readFileSync(SESSION, 'utf8'))
    const tz = (s.tz_offset_minutes ?? 0) * 60_000
    cache = { list: analyseManoeuvres(s.log_data.rows, s.xml_data), local: u => new Date(u + tz).toISOString().slice(11, 19) }
    return cache
  }

  it('judges exactly KND’s 13 racing tacks and 5 racing gybes', () => {
    const { list, local } = load()
    const judged = list.filter(isJudged)
    expect(judged.filter(m => m.kind === 'tack').map(m => local(m.utc))).toEqual(KND_TACKS.map(r => r[0]))
    expect(judged.filter(m => m.kind === 'gybe').map(m => local(m.utc))).toEqual(KND_GYBES.map(r => r[0]))
    // the event file's other entries are the pre-start, the mark roundings and between-race tacks
    expect(list.filter(m => m.atMark).map(m => local(m.utc))).toEqual(expect.arrayContaining(['12:39:10', '12:49:20', '14:29:37']))
  })

  it('reads the tack directions and flags KND’s n/a rows the same way', () => {
    const { list, local } = load()
    const at = (t: string) => list.find(m => local(m.utc) === t)!
    expect([at('12:23:19').from, at('12:23:19').to]).toEqual(['stbd', 'port'])
    expect([at('13:19:19').from, at('13:19:19').to]).toEqual(['port', 'stbd'])
    expect(at('12:24:10').shortHitch).toBe(true)
    expect(at('12:24:10').distLost).toBeNull()
    expect(at('13:08:51').intoMark).toBe(true)
    expect(at('13:08:51').distLost).toBeNull()
  })

  for (const [kind, table] of [['tack', KND_TACKS], ['gybe', KND_GYBES]] as const) {
    it(`measures each ${kind} close to KND`, () => {
      const { list, local } = load()
      const distErr: number[] = []
      for (const [t, t95, dist, rot, before, after, turn, src] of table) {
        if (src === 'gap') continue
        const m = list.find(x => local(x.utc) === t)!
        const label = (what: string, got: number | null, want: number) => `${kind} ${t} ${what}: ${got} vs KND ${want}`
        if (before != null) expect(Math.abs(m.bspBefore! - before), label('BSP before', m.bspBefore, before)).toBeLessThanOrEqual(0.2)
        if (after != null) expect(Math.abs(m.bspAfter! - after), label('BSP after', m.bspAfter, after)).toBeLessThanOrEqual(0.9)
        if (turn != null) expect(Math.abs(m.turnAngle! - turn), label('turn', m.turnAngle, turn)).toBeLessThanOrEqual(6)
        if (t95 != null) expect(Math.abs(m.timeTo95! - t95), label('time to 95 %', m.timeTo95, t95)).toBeLessThanOrEqual(6)
        if (rot != null) {
          // one sample every ~6 s can only under-read the fastest turn
          expect(m.maxRotation!, label('max rotation', m.maxRotation, rot)).toBeLessThanOrEqual(rot + 0.5)
          expect(m.maxRotation!, label('max rotation', m.maxRotation, rot)).toBeGreaterThanOrEqual(rot - 3.5)
        }
        if (src === '1hz' && dist != null && m.distLost != null) distErr.push(Math.abs(m.distLost - dist))
      }
      // distance lost only against KND's own 1 Hz rebuild (its export rows use another method).
      // KND has six such tacks; 12:51:16's −35…+60 s window runs into the cloud log's gap before
      // 12:52, so ours is n/a there and five remain.
      if (kind === 'tack') {
        expect(distErr.length).toBe(5)
        expect(distErr.reduce((a, b) => a + b, 0) / distErr.length).toBeLessThanOrEqual(10)
      }
    })
  }
})
