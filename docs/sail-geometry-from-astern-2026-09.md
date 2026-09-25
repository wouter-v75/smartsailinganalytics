# Sail geometry from astern — prior art, method and plan

**Automating the three speed-team measurements that are made by hand in Rhino
today: mast centreline → jib clew, mast centreline → jib leech at spreader 2,
mast centreline → boom.**

September 2026. Written against the 6 Sept speed-team material
(`speedteam/notes-2026-09-06/01–12.jpg`, made from the 5 Sept sailing).

---

## 0. The one-paragraph answer

Nothing on the market does this. Every sail-vision product in sailing measures
**shape** (camber, draft, twist) from a camera **on the boat**; the astern,
off-boat measurement of **where the sail is relative to the boat** is done by
hand in Rhino, SailTool or SailPack-Vision, everywhere, by everyone. The
components to automate it all exist and are mature — they are just borrowed
from 6-DoF object-pose estimation, not from sailing. The thing that decides
whether this works is not the detector. It is **geometry**: at the ranges these
photos are taken, one degree of being off the centreline puts ~140 mm of error
into a 1,900 mm measurement, which is seven times the useful tolerance. The
insight that makes the whole project tractable is that **the misalignment can
be measured from the photograph itself, roughly twenty times more precisely
than a photographer in a RIB can achieve it.** So the first generation should
not *require* well-aligned pictures. It should *measure how badly aligned each
picture is, and correct for it* — which is also what turns "a few good frames a
day" into "every frame of a video".

---

## 1. What the measurement is today

From the 6 Sept compilations: pairs (sometimes triples) of stern shots,
Northstar 76 beside Northstar 72 (and in one case Bella), each with the SSA
instrument overlay burned in, and a red dimension line drawn horizontally
across the picture at spreader-2 height with a number in millimetres —
`1905`, `1929`, `1658`, `1782`, `1648`. That is
*mast centreline → jib leech at spreader 2*, and the pairing makes it a direct
A/B of two boats within 40 seconds of each other.

Measured off `01.jpg`: the `1905` dimension spans **696 px** on the 9,448 px-wide
compilation. Each panel is a full-height crop of a 4000×6000 frame upscaled
≈2.26×, so on the **original** frame that dimension is ≈308 px, i.e.

> **≈ 6.2 mm per pixel.**

The originals are Canon EOS R6 Mark II (6000×4000, 6.0 µm pixels) on an
RF 100‑500 mm, shot at 128–254 mm. A 6.2 mm/px scale at 254 mm implies a range
of ≈260 m. Those two numbers — **6 mm/px, 260 m** — drive everything below.

Two facts worth noting before anything else:

- **The originals carry full EXIF; the files that reach SSA do not.** The
  overlaid/renamed exports in `photos/2026-09-05/` have lost `Make`, `Model`,
  `FocalLength` and `LensModel` — only `DateTimeOriginal` survives. Focal
  length is needed for the geometry, so either the pipeline preserves EXIF or
  focal length gets recovered from the image (it can be — see §4.3).
- **Measure on the original frame, never on the compilation.** The compilation
  is upscaled 2.26× and re-JPEGed; every edge in it has been resampled.

---

## 2. Prior art — sailing

### 2.1 On-board sail-vision systems (not applicable, but they set the bar)

| System | Camera | Measures | Status |
|---|---|---|---|
| **VSPARS** (Univ. Auckland) | deck-mounted, looking **up** | stripe camber/draft/twist in 3D + rig deflection from coloured target dots | commercial; TP52s, Quantum Sail Scan |
| **Onboard lidar** | on the boat | camber / draft / twist at 25-50-75 % per sail, 4 Hz | **already on Northstar 76** — see §3 |
| Masthead / forestay cameras | aloft, looking **down** | stripe shape upwind | the older standard; weight and windage aloft |

VSPARS is worth one line only to say why it is *not* the reference here: it
looks up from the deck at stripes, resolves rig target dots to better than 5 mm
at the top of a 30 m rig, and its whole design problem is coping with extreme
perspective on a sail seen nearly edge-on from below. None of that transfers to
a long-lens frame shot from 260 m astern. Different optics, different problem.
It is a useful accuracy benchmark and nothing else.

### 2.2 Off-boat digitising tools — the actual incumbents

These are what the speed team is really competing with, and what Rhino is
standing in for:

| Tool | What it is | Automation |
|---|---|---|
| **The Sail Cloud** (`sailscan.thesailcloud.com`) | cloud sail-scan; explicitly supports **coach-boat photos**; compares **mast bend and rake between boats on the water**; Mac + Windows; free trial then paid | "Auto-scan" for stripes; the off-boat rig work is manual digitising |
| **SailTool** (Curtin CMST) | Windows digitiser; draft, camber, **offsets**, twist, entry/exit, **mast bend**, leech twist, **spinnaker flying distance** | semi-manual: virtual protractor, tape measure, grid overlay. **Freeware** |
| **SailPack-Vision** (BSG / OneSails) | free image-measurement tool: load image, digitise stripes, **measure distances and angles, superimpose images** | manual |
| **AccuMeasure** (UK Sailmakers) | free; camber, draft position, twist per section | you send the picture in for analysis |
| **Sailemetry** | offline batch stripe analysis — 7,000 photos in ~30 min, no user input; needs contrasting draft stripes; zeroes twist against **the spreaders** | automated, but stripes only |
| **SailWatcher** (ISISLab, Salerno) | phone web app; user taps stripe positions | manual |
| **North Sails SailScan** app | phone export, one A4 page per sail | semi-automatic |

**SSA already parses two of these** — `src/lib/sailScanParse.ts` reads North
app and The Sail Cloud PDFs into `sail_scans`. So the ingest side of the
stripe-shape world is done. What none of them do is the three numbers in the
6 Sept notes.

The closest anyone gets is **SailTool's "offsets" and "spinnaker flying
distance"** and **The Sail Cloud's mast-bend/rake comparison between boats** —
both of which are the same *kind* of measurement (a distance from a rig
reference, digitised off a photo) and both of which are **manual clicks with an
operator-set scale**. Nobody measures a jib clew position automatically, and
nobody publishes an error budget for it.

### 2.3 Academic

- **Le Pelley & Modral, V-SPARS**, HPYD 2008 — the perspective-correction maths,
  and the 5 mm-at-30 m accuracy figure. [vspars.com](https://www.vspars.com/cmsFiles/file/LePelley_Modral_VSPARS.pdf)
- **Oliveira, "Sail and Rig Shape From Single Images"**, IST Lisboa 2016 — the
  right *framing* ("recovering 3D from a single 2D projection is
  under-constrained; exploit the fact that the geometry of the mast, sail
  stripes and leech is **partially known beforehand** to make it well-posed"),
  with poor results (20 %, 11 %, 4 % on three features) because it used a GoPro
  on the boom with no rig model. The idea is right; the execution had nothing
  to anchor to. We have the anchor.
- **Deparday et al.**, full-scale offwind flying shape with photogrammetry
  (*Ocean Engineering*, 2016) — four cameras on motorboats around the yacht;
  concluded that boats on moving spots are hard to synchronise and that RIB
  wake hampers the experiment. Reported <1.5 % accuracy. Relevant as the
  honest account of multi-boat photogrammetry's practical cost.
- **Maciel et al.**, monocular 3D sail shape with ArUco markers (*Machine
  Vision and Applications*, 2021) — single camera made well-posed by sticking
  known fiducials on the sail. We cannot stick markers on a rival, but we can
  on our own two boats (see §6, stage 4).

---

## 3. What SSA already has that none of them have

This is the part that changes the plan, and it is all in the repo already.

**1. The boat is already instrumented with a lidar sail-shape system.** The
4 Hz N76 export carries `JIB_CA_25 … JIB_TAL_75`, `MN_*`, `SPI_*`,
`JIB_SAGx/y/z`, `JIB_LUFF%`, `JIB_LEECH%` plus the sailmaker's targets
`T_JIB_*` — parsed in `src/lib/flatLogParse.ts`, filtered and tabled in
`src/lib/lidarTables.ts`. **Do not rebuild camber/draft/twist from stern
photos for our own boat; it is already measured at 4 Hz.**

**2. The trim controls are logged.** `JibIO%` (jib lead in/out), `Mainsheet`,
`Vang`, `Forestay`, `UpDfclt%` / `LwDfclt%` (mast deflection), `ToeIn`,
`KeelAngle`, `Heel`, `Trim` — at 4 Hz, on the same clock the photos are matched
against. **This is a free, automatically-labelled validation set of essentially
unlimited size**: every stern photo of our own boat has, at the same second, a
sensor reading of the thing the photo is supposed to measure. No other project
in §2 has that, and it is the difference between "we think it's accurate" and a
published error figure.

**3. Both compared boats are ours.** Northstar 76 and Northstar 72 are the same
programme (a team holds several boats). So the rig model — the thing that makes
the single-image problem well-posed — is available for *both* sides of the
comparison from day one. Rivals like Bella are a later, degraded mode.

**4. The photo pipeline exists.** EXIF-time → log-row matching, venue-local
clock handling, instrument overlay rendering (`photoOverlay.js`,
`PhotosTab.jsx`), cloud enrichment via `npm run media:upload`, and a
`sail_scans` table with `photo_id`, `session_id`, `run_id`, `conditions`,
`stripes`, `summary` JSONB that a new measurement family slots straight into.

**5. Computer-vision foundations are already in the repo.**
`src/lib/sailscan-cv.ts` lazy-loads OpenCV.js and implements CLAHE, the
gradient structure tensor and orientation masking; `sail-scan-ai/` is a vendored
YOLO11 + SAM 2.1 stripe pipeline; `docs/sailscan/prior-art.md` is the stripe
survey. The detector work is not starting from zero.

### 3.1 The rig dimensions already exist — for the whole fleet

An endorsed IRC certificate carries exactly the three things the photograph
cannot supply, measured by a measurer, and it is issued for competitors too.
Parsed from the six Maxi 72 certificates (`npm run irc:rigmodel -- <folder>`):

| boat | sail no | LH | kg | **P** | **E** | **J** | HLU | HLP | rake | clew | leech | boom |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Northstar III | GBR76X | 23.20 | 17017 | **31.44** | 10.33 | 8.86 | 30.60 | 8.96 | 16.8° | −1.05 | −0.35 | −10.33 |
| Jethou | GBR74R | 23.50 | 15088 | 30.74 | 10.17 | 8.35 | 29.54 | 8.54 | 16.4° | −1.09 | −0.34 | −10.17 |
| Bella Mente | USA45 | 22.55 | 14694 | 30.20 | 9.66 | 8.40 | 29.58 | 8.72 | 16.5° | −1.22 | −0.38 | −9.66 |
| Balthasar | MLT5 | 21.95 | 15985 | 30.00 | 9.88 | 8.44 | 28.48 | 8.52 | 17.2° | −0.96 | −0.27 | −9.88 |
| Jolt | GBR72N | 21.95 | 15064 | 29.82 | 9.86 | 8.38 | 28.98 | 8.70 | 16.8° | −1.21 | −0.36 | −9.86 |
| Django 7X | GBR8N | 21.40 | 12147 | 28.52 | 9.63 | 8.53 | 28.12 | 8.83 | 17.7° | −1.16 | −0.31 | −9.63 |

Metres; the last three are fore-and-aft offsets from the mast, forward
positive, and are *derived* from J/HLU/HLP rather than read off.

**P is the scale reference, and it is the thing that was missing.** It is not
an athwartships length, but it does not need to be: seen from astern the mast
lies in the plane perpendicular to the line of sight, so the mainsail hoist
between the black bands projects at **full length**. Rake costs cos(rake) —
0.06 % at 2°, 0.2 % at 4° — and mast bend costs the arc-to-chord difference,
about 0.02 % for 300 mm of sagitta over 31 m. At 31.44 m it is five times the
baseline of a spreader and lands the scale an order of magnitude tighter: on a
6,000 px frame P spans ~5,000 px, so ±1 px at each end is ±0.04 %.

**J is the ψ baseline** — forestay tack to the mast at deck, both centreplane
points visible from astern — and **E puts the boom**. The jib's corners come
out of J, HLU and HLP by construction.

Two caveats. J is measured to the *front* of the mast, not its centreline —
half a section, ~200 mm, which scales ψ by the same fraction. And the clew's
height up the luff is the one thing the certificate does not carry; it is taken
as 15 % ± 6 % of the luff, which is where the clew's ±0.5 m comes from.

And the point that matters beyond our own boat: **five of those six are
rivals.** Stage 4 had no answer for a boat whose rig model we do not have. IRC
is the answer.

---

## 4. The physics that decides the project

This section is the reason to read the document. All numbers at R = 260 m,
6.2 mm/px, and a jib clew Δd ≈ 8 m forward of the mast (**substitute N76's real
J** — the conclusions scale linearly with it).

### 4.1 Pixel noise is not the problem

At 6.2 mm/px, sub-pixel edge fitting (±0.3 px is routine for a high-contrast
edge) gives **±2 mm** per endpoint. Against a ±20 mm target, the detector has
an order of magnitude in hand. **Anyone who frames this project as "we need a
better detector" is solving the wrong problem.**

### 4.2 Misalignment is the problem — and it is measurable

Let ψ be the angle by which the camera sits off the boat's centreplane. A point
Δd forward of the mast is displaced laterally in the image by **Δd · sin ψ**,
and that displacement lands directly in the measurement:

| ψ | error on a clew 8 m forward of the mast |
|---|---|
| 1.0° | **140 mm** (7 % of a 1,900 mm reading) |
| 0.5° | 70 mm |
| 0.2° | 28 mm |
| 0.1° | 14 mm |

To hold ±20 mm by alignment alone the RIB would have to be within **0.6 m** of
the extended centreline at 260 m — i.e. ψ ≤ 0.14°. That is not achievable, is
not verifiable by eye, and is not what "mast and headstay in line" delivers in
practice. **The current manual method has no way to know how far off it was.**

> **Which target this bites is not where I first assumed.** The 8 m above was a
> guess. Northstar's IRC certificate (§3.1) gives J 8.86, HLU 30.60, HLP 8.96 —
> a 101 %-LP jib, and a 100 % jib's clew lands *on the mast*. Worked through,
> the clew sits about **1.1 m ABAFT** the mast and the leech at spreader 2 about
> **0.35 m** abaft it. So on the two jib targets ψ costs ~18 and ~6 mm per
> degree, not 140. The boom is the opposite case: E 10.33 m aft of the mast
> makes it **180 mm per degree**, and gives it a −4 % depth error at 260 m. The
> principle is unchanged and the arithmetic is the same; what changed is which
> of the three measurements needs the care.

But: any two identifiable points on the boat's **centreplane** at different
fore-and-aft positions give ψ directly, because their lateral separation in the
image *is* Δd · sin ψ. Candidate centreplane landmarks visible from astern:
masthead, forestay tack / bow, gooseneck, traveller centre, backstay, transom
centre, rudder stock. With a 8 m baseline and ±1 px (6 mm) localisation of each,

> **ψ is recovered to ±0.06°, i.e. ±8 mm of residual error on the clew.**

Use a 20 m baseline (bow to transom) and it is ±0.025°. **The photograph
measures its own misalignment about twenty times better than the photographer
can control it.** This is the whole project in one sentence.

### 4.3 Perspective/depth is a systematic bias the manual method ignores

The camera is **astern**, so a point Δd *forward* of the mast is Δd *farther
away* and is imaged **smaller** by the factor R/(R+Δd). Scale it with the
mast's mm-per-pixel and you **under**-read by Δd/R. At R = 260 m, Δd = 8 m that
is **−3.0 %, i.e. ≈57 mm missing from a 1,900 mm reading**; at R = 140 m (the
128 mm shots) it is −5.4 %. The boom, being aft of the mast, is over-read by
the same mechanism with the opposite sign.

A single uniform image scale — which is what a Rhino overlay gives you — is only
valid in one plane. So today's numbers very likely carry a **few-percent
range-dependent bias**. That is harmless when comparing two boats in one frame
at the same range on the same day, and *not* harmless when comparing across
days, across venues, or between two boats at noticeably different distances.
**This is a testable claim** and should be tested early (§6, stage 0).

Correcting it needs R and Δd. R comes from the apparent size of any known rig
dimension (spreader tip-to-tip, mast chord, P, J); Δd comes from the rig model.
Both are free once the model exists. As a by-product, the same fit **recovers
focal length**, which is why the stripped EXIF is survivable.

### 4.4 The definition question — world-horizontal vs boat-frame

The red dimension lines in the 6 Sept compilations are drawn **horizontal in
the image**, on a boat heeled 21–25°. That measures a *world-horizontal*
distance, not an *athwartships-in-boat-frame* one. Measuring horizontally to a mast that has leaned away gives
**world-horizontal = boat-athwartships ÷ cos(heel)** — exactly, and
independently of the target's height. At 23° heel that is ×1.086, and two boats
2° apart in heel read **1.6 % (≈31 mm) apart** for identical trim.

This is a definition, not a bug — but it must be pinned down before any code
is written, and it is the single most important thing to decide (§7). The
automated method can emit **both**, and heel is in the log for our boats.

> **Measured, 24 Sep — and it appears already decided.** On `01.jpg` panel 1
> (N76, 11:53:00) the **sea horizon runs at −23.20°** to the frame (least
> squares over 71 samples, rms **1.1 px**) while the **mast stands within
> 0.64° of the frame's vertical** (145 rows, rms 47 px — that residual is mast
> bend). So the panel has been **rotated ~23° in PhotoScape to stand the mast
> up**, and the red dimension line, horizontal in the rotated panel, is
> therefore **perpendicular to the mast** — the boat-frame athwartships
> measurement, not the world-horizontal one.
>
> The same numbers are a clean validation of the whole projection model: the
> mast's angle to the TRUE vertical is 23.20 − 0.64 = **22.56°**, against a
> **logged heel of 22.7°**. Agreement to **0.14°**, from a photograph, with no
> rig dimensions involved.
>
> Two consequences. SailTrim's "Across the mast" default already matches the
> historical Rhino numbers. And the rotation is invisible once applied — so a
> compilation panel must never be fed to the tool as if it were an original.

Camera roll, by contrast, is second-order (1° of roll moves the leech
intersection ≈7 mm) and can be ignored once the pose is solved. On an
unrotated original — `12:46:30`, 5 Sept — the same method gives a camera roll
of **4.8°** and puts the mast **22.1°** off true vertical against a logged
heel of **22.1°**. The camera on a RIB is never level; the horizon says by how
much.

### 4.5 What about stereo off the RIB?

Not needed. Two cameras on a 2 m baseline at 260 m give depth to ≈±0.4 m —
useless for the transverse measurement (which is already good) but *just*
enough for the §4.3 scale correction. The rig model supplies the same depth for
free and better. Keep stereo in the back pocket for rival boats whose rig model
we do not have.

---

## 5. Outside sailing — the methods worth stealing

| Field | Technique | Why it matters here |
|---|---|---|
| Robotics / AR | **Model-based 6-DoF pose** (BOP benchmark; MegaPose, FoundationPose, render-and-compare) | Exactly our problem: known CAD model + one image → camera pose. Model-based localisation of *seen* objects improved >50 % (56.9 → 86.0 AR) on the BOP core sets since 2017. We have the "CAD model": the Rhino rig. |
| Classical CV | **Single-view metrology** (Criminisi, Reid & Zisserman) | 3D affine measurement from one perspective view given a vanishing line and one reference length — the fallback when no rig model exists (rivals). |
| Aerial inspection | **Thin-structure segmentation** (CableNet, TTPLA, YOLO-based power-line detection) | Forestay, backstay, shrouds, leech: bounding boxes are hopeless for thin diagonal structures; pixel-level segmentation + Hough-style line fitting is the established answer. |
| Metrology | **Sub-pixel edge localisation** | Deep nets are good at *finding* edges and bad at *locating* them; the literature is explicit that classical sub-pixel methods still win on measurement accuracy. Use the net to find, classical maths to measure. |
| Wind energy | **Blade tip-clearance from a single ground camera** | Same shape of problem — a large flexible structure, one distant camera, millimetre-class deflection wanted — and the same conclusion: anchor to a known rigid geometry. |
| Broadcast | **Bolt6** optical tracking, America's Cup | Millimetre-class asset positions recovered from TV feeds alone, in real time. Proof that model-anchored monocular tracking at this scale is production-grade, not research. |

And the honest note from the AC world: *teams already run measurement
programmes on chase-boat photographs to compare rigs and mast bend to
millimetre accuracy, and treat it as a skill honed over years.* That is the
craft this project is trying to turn into arithmetic.

---

## 6. The method

**Model-based, not pixel-based.** Do not measure distances in the image and
scale them. Solve for where the camera was, then measure in the boat's own
coordinate frame. Same three numbers out, but with a stated uncertainty and no
alignment requirement.

### 6.1 Inputs

1. **A rig model per boat** — mast section and centreline, spreader positions
   and lengths, hounds, gooseneck, boom length, forestay tack, transom centre,
   sheer line. Ten to twenty 3D points in boat coordinates is enough; the Rhino
   model already has them. Store as `boats.rig_model` JSONB (the `boats` table
   has no specs column today — this is the first thing it needs).
2. **The frame** (original, not compilation), with focal length if EXIF survived.
3. **The log row** at the photo's capture second — heel, trim, `JibIO%`,
   `Mainsheet`, `Forestay`, TWS/TWA. Already wired up.

### 6.2 Pipeline

```
frame ─┬─► [A] mast centreline      ──┐
       ├─► [B] centreplane landmarks ─┼─► [C] camera pose solve (PnP + heel prior)
       ├─► [D] known-length reference ┘        → ψ, R, f, roll, elevation
       │                                        → σ on each
       └─► [E] target points ──────────► [F] project into boat frame
             leech @ spreader 2               → 3 distances, boat-frame AND
             jib clew                           world-horizontal
             boom (outboard end / mid)          → ±uncertainty each
                                              → [G] sail_scans row + overlay
```

- **[A] Mast centreline.** Two near-parallel high-contrast edges running the
  height of the frame; bisector gives the centreline, and the apparent chord
  gives a scale reference at the mast's depth. The structure-tensor machinery
  in `sailscan-cv.ts` already isolates near-vertical structure — the *inverse*
  of the mask it was written for.
- **[B] Centreplane landmarks.** Masthead, forestay tack, gooseneck, transom
  centre, backstay. Thin-structure segmentation for the stays; a keypoint model
  for the fittings.
- **[C] Pose.** Least-squares fit of the rig model's projection to the detected
  landmarks — 6 DoF, or 4 with focal length and heel taken from EXIF/log. Report
  **ψ as a first-class output on every measurement**; it is the quality score,
  and it replaces "was this picture well aligned?" with a number.
- **[D] Scale.** From the fit, not from an operator-drawn reference line.
- **[E] Targets.** Jib leech: a curve, intersected with the spreader-2 plane —
  so the answer is an intersection, not a keypoint, and is robust. Boom: a
  rigid known object, so its projected length gives its own depth as a check.
  Clew: the hard one — a single image constrains it to a ray, so its
  fore-and-aft position must come from the jib geometry (foot length from the
  tack) or from `JibIO%`. Its residual sensitivity is small once ψ is known
  (§4.2), but it deserves its own error bar.
- **[F] Output both frames**, with σ, and the pose parameters that produced them.
- **[G] Persist** as a `sail_scans` row (`source='ssa'`, a new `geometry` JSONB
  beside `stripes`), linked to `photo_id`, `session_id`, `run_id` — so it lands
  in Analytics, the report tables and Ask-the-data for free.

### 6.3 Video, later

With ψ measured per frame, **frame selection stops being about alignment**. The
gate becomes: all landmarks visible, sharp enough, instruments steady (no
manoeuvre), |ψ| small enough that the correction is a correction and not an
extrapolation — call it 3°. That passes far more frames than "mast and headstay
in line" ever would, and the output stops being one number per photo and
becomes **a time series of trim joined to the 4 Hz log**. That is the actual
prize: not "what was the lead at 11:53", but "what was the lead through the
whole beat, and what did the boat do about it".

Caveat for video: rolling shutter. A fast pan from a moving RIB skews the frame
and the skew looks exactly like ψ. Either shoot stills bursts (the R6 II will
do 40 fps electronic, same problem; 12 fps mechanical, no problem) or calibrate
and correct the skew. **Test this before committing to video.**

---

## 7. Plan

Every stage ends with something usable, and every stage is validated against
the logged sensors. Stages 0–4 are the near slice: three points on one sail,
measured properly. **§8 is where that is going** — twist and draft at every
stripe on both sails, for boats that have no instruments at all — and it
reorders some of what follows.

### Stage 0 — pin the definitions and kill Rhino (≈2 weeks)

**The digitiser is built** — Tools → SailTrim (`src/components/sailtrim/`, maths
in `src/lib/sailTrim.ts`, detection in `src/lib/sailTrimCv.ts`, dimensions in
`src/lib/rigModel.ts`). `/dev/sailtrim` opens it without a signed-in session. It takes an original frame, the mast edges at two
heights, a scale reference, an optional centreplane baseline and the three
targets, and returns each measurement **in both frames with a sigma**, beside
the number the Rhino method would have given. ψ, the range and the camera roll
are all reported. It recovers a synthetic target of known position to ±5 mm
through the full UI path.

**It is also reachable from the photo itself** — Photos → a photo →
*Analyse sail geometry* opens the same digitiser on that photo's
full-resolution original, and *Save to photo* writes the result back onto it:
the three numbers on a card beside the instrument data, and, if the box is
ticked, the lines burned into the picture beside the gauge overlay. That matters
more than it sounds. A measurement that lives in a downloaded JSON is a
measurement one person has; a measurement on the photo is one the whole team
has, in the place they were already looking.

What travels is a small **annotation record** (`src/lib/sailTrimOverlay.ts`) —
the geometry already resolved to pixels and millimetres, not the marks — carried
in the photo row's `analysis_data`. The alternative, shipping the clicks and
re-deriving on each device, would need the rig model to travel too and would
quietly give a different answer the day a default changed. The record says which
pixel frame its points are in, so the same three lines draw correctly on the
6000 px original, on the 480 px thumbnail and into a PDF.

What remains in this stage:

- **Decide the definition** (§4.4): boat-frame athwartships, world-horizontal,
  or both. Decide what "the clew" and "the leech at spreader 2" mean precisely
  — outer edge? centre of the ring? leech tape centreline? The tool computes
  both today so the decision is not blocking, but it is still the decision that
  matters most.
- ~~Feed it the rig model's real numbers~~ — **done, from the IRC certificates**
  (§3.1). Wire the heel straight off the log row rather than typing it in.
- **Find the frames the compilations were made from.** SSA holds 9 photos for
  5 Sept — 11:42, 12:37×3, 12:46×3, 13:37, 14:25 — and *none* at 11:53, 11:58
  or 12:03, which are the three moments the 6 Sept compilations use. Only the
  flattened, rotated, upscaled panels survived. Until those originals turn up,
  the "re-measure 20 Rhino dimensions" comparison has nothing to run on.
- **Re-measure 20 dimensions that were done in Rhino on 5–6 Sept** and compare.
  Two outcomes, both valuable: agreement (the tool is a drop-in replacement and
  Rhino is retired), or a systematic offset (§4.3's range bias is real and now
  quantified).
- *Ships:* the speed team stops using Rhino. *Produces:* the first labels.

### Stage 1 — automatic pose, manual targets

**Mostly built.** Two of the four detections are automatic and validated on
real frames; what remains is data, not code.

**The horizon, found automatically** (`detectHorizon`). The sea horizon is
world-horizontal by definition, so it fixes the camera's roll exactly and makes
the logged heel a *check* rather than an input. It runs the moment a frame is
opened. On the six 5 Sept frames it fits to **0.9–1.3 px rms over 111–151
columns**.

Two things make it harder than it sounds, and both are in the code: a clear
Mediterranean sky at the top of the frame is *bluer* than the sea just below
the horizon (measured: 62–70 blue-minus-red against 38 for the pale sky above
the water), so brightness relative to this frame's own sky is what separates
them; and the boat's sails are navy — as blue and as dark as the water — so the
search runs from the bottom up, the sea being the region that reaches the
bottom edge. Everything that can go wrong pushes a column's answer *down*, so
among candidate lines that fit, the highest one wins. That is what survives a
headland filling more of the skyline than open water does.

**The mast, from one click** (`traceMastFromSeed`). The click says which edge;
the trace follows it sub-pixel, up and down, as far as the contrast holds, and
is drawn so the operator can see where it went. On the 5 Sept frames it covers
**76–90 % of the frame height**. No network, no OpenCV — these are long,
high-contrast, near-straight boundaries against plain sky, the one regime where
classical edge finding plus a robust fit beats anything learned.

**The end-to-end check, which needs no rig dimensions at all:** the angle
between the traced mast and the detected horizon *is* the heel. Against the
log, over six frames:

| frame | horizon | mast | heel from the photo | logged | Δ |
|---|---|---|---|---|---|
| 12:37:46 | −2.50° | 20.76° | 23.27° | 23.5° | −0.23° |
| 12:37:48 | −1.86° | 21.52° | 23.38° | 23.2° | +0.18° |
| 12:37:52 | −2.25° | 23.95° | 26.20° | 24.8° | +1.40° |
| 12:46:30 | −4.71° | 17.26° | 21.97° | 22.1° | −0.13° |
| 12:46:31 | −4.30° | 16.54° | 20.83° | 22.4° | −1.57° |
| 12:46:37 | −4.57° | 17.63° | 22.21° | 21.6° | +0.61° |

Worst disagreement 1.57°, and the answers move by less than 0.2° between
decoding at 900 px and 1600 px wide. Repeatable with
`npm run sailtrim:validate -- <frames> --heel 23.5,23.2,…`, which is how any
future change to the detectors gets checked.

Still to do, and all of it is the rig model rather than code:

- **The dimensions — now solved from IRC** (§3.1). `src/lib/ircCertificate.ts`
  reads a certificate into a rig model; paste one into the tool, or run
  `npm run irc:rigmodel -- <folder of PDFs> --out models` for the whole fleet.
  `src/lib/rigModel.ts` holds them per boat with the provenance of each —
  `designer`, `measured`, `derived` or `estimate` — and anything short of a
  real number propagates its sigma into every measurement.
  `supabase/migrations/0090` adds `boats.rig_model` and a `sail_trim` table;
  **not applied**.
- **Centreplane landmarks** are still clicked, not detected. Two points is a
  small ask, and ψ is the one number that most rewards being got right.
- **The log row** — heel, TWS, TWA, `JibIO%` — is still typed in rather than
  joined on the photo's capture second.

### Stage 2 — automatic targets (≈6–8 weeks)

- Keypoint/segmentation model for leech, clew, boom, trained on Stage 0–1
  labels plus synthetic renders of the rig model (the standard trick from the
  BOP world: render the CAD model under a distribution of poses and light).
- **Validate against the logged sensors**: predicted clew position vs `JibIO%`,
  predicted boom position vs `Mainsheet`/traveller, predicted leech vs
  `JIB_LEECH%` and `JIB_SAGy` from the lidar. This is the claim that sells the
  product, and the data for it already exists for every day we have sailed.
- *Ships:* upload a stern photo, get three numbers. The 6 Sept workflow becomes
  automatic.

### Stage 3 — video and the time series (≈6 weeks)

- Rolling-shutter test first. Frame scoring, per-frame measurement, aggregation,
  join to the 4 Hz log, chart in Analytics.
- *Ships:* trim as a continuous channel rather than a handful of stills.

### Stage 4 — boats we do not own (opportunistic)

- ~~No rig model for a rival.~~ — **solved by the certificates** (§3.1), and
  §8 argues this is the beginning of the interesting part rather than an
  opportunistic afterthought: the same certificates carry the sail girths, which
  are what turn an astern photograph into twist and camber.
- Expect a factor-of-2 worse uncertainty than our own boat and say so — the
  range is longer and the sail identification is inferred rather than known.
- Also: for our own boats, a handful of **passive markers** on the spreaders and
  boom (the Maciel 2021 trick) would cut Stage 1's uncertainty substantially for
  the cost of some tape. Worth a trial in Stage 1, not a dependency.

---

## 8. The longer game — twist and draft for boats with no instruments

Sections 6 and 7 measure three points on one sail. The destination is different
and much larger: **twist and draft at every stripe, on the main and the jib, for
a boat we do not own and cannot instrument.** Northstar has lidar and SailScan;
the five rivals in §3.1 have a photograph and a certificate. If a photograph and
a certificate are enough, SSA can say what a rival's sails are doing, which is
not a thing anyone can currently buy.

The plan below is not a straight extension of Stage 4. The difficulty is
distributed very differently from how it looks, and one quantity in the list is
much harder than the rest.

### 8.1 What the astern projection preserves, and what it destroys

Take the camera dead astern, looking forward. It images the athwartships-vertical
plane; fore-and-aft is the axis it collapses. Every quantity on the wish list
sorts cleanly by which direction it mostly lives in:

| quantity | mostly lies | from astern |
|---|---|---|
| leech offset at a given height | athwartships | **measured directly** — this is Stage 0 |
| camber **depth** (the bulge) | athwartships | **measured directly** |
| twist (chord angle per stripe) | a ratio of the two | **solvable, given the chord length** |
| chord length per stripe | fore-and-aft | foreshortened to nearly nothing |
| draft **position** (% aft along the chord) | fore-and-aft | **the hard one** |

The counter-intuitive line is the second. A sheeted mainsail's **chord** runs
mostly fore-and-aft — Northstar's boom is E = 10.33 m aft of the mast while the
leech is a metre or two to leeward — so the chord is precisely what the
projection ruins. But the sail **bulges to leeward**, and leeward is
athwartships: the belly is in the plane the camera resolves best. The thing that
looks hardest to see from behind is in fact the easiest, and the humble length
you would divide it by is the thing that is lost.

So camber % = (a quantity the photo measures well) ÷ (a quantity the photo
cannot measure at all). Everything turns on where the denominator comes from.

### 8.2 The girths are the denominator, and the certificates carry them

They do — for both sails, for all six boats, parsed from the same PDFs as §3.1.
MHW/MTW/MUW are the mainsail's widths at 1/2, 3/4 and 7/8 hoist; HHW/HTW/HUW are
the headsail's at the same fractions of the luff:

| boat | E | MHW | MTW | MUW | MHW/E | MTW/E | MUW/E | HLP | HHW | HTW | HUW | HHW/LP | HTW/LP | HUW/LP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Northstar III | 10.33 | 7.04 | 4.93 | 3.63 | 0.682 | 0.477 | 0.351 | 8.96 | 4.90 | 2.66 | 1.48 | 0.547 | 0.297 | 0.165 |
| Jethou | 10.17 | 7.02 | 5.00 | 3.64 | 0.690 | 0.492 | 0.358 | 8.54 | 4.54 | 2.44 | 1.34 | 0.532 | 0.286 | 0.157 |
| Bella Mente | 9.66 | 6.74 | 4.91 | 3.74 | 0.698 | 0.508 | 0.387 | 8.72 | 4.60 | 2.50 | 1.40 | 0.528 | 0.287 | 0.161 |
| Balthasar | 9.88 | 6.78 | 4.91 | 3.71 | 0.686 | 0.497 | 0.376 | 8.52 | 4.56 | 2.51 | 1.40 | 0.535 | 0.295 | 0.164 |
| Jolt | 9.86 | 6.67 | 4.76 | 3.62 | 0.676 | 0.483 | 0.367 | 8.70 | 4.64 | 2.54 | 1.42 | 0.533 | 0.292 | 0.163 |
| Django 7X | 9.63 | 6.68 | 4.83 | 3.70 | 0.694 | 0.502 | 0.384 | 8.83 | 4.64 | 2.45 | 1.33 | 0.525 | 0.277 | 0.151 |

Two things follow, and the second is the surprise.

**Twist and camber need no machine learning.** Given the chord length at a stripe
(the girth) and the athwartships component of the chord (the photograph), the
fore-and-aft component is Pythagoras and the chord angle falls out; the
difference between two stripes' chord angles is twist. Camber depth is the
sagitta the photograph already shows, divided by the girth. For a rival's
**mainsail** that is a complete answer from a photograph and a certificate, with
no training data anywhere in it.

**Normalised, the whole fleet is one sail.** MHW/E spans 0.676–0.698 across six
different designers — a **3.2 % spread**. HHW/LP spans 0.525–0.547, **4.1 %**.
The planforms tighten as you come down the sail and loosen at the head, where
designers actually differ: MUW/E spreads 9.8 %, HUW/LP 8.9 %. So for a Maxi 72
whose certificate we do not have at all, the girths are predictable from E or LP
to a few per cent — and a few per cent on the denominator is a few per cent on
the camber, which is inside the number's usefulness.

One gap worth naming: the widths are at 1/2, 3/4 and 7/8 — **there is no
quarter-height width.** Draft stripes usually sit at about 1/4, 1/2 and 3/4, so
the middle and upper stripes land on MHW and MTW almost exactly, and the lower
stripe has to be interpolated between the foot (E, or HLP, at zero height) and
MHW. That is a short, well-anchored interpolation rather than an extrapolation,
which is why it is a footnote and not a problem.

### 8.3 The headsail gap is real, and SSA is the only one who can close it

The certificate dimensions **one** headsail. Northstar's is ID# J1.5-B, and
`HLP` and `HSA` each appear exactly once in the file. The boat is rated to carry
four. So J2, J3 and J4 — which is most of the wind range — have no girths at
all, while the mainsail, which barely changes across the range, is fully
described. The certificate covers the sail that changes least and omits the ones
that change most.

Three ways in, best first:

1. **Measure them once on our own boat and keep them.** SailScan already
   measures chord per stripe. Every J2/J3/J4 scan is a girth table for a sail
   IRC never dimensioned — and these are fleet-standard sails from the same few
   lofts, so Northstar's J3 profile is a real prior for another Maxi 72's J3.
   This turns a hole in the certificate into a dataset SSA owns and nobody else
   has. It is the clearest case in this document of the instrumented boat paying
   for the un-instrumented ones.
2. **Scale from LP.** Smaller headsails are flatter, not scaled copies, so this
   is wrong — but wrong *systematically*, which means (1) measures the
   correction once and it applies thereafter.
3. **Which jib is up is already a Stage 0 output.** The clew position that
   shipped this week discriminates between J1/J2/J3 on its own, because the clew
   moves aft and inboard as LP shrinks. The sail identification the rest of this
   depends on is a by-product of what is already built.

### 8.4 Where the machine learning actually belongs

Not photograph → shape. **Learn the residual.**

Build the deterministic model of §8.2, run it on our own boat, and use lidar and
SailScan to measure its *error*. Then fit a small correction — a handful of
parameters — rather than a mapping from pixels to camber.

The reason is arithmetic, not taste. The scarce resource is not photographs and
not lidar hours; it is their **intersection** — frames shot from the RIB while
the lidar was running on a sail whose state is known. SSA holds nine photographs
for 5 Sept. A residual model with a few parameters can be fitted on tens of
paired samples and will tell you honestly when it is extrapolating. An
end-to-end model needs thousands and, when it is wrong about a rival's camber,
is wrong confidently and silently. That is the same argument that killed the
sail-on-sail edge detector in Stage 0: a detector that picks the wrong edge with
confidence is worse than no detector.

### 8.5 Video is not a convenience — it is the data engine

§6.3 and Stage 3 treat video as a later refinement that turns stills into a time
series. That undersells it. A single pass down the transom at 30 fps is roughly
**18,000 frames**, of which some hundreds will have a usable ψ and heel. Against
nine photographs for a day, that is not an improvement in convenience; it is two
orders of magnitude of training data for every stage that follows.

And the selection criterion already exists: ψ is measured, not assumed, so
frames can be *scored and chosen* rather than hoped for. **Video frame selection
should come before automatic target detection, not after it** — the detector
wants labels, and every marked frame is a label, so the cheapest way to get a
detector is to make marking cheap and frames plentiful first.

### 8.6 The ψ spread is parallax — geometry where the ML was planned

Draft position is the one quantity §8.1 marks as genuinely hard, because a
position along a chord is a fore-and-aft measure and a single astern frame has
no fore-and-aft information at all.

A burst of video frames does. Over a pass, ψ sweeps through several degrees,
and those frames view the *same sail state* from different angles. That is
parallax: the fore-and-aft shape one frame cannot see is constrained by the
spread across many. A few degrees is a short baseline, but the sail is 10 m deep
and the measurement is a shape rather than a range, which is a far kinder problem
than the stereo depth estimate §4.5 dismissed.

This is the most valuable untested idea in this document, because it converts the
hardest sub-problem from one needing training data into one needing none. It
should be tried on a single video before any commitment is made to the learned
route.

### 8.7 Already measured, currently thrown away: mast bend

`traceMastFromSeed` follows the mast sub-pixel over 76–90 % of frame height and
then **fits a straight line through it and discards the curve.** Those points are
a mast-bend measurement — free, on every frame, for rivals as well as for us, and
bend is what sets the mainsail's entry. It should be kept and reported rather
than fitted away. The fix is small and the data is already in hand on every frame
ever marked.

### 8.8 The order this argues for

Each step reuses what the step before it built, and none of them is blocked on
the one after:

1. **More targets, same geometry.** Leech at every spreader and every stripe,
   main *and* jib. `leechTargets` and the reference-height machinery generalise
   from one height to N almost unchanged. Highest value per unit of work in the
   whole document, and it needs no new science.
2. **Twist and camber from the girths** (§8.2), validated against our own lidar
   and SailScan. This either works or says exactly what is wrong.
3. **Video frame selection** (§8.5) — the data engine, before the detector.
4. **Automatic targets**, trained on the labels steps 1–3 have been generating
   all along.
5. **Parallax for draft position** (§8.6); the residual correction (§8.4) only
   for what parallax and geometry leave over.
6. **Rivals.** By this point the only thing that is theirs rather than ours is
   the certificate, and §3.1 has six of those.

The order matters more than any single step in it. Steps 3 and 4 are routinely
run the other way round, which is how projects like this end up hand-labelling
for months to train a detector on a corpus that a week of video would have made
redundant.

---

## 9. Risks, honestly

| Risk | Severity | Mitigation |
|---|---|---|
| The definition (§4.4) is settled late and Stages 0–2 measure the wrong thing | **high** | Settle it in Stage 0, before code |
| Rig model unavailable or inaccurate for N72 | high | It gates everything from Stage 1. Confirm it exists *this week* |
| Clew depth ambiguity | medium | Constrain from jib foot + `JibIO%`; publish its wider error bar; do not pretend it is as good as the leech measurement |
| Rolling shutter kills the video stage | medium | Test in Stage 3 before building on it |
| EXIF stripped upstream | low | Recovered by the pose fit (§4.3); also fix the export so it stops happening |
| Motion blur / spray / backlit sails | low | Frame scoring rejects them; at 1/1250 s there is little blur |
| Detector accuracy | **low** | §4.1 — there is an order of magnitude in hand |

The thing that kills this project is not vision. It is measuring something
subtly different from what the speed team means, very precisely.

---

## 10. What I need decided

1. **The definition.** Probably already answered — §4.4 measures the 6 Sept
   panels as rotated ~23° to stand the mast up, which makes the existing
   numbers **boat-frame athwartships**. Confirm that is deliberate rather than
   an artefact of making the panels look tidy side by side, and SailTrim's
   default is already right.
2. **The exact target points.** Clew: ring centre or sail corner? Leech at
   spreader 2: at the spreader *tip* height or the spreader *root* height on the
   mast? Boom: outboard end, or a fixed station along it?
3. **The tolerance that matters.** Is ±20 mm right, or is ±50 mm plenty, or does
   the team actually need ±10 mm? The whole error budget is set by this answer.
   With P as the scale and ψ measured, the jib targets should now sit inside
   ±20 mm; the boom is the one that will need the baseline marked every time.
4. ~~**Does the Rhino rig model exist for both N76 and N72?**~~ — **moot.** The
   IRC certificates carry everything the measurement needs (§3.1), for the
   whole fleet, measured and endorsed. A rig drawing would still improve two
   things: the mast's athwartships section (a better short-range scale check)
   and the height of spreader 2 (which is what the leech target is defined
   against, and is currently taken as 20 m).
5. **Is the 5–6 Sept Rhino session reproducible** — the same operator measuring
   the same dimensions again — so Stage 0 has a human-repeatability figure to
   compare against? Without it we can say the tool is consistent, but not that
   it beats a person.

---

## Sources

Sailing:
[VSPARS](https://vspars.com/) ·
[Le Pelley & Modral, V-SPARS, HPYD 2008](https://www.vspars.com/cmsFiles/file/LePelley_Modral_VSPARS.pdf) ·
[The Sail Cloud](https://www.thesailcloud.com/) ·
[SailTool, Curtin CMST](http://cmst.curtin.edu.au/products/sailtool-software/) ·
[SailPack-Vision](https://www.bsgdev.com/CMS3/index.php/menuproducts/sailpack-vision) ·
[Sailemetry](https://www.sailemetry.com/) ·
[AccuMeasure, UK Sailmakers](https://uksailmakers.com/accumeasure) ·
[SailWatcher](https://www.sailwatcher.com/) ·
[Oliveira, Sail and Rig Shape From Single Images, IST 2016](https://fenix.tecnico.ulisboa.pt/downloadFile/1407770020544647/ExtendedAbstract.pdf) ·
[Deparday et al., full-scale offwind flying shape](https://www.sciencedirect.com/science/article/abs/pii/S0029801816304334) ·
[Maciel et al., monocular 3D sail shape with passive markers](https://link.springer.com/article/10.1007/s00138-020-01149-3) ·
[How the TP52 fleet uses America's Cup tech](https://www.yachtingworld.com/americas-cup/how-the-tp52-fleet-uses-americas-cup-tech-138511)

Computer vision:
[BOP Challenge 2024](https://arxiv.org/pdf/2504.02812) ·
[BOP benchmark](https://bop.felk.cvut.cz/challenges/) ·
[MegaPose](https://proceedings.mlr.press/v205/labbe23a/labbe23a.pdf) ·
[FoundationPose](https://nvlabs.github.io/FoundationPose/) ·
[Criminisi, Reid & Zisserman, Single View Metrology](https://www.microsoft.com/en-us/research/wp-content/uploads/1999/01/Criminisi_iccv1999.pdf) ·
[TTPLA power-line dataset](https://arxiv.org/pdf/2010.10032) ·
[Vision-based power line and pylon detection](https://arxiv.org/html/2407.14352v2) ·
[Sub-pixel edge localisation](https://arxiv.org/pdf/2502.16502) ·
[Wind-turbine blade tip clearance by machine vision](https://pmc.ncbi.nlm.nih.gov/articles/PMC11435556/)

In-repo: `docs/sailscan/prior-art.md`, `src/lib/sailscan-cv.ts`,
`src/lib/flatLogParse.ts`, `src/lib/lidarTables.ts`,
`src/lib/sailScanParse.ts`, `supabase/migrations/0035_boat_config_sails.sql`,
`sail-scan-ai/`.
