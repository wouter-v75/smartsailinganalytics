// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { parseLog } from '../logParse'
import { startAnalyses } from '../startAnalysis'

// Opt-in: the 11 Sep 2026 full log and session (client data, gitignored fixtures/local/), checked
// against KND's Starts tab readout for Prestart 5 at −5:00: BSP 16.52, BSP_trg% 87.8, TWA −119.5,
// ΔTwaTrg −28.7, RUDDER 7.1 · header: Sails J4_A 2026.
const DIR = process.env.SSA_PERF_FIXTURE_DIR || resolve(process.cwd(), 'fixtures/local')
const LOG = resolve(DIR, 'log-lidar-20260911.csv')
const SESSION = resolve(DIR, 'session-2026-09-11.json')
const run = existsSync(LOG) && existsSync(SESSION) ? describe : describe.skip

run('starts vs KND, 11 Sep 2026', () => {
  const load = () => {
    const s = JSON.parse(readFileSync(SESSION, 'utf8'))
    const xml = s.xmlData || s.xml || s.xml_data
    return startAnalyses(parseLog(readFileSync(LOG, 'utf8')).rows, xml, null)
  }

  it('Race 5 at −5:00 reads like KND, within a few seconds of sampling', () => {
    const [race5, race6] = load()
    expect([race5.raceNum, race6.raceNum]).toEqual([5, 6])
    expect(race5.sails).toBe('J4_A 2026')
    const s = race5.samples.find(x => x.t === -300)!
    expect(s.bsp!).toBeCloseTo(16.52, 0)
    expect(Math.abs(s.bspTrgPct! - 87.8)).toBeLessThan(1)
    expect(Math.abs(s.twa! - -119.5)).toBeLessThan(5)
    expect(Math.abs(s.dTwaTrg! - -28.7)).toBeLessThan(5)
    expect(Math.abs(s.rudder! - 7.1)).toBeLessThan(2)
  })

  it('has the burn and distance to line at the gun, and a track from the full log', () => {
    const [race5] = load()
    expect(race5.atGun!.distLn!).toBeCloseTo(1.3, 0)
    expect(race5.atGun!.burn!).toBeLessThan(0)            // late at the gun
    expect(race5.track!.length).toBeGreaterThan(60)
    expect(race5.line!.gunAlongPct).not.toBeNull()
    expect(race5.rowSpacingS).toBeLessThanOrEqual(1.1)
  })
})
