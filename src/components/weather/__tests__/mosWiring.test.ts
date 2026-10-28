import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain JS modules, no types
import { MODELS, COMPARE_ORDER, modelCoversPoint } from '../openMeteo'
// @ts-expect-error — plain JS module, no types
import { specFor, calibratedVenues, applyMOS } from '../mos'
import { VENUES } from '../../../lib/venues'

// A FITTED CORRECTION THAT NOBODY LOOKS UP IS NOT SHIPPED, AND NOTHING SAYS SO.
//
// applyMOS reads `spec.models[MODELS[key].mosModel]`. Three ways that misses,
// all silent, all of which were live in this repo on 28 Oct 2026 until the San
// Juan spec was registered and someone checked:
//
//   1. the model carries NO mosModel at all — HRRR and HRDPS did not, so the
//      San Juan coefficients fitted for them could never have been found;
//   2. the spec's key is not any model's mosModel — San Juan's `icon_global`
//      is not, because MODELS.ICON claims `icon_eu`, which does not reach the
//      Pacific;
//   3. the venue is registered but its key does not match lib/venues.ts.
//
// None of these throws. Each just means the raw forecast, which looks exactly
// like a correction that is working and finding nothing to correct.

/** Every mosModel any model claims. */
const CLAIMED: ReadonlySet<string> = new Set(
  Object.values(MODELS).map((m: { mosModel?: string }) => m.mosModel).filter(Boolean) as string[],
)

describe('every registered MOS spec is reachable from the app', () => {
  it('registers only venues that exist in lib/venues.ts', () => {
    const keys = new Set(VENUES.map((v) => v.key))
    const orphans = calibratedVenues().filter((k: string) => !keys.has(k))
    expect(orphans, `registered under a key no venue has: ${orphans.join(', ')}`).toEqual([])
  })

  it('has a model claiming every spec key, or names it as not applied', () => {
    for (const venue of calibratedVenues()) {
      const spec = specFor(venue)
      const declared = Object.keys(spec.models_not_applied ?? {})
      const unreachable = Object.keys(spec.models ?? {})
        .filter((id) => !CLAIMED.has(id) && !declared.includes(id))
      expect(unreachable, `${venue}: fitted but no model's mosModel matches, and not declared `
        + `in models_not_applied — these coefficients are inert: ${unreachable.join(', ')}`).toEqual([])
    }
  })

  it('does not DECLARE a key unapplied that is in fact wired', () => {
    // The other direction: a stale `models_not_applied` entry would hide a
    // correction that is actually live from anyone reading the spec.
    for (const venue of calibratedVenues()) {
      const spec = specFor(venue)
      const lying = Object.keys(spec.models_not_applied ?? {}).filter((id) => CLAIMED.has(id))
      expect(lying, `${venue}: declared not-applied but a model claims it`).toEqual([])
    }
  })

  it('wires HRRR and HRDPS, which San Juan depends on', () => {
    // Named rather than left to the generic test, because these two are the
    // only reason the San Juan spec does anything at all: ECMWF is raw there
    // and icon_global is deliberately unwired.
    expect(MODELS.HRRR.mosModel).toBe('gfs_hrrr')
    expect(MODELS.HRDPS.mosModel).toBe('gem_hrdps_continental')
    const sj = specFor('san-juan')
    expect(Object.keys(sj.models)).toContain('gfs_hrrr')
    expect(Object.keys(sj.models)).toContain('gem_hrdps_continental')
  })

  it('actually moves the number for San Juan through the app path', () => {
    // End to end on the real spec and the real lookup key: a non-raw entry must
    // change the wind, or something upstream is still not connected.
    const sj = specFor('san-juan')
    for (const key of ['HRRR', 'HRDPS'] as const) {
      const id = MODELS[key].mosModel
      const out = applyMOS(sj, id, 12, 270, 15, 7)
      expect(Number.isFinite(out?.ws ?? out), `${key}: applyMOS returned nothing usable`).toBe(true)
      const v = typeof out === 'number' ? out : out.ws
      expect(v, `${key}: correction did not move 12 kn`).not.toBe(12)
      expect(v).toBeGreaterThan(5)
      expect(v).toBeLessThan(25)
    }
  })

  it('leaves every model a venue does not cover alone', () => {
    // A spec key only matters where the model is actually offered. AROME has
    // no business at San Juan and must not acquire a correction there.
    const sj = VENUES.find((v) => v.key === 'san-juan')!
    const offered = COMPARE_ORDER.filter((k: string) => modelCoversPoint(k, sj.lat, sj.lon))
    expect(offered).not.toContain('AROME')
    expect(offered).toContain('HRDPS')
  })
})
