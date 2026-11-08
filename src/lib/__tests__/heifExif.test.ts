import { describe, it, expect } from 'vitest'
import { heifExifTiff, ftypSize, isIsoBmff } from '../heifExif'
import { buildHeif, tiffBlock, ascii, u32 } from './fixtures/heifContainer'

describe('heifExifTiff', () => {
  it("reads the EXIF out of a container exifr's ftyp gate rejects", () => {
    const file = buildHeif()
    // 52 bytes: the exact size of an iPhone 16 Pro's ftyp, and exifr bails at >50
    // before it looks at a single brand.
    expect(ftypSize(file)).toBe(52)
    expect(ftypSize(file)!).toBeGreaterThan(50)
    expect(Array.from(heifExifTiff(file)!)).toEqual(tiffBlock())
  })

  it('reads an older six-brand file the same way, whose ftyp is 40', () => {
    const file = buildHeif({ brands: ['mif1', 'MiHE', 'MiPr', 'miaf', 'MiHB', 'heic'] })
    expect(ftypSize(file)).toBe(40)
    expect(Array.from(heifExifTiff(file)!)).toEqual(tiffBlock())
  })

  it('joins an item split across extents', () => {
    const file = buildHeif({ splitExtents: true })
    expect(Array.from(heifExifTiff(file)!)).toEqual(tiffBlock())
  })

  it('honours the payload offset to the TIFF header', () => {
    // A non-zero exif_tiff_header_offset: four bytes of padding before the TIFF.
    const file = buildHeif({ exifPayload: [...u32(4), 9, 9, 9, 9, ...tiffBlock(0x5c)] })
    expect(Array.from(heifExifTiff(file)!)).toEqual(tiffBlock(0x5c))
  })

  it('refuses an item whose bytes are not at a file offset', () => {
    // construction_method 1 means "inside idat". Reading those bytes from the
    // file offset would hand exifr something from the wrong place entirely.
    expect(heifExifTiff(buildHeif({ construction: 1 }))).toBeNull()
  })

  it('returns null, not guesses, when there is nothing to read', () => {
    expect(heifExifTiff(buildHeif({ omitExifItem: true }))).toBeNull()
    expect(heifExifTiff(new Uint8Array([1, 2, 3, 4]))).toBeNull()
    expect(heifExifTiff(new Uint8Array(0))).toBeNull()
    // A JPEG: not ISO-BMFF at all.
    expect(heifExifTiff(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })

  it('refuses a payload that is not a TIFF block', () => {
    expect(heifExifTiff(buildHeif({ exifPayload: [...u32(0), ...ascii('nope'), 1, 2, 3, 4] }))).toBeNull()
  })

  it('refuses an extent that runs past the end of the file', () => {
    const file = buildHeif()
    // Nudge the stored length so the extent overruns; the walk must not read it.
    const over = new Uint8Array(file)
    const marker = ascii('iloc')
    let at = -1
    for (let i = 0; i < over.length - 4; i++) {
      if (over[i] === marker[0] && over[i + 1] === marker[1] && over[i + 2] === marker[2] && over[i + 3] === marker[3]) { at = i; break }
    }
    expect(at).toBeGreaterThan(0)
    // item 2's extent length is the last 4 bytes of the iloc box.
    const end = at - 4 + new DataView(over.buffer).getUint32(at - 4)
    new DataView(over.buffer).setUint32(end - 4, 1 << 20)
    expect(heifExifTiff(over)).toBeNull()
  })

  it('knows an ISO-BMFF file from anything else', () => {
    expect(isIsoBmff(buildHeif())).toBe(true)
    expect(isIsoBmff(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false)
    expect(ftypSize(new Uint8Array([0xff, 0xd8]))).toBeNull()
  })
})
