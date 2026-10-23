// Every observation source must actually reach the map.
//
// This has happened twice. The decluttering shipped with its lib, its tests and
// the marker changes but WITHOUT the component that called them — green build,
// unreachable code. Then frost and metoffice were wired into obsSources.ts, got
// polled and stored every fifteen minutes, and never once appeared on the map,
// because /api/obs keeps its own list of sources and nobody added them to it.
//
// Both were invisible to every other check: tests prove a function behaves,
// `tsc` proves it compiles, and neither proves anybody calls it.
//
// So: each name in SOURCE_NAMES must either be called by the live route, or be
// listed below WITH THE REASON it is only stored. Adding a source is then a
// choice you have to make in writing.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SOURCE_NAMES } from '../obsSources'

const ROUTE = join(process.cwd(), 'src/app/api/obs/route.ts')

// Sources the live map does NOT call directly. Each is served from
// wind_observations instead, which the poller fills.
const STORED_ONLY: Record<string, string> = {
  metoffice:
    'the free plan is 360 calls a day and one call returns 48 hourly rows, so ' +
    'letting every map view fetch it would spend the budget on panning. The ' +
    'poller takes it hourly and the map reads the stored result.',
}

describe('every observation source reaches the map', () => {
  const src = readFileSync(ROUTE, 'utf8')

  it('the route still declares its sources as a list', () => {
    // If this changes shape the checks below stop meaning anything.
    expect(src).toContain('const sources: Array<[string, Promise<WindObs[]>]>')
  })

  it('reads from the stored table, which is what the stored-only sources rely on', () => {
    expect(src).toContain("['stored'")
    expect(src).toContain('wind_observations')
  })

  for (const name of SOURCE_NAMES) {
    const why = STORED_ONLY[name]
    it(why ? `${name} — stored only: ${why}` : `${name} is called by the live route`, () => {
      if (why) {
        // Nothing to assert but the reason's existence; what matters is that
        // making a source stored-only requires writing down why.
        expect(typeof why).toBe('string')
        return
      }
      // The route labels each source with its own name in the list.
      expect(
        src.includes(`['${name}'`),
        `'${name}' is in SOURCE_NAMES but /api/obs never calls it — add it to the route, `
        + 'or list it in STORED_ONLY with the reason it is only polled.',
      ).toBe(true)
    })
  }
})
