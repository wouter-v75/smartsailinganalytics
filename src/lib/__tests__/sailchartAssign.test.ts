import { describe, it, expect } from 'vitest'
import { makeSailPicker, sailHours } from '../sailchart/assign'
import type { SailChart, ChartSail } from '../sailchart/model'

const box = (name: string, group: string, a0: number, a1: number, w0: number, w1: number): ChartSail => ({
  id: name, name, group, colour: '#000000', alias: [], opacity: 40, dashed: false, lineWidth: 2, label: null, visible: true, sailIds: [],
  points: [{ twa: a0, tws: w0 }, { twa: a1, tws: w0 }, { twa: a1, tws: w1 }, { twa: a0, tws: w1 }],
  extra: { straight: true },
})
const chart: SailChart = {
  version: 1, fileName: 't', importedAt: null,
  sails: [box('J2', 'Headsails', 40, 110, 8, 20), box('A2', 'Spinnakers', 120, 148, 10, 20), box('A1', 'Spinnakers', 120, 148, 4, 10)],
}

describe('makeSailPicker', () => {
  const pick = makeSailPicker(chart)!
  it('takes the shape that contains the point, on either tack', () => {
    expect(pick(60, 12)).toEqual({ name: 'J2', group: 'Headsails', inside: true })
    expect(pick(-135, 15)).toEqual({ name: 'A2', group: 'Spinnakers', inside: true })
  })
  it('deeper than the downwind VMG edge is the sail on that edge at the same TWS', () => {
    expect(pick(160, 15)).toMatchObject({ name: 'A2', inside: false })
    expect(pick(175, 6)).toMatchObject({ name: 'A1', inside: false })
  })
  it('tighter than the upwind edge is the sail on the upwind edge', () => {
    expect(pick(30, 12)).toMatchObject({ name: 'J2', inside: false })
    // at 6 kn the chart's tightest sail is A1 (J2 starts at 8 kn)
    expect(pick(30, 6)).toMatchObject({ name: 'A1', inside: false })
  })
  it('a TWS the chart does not reach is brought to its edge first', () => {
    expect(pick(60, 30)).toMatchObject({ name: 'J2', inside: false })
    expect(pick(160, 30)).toMatchObject({ name: 'A2', inside: false })
    expect(pick(160, 1)).toMatchObject({ name: 'A1', inside: false })
  })
  it('a hole inside the chart goes to the nearest sail', () => {
    expect(pick(115, 15)).toMatchObject({ name: 'J2', inside: false })   // 110-120° gap, nearer J2's edge at 110
  })
  it('a chart with no shapes picks nothing', () => {
    expect(makeSailPicker({ ...chart, sails: [] })).toBeNull()
  })
})

describe('sailHours', () => {
  const H = 3600e3
  const route = (pts: [number, number][]) => pts.map(([twa, tws], k) => ({ t: k * H, twa, tws }))
  it('charges each hour to the sail at its start, and adds up to the sailing time', () => {
    const r = sailHours(chart, [route([[60, 12], [60, 12], [140, 15], [160, 15], [0, 0]]), route([[140, 6], [140, 6], [0, 0]])])!
    const by = Object.fromEntries(r.sails.map(s => [s.name, s]))
    expect(r.totalHours).toBe(3)                        // (4 + 2) h over two races
    expect(by.J2.hours).toBe(1)
    expect(by.A2.hours).toBe(1)
    expect(by.A2.outsideHours).toBe(0.5)
    expect(by.A1.hours).toBe(1)
    expect(r.outsideShare).toBeCloseTo(1 / 6)
    expect(by.J2.usedIn).toBe(0.5)
    expect(by.A1.usedIn).toBe(0.5)
    expect(r.sails.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1)
  })
})
