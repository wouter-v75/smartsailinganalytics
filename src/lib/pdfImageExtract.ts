// src/lib/pdfImageExtract.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pull the embedded JPEGs out of a PDF's raw bytes. North SailScan PDFs embed
// the analysed sail photo (the shot with the red stripe overlay) as a DCTDecode
// (JPEG) image stream — a JPEG file's bytes sit verbatim in the PDF. We scan for
// SOI…EOI (FF D8 FF … FF D9) spans and return them. No pdf.js needed.
//
// NOT EVERY PDF LEAVES THEM VERBATIM. Baraka's Sail Vision reports write
// `/Filter [ /ASCII85Decode /DCTDecode ]`: the same JPEG, ASCII85-armoured, so
// the bytes on disk are printable text and there is no FF D8 FF anywhere in the
// file to find. The byte scan returned zero images and the import quietly
// carried on without photos — `importScan` swallows an extraction failure on
// purpose, so twenty scans arrived with no pictures and nothing said why.
// `extractJpegBytesList` now falls back to un-armouring those streams.
// ─────────────────────────────────────────────────────────────────────────────

// All embedded JPEG byte-spans, in document (byte) order. Each span runs SOI…EOI
// (FF D8 FF … FF D9), with the last EOI before the next SOI taken as the end so an
// embedded EXIF thumbnail (whose EOI comes first) doesn't truncate the image.
function jpegSpans(data: Uint8Array): Array<[number, number]> {
  const n = data.length
  const spans: Array<[number, number]> = []
  for (let i = 0; i + 3 < n; i++) {
    if (data[i] === 0xff && data[i + 1] === 0xd8 && data[i + 2] === 0xff) {
      let end = -1
      let j = i + 2
      for (; j + 1 < n; j++) {
        if (data[j] === 0xff && data[j + 1] === 0xd8 && data[j + 2] === 0xff) break
        if (data[j] === 0xff && data[j + 1] === 0xd9) end = j + 1
      }
      if (end > i) { spans.push([i, end]); i = end }
    }
  }
  return spans
}

// Return the byte range of the largest embedded JPEG, or null if none.
export function extractLargestJpegBytes(data: Uint8Array): Uint8Array | null {
  let best: [number, number] | null = null
  for (const s of jpegSpans(data)) if (!best || s[1] - s[0] > best[1] - best[0]) best = s
  if (best) return data.subarray(best[0], best[1] + 1)
  // Nothing verbatim: the streams may be ASCII85-armoured.
  let biggest: Uint8Array | null = null
  for (const img of extractAscii85JpegList(data, 0)) {
    if (!biggest || img.length > biggest.length) biggest = img
  }
  return biggest
}

/**
 * Adobe ASCII85 → bytes.
 *
 * Five printable characters carry four bytes, '!' is 0 and 'u' is 84. 'z' is the
 * shorthand for four zero bytes, `~>` ends the data and a leading `<~` is
 * allowed. All whitespace is skipped, which matters because a PDF writer wraps
 * these streams at 80 columns. A short final group is padded with 'u' and yields
 * one byte fewer than it has characters.
 */
export function ascii85Decode(src: Uint8Array): Uint8Array {
  const out: number[] = []
  let tuple = 0
  let count = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    // whitespace
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) continue
    if (c === 0x3c && src[i + 1] === 0x7e) { i++; continue } // leading "<~"
    if (c === 0x7e) break // "~>" — end of data
    if (c === 0x7a && count === 0) { out.push(0, 0, 0, 0); continue } // "z"
    if (c < 0x21 || c > 0x75) continue // not an ASCII85 digit
    tuple = tuple * 85 + (c - 0x21)
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff)
      tuple = 0
      count = 0
    }
  }
  if (count > 0) {
    // Pad the partial group with 'u' (84) and keep count-1 bytes.
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84
    const b = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff]
    for (let i = 0; i < count - 1; i++) out.push(b[i])
  }
  return new Uint8Array(out)
}

const ascii = (s: string) => {
  const a = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i)
  return a
}

/** First index of `needle` in `hay` at or after `from`, or -1. */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/**
 * Every ASCII85-armoured JPEG in the file, decoded, in document order.
 *
 * Finds each `/ASCII85Decode` that is paired with `/DCTDecode` in the same image
 * dictionary — the pairing is the guard, because ASCII85 also armours content
 * streams that are not pictures — then un-armours the bytes between `stream` and
 * the `~>` end-of-data marker.
 *
 * Document order is page order here, which is what the importer needs: it maps
 * photo i onto scan i, and a Sail Vision report is one scan per page.
 */
export function extractAscii85JpegList(data: Uint8Array, minSize = 20000): Uint8Array[] {
  const A85 = ascii('ASCII85Decode')
  const DCT = ascii('DCTDecode')
  const STREAM = ascii('stream')
  const ENDSTREAM = ascii('endstream')
  const EOD = ascii('~>')
  const out: Uint8Array[] = []
  let at = 0
  for (;;) {
    const f = indexOfBytes(data, A85, at)
    if (f < 0) break
    at = f + A85.length
    const s = indexOfBytes(data, STREAM, at)
    if (s < 0) break
    // DCTDecode must sit in the same dictionary, i.e. before this stream starts.
    const d = indexOfBytes(data, DCT, f)
    if (d < 0 || d > s) continue
    let b = s + STREAM.length
    if (data[b] === 0x0d) b++
    if (data[b] === 0x0a) b++
    const end = indexOfBytes(data, ENDSTREAM, b)
    const eod = indexOfBytes(data, EOD, b)
    const stop = eod >= 0 && (end < 0 || eod < end) ? eod : end
    if (stop < 0) break
    const img = ascii85Decode(data.subarray(b, stop))
    // Only keep it if it really is a JPEG once un-armoured.
    if (img.length >= minSize && img[0] === 0xff && img[1] === 0xd8 && img[2] === 0xff) out.push(img)
    at = stop
  }
  return out
}

// Return every embedded JPEG ≥ minSize, in document (byte) order — used by the
// Sail Comparison import where one PDF carries the two analysed photos (left,
// then right). The size floor drops the small NS logo (~64 KB) but keeps the
// ~700 KB photos. Order = page draw order = left→right scan order.
export function extractJpegBytesList(data: Uint8Array, minSize = 120000): Uint8Array[] {
  const verbatim = jpegSpans(data)
    .filter(([a, b]) => b - a + 1 >= minSize)
    .map(([a, b]) => data.subarray(a, b + 1))
  if (verbatim.length) return verbatim
  // Sail Vision: `/Filter [ /ASCII85Decode /DCTDecode ]`, so there is no SOI in
  // the file to scan for. Same JPEGs, same page order, one layer of armour.
  return extractAscii85JpegList(data, minSize)
}

// Browser helper: read a File/Blob and return the largest embedded JPEG as a
// Blob (image/jpeg), or null. Used at SailScan import to stash the sail photo.
export async function extractLargestJpegBlob(file: Blob): Promise<Blob | null> {
  const buf = new Uint8Array(await file.arrayBuffer())
  const bytes = extractLargestJpegBytes(buf)
  if (!bytes || bytes.length < 2000) return null // ignore tiny logos
  // Copy into a fresh ArrayBuffer so the Blob isn't a view over the whole PDF.
  return new Blob([bytes.slice()], { type: 'image/jpeg' })
}

// Browser helper: every embedded photo (≥ minSize) as Blobs, in byte order.
// For a Sail Comparison PDF this is [leftPhoto, rightPhoto].
export async function extractJpegBlobs(file: Blob, minSize = 120000): Promise<Blob[]> {
  const buf = new Uint8Array(await file.arrayBuffer())
  return extractJpegBytesList(buf, minSize).map((bytes) => new Blob([bytes.slice()], { type: 'image/jpeg' }))
}
