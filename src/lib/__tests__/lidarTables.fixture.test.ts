// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { parseLog } from '../logParse'
import { computePhaseStats } from '../phaseStats'
import { lidarTables } from '../lidarTables'

// Opt-in: the 11 Sep 2026 log with lidar columns and its session row (client data, kept in the
// gitignored fixtures/local/), checked against KND's Main Lidar and Jib Lidar tabs for that day.
const DIR = process.env.SSA_PERF_FIXTURE_DIR || resolve(process.cwd(), 'fixtures/local')
const LOG = resolve(DIR, 'log-lidar-20260911.csv')
const SESSION = resolve(DIR, 'session-2026-09-11.json')
const run = existsSync(LOG) && existsSync(SESSION) ? describe : describe.skip

// KND "2. Overall % difference vs target": [Avg Meas, % Diff, n], CA/DR/TW × 25/50/75.
const KND = {
  mn: [[8.9, 107.5, 137], [9.3, 150.6, 74], [5.9, 36.9, 3], [47.3, -13.1, 139], [55.9, -5.0, 139], [49, -15.8, 129], [9.7, 74.8, 133], [19.2, 56.2, 136], [27, 43.9, 139]],
  jib: [[11.1, 173.7, 108], [10.9, 83.3, 122], [12.5, 114.6, 92], [37.3, 63.0, 139], [46.1, 68.7, 136], [54.8, 62.5, 118], [9.8, 17.3, 120], [21.4, 21.4, 126], [20.6, -8.7, 134]],
}

run('lidar tables vs KND, 11 Sep 2026', () => {
  const load = () => {
    const s = JSON.parse(readFileSync(SESSION, 'utf8'))
    const xml = s.xmlData || s.xml || s.xml_data
    return computePhaseStats(parseLog(readFileSync(LOG, 'utf8')).rows, xml)
  }

  it('main: mode × tack reads like KND (Upwind Stbd n 39, CA25 7.5, dCA25 3.1)', () => {
    const [byModeTack] = lidarTables(load(), 'mn')
    expect(byModeTack.rows[0].slice(0, 6)).toEqual(['Upwind', 'Stbd', 'MAIN_B 2026', 39, 7.5, 3.1])
    expect(byModeTack.rows.map(r => [r[0], r[1], r[2], r[3]])).toEqual([
      ['Upwind', 'Stbd', 'MAIN_B 2026', 39], ['Upwind', 'Port', 'MAIN_B 2026', 50],
      ['Downwind', 'Stbd', 'MAIN_B 2026', 22], ['Downwind', 'Port', 'MAIN_B 2026', 27],
    ])
  })

  // Not exact: KND keeps a few more or fewer phases on some rows (its sample alignment is not
  // published). Tolerances are the worst row today, so a change in the filters shows up.
  for (const sail of ['mn', 'jib'] as const) {
    it(`${sail}: overall table within a few phases of KND`, () => {
      const [, overall] = lidarTables(load(), sail)
      overall.rows.forEach((r, i) => {
        const [meas, pct, n] = KND[sail][i]
        expect(Math.abs((r[5] as number) - n), `${r[0]} n`).toBeLessThanOrEqual(6)
        expect(Math.abs((r[3] as number) - pct), `${r[0]} % diff`).toBeLessThanOrEqual(10.5)
        expect(Math.abs((r[1] as number) - meas), `${r[0]} avg meas`).toBeLessThanOrEqual(1.2)
      })
    })
  }
})
