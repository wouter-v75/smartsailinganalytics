import { describe, expect, it } from 'vitest'
import {
  marineSstUrl, parseMarineSst, sstAt, airSeaDeltaK, deltaKFromHourly,
} from '../seaTemp'
import { mastheadWind } from '../windProfile'

// The real response, taken off the marine endpoint for the Gulf of Naples on
// 24 Oct 2026. Note the NAIVE stamps and the declared unit.
const LIVE = {
  latitude: 40.708336,
  longitude: 14.2083435,
  timezone: 'GMT',
  hourly_units: { time: 'iso8601', sea_surface_temperature: '°C' },
  hourly: {
    time: ['2026-10-24T00:00', '2026-10-24T01:00', '2026-10-24T12:00'],
    sea_surface_temperature: [22, 21.9, 22],
  },
}

describe('marineSstUrl', () => {
  it('always carries a timezone, because the default is GMT', () => {
    // The surface fetch asks in the venue's local time. If this one did not,
    // the two series would be out of step by the venue offset — two hours in
    // the Med, which in a diurnal sea breeze is the difference between stable
    // and unstable.
    const u = marineSstUrl(40.7, 14.2, 'Europe/Rome')
    expect(u).toContain('timezone=Europe%2FRome')
    expect(u).toContain('hourly=sea_surface_temperature')
  })
})

describe('parseMarineSst', () => {
  it('reads the live shape', () => {
    const s = parseMarineSst(LIVE)!
    expect(s.times).toHaveLength(3)
    expect(s.sstC).toEqual([22, 21.9, 22])
    expect(s.lat).toBeCloseTo(40.708336, 5)
    expect(s.timezone).toBe('GMT')
  })

  it('REFUSES a series that is not in Celsius', () => {
    // The same endpoint serves Fahrenheit. Read as Celsius, every sea comes
    // out warmer than every air and the whole stability sign flips.
    const f = { ...LIVE, hourly_units: { ...LIVE.hourly_units, sea_surface_temperature: '°F' } }
    expect(parseMarineSst(f)).toBeNull()
  })

  it('accepts the unit written either way', () => {
    for (const u of ['°C', 'C', '  °C ']) {
      expect(parseMarineSst({ ...LIVE, hourly_units: { sea_surface_temperature: u } })).not.toBeNull()
    }
  })

  it('keeps nulls as nulls rather than zeroes', () => {
    const gappy = { ...LIVE, hourly: { ...LIVE.hourly, sea_surface_temperature: [22, null, 'x'] } }
    expect(parseMarineSst(gappy)!.sstC).toEqual([22, null, null])
  })

  it('refuses mismatched or missing arrays', () => {
    expect(parseMarineSst({ ...LIVE, hourly: { time: ['a', 'b'], sea_surface_temperature: [1] } })).toBeNull()
    expect(parseMarineSst({ hourly: {} })).toBeNull()
    expect(parseMarineSst(null)).toBeNull()
    expect(parseMarineSst('nope')).toBeNull()
  })
})

describe('sstAt', () => {
  const s = parseMarineSst(LIVE)!

  it('matches a stamp exactly', () => {
    expect(sstAt(s, '2026-10-24T12:00')).toBe(22)
    expect(sstAt(s, '2026-10-24T01:00')).toBe(21.9)
  })

  it('tolerates a caller holding seconds', () => {
    expect(sstAt(s, '2026-10-24T01:00:00')).toBe(21.9)
  })

  it('returns null for an hour that is not there, rather than the nearest', () => {
    // Strict on purpose: a near match would paper over the timezone mismatch
    // this module exists to prevent. An SST attributed to the wrong hour of a
    // diurnal cycle is the failure; a missing one is merely a gap.
    expect(sstAt(s, '2026-10-24T02:00')).toBeNull()
    expect(sstAt(s, '2026-10-24T14:00')).toBeNull()
    expect(sstAt(s, null)).toBeNull()
    expect(sstAt(null, '2026-10-24T12:00')).toBeNull()
  })
})

describe('airSeaDeltaK', () => {
  it('is air minus sea, positive for stable', () => {
    expect(airSeaDeltaK(24, 22)).toBe(2)
    expect(airSeaDeltaK(20, 22)).toBe(-2)
  })

  it('is null when either side is missing', () => {
    expect(airSeaDeltaK(null, 22)).toBeNull()
    expect(airSeaDeltaK(24, null)).toBeNull()
    expect(airSeaDeltaK(NaN, 22)).toBeNull()
  })
})

describe('deltaKFromHourly', () => {
  const sst = parseMarineSst(LIVE)!
  const hourly = {
    time: ['2026-10-24T00:00', '2026-10-24T01:00', '2026-10-24T12:00'],
    temperature_2m: [23, 21, 24],
  }

  it('pairs the model air temperature with the SST at the same stamp', () => {
    expect(deltaKFromHourly(hourly, 0, sst)).toBeCloseTo(1, 6)
    expect(deltaKFromHourly(hourly, 1, sst)).toBeCloseTo(-0.9, 6)
    expect(deltaKFromHourly(hourly, 2, sst)).toBeCloseTo(2, 6)
  })

  it('returns null when the model carries no temperature at all', () => {
    expect(deltaKFromHourly({ time: hourly.time }, 0, sst)).toBeNull()
    expect(deltaKFromHourly(null, 0, sst)).toBeNull()
  })

  it('returns null when the series do not line up', () => {
    // The timezone-mismatch case: both series exist, neither stamp matches.
    const shifted = { time: ['2026-10-24T02:00'], temperature_2m: [24] }
    expect(deltaKFromHourly(shifted, 0, sst)).toBeNull()
  })
})

describe('end to end: the Gulf of Naples case', () => {
  it('turns a real SST and air temperature into the 2.1 kn correction', () => {
    // SST 22 C from the live response, air 24 C: +2 K, the ordinary offshore
    // morning. At 10 kn that is the headline 2.1 kn at the masthead.
    const sst = parseMarineSst(LIVE)!
    const dK = airSeaDeltaK(24, sstAt(sst, '2026-10-24T12:00'))
    expect(dK).toBe(2)
    const t = mastheadWind(10, 10, 30, dK)
    expect(t.kn - t.neutralKn).toBeCloseTo(2.1, 1)
    expect(t.regime).toBe('stable')
  })

  it('falls back to a flagged neutral answer when SST is missing', () => {
    const dK = airSeaDeltaK(24, sstAt(parseMarineSst(LIVE)!, '2026-10-24T02:00'))
    expect(dK).toBeNull()
    const t = mastheadWind(10, 10, 30, dK)
    expect(t.kn).toBeCloseTo(t.neutralKn, 6)
    expect(t.quality).not.toBe('ok')
    expect(t.note).toMatch(/LOW/)
  })
})
