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

import { heifExifTiff } from './heifExif'

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

// libheif, compiled to wasm. This replaced heic2any (0.0.4, last published 2021),
// which refused an iPhone 16 Pro's HEIC outright — `ERR_LIBHEIF format not
// supported`, thrown in 18 ms, i.e. before it decoded anything. Measured side by
// side on the same three files: heic2any did a 12 MP iPhone 12 photo in 1854 ms
// and failed both 24 MP iPhone 16 Pro ones; libheif-js did all three, the 12 MP
// in ~800 ms and each 24 MP in ~1.5 s once the module is up (the FIRST
// conversion of a session also pays the wasm load, so budget 3-4 s for it). The
// bundles are the same size to within 8 % (1.46 MB against 1.35 MB), so there
// was nothing to trade away.
const LIBHEIF_URL = 'https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.js'
const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
const EXIFR_URL = 'https://unpkg.com/exifr@7.1.3/dist/full.umd.js'

type HeifImage = {
  get_width: () => number
  get_height: () => number
  display: (into: ImageData, done: (out: ImageData | null) => void) => void
  free?: () => void
}
type LibHeif = { HeifDecoder: new () => { decode: (bytes: Uint8Array) => HeifImage[] } }
// The bundle defines `window.libheif` as a FACTORY that instantiates the wasm
// module, not the module itself. Calling it twice builds two of them, so the
// resolved module is memoised here rather than left to loadCdnGlobal's per-URL
// cache, which only promises the SCRIPT ran once.
type LibHeifFactory = (() => LibHeif | Promise<LibHeif>) | LibHeif
let heifModule: Promise<LibHeif> | null = null

/** libheif's wasm build — the HEIC/HEIF decoder for browsers that have none. */
export function loadLibheif(): Promise<LibHeif> {
  if (heifModule) return heifModule
  heifModule = loadCdnGlobal<LibHeifFactory>(
    LIBHEIF_URL,
    (w) => w.libheif as LibHeifFactory | undefined,
    'libheif'
  )
    .then((f) => (typeof f === 'function' ? f() : f))
    .then((lib) => {
      if (!lib?.HeifDecoder) throw new Error('libheif loaded without a HeifDecoder')
      return lib
    })
    .catch((e) => {
      heifModule = null // so a retry after a dropped connection really retries
      throw e
    })
  return heifModule
}

/** Is this a file we should put through the HEIC decoder at all? */
export function isHeicFile(file: { type?: string; name?: string }): boolean {
  return (
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    /\.(heic|heif)$/i.test(file.name || '')
  )
}

const toJpegBlob = (c: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', quality))

/**
 * HEIC/HEIF → a JPEG File; anything else is passed straight through.
 *
 * Only the PRIMARY image is converted. A modern iPhone HEIC holds over a hundred
 * items — tiles, a depth map, an HDR gain map, a thumbnail — and libheif hands
 * back just the displayable one, which is what used to need picking out of
 * heic2any's array by hand.
 *
 * It THROWS rather than returning the original on failure. A caller that quietly
 * keeps undecodable bytes gets a photo that imports cleanly and then fails
 * somewhere else entirely — which is how a decoder problem came to be reported
 * to the user as "thumb load failed".
 */
export async function heicToJpeg(file: File, quality = 0.92): Promise<File> {
  if (!isHeicFile(file)) return file
  const lib = await loadLibheif()
  const decoder = new lib.HeifDecoder()
  const images = decoder.decode(new Uint8Array(await file.arrayBuffer()))
  if (!images?.length) throw new Error(`${file.name}: no image found in the HEIC`)
  const image = images[0]
  try {
    const w = image.get_width()
    const h = image.get_height()
    if (!w || !h) throw new Error(`${file.name}: the HEIC reports a ${w}x${h} image`)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d canvas context')
    const data = await new Promise<ImageData>((resolve, reject) => {
      image.display(new ImageData(w, h), (out) =>
        out ? resolve(out) : reject(new Error(`${file.name}: HEIC decode failed`))
      )
    })

    // A 24 MP photo is a 4284x5712 canvas, and iOS Safari caps canvas AREA well
    // below that on some devices — where it does, toBlob yields null rather than
    // an error. Halving until it encodes keeps a phone import working; the JPEG
    // is then smaller but not WRONG, because SailTrim derives mm/px from a known
    // length inside the image, so a uniform scale cancels out of every
    // measurement. It is warned about because it is still a loss of precision.
    for (let shrink = 1; shrink <= 8; shrink *= 2) {
      canvas.width = Math.max(1, Math.round(w / shrink))
      canvas.height = Math.max(1, Math.round(h / shrink))
      if (shrink === 1) {
        ctx.putImageData(data, 0, 0)
      } else {
        const full = document.createElement('canvas')
        full.width = w
        full.height = h
        full.getContext('2d')?.putImageData(data, 0, 0)
        ctx.drawImage(full, 0, 0, canvas.width, canvas.height)
      }
      const blob = await toJpegBlob(canvas, quality)
      if (blob?.size) {
        if (shrink > 1) {
          console.warn(
            `heicToJpeg: ${file.name} would not encode at ${w}x${h} (canvas limit); ` +
              `stored at ${canvas.width}x${canvas.height}`
          )
        }
        return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })
      }
    }
    throw new Error(`${file.name}: could not encode the decoded HEIC as a JPEG`)
  } finally {
    try { image.free?.() } catch { /* older builds expose no free() */ }
  }
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
export type Exifr = { parse: (input: File | Blob | ArrayBuffer | Uint8Array, opts?: any) => Promise<any> }

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

/** What every caller here asks exifr for: time, camera, lens and position. */
const EXIF_WANTED = { tiff: true, exif: true, gps: true, ifd0: true }

/**
 * EXIF off a photo, including the HEICs exifr refuses to open.
 *
 * exifr 7.1.3 gates every ISO-BMFF file on the SIZE of its `ftyp` box and bails
 * at anything over 50 bytes, before it has looked at a single brand. An iPhone
 * 12's HEIC declares six compatible brands in 40 bytes and passes; an iPhone 16
 * Pro's declares nine — Apple added `MiHA`, `heix` and `tmap` for the HDR gain
 * map — in **52 bytes**, and gets "Unknown file format". 7.1.3 is the last
 * release its author published, so there is no version to move to.
 *
 * The cost of that is not a missing camera name. `readExif` and both scan tabs
 * fall back to `new Date()` when the parse fails, so the photo is filed under
 * TODAY instead of the day it was shot, and arrives with no focal length — which
 * makes SailTrim SKIP the depth correction and ψ's effective separation rather
 * than approximate them, while the frame still produces millimetres.
 *
 * So when exifr refuses, the EXIF is lifted out of the container by hand and
 * handed to exifr as the bare TIFF block it is — the parsing was never the
 * problem, only the sniff. Checked against `exiftool` on an iPhone 16 Pro pair:
 * identical time, lens, 24 mm equivalent, orientation and position. On a file
 * exifr DOES accept, the two routes agree field for field.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- exifr's own output is untyped
export async function parseExif(input: File | Blob, opts: any = EXIF_WANTED): Promise<any | null> {
  const exifr = await loadExifr()
  try {
    const direct = await exifr.parse(input, opts)
    if (direct) return direct
  } catch {
    /* fall through to the container walk */
  }
  let tiff: Uint8Array | null = null
  try {
    tiff = heifExifTiff(new Uint8Array(await input.arrayBuffer()))
  } catch {
    return null
  }
  if (!tiff) return null
  try {
    return (await exifr.parse(tiff, opts)) || null
  } catch {
    return null
  }
}
