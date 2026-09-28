import { describe, it, expect } from 'vitest'
import { inferFinish } from '../raceWindow'

const T = (h: number, m: number, s = 0) =>
  Date.parse(`2026-09-28T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}Z`)

// 28 September, as the file actually reads: one gun, then two laps, and a third
// "top mark" that is really the finish.
const GUNS = [{ utc: T(14, 5) }]
const ROUNDINGS = [
  { utc: T(13, 59, 59), isTop: true },   // training, before the gun
  { utc: T(14, 23, 29), isTop: true },
  { utc: T(14, 36, 52), isTop: false },
  { utc: T(14, 52, 6), isTop: true },
  { utc: T(15, 9, 33), isTop: false },
  { utc: T(15, 17, 40), isTop: true },   // the finish
]
const DAY_STOP = T(15, 24, 29)

describe('inferFinish', () => {
  it('prefers the crew’s own finish tag', () => {
    const r = inferFinish(GUNS, ROUNDINGS, { taggedUtc: T(15, 18), dayStopUtc: DAY_STOP })
    expect(r.utc).toBe(T(15, 18))
    expect(r.how).toMatch(/finish tag/)
  })

  it('reads a windward finish out of the last top-mark rounding', () => {
    // Without this the day has three top marks and a lap nobody sailed.
    expect(inferFinish(GUNS, ROUNDINGS, { dayStopUtc: DAY_STOP }).utc).toBe(T(15, 17, 40))
  })

  it('ignores roundings from the training before the gun', () => {
    const onlyTraining = [{ utc: T(13, 59, 59), isTop: true }]
    expect(inferFinish(GUNS, onlyTraining, { dayStopUtc: DAY_STOP }).utc).toBe(DAY_STOP)
  })

  it('does not guess a leeward finish', () => {
    // A gate rounding and a leeward finish look identical in the file, and a
    // wrong finish silently throws away the end of the race.
    const leeward = ROUNDINGS.slice(0, -1)
    const r = inferFinish(GUNS, leeward, { dayStopUtc: DAY_STOP })
    expect(r.utc).toBe(DAY_STOP)
    expect(r.how).toMatch(/end of the day/)
  })

  it('says so when there is no gun at all', () => {
    expect(inferFinish([], ROUNDINGS, { dayStopUtc: DAY_STOP }).utc).toBeNull()
  })
})

describe('a finish that cannot be true', () => {
  it('ignores one that lands after the boat came in', () => {
    // 2026-09-28 read 17:17:40 for a day that stopped at 15:24 — the venue
    // offset applied twice. It looks like an ordinary time and quietly throws
    // away whatever falls outside it.
    const r = inferFinish(GUNS, ROUNDINGS, { taggedUtc: T(17, 17, 40), dayStopUtc: DAY_STOP })
    expect(r.utc).toBe(DAY_STOP)
    expect(r.how).toMatch(/outside the sailing day/)
  })

  it('ignores one before the gun', () => {
    expect(inferFinish(GUNS, ROUNDINGS, { taggedUtc: T(13, 0), dayStopUtc: DAY_STOP }).utc).toBe(DAY_STOP)
  })

  it('still takes a good tag', () => {
    expect(inferFinish(GUNS, ROUNDINGS, { taggedUtc: T(15, 18), dayStopUtc: DAY_STOP }).utc).toBe(T(15, 18))
  })
})
