import { describe, it, expect } from 'vitest'
import { fallbackMagVar, MAGVAR_VENUES, magVarDeg, trueToMagnetic } from '../magVar'

describe('fallbackMagVar', () => {
  it('finds Porto Cervo from a position on the race area', () => {
    // a real drone fix from 8 Sept, out on the course
    const v = fallbackMagVar(41.182442, 9.552726)
    expect(v?.name).toBe('Porto Cervo')
    expect(v?.varDeg).toBe(3.5)
  })

  it('returns null far away rather than the nearest guess', () => {
    expect(fallbackMagVar(50.76, -1.30)).toBeNull()   // the Solent
    expect(fallbackMagVar(43.17, 5.61)).toBeNull()    // La Ciotat
  })

  it('returns null for a missing or nonsense position', () => {
    expect(fallbackMagVar(undefined, undefined)).toBeNull()
    expect(fallbackMagVar(NaN, 9.5)).toBeNull()
    expect(fallbackMagVar('41.1' as unknown, 9.5)).toBeNull()
  })

  it('every entry records where its number came from', () => {
    // a value with no provenance is indistinguishable from a guess
    for (const v of MAGVAR_VENUES) expect(v.source).toBeTruthy()
  })
})

describe('magVarDeg — the global answer', () => {
  // NOAA geomag-web, WMM-2025, elevation 0, queried 2026-10-22. These pin the
  // EPOCH as much as the arithmetic: a package bump that quietly shipped
  // WMM-2020 would be wrong here by about a degree, which is exactly the kind of
  // staleness that otherwise looks fine.
  const WHEN = new Date('2026-10-22T00:00:00Z')
  const NOAA: Array<[string, number, number, number]> = [
    ['St Tropez', 43.275, 6.678, 3.099],
    ['Solent', 50.76, -1.29, 0.891],
    ['La Spezia', 44.10, 9.83, 3.755],
    ['San Juan Islands', 48.5627, -122.8946, 15.171],
    ['Long Beach', 33.72, -118.27, 11.280],
    ['Ensenada', 31.85, -116.62, 10.582],
  ]

  it.each(NOAA)('matches NOAA at %s', (_name, lat, lon, decl) => {
    expect(magVarDeg(lat, lon, WHEN)!).toBeCloseTo(decl, 2)
  })

  it('answers for a venue nobody has listed — that was the whole point', () => {
    // Before this, an unlisted venue returned null and the caller substituted 0,
    // showing a TRUE bearing under a magnetic label.
    expect(fallbackMagVar(48.5627, -122.8946)).toBeNull()
    expect(magVarDeg(48.5627, -122.8946, WHEN)).not.toBeNull()
  })

  it('lets a MEASURED venue value outrank the model', () => {
    // Porto Cervo is in the table at 3.5 from the crew; WMM says 3.529. The
    // table wins, and the fact that they agree is the reason to trust both.
    expect(magVarDeg(41.135, 9.538, WHEN)).toBe(3.5)
  })

  it('refuses an unusable position rather than returning zero', () => {
    expect(magVarDeg(undefined, undefined)).toBeNull()
    expect(magVarDeg(NaN, 9.5)).toBeNull()
    expect(magVarDeg(91, 0)).toBeNull()
    expect(magVarDeg(0, 181)).toBeNull()
  })
})

describe('trueToMagnetic', () => {
  const WHEN = new Date('2026-10-22T00:00:00Z')
  it('subtracts easterly variation', () => {
    // Long Beach, 11.28 E. A wind FROM 250 true is from 238.7 magnetic.
    expect(trueToMagnetic(250, 33.72, -118.27, WHEN)!).toBeCloseTo(238.72, 1)
  })
  it('wraps below zero', () => {
    expect(trueToMagnetic(5, 33.72, -118.27, WHEN)!).toBeCloseTo(353.72, 1)
  })

  it('reports north as 360, not 0', () => {
    // Use the TABLE value (Porto Cervo, exactly 3.5) so this lands on a clean
    // zero. Against the model it would land on 0.00003 and never trip the rule —
    // which is fine: 360 is for a bearing that really is due north.
    expect(trueToMagnetic(3.5, 41.135, 9.538, WHEN)).toBe(360)
  })
  it('is null when the position is unusable', () => {
    expect(trueToMagnetic(250, NaN, 0)).toBeNull()
    expect(trueToMagnetic(NaN, 33.72, -118.27)).toBeNull()
  })
})
