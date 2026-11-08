// Pulling the EXIF out of a HEIF/HEIC container by hand, because exifr will not.
//
// exifr 7.1.3 (the version SSA loads, and the last one its author published)
// gates every ISO-BMFF file on the SIZE of its `ftyp` box:
//
//     static canHandle(file, t) {
//       if (t !== 0) return false
//       let i = file.getUint16(2)   // ftyp box size
//       if (i > 50) return false    // ← this
//       ...                          // only THEN does it look at the brands
//     }
//
// An iPhone 12's HEIC declares six compatible brands and its `ftyp` is 40 bytes,
// so it passes. An iPhone 16 Pro's declares nine — Apple added `MiHA`, `heix`
// and `tmap` for the HDR gain map — and its `ftyp` is **52 bytes**, so exifr
// rejects the file with "Unknown file format" before reading a single brand.
// Nothing is wrong with the EXIF; exifr never reaches it.
//
// That silence is expensive. `readExif` swallows the throw and returns
// `{ utc: null }`, and a photo with no capture time is filed under TODAY rather
// than the day it was shot — and arrives with no focal length, which makes
// SailTrim SKIP the depth correction and ψ's effective separation rather than
// approximate them (see CLAUDE.md). So the fallback here is not a nicety.
//
// What it does: walk `meta` → `iinf` for the item whose type is `Exif`, read its
// position out of `iloc`, and return the TIFF block inside it. exifr parses a
// bare TIFF buffer perfectly well — it is only the container sniff that fails.

/** A box header: where it is, how long, and how much of that is the header. */
type Box = { type: string; start: number; size: number; hdr: number }

function readBoxes(b: Uint8Array, view: DataView, from: number, to: number): Box[] {
  const out: Box[] = []
  let p = from
  while (p + 8 <= to) {
    let size = view.getUint32(p)
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7])
    let hdr = 8
    if (size === 1) {
      if (p + 16 > to) break
      // 64-bit size. Anything over 2^53 is not a real file; Number is fine.
      size = Number(view.getBigUint64(p + 8))
      hdr = 16
    } else if (size === 0) {
      size = to - p // "to the end of the file"
    }
    if (size < hdr || p + size > to) break
    out.push({ type, start: p, size, hdr })
    p += size
  }
  return out
}

/** `meta` is a FullBox, so its children start 4 bytes later than a plain box's. */
const childrenStart = (box: Box) => box.start + box.hdr + (box.type === 'meta' ? 4 : 0)

function findBox(b: Uint8Array, view: DataView, from: number, to: number, type: string): Box | null {
  return readBoxes(b, view, from, to).find((x) => x.type === type) || null
}

/**
 * True when the bytes open with an ISO-BMFF `ftyp` box — HEIC, HEIF or AVIF.
 * Deliberately not a brand whitelist: the brand list is exactly what Apple keeps
 * adding to, and a whitelist is how this bug happened in the first place.
 */
export function isIsoBmff(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 // 'ftyp'
}

/** The `ftyp` box's size — what exifr compares against 50. For diagnostics. */
export function ftypSize(bytes: Uint8Array): number | null {
  if (!isIsoBmff(bytes)) return null
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
}

/** Item id → ISO-BMFF item type, from `iinf`/`infe`. */
function itemTypes(b: Uint8Array, view: DataView, meta: Box): Map<number, string> {
  const out = new Map<number, string>()
  const iinf = findBox(b, view, childrenStart(meta), meta.start + meta.size, 'iinf')
  if (!iinf) return out
  const ver = b[iinf.start + iinf.hdr]
  let p = iinf.start + iinf.hdr + 4
  // entry_count is 16-bit in version 0, 32-bit after.
  p += ver === 0 ? 2 : 4
  for (const infe of readBoxes(b, view, p, iinf.start + iinf.size)) {
    if (infe.type !== 'infe') continue
    const v = b[infe.start + infe.hdr]
    let q = infe.start + infe.hdr + 4
    if (v >= 2) {
      const id = v === 2 ? view.getUint16(q) : view.getUint32(q)
      q += v === 2 ? 2 : 4
      q += 2 // protection_index
      out.set(id, String.fromCharCode(b[q], b[q + 1], b[q + 2], b[q + 3]))
    }
    // Versions 0 and 1 carry no item_type at all — they predate HEIF and never
    // appear in one. Nothing to record, so they are skipped rather than guessed.
  }
  return out
}

/** Where an item's bytes are: absolute file extents, or null if not addressable. */
function itemExtents(
  b: Uint8Array,
  view: DataView,
  meta: Box,
  wanted: number
): Array<[number, number]> | null {
  const iloc = findBox(b, view, childrenStart(meta), meta.start + meta.size, 'iloc')
  if (!iloc) return null
  const ver = b[iloc.start + iloc.hdr]
  let p = iloc.start + iloc.hdr + 4
  const offsetSize = b[p] >> 4
  const lengthSize = b[p] & 15
  const baseOffsetSize = b[p + 1] >> 4
  const indexSize = ver === 1 || ver === 2 ? b[p + 1] & 15 : 0
  p += 2
  const count = ver < 2 ? view.getUint16(p) : view.getUint32(p)
  p += ver < 2 ? 2 : 4
  const readN = (width: number): number => {
    let v = 0
    for (let i = 0; i < width; i++) v = v * 256 + b[p + i]
    p += width
    return v
  }
  for (let i = 0; i < count; i++) {
    const id = ver < 2 ? view.getUint16(p) : view.getUint32(p)
    p += ver < 2 ? 2 : 4
    let construction = 0
    if (ver === 1 || ver === 2) {
      construction = b[p + 1] & 15
      p += 2
    }
    p += 2 // data_reference_index
    const base = readN(baseOffsetSize)
    const extents = view.getUint16(p)
    p += 2
    const got: Array<[number, number]> = []
    for (let j = 0; j < extents; j++) {
      if (indexSize) p += indexSize
      const off = readN(offsetSize)
      const len = readN(lengthSize)
      got.push([base + off, len])
    }
    if (id === wanted) {
      // construction_method 1 means the bytes live in an `idat` box and 2 means
      // another item holds them. Apple writes EXIF with method 0 (plain file
      // offsets); anything else is refused rather than read from the wrong place.
      return construction === 0 ? got : null
    }
  }
  return null
}

/**
 * The TIFF block from a HEIF container's `Exif` item, ready for `exifr.parse`.
 *
 * Returns null when the file is not ISO-BMFF, carries no EXIF item, or stores it
 * somewhere this does not follow — all of which mean "no EXIF here", never "trust
 * these bytes anyway".
 */
export function heifExifTiff(bytes: Uint8Array): Uint8Array | null {
  if (!isIsoBmff(bytes)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const meta = findBox(bytes, view, 0, bytes.length, 'meta')
  if (!meta) return null
  const types = itemTypes(bytes, view, meta)
  let exifId: number | null = null
  types.forEach((t, id) => { if (exifId == null && t === 'Exif') exifId = id })
  if (exifId == null) return null
  const extents = itemExtents(bytes, view, meta, exifId)
  if (!extents?.length) return null

  // Join the extents (almost always one) into the item payload.
  const total = extents.reduce((n, [, len]) => n + len, 0)
  if (!total || total > bytes.length) return null
  const payload = new Uint8Array(total)
  let at = 0
  for (const [off, len] of extents) {
    if (off < 0 || off + len > bytes.length) return null
    payload.set(bytes.subarray(off, off + len), at)
    at += len
  }

  // ISO/IEC 23008-12 §A.2.1: the payload opens with a 4-byte offset to the TIFF
  // header, which is almost always 0 but is not guaranteed to be. Skip it and
  // whatever it points past, then check we really landed on a TIFF byte-order
  // mark — "II*\0" or "MM\0*" — rather than hand exifr arbitrary bytes.
  if (payload.length < 8) return null
  const skip = 4 + ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3])
  if (skip < 4 || skip + 4 > payload.length) return null
  const tiff = payload.subarray(skip)
  const le = tiff[0] === 0x49 && tiff[1] === 0x49 && tiff[2] === 0x2a && tiff[3] === 0x00
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d && tiff[2] === 0x00 && tiff[3] === 0x2a
  if (!le && !be) return null
  return tiff
}
