# Racing-Yacht Forecast Diagnostics — Specification (pre-implementation)

**Status:** draft for review · **Date:** 2026-06-22 · **Author:** weather diagnostics workstream
**Purpose:** define the deterministic, physically-grounded diagnostics that feed the AI-written
tactical race brief (exec summary on the forecast deck). The LLM does *phrasing*; these
diagnostics do the *physics*, so the brief is numeric and reproducible, not hand-waving.

This spec is the output of a focused literature/operational-practice review (sea-breeze
meteorology, sailing-met texts, ensemble/verification science, gap-wind dynamics). Every
quantitative threshold below carries a confidence rating and a source; thresholds marked
*tune* are defensible defaults to be calibrated against the first season of Icon-Race
verification at La Spezia / Channel venues.

---

## 1. Architecture

```
ICON _pbl stream + soundings + HPBL + multi-model fetch
        │
        ▼
[ primitives ]  coast-normal θ · cross-shore gradient component · thermal bend Δβ ·
                sea-breeze index SBI · inversion/stability from sounding · multi-model spread
        │
        ▼
[ diagnostics ]  Sea-breeze potential (0–10)  ·  Type-of-day (4 classes)  ·
                 Cloud-trend signal  ·  Confidence (High/Mod/Low)  ·  Funnelling field
        │
        ▼
[ deck ]  shown numerically on the title/stability slides  +  passed as structured
          JSON into the Claude exec-summary prompt (grounding, not invention)
```

Design rule: **stability and insolation can VETO a sea breeze** (multiplicative gates);
everything else sums. The gradient-wind *direction relative to the coast* (Quadrant Theory)
is the largest day-to-day discriminator and enters as a signed modifier.

---

## 2. Data inputs (what we already have / need)

| Input | Source | Status |
|---|---|---|
| 10 m wind (dir/speed) | all models | have |
| Low-level wind 100–900 m AGL (≈ 925 hPa / BL-top) | SSA-Race `_pbl`, soundings, ECMWF pressure levels | have |
| Boundary-layer / mixed-layer height `h_mix` | HPBL field (bulk-Richardson) | have |
| Low-level sounding (T, Td, wind) ≤ ~1500 m | SSA-Race sounding.json / ECMWF | have |
| Capping-inversion strength & base height | derived from sounding (new) | **derive** |
| CIN (`cin_ml`) | planned `_pbl` addition (TODO_hpbl_and_instability) | **pending** |
| Air–SST contrast ΔT | 2 m T_max over land − SST | have/derive |
| Total + low cloud over land/sea | model `clct` / `clcl` | have |
| Coastline orientation θ (normal, land→sea) | static, from land-sea mask at point 1 | **derive once per venue** |
| Multi-model TWD/TWS at race time | existing comparison fetch | have |
| ~1 km wind-field grid | SSA-Race / windField | have |

The only genuinely new data work is: (a) deriving inversion strength/base + a stability
metric from the sounding profile, (b) the planned `cin_ml`, (c) a per-venue coastline-normal θ.

---

## 3. Primitives

**3.1 Coastline normal θ** — azimuth pointing from land out to sea at point 1. Derived once
per venue from the land-sea mask (or set manually per venue; small list). All "onshore /
offshore / along-shore" logic is relative to θ.

**3.2 Cross-shore gradient component** — project the gradient (925 hPa / BL-top) wind onto θ:
`U_cross = G · cos(angle(G_dir, θ))`. Positive = offshore, negative = onshore. This is the
single most important number for sea-breeze suppression.

**3.3 Thermal bend Δβ** — signed angular difference between 10 m and gradient (925 hPa)
direction. Friction-only turn is ~10–15° over open ocean, ~20–30° on enclosed water
[Sailing World/Bedford, high]. A bend **materially larger than the friction band**, or a
coherent afternoon backing/veering excursion, signals thermal forcing.

**3.4 Sea-breeze index SBI** (the cleanest machine discriminator — uses only fields we have):
surface onshore + BL-top offshore + the two opposing.
`SBI = cos[α − (θ+90°)] × cos[(α+180°) − β]`, where α = 10 m dir, β = BL-top dir, range 0→1,
max when surface flow is coast-perpendicular onshore and the layer aloft exactly opposes
[GMD 2026 / Hallgren et al., high]. SBI > 0 = a closed sea-breeze cell is present.

**3.5 Inversion / stability from sounding** (the *primary* sea-breeze control, per your steer):
from the low-level profile compute (i) sub-inversion lapse rate Γ in °C/km, (ii) capping-
inversion strength ΔT_inv (°C across the inversion) and base height z_inv, (iii) `h_mix`
from HPBL, (iv) CIN when available.
 - Well-mixed near-dry-adiabatic (Γ ≳ 8 °C/km) + deep `h_mix` → favourable.
 - Low, strong cap (shallow `h_mix`, large ΔT_inv, high CIN) → the land CBL can't deepen,
   thermal low never forms → **breeze suppressed** [Crosman & Horel 2010, high].
 - Nuance: a strong inversion sitting *well above* a healthy deep CBL is benign/favourable
   (it sharpens the front). So the killer is specifically a **low cap**, not "any inversion."

**3.6 Multi-model spread** — circular std of TWD across models `σ_TWD = sqrt(−2 ln R)`
(R = resultant length), and TWS std `σ_TWS`, at race time/place.

---

## 4. Sea-breeze potential score (0–10)

Hybrid additive + multiplicative-gate, stability dominant (it appears twice — as a gate AND
in the additive mix):

```
Score = 10 · G_stab · G_solar · [ 0.45·f_grad + 0.35·f_thermal + 0.20·f_stab2 ] + Q_mod
```

| Element | Meaning | Definition (each 0–1 unless noted) |
|---|---|---|
| **G_stab** (gate) | vertical stability / inversion lid — **primary driver** | `clamp((h_mix−300)/(1300−300)) × clamp(1−CIN/CIN_max) × invFactor`; invFactor→0 for a low strong cap. *tune* h_min≈300 m, h_full≈1300 m, CIN_max≈50–100 J/kg |
| **G_solar** (gate) | insolation available | `1 − 0.8·cloud_fraction_land`; heavy overcast → ~0.2 |
| **f_grad** (0.45) | cross-shore gradient wind | triangular: peak at light offshore (U_cross ≈ −2 m/s in sailing sign), → 0 at offshore ≥ 6 m/s and onshore ≥ 6–8 m/s. Equivalent to Biggs–Graves ε<3 |
| **f_thermal** (0.35) | air–SST / land–sea ΔT | 0 at ΔT≤0, ~0.5 at 3 °C, 1.0 at ≥5–6 °C |
| **f_stab2** (0.20) | mixed-layer quality | rewards near-adiabatic Γ and deeper `h_mix` beyond the gate threshold |
| **Q_mod** | Quadrant Theory modifier (§6) | signed −3…+2 added after, then clamp 0–10 |

**Biggs & Graves (1962) ε** = |U|² / (C_p·ΔT), C_p = 1004 J/kg/K, critical **ε = 3** (breeze
expected when ε < 3) [high]. We embed this inside `f_grad` rather than as a separate term.

Anchored thresholds (confidence): offshore-gradient kill ≈ 6 m/s / ~12 kt [Steele et al.;
Adaricheva 2023, high]; ΔT init ~1 °C, deep penetration ≥5 °C [Wikipedia/Simpson, medium];
ε_crit = 3 [Biggs & Graves, high]. `h_mix`/CIN cut-points are engineering defaults [low — *tune*].

> Note on your "10 kn" low-level wind threshold for type-of-day (§5): the literature's
> suppression ceiling is ~12 kt (6 m/s). I propose we use **your 10 kn as the class boundary**
> and keep 12 kt as the steep roll-off inside `f_grad` — i.e. 10 kn splits the *labels*, 12 kt
> shapes the *score*. Both exposed as tunables.

---

## 5. Type-of-day classifier (your four classes)

Inputs: `W_lowlevel` = 100–900 m AGL wind speed (kt); SBI; Δβ thermal bend; sea-breeze
favourability (= is `G_stab·G_solar·f_grad` healthy AND quadrant favourable); funnelling flag (§8).

```
0. FUNNEL PRE-FILTER (topography wins first)
   IF funnelling flag set in race box (R ≥ 1.3 & along-flow accel & gap/headland geometry):
        → (iv) FUNNELLED GRADIENT WIND

1. ELSE branch on low-level wind speed (your 10 kn boundary):
   IF W_lowlevel < 10 kn:
        IF favourable sea-breeze conditions (G_stab·G_solar healthy, SBI>0, quadrant ok):
              → (i) PURE SEA BREEZE
        ELSE:
              → (iii) GRADIENT/light residual + trend
   ELSE (W_lowlevel ≥ 10 kn):
        IF favourable sea-breeze conditions AND thermal-bend detected (Δβ ≫ friction band, or SBI>0):
              → (ii) THERMALLY-ENHANCED GRADIENT
        ELSE (unfavourable sea breeze, limited thermal bend):
              → (iii) GRADIENT WIND DAY + trend
```

Each class also emits the supporting evidence for the brief, e.g.
*"(ii) thermally-enhanced: 925 hPa 14 kt, surface bent 28° left of gradient, SBI 0.4,
ΔT 4 °C → breeze reinforcing the gradient, expect build + right-veer through afternoon."*

Class → human label mapping (Houghton-style, for the deck): pure sea breeze · thermally-
enhanced (reinforced) gradient · gradient day · funnelled gradient.

---

## 6. Quadrant Theory modifier (gradient-wind direction vs coast)

The four-box labels are sailing heuristic; the **underlying physics is peer-reviewed** —
Steele et al. (2015, QJRMS) find sea-breeze strength maximises when the gradient has a
shore-parallel component with **land on its left** (N. hemisphere), and a ~6 m/s opposing-
flow suppression criterion [high]. We build the modifier on the physics and use the Q-labels
for the UI.

Convention: θ_rel = signed angle of the gradient wind (direction *from*) relative to the
offshore normal; "left" = land-on-left looking out to sea (NH favourable).

| Family (|θ_rel|) | Side | Quad | Behaviour | Q_mod (NH) |
|---|---|---|---|---|
| Offshore (≤60°) | left | **Q1** | best — light offshore holds breeze back, clean build | **+2** |
| Offshore (≤60°) | right / strong | **Q3** | suppressed/late, dies PM | **−2** |
| Along-shore (60–120°) | left | **Q4** | reinforced, all-day build, can exceed 20 kt (hybrid) | **+1.5** |
| Along-shore (60–120°) | right | **Q3** | suppressive | **−1.5** |
| Onshore (≥120°) | — | **Q2** | reinforced onshore, no discrete front, weak predictability | **+0.5** |

Plus a speed sub-modifier on the offshore component: light offshore (≤8 kt) +0.5 (delays then
boosts); 15–25 kt −1; >25 kt −3 (hard suppression) [Houghton 25 kt rule, medium; Steele 6 m/s, high].
Hemisphere flips sign of "left" and the Coriolis veer. Expected breeze direction = onshore
(θ+180°) at onset, veering ~+35° (NH) by mid-afternoon [PredictWind/AC met, high].

---

## 7. Cloud-trend signal

Sea breeze runs on insolation; the **trend** of low cloud over the upwind land through the
heating window (09:00→13:00 CEST) is a leading indicator, and it's the **land-minus-sea**
cloud that matters [PredictWind/AC met; Houghton & Campbell, high].

```
land_cloud_am  = mean(clcl over upwind land sector, 09–11)        # oktas 0–8
land_cloud_mid = mean(clcl over upwind land sector, 11–13)
trend = land_cloud_mid − land_cloud_am
base    = clamp((4 − land_cloud_am)/4, −1, 1)                     # clear AM=+1, overcast=−1
C_trend = clamp(base − 0.5·max(trend,0)/2, −1, 1)                 # penalise midday building
# override: convective precip over land in PM  → C_trend = −1 (collapse flag)
# bonus:    cloud over water but land clear     → +0.2
```

Verdicts: ≤2 oktas clearing → full build; 3–5 steady → delayed/weaker; 3–5 *building* → over-
development risk; ≥6 persistent → marginal/no breeze; Cu→Cb+precip over land → collapse
("switch-off"); cells advected over water → possible boost. Okta cut-points are operational
discretisation [medium — *tune*]; mechanism is well-supported [high].

`C_trend` feeds both the sea-breeze score (via G_solar trend) and the confidence score.

---

## 8. Funnelling / channelled gradient wind (from the 1 km grid)

**Flag the Venturi misconception in code:** the max wind is NOT at the narrowest throat — it's
at the **gap exit / just downwind of a headland**. Place markers downstream accordingly
[US Navy mesoscale gap-wind primer; AMS glossary, high].

From `u(x,y), v(x,y)`, `S=√(u²+v²)`:
 - **Speed-up ratio** `R = S / S_ref` (S_ref = open-water median or gradient wind). `R≥1.3`
   noticeable, `R≥1.4–1.5` strong; `R≤0.8` lee/bay shadow [medium — *tune*].
 - **Convergence** `D = ∂u/∂x + ∂v/∂y`; line where `D ≤ −1×10⁻⁴ s⁻¹`, persists ≥2 frames,
   with a direction shift across it → sea-breeze / gap-exit front [high mechanism; threshold medium].
 - **Along-flow acceleration** `û·∇S` (û = unit wind); positive band + `R>1.3` downstream of a
   gap/convex headland = funnelled gradient wind.

Output layers for the deck/windfield: shaded `R` ("pressure map"), FUNNEL cores (markers
downstream of gaps/points), CONVERGENCE polyline (line to favour/cross), SHADOW patches to
avoid. Needs grid ≲ ¼ gap width — our ~1 km is adequate for straits/headlands of a few km+.
La Spezia relevance: headland acceleration at Punta Mesco / Portovenere / Cinque Terre points;
Tramontana gap enhancement off the Apennines [medium].

---

## 9. Confidence score (High / Moderate / Low)

Three components; multi-model agreement weighted highest, light air both lowers skill AND
caps the label.

```
S (0.35) sea-breeze marginality  = 0.5 + 0.5·C_trend − penalties(offshore>6m/s, stable AM, transitional SBI)
M (0.40) multi-model consistency = 0.6·clamp(1−σ_TWD/40°) + 0.4·clamp(1−σ_TWS/4kn)
L (0.25) low-wind factor         = 1.0 (≥9 kn) · ramp 0.4→1.0 (7–9) · 0.4 (5–7) · 0.2 (<5)

core    = 0.35·S + 0.40·M + 0.25·L
score10 = 10 · core · L_cap          where L_cap = min(1, 0.5+0.5·L)
Label:  ≥7 HIGH · 4–7 MODERATE · <4 LOW
```

Rationale: direction-forecast error scales as σ_dir ≈ 0.32/V for V ≤ 5 m/s — light air is
*intrinsically* less predictable, not just instrument noise [Jones/Smedman-Högström, high].
The <7 kn penalty additionally **caps** the score so light air can't read "High" even if
models happen to agree. Ensemble/multi-model spread as a confidence proxy is the standard,
defensible approach [Mylne/RMetS, high], but spread→skill is probabilistic — use a
categorical label, calibrate the cut-points [Whitaker & Loughe, high]. Headline number to
surface: **σ_TWD** with <15° High / 15–30° Moderate / >30° Low [direction-skill link high;
exact cuts medium — *tune*].

**Always pair the label with the named trigger**, the way AC meteorologists brief, e.g.
*"MODERATE — sea breeze marginal; ICON vs ECMWF disagree 22° on timing; watch midday cloud
over the Apuan foothills."*

---

## 10. How it feeds the Claude brief

The route payload gains a `diagnostics` object:
```json
{
  "typeOfDay": "thermally-enhanced gradient",
  "seaBreeze": { "score": 6.5, "quadrant": "Q1", "expectedDir": 210, "onset": "late morning", "drivers": [...] },
  "stability": { "h_mix_m": 1200, "inversion": "weak cap at 1400 m", "cin": 20 },
  "cloudTrend": { "signal": +0.4, "note": "clearing over land through midday" },
  "confidence": { "label": "MODERATE", "sigma_twd_deg": 22, "trigger": "ICON/ECMWF timing split" },
  "funnelling": { "flag": true, "where": "downwind of Punta Mesco" }
}
```
The SYSTEM prompt is updated to: *use these computed diagnostics as ground truth; phrase the
Situation / Today's wind / Stability / Outlook around these numbers; do not invent figures.*
This keeps the LLM as a writer, not a forecaster.

---

## 11. Build order (DECIDED 2026-06-22)

**No box blocker.** The *primary* stability gate — inversion strength/base, lapse rate — is
derived from the **low-level sounding we already publish** plus the live `h_mix` (HPBL).
`cin_ml`/`cape_ml` are NOT the sea-breeze onset driver (confirmed by both the literature
review and `regatta-nwp/docs/TODO_hpbl_and_instability.md`: *"no correlation between morning
CAPE/CIN caps and sea-breeze onset"*) — they are a **collapse / overdevelopment RISK flag**,
built in parallel and paired with the Cu→Cb cloud-collapse trigger (§7). App diagnostics start
immediately.

1. Primitives: coast-normal θ (**auto-derive from land-sea mask + per-venue override**),
   cross-shore component, Δβ, SBI, multi-model spread.
2. **Stability from sounding (primary gate, available now)**: inversion strength ΔT_inv,
   cap-base height z_inv, sub-inversion lapse rate Γ, `h_mix` (have). No box dependency.
3. Sea-breeze score (§4) + Quadrant modifier (§6) — node-test against hand-worked cases.
4. Type-of-day classifier (§5) + cloud-trend (§7).
5. Confidence (§9).
6. **Funnelling field (§8) — IN SCOPE this round**; reuses windfield grid, completes class (iv).
7. Surface on title/stability slides + extend the Claude payload/prompt (§10).
8. **(Parallel, box)** `cin_ml`/`cape_ml` into the `_pbl` stream per the instability TODO →
   expose as a `collapseRisk` flag in the brief (not the onset gate).
9. Calibrate thresholds vs Icon-Race verification (ongoing; all *tune* values).

---

## 12. Sign-off decisions (2026-06-22)

1. **Class boundary** — ✅ **10 kn split + 12 kt roll-off**: 10 kn (100–900 m wind) is the
   type-of-day class boundary; 12 kt (6 m/s) is the steep suppression roll-off inside
   `f_grad`. Both tunable.
2. **Coastline normal θ** — ✅ **auto-derive from the land-sea mask near point 1, with a
   per-venue manual override** when the automatic value is off (complex/indented coasts,
   headlands).
3. **CIN** — ✅ **build inversion gate now from the sounding + `h_mix` (no box dependency);
   `cin_ml`/`cape_ml` added in parallel as a collapse-RISK flag, not the onset gate.** (Revised
   from "wait for cin_ml" once it was clear inversion detection comes from the sounding and CIN
   isn't an onset predictor.)
4. **Funnelling** — ✅ **include now** (build order step 6); completes all four type-of-day classes.
5. **Confidence display** — surface **High/Mod/Low label + σ_TWD + named trigger** as the
   headline (0–10 retained internally / optional).

---

## Key sources

- Sea-breeze detection from model output (SBI): [GMD 2026, sea_breeze v1.1](https://gmd.copernicus.org/articles/19/933/2026/) · [WES 2022](https://wes.copernicus.org/articles/7/815/2022/)
- Sea-breeze review: [Miller et al. 2003, Rev. Geophys.](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2003RG000124)
- Stability/depth control: [Crosman & Horel 2010, BLM](https://link.springer.com/article/10.1007/s10546-010-9517-9)
- Biggs–Graves index: [Biggs & Graves 1962](https://quod.lib.umich.edu/g/glrr/3486415.0001.001) · [Adaricheva et al. 2023](https://arxiv.org/pdf/2309.01803)
- Quadrant Theory: [Houghton card (Yachting Monthly PDF)](https://keyassets.timeincuk.net/inspirewp/live/wp-content/uploads/sites/20/filebank/ym_quadrant.pdf) · peer-reviewed anchor [Steele et al. 2015, QJRMS](https://rmets.onlinelibrary.wiley.com/doi/10.1002/qj.2484) · [PredictWind Marine Met 4](https://help.predictwind.com/en/articles/10449446-marine-meteorology-4-sea-breeze)
- Gradient wind / friction turn: [Sailing World, Bedford](https://www.sailingworld.com/how-to/strategy-unlocking-the-mystery-of-gradient-wind/)
- Confidence/ensemble: [Mylne, RMetS](https://www.rmets.org/metmatters/how-interpret-ensemble-forecast) · [Whitaker & Loughe](https://www.academia.edu/13286028/Verifying_the_Relationship_between_Ensemble_Forecast_Spread_and_Skill) · light-wind σ_dir [Jones 1988, JAM](https://journals.ametsoc.org/view/journals/apme/27/5/1520-0450_1988_027_0550_sdowsa_2_0_co_2.xml)
- Gap winds / Venturi misconception: [US Navy mesoscale primer](https://www.atmos.washington.edu/~cliff/Navygap5.html) · [AMS glossary: Venturi](https://glossary.ametsoc.org/wiki/venturi-effect/)
- Coastal/AC tactics: [Isler, Sailing World](https://www.sailingworld.com/racing/the-role-of-the-modern-americas-cup-weatherman/) · [Doyle coastal primer](https://www.doylesails.com/a-coastal-race-primer/)
