import { describe, it, expect } from 'vitest'
import { parsePolarText, parsePolarWorkbook, buildPolarData, polarFromData } from '../polarFile'
import { polarInterp } from '../polarCalc'
import targetsV14 from '../../data/targets-v1.4.json'

const EXPECTED = [
  { tws: 6, points: [{ twa: 40, bsp: 6.5 }, { twa: 90, bsp: 8 }, { twa: 150, bsp: 7 }] },
  { tws: 12, points: [{ twa: 40, bsp: 9 }, { twa: 90, bsp: 11 }, { twa: 150, bsp: 10 }] },
]

describe('parsePolarText', () => {
  it('reads an Expedition polar (one row per TWS, TWA/BSP pairs)', () => {
    const txt = '!Expedition polar\n12\t40\t9\t150\t10\t90\t11\n6\t40\t6.5\t90\t8\t150\t7\n'
    expect(parsePolarText(txt)).toEqual(EXPECTED)
  })

  it('reads a labelled TWS×TWA grid', () => {
    const txt = 'twa/tws\t6\t12\n40\t6.5\t9\n90\t8\t11\n150\t7\t10\n'
    expect(parsePolarText(txt)).toEqual(EXPECTED)
  })

  it('reads a grid whose header starts with 0, comma separated', () => {
    expect(parsePolarText('0,6,12\n40,6.5,9\n90,8,11\n150,7,10')).toEqual(EXPECTED)
  })

  it('reads a transposed grid (angles across, wind speeds down)', () => {
    expect(parsePolarText('tws\\twa;40;90;150\n6;6.5;8;7\n12;9;11;10')).toEqual(EXPECTED)
  })

  it('skips empty and zero cells in a grid', () => {
    const e = parsePolarText('twa/tws 6 12\n0 0 0\n40 6.5 9\n90 8 11\n150 7 0\n')
    expect(e[1].points.map(p => p.twa)).toEqual([40, 90])
  })

  it('rejects a file with no polar in it', () => {
    expect(() => parsePolarText('hello')).toThrow()
    expect(() => parsePolarText('name,value\nfoo,bar\nbaz,qux')).toThrow()
  })
})

describe('buildPolarData', () => {
  const data = buildPolarData(EXPECTED, { name: '37m-VPP-76 v1.6', source: 'design_vpp', file_name: '37m-VPP-76 v1.6.txt' })

  it('keeps the exact points and builds the Targets-tab grid', () => {
    expect(data.entries).toEqual(EXPECTED)
    expect(data.tws).toEqual([6, 12])
    expect(data.twa).toEqual([40, 90, 150])
    expect(data.matrices.bsp).toEqual([[6.5, 8, 7], [9, 11, 10]])
    expect(data.source_note).toBe('Uploaded from 37m-VPP-76 v1.6.txt')
  })

  it('derives the best VMG angles per TWS for the headline sheet', () => {
    expect(data.headline).toHaveLength(2)
    for (const h of data.headline) {
      expect(h.up.twa).toBeGreaterThanOrEqual(40)
      expect(h.up.twa).toBeLessThan(90)
      expect(h.dn.twa).toBeGreaterThan(90)
      expect(h.up.rudd).toBeNull()
    }
  })
})

describe('parsePolarWorkbook', () => {
  // Same layout as "NS76 Polar Development History.xlsx": a version list, one
  // "<version> Targets" sheet, one TWS/TWA grid sheet per version, and a comparison
  // sheet that must be ignored.
  const grid = [['TWS/TWA', '0', '40', '90', '150'], ['6', '0', '6.5', '8', '7'], ['12', '0', '9', '11', '10'], []]
  const sheets = [
    { name: 'Polar List', rows: [['Polars'], ['-'], ['37m-VPP-76 v1.2', 'Second run'], ['37m-VPP-76 v1.10 - Long name', 'Post Worlds'], ['', 'TWS/TWA', '35']] },
    { name: 'Polar Comp.', rows: [['Polar A', '37m-VPP-76 v1.2'], ['', '0', '5'], ['4', '0', '0.3']] },
    { name: 'v1.10 Targets', rows: [['37m-VPP-76 v1.10 - '], ['TWS/TWA', 'Up BSP', 'Up TWA', 'Dn BSP', 'Dn TWA'], ['6', '7.9', '43', '8.3000000000000007', '138'], ['12', '10.9', '37', '13.6', '144']] },
    { name: '37m-VPP-76 v1.10 - Long', rows: grid },
    { name: '37m-VPP-76 v1.2', rows: grid },
  ]
  const versions = parsePolarWorkbook(sheets)

  it('finds one version per grid sheet, oldest first', () => {
    expect(versions.map(v => v.name)).toEqual(['37m-VPP-76 v1.2', '37m-VPP-76 v1.10 - Long name'])
    expect(versions[1].entries).toEqual(EXPECTED)
  })

  it('attaches the notes and the targets sheet of each version', () => {
    expect(versions[0].notes).toBe('Second run')
    expect(versions[0].headline).toBeNull()
    expect(versions[1].notes).toBe('Post Worlds')
    expect(versions[1].headline?.[0]).toEqual({
      tws: 6,
      up: { bsp: 7.9, twa: 43, awa: null, heel: null, rudd: null },
      dn: { bsp: 8.3, twa: 138, awa: null, heel: null, rudd: null },
    })
  })

  it('stores the sheet targets as the headline instead of derived ones', () => {
    const v = versions[1]
    const data = buildPolarData(v.entries, { name: v.name, source_note: v.notes, headline: v.headline })
    expect(data.headline).toBe(v.headline)
    expect(data.source_note).toBe('Post Worlds')
  })
})

describe('polarFromData', () => {
  it('prepares an uploaded polar from its entries', () => {
    const p = polarFromData(buildPolarData(EXPECTED, { name: 'x' }))
    expect(polarInterp(p, 6, 90)).toBeCloseTo(8, 5)
    expect(polarInterp(p, 12, 40)).toBeCloseTo(9, 5)
  })

  it('prepares the bundled V1.4 targets from their BSP matrix', () => {
    const t: any = targetsV14
    const p = polarFromData(t)
    const i = t.tws.indexOf(20), j = t.twa.indexOf(40)
    expect(polarInterp(p, 20, 40)).toBeCloseTo(t.matrices.bsp[i][j], 5)
  })

  it('returns null for data without speeds', () => {
    expect(polarFromData(null)).toBeNull()
    expect(polarFromData({ headline: [] })).toBeNull()
  })
})
