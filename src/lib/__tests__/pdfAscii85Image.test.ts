import { describe, it, expect } from 'vitest'
import {
  ascii85Decode, extractAscii85JpegList, extractJpegBytesList, extractLargestJpegBytes,
} from '../pdfImageExtract'
import { northstarConditions, isNorthstarBoat } from '../northstarTarget'

const bytes = (s: string) => {
  const a = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i)
  return a
}
const str = (b: Uint8Array) => Array.from(b).map((c) => String.fromCharCode(c)).join('')

describe('ascii85Decode', () => {
  it('decodes a full five-character group', () => {
    // "s4IA0" is FF D8 FF E0 — a JPEG SOI followed by APP0, and the literal
    // prefix every image stream in Baraka's report starts with.
    expect(Array.from(ascii85Decode(bytes('s4IA0')))).toEqual([0xff, 0xd8, 0xff, 0xe0])
    expect(str(ascii85Decode(bytes('9jqo^')))).toBe('Man ')
  })

  it('expands "z" to four zero bytes', () => {
    expect(Array.from(ascii85Decode(bytes('z')))).toEqual([0, 0, 0, 0])
  })

  it('handles a SHORT final group, which yields one byte fewer', () => {
    // Two characters carry one byte. Getting this wrong truncates or over-runs
    // the end of every image.
    expect(Array.from(ascii85Decode(bytes('s4IA0!<')))).toEqual([0xff, 0xd8, 0xff, 0xe0, 0x01])
  })

  it('skips the whitespace a PDF writer wraps streams with', () => {
    expect(Array.from(ascii85Decode(bytes('s4\n I\r\nA0')))).toEqual([0xff, 0xd8, 0xff, 0xe0])
  })

  it('stops at "~>" and tolerates a leading "<~"', () => {
    expect(Array.from(ascii85Decode(bytes('<~s4IA0~>9jqo^')))).toEqual([0xff, 0xd8, 0xff, 0xe0])
  })
})

// A minimal PDF-shaped buffer: an image XObject whose filter array is
// [/ASCII85Decode /DCTDecode], the way Sail Vision writes one.
const pdfWith = (filter: string, armoured: string) => bytes(
  `%PDF-1.4\n4 0 obj << /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter ${filter}`
  + ` /Height 1536 /Subtype /Image /Type /XObject /Width 2048 >> stream\n`
  + `${armoured}~>\nendstream endobj\n`,
)
// FF D8 FF E0 then four zero bytes — enough to pass the SOI check.
const ARMOURED = 's4IA0z'

describe('ASCII85-armoured JPEGs', () => {
  it('un-armours an image whose bytes are NOT verbatim in the file', () => {
    const pdf = pdfWith('[ /ASCII85Decode /DCTDecode ]', ARMOURED)
    // The point of the bug: there is no SOI anywhere in the raw file to find.
    expect(str(pdf).includes('\xff\xd8\xff')).toBe(false)
    const out = extractAscii85JpegList(pdf, 0)
    expect(out).toHaveLength(1)
    expect(Array.from(out[0]).slice(0, 4)).toEqual([0xff, 0xd8, 0xff, 0xe0])
  })

  it('ignores an ASCII85 stream that is NOT an image', () => {
    // ASCII85 also armours content streams. DCTDecode in the same dictionary is
    // what says "this one is a picture".
    expect(extractAscii85JpegList(pdfWith('[ /ASCII85Decode /FlateDecode ]', ARMOURED), 0)).toHaveLength(0)
  })

  it('ignores a stream that does not decode to a JPEG', () => {
    // "9jqo^" is "Man ", not an SOI. A filter array can lie; the bytes cannot.
    expect(extractAscii85JpegList(pdfWith('[ /ASCII85Decode /DCTDecode ]', '9jqo^'), 0)).toHaveLength(0)
  })

  it('returns several images in DOCUMENT order, which is page order', () => {
    const two = bytes(str(pdfWith('[ /ASCII85Decode /DCTDecode ]', 's4IA0z'))
      + str(pdfWith('[ /ASCII85Decode /DCTDecode ]', 's4IA0zz')))
    const out = extractAscii85JpegList(two, 0)
    expect(out).toHaveLength(2)
    // The second is longer, so order is not being sorted by size.
    expect(out[1].length).toBeGreaterThan(out[0].length)
  })

  it('is only a FALLBACK — a verbatim JPEG still wins', () => {
    // North's reports embed the bytes raw, and that path must not change.
    const raw = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])
    expect(extractJpegBytesList(raw, 0)).toHaveLength(1)
    expect(Array.from(extractLargestJpegBytes(raw)!)).toEqual(Array.from(raw))
  })

  it('falls through to the armoured path when the byte scan finds nothing', () => {
    const pdf = pdfWith('[ /ASCII85Decode /DCTDecode ]', ARMOURED)
    expect(extractJpegBytesList(pdf, 0)).toHaveLength(1)
    expect(extractLargestJpegBytes(pdf)).not.toBeNull()
  })
})

describe('the Northstar target belongs to Northstar', () => {
  const nsSail = { kind: 'mainsail', specs: {} }

  it('ships her sheet for a Northstar', () => {
    expect(isNorthstarBoat('Northstar 76')).toBe(true)
    expect(northstarConditions(nsSail, 'Northstar 76').length).toBeGreaterThan(0)
  })

  it('gives another boat NOTHING rather than Northstar\'s numbers', () => {
    // The bug: the fallback was unconditional, so Baraka's mainsail scans were
    // shown Northstar 76's reference trim — under a panel and a chart legend
    // both labelled "Northstar target". A wrong target is worse than no target.
    expect(isNorthstarBoat('Baraka GP')).toBe(false)
    expect(northstarConditions(nsSail, 'Baraka GP')).toEqual([])
  })

  it('treats an UNKNOWN boat as no target, not as Northstar', () => {
    // Fail closed. A caller that does not know which boat it is holding must not
    // be handed one boat's sheet by default — that is how this happened.
    expect(northstarConditions(nsSail)).toEqual([])
    expect(northstarConditions(nsSail, null)).toEqual([])
  })

  it('still honours numbers somebody SAVED onto the sail, whatever the boat', () => {
    const saved = { kind: 'mainsail', specs: { northstar_target: { conditions: [{ tws: 8, sections: [] }] } } }
    expect(northstarConditions(saved, 'Baraka GP')).toEqual([{ tws: 8, sections: [] }])
  })
})
