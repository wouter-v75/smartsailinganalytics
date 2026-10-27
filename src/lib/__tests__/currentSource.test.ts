// Which current source answers, and the one fallback that must NOT happen.
//
// Open-Meteo's marine currents are the global default and they are fine almost
// everywhere. In the Salish Sea they are not: measured 27 Oct 2026 at the San
// Juan Islands they return 0.8-1.2 km/h — under 0.6 kn — in channels that run
// 3 to 6. So when SalishSeaCast cannot answer there, the honest result is null,
// and falling back would replace "unknown" with a confident half a knot.

import { describe, expect, it, vi } from 'vitest'
import { sourceFor, fetchCurrentForPoint } from '../currentSource'

const VENUE = { lat: 48.5627, lon: -122.8946, startDate: '2026-10-27' }
const CERVO = { lat: 41.135, lon: 9.538, startDate: '2026-10-27' }

describe('sourceFor', () => {
  it('picks SalishSeaCast in the Salish Sea and Open-Meteo elsewhere', () => {
    expect(sourceFor(VENUE.lat, VENUE.lon)).toBe('salishseacast')
    expect(sourceFor(48.4514, -122.9686)).toBe('salishseacast')
    expect(sourceFor(CERVO.lat, CERVO.lon)).toBe('open-meteo')
    expect(sourceFor(43.2669, 6.6984)).toBe('open-meteo')
  })
})

describe('fetchCurrentForPoint', () => {
  it('uses Open-Meteo outside the Salish Sea, and says so', async () => {
    const body = {
      latitude: 41.15, longitude: 9.55,
      hourly: {
        time: ['2026-10-27T00:00', '2026-10-27T01:00'],
        ocean_current_velocity: [1.852, 3.704],       // km/h -> 1 kn, 2 kn
        ocean_current_direction: [90, 180],
      },
    }
    const f = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response))
    const r = await fetchCurrentForPoint(CERVO, f as never)
    expect(r!.source).toBe('open-meteo')
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0][0])).toContain('marine-api.open-meteo.com')
  })

  it('uses SalishSeaCast inside it', async () => {
    const geo = { table: { rows: [[294, 285, 48.5642, -122.8945, 41.1]] } }
    const cur = { table: { rows: [['t', 294, 285, 1.0, 0.0]] } }
    const ser = { table: { rows: [['2026-10-27T00:30:00Z', 294, 285, 1.0, 0.0]] } }
    const f = vi.fn((u: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(u.includes('Bathymetry') ? geo : u.includes('0:last') ? ser : cur),
    } as Response))
    const r = await fetchCurrentForPoint(VENUE, f as never)
    expect(r!.source).toBe('salishseacast')
    expect(r!.speedKn[0]).toBeCloseTo(1.94384, 5)
    for (const c of f.mock.calls) expect(String(c[0])).toContain('salishsea.eos.ubc.ca')
  })

  it('returns NULL in the Salish Sea when the local source cannot answer', async () => {
    // The load-bearing assertion: no request to the global model is made, so a
    // 0.5 kn answer cannot reach a crew deciding whether to cross a gate.
    const f = vi.fn(() => Promise.resolve({ ok: false } as Response))
    const r = await fetchCurrentForPoint(VENUE, f as never)
    expect(r).toBeNull()
    for (const c of f.mock.calls) expect(String(c[0])).not.toContain('open-meteo')
  })

  it('returns null outside it too when the global source fails', async () => {
    const f = vi.fn(() => Promise.resolve({ ok: false } as Response))
    expect(await fetchCurrentForPoint(CERVO, f as never)).toBeNull()
  })
})
