import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parseExif } from '../cdnScript'
import { buildHeif } from './fixtures/heifContainer'

// What exifr 7.1.3 really does with an iPhone 16 Pro's HEIC. Its ISO-BMFF
// `canHandle` reads the ftyp box size and returns false above 50 bytes, and the
// parser then reports the file as unrecognised — never as a HEIC it could not
// read. Nine compatible brands put Apple's current ftyp at 52.
const UNKNOWN = () => { throw new Error('Unknown file format') }

/** Stand in for the CDN script having already run: loadCdnGlobal takes the global. */
function installExifr(parse: (input: unknown, opts?: unknown) => Promise<unknown>) {
  const spy = vi.fn(parse)
  ;(window as unknown as Record<string, unknown>).exifr = { parse: spy }
  return spy
}

// jsdom's Blob has no `arrayBuffer()`; every browser that can run SSA has had
// one since 2019. Supplied here so the test exercises the real code path rather
// than the environment's gap in it.
function blobOf(bytes: Uint8Array): Blob {
  const blob = new Blob([bytes as unknown as BlobPart])
  if (typeof blob.arrayBuffer !== 'function') {
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async () => bytes.slice().buffer,
    })
  }
  return blob
}

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>).exifr
})

describe('parseExif', () => {
  it('falls back to the container when exifr refuses the file', async () => {
    const taken = new Date('2026-11-07T11:47:48')
    const parse = installExifr(async (input) => {
      // A Blob is the whole file, which exifr rejects; a Uint8Array is the TIFF
      // block lifted out of it, which it parses perfectly well.
      if (input instanceof Uint8Array) {
        return { DateTimeOriginal: taken, Model: 'iPhone 16 Pro', FocalLengthIn35mmFormat: 24 }
      }
      return UNKNOWN()
    })
    const out = await parseExif(blobOf(buildHeif()))
    expect(out?.Model).toBe('iPhone 16 Pro')
    expect(out?.DateTimeOriginal).toBe(taken)
    expect(out?.FocalLengthIn35mmFormat).toBe(24)
    expect(parse).toHaveBeenCalledTimes(2)
  })

  it('does not touch the container when exifr reads the file itself', async () => {
    const parse = installExifr(async () => ({ Model: 'iPhone 12' }))
    const out = await parseExif(blobOf(buildHeif({ brands: ['mif1', 'heic'] })))
    expect(out?.Model).toBe('iPhone 12')
    expect(parse).toHaveBeenCalledTimes(1)
  })

  it('returns null rather than throwing when there is no EXIF either way', async () => {
    installExifr(async () => UNKNOWN())
    expect(await parseExif(blobOf(buildHeif({ omitExifItem: true })))).toBeNull()
  })

  it('returns null when the fallback parse fails too', async () => {
    installExifr(async () => UNKNOWN())
    expect(await parseExif(blobOf(buildHeif()))).toBeNull()
  })

  it('treats an empty result as a reason to try the container', async () => {
    // exifr answers `undefined` for a file it opens but finds nothing in.
    const parse = installExifr(async (input) =>
      input instanceof Uint8Array ? { Model: 'iPhone 16 Pro' } : undefined
    )
    const out = await parseExif(blobOf(buildHeif()))
    expect(out?.Model).toBe('iPhone 16 Pro')
    expect(parse).toHaveBeenCalledTimes(2)
  })
})
