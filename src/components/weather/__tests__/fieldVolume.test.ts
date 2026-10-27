// The vertical stack the 3D viewer draws arrows from.
//
// Only the SSA-Race path used to build one, so every Open-Meteo model fell back
// to single-level surface vectors in 3D — including HRDPS, whose 10/40/80/120
// ladder is the reason it was added. The contract is narrow and entirely
// implicit in field3dUtils, so it is pinned here: cell order, per-height keys,
// and the UNIT, which is the one that fails silently.

import { describe, expect, it, vi } from 'vitest'
import { fetchWindField } from '../windField'
import { MODELS } from '../openMeteo'
import { defaultLevels } from '../field3dUtils'
import { buildProfileVectors, sampleVolumeAtHeight } from '../field3dUtils'

/**
 * Identical points, one per sample cell, each with the model's own ladder.
 * The COUNT matters: fetchWindField samples (fieldGrid || 10)^2 points and
 * refuses a reply with a different number, so a fixture of a fixed 100 only
 * ever tests the coarse models. HRDPS samples 16x16.
 */
const pointCount = (key: string) => ((MODELS[key].fieldGrid || 10) ** 2)
function omPoints(heights: number[], speedMs: number, dirDeg: number, n: number) {
  const hourly: Record<string, unknown> = { time: ['2026-10-27T00:00', '2026-10-27T01:00'] }
  for (const h of heights) {
    hourly[`wind_speed_${h}m`] = [speedMs, speedMs]
    hourly[`wind_direction_${h}m`] = [dirDeg, dirDeg]
  }
  return new Array(n).fill({ latitude: 48.5, longitude: -122.9, hourly })
}

const withFetch = async (body: unknown, fn: () => Promise<unknown>) => {
  const prev = globalThis.fetch
  globalThis.fetch = vi.fn(() => Promise.resolve({
    ok: true, text: () => Promise.resolve(JSON.stringify(body)),
  } as Response)) as never
  try { return await fn() } finally { globalThis.fetch = prev }
}

describe('fetchWindField builds a vertical stack', () => {
  it('carries every published level for HRDPS', async () => {
    const f = await withFetch(omPoints([10, 40, 80, 120], 10, 270, pointCount('HRDPS')), () =>
      fetchWindField({ modelKey: 'HRDPS', lat: 48.5627, lon: -122.8946, height: 30, timezone: 'UTC' })) as any
    expect(f.volume).toBeTruthy()
    expect(f.volume.heights).toEqual([10, 40, 80, 120])
    expect(f.volume.cellAt).toHaveLength(f.header.nx * f.header.ny)
    expect(f.volume.cellAt[0].spd['40']).toHaveLength(2)
  })

  it('stores speed in KM/H, which is what the readers assume', async () => {
    // sampleVolumeAtHeight and buildProfileVectors both do `sp * 0.539957`
    // (km/h -> kn). Handing them m/s under-reads every arrow by 3.6x, and
    // nothing would complain — the arrows would simply be too short.
    const f = await withFetch(omPoints([10, 40, 80, 120], 10, 270, pointCount('HRDPS')), () =>
      fetchWindField({ modelKey: 'HRDPS', lat: 48.5627, lon: -122.8946, height: 30, timezone: 'UTC' })) as any
    expect(f.volume.cellAt[0].spd['10'][0]).toBeCloseTo(36, 6)      // 10 m/s = 36 km/h
    const s = sampleVolumeAtHeight(f.volume, 0, 40, 48.5627, -122.8946)!
    expect(s.kt).toBeCloseTo(10 * 1.94384, 2)                        // 10 m/s ~ 19.44 kn
  })

  it('produces arrows at EVERY selected level, not one', async () => {
    const f = await withFetch(omPoints([10, 40, 80, 120], 10, 270, pointCount('HRDPS')), () =>
      fetchWindField({ modelKey: 'HRDPS', lat: 48.5627, lon: -122.8946, height: 30, timezone: 'UTC' })) as any
    const levels = defaultLevels(f.volume.heights)
    const arrows = buildProfileVectors(f.volume, 0, levels)
    expect(arrows.length).toBeGreaterThan(0)
    expect([...new Set(arrows.map((a: { altM: number }) => a.altM))].sort((a, b) => a - b)).toEqual(levels)
  })

  it('does not claim a volume for a single-level model', async () => {
    // METNO and ICON-2I publish 10 m only; a one-button level picker is worse
    // than the surface-vector path that already handles that case.
    const f = await withFetch(omPoints([10], 8, 180, pointCount('METNO')), () =>
      fetchWindField({ modelKey: 'METNO', lat: 59.03, lon: 10.15, height: 10, timezone: 'UTC' })) as any
    expect(f.volume).toBeUndefined()
  })
})

describe('the default levels match what was asked for', () => {
  it('gives HRDPS every published level, 120 m included', () => {
    expect(defaultLevels([10, 40, 80, 120])).toEqual([10, 40, 80, 120])
  })

  it('and HRRR the same, from its coarser ladder', () => {
    expect(defaultLevels([10, 80])).toEqual([10, 80])
  })

  it('stops above 120 m, so a deep ladder does not fill the view', () => {
    // ECMWF publishes to 200 m and ICON to 180; those upper levels are
    // synoptic context, not racing air, and drawing them by default buries
    // the ones that matter.
    expect(defaultLevels([10, 80, 120, 180])).toEqual([10, 80, 120])
    expect(defaultLevels([10, 80, 100, 120, 180, 200])).toEqual([10, 80, 100, 120])
    expect(defaultLevels([10, 20, 50, 100, 150, 200])).toEqual([10, 20, 50, 100])
  })

  it('still shows something when every level is above the cap', () => {
    expect(defaultLevels([150, 200])).toEqual([150])
  })

  it('never invents a level the model does not publish', () => {
    for (const hs of [[10, 40, 80, 120], [10, 80], [10, 80, 120, 180]]) {
      for (const l of defaultLevels(hs)) expect(hs).toContain(l)
    }
  })
})
