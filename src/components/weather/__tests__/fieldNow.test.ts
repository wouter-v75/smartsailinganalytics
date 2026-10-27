import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain JS module, no types
import { nowFrameIndex, nowFraction } from '../windField'

// A field is only ever as good as which frame it opens on, and the two time
// formats in `field.times` are the trap. Open-Meteo is asked for timezone=auto
// and answers ZONE-LESS strings whose digits already are venue time; Icon-Race
// and the currents grid carry real UTC, and not reliably Z-suffixed. Reading
// the first kind as an instant is the venueTz.js bug, and here it would put
// "now" off by the venue offset — eight frames at Newport seen from Amsterdam.
//
// Every case below is written at a venue whose offset is LARGE and not a whole
// number of frames away from the viewer's, because a test built at a venue that
// shares the browser's zone passes under either reading.

const PDT = 'America/Los_Angeles'   // UTC−7 in October
const CEST = 'Europe/Amsterdam'     // UTC+2 in October

/** An Open-Meteo-shaped field: zone-less venue wall clock, hourly. */
const wallField = (day: string, h0: number, n: number) => ({
  times: Array.from({ length: n }, (_, i) =>
    `${day}T${String(h0 + i).padStart(2, '0')}:00`),
  timesAreUtc: false,
})

/** An Icon-Race-shaped field: true UTC instants, NO Z suffix. */
const utcField = (day: string, h0: number, n: number) => ({
  times: Array.from({ length: n }, (_, i) =>
    `${day}T${String(h0 + i).padStart(2, '0')}:00:00`),
  timesAreUtc: true,
})

describe('nowFrameIndex', () => {
  it('picks the venue wall-clock hour from a zone-less field', () => {
    // 2026-10-27 18:30 UTC is 11:30 PDT. The field runs 00:00–23:00 venue time,
    // so the answer is frame 11 (11:00) or 12 (12:00) — 11:30 is equidistant and
    // the first wins. Read as instants instead it would be frame 18.
    const f = wallField('2026-10-27', 0, 24)
    const i = nowFrameIndex(f, PDT, new Date('2026-10-27T18:30:00Z'))
    expect(i).toBe(11)
    expect(nowFrameIndex(f, PDT, new Date('2026-10-27T18:50:00Z'))).toBe(12)
  })

  it('reads the SAME instant differently in two venues, which is the point', () => {
    const f = (day: string) => wallField(day, 0, 24)
    const t = new Date('2026-10-27T23:30:00Z')   // 16:30 PDT, 00:30 CEST next day
    expect(nowFrameIndex(f('2026-10-27'), PDT, t)).toBe(16)
    // In Amsterdam that instant is already the 28th, so a field covering only
    // the 27th has no frame near it and clamps to its LAST — which is what
    // nowFraction() returning null is for.
    expect(nowFrameIndex(f('2026-10-27'), CEST, t)).toBe(23)
    expect(nowFraction(f('2026-10-27'), CEST, t)).toBeNull()
  })

  it('converts a UTC field into venue time rather than taking it at face value', () => {
    // 20:00 UTC is 13:00 PDT. A UTC field covering 12:00–23:00 UTC has 20:00 at
    // index 8. Taking the digits at face value would answer index 1 (13:00 UTC).
    const f = utcField('2026-10-27', 12, 12)
    expect(nowFrameIndex(f, PDT, new Date('2026-10-27T20:00:00Z'))).toBe(8)
  })

  it('agrees with itself across the two formats for the same real instant', () => {
    // The same 12 hours expressed both ways: 12:00–23:00 UTC is 05:00–16:00 PDT.
    const asUtc = utcField('2026-10-27', 12, 12)
    const asWall = wallField('2026-10-27', 5, 12)
    const t = new Date('2026-10-27T17:00:00Z')   // 10:00 PDT
    expect(nowFrameIndex(asUtc, PDT, t)).toBe(5)
    expect(nowFrameIndex(asWall, PDT, t)).toBe(5)
  })

  it('falls back to sniffing the string when the flag is absent', () => {
    // A field restored from a session store written before `timesAreUtc` existed.
    const zoned = { times: ['2026-10-27T19:00:00Z', '2026-10-27T20:00:00Z'] }
    expect(nowFrameIndex(zoned, PDT, new Date('2026-10-27T20:10:00Z'))).toBe(1)
    const bare = { times: ['2026-10-27T12:00', '2026-10-27T13:00'] }
    expect(nowFrameIndex(bare, PDT, new Date('2026-10-27T20:10:00Z'))).toBe(1)
  })

  it('returns -1 rather than 0 for a field with no times', () => {
    // -1 is what disables the Now button. A 0 here would arm it and silently
    // jump to a frame that is not now.
    expect(nowFrameIndex({ times: [] }, PDT)).toBe(-1)
    expect(nowFrameIndex(null, PDT)).toBe(-1)
    expect(nowFrameIndex({}, PDT)).toBe(-1)
  })
})

describe('nowFraction', () => {
  it('interpolates between frames so the marker creeps', () => {
    const f = wallField('2026-10-27', 0, 25)      // 00:00..24:00, n=25
    // 11:30 PDT = 18:30 UTC sits half way between frames 11 and 12 of 24 steps.
    const half = nowFraction(f, PDT, new Date('2026-10-27T18:30:00Z'))
    expect(half).toBeCloseTo(11.5 / 24, 6)
    const onFrame = nowFraction(f, PDT, new Date('2026-10-27T19:00:00Z'))
    expect(onFrame).toBeCloseTo(12 / 24, 6)
  })

  it('lands on the same percentage the slider thumb uses for that frame', () => {
    // The marker and the thumb label must agree, or they disagree visibly at
    // exactly the moment someone presses Now.
    const f = wallField('2026-10-27', 0, 24)
    const t = new Date('2026-10-27T19:00:00Z')    // 12:00 PDT, exactly frame 12
    const i = nowFrameIndex(f, PDT, t)
    expect(nowFraction(f, PDT, t)).toBeCloseTo(i / (f.times.length - 1), 9)
  })

  it('is null outside the window, both ends', () => {
    const f = wallField('2026-10-27', 6, 12)      // 06:00..17:00 venue time
    expect(nowFraction(f, PDT, new Date('2026-10-27T12:00:00Z'))).toBeNull()  // 05:00 PDT
    expect(nowFraction(f, PDT, new Date('2026-10-28T02:00:00Z'))).toBeNull()  // 19:00 PDT
    expect(nowFraction(f, PDT, new Date('2026-10-27T17:00:00Z'))).not.toBeNull() // 10:00
  })

  it('is null for a field too short to have an axis', () => {
    expect(nowFraction({ times: ['2026-10-27T12:00'], timesAreUtc: false }, PDT)).toBeNull()
    expect(nowFraction({ times: [] }, PDT)).toBeNull()
    expect(nowFraction(null, PDT)).toBeNull()
  })

  it('holds across a DST change, where wall clock is not monotonic', () => {
    // Europe ends summer time at 03:00 local on 25 Oct 2026, so 02:00 CEST
    // recurs. A UTC field spanning it is still strictly ordered in UTC, but its
    // VENUE wall clock repeats an hour — which is why the search skips any pair
    // that does not advance (b <= a) instead of dividing by zero or going
    // backwards. Nothing should throw, and nothing should leave the window.
    const f = utcField('2026-10-25', 0, 6)        // 00:00..05:00 UTC
    for (const h of [0, 1, 2, 3, 4, 5]) {
      const t = new Date(`2026-10-25T0${h}:30:00Z`)
      const frac = nowFraction(f, CEST, t)
      if (frac != null) {
        expect(frac).toBeGreaterThanOrEqual(0)
        expect(frac).toBeLessThanOrEqual(1)
      }
      expect(nowFrameIndex(f, CEST, t)).toBeGreaterThanOrEqual(0)
    }
  })
})
