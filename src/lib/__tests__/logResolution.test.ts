import { describe, it, expect } from 'vitest'
import { logRateHz, isSubSecondLog, thinToOneHz, lidarSailsIn } from '../logResolution'

const T0 = Date.UTC(2026, 8, 12, 10, 10, 0)
// 4 Hz with the export's jitter: 00.872, 01.122, 01.372, …
const fourHz = Array.from({ length: 400 }, (_, i) => ({ utc: T0 + 872 + i * 250 + (i % 3) * 3, i }))
const oneHz = Array.from({ length: 100 }, (_, i) => ({ utc: T0 + i * 1000 + (i % 2) * 40 }))

describe('log sample rate', () => {
  it('tells a 4 Hz lidar export from a 1 Hz log', () => {
    expect(logRateHz(fourHz)).toBe(4)
    expect(logRateHz(oneHz)).toBe(1)
    expect(isSubSecondLog(fourHz)).toBe(true)
    expect(isSubSecondLog(oneHz)).toBe(false)
    expect(logRateHz([])).toBeNull()
  })
})

describe('thinToOneHz', () => {
  it('keeps the first real row of every UTC second', () => {
    const thin = thinToOneHz(fourHz)
    expect(thin).toHaveLength(101)                     // 00.872 … 100.622 spans 101 whole seconds
    expect(thin.slice(0, 3).map(r => r.i)).toEqual([0, 1, 5])
    expect(thin[1]).toBe(fourHz[1])                    // the row itself, not a copy or an average
    expect(logRateHz(thin)).toBe(1)
  })

  it('leaves a 1 Hz log as it is', () => {
    expect(thinToOneHz(oneHz)).toHaveLength(100)
  })
})

describe('lidarSailsIn', () => {
  it('lists the sails with measured shape, ignoring target-only columns', () => {
    const rows = [{ utc: 1, mnCa25: 8, tSpiCa25: 10 }, { utc: 2, jibDr50: 40, spiCa25: null }]
    expect(lidarSailsIn(rows).map(s => s.label)).toEqual(['Main', 'Jib'])
    expect(lidarSailsIn([{ utc: 1, bsp: 10 }])).toEqual([])
  })
})
