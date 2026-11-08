// A HEIF container, built byte by byte.
//
// Built rather than committed as a fixture: the bug these tests are about is the
// SIZE of the ftyp box, and a builder lets a test say "nine brands" or "six" and
// get the 52 and 40 bytes the real iPhone files have. Shared by the extraction
// tests and the parseExif fallback tests, so both describe the same container.

export const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
export const u16 = (n: number) => [(n >>> 8) & 255, n & 255]
export const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))

/** A box: 4-byte size, 4-byte type, payload. */
const box = (type: string, body: number[]) => [...u32(body.length + 8), ...ascii(type), ...body]

const ftyp = (brands: string[]) =>
  box('ftyp', [...ascii('heic'), ...u32(0), ...brands.flatMap(ascii)])

/** An `infe` version 2 entry: this id holds this item type. */
const infe = (id: number, type: string) =>
  box('infe', [2, 0, 0, 0, ...u16(id), ...u16(0), ...ascii(type), 0])

const iinf = (entries: number[][]) =>
  box('iinf', [0, 0, 0, 0, ...u16(entries.length), ...entries.flat()])

/** An `iloc` version 1 with 4-byte offsets and lengths and no base offset. */
const iloc = (items: Array<{ id: number; construction?: number; extents: Array<[number, number]> }>) =>
  box('iloc', [
    1, 0, 0, 0,
    0x44, // offset_size 4, length_size 4
    0x00, // base_offset_size 0, index_size 0
    ...u16(items.length),
    ...items.flatMap((it) => [
      ...u16(it.id),
      ...u16(it.construction ?? 0),
      ...u16(0), // data_reference_index
      ...u16(it.extents.length),
      ...it.extents.flatMap(([off, len]) => [...u32(off), ...u32(len)]),
    ]),
  ])

const meta = (children: number[][]) => box('meta', [0, 0, 0, 0, ...children.flat()])

/** A TIFF block exifr would accept: big-endian magic plus a recognisable body. */
export const tiffBlock = (marker = 0xab) => [...ascii('MM'), 0x00, 0x2a, ...u32(8), marker, marker, marker, marker]

/**
 * Assemble a file. The EXIF item's extent is an ABSOLUTE file offset, so the
 * boxes have to be laid out before it can be filled in — which is the part of
 * this that has to be right.
 */
export function buildHeif(opts: {
  brands?: string[]
  exifPayload?: number[] | null
  construction?: number
  splitExtents?: boolean
  omitExifItem?: boolean
} = {}) {
  const brands = opts.brands ?? ['mif1', 'MiHB', 'MiHA', 'heix', 'MiHE', 'MiPr', 'heic', 'miaf', 'tmap']
  const payload = opts.exifPayload === undefined ? [...u32(0), ...tiffBlock()] : opts.exifPayload
  const head = ftyp(brands)

  const items = opts.omitExifItem ? [infe(1, 'hvc1')] : [infe(1, 'hvc1'), infe(2, 'Exif')]
  // Lay the meta box out once with placeholder extents to learn its length, then
  // again with the real offsets. Both passes produce the same byte count because
  // the extent fields are fixed-width.
  const measure = (off: number, len: number) => {
    const extents: Array<[number, number]> =
      opts.splitExtents && len > 2 ? [[off, 2], [off + 2, len - 2]] : [[off, len]]
    return meta([
      iinf(items),
      iloc([
        { id: 1, extents: [[0, 0]] },
        ...(opts.omitExifItem ? [] : [{ id: 2, construction: opts.construction, extents }]),
      ]),
    ])
  }
  const metaLen = measure(0, payload?.length ?? 0).length
  const exifAt = head.length + metaLen
  const body = measure(exifAt, payload?.length ?? 0)
  return new Uint8Array([...head, ...body, ...(payload ?? [])])
}
