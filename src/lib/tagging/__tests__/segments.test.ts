import { describe, it, expect } from 'vitest'
import {
  segmentDay, segmentAt, racesOf, isInferredEnd, racingRoundingFilter,
  DEFAULT_WARNING_LEAD_SEC, type DaySegment,
} from '../segments'

const T = (hhmm: string) => Date.parse(`2026-09-11T${hhmm}:00Z`)
/** With seconds, for the one assertion that turns on them. */
const TS = (hhmmss: string) => Date.parse(`2026-09-11T${hhmmss}Z`)
const shape = (segs: DaySegment[]) => segs.map((s) => s.key)
const span = (s: DaySegment) => [new Date(s.t0).toISOString().slice(11, 16), new Date(s.t1).toISOString().slice(11, 16)]

describe('segmentDay', () => {
  it('cuts a two-race day into pre / race / between / race / post', () => {
    const segs = segmentDay({
      guns: [{ utc: T('12:00'), raceNum: 1 }, { utc: T('14:00'), raceNum: 2 }],
      markRoundings: [{ utc: T('12:20') }, { utc: T('12:50') }, { utc: T('14:25') }, { utc: T('14:55') }],
      dayStartUtc: T('10:30'),
      dayStopUtc: T('16:00'),
    })
    expect(shape(segs)).toEqual(['pre', 'r1', 'btw1', 'r2', 'post'])
  })

  it('starts a race at the 5-minute gun, not the start gun', () => {
    const [, r1] = segmentDay({
      guns: [{ utc: T('12:00') }],
      dayStartUtc: T('10:30'),
      dayStopUtc: T('14:00'),
    })
    expect(r1.t0).toBe(T('12:00') - DEFAULT_WARNING_LEAD_SEC * 1000)
    expect(span(r1)[0]).toBe('11:55')
  })

  it('honours a class that runs a 3-minute sequence', () => {
    const [, r1] = segmentDay({
      guns: [{ utc: T('12:00') }],
      dayStartUtc: T('11:00'), dayStopUtc: T('13:00'),
      warningLeadSec: 180,
    })
    expect(span(r1)[0]).toBe('11:57')
  })

  it('infers a finish from the last mark rounding plus a grace', () => {
    const segs = segmentDay({
      guns: [{ utc: T('12:00') }],
      markRoundings: [{ utc: T('12:20') }, { utc: T('12:50') }],
      dayStartUtc: T('11:00'), dayStopUtc: T('15:00'),
      finishGraceSec: 180,
    })
    const r1 = segs.find((s) => s.key === 'r1')!
    expect(span(r1)[1]).toBe('12:53')
    expect(r1.endSource).toBe('last-mark')
    expect(isInferredEnd(r1)).toBe(true)
  })

  it('prefers a real finish over any inference, and says so', () => {
    const segs = segmentDay({
      guns: [{ utc: T('12:00'), raceNum: 1 }],
      finishes: [{ utc: T('13:07'), raceNum: 1 }],
      markRoundings: [{ utc: T('12:50') }],
      dayStartUtc: T('11:00'), dayStopUtc: T('15:00'),
    })
    const r1 = segs.find((s) => s.key === 'r1')!
    expect(span(r1)[1]).toBe('13:07')
    expect(r1.endSource).toBe('finish')
    expect(isInferredEnd(r1)).toBe(false)
  })

  it('attaches an unnumbered finish to the race that was running', () => {
    const segs = segmentDay({
      guns: [{ utc: T('12:00') }, { utc: T('14:00') }],
      finishes: [{ utc: T('13:00') }],   // no raceNum — belongs to race 1
      dayStartUtc: T('11:00'), dayStopUtc: T('16:00'),
    })
    expect(segs.find((s) => s.key === 'r1')!.endSource).toBe('finish')
    expect(span(segs.find((s) => s.key === 'r1')!)[1]).toBe('13:00')
  })

  it('never lets a race outlast the next race’s warning signal', () => {
    // A mark rounding late in the "race 1" window would otherwise push its
    // inferred finish past race 2's warning gun.
    const segs = segmentDay({
      guns: [{ utc: T('12:00') }, { utc: T('13:00') }],
      markRoundings: [{ utc: T('12:54') }],
      dayStartUtc: T('11:00'), dayStopUtc: T('15:00'),
      finishGraceSec: 600,
    })
    const r1 = segs.find((s) => s.key === 'r1')!
    const r2 = segs.find((s) => s.key === 'r2')!
    expect(r1.t1).toBeLessThanOrEqual(r2.t0)
    expect(span(r2)[0]).toBe('12:55')
  })

  it('emits no between-segment for back-to-back races', () => {
    const segs = segmentDay({
      guns: [{ utc: T('12:00') }, { utc: T('13:00') }],
      dayStartUtc: T('11:00'), dayStopUtc: T('15:00'),
    })
    // No marks and no finishes, so each race runs to the next known boundary:
    // race 1 to race 2's warning (nothing sits between), and race 2 to the end
    // of the day (so there is no 'post' either). Absorbing the rest of the day
    // is the honest answer when nothing says when racing stopped — and
    // endSource records that it was inferred rather than recorded.
    expect(shape(segs)).toEqual(['pre', 'r1', 'r2'])
    expect(segs.find((s) => s.key === 'r2')!.endSource).toBe('day-stop')
    expect(isInferredEnd(segs.find((s) => s.key === 'r2')!)).toBe(true)
  })

  it('treats a day with no guns as one training session', () => {
    const segs = segmentDay({ dayStartUtc: T('10:00'), dayStopUtc: T('14:00') })
    expect(shape(segs)).toEqual(['session'])
    expect(segs[0].kind).toBe('session')
    expect(segs[0].raceNum).toBeNull()
  })

  it('falls back to the data extent when the event file has no day bounds', () => {
    const segs = segmentDay({
      guns: [{ utc: T('12:00') }],
      dataT0: T('10:45'), dataT1: T('14:30'),
    })
    expect(span(segs[0])).toEqual(['10:45', '11:55'])
    expect(segs[segs.length - 1].endSource).toBe('data-end')
  })

  it('drops the pre-race segment when racing starts at the day boundary', () => {
    const segs = segmentDay({
      guns: [{ utc: T('12:00') }],
      dayStartUtc: T('11:55'), dayStopUtc: T('14:00'),
    })
    expect(shape(segs)).toEqual(['r1'])
  })

  it('numbers races from the guns, not from array position', () => {
    const segs = segmentDay({
      guns: [{ utc: T('14:00'), raceNum: 4 }, { utc: T('12:00'), raceNum: 3 }],
      markRoundings: [{ utc: T('12:50') }, { utc: T('14:50') }],
      dayStartUtc: T('11:00'), dayStopUtc: T('16:00'),
    })
    expect(shape(segs)).toEqual(['pre', 'r3', 'btw3', 'r4', 'post'])
    expect(segs.find((s) => s.key === 'btw3')!.label).toBe('Between races 3–4')
  })

  it('produces segments that tile the day without overlapping', () => {
    const segs = segmentDay({
      guns: [{ utc: T('12:00') }, { utc: T('14:00') }],
      markRoundings: [{ utc: T('12:50') }, { utc: T('14:50') }],
      dayStartUtc: T('10:30'), dayStopUtc: T('16:00'),
    })
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].t0).toBe(segs[i - 1].t1)   // contiguous
      expect(segs[i].t1).toBeGreaterThan(segs[i].t0)  // non-empty
    }
    expect(segs[0].t0).toBe(T('10:30'))
    expect(segs[segs.length - 1].t1).toBe(T('16:00'))
  })

  it('survives junk input', () => {
    expect(segmentDay({})).toEqual([])
    expect(segmentDay({ guns: [] })).toEqual([])
    expect(segmentDay({ guns: [{ utc: NaN }], dayStartUtc: T('10:00'), dayStopUtc: T('12:00') }))
      .toEqual([expect.objectContaining({ kind: 'session' })])
    expect(segmentDay({ dayStartUtc: T('12:00'), dayStopUtc: T('10:00') })).toEqual([])
  })
})

describe('segmentAt', () => {
  const segs = segmentDay({
    guns: [{ utc: T('12:00') }, { utc: T('14:00') }],
    markRoundings: [{ utc: T('12:50') }, { utc: T('14:50') }],
    dayStartUtc: T('10:30'), dayStopUtc: T('16:00'),
  })

  it('finds the segment a moment belongs to', () => {
    expect(segmentAt(segs, T('11:00'))!.key).toBe('pre')
    expect(segmentAt(segs, T('11:58'))!.key).toBe('r1')   // inside the start sequence
    expect(segmentAt(segs, T('12:30'))!.key).toBe('r1')
    expect(segmentAt(segs, T('13:30'))!.key).toBe('btw1')
    expect(segmentAt(segs, T('14:30'))!.key).toBe('r2')
    expect(segmentAt(segs, T('15:30'))!.key).toBe('post')
  })

  it('puts a boundary moment in exactly one segment', () => {
    const r1 = segs.find((s) => s.key === 'r1')!
    expect(segmentAt(segs, r1.t0)!.key).toBe('r1')       // owns its start
    expect(segmentAt(segs, r1.t1)!.key).toBe('btw1')     // not its end
  })

  it('owns the very end of the day', () => {
    expect(segmentAt(segs, T('16:00'))!.key).toBe('post')
  })

  it('returns null outside the day, and for junk', () => {
    expect(segmentAt(segs, T('09:00'))).toBeNull()
    expect(segmentAt(segs, T('17:00'))).toBeNull()
    expect(segmentAt(segs, NaN)).toBeNull()
    expect(segmentAt([], T('12:00'))).toBeNull()
  })
})

describe('racesOf', () => {
  it('returns just the races, in order', () => {
    const segs = segmentDay({
      guns: [{ utc: T('12:00') }, { utc: T('14:00') }],
      markRoundings: [{ utc: T('12:50') }, { utc: T('14:50') }],
      dayStartUtc: T('10:30'), dayStopUtc: T('16:00'),
    })
    expect(racesOf(segs).map((s) => s.raceNum)).toEqual([1, 2])
  })

  it('is empty on a training day', () => {
    expect(racesOf(segmentDay({ dayStartUtc: T('10:00'), dayStopUtc: T('14:00') }))).toEqual([])
  })
})

describe('racingRoundingFilter — a rounding only counts while racing', () => {
  const M = 60_000
  const H = 60 * M
  // Two races off one day: guns at 12:00 and 14:00, roundings in each.
  const day = (over: Partial<Parameters<typeof segmentDay>[0]> = {}) => segmentDay({
    guns: [{ utc: T('12:00'), raceNum: 1 }, { utc: T('14:00'), raceNum: 2 }],
    markRoundings: [{ utc: T('12:20') }, { utc: T('12:50') }, { utc: T('14:20') }],
    dayStartUtc: T('10:00'), dayStopUtc: T('16:00'),
    ...over,
  })
  const filt = (over = {}, opts = {}) =>
    racingRoundingFilter({
      segments: day(over),
      gunUtcs: [T('12:00'), T('14:00')],
      ...opts,
    })

  it('keeps a rounding inside a race', () => {
    expect(filt()(T('12:20'))).toBe(true)
  })

  it('throws away the warm-up', () => {
    // Sailing round a mark an hour before the first gun is practice, and a
    // "Top mark" from it is something the crew has to go and delete.
    expect(filt()(T('10:30'))).toBe(false)
    expect(filt()(T('11:00'))).toBe(false)
  })

  it('throws away the sail home', () => {
    expect(filt()(T('15:30'))).toBe(false)
  })

  it('throws away the warning period, which is inside the race SEGMENT', () => {
    // The segment starts at the warning signal; the racing starts at the gun.
    expect(filt()(T('11:57'))).toBe(false)
    expect(filt()(T('12:00'))).toBe(true)
  })

  // The failure this rule exists for: a STRAY rounding in the pre-start of race
  // 2 is itself what segmentDay uses to guess where race 1 finished — so the
  // stray one lands inside the race it invented for itself and looks entirely
  // legitimate. Guns at 12:00 and 14:00; a real rounding at 12:20 and a spurious
  // one at 13:40 while everybody mills about waiting for the next start.
  const strayDay = segmentDay({
    guns: [{ utc: T('12:00'), raceNum: 1 }, { utc: T('14:00'), raceNum: 2 }],
    markRoundings: [{ utc: T('12:20') }, { utc: T('13:40') }],
    dayStartUtc: T('10:00'), dayStopUtc: T('16:00'),
  })
  const strayFilter = (opts = {}) =>
    racingRoundingFilter({ segments: strayDay, gunUtcs: [T('12:00'), T('14:00')], ...opts })

  it('the stray rounding IS inside the race, which is why rule 1 is not enough', () => {
    const r1 = strayDay.find((x) => x.key === 'r1')!
    expect(r1.endSource).toBe('last-mark')
    expect(T('13:40') >= r1.t0 && T('13:40') < r1.t1).toBe(true)
  })

  it('blacks out the half hour before a gun when the finish was only guessed', () => {
    expect(strayFilter()(T('13:40'))).toBe(false)
    expect(strayFilter()(T('13:59'))).toBe(false)
    // And leaves the genuine one alone.
    expect(strayFilter()(T('12:20'))).toBe(true)
  })

  it('believes a recorded finish, right up to the next gun', () => {
    const f = racingRoundingFilter({
      segments: segmentDay({
        guns: [{ utc: T('12:00'), raceNum: 1 }, { utc: T('14:00'), raceNum: 2 }],
        markRoundings: [{ utc: T('12:20') }, { utc: T('13:40') }],
        finishes: [{ utc: T('13:50'), raceNum: 1 }],
        dayStartUtc: T('10:00'), dayStopUtc: T('16:00'),
      }),
      gunUtcs: [T('12:00'), T('14:00')],
    })
    // Inside race 1, inside the blackout window — but the finish is a fact, so
    // the boat really was still racing and the rounding really did happen.
    expect(f(T('13:40'))).toBe(true)
    expect(f(T('13:55'))).toBe(false)     // after the recorded finish
  })

  it('takes the blackout as a setting, for a class that starts differently', () => {
    expect(strayFilter({ preGunBlackoutSec: 60 })(T('13:40'))).toBe(true)
    expect(strayFilter({ preGunBlackoutSec: 60 })(TS('13:59:30'))).toBe(false)
  })

  it('keeps everything on a training day — there is no race to be outside of', () => {
    // The whole reason the log fallback exists: a day with no event file still
    // wants its roundings.
    const f = racingRoundingFilter({
      segments: segmentDay({ dayStartUtc: T('10:00'), dayStopUtc: T('16:00') }),
      gunUtcs: [],
    })
    expect(f(T('10:30'))).toBe(true)
    expect(f(T('15:30'))).toBe(true)
  })

  it('refuses a time that is not a time', () => {
    expect(filt()(NaN)).toBe(false)
    expect(filt()(undefined as unknown as number)).toBe(false)
  })
})
