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
//   3. Read the tap pixel's HSV directly — that is our reference colour.
//   4. Region-grow (BFS flood fill) from the tap pixel in HSV space, accepting
//      neighbours within ±HUE_DIFF / ±SAT_DIFF / ±VAL_DIFF of the tap pixel.
//      Hue tolerance is bypassed for achromatic samples (sC < 50, e.g. white
//      stripes), since hue is mathematically unstable at low saturation.
//   5. The component is bounded automatically by the dramatic colour jumps at
//      sail / sky / luff edges — no global threshold needed.
//   6. The farthest pixel in the component from the tap = leech.
//   7. Centerline sampled by walking along the tap→leech vector and taking the
//      perpendicular median of in-component pixels at each step.
//   8. Three midpoints sampled at t = 0.25, 0.50, 0.75 of the chord.
//   9. Coordinates mapped back to the original image-pixel space.
//
// Confidence is the chord length / image-long-edge ratio; below 0.15 we
// surface it to the caller so the UI can prompt the user instead of silently
// shipping a tiny garbage stripe.

interface P { x: number; y: number; }

// Gaussian elimination on a 4×4 system A·x = b. Returns x.
// Used by the cubic-LSQ fit for the centerline. Tolerates near-singular
// matrices by returning zeros (caller treats that as "no curve").
function solve4x4(A: number[][], b: number[]): number[] {
  const M: number[][] = A.map((row, i) => [row[0], row[1], row[2], row[3], b[i]]);
  for (let p = 0; p < 4; p++) {
    let pivot = p;
    for (let r = p + 1; r < 4; r++) {
      if (Math.abs(M[r][p]) > Math.abs(M[pivot][p])) pivot = r;
    }
    if (pivot !== p) { const tmp = M[p]; M[p] = M[pivot]; M[pivot] = tmp; }
    if (Math.abs(M[p][p]) < 1e-10) return [0, 0, 0, 0];
    for (let r = p + 1; r < 4; r++) {
      const f = M[r][p] / M[p][p];
      for (let c = p; c <= 4; c++) M[r][c] -= f * M[p][c];
    }
  }
  const x = [0, 0, 0, 0];
  for (let i = 3; i >= 0; i--) {
    let s = M[i][4];
    for (let j = i + 1; j < 4; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

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
    /** When provided, use this as the leech endpoint (in original-image
     *  coordinates) instead of the flood-fill's farthest-pixel result.
     *  Useful for the "user supplies both endpoints, app fills midpoints"
     *  workflow when the algorithm's auto-leech misses the actual stripe end. */
    leechHint?: P;
  } = {},
): DetectionResult {
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

  // The tap pixel itself is always our colour reference — read it directly
  // from the downsampled HSV mat (so it matches what we'll flood-fill on).
  // This sidesteps the previous "sample, threshold, hope tap matches"
  // pattern which broke when the brightest neighbour pixels were sky/glare.
  const data = hsv.data as Uint8Array;
  const tapIdxLin = ty * w + tx;
  const tapIdx = tapIdxLin * 3;
  const hC = data[tapIdx];
  const sC = data[tapIdx + 1];
  const vC = data[tapIdx + 2];
  console.log('[SailScan:cv] tap-pixel HSV (downsampled)', { tx, ty, hsv: { h: hC, s: sC, v: vC } });

  // ── Region-grow (flood fill) from the tap pixel in HSV space ────────────
  // Far more robust than threshold-around-mean for thin stripes:
  //   - The tap pixel is GUARANTEED to be in the component (it's the seed).
  //   - Tolerance is local — neighbours are added if they're similar to the
  //     tap pixel, not a global average. So small gradients along the stripe
  //     are fine, but the dramatic colour jumps at sail/sky/luff boundaries
  //     stop the growth automatically.
  //   - Hue tolerance only matters when the sample is chromatic; for the
  //     near-white stripes typical on sailing yachts (low S), the value
  //     tolerance dominates.
  const HUE_DIFF = options.hueTol ?? 15;
  const SAT_DIFF = options.satTol ?? 60;
  const VAL_DIFF = options.valTol ?? 60;
  const isAchromatic = sC < 50;

  const inMask = new Uint8Array(w * h);
  inMask[tapIdxLin] = 1;
  // Open queue (4-connectivity flood fill). We use indices to avoid object
  // churn; x = idx % w, y = idx / w.
  const queue: number[] = [tapIdxLin];
  let bbX0 = tx, bbY0 = ty, bbX1 = tx, bbY1 = ty;
  let leechX = tx, leechY = ty;
  let maxDist2 = 0;
  let cArea = 1;
  // Cap the BFS so a runaway flood fill (e.g. seed on uniform sail) can't
  // consume the whole image. 1/8 of pixels is generous for one stripe.
  const MAX_PIXELS = Math.max(2000, Math.floor((w * h) / 8));

  let qHead = 0;
  while (qHead < queue.length && cArea < MAX_PIXELS) {
    const idx = queue[qHead++];
    const y = (idx / w) | 0;
    const x = idx - y * w;
    // 4-connectivity neighbours
    const ns = [idx - 1, idx + 1, idx - w, idx + w];
    const nxs = [x - 1, x + 1, x,     x    ];
    const nys = [y,     y,     y - 1, y + 1];
    for (let k = 0; k < 4; k++) {
      const nx = nxs[k], ny = nys[k];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const nIdx = ns[k];
      if (inMask[nIdx]) continue;
      const dataIdx = nIdx * 3;
      const nH = data[dataIdx];
      const nS = data[dataIdx + 1];
      const nV = data[dataIdx + 2];
      // Hue is circular [0, 180); compute shortest difference.
      let dH = Math.abs(nH - hC);
      if (dH > 90) dH = 180 - dH;
      const dS = Math.abs(nS - sC);
      const dV = Math.abs(nV - vC);
      // For achromatic samples (white/grey stripes), ignore hue entirely:
      // hue is mathematically unstable when saturation is low, so the per-
      // pixel hue value is effectively random and would cap growth wrongly.
      const hueOk = isAchromatic || dH <= HUE_DIFF;
      const satOk = dS <= SAT_DIFF;
      const valOk = dV <= VAL_DIFF;
      inMask[nIdx] = 1; // mark visited regardless so we don't revisit
      if (!(hueOk && satOk && valOk)) continue;
      // Accept this neighbour into the component.
      cArea++;
      queue.push(nIdx);
      if (nx < bbX0) bbX0 = nx;
      if (ny < bbY0) bbY0 = ny;
      if (nx > bbX1) bbX1 = nx;
      if (ny > bbY1) bbY1 = ny;
      const ddx = nx - tx, ddy = ny - ty;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 > maxDist2) { maxDist2 = d2; leechX = nx; leechY = ny; }
    }
  }

  hsv.delete();

  if (cArea < 12) {
    throw new Error(
      `Component too small (${cArea}px) — tap was probably on background. Try tapping more precisely on the stripe.`,
    );
  }

  // Reconstruct an inMask that *only* contains accepted pixels, not "visited
  // but rejected" pixels. We tagged "accepted" by pushing to queue; rebuild
  // a boolean mask from that. (The earlier `inMask[nIdx] = 1` for rejected
  // neighbours was a visit-marker only.)
  const accepted = new Uint8Array(w * h);
  for (const idx of queue) accepted[idx] = 1;
  // Use a synthetic component bbox for downstream centerline sampling.
  const cX = bbX0, cY = bbY0;
  const cW = bbX1 - bbX0 + 1, cH = bbY1 - bbY0 + 1;

  // ── Resolve chord (tap→leech) ───────────────────────────────────────────
  // If the caller supplied an explicit leechHint (the user has manually
  // marked both luff and leech), use that as the leech and the chord
  // direction. Otherwise default to the flood-fill's farthest-pixel result.
  let chordTx = leechX, chordTy = leechY;
  if (options.leechHint) {
    chordTx = Math.max(0, Math.min(w - 1, Math.round(options.leechHint.x * scale)));
    chordTy = Math.max(0, Math.min(h - 1, Math.round(options.leechHint.y * scale)));
  }
  const dx = chordTx - tx, dy = chordTy - ty;
  const chordLen = Math.sqrt(dx * dx + dy * dy);

  // ── Sample centerline along the chord ───────────────────────────────────
  // Walk along the tap→leech vector, at each step collect perpendicular
  // distances of in-component pixels and take the median. We then smooth
  // those perp-distance values with a moving-average to remove jitter
  // caused by component spurs and chord-perpendicular wobble.
  const centerlineTs: number[] = [];
  const centerlineDs: number[] = [];
  let ux = 0, uy = 0, nx = 0, ny = 0;
  if (chordLen > 4) {
    ux = dx / chordLen; uy = dy / chordLen;          // along-chord unit
    nx = -uy;           ny = ux;                      // perpendicular
    const SAMPLES = 60;
    const PERP_RADIUS = 30;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const cx = tx + ux * chordLen * t;
      const cy = ty + uy * chordLen * t;
      const ds: number[] = [];
      for (let pp = -PERP_RADIUS; pp <= PERP_RADIUS; pp++) {
        const sx = Math.round(cx + nx * pp);
        const sy = Math.round(cy + ny * pp);
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        if (accepted[sy * w + sx]) ds.push(pp);
      }
      if (ds.length === 0) continue;
      ds.sort((a, b) => a - b);
      const median = ds[Math.floor(ds.length / 2)];
      centerlineTs.push(t);
      centerlineDs.push(median);
    }
  }

  // ── Constraint (a): canonical side of chord ─────────────────────────────
  // Sail trim stripes always curve to one side of the chord (the sail
  // belly). Determine that side from the majority sign of raw centerline
  // perpendicular distances, then drop any wrong-side samples as noise
  // before fitting.
  let posCnt = 0, negCnt = 0;
  for (const d of centerlineDs) { if (d > 0.5) posCnt++; else if (d < -0.5) negCnt++; }
  const stripeSide = posCnt >= negCnt ? 1 : -1;
  const filteredTs: number[] = [];
  const filteredDs: number[] = [];
  for (let i = 0; i < centerlineTs.length; i++) {
    if (centerlineDs[i] * stripeSide >= -0.5) {  // on-side or essentially zero
      filteredTs.push(centerlineTs[i]);
      filteredDs.push(centerlineDs[i]);
    }
  }

  // ── Constraint (b): bounded curvature via cubic LSQ fit ─────────────────
  // Fit  d(t) = c0 + c1·t + c2·t² + c3·t³  by weighted least squares.
  // Synthetic (0,0) and (1,0) anchors at high weight pin both endpoints to
  // the chord, since by definition the stripe centerline meets the chord at
  // luff and leech. A cubic curve is smooth-by-construction so adjacent
  // midpoints can never differ by an unbounded angle — they sit on the same
  // smooth curve.
  const ANCHOR_W = 100;
  const ts = [0, ...filteredTs, 1];
  const ds = [0, ...filteredDs, 0];
  const ws = ts.map((_, i) => (i === 0 || i === ts.length - 1) ? ANCHOR_W : 1);
  const sw = (k: number) => { let s = 0; for (let i = 0; i < ts.length; i++) s += ws[i] * Math.pow(ts[i], k); return s; };
  const swd = (k: number) => { let s = 0; for (let i = 0; i < ts.length; i++) s += ws[i] * Math.pow(ts[i], k) * ds[i]; return s; };
  const A = [
    [sw(0), sw(1), sw(2), sw(3)],
    [sw(1), sw(2), sw(3), sw(4)],
    [sw(2), sw(3), sw(4), sw(5)],
    [sw(3), sw(4), sw(5), sw(6)],
  ];
  const bVec = [swd(0), swd(1), swd(2), swd(3)];
  const coeffs = solve4x4(A, bVec);
  const fittedD = (t: number) => coeffs[0] + coeffs[1] * t + coeffs[2] * t * t + coeffs[3] * t * t * t;

  // ── Constraint (c): snap to in-component pixel ──────────────────────────
  // After computing the midpoint coordinate from the fit, search a small
  // radius for the nearest pixel that's actually inside the flood-fill
  // component. This guarantees points land *on* the stripe colour rather
  // than floating on a smooth-but-untethered curve.
  const SNAP_RADIUS = 5;
  const snap = (px: number, py: number): { x: number; y: number } => {
    const ix = Math.round(px), iy = Math.round(py);
    if (ix >= 0 && ix < w && iy >= 0 && iy < h && accepted[iy * w + ix]) {
      return { x: px, y: py };
    }
    let bestX = px, bestY = py, bestD2 = Infinity;
    for (let dy = -SNAP_RADIUS; dy <= SNAP_RADIUS; dy++) {
      for (let dx = -SNAP_RADIUS; dx <= SNAP_RADIUS; dx++) {
        const sx = ix + dx, sy = iy + dy;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        if (!accepted[sy * w + sx]) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; bestX = sx; bestY = sy; }
      }
    }
    return { x: bestX, y: bestY };
  };

  // ── Sample 5 luff-biased midpoints from the fitted curve ────────────────
  // Sail entry curvature concentrates in the front 30–40% of the chord, so
  // 3 of the 5 midpoints sit in the front half. Each midpoint comes from
  // the cubic fit (smooth + bounded curvature), then snaps to the nearest
  // in-component pixel (so it lands on an actual stripe pixel).
  const MIDPOINT_TS = [0.10, 0.20, 0.35, 0.55, 0.80];
  const midpoints: P[] = [];
  if (chordLen > 4 && filteredTs.length >= 4) {
    MIDPOINT_TS.forEach(t => {
      let d = fittedD(t);
      // Enforce canonical side: a slightly noisy fit can dip across the
      // chord at endpoints; clamp to the correct side.
      if (d * stripeSide < 0) d = 0;
      const cx = tx + ux * chordLen * t;
      const cy = ty + uy * chordLen * t;
      const snapped = snap(cx + nx * d, cy + ny * d);
      midpoints.push({ x: snapped.x / scale, y: snapped.y / scale });
    });
  }

  // Map endpoints back to original-image space. Keep luff = user's exact tap.
  // Leech is either the user's hint (preserved exactly) or the flood-fill's
  // farthest-pixel result (mapped back from downsampled space).
  const luff: P = { x: tapImagePx.x, y: tapImagePx.y };
  const leech: P = options.leechHint
    ? { x: options.leechHint.x, y: options.leechHint.y }
    : { x: leechX / scale, y: leechY / scale };

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
