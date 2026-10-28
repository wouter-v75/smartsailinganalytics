// One venue vocabulary, asserted.
//
// There were three. MOS kept its own centres keyed `st_tropez`/`porto_cervo`/
// `sorrento`; the observation network used `st-tropez`/`porto-cervo`; and
// forecastDiagnostics.VENUE_COAST_NORMAL was keyed by the MOS spelling for a
// venue the observation list called `la-spezia`, so that override could never
// fire. Every mismatch was SILENT — a key matching nothing is just no
// correction, no coast normal, or no dense network, with everything looking
// fine. These tests are what stops it drifting apart again.

import { describe, expect, it } from 'vitest'
import { VENUES, venueByKey, venueAt, VENUE_MATCH_NM } from '../venues'
import { matchVenue, specFor, calibratedVenues, venueLabel } from '../../components/weather/mos'
import { VENUE_COAST_NORMAL } from '../../components/weather/forecastDiagnostics'

const KEYS = new Set(VENUES.map((v) => v.key))

describe('venue keys', () => {
  it('are unique and hyphenated, never underscored', () => {
    expect(new Set(VENUES.map((v) => v.key)).size).toBe(VENUES.length)
    for (const v of VENUES) {
      expect(v.key, `${v.key} must be lower-case kebab`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(v.key).not.toContain('_')
    }
  })

  it('give every venue a name and a position', () => {
    for (const v of VENUES) {
      expect(v.name.trim()).not.toBe('')
      expect(Math.abs(v.lat)).toBeLessThanOrEqual(90)
      expect(Math.abs(v.lon)).toBeLessThanOrEqual(180)
    }
  })
})

describe('MOS is keyed by the venue list', () => {
  it('has a fitted spec only for venues that exist', () => {
    // A spec keyed by a name no venue has is a correction that can never be
    // applied, and nothing would report it.
    for (const key of calibratedVenues()) {
      expect(KEYS.has(key), `MOS spec '${key}' is not a venue key`).toBe(true)
      expect(specFor(key)).toBeTruthy()
    }
  })

  it('still carries the three Mediterranean venues the rename was about', () => {
    // The rename that this file guards was hyphenating the Mediterranean keys,
    // and those three must never silently drop out. It is no longer the WHOLE
    // list — oslofjord, viksfjord and san-juan were registered on 28 Oct 2026 —
    // so this asserts containment rather than equality, which is what it was
    // actually protecting. The test above already checks every registered key
    // is a real venue, so a typo in a new one still fails there.
    for (const key of ['porto-cervo', 'sorrento', 'st-tropez']) {
      expect(calibratedVenues(), key).toContain(key)
    }
  })

  it('registers the station-fitted venues too, each under its venue key', () => {
    for (const key of ['oslofjord', 'viksfjord', 'san-juan', 'long-beach']) {
      expect(calibratedVenues(), key).toContain(key)
      expect(specFor(key).venue, key).toBe(key)
    }
  })

  it('includes Sorrento in the venue list, which it was missing', () => {
    // Three years of fitted coefficients for a venue the observation network
    // had never heard of was the clearest sign the two lists had drifted.
    expect(KEYS.has('sorrento')).toBe(true)
  })

  it('matches a position to a venue key the spec table understands', () => {
    const stt = VENUES.find((v) => v.key === 'st-tropez')!
    const key = matchVenue(stt.lat, stt.lon)
    expect(key).toBe('st-tropez')
    expect(specFor(key)).toBeTruthy()
  })

  it('returns null outside the match radius rather than a neighbour', () => {
    // A correction fitted off St Tropez is worse than nothing at La Spezia.
    expect(matchVenue(0, 0)).toBeNull()
    expect(matchVenue(null, null)).toBeNull()
    expect(matchVenue(NaN, 5)).toBeNull()
    const spezia = VENUES.find((v) => v.key === 'la-spezia')!
    expect(specFor(matchVenue(spezia.lat, spezia.lon))).toBeNull()
  })

  it('gives a display NAME, not a de-underscored key', () => {
    // ForecastDeck titled its slides with key.replace(/_/g,' '), which would
    // now print "st-tropez".
    expect(venueLabel('st-tropez')).toBe('St Tropez')
    expect(venueLabel('porto-cervo')).toBe('Porto Cervo')
    expect(venueLabel(null)).toBeNull()
    expect(venueLabel('not-a-venue')).toBeNull()
  })
})

describe('coast-normal overrides are keyed by the venue list', () => {
  it('names only venues that exist', () => {
    for (const key of Object.keys(VENUE_COAST_NORMAL)) {
      expect(KEYS.has(key), `VENUE_COAST_NORMAL['${key}'] is not a venue key`).toBe(true)
    }
  })

  it('still has La Spezia, now under a key that can fire', () => {
    expect(VENUE_COAST_NORMAL['la-spezia']).toBe(210)
  })
})

describe('venueAt / venueByKey', () => {
  it('finds the nearest venue within the radius', () => {
    const stt = VENUES.find((v) => v.key === 'st-tropez')!
    expect(venueAt(stt.lat, stt.lon)?.key).toBe('st-tropez')
    // 10 nm east is still St Tropez; the Atlantic is not.
    expect(venueAt(stt.lat, stt.lon + 0.2)?.key).toBe('st-tropez')
    expect(venueAt(30, -40)).toBeNull()
  })

  it('honours a tighter radius when asked', () => {
    const stt = VENUES.find((v) => v.key === 'st-tropez')!
    expect(venueAt(stt.lat + 0.25, stt.lon, 5)).toBeNull()
    expect(venueAt(stt.lat + 0.25, stt.lon, 20)?.key).toBe('st-tropez')
    expect(VENUE_MATCH_NM).toBe(20)
  })

  it('looks a venue up by key, case-insensitively', () => {
    expect(venueByKey('st-tropez')?.name).toBe('St Tropez')
    expect(venueByKey('ST-TROPEZ')?.name).toBe('St Tropez')
    expect(venueByKey('nope')).toBeUndefined()
    expect(venueByKey(null)).toBeUndefined()
  })
})
