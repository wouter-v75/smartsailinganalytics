// What activation actually saves, measured against the real registries.
//
// The bulk feeds (NDBC, METAR, Pioupiou, FFVL) cost one call whatever we keep,
// so for those the gate only trims what is stored. The saving that matters is
// on the PER-STATION sources — Davis, WeatherFile, the club feeds, Météo-France
// land — where every station is its own request, 48 times a day.

import { describe, expect, it } from 'vitest'
import {
  stationsForPoll, selectAroundVenue, VENUES, keepRadiusNm, type PollContext,
} from '../obsSources'
import { decideVenues, IDLE_NM, FORCE_ALL } from '../obsActivation'
import { DAVIS_MAP_STATIONS } from '../windObsDavisMap'
import { WEATHERFILE_STATIONS } from '../windObsWeatherfile'
import { CLUB_FEEDS } from '../windObsClubs'
import { GRADED_DEFAULTS, nmBetween } from '../obsDensity'
import { IDLE_MIN_PER_VENUE } from '../obsActivation'

const NOW = Date.parse('2026-09-28T12:00:00Z')
const ctx = (opts: Parameters<typeof decideVenues>[1]): PollContext =>
  ({ venues: decideVenues(VENUES, { ...opts, nowMs: NOW }) })

describe('stationsForPoll', () => {
  it('polls far fewer Davis stations idle than dense', () => {
    const idle = stationsForPoll(DAVIS_MAP_STATIONS, ctx({}))
    const dense = stationsForPoll(DAVIS_MAP_STATIONS, ctx({ force: [FORCE_ALL] }))
    expect(dense.length).toBe(DAVIS_MAP_STATIONS.length)
    expect(idle.length).toBeLessThan(dense.length)
    // The whole justification for the feature. Measured 23 Oct 2026 across
    // all three per-station registries: 69 stations idle against 239 dense,
    // 3,312 requests a day against 11,472.
    expect(idle.length).toBeLessThan(dense.length * 0.5)
  })

  it('keeps every station inside the idle radius even when nothing is active', () => {
    // Idle is not "off". The places that matter keep a continuous record.
    const idle = stationsForPoll(DAVIS_MAP_STATIONS, ctx({}))
    for (const s of DAVIS_MAP_STATIONS) {
      const nearest = Math.min(...VENUES.map((v) =>
        Math.hypot((v.lat - s.lat) * 60, (v.lon - s.lon) * 60 * Math.cos((v.lat * Math.PI) / 180))))
      if (nearest <= IDLE_NM) {
        expect(idle.some((k) => k.id === s.id), `${s.name} at ${nearest.toFixed(1)} nm was dropped`).toBe(true)
      }
    }
  })

  it('brings back the far stations of ONE venue when that venue goes dense', () => {
    const idle = stationsForPoll(DAVIS_MAP_STATIONS, ctx({}))
    const stTropez = stationsForPoll(DAVIS_MAP_STATIONS, ctx({ force: ['st-tropez'] }))
    expect(stTropez.length).toBeGreaterThan(idle.length)
    // And it does not drag in the other side of the world.
    const all = stationsForPoll(DAVIS_MAP_STATIONS, ctx({ force: [FORCE_ALL] }))
    expect(stTropez.length).toBeLessThan(all.length)
  })

  it('is driven by a window exactly as it is by a force', () => {
    const forced = stationsForPoll(DAVIS_MAP_STATIONS, ctx({ force: ['st-tropez'] }))
    const windowed = stationsForPoll(DAVIS_MAP_STATIONS, ctx({
      windows: [{
        venueKey: 'st-tropez',
        startsAt: '2026-09-25T00:00:00Z',
        endsAt: '2026-10-04T00:00:00Z',
        reason: 'Les Voiles',
      }],
    }))
    expect(windowed.map((s) => s.id).sort()).toEqual(forced.map((s) => s.id).sort())
  })

  it('still reaches the WeatherFile and club stations when idle — they are all close in', () => {
    // These registries are small and sit on the race areas, so the idle set
    // should keep most of them. If a venue's own harbour went quiet out of
    // season that would be the wrong trade.
    const idleWf = stationsForPoll(WEATHERFILE_STATIONS, ctx({}))
    const idleClubs = stationsForPoll(CLUB_FEEDS, ctx({}))
    expect(idleWf.length).toBeGreaterThan(0)
    expect(idleClubs.length).toBeGreaterThan(0)
  })

  it('leaves NO VENUE DARK when idle, however sparse its neighbourhood', () => {
    // This is the floor, and it is not hypothetical: Porto Cervo has no
    // station at all within 5 nm, so a radius on its own would stop
    // collecting there entirely out of season — a gap nobody notices until
    // they go looking for last month's wind and it is not there.
    const all = [
      ...DAVIS_MAP_STATIONS.map((s) => ({ lat: s.lat, lon: s.lon })),
      ...WEATHERFILE_STATIONS.map((s) => ({ lat: s.lat, lon: s.lon })),
      ...CLUB_FEEDS.map((s) => ({ lat: s.lat, lon: s.lon })),
    ]
    const idleCtx = ctx({})
    const picked = [
      ...stationsForPoll(DAVIS_MAP_STATIONS, idleCtx).map((s) => ({ lat: s.lat, lon: s.lon })),
      ...stationsForPoll(WEATHERFILE_STATIONS, idleCtx).map((s) => ({ lat: s.lat, lon: s.lon })),
      ...stationsForPoll(CLUB_FEEDS, idleCtx).map((s) => ({ lat: s.lat, lon: s.lon })),
    ]
    for (const v of VENUES) {
      const available = all.filter((s) => nmBetween(v.lat, v.lon, s.lat, s.lon) <= 60).length
      const kept = picked.filter((s) => nmBetween(v.lat, v.lon, s.lat, s.lon) <= 60).length
      expect(kept, `${v.key} kept nothing while ${available} were available`)
        .toBeGreaterThanOrEqual(Math.min(available, IDLE_MIN_PER_VENUE))
    }
  })

  it('selects nothing from an empty list, and never duplicates', () => {
    expect(stationsForPoll([], ctx({ force: [FORCE_ALL] }))).toEqual([])
    const picked = stationsForPoll(DAVIS_MAP_STATIONS, ctx({ force: [FORCE_ALL] }))
    expect(new Set(picked.map((s) => s.id)).size).toBe(picked.length)
  })
})

describe('keepRadiusNm', () => {
  it('stores a wide radius when dense and the inner circle when idle', () => {
    const [dense] = decideVenues([VENUES[0]], { force: [FORCE_ALL], nowMs: NOW })
    const [idle] = decideVenues([VENUES[0]], { nowMs: NOW })
    expect(keepRadiusNm(idle)).toBe(IDLE_NM)
    expect(keepRadiusNm(dense)).toBeGreaterThan(IDLE_NM)
    // Bulk feeds are free to ask for, so a dense venue keeps more than it
    // even selects per-station.
    expect(keepRadiusNm(dense)).toBeGreaterThanOrEqual(GRADED_DEFAULTS.outerNm)
  })
})

describe('selectAroundVenue (an ungraded pool, such as all of France)', () => {
  // The Météo-France list is every station in the country, so it has to be
  // thinned when dense AND floored when idle. Leaving out the floor is what
  // hid Cap Camarat.
  const LA = 43.266897
  const LO = 6.698371
  const CAMARAT = { id: '83101001', lat: 43.2005, lon: 6.6745 }   // 4.1 nm
  const COGOLIN = { id: '83042001', lat: 43.25, lon: 6.53 }       // 8.2 nm
  const FREJUS = { id: '83061001', lat: 43.4327, lon: 6.7358 }    // 9.9 nm
  const PARIS = { id: '75114001', lat: 48.85, lon: 2.35 }         // far away
  const pool = [CAMARAT, COGOLIN, FREJUS, PARIS]

  const decisionFor = (opts: Parameters<typeof decideVenues>[1]) =>
    decideVenues(VENUES, { ...opts, nowMs: NOW }).find((v) => v.key === 'st-tropez')!

  it('keeps Cap Camarat when St Tropez is IDLE, though it is outside the 3 nm radius', () => {
    // The regression. Cap Camarat is 4.1 nm out and the idle radius is 3, so
    // a radius-only rule drops the single most useful station at the venue —
    // the only one inside the 5 nm circle — whenever no regatta is running.
    const kept = selectAroundVenue(pool, decisionFor({}))
    expect(kept.map((s) => s.id)).toContain('83101001')
  })

  it('keeps it when St Tropez is DENSE too', () => {
    const kept = selectAroundVenue(pool, decisionFor({ force: ['st-tropez'] }))
    expect(kept.map((s) => s.id)).toContain('83101001')
  })

  it('does not drag in the other end of the country either way', () => {
    for (const opts of [{}, { force: ['st-tropez'] }]) {
      expect(selectAroundVenue(pool, decisionFor(opts)).map((s) => s.id)).not.toContain('75114001')
    }
  })

  it('selects more when dense than when idle', () => {
    const idle = selectAroundVenue(pool, decisionFor({})).length
    const dense = selectAroundVenue(pool, decisionFor({ force: ['st-tropez'] })).length
    expect(dense).toBeGreaterThanOrEqual(idle)
  })

  it('floors at the nearest few, not at everything in range', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, lat: LA + 0.2 + i * 0.01, lon: LO }))
    const kept = selectAroundVenue(many, decisionFor({}))
    expect(kept.length).toBeLessThanOrEqual(IDLE_MIN_PER_VENUE)
  })
})
