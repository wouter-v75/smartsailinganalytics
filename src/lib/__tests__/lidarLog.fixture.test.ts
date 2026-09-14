// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { parseLog } from '../logParse'

// Opt-in: the first 5 rows of the Northstar 76 4 Hz log of 2026-09-12 (client data, kept in
// the gitignored fixtures/local/). Checks the real cells land on the right keys.
const FILE = resolve(process.env.SSA_PERF_FIXTURE_DIR || resolve(process.cwd(), 'fixtures/local'), 'log-4hz-sample-20260912.csv')
const run = existsSync(FILE) ? describe : describe.skip

run('4 Hz log sample, 2026-09-12', () => {
  const load = () => parseLog(readFileSync(FILE, 'utf8'))

  it('parses 5 rows at 4 Hz', () => {
    const p = load()
    expect(p.format).toBe('flat-ole')
    expect(p.rows).toHaveLength(5)
    expect(new Date(p.rows[0].utc).toISOString()).toBe('2026-09-12T10:10:00.872Z')
  })

  it('reads the main and jib stripes and their targets', () => {
    const r = load().rows[0]
    const want: Record<string, number> = {
      mnCa25: 11.6, mnTw25: 15.41, mnDr25: 42.2, mnCa50: 11.3, mnTw50: 29.93, mnDr50: 51, mnCa75: 5.9, mnTw75: 39.22, mnDr75: 53,
      jibCa25: 17.2, jibTw25: 20.1, jibDr25: 64.3, jibCa50: 2.6, jibTw50: 31.67, jibDr50: 46.3, jibCa75: 14.4, jibTw75: -3.14, jibDr75: 76,
      tMnCa25: 7.5839, tMnTw25: 3.0392, tMnDr25: 43.8298, tMnTr25: -11.8444, tMnCa75: 8.5253,
      tJibCa25: 10.8585, tJibTw25: 5.451, tJibDr25: 28.5226, tJibDr75: 35.767, tSpiCa25: 10.9005,
      bobstay: 0.0097,
    }
    for (const [k, v] of Object.entries(want)) expect(r[k], k).toBeCloseTo(v, 3)
    expect(r.spiCa25).toBeUndefined()   // no spinnaker up
  })
})
