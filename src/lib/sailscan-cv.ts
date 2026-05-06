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
// The script tag fires `onload` after the JS bytes arrive, but the WASM module
// finishes initialisation slightly later. Both onRuntimeInitialized and a Mat
// constructor existing are valid readiness signals; we poll for the latter.
//
// We try multiple CDNs in order. The first one that responds wins. Browsers
// or networks may block individual hosts (corporate VPNs, ad blockers, CSP),
// so a fallback chain is much more robust than a single URL.
let cvPromise: Promise<CV> | null = null;

const OPENCV_URLS = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://docs.opencv.org/4.10.0/opencv.js',
];

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

export function loadOpenCV(): Promise<CV> {
  if (cvPromise) return cvPromise;
  cvPromise = (async () => {
    const w = window as any;
    if (w.cv?.Mat) { log('cv.Mat already present, skipping load'); return w.cv; }

    let lastError: string = '';
    for (const url of OPENCV_URLS) {
      try {
        await tryLoadScript(url, 15000);
        // Script bytes arrived. WASM module is initialised slightly later.
        // Prefer cv.onRuntimeInitialized callback (Emscripten standard) — only
        // when that fires are downstream classes like cv.CLAHE actually safe
        // to construct. Fall back to polling for cv.Mat AND cv.CLAHE both,
        // which catches partial-init states.
        await new Promise<void>((resolve, reject) => {
          const startedAt = Date.now();
          const INIT_TIMEOUT = 20000;
          // Path 1: explicit Emscripten callback
          if (typeof w.cv?.then === 'function') {
            log('cv has .then; awaiting Promise-style ready');
            w.cv.then(resolve).catch(reject);
            return;
          }
          if (w.cv && 'onRuntimeInitialized' in w.cv && !w.cv.Mat) {
            log('hooking onRuntimeInitialized');
            const prev = w.cv.onRuntimeInitialized;
            w.cv.onRuntimeInitialized = () => { try { prev?.(); } catch {} resolve(); };
            // also poll as a backup
          }
          // Path 2: poll for both cv.Mat AND cv.CLAHE (partial init guard)
          const tick = () => {
            const cv = w.cv;
            const ok = cv && typeof cv.Mat === 'function' && typeof cv.CLAHE === 'function';
            if (ok) { resolve(); return; }
            if (Date.now() - startedAt > INIT_TIMEOUT) {
              reject(new Error(
                `WASM init timed out — Mat=${typeof cv?.Mat}, CLAHE=${typeof cv?.CLAHE}`,
              ));
              return;
            }
            setTimeout(tick, 60);
          };
          tick();
        });
        log('cv.Mat AND cv.CLAHE ready (from', url, ')');
        return w.cv;
      } catch (e: any) {
        lastError = `${url}: ${e?.message || e}`;
        log('CDN failed:', lastError);
      }
    }
    throw new Error('All OpenCV CDNs failed. Last: ' + lastError);
  })();
  // Reset the cached promise on failure so the user can retry without a reload.
  cvPromise.catch(() => { cvPromise = null; });
  return cvPromise;
}

export function isOpenCVLoaded(): boolean {
  return !!(window as any).cv?.Mat;
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
