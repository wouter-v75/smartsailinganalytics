// src/lib/pdfImageExtract.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pull the largest embedded JPEG out of a PDF's raw bytes. North SailScan PDFs
// embed the analysed sail photo (the shot with the red stripe overlay) as a
// DCTDecode (JPEG) image stream — a JPEG file's bytes sit verbatim in the PDF.
// We scan for SOI…EOI (FF D8 FF … FF D9) spans and return the largest, which is
// the photo (a small header graphic is the only other JPEG). No pdf.js needed.
// ─────────────────────────────────────────────────────────────────────────────

// Return the byte range of the largest embedded JPEG, or null if none.
export function extractLargestJpegBytes(data: Uint8Array): Uint8Array | null {
  const n = data.length
  let best: [number, number] | null = null
  for (let i = 0; i + 3 < n; i++) {
    if (data[i] === 0xff && data[i + 1] === 0xd8 && data[i + 2] === 0xff) {
      // Walk to the end of this JPEG: remember the last EOI before the next SOI
      // (handles an embedded EXIF thumbnail, whose EOI comes before the real one).
      let end = -1
      let j = i + 2
      for (; j + 1 < n; j++) {
        if (data[j] === 0xff && data[j + 1] === 0xd8 && data[j + 2] === 0xff) break
        if (data[j] === 0xff && data[j + 1] === 0xd9) end = j + 1
      }
      if (end > i) {
        if (!best || end - i > best[1] - best[0]) best = [i, end]
        i = end
      }
    }
  }
  return best ? data.subarray(best[0], best[1] + 1) : null
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
