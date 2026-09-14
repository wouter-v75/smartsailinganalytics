// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'zlib'
import { readXlsx } from '../xlsxRead'

// Build a zip in memory: `deflate` names the entries to store compressed.
function zip(files: Record<string, string>, deflate: string[] = []): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const n = enc.encode(name)
    const raw = enc.encode(content)
    const compressed = deflate.includes(name)
    const d = compressed ? new Uint8Array(deflateRawSync(raw)) : raw
    const local = new Uint8Array(30 + n.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, compressed ? 8 : 0, true)
    lv.setUint32(18, d.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, n.length, true)
    local.set(n, 30)
    const cen = new Uint8Array(46 + n.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, compressed ? 8 : 0, true)
    cv.setUint32(20, d.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, n.length, true)
    cv.setUint32(42, offset, true)
    cen.set(n, 46)
    parts.push(local, d)
    central.push(cen)
    offset += local.length + d.length
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, cenSize, true)
  ev.setUint32(16, offset, true)
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of all) { out.set(p, o); o += p.length }
  return out
}

const FILES = {
  'xl/workbook.xml':
    '<workbook xmlns:r="urn:r"><sheets>' +
    '<sheet name="Notes &amp; list" sheetId="1" r:id="rId1"/>' +
    '<sheet name="Grid" sheetId="2" r:id="rId2"/>' +
    '</sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships>' +
    '<Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Target="/xl/worksheets/sheet2.xml" Type="ws" Id="rId2"/>' +
    '</Relationships>',
  'xl/sharedStrings.xml':
    '<sst><si><t>TWS/TWA</t></si><si><r><t>Rich </t></r><r><t xml:space="preserve">text</t></r></si></sst>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>a&lt;b</t></is></c></row>' +
    '<row r="3"/>' +
    '<row r="4"><c r="B4"><v>8.3000000000000007</v></c><c r="C4" t="str"><v>=cached</v></c></row>' +
    '</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml':
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>40</v></c></row></sheetData></worksheet>',
}

describe('readXlsx', () => {
  it('reads sheet names and cell values, keeping row and column positions', async () => {
    const sheets = await readXlsx(zip(FILES, ['xl/worksheets/sheet2.xml', 'xl/sharedStrings.xml']))
    expect(sheets.map(s => s.name)).toEqual(['Notes & list', 'Grid'])
    expect(sheets[0].rows).toEqual([
      ['Rich text', '', 'a<b'],
      [],
      [],
      ['', '8.3000000000000007', '=cached'],
    ])
    expect(sheets[1].rows).toEqual([['TWS/TWA', '40']])
  })

  it('rejects files that are not workbooks', async () => {
    await expect(readXlsx(new Uint8Array(40))).rejects.toThrow(/xlsx/)
    await expect(readXlsx(zip({ 'a.txt': 'hi' }))).rejects.toThrow(/workbook/)
  })
})
