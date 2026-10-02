import { describe, it, expect } from 'vitest'
import {
  EMPTY_COVERAGE, clampToFootage, covers, gapsBetween, isEmptyCoverage,
  mergeSpans, normaliseCoverage, spanTotal, spansOnDay,
} from '../droneCoverage'

const T = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 30, h, m, s)

describe('mergeSpans', () => {
  it('closes the seam where the drone split a file', () => {
    // 30 September: three files inside six seconds. Drawn as written they put
    // two holes in a continuous piece of filming.
    const merged = mergeSpans([
      { from: T(14, 43, 34), to: T(14, 46, 17) },
      { from: T(14, 46, 20), to: T(14, 46, 22) },
      { from: T(14, 46, 23), to: T(14, 46, 24) },
    ])
    expect(merged).toEqual([{ from: T(14, 43, 34), to: T(14, 46, 24) }])
  })

  it('does NOT close a real gap', () => {
    // The 14 minutes the drone spent on the deck is the whole point of the
    // picture; a join generous enough to swallow it would hide the answer.
    const merged = mergeSpans([
      { from: T(14, 26, 36), to: T(14, 29, 9) },
      { from: T(14, 43, 34), to: T(14, 46, 17) },
    ])
    expect(merged).toHaveLength(2)
  })

  it('merges overlaps and sorts out-of-order input', () => {
    expect(mergeSpans([
      { from: T(15, 0), to: T(15, 5) },
      { from: T(14, 0), to: T(14, 30) },
      { from: T(14, 20), to: T(14, 40) },
    ])).toEqual([
      { from: T(14, 0), to: T(14, 40) },
      { from: T(15, 0), to: T(15, 5) },
    ])
  })

  it('drops the impossible rather than drawing it', () => {
    expect(mergeSpans([
      { from: T(14, 0), to: T(14, 0) },            // zero length
      { from: T(15, 0), to: T(14, 0) },            // backwards
      { from: NaN, to: T(14, 0) },
    ] as never)).toEqual([])
  })

  it('survives nothing at all', () => {
    expect(mergeSpans([])).toEqual([])
    expect(mergeSpans(null as never)).toEqual([])
  })
})

describe('gapsBetween — why a tag produced no clip', () => {
  it('names the hole the top mark fell into', () => {
    const footage = [
      { from: T(14, 19, 50), to: T(14, 29, 9) },
      { from: T(14, 43, 34), to: T(14, 59, 53) },
    ]
    const gaps = gapsBetween(footage)
    expect(gaps).toEqual([{ from: T(14, 29, 9), to: T(14, 43, 34) }])
    expect(covers(footage, T(14, 42, 24))).toBe(false)   // the top mark
    expect(covers(footage, T(14, 51, 11))).toBe(true)    // the gybe
  })

  it('counts the day before the first frame and after the last', () => {
    const gaps = gapsBetween([{ from: T(14, 0), to: T(15, 0) }], T(13, 0), T(16, 0))
    expect(gaps).toEqual([
      { from: T(13, 0), to: T(14, 0) },
      { from: T(15, 0), to: T(16, 0) },
    ])
  })

  it('is the whole day when the drone never flew', () => {
    expect(gapsBetween([], T(13, 0), T(16, 0))).toEqual([{ from: T(13, 0), to: T(16, 0) }])
  })
})

describe('clampToFootage — a clip cannot exist outside its footage', () => {
  it('trims a padded window back to where the drone was recording', () => {
    // A top mark's window reaches 90 s past the rounding; the drone may have
    // stopped at 60. The dark band must not overhang the light one.
    const clipped = clampToFootage(
      [{ from: T(14, 50, 0), to: T(14, 53, 0) }],
      [{ from: T(14, 51, 0), to: T(14, 52, 0) }]
    )
    expect(clipped).toEqual([{ from: T(14, 51, 0), to: T(14, 52, 0) }])
  })

  it('splits a clip that straddles a gap', () => {
    const clipped = clampToFootage(
      [{ from: T(14, 0), to: T(15, 0) }],
      [{ from: T(14, 0), to: T(14, 20) }, { from: T(14, 40), to: T(15, 0) }]
    )
    expect(clipped).toHaveLength(2)
  })

  it('drops a clip with no footage under it at all', () => {
    expect(clampToFootage(
      [{ from: T(16, 0), to: T(16, 1) }],
      [{ from: T(14, 0), to: T(15, 0) }]
    )).toEqual([])
  })
})

describe('spanTotal', () => {
  it('counts overlapping spans once', () => {
    expect(spanTotal([
      { from: T(14, 0), to: T(14, 10) },
      { from: T(14, 5), to: T(14, 15) },
    ])).toBe(15 * 60_000)
  })
})

describe('normaliseCoverage', () => {
  it('reads what the script writes', () => {
    const c = normaliseCoverage({
      footage: [{ from: T(14, 0), to: T(14, 10) }],
      clips: [{ from: T(14, 2), to: T(14, 3) }],
      scannedAt: '2026-09-30T18:00:00.000Z', tzOffsetMin: 120, fileCount: 11,
    })
    expect(c.footage).toHaveLength(1)
    expect(c.tzOffsetMin).toBe(120)
    expect(c.fileCount).toBe(11)
  })

  it('never throws on rubbish — a track must not fail over a stored column', () => {
    for (const junk of [null, undefined, 0, 'x', [], { footage: 'no' }, { clips: [1, 2] }]) {
      expect(() => normaliseCoverage(junk)).not.toThrow()
    }
    expect(normaliseCoverage(null)).toEqual(EMPTY_COVERAGE)
  })

  it('knows an unscanned day from one with no footage', () => {
    expect(isEmptyCoverage(normaliseCoverage(null))).toBe(true)
    expect(isEmptyCoverage(normaliseCoverage({ footage: [{ from: 1, to: 2 }] }))).toBe(false)
  })
})

describe('spansOnDay', () => {
  // The card's own wall clock, which is the frame the scan arrives in.
  const W = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h, m)

  it('keeps the day asked for and drops the rest of the card', () => {
    // A card straight out of the drone holds every day it has recorded.
    const scan = [
      { from: W(1, 11, 0), to: W(1, 11, 5) },
      { from: W(2, 14, 0), to: W(2, 14, 6) },
      { from: W(3, 9, 0), to: W(3, 9, 4) },
    ]
    expect(spansOnDay(scan, '2026-10-02')).toEqual([{ from: W(2, 14, 0), to: W(2, 14, 6) }])
  })

  it('cuts a recording that crosses midnight rather than dropping it', () => {
    const over = [{ from: W(2, 23, 50), to: W(3, 0, 10) }]
    expect(spansOnDay(over, '2026-10-02')).toEqual([{ from: W(2, 23, 50), to: W(3, 0, 0) }])
    expect(spansOnDay(over, '2026-10-03')).toEqual([{ from: W(3, 0, 0), to: W(3, 0, 10) }])
  })

  it('is empty for a day the card never filmed, and for a bad date', () => {
    const scan = [{ from: W(2, 14, 0), to: W(2, 14, 6) }]
    expect(spansOnDay(scan, '2026-10-05')).toEqual([])
    expect(spansOnDay(scan, 'not-a-date')).toEqual([])
  })

  it('ignores a span with no length or no numbers', () => {
    expect(spansOnDay([
      { from: W(2, 14, 0), to: W(2, 14, 0) },
      { from: NaN, to: W(2, 14, 6) },
    ], '2026-10-02')).toEqual([])
  })
})
