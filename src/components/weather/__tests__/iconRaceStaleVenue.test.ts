import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { iconRaceGridForPoint } from '../openMeteo'

// Porto Cervo on 31 Aug 2026, the case this gate exists for: the 1 km nest's grid
// had been held since 12 Aug, the 2 km parent ran that morning. Clicking the three
// points used to auto-select the 1 km and render 12 August as today's forecast.
//
// Coordinates sit inside BOTH venue boxes (1 km: 9.45/41.22 ±0.24; 2 km:
// 9.55/41.13 ±0.31), so the only thing separating them is cycle freshness.
const PC_LAT = 41.22
const PC_LON = 9.45

const STALE_1KM = {
  venue: 'porto_cervo', cycle: '2026081200', heights: [10, 30],
  time: ['2026-08-12T04:00:00Z', '2026-08-12T12:00:00Z', '2026-08-12T18:00:00Z'],
  cells: [{ lat: 41.22, lon: 9.45, spd: { 10: [12, 14, 11] }, dir: { 10: [200, 210, 220] } }],
}
const LIVE_2KM = {
  venue: 'porto_cervo', cycle: '2026083100', heights: [10, 30],
  time: ['2026-08-31T06:00:00Z', '2026-08-31T18:00:00Z', '2026-09-01T18:00:00Z'],
  cells: [{ lat: 41.13, lon: 9.55, spd: { 10: [9, 15, 13] }, dir: { 10: [180, 190, 200] } }],
}

describe('SSA-Race venue selection at Porto Cervo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T09:00:00Z'))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('porto_cervo_1km') ? STALE_1KM : LIVE_2KM),
    })))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('drops the 1 km nest whose cycle has elapsed', async () => {
    expect(await iconRaceGridForPoint(PC_LAT, PC_LON, 'ICONRACE_1KM')).toBeNull()
  })

  it('still serves the 2 km parent that ran today', async () => {
    const got = await iconRaceGridForPoint(PC_LAT, PC_LON, 'ICONRACE')
    expect(got).not.toBeNull()
    expect(got!.grid.cycle).toBe('2026083100')
    expect(got!.venue.domain).toBe('porto_cervo_2km')
  })

  it('serves the 1 km again once its nest resumes tomorrow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...STALE_1KM,
        cycle: '2026090100',
        time: ['2026-09-01T04:00:00Z', '2026-09-01T18:00:00Z'],
      }),
    })))
    vi.setSystemTime(new Date('2026-09-01T09:00:00Z'))
    const got = await iconRaceGridForPoint(PC_LAT, PC_LON, 'ICONRACE_1KM')
    expect(got).not.toBeNull()
    expect(got!.grid.cycle).toBe('2026090100')
  })
})
