# SailScan v2 — Training & Optimisation Plan

Phased plan to tune the auto-fill algorithm against 30-50 user-collected example photos. Covers data collection, evaluation, parameter search, and per-yacht specialisation.

The accuracy of SailScan v2 depends on a small set of numeric parameters in `src/lib/sailscan-cv.ts` — HSV tolerances, perpendicular search radius, draft clamps, anchor weights, snap radius. Hand-tuned defaults hit ~80% of cases; getting to 95%+ requires fitting the parameters to actual data.

---

## Phase F1 — Ground-truth data capture (user-driven)

For each photo (target 30-50):

1. Open SailScan, place luff and leech for **every visible trim stripe** by long-press, then **manually drag each midpoint** until the spline overlay matches the visible stripe centerline.
2. Tap **💾 Save to Photos**. The saved record carries `sailscan_data` JSON with raw stripe points + computed metrics — that JSON IS the ground truth.
3. (Optional) Add `sailscan-truth` as an extra raceTag so the evaluator can find them.

**Variation to seek across the 30-50:**

- Different yachts (sail colours: black, white, red, blue, multi-coloured)
- Different sails (mainsail, jib, with/without battens visible)
- Different lighting (full sun, overcast, into the sun, dawn/dusk)
- Different crew angles (under boom, companionway, rail)
- Different sail trim conditions (flat, powered up, twisty, depowered)

---

## Phase F2 — Evaluation framework (1 build session)

Build a small benchmark runner.

1. Add an Admin button **"Run SailScan benchmark"** that iterates all photos with `sailscan_data` JSON in their metadata.
2. For each photo:
   - Read the saved `sailscan_data` to get the user's manually-traced points (= ground truth).
   - Call `detectStripeFromTap(image, luff, {leechHint: leech})` with the user's luff and leech.
   - Compare auto midpoints to manual midpoints. Compute per stripe:
     - **Centerline RMSE** — root-mean-square distance between auto and manual centerlines, in image pixels.
     - **Max draft error** — `auto draft% − manual draft%`.
     - **Draft position error** — `auto draft-position% − manual draft-position%`.
     - **Entry angle error** (degrees).
     - **Exit angle error** (degrees).
3. Aggregate across all photos. Report mean / p50 / p90 / max for each metric.

Output: a JSON file the optimiser can re-read, plus an in-app card showing per-photo errors.

A minimal-viable F2 is ~150 lines of TS in a new file `src/lib/sailscan-bench.ts` plus an Admin button. Doable in one build session.

---

## Phase F3 — Parameter sweep (offline)

| Parameter | Current | Search space |
|---|---|---|
| `HUE_DIFF` | 15 | 5, 10, 15, 20, 25 |
| `SAT_DIFF` | 60 | 30, 50, 60, 80, 100 |
| `VAL_DIFF` | 60 | 30, 50, 60, 80, 100 |
| `PERP_RADIUS` | 30 | 10, 20, 30, 50 |
| `SAMPLES` | 60 | 30, 60, 90, 120 |
| `ANCHOR_W` | 100 | 10, 50, 100, 200, 500 |
| `SNAP_RADIUS` | 5 | 2, 5, 10, 15 |
| `MIN_DRAFT_FRAC` | 0.05 | 0.02, 0.05, 0.08 |
| `MAX_DRAFT_FRAC` | 0.30 | 0.20, 0.25, 0.30, 0.40 |
| Downsample `MAX` | 1024 | 512, 1024, 2048 |

**Strategies (pick one):**

- **Grid search** — small factorial across the most important params. ~700 combos × 50 photos = 35k runs. ~10 min on iPhone. Cheap, exhaustive.
- **Random search** — 200-500 random samples from full hypercube. Better for high dimensions.
- **Bayesian optimisation** — sequential strategy. ~100 evaluations. Run offline in Python with scikit-optimize.

For each sample, run the evaluator and record the aggregate error. Pick the parameter set that minimises a weighted objective:

```
J = w1 · mean_centerline_rmse + w2 · mean_draft_error + w3 · mean_angle_error
```

Default weights `(1.0, 0.5, 0.3)` — prioritise centerline accuracy because draft/angle errors are downstream of it.

---

## Phase F4 — Per-yacht specialisation

After global optimisation:

1. Filter the corpus to one yacht's photos (≥10 to be useful).
2. Re-run F3 on that subset.
3. Save the tuned parameters under `ssa:sailscan:yacht-prefs[boatName].cvParams`.
4. At detection time: look up boat name → use yacht's params if present, else global defaults.

Per-yacht tuning matters most when:
- Stripe colours are unusual (e.g. dark grey on a black sail).
- Sail material reflectance is unusual (shiny carbon vs matte dacron).

---

## Phase F5 — Algorithmic upgrades (when parameter tuning plateaus)

If RMSE > 5 pixels persists after Phase F3-F4, the algorithm itself is the bottleneck. Candidate upgrades, rough cost/benefit order:

1. **Edge-aware flood fill** — pre-pass with Canny, mark strong-edge pixels as barriers. Stops the flood from leaking across luff/leech.
2. **Lab colour space** instead of HSV — perceptually uniform, better stripe-vs-background under variable lighting.
3. **Multi-stripe context** — when 2+ stripes detected, enforce parallelism. Reject candidate points that violate the parallelism prior.
4. **ML-based segmentation** — small CNN (≤500K params, runnable in browser via TF.js or ONNX) trained on the labelled corpus. Replaces flood fill entirely. Bigger lift, larger gain.
5. **Sub-pixel centerline precision** — refine each centerline point by parabolic fit on local intensity. Useful only if sub-pixel accuracy matters.

---

## Phase F6 — Iteration & track progress

- After every batch of new labelled photos, re-run F2-F4.
- Track accuracy over time in `docs/sailscan/benchmark-history.md`.
- Document which parameters moved most and why.

---

## Build order recommendation

Build **F2 first** (benchmark runner). It tells us baseline accuracy and gives a measuring stick. Without it, parameter tuning is guessing. F3+ only become valuable once we can measure objectively.
