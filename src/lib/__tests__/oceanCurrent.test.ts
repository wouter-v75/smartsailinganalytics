import { describe, it, expect } from 'vitest'
import {
  currentUrl, parseCurrentResponse, currentAt, crossWindKn, twdBiasDeg,
  biasVerdict, describeCurrentBias, snapToGrid, medianPosition, distanceKm,
  fetchOceanCurrent,
} from '../oceanCurrent'

// The real response shape, captured from marine-api.open-meteo.com for the
// Palma session (39.53, 2.57 → the model answered from a cell 8.3 km away).
const REAL = {
  latitude: 39.458336,
  longitude: 2.5416718,
  utc_offset_seconds: 0,
  hourly_units: { time: 'iso8601', ocean_current_velocity: 'km/h', ocean_current_direction: '°' },
  hourly: {
    time: ['2026-02-08T10:00', '2026-02-08T11:00', '2026-02-08T12:00', '2026-02-08T13:00'],
    ocean_current_velocity: [0.6, 0.6, 0.6, 0.6],
    ocean_current_direction: [108, 108, 108, 124],
  },
}

describe('currentUrl', () => {
  it('requests UTC, never a named zone', () => {
    // Asking for Europe/Madrid on a February date returned September's DST
    // offset (utc_offset_seconds 7200), which would slide the series an hour.
    const url = currentUrl({ lat: 39.53, lon: 2.57, startDate: '2026-02-08' })
    expect(url).toContain('timezone=UTC')
    expect(url).not.toContain('Europe')
  })

  it('snaps the position so a session costs one billed location', () => {
    const url = currentUrl({ lat: 39.5312345, lon: 2.5704827, startDate: '2026-02-08' })
    expect(url).toContain('latitude=39.55')
    expect(url).toContain('longitude=2.55')
  })

  it('defaults the end date to the start date', () => {
    const url = currentUrl({ lat: 39.5, lon: 2.5, startDate: '2026-02-08' })
    expect(url).toContain('start_date=2026-02-08&end_date=2026-02-08')
  })
})

describe('snapToGrid / medianPosition / distanceKm', () => {
  it('snaps to 0.05°, finer than the model’s own 8 km cell', () => {
    expect(snapToGrid(39.5312345, 2.5704827)).toEqual({ lat: 39.55, lon: 2.55 })
    expect(snapToGrid(-0.012, -0.049)).toEqual({ lat: 0, lon: -0.05 })   // toFixed drops the -0 sign
  })

  it('takes one representative point from a track', () => {
    expect(medianPosition([
      { lat: 39.1, lon: 2.1 }, { lat: 39.3, lon: 2.3 }, { lat: 39.2, lon: 2.2 },
    ])).toEqual({ lat: 39.2, lon: 2.2 })
    expect(medianPosition([{ lat: null, lon: null }])).toBeNull()
    expect(medianPosition([])).toBeNull()
  })

  it('measures how far the model cell actually is', () => {
    expect(distanceKm(39.53, 2.57, 39.458336, 2.5416718)).toBeCloseTo(8.3, 0)
  })
})

describe('parseCurrentResponse', () => {
  const s = parseCurrentResponse(REAL, 39.53, 2.57)!

  it('converts km/h to knots because the unit request is ignored', () => {
    // `current_velocity_unit=kn` has no effect — the API answers in km/h
    // regardless, so the unit is read from the response. Trusting the request
    // would have made every current 1.85x too big.
    expect(s.speedKn[0]).toBeCloseTo(0.6 / 1.852, 4)
    expect(s.speedKn[0]).toBeCloseTo(0.324, 3)
  })

  it('honours a response that really is in knots', () => {
    const kn = parseCurrentResponse(
      { ...REAL, hourly_units: { ...REAL.hourly_units, ocean_current_velocity: 'kn' } },
      39.53, 2.57)!
    expect(kn.speedKn[0]).toBeCloseTo(0.6, 4)
  })

  it('reads times as UTC even though the API omits the Z', () => {
    expect(s.times[0]).toBe(Date.UTC(2026, 1, 8, 10, 0))
  })

  it('reports the cell it was actually given, and how far away it is', () => {
    expect(s.cell).toEqual({ lat: 39.458336, lon: 2.5416718 })
    expect(s.cellOffsetKm).toBeCloseTo(8.3, 0)
  })

  it('returns null for a land cell or an empty response', () => {
    expect(parseCurrentResponse({ hourly: { time: [], ocean_current_velocity: [] } }, 0, 0)).toBeNull()
    expect(parseCurrentResponse({}, 0, 0)).toBeNull()
    expect(parseCurrentResponse({
      ...REAL,
      hourly: { ...REAL.hourly, ocean_current_velocity: [null, null, null, null] },
    }, 0, 0)).toBeNull()
  })
})

describe('currentAt', () => {
  const s = parseCurrentResponse(REAL, 39.53, 2.57)!

  it('returns the sample on the hour', () => {
    const c = currentAt(s, Date.UTC(2026, 1, 8, 11, 0))!
    expect(c.speedKn).toBeCloseTo(0.324, 3)
    expect(c.setDeg).toBeCloseTo(108, 1)
  })

  it('interpolates the vector, not the bearing', () => {
    // Halfway from 108° to 124° at constant speed must give 116°, and must not
    // be computed by averaging degrees blindly (which breaks across 0/360).
    const c = currentAt(s, Date.UTC(2026, 1, 8, 12, 30))!
    expect(c.setDeg).toBeCloseTo(116, 0)
    expect(c.speedKn).toBeLessThanOrEqual(0.325)
  })

  it('handles the 0/360 wrap', () => {
    const wrap = parseCurrentResponse({
      ...REAL,
      hourly: {
        time: ['2026-02-08T10:00', '2026-02-08T11:00'],
        ocean_current_velocity: [1.852, 1.852],
        ocean_current_direction: [350, 10],
      },
    }, 0, 0)!
    const c = currentAt(wrap, Date.UTC(2026, 1, 8, 10, 30))!
    expect(c.setDeg).toBeCloseTo(0, 1)     // not 180
  })

  it('refuses to extrapolate outside the series', () => {
    expect(currentAt(s, Date.UTC(2026, 1, 8, 9, 0))).toBeNull()
    expect(currentAt(s, Date.UTC(2026, 1, 8, 14, 0))).toBeNull()
    expect(currentAt(null, Date.now())).toBeNull()
  })
})

describe('crossWindKn and twdBiasDeg', () => {
  it('only the across-wind component counts', () => {
    // Current setting straight downwind of a northerly: no rotation.
    expect(crossWindKn(1, 180, 0)).toBeCloseTo(0, 6)
    // Setting due east with wind from the north: fully across.
    expect(crossWindKn(1, 90, 0)).toBeCloseTo(1, 6)
    expect(crossWindKn(1, 270, 0)).toBeCloseTo(-1, 6)
  })

  it('reproduces the worked example from the research', () => {
    // TWD doc §7: 0.5 kn across, 49er at 6 kn and TWA 42° → 3.55°.
    const bias = twdBiasDeg({ speedKn: 0.5, setDeg: 90, twdDeg: 0, boatSpeedKn: 6, twaDeg: 42 })
    expect(bias).toBeCloseTo(3.55, 2)
  })

  it('matches the published per-class table', () => {
    const b = (V: number, twa: number) =>
      twdBiasDeg({ speedKn: 0.5, setDeg: 90, twdDeg: 0, boatSpeedKn: V, twaDeg: twa })
    expect(b(6.0, 42)).toBeCloseTo(3.55, 1)   // 49er
    expect(b(5.0, 43)).toBeCloseTo(4.19, 1)   // 470
    expect(b(4.5, 45)).toBeCloseTo(4.50, 1)   // ILCA
  })

  it('is zero when the boat is not moving', () => {
    expect(twdBiasDeg({ speedKn: 1, setDeg: 90, twdDeg: 0, boatSpeedKn: 0, twaDeg: 42 })).toBe(0)
  })

  it('computes the real Palma session as near-zero', () => {
    // 0.324 kn setting 124°, TWD 265° (the COG-derived figure), 49er-ish.
    // This is why the two boats could agree to 0.2° there.
    const bias = twdBiasDeg({
      speedKn: 0.324, setDeg: 124, twdDeg: 265, boatSpeedKn: 6, twaDeg: 42,
    })
    expect(Math.abs(bias)).toBeLessThan(2)
    expect(bias).toBeCloseTo(-1.45, 1)
  })
})

describe('biasVerdict and describeCurrentBias', () => {
  it('grades against what the wind estimate can otherwise achieve', () => {
    expect(biasVerdict(0.4)).toBe('negligible')   // below the ~1° a fleet reaches
    expect(biasVerdict(-2)).toBe('notable')
    expect(biasVerdict(6)).toBe('significant')
  })

  it('says nothing when there is nothing to say', () => {
    expect(describeCurrentBias({
      speedKn: 0.1, setDeg: 90, twdDeg: 0, boatSpeedKn: 6, twaDeg: 42,
    })).toBeNull()
  })

  it('gives a coach one actionable sentence', () => {
    const s = describeCurrentBias({
      speedKn: 1.5, setDeg: 90, twdDeg: 0, boatSpeedKn: 6, twaDeg: 42,
    })!
    expect(s).toContain('1.5 kn setting 90')
    expect(s).toContain('clockwise')
    expect(s).toContain('ground wind')    // significant → caveat the TWD
  })

  it('names the rotation direction correctly', () => {
    const anti = describeCurrentBias({
      speedKn: 1.5, setDeg: 270, twdDeg: 0, boatSpeedKn: 6, twaDeg: 42,
    })!
    expect(anti).toContain('anticlockwise')
  })
})

describe('fetchOceanCurrent', () => {
  it('parses a good response', async () => {
    const fake = (async () => ({ ok: true, json: async () => REAL })) as unknown as typeof fetch
    const s = await fetchOceanCurrent({ lat: 39.53, lon: 2.57, startDate: '2026-02-08' }, fake)
    expect(s!.speedKn[0]).toBeCloseTo(0.324, 3)
  })

  it('returns null rather than throwing when the API is unhappy', async () => {
    const bad = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    expect(await fetchOceanCurrent({ lat: 0, lon: 0, startDate: '2026-02-08' }, bad)).toBeNull()
    const boom = (async () => { throw new Error('network') }) as unknown as typeof fetch
    expect(await fetchOceanCurrent({ lat: 0, lon: 0, startDate: '2026-02-08' }, boom)).toBeNull()
  })
})
