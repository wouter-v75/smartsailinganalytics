'use client';
// src/lib/sailscan-cv.ts
// ─────────────────────────────────────────────────────────────────────────────
// SailScan v2 — computer-vision foundation.
//
// Lazy-loads OpenCV.js (~8.5 MB WASM) from unpkg only when a v2 feature is
// invoked, so v1.2 users never pay the cost. Provides:
//
//   loadOpenCV()             → Promise<cv>      idempotent, cached
//   applyClahe()             → CLAHE-normalised gray Mat
//   structureTensor()        → per-pixel dominant orientation + coherence
//   maskByOrientation()      → keep only ~horizontal pixels (luff/leech filter)
//   horizontalOnlyEdges()    → full pipeline: CLAHE → orientation mask → Canny
//   colorizeOrientation()    → HSV preview of the orientation map
//   matToImageData()         → paint a Mat to a 2D canvas
//
// Caller is responsible for `mat.delete()` on returned Mats (Emscripten heap).
//
// All algorithm choices are documented in docs/sailscan/prior-art.md. Key idea
// for distinguishing trim stripes (horizontal) from luff/leech (vertical):
// compute per-pixel image orientation via gradient structure tensor and mask
// out near-vertical pixels *before* edge detection.
// ─────────────────────────────────────────────────────────────────────────────

// We don't have @types/opencv-js so we accept the whole API as `any`.
// Concrete types are documented inline at use sites.
type CV = any;
type Mat = any;

// ── Lazy loader ─────────────────────────────────────────────────────────────
// CRITICAL: OpenCV's `cv` namespace object is itself a *thenable* — it has a
// `.then` method (Emscripten Module convention for `await Module()` style
// init). If `cv` ever appears as the resolved value of a Promise — including
// the return value of an async function — the Promise machinery chains
// through `cv.then(resolve, reject)`, which after init is a silent no-op.
// The whole Promise stalls forever and microtask handlers (including any
// `.then` we add) never fire.
//
// To avoid this entirely the loader API is split:
//   - `ensureOpenCV(): Promise<void>` — resolves once cv is fully ready.
//   - `getCV(): CV`                   — synchronous accessor, throws if not.
// `cv` itself is never a Promise resolution value.
//
// Plus, "fully ready" means we can actually instantiate a Mat without throwing
// or hanging. Constructors existing isn't enough — Emscripten can populate
// `cv.Mat` on the namespace before the WASM heap is fully allocated. The
// canonical test is to `new cv.Mat(1, 1, cv.CV_8U)` inside a try/catch.
//
// We try multiple CDNs in order; the first that responds wins.
let cvReady: Promise<void> | null = null;

const OPENCV_URLS = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js',
  'https://unpkg.com/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js',
  'https://docs.opencv.org/4.10.0/opencv.js',
];

function isOpenCVFullyReady(): boolean {
  const cv = (window as any).cv;
  if (!cv) return false;
  if (typeof cv.Mat   !== 'function') return false;
  if (typeof cv.CLAHE !== 'function') return false;
  try {
    const t = new cv.Mat(1, 1, cv.CV_8U);
    t.delete();
    return true;
  } catch {
    return false;
  }
}

const log = (...args: any[]) => console.log('[SailScan:cv]', ...args);

function tryLoadScript(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    log('attempting', url);
    if (document.querySelector(`script[data-sailscan-cv][src="${url}"]`)) {
      log('script already in DOM for', url);
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.setAttribute('data-sailscan-cv', '1');
    let settled = false;
    const finish = (ok: boolean, err?: string) => {
      if (settled) return;
      settled = true;
      if (ok) { log('script onload', url); resolve(); }
      else    { log('script onerror / timeout', url, err); reject(new Error(err || 'script error')); }
    };
    s.onload  = () => finish(true);
    s.onerror = () => finish(false, 'onerror (likely network/CSP block)');
    setTimeout(() => finish(false, `script tag timed out after ${timeoutMs} ms`), timeoutMs);
    document.head.appendChild(s);
  });
}

// Synchronous accessor — call AFTER ensureOpenCV() has resolved.
// Throws if cv isn't ready, so call sites fail loudly instead of hanging.
export function getCV(): CV {
  if (!isOpenCVFullyReady()) {
    throw new Error('getCV called before ensureOpenCV resolved');
  }
  return (window as any).cv;
}

// Public loader API. Resolves with `void` so cv is never a Promise value.
export function ensureOpenCV(): Promise<void> {
  if (cvReady) return cvReady;
  cvReady = (async () => {
    const w = window as any;
    if (isOpenCVFullyReady()) { log('cv already fully ready, skipping load'); return; }

    let lastError: string = '';
    for (const url of OPENCV_URLS) {
      try {
        await tryLoadScript(url, 15000);
        // Script bytes arrived. WASM module is initialised slightly later.
        // Belt-and-braces readiness check: hook onRuntimeInitialized AND poll
        // for cv.Mat AND cv.CLAHE. We deliberately DON'T use cv.then(...) —
        // OpenCV's Module.then() is a non-Promise callback registrar and
        // chaining .catch on its return value blows up.
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (label: string) => { if (!settled) { settled = true; log(label); resolve(); } };
          const startedAt = Date.now();
          const INIT_TIMEOUT = 20000;

          // Hook the Emscripten callback if present.
          if (w.cv && typeof w.cv.onRuntimeInitialized !== 'undefined') {
            const prev = w.cv.onRuntimeInitialized;
            w.cv.onRuntimeInitialized = () => {
              try { prev?.(); } catch {}
              settle('onRuntimeInitialized fired');
            };
          }

          // The canonical readiness check: actually construct a Mat. Constructors
          // can be defined on the cv namespace before the WASM heap is alive,
          // and downstream calls hang silently in that partial state. This try
          // forces a heap allocation; if it succeeds, full init is guaranteed.
          const tick = () => {
            if (settled) return;
            if (isOpenCVFullyReady()) { settle('Mat-instance test passed — fully ready'); return; }
            if (Date.now() - startedAt > INIT_TIMEOUT) {
              const cv = (window as any).cv;
              reject(new Error(`WASM init timed out — Mat=${typeof cv?.Mat}, CLAHE=${typeof cv?.CLAHE}`));
              return;
            }
            setTimeout(tick, 60);
          };
          tick();
        });
        log('OpenCV ready (from', url, ')');
        return; // resolves the outer cvReady promise with void
      } catch (e: any) {
        lastError = `${url}: ${e?.message || e}`;
        log('CDN failed:', lastError);
      }
    }
    throw new Error('All OpenCV CDNs failed. Last: ' + lastError);
  })();
  // Reset the cached promise on failure so the user can retry without a reload.
  cvReady.catch(() => { cvReady = null; });
  log('ensureOpenCV returning cvReady (caller will await void)');
  return cvReady;
}

export function isOpenCVLoaded(): boolean {
  return isOpenCVFullyReady();
}

// ── Pipeline helpers ────────────────────────────────────────────────────────

// CLAHE = contrast-limited adaptive histogram equalisation. Better than plain
// histogram equalisation for outdoor sail photos with strong sky/sail contrast.
// `grayMat` must be CV_8UC1. Returns a new Mat (caller deletes).
export function applyClahe(cv: CV, grayMat: Mat, clipLimit = 3.0, tileGrid = 8): Mat {
  const dst = new cv.Mat();
  const clahe = new cv.CLAHE(clipLimit, new cv.Size(tileGrid, tileGrid));
  clahe.apply(grayMat, dst);
  clahe.delete();
  return dst;
}

// Compute the gradient structure tensor and derive per-pixel:
//   - dominant orientation (degrees [0, 180), 0/180 = horizontal, 90 = vertical)
//   - coherence in [0, 1]: how strongly oriented the pixel is (1 = perfect line,
//     0 = isotropic noise). We use this to ignore textureless pixels.
// Returns two CV_32F single-channel Mats. Caller deletes both.
export function structureTensor(
  cv: CV,
  grayMat: Mat,
  smoothSigma = 3,
  smoothKernel = 11,
): { angle: Mat; coherence: Mat } {
  const Ix = new cv.Mat();
  const Iy = new cv.Mat();
  cv.Sobel(grayMat, Ix, cv.CV_32F, 1, 0, 3);
  cv.Sobel(grayMat, Iy, cv.CV_32F, 0, 1, 3);

  const Ixx = new cv.Mat();
  const Iyy = new cv.Mat();
  const Ixy = new cv.Mat();
  cv.multiply(Ix, Ix, Ixx);
  cv.multiply(Iy, Iy, Iyy);
  cv.multiply(Ix, Iy, Ixy);

  const ksize = new cv.Size(smoothKernel, smoothKernel);
  cv.GaussianBlur(Ixx, Ixx, ksize, smoothSigma);
  cv.GaussianBlur(Iyy, Iyy, ksize, smoothSigma);
  cv.GaussianBlur(Ixy, Ixy, ksize, smoothSigma);

  const w = grayMat.cols, h = grayMat.rows;
  const angle = new cv.Mat(h, w, cv.CV_32F);
  const coherence = new cv.Mat(h, w, cv.CV_32F);
  const xx = Ixx.data32F as Float32Array;
  const yy = Iyy.data32F as Float32Array;
  const xy = Ixy.data32F as Float32Array;
  const aD = angle.data32F as Float32Array;
  const cD = coherence.data32F as Float32Array;

  for (let i = 0, n = w * h; i < n; i++) {
    const a = xx[i], b = yy[i], c = xy[i];
    const num = Math.sqrt((a - b) * (a - b) + 4 * c * c);
    const den = a + b + 1e-6;
    cD[i] = Math.max(0, Math.min(1, num / den));
    let angDeg = (0.5 * Math.atan2(2 * c, a - b)) * (180 / Math.PI);
    angDeg = ((angDeg % 180) + 180) % 180;
    aD[i] = angDeg;
  }

  Ix.delete(); Iy.delete(); Ixx.delete(); Iyy.delete(); Ixy.delete();
  return { angle, coherence };
}

// Mask the gray image to keep only pixels whose dominant orientation falls in
// [minDeg, maxDeg] (default ±10° of horizontal) AND whose coherence exceeds a
// floor (rejects flat textureless regions). Rejected pixels are flattened to a
// neutral mid-gray (128) so subsequent Canny doesn't see edges there.
//
// Returns a new CV_8UC1 Mat (caller deletes).
export function maskByOrientation(
  cv: CV,
  grayMat: Mat,
  angleMat: Mat,
  opts: { minDeg?: number; maxDeg?: number; coherenceMat?: Mat; coherenceMin?: number } = {},
): Mat {
  const minDeg = opts.minDeg ?? 10;
  const maxDeg = opts.maxDeg ?? 170;
  const coMin  = opts.coherenceMin ?? 0.05;
  const coMat  = opts.coherenceMat;

  const out = grayMat.clone();
  const g  = out.data            as Uint8Array;
  const a  = angleMat.data32F    as Float32Array;
  const co = coMat?.data32F      as Float32Array | undefined;
  for (let i = 0, n = g.length; i < n; i++) {
    const inHorizontalBand = a[i] >= minDeg && a[i] <= maxDeg;
    const enoughCoherence  = !co || co[i] >= coMin;
    if (!inHorizontalBand || !enoughCoherence) {
      g[i] = 128;
    }
  }
  return out;
}

// Full pipeline: CLAHE → structure tensor → orientation mask → Canny.
// Returns a CV_8UC1 binary edge Mat. Caller deletes.
export function horizontalOnlyEdges(
  cv: CV,
  grayMat: Mat,
  opts: {
    minDeg?: number; maxDeg?: number; coherenceMin?: number;
    cannyLo?: number; cannyHi?: number;
  } = {},
): Mat {
  const lo = opts.cannyLo ?? 50;
  const hi = opts.cannyHi ?? 150;

  const enhanced = applyClahe(cv, grayMat);
  const { angle, coherence } = structureTensor(cv, enhanced);
  const masked = maskByOrientation(cv, enhanced, angle, {
    minDeg: opts.minDeg, maxDeg: opts.maxDeg,
    coherenceMat: coherence, coherenceMin: opts.coherenceMin,
  });
  const edges = new cv.Mat();
  cv.Canny(masked, edges, lo, hi);

  enhanced.delete();
  angle.delete();
  coherence.delete();
  masked.delete();
  return edges;
}

// ── Visualisation helpers (for the debug pane) ───────────────────────────────

// Render the orientation map as an HSV image where:
//   hue        = orientation (0° → red, 60° → yellow, ... wraps at 180° back to red)
//   saturation = coherence (clamped & boosted ×8 so low-coherence pixels show muted)
//   value      = 1
// Returns a CV_8UC4 RGBA Mat. Caller deletes.
export function colorizeOrientation(cv: CV, angleMat: Mat, coherenceMat: Mat): Mat {
  const w = angleMat.cols, h = angleMat.rows;
  const rgba = new cv.Mat(h, w, cv.CV_8UC4);
  const a = angleMat.data32F      as Float32Array;
  const co = coherenceMat.data32F as Float32Array;
  const px = rgba.data            as Uint8Array;
  for (let i = 0, n = w * h; i < n; i++) {
    const hue = (a[i] / 180) * 360;     // [0, 360)
    const sat = Math.max(0, Math.min(1, co[i] * 8));
    // HSV → RGB (V = 1)
    const c = sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = 1 - c;
    let r = 0, g = 0, b = 0;
    if      (hue <  60) { r = c; g = x; b = 0; }
    else if (hue < 120) { r = x; g = c; b = 0; }
    else if (hue < 180) { r = 0; g = c; b = x; }
    else if (hue < 240) { r = 0; g = x; b = c; }
    else if (hue < 300) { r = x; g = 0; b = c; }
    else                { r = c; g = 0; b = x; }
    const j = i * 4;
    px[j]     = Math.round((r + m) * 255);
    px[j + 1] = Math.round((g + m) * 255);
    px[j + 2] = Math.round((b + m) * 255);
    px[j + 3] = 255;
  }
  return rgba;
}

// Paint any Mat onto a 2D canvas. Matches OpenCV.js `cv.imshow` semantics but
// works without OpenCV's HTML helper, which expects a canvas id.
export function matToCanvas(cv: CV, mat: Mat, canvas: HTMLCanvasElement): void {
  // Convert non-RGBA mats to RGBA via cvtColor for ImageData compatibility.
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width  = mat.cols;
  canvas.height = mat.rows;
  let rgba: Mat | null = null;
  let bytes: Uint8Array;
  if (mat.type() === cv.CV_8UC4) {
    bytes = mat.data;
  } else if (mat.type() === cv.CV_8UC3) {
    rgba = new cv.Mat();
    cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA);
    bytes = rgba.data;
  } else if (mat.type() === cv.CV_8UC1) {
    rgba = new cv.Mat();
    cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
    bytes = rgba.data;
  } else {
    // Fallback: clamp to 0..255 and treat as gray
    rgba = new cv.Mat();
    mat.convertTo(rgba, cv.CV_8U);
    const gray = rgba;
    rgba = new cv.Mat();
    cv.cvtColor(gray, rgba, cv.COLOR_GRAY2RGBA);
    gray.delete();
    bytes = rgba.data;
  }
  const id = new ImageData(new Uint8ClampedArray(bytes), mat.cols, mat.rows);
  ctx.putImageData(id, 0, 0);
  rgba?.delete();
}

// ── Phase B: tap-the-luff seeded stripe detection ───────────────────────────
//
// Given a tap on the photo near the LUFF end of a stripe, find that one stripe
// and return enough points (luff + leech + 3 midpoints) to seed the v1.2 spline
// pipeline. The user can then drag/refine any point exactly as in v1.2.
//
// Algorithm:
//   1. Downsample to ≤1024 px on the long edge for speed; keep scale factor.
//   2. Convert to HSV.
//   3. If a per-yacht HSV hint was supplied, use it as the colour centre;
//      otherwise sample a 21×21 patch around the tap as the colour signature.
//   4. cv.inRange in HSV ±tolerances → binary mask. Hue wrap-around handled.
//   5. Morphological close to bridge stripe gaps from creases / wrinkles.
//   6. Connected components; pick the component containing the tap.
//   7. Within that component, the farthest pixel from the tap = leech.
//   8. Centerline = column-wise (or row-wise) median along the chord direction.
//   9. Sample 3 evenly-spaced midpoints along the centerline.
//  10. Map all coordinates back to the original image-pixel space.
//
// Confidence is the chord length / image-long-edge ratio; below 0.15 we
// surface it to the caller so the UI can prompt the user instead of silently
// shipping a tiny garbage stripe.

interface P { x: number; y: number; }

export interface DetectionResult {
  luff: P;
  leech: P;
  midpoints: P[];
  /** 0..1: chord length / image long edge. <0.15 = suspicious. */
  confidence: number;
  /** The HSV signature actually used (whether learned or supplied). */
  hsvSample: { h: number; s: number; v: number };
  /** Diagnostic flags for debugging. */
  componentArea: number;
  imageWidth: number;
  imageHeight: number;
}

export function detectStripeFromTap(
  cv: CV,
  imgElement: HTMLImageElement | HTMLCanvasElement,
  tapImagePx: P,
  options: {
    hsvHint?: { h: number; s: number; v: number };
    hueTol?: number;
    satTol?: number;
    valTol?: number;
    morphKernelPx?: number;
  } = {},
): DetectionResult {
  const hueTol = options.hueTol ?? 18;
  const satTol = options.satTol ?? 70;
  const valTol = options.valTol ?? 70;
  const morphPx = options.morphKernelPx ?? 5;

  const imgW = (imgElement as HTMLImageElement).naturalWidth || imgElement.width;
  const imgH = (imgElement as HTMLImageElement).naturalHeight || imgElement.height;
  const MAX = 1024;
  const scale = Math.min(1, MAX / Math.max(imgW, imgH));
  const w = Math.max(1, Math.round(imgW * scale));
  const h = Math.max(1, Math.round(imgH * scale));

  const tx = Math.max(0, Math.min(w - 1, Math.round(tapImagePx.x * scale)));
  const ty = Math.max(0, Math.min(h - 1, Math.round(tapImagePx.y * scale)));

  // Render image at downsampled resolution.
  const offcanvas = document.createElement('canvas');
  offcanvas.width = w; offcanvas.height = h;
  offcanvas.getContext('2d')!.drawImage(imgElement as any, 0, 0, w, h);

  const rgba = imageToMat(cv, offcanvas);
  const bgr = new cv.Mat();
  cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
  rgba.delete();
  const hsv = new cv.Mat();
  cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);
  bgr.delete();

  // Resolve HSV centre — provided hint or sample around tap.
  let hC: number, sC: number, vC: number;
  if (options.hsvHint) {
    hC = options.hsvHint.h; sC = options.hsvHint.s; vC = options.hsvHint.v;
  } else {
    const PR = 10;
    let hSum = 0, sSum = 0, vSum = 0, cnt = 0;
    const data = hsv.data as Uint8Array;
    for (let y = Math.max(0, ty - PR); y <= Math.min(h - 1, ty + PR); y++) {
      for (let x = Math.max(0, tx - PR); x <= Math.min(w - 1, tx + PR); x++) {
        const idx = (y * w + x) * 3;
        hSum += data[idx]; sSum += data[idx + 1]; vSum += data[idx + 2];
        cnt++;
      }
    }
    hC = hSum / cnt; sC = sSum / cnt; vC = vSum / cnt;
  }

  // Build the binary mask. Two regimes:
  //   - Achromatic sample (sC < 50, e.g. white-on-dark stripes): hue is
  //     mathematically unreliable for near-white pixels, so we ignore H,
  //     restrict S to a tight low band (excluding coloured regions like sky),
  //     and threshold mainly on V. This is the regime sailing trim stripes
  //     usually fall into (white tape on a coloured sail).
  //   - Chromatic sample (sC ≥ 50, e.g. red, blue, yellow stripes): standard
  //     hue-window threshold with hue wrap-around handling.
  const isAchromatic = sC < 50;
  const mask = new cv.Mat();

  if (isAchromatic) {
    // Hue: full range. Sat: 0 to sC + 30 (tight cap to exclude saturated areas
    // like blue sky / coloured sail). Val: ±valTol around vC.
    const sCap = Math.min(255, sC + 30);
    const vLo = Math.max(0,   vC - valTol);
    const vHi = Math.min(255, vC + valTol);
    const lo = cv.matFromArray(1, 1, cv.CV_8UC3, [0,   0,    vLo]);
    const hi = cv.matFromArray(1, 1, cv.CV_8UC3, [180, sCap, vHi]);
    cv.inRange(hsv, lo, hi, mask);
    lo.delete(); hi.delete();
  } else {
    const sLo = Math.max(0,   sC - satTol);
    const sHi = Math.min(255, sC + satTol);
    const vLo = Math.max(0,   vC - valTol);
    const vHi = Math.min(255, vC + valTol);
    const hLoRaw = hC - hueTol;
    const hHiRaw = hC + hueTol;
    if (hLoRaw < 0 || hHiRaw > 180) {
      const lo1 = cv.matFromArray(1, 1, cv.CV_8UC3, [Math.max(0, ((hLoRaw + 180) % 180)), sLo, vLo]);
      const hi1 = cv.matFromArray(1, 1, cv.CV_8UC3, [180, sHi, vHi]);
      const lo2 = cv.matFromArray(1, 1, cv.CV_8UC3, [0, sLo, vLo]);
      const hi2 = cv.matFromArray(1, 1, cv.CV_8UC3, [Math.min(180, ((hHiRaw + 180) % 180)), sHi, vHi]);
      const m1 = new cv.Mat();
      const m2 = new cv.Mat();
      cv.inRange(hsv, lo1, hi1, m1);
      cv.inRange(hsv, lo2, hi2, m2);
      cv.bitwise_or(m1, m2, mask);
      lo1.delete(); hi1.delete(); lo2.delete(); hi2.delete(); m1.delete(); m2.delete();
    } else {
      const lo = cv.matFromArray(1, 1, cv.CV_8UC3, [Math.max(0, hLoRaw), sLo, vLo]);
      const hi = cv.matFromArray(1, 1, cv.CV_8UC3, [Math.min(180, hHiRaw), sHi, vHi]);
      cv.inRange(hsv, lo, hi, mask);
      lo.delete(); hi.delete();
    }
  }
  hsv.delete();

  // Bridge small gaps within stripes.
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(morphPx, morphPx));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
  kernel.delete();

  // Find connected components and pick the one containing the tap.
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  cv.connectedComponentsWithStats(mask, labels, stats, centroids);

  const tapLabel = labels.intPtr(ty, tx)[0];
  if (tapLabel === 0) {
    mask.delete(); labels.delete(); stats.delete(); centroids.delete();
    throw new Error('Tap landed on background — try tapping more precisely on the stripe.');
  }

  const cArea = stats.intPtr(tapLabel, cv.CC_STAT_AREA)[0] as number;
  const cX = stats.intPtr(tapLabel, cv.CC_STAT_LEFT)[0] as number;
  const cY = stats.intPtr(tapLabel, cv.CC_STAT_TOP)[0] as number;
  const cW = stats.intPtr(tapLabel, cv.CC_STAT_WIDTH)[0] as number;
  const cH = stats.intPtr(tapLabel, cv.CC_STAT_HEIGHT)[0] as number;

  // Find leech = pixel in component farthest from tap.
  let leechX = tx, leechY = ty;
  let maxDist2 = 0;
  for (let y = cY; y < cY + cH; y++) {
    for (let x = cX; x < cX + cW; x++) {
      if (labels.intPtr(y, x)[0] !== tapLabel) continue;
      const dx = x - tx, dy = y - ty;
      const d2 = dx * dx + dy * dy;
      if (d2 > maxDist2) { maxDist2 = d2; leechX = x; leechY = y; }
    }
  }

  // Centerline: parameterise along the tap→leech vector. For each step t in
  // [0,1], find pixels in the component near the chord at that t and take the
  // perpendicular median. Robust to whether the stripe is roughly horizontal,
  // diagonal, or near-vertical.
  const dx = leechX - tx, dy = leechY - ty;
  const chordLen = Math.sqrt(maxDist2);
  const centerline: P[] = [];
  if (chordLen > 4) {
    const ux = dx / chordLen, uy = dy / chordLen;          // along-chord unit
    const nx = -uy, ny = ux;                                // perpendicular
    const SAMPLES = 40; // sample 40 t-positions along chord
    const PERP_RADIUS = 30;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const cx = tx + ux * chordLen * t;
      const cy = ty + uy * chordLen * t;
      // Collect perpendicular distances of in-component pixels near (cx, cy).
      const ds: number[] = [];
      for (let pp = -PERP_RADIUS; pp <= PERP_RADIUS; pp++) {
        const sx = Math.round(cx + nx * pp);
        const sy = Math.round(cy + ny * pp);
        if (sx < cX || sx >= cX + cW || sy < cY || sy >= cY + cH) continue;
        if (labels.intPtr(sy, sx)[0] === tapLabel) ds.push(pp);
      }
      if (ds.length === 0) continue;
      ds.sort((a, b) => a - b);
      const median = ds[Math.floor(ds.length / 2)];
      centerline.push({
        x: cx + nx * median,
        y: cy + ny * median,
      });
    }
  }

  mask.delete(); labels.delete(); stats.delete(); centroids.delete();

  // Pick 3 midpoints: at t = 0.25, 0.5, 0.75 along the chord.
  const midpoints: P[] = [];
  if (centerline.length >= 5) {
    [0.25, 0.5, 0.75].forEach(t => {
      const idx = Math.floor(t * (centerline.length - 1));
      const p = centerline[idx];
      midpoints.push({ x: p.x / scale, y: p.y / scale });
    });
  }

  // Map endpoints back to original-image space. Keep luff = user's exact tap.
  const luff: P = { x: tapImagePx.x, y: tapImagePx.y };
  const leech: P = { x: leechX / scale, y: leechY / scale };

  const longEdge = Math.max(w, h);
  const confidence = Math.max(0, Math.min(1, chordLen / (longEdge * 0.5)));

  return {
    luff, leech, midpoints,
    confidence,
    hsvSample: { h: hC, s: sC, v: vC },
    componentArea: cArea,
    imageWidth: imgW,
    imageHeight: imgH,
  };
}

// Read an HTMLImageElement (or canvas) into a fresh Mat (CV_8UC4 RGBA).
// Caller deletes.
//
// We deliberately avoid `cv.imread` because it can hang silently on
// offscreen canvases under certain WASM versions. `cv.matFromImageData` works
// from a plain ImageData and is much more reliable.
export function imageToMat(cv: CV, img: HTMLImageElement | HTMLCanvasElement): Mat {
  let canvas: HTMLCanvasElement;
  if (img instanceof HTMLCanvasElement) {
    canvas = img;
  } else {
    canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
  }
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return cv.matFromImageData(imgData);
}
