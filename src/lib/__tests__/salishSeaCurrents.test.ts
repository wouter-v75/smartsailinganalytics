// SalishSeaCast currents: the grid lookup and the parsing.
//
// The fixtures below are the real response SHAPE from ERDDAP — rows of
// [gridY, gridX, latitude, longitude, bathymetry] and
// [time, gridY, gridX, VelEast5, VelNorth5] — trimmed to a few cells. The
// numbers in the assertions are the ones measured against the live service on
// 27 Oct 2026, so a drift in the fit or the conventions shows up here.

import { describe, expect, it, vi } from 'vitest'
import {
  inSalishSea, gridGuess, windowSel, geoWindowUrl, currentWindowUrl, seriesUrl,
  pickCell, parseSeries, fetchSalishSeaCurrent, NY, NX,
} from '../salishSeaCurrents'

const VENUE = { lat: 48.5627, lon: -122.8946 }

describe('inSalishSea', () => {
  it('covers the San Juans and Puget Sound', () => {
    expect(inSalishSea(VENUE.lat, VENUE.lon)).toBe(true)
    expect(inSalishSea(47.60, -122.33)).toBe(true)      // Seattle
    expect(inSalishSea(48.45, -122.97)).toBe(true)      // Cattle Pass
  })

  it('excludes everywhere the global source still serves', () => {
    expect(inSalishSea(41.135, 9.538)).toBe(false)      // Porto Cervo
    expect(inSalishSea(59.03, 10.15)).toBe(false)       // Viksfjord
    expect(inSalishSea(33.72, -118.27)).toBe(false)     // Long Beach
  })

  it('is false for a missing position rather than throwing', () => {
    expect(inSalishSea(null, null)).toBe(false)
    expect(inSalishSea(48.5, undefined)).toBe(false)
    expect(inSalishSea(NaN, -122.9)).toBe(false)
  })
})

describe('gridGuess', () => {
  it('lands where the live grid says, at the venue', () => {
    // Measured: the true nearest water cell is (294,285); the fit gives 293.9,
    // 284.9. Within one cell is the whole requirement — the cell is then chosen
    // by looking at the real field.
    const g = gridGuess(VENUE.lat, VENUE.lon)
    expect(g.gy).toBeCloseTo(293.9, 1)
    expect(g.gx).toBeCloseTo(284.9, 1)
  })

  it('and at Cattle Pass and Rosario Strait', () => {
    const cp = gridGuess(48.4514, -122.9686)
    expect(Math.round(cp.gy)).toBeCloseTo(278, 0)       // true cell (277,260)
    expect(Math.round(cp.gx)).toBeCloseTo(260, 0)
    const ro = gridGuess(48.55, -122.75)
    expect(Math.round(ro.gy)).toBeCloseTo(281, 0)       // true cell (281,304)
    expect(Math.round(ro.gx)).toBeCloseTo(305, 0)
  })
})

describe('windowSel', () => {
  it('builds a square window around the guess', () => {
    expect(windowSel(294, 285, 2)).toBe('[292:296][283:287]')
  })

  it('clamps at the grid edges instead of asking for a negative index', () => {
    expect(windowSel(1, 1, 12)).toBe('[0:13][0:13]')
    expect(windowSel(NY - 1, NX - 1, 12)).toBe(`[${NY - 13}:${NY - 1}][${NX - 13}:${NX - 1}]`)
  })
})

describe('the URLs', () => {
  it('percent-encode the brackets, which ERDDAP requires', () => {
    const u = geoWindowUrl('[1:2][3:4]')
    expect(u).toContain('%5B1:2%5D%5B3:4%5D')
    expect(u).not.toContain('[')
    expect(u).toContain('ubcSSnBathymetryV21-08')
    expect(u).toContain('latitude')
    expect(u).toContain('bathymetry')
  })

  it('asks the current field for ONE timestep when choosing a cell', () => {
    const u = currentWindowUrl('[1:2][3:4]')
    expect(u).toContain('VelEast5%5B0:0%5D')
    expect(u).toContain('VelNorth5%5B0:0%5D')
    expect(u).toContain('ubcSSfDepthAvgdCurrents1h')
  })

  it('asks for every timestep at one cell for the series', () => {
    const u = seriesUrl(294, 285)
    expect(u).toContain('VelEast5%5B0:last%5D%5B294:294%5D%5B285:285%5D')
    expect(u).toContain('VelNorth5%5B0:last%5D%5B294:294%5D%5B285:285%5D')
  })
})

describe('pickCell', () => {
  // (294,285) is the nearest cell and has geo but NO velocity — the real mask
  // disagreement at the venue centre. (295,285) is further and has one.
  const geo = {
    table: {
      rows: [
        [294, 285, 48.5642, -122.8945, 41.1],
        [295, 285, 48.5700, -122.8945, 55.0],
        [296, 288, 48.5800, -122.8800, 70.3],
      ],
    },
  }
  const cur = {
    table: {
      rows: [
        ['2026-10-27T00:30:00Z', 294, 285, null, null],
        ['2026-10-27T00:30:00Z', 295, 285, 0.30, 0.10],
        ['2026-10-27T00:30:00Z', 296, 288, 1.00, 0.00],
      ],
    },
  }

  it('skips the nearest cell when it carries no velocity', () => {
    const c = pickCell(geo as never, cur as never, VENUE.lat, VENUE.lon)!
    expect([c.gy, c.gx]).toEqual([295, 285])
    expect(c.depthM).toBe(55)
  })

  it('reports the window spread, which is the point at a tidal gate', () => {
    // Measured at Cattle Pass: the same window spans 0.04 to 4.03 kn, so the
    // fastest cell nearby is worth carrying out of here.
    const c = pickCell(geo as never, cur as never, VENUE.lat, VENUE.lon)!
    expect(c.localMaxKn).toBeCloseTo(1.0 * 1.94384, 4)
    expect(c.withData).toBe(2)
    expect(c.inWindow).toBe(3)
  })

  it('returns null when nothing in the window has a current', () => {
    const dead = { table: { rows: cur.table.rows.map((r) => [r[0], r[1], r[2], null, null]) } }
    expect(pickCell(geo as never, dead as never, VENUE.lat, VENUE.lon)).toBeNull()
  })

  it('ignores a velocity cell with no geo entry, so the join is safe', () => {
    const orphan = { table: { rows: [['t', 700, 300, 2.0, 0.0]] } }
    expect(pickCell(geo as never, orphan as never, VENUE.lat, VENUE.lon)).toBeNull()
  })
})

describe('parseSeries', () => {
  const cell = { gy: 281, gx: 304, lat: 48.5489, lon: -122.7518, depthM: 70.6, offsetKm: 0.17, localMaxKn: 4.2, withData: 1, inWindow: 1 }

  it('converts m/s to knots and gives a SET, not a from-direction', () => {
    const j = {
      table: {
        rows: [
          ['2026-10-27T00:30:00Z', 281, 304, 1.0, 0.0],    // due east
          ['2026-10-27T01:30:00Z', 281, 304, 0.0, 1.0],    // due north
          ['2026-10-27T02:30:00Z', 281, 304, -1.0, 0.0],   // due west
        ],
      },
    }
    const s = parseSeries(j as never, cell, 48.55, -122.75)!
    expect(s.speedKn[0]).toBeCloseTo(1.94384, 5)
    expect(s.setDeg).toEqual([90, 0, 270])
    expect(s.times[0]).toBe(Date.parse('2026-10-27T00:30:00Z'))
  })

  it('keeps a masked hour as null rather than dropping the step', () => {
    const j = { table: { rows: [['2026-10-27T00:30:00Z', 281, 304, null, null]] } }
    const s = parseSeries(j as never, cell, 48.55, -122.75)!
    expect(s.times).toHaveLength(1)
    expect(s.speedKn[0]).toBeNull()
    expect(s.setDeg[0]).toBeNull()
  })

  it('reports the cell and how far it is from the point asked for', () => {
    const j = { table: { rows: [['2026-10-27T00:30:00Z', 281, 304, 1.0, 0.0]] } }
    const s = parseSeries(j as never, cell, 48.55, -122.75)!
    expect(s.cell).toEqual({ lat: 48.5489, lon: -122.7518 })
    expect(s.cellOffsetKm).toBeGreaterThan(0)
    expect(s.cellOffsetKm).toBeLessThan(0.5)
  })

  it('returns null for an empty table', () => {
    expect(parseSeries({ table: { rows: [] } } as never, cell, 48.55, -122.75)).toBeNull()
    expect(parseSeries({} as never, cell, 48.55, -122.75)).toBeNull()
  })
})

describe('fetchSalishSeaCurrent', () => {
  const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)

  it('refuses a position outside the domain without any request', () => {
    const f = vi.fn()
    return fetchSalishSeaCurrent({ lat: 41.135, lon: 9.538 }, f as never).then((r) => {
      expect(r).toBeNull()
      expect(f).not.toHaveBeenCalled()
    })
  })

  it('resolves a cell and then its series, and tags the source', async () => {
    const geo = { table: { rows: [[294, 285, 48.5642, -122.8945, 41.1]] } }
    const cur = { table: { rows: [['t', 294, 285, 0.5, 0.5]] } }
    const ser = { table: { rows: [['2026-10-27T00:30:00Z', 294, 285, 0.5, 0.5]] } }
    const f = vi.fn((u: string) => ok(u.includes('Bathymetry') ? geo : u.includes('0:last') ? ser : cur))
    const r = await fetchSalishSeaCurrent(VENUE, f as never)
    expect(r!.source).toBe('salishseacast')
    expect(r!.depthM).toBe(41.1)
    expect(r!.localMaxKn).toBeCloseTo(Math.hypot(0.5, 0.5) * 1.94384, 5)
    expect(r!.speedKn[0]).toBeCloseTo(Math.hypot(0.5, 0.5) * 1.94384, 5)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('returns null — never a guess — when the service fails', async () => {
    const bad = vi.fn(() => Promise.resolve({ ok: false } as Response))
    expect(await fetchSalishSeaCurrent(VENUE, bad as never)).toBeNull()
    const boom = vi.fn(() => Promise.reject(new Error('network')))
    expect(await fetchSalishSeaCurrent(VENUE, boom as never)).toBeNull()
  })
})
