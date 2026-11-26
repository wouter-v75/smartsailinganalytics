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
    // below the chart at an angle only a higher shape covers: that shape, not the lowest one
    expect(pick(130, 25)).toMatchObject({ name: 'A2', inside: false })
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

import { foldToTargets } from '../routing/climatology'
describe('foldToTargets', () => {
  // rows: <30, 30, 35, ..., 155, >=160 (5° bins); columns: 0, 2, ..., 30 kn
  const twaEdges = [0]; for (let a = 30; a <= 160; a += 5) twaEdges.push(a)
  const twsEdges: number[] = []; for (let s = 0; s <= 30; s += 2) twsEdges.push(s)
  const rowOf = (a: number) => twaEdges.indexOf(a)
  it('moves time past the targets into the target box of the same TWS row, and keeps the total', () => {
    const hours = twaEdges.map(() => twsEdges.map(() => 0))
    hours[rowOf(155)][7] = 2      // 14-16 kn, 155-160°: past a 150° target
    hours[rowOf(160)][7] = 1      // >=160
    hours[rowOf(150)][7] = 3      // the target's own box
    hours[rowOf(30)][7] = 1       // tighter than a 40° upwind target
    hours[rowOf(100)][7] = 5      // between the targets: untouched
    const t = { twaEdges, twsEdges, hours, totalHours: 12 }
    const f = foldToTargets(t, () => ({ upTwa: 40, dnTwa: 150 }))
    expect(f.table.hours[rowOf(150)][7]).toBe(6)
    expect(f.table.hours[rowOf(155)][7]).toBe(0)
    expect(f.table.hours[rowOf(160)][7]).toBe(0)
    expect(f.table.hours[rowOf(40)][7]).toBe(1)
    expect(f.table.hours[rowOf(30)][7]).toBe(0)
    expect(f.table.hours[rowOf(100)][7]).toBe(5)
    expect(f.movedShare).toBeCloseTo(4 / 12)
    expect(f.table.hours.flat().reduce((a, b) => a + b, 0)).toBe(12)
    expect(t.hours[rowOf(155)][7]).toBe(2)   // the input is not modified
  })
})
