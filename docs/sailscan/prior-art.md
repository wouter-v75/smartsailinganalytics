# Sail trim stripe analysis — prior art survey

## Open-source projects

No directly applicable open-source GitHub repositories were found for trim-stripe sail-shape analysis from photographs. However, the following related projects exist:

**ISISLab (University of Salerno)**
- Organization: [github.com/isislab-unisa](https://github.com/isislab-unisa)
- Status: Active research lab, multiple projects
- What we know: SailWatcher originated here, but the source code does not appear to be publicly released on GitHub. The lab's GitHub contains projects in contact tracing, heterogeneous simulation, and other domains, but not the sail analysis tool itself.

**OrientationJ — ImageJ Plugin**
- URL: [github.com/Biomedical-Imaging-Group/OrientationJ](https://github.com/Biomedical-Imaging-Group/OrientationJ)
- License: Open source
- What it does: Computes local image orientation via gradient structure tensor; includes color-coded directionality maps, orientation distribution, and vector fields. Directly applicable to detecting horizontal stripe orientation and filtering out vertical luff/leech edges.

**Frangi Vesselness Filter (Python)**
- URL: [github.com/solivr/frangi_filter](https://github.com/solivr/frangi_filter)
- License: Open source
- What it does: Ridge/vessel enhancement filter via multiscale Hessian analysis. Useful as a secondary feature detector after orientation filtering to amplify horizontal stripe responses and suppress vertical edges.

**ArUco Marker Detection**
- Status: Built into OpenCV (cv2.aruco module) as of OpenCV 4.x
- URL: [docs.opencv.org — ArUco Detection](https://docs.opencv.org/4.x/d5/dae/tutorial_aruco_detection.html)
- What it does: Detects binary fiducial markers in images. One monocular 3D sail reconstruction paper (Maciel et al., 2021) uses ArUco markers glued to sails as passive measurement points, though this is not stripe-based.

**Catenary Curve Fitting**
- URL: [github.com/dulnan/catenary-curve](https://github.com/dulnan/catenary-curve)
- What it does: Calculates catenary curves between two points; useful for modeling the natural drape of a horizontal stripe under its own weight and wind pressure. Could serve as a spline family for fitting stripe centerlines.

## Academic papers & research

**Monocular 3D reconstruction of sail flying shape using passive markers** (Luiz Maciel et al., 2021)
- Published: Machine Vision and Applications, Springer Nature Link
- Full text: [link.springer.com/article/10.1007/s00138-020-01149-3](https://link.springer.com/article/10.1007/s00138-020-01149-3)
- Key idea: Recovers 3D sail shape from a single camera using printed ArUco markers fixed to the sail surface.

**Full-scale flying shape measurement of offwind yacht sails with photogrammetry**
- Published: ScienceDirect, [sciencedirect.com/science/article/abs/pii/S0029801816304334](https://www.sciencedirect.com/science/article/abs/pii/S0029801816304334)
- Key idea: Multi-camera photogrammetry with green/blue checkerboards glued to sail. NURBS surface fitting from 3D point clouds.

**Photogrammetry Based Flying Shape Investigation of Downwind Sails**
- Published: SNAME Chesapeake Sailing Yacht Symposium
- ResearchGate: [researchgate.net/publication/262413813](https://www.researchgate.net/publication/262413813)
- Key idea: Wind-tunnel vs. full-scale comparison; documents that full-scale is "challenging" — justifies our single-camera approach if solvable.

**SailVis: Reconstruction and Multifaceted Visualization of Sail Shape**
- Published: Eurographics Digital Library, [diglib.eg.org](https://diglib.eg.org/items/4fb3a4ec-e5f4-4d80-b8ea-fdf9bbe18d7a)
- Key idea: Reconstructs 3D sail shape from photogrammetry point clouds; deforms a template sail to estimate missing parts.

**Sensing sail luffing by detection of sail shape** (IEEE)
- Published: [ieeexplore.ieee.org/abstract/document/8084810](https://ieeexplore.ieee.org/abstract/document/8084810)
- **Directly relevant**: Distinguishes luff/leech from sail shape via image segmentation. Defines vectors between luff and leech reference points.

**Flying shape and aerodynamics of a full-scale flexible Olympic windsurf sail** (2025)
- ArXiv: [arxiv.org/html/2501.13254v1](https://arxiv.org/html/2501.13254v1)
- Recent full-scale photogrammetry on windsurf sails — current best practice baseline.

## Commercial systems (for inspiration)

**VSPARS (Visual Sail Position And Rig Shape)**
- URL: [vspars.com](https://vspars.com/)
- Research paper: [vspars.com/cmsFiles/file/LePelley_Modral_VSPARS.pdf](https://www.vspars.com/cmsFiles/file/LePelley_Modral_VSPARS.pdf)
- How it works: Deck-mounted cameras (typically 3) look up at colored trim stripes. Software corrects for perspective distortion and extracts stripe positions. Outputs camber, draft position, twist per stripe. Measurement uncertainty: 0.5–2%.
- Status: Commercial; powers Quantum Sail Scan for TP52 racing.
- Insight: Multi-camera reduces ambiguity vs. single-camera monocular.

**Quantum Sail Scan (powered by VSPARS)**
- URL: [quantumsails.com](https://www.quantumsails.com/en/store/products/accessories/other/quantum-sail-scan-powered-by-vspars)
- Used for overlaying actual flying shape vs. design file.

**SailWatcher** ⭐ closest analog
- URL: [sailwatcher.com](https://www.sailwatcher.com/)
- Status: Commercial (free web app); source not public.
- What it does: Smartphone web app for photographing sails from below. **User manually marks stripe positions** on the photo; computes draft depth, draft position, twist, entry/exit angles per stripe.
- Originated: ISISLab, University of Salerno.
- Why relevant: **Our exact use case.** No automation in the public-facing app — proves manual digitization is a viable v1.

**SailPack-Vision**
- URL: [bsgdev.com — SailPack-Vision](https://www.bsgdev.com/CMS3/index.php/menuproducts/sailpack-vision), [onesails.com](https://www.onesails.com/sailpack-vision/)
- Status: Commercial Windows desktop. Semi-manual stripe tracing.

**North Sails 3DL/3Di** and **Quantum iQ**
- Internal sail-design tools using photogrammetry for validation. No public algorithm details. Validate that spline-based representation is industry standard.

## Recommended algorithm pipeline

### 1. Image preprocessing (perspective & exposure)

- CLAHE (Contrast-Limited Adaptive Histogram Equalization) for exposure normalization.
- Local radial undistortion via OpenCV camera calibration (or assume typical phone-lens constants).
- Don't do full perspective correction up front — keep raw pixel coords until after stripe fitting.

### 2. Trim-stripe detection (the luff/leech-confusion fix)

**The hard problem:** Stripes are ~horizontal; luff/leech are ~vertical. Naive Canny/Sobel catches both.

**Recommendation: orientation-filtered Canny via gradient structure tensor.**

1. Compute per-pixel local image orientation using the gradient structure tensor (Sobel + Gaussian-smoothed second moments).
2. Mask the image: keep only pixels with dominant direction in 10°–170° (near-horizontal); reject pixels near 0° / 180° (luff/leech).
3. Apply Canny on the masked image. Edge detection now operates only on horizontal structure.
4. Connect via morphological closing → `findContours`. Require contour length >0.2× sail width.

```python
# Reference (Python / OpenCV)
gray  = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
gray  = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8,8)).apply(gray)

Ix    = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
Iy    = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
Ixx   = cv2.GaussianBlur(Ix*Ix, (11,11), 3)
Iyy   = cv2.GaussianBlur(Iy*Iy, (11,11), 3)
Ixy   = cv2.GaussianBlur(Ix*Iy, (11,11), 3)
angle = (np.degrees(0.5*np.arctan2(2*Ixy, Ixx-Iyy))) % 180

h_mask         = (angle >= 10) & (angle <= 170)
masked         = gray.copy()
masked[~h_mask]= 128  # neutral; suppresses vertical structure

edges          = cv2.Canny(masked, 50, 150)
contours,_     = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
```

For the browser, the same logic ports to **OpenCV.js** (WASM) — `cv.Sobel`, `cv.GaussianBlur`, `cv.Canny`, `cv.findContours` are all there. ~8 MB asset cost.

**Fallbacks:**
- HSV color-range segmentation if stripes are colored.
- Frangi vesselness for low-contrast monochrome stripes.

### 3. Per-stripe pixel grouping

- Cluster contours into 2–4 horizontal bands by median y-coordinate.
- Merge fragmented contours within each band (morphological dilation).
- Sort pixels luff→leech (left→right in image).

### 4. Spline fit & metric extraction

**Cubic B-spline via least-squares** (matches CAD/CFD convention; analytic derivatives).

For each stripe centerline:
- Compute median y per x-column.
- Smooth with Savitzky-Golay (window 5–9).
- Fit cubic B-spline with knots at quartiles, smoothing factor `s` cross-validated.

Extract:
- **Draft depth (%):** max perpendicular distance from spline to luff-leech chord, normalized by chord length.
- **Draft position:** x-fraction along chord where max draft occurs.
- **Entry angle:** `arctan(spline'(x_min))`.
- **Exit angle:** `arctan(spline'(x_max))`.
- **Twist:** difference in entry (or exit) angle between adjacent stripes.

**Fallbacks:** catenary `y = a·cosh((x−x₀)/a) + y₀` (sparse data); cubic polynomial; RANSAC for outlier-heavy fits.

### 5. Output schema

```json
{
  "photo_id": "jib_2026_05_03_14h30m.jpg",
  "stripes": [
    {
      "stripe_index": 1,
      "height_percent": 0.33,
      "draft_percent": 4.2,
      "draft_position": 0.45,
      "entry_angle_deg": 12.3,
      "exit_angle_deg": -8.7,
      "twist_to_next_stripe_deg": 2.1
    }
  ]
}
```

## Risks & open questions

1. **Wide-angle lens distortion** — phone barrel distortion → ~2–5% error near edges. Use OpenCV camera matrix or accept the error.
2. **Lighting variation** — CLAHE helps; reject low-SNR photos; suggest leeward (shadow) side.
3. **Luff/leech ambiguity in extreme angles** — orientation filter assumes ~horizontal stripes; warn if detected stripe angle > ±15° from horizontal.
4. **Stripe continuity** — creases/wrinkles fragment stripes. Morphological closing bridges gaps.
5. **Low-contrast stripes** — color-range segmentation if colored; Frangi if monochrome.
6. **Curved chord projection** — chord is straight in 3D but curves in image due to perspective. Either fit a 2D parabola or accept ~1–2% error for moderate angles.
7. **No ground truth** — collect 10–20 photos with manual stripe tracing for validation.

### Validation plan

- **Phase 1:** 5–10 photos, manual stripe centerlines from one expert.
- **Phase 2:** 30–50 photos across 5–10 sails, with reference angles (battens). Report RMSE.
- **Phase 3:** Compare auto vs. SailWatcher manual.

### Target accuracy
- Draft depth: ±1.5% absolute
- Draft position: ±0.05 (5% of chord)
- Entry/exit angles: ±3°
- Twist: ±2°

## Bottom line

There is **no open-source repo** to fork. SailWatcher (closed, manual digitization) is the closest reference; VSPARS is the multi-camera commercial gold standard.

The one technical idea that directly solves the past failure (algorithm tracking luff/leech instead of stripes) is **gradient-structure-tensor orientation filtering**: compute per-pixel local orientation, mask out near-vertical pixels before edge detection. This pushes vertical luff/leech edges out of the candidate set entirely, so the stripe detector can no longer "snap to" them.

Build order suggestion:
1. **v1 — manual digitization** (SailWatcher-style): user taps stripe endpoints + a few midpoints, app fits spline & reports metrics. Ships fast, validates the math end-to-end.
2. **v2 — automated detection** (OpenCV.js + orientation filter): replace manual taps with auto-detected stripes, keep manual-correction UI as fallback.
