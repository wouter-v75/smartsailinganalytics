// Several stretches of one day, each keeping its colour and its number, because both
// are how a reader ties a figure beside a chart back to a piece of water.
import { describe, it, expect } from 'vitest'
import {
  addSection, removeSection, sectionOf, inSections, phaseSection, phaseInSections,
  sectionsSpan, sectionAverages, selectButtonLabel, sectionLabel,
  SECTION_COLORS, MAX_SECTIONS,
} from '../trackSections'

const T0 = Date.UTC(2026, 8, 11, 10, 0, 0)
const m = (min: number) => T0 + min * 60_000
const build = (...ranges: [number, number][]) => ranges.reduce((acc, r) => addSection(acc, r), [] as ReturnType<typeof addSection>)

describe('adding sections', () => {
  it('numbers and colours them in the order they were picked', () => {
    const s = build([m(0), m(10)], [m(20), m(30)])
    expect(s.map(x => x.n)).toEqual([1, 2])
    expect(s.map(x => x.color)).toEqual([SECTION_COLORS[0], SECTION_COLORS[1]])
  })

  it('accepts a drag made backwards', () => {
    const [s] = build([m(30), m(10)])
    expect(s.range).toEqual([m(10), m(30)])
  })

  it('allows two sections over the same water — that is a fair comparison', () => {
    expect(build([m(0), m(20)], [m(10), m(30)])).toHaveLength(2)
  })

  it('ignores a section with no length, or none at all', () => {
    expect(addSection([], [m(5), m(5)])).toHaveLength(0)
    expect(addSection([], null)).toHaveLength(0)
    expect(addSection([], [NaN, m(5)] as never)).toHaveLength(0)
  })

  it('stops at the number of colours it can tell apart', () => {
    let s = build()
    for (let i = 0; i < MAX_SECTIONS + 3; i++) s = addSection(s, [m(i * 2), m(i * 2 + 1)])
    expect(s).toHaveLength(MAX_SECTIONS)
  })
})

describe('removing a section', () => {
  it('renumbers and recolours the rest, so section 2 is always the second one', () => {
    const s = build([m(0), m(10)], [m(20), m(30)], [m(40), m(50)])
    const left = removeSection(s, s[0].id)
    expect(left.map(x => x.n)).toEqual([1, 2])
    expect(left[0].range).toEqual([m(20), m(30)])
    expect(left[0].color).toBe(SECTION_COLORS[0])
  })

  it('does nothing for an id that is not there', () => {
    const s = build([m(0), m(10)])
    expect(removeSection(s, 'nope')).toHaveLength(1)
  })
})

describe('what belongs to a section', () => {
  const s = build([m(0), m(10)], [m(20), m(30)])

  it('finds the section a moment is in', () => {
    expect(sectionOf(s, m(5))?.n).toBe(1)
    expect(sectionOf(s, m(25))?.n).toBe(2)
    expect(sectionOf(s, m(15))).toBeNull()
  })

  it('gives an overlapping moment one colour, not two', () => {
    const over = build([m(0), m(20)], [m(10), m(30)])
    expect(sectionOf(over, m(15))?.n).toBe(1)
  })

  it('treats no sections as the whole day', () => {
    expect(inSections(m(99), [])).toBe(true)
    expect(inSections(m(15), s)).toBe(false)
    expect(inSections(m(5), s)).toBe(true)
  })

  it('puts a phase in the section its midpoint falls in', () => {
    expect(phaseSection({ utc: m(9), endUtc: m(11) }, s)?.n).toBe(1)   // midpoint m(10)
    expect(phaseSection({ utc: m(10), endUtc: m(12) }, s)).toBeNull()  // midpoint m(11)
    expect(phaseInSections({ utc: m(10), endUtc: m(12) }, [])).toBe(true)
  })
})

describe('sectionsSpan', () => {
  it('covers every section, for zooming the charts', () => {
    expect(sectionsSpan(build([m(20), m(30)], [m(0), m(10)]))).toEqual([m(0), m(30)])
    expect(sectionsSpan([])).toBeNull()
  })
})

describe('sectionAverages', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ utc: T0 + i * 60_000, tws: i < 10 ? 12 : 18, bad: null }))
  const s = build([m(0), m(9)], [m(20), m(29)])

  it('averages each section separately, in its own colour and number', () => {
    const avg = sectionAverages(rows, s, (r: { tws: number }) => r.tws)
    expect(avg.map(a => a.mean)).toEqual([12, 18])
    expect(avg.map(a => a.n)).toEqual([1, 2])
    expect(avg[0].color).toBe(SECTION_COLORS[0])
    expect(avg[0].count).toBe(10)
  })

  it('reports nothing rather than zero for a section with no data', () => {
    const avg = sectionAverages(rows, s, (r: { bad: number | null }) => r.bad)
    expect(avg.every(a => a.mean === null && a.count === 0)).toBe(true)
  })

  it('copes with no rows at all', () => {
    expect(sectionAverages(null, s, () => 1).map(a => a.mean)).toEqual([null, null])
  })
})

describe('what the button says', () => {
  it('invites a first section, then the next one', () => {
    expect(selectButtonLabel([])).toMatch(/Select a section/)
    expect(selectButtonLabel(build([m(0), m(10)]))).toMatch(/Select section 2/)
    expect(selectButtonLabel(build([m(0), m(10)], [m(20), m(30)]))).toMatch(/Select section 3/)
  })

  it('names a section the way its chip does', () => {
    expect(sectionLabel(build([m(0), m(10)])[0])).toBe('Section 1')
  })
})
