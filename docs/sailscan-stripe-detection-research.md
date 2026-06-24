# SailScan — automated draft-stripe detection: research brief

**Date:** 2026-06-23 · **Goal:** move SailScan from manual line tracing to reliable
**automated** draft/trim-stripe detection that survives glare + low contrast.

---

## 0. Important correction on "North Sails' new app"

The deep dig did **not** find a confirmed 2025-2026 North Sails AI app that auto-detects
stripes and analyses "in seconds." What exists under the North brand is the older
**"North Sails Scan"** (App Store id 436294029, ~2011-2013): you **manually trace** the
three draft stripes and a consultant does the detailed analysis — minutes per photo, no
ML/auto-detection confirmed. North's 2025-26 innovation messaging is about 3Di / HELIX /
AEROTECH / America's Cup design tools, not a consumer auto-scan app.

The "automatic stripe detection, fast results" capability is real in 2025-26 but sits with
**competitors**, which are the right things to benchmark against:
- **Sailemetry** (sailemetry.com) — *automated* image-based sail analysis; only needs "a
  camera and contrasting draft stripes"; you threshold sample colours, it scans thousands
  of images and outputs camber, draft position, entry (first 5%), exit (last 5%), twist.
  **This is the closest analogue and it's classical CV, no ML.**
- **OneDesignSails SailSmart OW** — photo → 3D flying shape → feeds their VPP/CFD (2026).
- **VSPARS "Sail Vision"** (Univ. Auckland) — deck-mounted multi-camera, tracks coloured
  sail stripes in real time; the grand-prix reference.
- **OneSails Sailpack Vision**, **Sail-CV**, **SailWatcher** — adjacent tools.

Takeaway: a colour-threshold → trace → fit → geometry pipeline is *demonstrably sufficient*
to do what you want; ML is an upgrade for robustness, not a prerequisite.

---

## 1. Why you're stuck, in CV terms

Three physical effects fight you, and each has a specific lever:
- **Specular glare** — gloss/wet sail/water reflections. Key fact: the specular component
  carries the *illuminant's* colour (white/sky), **not** the stripe colour → it's nearly
  *achromatic*, so it disappears in a colour-opponent channel.
- **Translucency / backlight** — a sail lit from behind becomes a lightbox; weave + seams
  swamp the stripe and the white point drifts. **Best fixed at capture, not in software.**
- **Low contrast** — a thin chromatic signal buried in a big luminance signal → move the
  signal into a colour channel where the stripe pops and glare/white sail score ~0.

---

## 2. Recommended path — two phases

### Phase 1 (do first): capture discipline + a classical colour pipeline

This gets you automated detection on *good* photos quickly, and dramatically reduces the
glare/contrast failures, using only OpenCV-style code.

**Capture-side (biggest ROI, mostly free) — bake into the camera UX:**
1. **Front-lit geometry** — sun behind the shooter, shoot ~30-45° off-axis to the sun's
   reflection; **never** shoot a backlit translucent sail. This is the single dominant
   variable.
2. **Protect highlights** — −0.3 to −1.0 EV, tap-meter on the sail, shoot RAW/DNG on the
   main/tele lens (not ultra-wide), brace the phone; optional 3-frame bracket. Clipped
   (255) stripe pixels are unrecoverable — never let them clip.
3. **Circular polarizer (CPL) clip-on** — the best hardware glare cut; user rotates to
   minimum glare in live preview. Use *circular* (keeps AF/AE working), main/tele lens
   (avoids ultra-wide vignetting), ~1-2 stops light cost. Cannot remove unpolarised/normal-
   incidence glints.

**Algorithmic chain (per frame):**
1. Lens **undistort** (one-time `cv2.calibrateCamera` per phone) — uncorrected fisheye bows
   straight stripes and biases camber directly.
2. **Gray-world white balance in Lab** (neutralise a*,b* means) — fixes colour cast.
3. **Illumination flatten** — homomorphic filter (or single-scale Retinex) on L to kill the
   luff→leech backlight gradient.
4. **Specular suppression** — Tan & Ikeuchi (2005) single-image "specular-free" image
   (cheap, license-free); or, if you captured two CPL orientations, polarization separation
   (much cleaner).
5. **CLAHE on the L channel only** (clip ~2.0, 8×8 tiles) for local contrast (don't CLAHE
   RGB — distorts colour).
6. **Opponent-channel stripe projection (the decisive step):** collapse to a 1-channel
   "stripe-likelihood" map from Lab **a*/b*** — for a known stripe colour use the matched
   opponent (e.g. red → +a*), else distance-in-a*b* from the sail's mean chroma. Achromatic
   glare and white sail → ~0; the coloured stripe → high. (Precedent: ChromaTag detects
   coloured markers via the a* gradient.)
7. **Threshold + morphology** on that map: `inRange` per stripe colour (red wraps hue →
   two ranges OR'd), `MORPH_OPEN` (despeckle) then `MORPH_CLOSE` with an elongated kernel
   (bridge batten/seam gaps), `connectedComponentsWithStats`, keep long/thin/horizontal
   blobs. Fallback for weak colour: **Frangi/Hessian ridge filter** (colour-agnostic thin-
   curve detector).
8. **Trace each stripe → ordered points:** column-wise centroid (simplest/robust) or
   skeletonise; an **active contour (snake)** to bridge occlusions (battens, logos, sail
   numbers) via its smoothness energy.
9. **Fit** a robust cubic/quartic polynomial or smoothing spline along the stripe (RANSAC-
   style to reject logo/batten outliers).

**Geometry → metrics (per stripe, chord = luff→leech endpoints):**
- **Camber/draft depth %** = max perpendicular distance to chord ÷ chord × 100.
- **Draft position %** = chordwise location of that max ÷ chord × 100 (target ~40-45% main).
- **Entry / exit angle** = tangent at luff / leech vs chord (Sailemetry uses twist over the
  first / last 5%). Sanity check: entry ≈ atan(2·draft% / position%).
- **Twist** = difference in chord bearing between stripes, zeroed to a fixed reference
  (spreaders/boom).
- **Perspective:** either a **homography** from known stripe endpoints / chord lengths
  (`findHomography` + `warpPerspective`) to rectify each section, or — pragmatic and robust
  for phone shots — **normalise per stripe as %-of-stripe-length** (what Sailemetry does)
  and skip full 3D.
- **Curve model:** spline/quartic for general shapes; a **NACA 4-digit mean-camber fit**
  (solve m = camber, p = draft position) is the most physically principled and rejects
  noise — fall back to spline for very full / hooked-leech sails.

### Phase 2 (robustness upgrade): a small on-device ML detector

When the classical pipeline still fails on the worst glare/low-contrast frames, replace the
*detection* step (not the geometry) with a learned segmenter:
- **Model:** **U-Net with a MobileNetV2 (ImageNet-pretrained) encoder** at ~256-512 px,
  outputting per-stripe masks + an auxiliary direction/distance field (the glare-robust
  trick borrowed from DeepLSD/HAWP). *Not* DeepLabv3+ (weaker on the thinnest lines), *not*
  SAM for inference (its low-res mask head blurs thin detail), *not* wireframe/line parsers
  (they assume straight segments).
- **Labelling with little data:** **SAM-assisted auto-labelling** — point-prompt
  MobileSAM/EfficientSAM on each stripe, human accept/correct → ~200 labelled real photos
  in hours. Then a semi-supervised loop (model pseudo-labels new photos, SAM refines).
- **Synthetic data:** render sails + stripes with **domain-randomised lighting that
  explicitly models blown-out specular highlights** (standard randomisation under-models
  glare — the whole reason to be deliberate here), colour, curvature, pose; mix with real.
- **Deploy:** PyTorch → **Core ML** via `coremltools` (trace→convert, no ONNX needed),
  fp16→int8, target the Neural Engine → tens of ms inference, leaving the "seconds" budget
  to capture + geometry. Use Apple **Vision** `VNDetectContoursRequest` only as a sub-pixel
  contour cleanup on the mask, not as the detector.
- **Endpoints (luff/leech):** derive geometrically from the mask skeleton extremities first
  (free); add a lightweight heatmap keypoint head only if that proves brittle.

**Build order:** SAM-assisted label ~200 real glare photos → train MobileNetV2-U-Net (heavy
glare/colour/perspective augmentation) → Core ML → keep the classical geometry step.

---

## 3. Single highest-leverage actions, ranked

1. **Capture UX**: front-lit + off-axis + −EV + RAW + (CPL). Prevents the unrecoverable
   failures; free.
2. **Opponent-channel (a*/b*) stripe projection + CLAHE-on-L** — turns the low-contrast
   colour problem into a high-contrast 1-D detection and inherently rejects glare. The
   biggest *algorithmic* win; pure OpenCV.
3. Tan-Ikeuchi specular-free image + homomorphic/Retinex flatten — for the hard frames.
4. Only then: the MobileNetV2-U-Net ML detector for the long tail.

Deep specular-removal networks and full MSRCR are **overkill on a phone** — keep as a
fallback tier.

---

## 4. Key sources
- [Sailemetry — How it works](https://www.sailemetry.com/how-it-works) (closest analogue; classical pipeline + metric defs)
- [North Sails — Tips for Taking Proper Sail Scan Photos](https://www.northsails.com/en-us/blogs/north-sails-blog/tips-for-taking-proper-sail-scan-photos) (the manual app)
- [OneDesignSails — SailSmart OW / mVPP](https://www.onedesignsails.com/2026/04/17/beyond-the-polars-the-evolution-of-mvpp-mrace-sailsmart/) · [VSPARS Sail Vision](https://vspars.com/sails.aspx)
- [Practical Sailor — Draft Stripes](https://www.practical-sailor.com/waypoints-tips/draft-stripes) · [SailZing — Draft shape & position](https://sailzing.com/shaping-your-mainsail-part-3-draft-shape-and-position/) · [Lester Gilbert — entry/exit angles](https://www.onemetre.net//design/Entry/entry.htm)
- CV: [scikit-image ridge/Frangi](https://scikit-image.org/docs/stable/auto_examples/edges/plot_ridge_filter.html) · [active contours](https://scikit-image.org/docs/stable/auto_examples/edges/plot_active_contours.html) · [HSV/Lab segmentation](https://realpython.com/python-opencv-color-spaces/) · [ChromaTag (a* marker detection)](https://arxiv.org/pdf/1708.02982)
- Glare: [phone CPL guide (SANDMARC)](https://www.sandmarc.com/blogs/creator-tips/how-to-choose-a-polarizer-for-smartphones-cutting-glare-on-water-glass-cars) · [Tan & Ikeuchi / specular survey (MDPI Sensors 2024)](https://www.mdpi.com/1424-8220/24/7/2286) · [real-time bilateral specular removal (ECCV'10)](https://vision.ai.illinois.edu/html-files-to-import/publications/yang_eccv10.pdf) · [OpenCV CLAHE/WB guide](https://opencv.org/blog/underwater-image-enhancement-using-opencv/)
- ML: [MobileSAM](https://arxiv.org/html/2306.14289) · [M-LSD mobile line detector](https://github.com/navervision/mlsd) · [SAM-assisted labelling (SAM2Auto)](https://arxiv.org/html/2506.07850v1) · [coremltools PyTorch conversion](https://apple.github.io/coremltools/docs-guides/source/convert-pytorch.html) · [Apple Vision contours](https://developer.apple.com/documentation/vision/vndetectcontoursrequest)

> Confidence: the North-app "manual, not AI" finding and the Sailemetry classical pipeline
> are **high**; the ML/glare chains are assembled from adjacent domains (crack segmentation,
> fiducial-marker detection, specular-removal literature) — no paper specifically on *sail*
> stripe detection — so tune parameters on your own sail imagery before trusting numbers.
