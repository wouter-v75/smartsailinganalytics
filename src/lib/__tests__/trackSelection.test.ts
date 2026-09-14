import { describe, it, expect } from 'vitest'
import { nearestTrackIndex, orderedRange, inRange, phaseInRange } from '../trackSelection'

// Out along y = 0 (indices 0–10, x 0…100), back along y = 3 (indices 11–21, x 100…0):
// two legs 3 px apart, like a lap on a windward-leeward course.
const track = [
  ...Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: 0 })),
  ...Array.from({ length: 11 }, (_, i) => ({ x: 100 - i * 10, y: 3 })),
]

describe('nearestTrackIndex', () => {
  it('takes the nearest point when nothing is picked yet', () => {
    expect(nearestTrackIndex(track, { x: 51, y: 0.5 }, 12)).toBe(5)
    expect(nearestTrackIndex(track, { x: 49, y: 2.8 }, 12)).toBe(16)
  })

  it('stays on the leg the drag is on where legs overlap', () => {
    expect(nearestTrackIndex(track, { x: 62, y: 0.5 }, 12, 15)).toBe(15)   // back leg, x 60
    expect(nearestTrackIndex(track, { x: 62, y: 2.8 }, 12, 4)).toBe(6)     // out leg, x 60
  })

  it('returns nothing away from the track', () => {
    expect(nearestTrackIndex(track, { x: 50, y: 40 }, 12)).toBeNull()
    expect(nearestTrackIndex([], { x: 0, y: 0 }, 12)).toBeNull()
  })
})

describe('ranges', () => {
  it('orders a drag in either direction and tests times and phases against it', () => {
    expect(orderedRange(20, 10)).toEqual([10, 20])
    expect(inRange(15, [10, 20])).toBe(true)
    expect(inRange(25, [10, 20])).toBe(false)
    expect(inRange(25, null)).toBe(true)
    expect(phaseInRange({ utc: 0, endUtc: 30 }, [10, 20])).toBe(true)    // midpoint 15
    expect(phaseInRange({ utc: 14, endUtc: 44 }, [10, 20])).toBe(false)  // midpoint 29
  })
})
