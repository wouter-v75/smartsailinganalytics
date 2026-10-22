import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  DAVIS_MAP_CONCURRENCY,
  davisMapNear,
  davisMapStations,
} from '../obsSources'
import { DAVIS_MAP_STATIONS, type DavisMapStation } from '../windObsDavisMap'

const COWES: [number, number] = [50.766, -1.288]

/** A payload the real parser accepts, so these tests exercise it rather than a stub. */
function payload(name: string, lat: number, lon: number, kn: number) {
  return {
    sStation: name,
    lat,
    lng: lon,
    windSpeed: kn,
    windSpeedUnit: 'kt',
    windDirection: 210,
    lastTimestamp: Math.floor(Date.now() / 1000),
  }
}

function station(i: number, lat: number, lon: number): DavisMapStation {
  return { id: `id-${i}`, name: `Station ${i}`, lat, lon }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('davisMapNear', () => {
  it('returns the nearest first', () => {
    const near = davisMapNear(COWES[0], COWES[1], 20)
    const d = near.map((s) => Math.hypot((s.lat - COWES[0]) * 60, (s.lon - COWES[1]) * 60 * Math.cos((COWES[0] * Math.PI) / 180)))
    expect(d).toEqual([...d].sort((a, b) => a - b))
  })

  it('honours the radius', () => {
    // Everything inside 3 nm must also be inside 20 nm, and strictly fewer.
    const tight = davisMapNear(COWES[0], COWES[1], 3)
    const wide = davisMapNear(COWES[0], COWES[1], 20)
    expect(wide.length).toBeGreaterThan(tight.length)
    const wideIds = new Set(wide.map((s) => s.id))
    for (const s of tight) expect(wideIds.has(s.id)).toBe(true)
  })

  it('caps at max, and the default is generous enough to beat Windycator', () => {
    expect(davisMapNear(COWES[0], COWES[1], 60, 4)).toHaveLength(4)
    // The old default of 8 is why the Solent drew 6 stations. Windycator shows
    // 24 over the same water, so a default below that cannot reach parity.
    const all = DAVIS_MAP_STATIONS.length
    expect(davisMapNear(COWES[0], COWES[1], 20_000).length).toBe(Math.min(all, 36))
    expect(davisMapNear(COWES[0], COWES[1], 20_000).length).toBeGreaterThan(24)
  })

  it('never returns a station with an unusable position', () => {
    for (const s of davisMapNear(COWES[0], COWES[1], 60)) {
      expect(Number.isFinite(s.lat)).toBe(true)
      expect(Number.isFinite(s.lon)).toBe(true)
    }
  })
})

describe('davisMapStations', () => {
  it('keeps the caller’s nearest-first order even when the calls finish out of order', async () => {
    const list = [station(0, 50.76, -1.28), station(1, 50.77, -1.29), station(2, 50.78, -1.30)]
    // Deliberately inverted delays: the LAST station answers first.
    const delays: Record<string, number> = { 'id-0': 30, 'id-1': 15, 'id-2': 0 }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const id = url.split('/').pop() as string
      await new Promise((r) => setTimeout(r, delays[id]))
      const i = Number(id.split('-')[1])
      return { ok: true, status: 200, json: async () => payload(`remote ${i}`, list[i].lat, list[i].lon, 10 + i) }
    }))
    const out = await davisMapStations(list)
    expect(out.map((o) => o.id)).toEqual(['wlmap:id-0', 'wlmap:id-1', 'wlmap:id-2'])
  })

  it('skips a station that fails without losing the rest', async () => {
    const list = [station(0, 50.76, -1.28), station(1, 50.77, -1.29), station(2, 50.78, -1.30)]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const id = url.split('/').pop() as string
      if (id === 'id-1') return { ok: false, status: 503, json: async () => ({}) }
      const i = Number(id.split('-')[1])
      return { ok: true, status: 200, json: async () => payload(`s${i}`, list[i].lat, list[i].lon, 10) }
    }))
    const out = await davisMapStations(list)
    expect(out.map((o) => o.id)).toEqual(['wlmap:id-0', 'wlmap:id-2'])
  })

  it('drops a station whose reading the parser refuses, rather than inventing one', async () => {
    const list = [station(0, 50.76, -1.28), station(1, 50.77, -1.29)]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const id = url.split('/').pop() as string
      // Their own "no value" for a station with no wind sensor.
      if (id === 'id-0') return { ok: true, status: 200, json: async () => ({ ...payload('x', 50.76, -1.28, 0), windSpeed: '--' }) }
      return { ok: true, status: 200, json: async () => payload('y', list[1].lat, list[1].lon, 12) }
    }))
    const out = await davisMapStations(list)
    expect(out.map((o) => o.id)).toEqual(['wlmap:id-1'])
  })

  it('opens no more than DAVIS_MAP_CONCURRENCY sockets at once', async () => {
    const list = Array.from({ length: 40 }, (_, i) => station(i, 50.7 + i / 1000, -1.3))
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      const i = Number((url.split('/').pop() as string).split('-')[1])
      return { ok: true, status: 200, json: async () => payload(`s${i}`, list[i].lat, list[i].lon, 9) }
    }))
    const out = await davisMapStations(list)
    expect(out).toHaveLength(40)
    expect(peak).toBeLessThanOrEqual(DAVIS_MAP_CONCURRENCY)
    // And it really did run them in parallel, not one at a time.
    expect(peak).toBeGreaterThan(1)
  })

  it('still runs when the list is shorter than the concurrency', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload('only', 50.76, -1.28, 7) })))
    const out = await davisMapStations([station(0, 50.76, -1.28)])
    expect(out).toHaveLength(1)
    expect(await davisMapStations([])).toEqual([])
  })

  it('prefers the index’s name and position over the blanker detail call', async () => {
    const list = [{ id: 'id-0', name: 'River Hamble Harbour Master', lat: 50.8601, lon: -1.3099 }]
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => payload('', 0.1, 0.2, 11),
    })))
    const [o] = await davisMapStations(list)
    expect(o.name).toBe('River Hamble Harbour Master')
    expect(o.lat).toBeCloseTo(50.8601, 4)
    expect(o.lon).toBeCloseTo(-1.3099, 4)
  })
})

describe('the generated registry', () => {
  it('has no duplicate station ids', () => {
    const ids = DAVIS_MAP_STATIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every station a name and a real position', () => {
    for (const s of DAVIS_MAP_STATIONS) {
      expect(s.name.trim()).not.toBe('')
      expect(Math.abs(s.lat)).toBeLessThanOrEqual(90)
      expect(Math.abs(s.lon)).toBeLessThanOrEqual(180)
      expect(s.lat === 0 && s.lon === 0).toBe(false)
    }
  })

  it('keeps the sentinels the refresh script writes its provenance into', () => {
    // Without these the script exits rather than letting the file keep a tally
    // from a previous run, so their absence is a silent rot, not a loud one.
    const src = readFileSync(join(process.cwd(), 'src/lib/windObsDavisMap.ts'), 'utf8')
    const open = src.indexOf('// <generated>')
    const close = src.indexOf('// </generated>')
    expect(open).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(open)
    expect(src.slice(open, close)).toMatch(/\d+ stations/)
  })
})
