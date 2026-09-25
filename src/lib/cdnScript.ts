// One place that pulls a UMD library off a CDN at the moment it is first needed.
//
// This pattern was written out by hand six times — heic2any three times (PhotosTab,
// SailScanTab, photoStore), jsPDF three times (SailScanDetail, SailScanCompare,
// BoatConfigTab) — each copy byte-identical apart from its variable names, and each
// with its OWN module-level promise. Separate caches are the bug: open the sail-scan
// detail and the rig card in one session and both append a <script> for the same
// jsPDF, because neither knows about the other's in-flight load. A failed load left
// its dead <script> in the head, and the next attempt appended another beside it.
//
// The cache here is keyed by URL and shared by every caller, so a library is fetched
// once per page no matter who asks or how many ask at the same time. A rejection is
// evicted, so a retry after a dropped connection genuinely retries.

const inFlight = new Map<string, Promise<unknown>>()

/**
 * Load a UMD script once and resolve the global it defines.
 *
 * @param src         CDN URL of the script.
 * @param pick        Reads the library off `window` once the script has run.
 * @param label       Name used in the error when the load fails.
 */
export function loadCdnGlobal<T>(
  src: string,
  pick: (w: Window & Record<string, unknown>) => T | undefined,
  label: string
): Promise<T> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error(`${label} needs a browser`))
  }
  const w = window as unknown as Window & Record<string, unknown>

  // Already on the page — from an earlier load, or a <script> someone else added.
  const present = pick(w)
  if (present) return Promise.resolve(present)

  const existing = inFlight.get(src)
  if (existing) return existing as Promise<T>

  const p = new Promise<T>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => {
      const lib = pick(w)
      if (lib) resolve(lib)
      else reject(new Error(`${label} loaded but did not define its global`))
    }
    s.onerror = () => reject(new Error(`failed to load ${label}`))
    document.head.appendChild(s)
  }).catch((e) => {
    // Drop the rejected promise AND its dead tag, so the next call really retries
    // rather than handing back the same failure for the life of the page.
    inFlight.delete(src)
    document.head.querySelector(`script[src="${CSS.escape(src)}"]`)?.remove()
    throw e
  })

  inFlight.set(src, p)
  return p
}

// ── The libraries SSA actually loads this way ────────────────────────────────

const HEIC2ANY_URL = 'https://cdnjs.cloudflare.com/ajax/libs/heic2any/0.0.4/heic2any.min.js'
const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
const EXIFR_URL = 'https://unpkg.com/exifr@7.1.3/dist/full.umd.js'

type Heic2Any = (opts: { blob: Blob; toType: string; quality?: number }) => Promise<Blob | Blob[]>

/** iPhone photos are HEIC/HEIF, which non-Safari browsers cannot render. */
export function loadHeic2any(): Promise<Heic2Any> {
  return loadCdnGlobal<Heic2Any>(
    HEIC2ANY_URL,
    (w) => w.heic2any as Heic2Any | undefined,
    'heic2any'
  )
}

/**
 * HEIC/HEIF → a JPEG File; anything else is passed straight through.
 *
 * heic2any returns a Blob, or an array of them for a multi-image HEIC — all three
 * call sites wanted the first frame, but only one of them said so. Here it is said
 * once.
 */
export async function heicToJpeg(file: File, quality = 0.92): Promise<File> {
  const isHeic =
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    /\.(heic|heif)$/i.test(file.name)
  if (!isHeic) return file
  const heic2any = await loadHeic2any()
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality })
  const blob = Array.isArray(out) ? out[0] : out
  return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsPDF ships no types here
type JsPdfCtor = any

/** jsPDF's UMD build hangs the constructor off `window.jspdf.jsPDF`. */
export function loadJsPdf(): Promise<JsPdfCtor> {
  return loadCdnGlobal<JsPdfCtor>(
    JSPDF_URL,
    (w) => (w.jspdf as { jsPDF?: JsPdfCtor } | undefined)?.jsPDF,
    'jsPDF'
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- exifr ships no types for the UMD build
export type Exifr = { parse: (input: File | Blob | ArrayBuffer, opts?: any) => Promise<any> }

/**
 * exifr, for reading EXIF off a photo in the browser.
 *
 * `photoStore.js` still has its own copy of this loader from before
 * `loadCdnGlobal` existed; new callers use this one. Worth knowing when you
 * read the EXIF this returns: the capture time has no timezone and is venue
 * LOCAL wall-clock, and the re-exported/overlaid files that reach SSA have had
 * `FocalLength`, `Model` and `LensModel` stripped — only the untouched
 * originals still carry them.
 */
export function loadExifr(): Promise<Exifr> {
  return loadCdnGlobal<Exifr>(EXIFR_URL, (w) => w.exifr as Exifr | undefined, 'exifr')
}
