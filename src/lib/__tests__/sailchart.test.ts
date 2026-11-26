import { describe, it, expect } from 'vitest'
import { parseCrossoverXml, toCrossoverXml, normaliseSailChart, defaultShape } from '../sailchart/model'
import { outline, contains, insertIndex, apparent, awsIsoline, awaIsoline, vmgLine } from '../sailchart/geometry'
import { matchSail, sailCode, autoLink } from '../sailchart/match'
import { preparePolar } from '../polarCalc'

const XML = `﻿<?xml version="1.0" encoding="utf-8"?>
<crossoverchart><elements>
  <element name="J3" group="Headsails" type="NotSet">
    <createdby val="Andy" /><datecreated val="2019-08-12" /><visible val="True" />
    <colour R="0" G="255" B="0" /><straightline val="False" />
    <alias val="J3-A;J3-B" />
    <bezierpoints>
      <point tws="19.4" twa="53.4" /><point tws="18.7" twa="30" /><point tws="13.9" twa="30.2" />
      <point tws="14.4" twa="68.4" /><point tws="18" twa="99.9" />
    </bezierpoints>
    <shapepattern val="Solid" /><shapeopacity val="40" /><linepattern val="Solid" /><linewidth val="2" />
    <labelposition tws="18.2" twa="68.6" />
  </element>
  <element name="SS &amp; co" group="Staysails" type="NotSet">
    <colour R="0" G="0" B="0" /><alias val="SS-A" />
    <bezierpoints><point tws="13.7" twa="134.1" /><point tws="9.3" twa="128.9" /><point tws="10.3" twa="145.1" /></bezierpoints>
    <linepattern val="Dash" /><linewidth val="1" />
  </element>
  <element name="Bad" group="X"><bezierpoints><point tws="1" twa="1" /></bezierpoints></element>
</elements></crossoverchart>`

describe('crossover XML', () => {
  it('parses shapes, colours, aliases, dash and label; drops a shape with no inside', () => {
    const c = parseCrossoverXml(XML, 'x.xml')
    expect(c.sails.map(s => s.name)).toEqual(['J3', 'SS & co'])
    const j3 = c.sails[0]
    expect(j3.colour).toBe('#00ff00')
    expect(j3.alias).toEqual(['J3-A', 'J3-B'])
    expect(j3.points).toHaveLength(5)
    expect(j3.label).toEqual({ tws: 18.2, twa: 68.6 })
    expect(c.sails[1].dashed).toBe(true)
    expect(c.sails[1].group).toBe('Staysails')
  })

  it('refuses a file that is not a crossover chart', () => {
    expect(() => parseCrossoverXml('<polar/>')).toThrow(/crossover/i)
  })

  it('round-trips through its own export', () => {
    const a = parseCrossoverXml(XML)
    const b = parseCrossoverXml(toCrossoverXml(a))
    expect(b.sails.map(s => [s.name, s.group, s.colour, s.alias, s.points, s.dashed]))
      .toEqual(a.sails.map(s => [s.name, s.group, s.colour, s.alias, s.points, s.dashed]))
    expect(b.sails[0].label).toEqual(a.sails[0].label)
    // a shape with no label gets one at its centre, which Expedition needs to draw the name
    expect(b.sails[1].label).not.toBeNull()
  })

  it('normalise drops undrawable shapes and keeps links', () => {
    const c = normaliseSailChart({ sails: [
      { name: 'A', points: [{ twa: 1, tws: 1 }, { twa: 2, tws: 2 }, { twa: 3, tws: 1 }], sailIds: ['x', 'x'] },
      { name: 'B', points: [{ twa: 1, tws: 1 }] },
      { name: '', points: [] },
    ] })
    expect(c.sails.map(s => s.name)).toEqual(['A'])
    expect(c.sails[0].sailIds).toEqual(['x'])
    expect(normaliseSailChart(null).sails).toEqual([])
  })

  it('places a new spinnaker deep and a new jib upwind', () => {
    const avg = (p: { twa: number }[]) => p.reduce((a, q) => a + q.twa, 0) / p.length
    expect(avg(defaultShape('spinnaker', 'Spinnakers'))).toBeGreaterThan(120)
    expect(avg(defaultShape('jib', 'Headsails'))).toBeLessThan(70)
  })
})

describe('geometry', () => {
  const sq = [{ twa: 40, tws: 5 }, { twa: 60, tws: 5 }, { twa: 60, tws: 15 }, { twa: 40, tws: 15 }]
  it('outline passes through every control point', () => {
    const o = outline(sq, 8)
    for (const p of sq) expect(o.some(q => Math.abs(q.twa - p.twa) < 1e-9 && Math.abs(q.tws - p.tws) < 1e-9)).toBe(true)
  })
  it('contains', () => {
    const o = outline(sq)
    expect(contains(o, { twa: 50, tws: 10 })).toBe(true)
    expect(contains(o, { twa: 80, tws: 10 })).toBe(false)
  })
  it('insertIndex puts a click on the right edge between points 1 and 2', () => {
    expect(insertIndex(sq, { twa: 61, tws: 10 })).toBe(2)
    expect(insertIndex(sq, { twa: 50, tws: 4.5 })).toBe(1)
  })
  it('apparent wind: head to wind adds, dead downwind subtracts', () => {
    expect(apparent(10, 0, 5)).toEqual({ aws: 15, awa: 0 })
    const dn = apparent(10, 180, 5)
    expect(dn.aws).toBeCloseTo(5)
    expect(dn.awa).toBeCloseTo(180)
    const beam = apparent(10, 90, 10)
    expect(beam.awa).toBeCloseTo(45)
  })

  // A toy polar: BSP = 0.6·TWS at every angle from 30° to 180°.
  const polar = preparePolar({ entries: [6, 10, 16, 24].map(tws => ({
    tws, points: [30, 45, 60, 90, 120, 150, 180].map(twa => ({ twa, bsp: 0.6 * tws })),
  })) }, { interp: 'linear' })
  const R = { twaMin: 30, twaMax: 160, twsMin: 0, twsMax: 30 }

  it('an AWS isoline really has that apparent wind', () => {
    const line = awsIsoline(polar, 20, { ...R, twsMax: 24 }) // the toy polar stops at 24
    expect(line.length).toBeGreaterThan(50)
    for (const p of line) expect(apparent(p.tws, p.twa, 0.6 * p.tws).aws).toBeCloseTo(20, 1)
    // more TWS is needed for the same AWS as the boat bears away
    expect(line[line.length - 1].tws).toBeGreaterThan(line[0].tws)
  })
  it('an AWA isoline really has that apparent angle', () => {
    const line = awaIsoline(polar, 60, { ...R, twsMin: 6, twsMax: 24 })
    expect(line.length).toBeGreaterThan(10)
    for (const p of line) expect(apparent(p.tws, p.twa, 0.6 * p.tws).awa).toBeCloseTo(60, 0)
  })
  it('VMG lines sit upwind and downwind', () => {
    const up = vmgLine(polar, 'up', { ...R, twaMax: 180 })
    const dn = vmgLine(polar, 'down', { ...R, twaMax: 180 })
    expect(up.length).toBeGreaterThan(0)
    expect(dn.length).toBeGreaterThan(0)
    for (const p of up) expect(p.twa).toBeLessThan(90)
    for (const p of dn) expect(p.twa).toBeGreaterThan(90)
  })
})

describe('matching', () => {
  const inv = [
    { id: 'j3a', name: 'J3-A' }, { id: 'j3b', name: 'J3-B' },
    { id: 'j3p', name: 'J3+A 2026' }, { id: 'j1', name: 'J1-A' }, { id: 'j15', name: 'J1.5-A' },
    { id: 'br0', name: 'BRO_A 2026' }, { id: 'old', name: 'A2-A', retired: true },
    { id: 'gs', name: 'Gennaker staysail', category: 'GS' },
  ]
  it('sail codes keep their boundary', () => {
    expect(sailCode('J3+A 2026')).toBe('J3+')
    expect(sailCode('J1.5-A')).toBe('J1.5')
    expect(sailCode('BRO_A 2026')).toBe('BR0')
    expect(sailCode('MH0 A')).toBe('MH0')
    expect(sailCode('GS 2024')).toBe('GS')
  })
  it('alias beats code; J3 never takes J3+', () => {
    const m = matchSail({ name: 'J3', alias: ['J3-A', 'J3-B'] }, inv)
    expect(m).toEqual({ sailIds: ['j3a', 'j3b'], how: 'alias', retiredOnly: false })
    expect(matchSail({ name: 'J3', alias: [] }, inv).sailIds).toEqual(['j3a', 'j3b'])
    expect(matchSail({ name: 'J3+', alias: [] }, inv).sailIds).toEqual(['j3p'])
  })
  it('J1 never takes J1.5', () => {
    expect(matchSail({ name: 'J1', alias: [] }, inv).sailIds).toEqual(['j1'])
  })
  it('zero and letter O are the same; category is the last resort', () => {
    expect(matchSail({ name: 'BR0', alias: [] }, inv).sailIds).toEqual(['br0'])
    expect(matchSail({ name: 'GS', alias: [] }, inv)).toMatchObject({ sailIds: ['gs'], how: 'category' })
  })
  it('a retired-only match is reported, not linked', () => {
    expect(matchSail({ name: 'A2', alias: [] }, inv)).toEqual({ sailIds: [], how: 'code', retiredOnly: true })
    const shapes = parseCrossoverXml(XML).sails
    const r = autoLink(shapes, inv)
    expect(r.linked).toBe(1)
    expect(r.unmatched).toHaveLength(1)
  })
})
