import { describe, expect, it, vi } from 'vitest'
import { fetchGfsHpblField, fetchHpblField } from '../windField'

describe('fetchHpblField exists and takes a point', () => {
  // The source selection itself (SSA-Race first, GFS on any failure) is not
  // mocked here: mocking the module under test poisons vitest's registry for
  // every later import in the file, which is how the first version of this
  // file ended up asserting against `undefined`.
  it('is exported for the viewer to call', () => {
    expect(typeof fetchHpblField).toBe('function')
  })
})

describe('the hpbl field shape is the one the renderer expects', () => {
  it('frames carry `scalar`, and the field is flagged isHpbl', async () => {
    const { fetchGfsHpblField } = await import('../windField')
    const body = {
      latitude: 48.5, longitude: -122.9,
      hourly: { time: ['2026-10-27T00:00', '2026-10-27T01:00'], boundary_layer_height: [320, 880] },
    }
    // 10x10 sample grid -> Open-Meteo answers with an array of 100 points
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(new Array(100).fill(body))),
    } as Response))
    const prev = globalThis.fetch
    globalThis.fetch = fetchMock as never
    try {
      const f = await fetchGfsHpblField({ lat: 48.5627, lon: -122.8946, timezone: 'America/Los_Angeles' })
      expect(f.isHpbl).toBe(true)
      expect(f.hpblSource).toContain('GFS')
      expect(f.frames).toHaveLength(2)
      expect(f.frames[0].scalar).toHaveLength(100)
      expect(f.frames[0].scalar[0]).toBe(320)
      expect(f.frames[1].scalar[0]).toBe(880)
      expect(f.scalarMax).toBe(880)
      // header must describe the sampled box, or the overlay lands elsewhere
      expect(f.header.nx).toBe(10)
      expect(f.header.ny).toBe(10)
      expect(f.times).toHaveLength(2)
      expect(f.labels).toHaveLength(2)
    } finally {
      globalThis.fetch = prev
    }
  })

  it('refuses an area GFS has no data for, rather than drawing nothing', async () => {
    const { fetchGfsHpblField } = await import('../windField')
    const empty = new Array(100).fill({ latitude: 0, longitude: 0, hourly: { time: [], boundary_layer_height: [] } })
    const prev = globalThis.fetch
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true, text: () => Promise.resolve(JSON.stringify(empty)),
    } as Response)) as never
    try {
      await expect(fetchGfsHpblField({ lat: 48.5, lon: -122.9, timezone: 'UTC' }))
        .rejects.toThrow(/no boundary-layer data/)
    } finally {
      globalThis.fetch = prev
    }
  })
})
