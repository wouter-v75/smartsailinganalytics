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

  // ── Multi-seed flood fill ───────────────────────────────────────────────
  // We try the user's luff first, then 3 chord-interior points (only if a
  // leechHint was supplied). The biggest connected component wins. This
  // makes detection robust when the user's luff/leech taps land *near* but
  // not exactly *on* a stripe pixel — a chord-interior seed will likely fall
  // inside the stripe.
  const data = hsv.data as Uint8Array;
  const HUE_DIFF = options.hueTol ?? 15;
  const SAT_DIFF = options.satTol ?? 60;
  const VAL_DIFF = options.valTol ?? 60;
  const MAX_PIXELS = Math.max(2000, Math.floor((w * h) / 8));

  // Pre-compute leech-hint coords in downsampled space (used for both seed
  // candidates and chord direction below).
  const lhDsX = options.leechHint
    ? Math.max(0, Math.min(w - 1, Math.round(options.leechHint.x * scale)))
    : tx;
  const lhDsY = options.leechHint
    ? Math.max(0, Math.min(h - 1, Math.round(options.leechHint.y * scale)))
    : ty;

  const seeds: { x: number; y: number; label: string }[] = [{ x: tx, y: ty, label: 'luff' }];
  if (options.leechHint) {
    seeds.push({ x: lhDsX, y: lhDsY, label: 'leech' });
    for (const frac of [0.25, 0.50, 0.75]) {
      seeds.push({
        x: Math.round(tx + (lhDsX - tx) * frac),
        y: Math.round(ty + (lhDsY - ty) * frac),
        label: `chord-${frac.toFixed(2)}`,
      });
    }
  }

  type FillResult = {
    accepted: Uint8Array;
    area: number;
    bbX0: number; bbY0: number; bbX1: number; bbY1: number;
    seedX: number; seedY: number; seedLabel: string;
    seedH: number; seedS: number; seedV: number;
  };

  function runFloodFill(seedX: number, seedY: number, label: string): FillResult {
    const seedIdxLin = seedY * w + seedX;
    const sH = data[seedIdxLin * 3];
    const sS = data[seedIdxLin * 3 + 1];
    const sV = data[seedIdxLin * 3 + 2];
    const isAch = sS < 50;
    const visited = new Uint8Array(w * h);
    visited[seedIdxLin] = 1;
    const localQ: number[] = [seedIdxLin];
    let area = 1;
    let x0 = seedX, y0 = seedY, x1 = seedX, y1 = seedY;
    let qH = 0;
    while (qH < localQ.length && area < MAX_PIXELS) {
      const idx = localQ[qH++];
      const y = (idx / w) | 0;
      const x = idx - y * w;
      const ns = [idx - 1, idx + 1, idx - w, idx + w];
      const nxs = [x - 1, x + 1, x,     x    ];
      const nys = [y,     y,     y - 1, y + 1];
      for (let k = 0; k < 4; k++) {
        const nx2 = nxs[k], ny2 = nys[k];
        if (nx2 < 0 || nx2 >= w || ny2 < 0 || ny2 >= h) continue;
        const nIdx = ns[k];
        if (visited[nIdx]) continue;
        visited[nIdx] = 1;
        const di = nIdx * 3;
        const nH = data[di], nS = data[di + 1], nV = data[di + 2];
        let dH = Math.abs(nH - sH);
        if (dH > 90) dH = 180 - dH;
        const hueOk = isAch || dH <= HUE_DIFF;
        const satOk = Math.abs(nS - sS) <= SAT_DIFF;
        const valOk = Math.abs(nV - sV) <= VAL_DIFF;
        if (!(hueOk && satOk && valOk)) continue;
        area++;
        localQ.push(nIdx);
        if (nx2 < x0) x0 = nx2;
        if (ny2 < y0) y0 = ny2;
        if (nx2 > x1) x1 = nx2;
        if (ny2 > y1) y1 = ny2;
      }
    }
    const acc = new Uint8Array(w * h);
    for (const idx of localQ) acc[idx] = 1;
    return { accepted: acc, area, bbX0: x0, bbY0: y0, bbX1: x1, bbY1: y1,
             seedX, seedY, seedLabel: label, seedH: sH, seedS: sS, seedV: sV };
  }

  let best: FillResult | null = null;
  for (const seed of seeds) {
    const r = runFloodFill(seed.x, seed.y, seed.label);
    if (!best || r.area > best.area) best = r;
  }
  hsv.delete();
  console.log('[SailScan:cv] flood-fill seeds:',
    seeds.map(s => s.label).join(','),
    '· best:', best?.seedLabel,
    '· area:', best?.area ?? 0);

  // The user's luff tap is always preserved as the luff endpoint.
  const stripeFound = !!(best && best.area >= 30);
  const accepted = best ? best.accepted : new Uint8Array(w * h);
  const cArea = best?.area ?? 0;
  // Default-far values; will be overwritten with chord direction below.
  const hC = best?.seedH ?? 0;
  const sC = best?.seedS ?? 0;
  const vC = best?.seedV ?? 0;
  // Carry through to keep type-checks happy; we don't use these as a fall-
  // back leech anymore — the user's leech (or chord midpoint) governs.
  const leechX = best ? best.bbX1 : tx;
  const leechY = best ? best.bbY1 : ty;
  void leechX; void leechY;

  // ── Resolve chord (luff→leech) ──────────────────────────────────────────
  // The user's luff and leech (or the leech-hint when supplied) define the
  // chord exactly. We never override them with auto-detected positions —
  // those endpoints are the user's contract.
  const chordTx = options.leechHint ? lhDsX : (best ? best.bbX1 : tx);
  const chordTy = options.leechHint ? lhDsY : (best ? best.bbY1 : ty);
  const dx = chordTx - tx, dy = chordTy - ty;
  const chordLen = Math.sqrt(dx * dx + dy * dy);

  // ── Constraint (a): always-below perpendicular direction ────────────────
  // Pick the perpendicular vector that points DOWN in image coordinates
  // (positive y), so the convention "positive d = below the chord" holds
  // regardless of whether the user dragged from left-to-right or
  // right-to-left. For a sail photographed from below looking up, the
  // belly always projects downward in the image — that is "below the
  // chord" in user terms.
  let ux = 0, uy = 0, nx = 0, ny = 0;
  if (chordLen > 4) {
    ux = dx / chordLen; uy = dy / chordLen;
    nx = -uy;           ny = ux;       // start with right-hand rule
    if (ny < 0) { nx = -nx; ny = -ny; } // flip to the down-pointing perpendicular
  }

  // ── Sample centerline along the chord ───────────────────────────────────
  // Walk along the luff→leech vector. At each step collect the
  // perpendicular DISTANCES (only on the "below" side, since we know the
  // stripe is below the chord) of in-component pixels and take the median.
  const centerlineTs: number[] = [];
  const centerlineDs: number[] = [];
  if (chordLen > 4 && stripeFound) {
    const SAMPLES = 60;
    const PERP_RADIUS = 30;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const cx = tx + ux * chordLen * t;
      const cy = ty + uy * chordLen * t;
      const ds: number[] = [];
      // Constraint (a): only accept "below chord" pixels (pp >= 0). We allow
      // pp from -2 upward so a stripe pixel sitting exactly on the chord at
      // an endpoint isn't rejected by quantisation noise.
      for (let pp = -2; pp <= PERP_RADIUS; pp++) {
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

  // No further canonical-side filtering needed — perpendicular sampling is
  // already constrained to d ≥ 0 above.
  const filteredTs = centerlineTs;
  const filteredDs = centerlineDs;
  const stripeSide = 1; // by construction, all kept samples are on the +d side

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

  // ── Constraint (b/draft): clamp max draft to [5%, 30%] of chord ─────────
  // Real sail trim stripe drafts fall in this range. Outside it, the
  // detector almost certainly went wrong — clamp uniformly so the curve
  // shape is preserved but its scale is sane. If no stripe was found at all
  // we synthesise a default parabolic curve at 10% draft.
  const MIN_DRAFT_FRAC = 0.05;
  const MAX_DRAFT_FRAC = 0.30;
  const DEFAULT_DRAFT_FRAC = 0.10;

  let scaleD = 1;
  let usingFallback = false;
  let fittedDFinal: (t: number) => number;
  if (stripeFound && chordLen > 4 && filteredTs.length >= 4) {
    // Find max abs(d) across t ∈ [0.05, 0.95] (avoid endpoint anchors).
    let maxAbsD = 0;
    for (let t = 0.05; t <= 0.95; t += 0.02) {
      const d = Math.abs(fittedD(t));
      if (d > maxAbsD) maxAbsD = d;
    }
    const ratio = maxAbsD / chordLen;
    if (ratio > MAX_DRAFT_FRAC) {
      scaleD = MAX_DRAFT_FRAC / ratio;
    } else if (ratio < MIN_DRAFT_FRAC && ratio > 0.01) {
      scaleD = MIN_DRAFT_FRAC / ratio;
    } else if (ratio <= 0.01) {
      // Curve too flat to trust — synthesise a default
      usingFallback = true;
    }
    fittedDFinal = usingFallback
      ? (t: number) => 4 * DEFAULT_DRAFT_FRAC * chordLen * t * (1 - t)
      : (t: number) => fittedD(t) * scaleD;
  } else {
    // Stripe not found at all — synthesise a parabolic default. Endpoints
    // are pinned (4·t·(1−t) is 0 at t=0 and t=1, peak 1 at t=0.5), and the
    // peak sits at DEFAULT_DRAFT_FRAC of the chord length.
    usingFallback = true;
    fittedDFinal = (t: number) => 4 * DEFAULT_DRAFT_FRAC * chordLen * t * (1 - t);
  }

  // ── Sample 5 luff-biased midpoints from the fitted curve ────────────────
  // Sail entry curvature concentrates in the front 30–40% of the chord, so
  // 3 of the 5 midpoints sit in the front half. Each midpoint comes from
  // the cubic fit (smooth + bounded curvature, draft-clamped to a sane
  // range), then snaps to the nearest in-component pixel when one exists.
  const MIDPOINT_TS = [0.10, 0.20, 0.35, 0.55, 0.80];
  const midpoints: P[] = [];
  if (chordLen > 4) {
    MIDPOINT_TS.forEach(t => {
      let d = fittedDFinal(t);
      if (d * stripeSide < 0) d = 0; // never above chord
      const cx = tx + ux * chordLen * t;
      const cy = ty + uy * chordLen * t;
      const px = cx + nx * d;
      const py = cy + ny * d;
      // Only snap if we have a real component to snap to. With the fallback
      // (synthesised curve, no flood-fill component), there's nothing to
      // snap to — leave the synthetic point in place for the user to drag.
      const final = stripeFound ? snap(px, py) : { x: px, y: py };
      midpoints.push({ x: final.x / scale, y: final.y / scale });
    });
  }
  if (usingFallback) {
    console.log('[SailScan:cv] no/weak stripe component — using default 10% parabolic midpoints');
  } else if (scaleD !== 1) {
    console.log('[SailScan:cv] draft clamp applied · scaleD=' + scaleD.toFixed(3));
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
