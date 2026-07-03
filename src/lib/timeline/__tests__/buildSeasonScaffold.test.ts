import { describe, it, expect } from 'vitest'
import { buildDayTimeline } from '../buildNodes'
import { buildSeasonScaffold } from '../buildSeasonScaffold'

const day = (date: string, startH: number, location: string) => {
  const T = Date.parse(`${date}T${String(startH).padStart(2, '0')}:00:00Z`)
  return buildDayTimeline({
    boatId: 'boat-1', date,
    xml: {
      meta: { location },
      dayStartUtc: T, dayStopUtc: T + 2 * 3600e3,
      raceGuns: [{ utc: T + 5 * 60e3, raceNum: 1 }],
      tackJibes: [{ utc: T + 20 * 60e3, isTack: true }],
    },
  })
}

describe('buildSeasonScaffold', () => {
  it('leaves a single day untouched', () => {
    const one = day('2026-07-03', 9, 'La Ciotat')
    expect(buildSeasonScaffold(one)).toEqual(one)
  })

  it('groups multiple days into regattas under a season', () => {
    const nodes = [
      ...day('2026-06-14', 10, 'La Ciotat'),
      ...day('2026-06-15', 10, 'La Ciotat'),
      ...day('2026-08-01', 11, 'Cowes'),
    ]
    const out = buildSeasonScaffold(nodes)
    const season = out.filter((n) => n.kind === 'season')
    const regattas = out.filter((n) => n.kind === 'regatta')
    const days = out.filter((n) => n.kind === 'day')

    expect(season).toHaveLength(1)
    expect(season[0].title).toBe('Season 2026')
    expect(season[0].metrics).toMatchObject({ regattas: 2, days: 3 })

    // one regatta per venue, La Ciotat spanning its two days
    expect(regattas.map((r) => r.title).sort()).toEqual(['Cowes', 'La Ciotat'])
    const lc = regattas.find((r) => r.title === 'La Ciotat')!
    expect(lc.parentId).toBe(season[0].id)
    expect(lc.metrics).toMatchObject({ days: 2 })

    // every day is re-parented under an existing regatta node
    const regIds = new Set(regattas.map((r) => r.id))
    expect(days.every((d) => !!d.parentId && regIds.has(d.parentId))).toBe(true)

    // races still hang off their day (untouched)
    const race = out.find((n) => n.kind === 'race')!
    expect(race.parentId).toContain(':day')
  })
})
