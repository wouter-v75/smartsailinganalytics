// src/lib/pdfImageExtract.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pull the largest embedded JPEG out of a PDF's raw bytes. North SailScan PDFs
// embed the analysed sail photo (the shot with the red stripe overlay) as a
// DCTDecode (JPEG) image stream — a JPEG file's bytes sit verbatim in the PDF.
// We scan for SOI…EOI (FF D8 FF … FF D9) spans and return the largest, which is
// the photo (a small header graphic is the only other JPEG). No pdf.js needed.
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
  return best ? data.subarray(best[0], best[1] + 1) : null
}

// Return every embedded JPEG ≥ minSize, in document (byte) order — used by the
// Sail Comparison import where one PDF carries the two analysed photos (left,
// then right). The size floor drops the small NS logo (~64 KB) but keeps the
// ~700 KB photos. Order = page draw order = left→right scan order.
export function extractJpegBytesList(data: Uint8Array, minSize = 120000): Uint8Array[] {
  return jpegSpans(data)
    .filter(([a, b]) => b - a + 1 >= minSize)
    .map(([a, b]) => data.subarray(a, b + 1))
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
