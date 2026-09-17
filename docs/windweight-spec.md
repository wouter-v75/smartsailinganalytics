# Windweight — automated hourly "wind weight" index for the racing window

**Status:** proposal / spec v0.2 · 2026-06-26 · _v0.2: profile factor = ratio vs standard log profile (§3.3); rig-band vertical-resolution note (§4.1); heel-vs-target as primary calibration label (§6)_
**Owner:** Wouter
**Related:** `racing-forecast-diagnostics-spec.md` (sea-breeze, stability-from-sounding), `multi-level-3d-windfield-spec.md`, hpbl work, funnelling field (1 km), SST-per-venue (planned), `sailscan-training-data-architecture.md` (the conditions↔outcome moat), Expedition raw-log channels (loads), rig-tune + design-shape data.

---

## 1. The problem

The same masthead TWS does **not** produce the same boat. On one 16-knot day the boat is fully powered, struggling to hold the rig down, calling for the heavier jib and maximum depower; on another 16-knot day it is soft and greasy, needs the full-power sail, more twist, and won't load up. Crews call this difference **wind weight** (or "pressure"): how much aerodynamic *load* the air actually delivers for the wind speed shown on the instrument.

This variation is also our single biggest nuisance in **data-analysis**. Because windweight is not captured by TWS alone, the same nominal wind maps to different sail shapes, loads, targets and modes — which smears every conditions→outcome relationship we try to learn from the logs. An automated, physically-grounded **windweight % per hour** does two jobs:

1. **Forecasting / on-water decisions** — tells the team, ahead of time, whether a given forecast TWS will feel light, standard or heavy, informing sail crossovers, target mode, rig tune and crew positioning.
2. **A normalising covariate** — a scalar we can join onto every logged sample so that "same TWS" finally means "same conditions," and the conditions→outcome models stop being confounded.

The user's intuition is correct and is the right set of first-order drivers: **(a) the vertical TWS profile, (b) the sea-to-air temperature difference (stability), and (c) funnelling**, with **air density** a smaller, fairly consistent Med-summer term. The rest of this document turns that intuition into a defensible formula, ties each term to data we already produce, and proposes a phased build with a calibration path against our own boat logs.

---

## 2. The physics: what "weight" actually is

The aerodynamic force on a sail is

```
F  =  q · A · C        with     q = ½ · ρ · V²
```

`q` is **dynamic pressure**, `ρ` air density, `V` the flow speed, `A` sail area, `C` a force coefficient. Force scales with the *square* of the wind speed and *linearly* with air density. "Wind weight" is, to first order, just **the dynamic pressure the rig sees** — but three things make it diverge from the naïve `½ρV²` you'd compute from the masthead number:

### 2.1 Air density — `ρ` (the smaller, steady term)
Cold, dry, high-pressure air is denser and therefore heavier for the *same* speed. At ISA sea level (15 °C, 1013.25 hPa) `ρ = 1.225 kg/m³`. Moist air is *lighter*, not heavier — water vapour (molar mass 18) displaces dry air (≈29), so humid air at fixed T and p is ≈0.6× as dense per unit of vapour partial pressure. Across a Med summer the swing is modest (≈ ±2–3 %), exactly as expected: warm (≈27 °C), often humid air sits near `ρ ≈ 1.16–1.18`, while a cool post-frontal airmass can reach `ρ ≈ 1.21–1.22`. Small, but free to compute and worth removing as a known bias.

### 2.2 The vertical profile — the rig sees a *column*, not a point
The anemometer reads one height (our masthead, ≈34 m). The sails span from the deck to the masthead, and the wind changes with height. What matters is the **rig-integrated** dynamic pressure, weighted by where the sail area actually is. The shape of `V(z)` is set by boundary-layer **stability**:

- **Stable** (warm air over cooler sea; classic Med afternoon sea-breeze over still-cool water, or warm continental advection): vertical mixing is suppressed, momentum aloft is *decoupled* from the surface. The profile is **strongly sheared** — big difference between masthead and deck. For a given **masthead** reading the lower rig is starved, so the rig-average pressure is **lower → feels light/soft**, and you need more twist to match the gradient.
- **Unstable / convective** (cool air over warm sea; post-frontal, autumn, morning offshore over warm water): surface heating drives convection that mixes high-momentum air down. The profile is **nearly uniform** with height (low shear) **and gusty**. For the same masthead reading the whole rig is loaded → **feels heavy/punchy**.

Over open water the **power-law exponent** `α` in `V(z) = V_ref (z/z_ref)^α` runs from ≈**0.11** (neutral) down to ≈**0.06–0.08** (unstable) and up to ≈**0.16–0.25** (stable); IEC's offshore "normal" value is 0.14. Measured near-surface wind over the sea varies by **~10 %** with the air–sea temperature difference *even in strong winds* — i.e. stability is a first-order control on the profile, not a fair-weather curiosity.

### 2.3 Gusts / dynamic loading — momentum delivery
Steady-state `q` understates the load in gusty air because peak loads, not means, break things and change how the boat is sailed. **Gust factor** `G = U_gust/U_mean ≈ 1 + k·TI`, where turbulence intensity `TI = σ_u/U`. `TI` is **high in unstable/convective** conditions (≈0.15–0.22 over water) and **low in stable** ones (≈0.05). So the same stability that flattens the profile *also* makes the air gusty — both pushing "unstable = heavy." Sails respond partially to gusts (they don't fully load the peak), so we apply a *tunable fraction* of `G²`.

### 2.4 Funnelling — sub-grid acceleration and shear
Where flow is channelled between terrain (straits, headlands, valley exits — Bonifacio, mistral/levant corridors, thermal funnels along a coast) it accelerates (Bernoulli/Venturi) and is typically **gustier** with its own shear layers. If our 1 km grid already resolves the acceleration, the speed is *already in* `V` and must **not** be double-counted; funnelling then contributes mainly an **extra gust/turbulence** term and a flag for sub-grid acceleration the coarse field misses. (Gap flows are also famously non-linear — strongest at the exit, not mid-gap — so a raw venturi multiplier would mislead; we lean on the resolved field plus a correction.)

---

## 3. The model

### 3.1 Definition
Anchor everything to **masthead TWS** `V_H` (`H ≈ 34 m`) because that is what the boat logs (Expedition), what our sail crossovers and targets are built against, and the natural top of the rig integration. (For pure forecasting, lift the model 10 m wind to masthead with the same profile; on-water, use the logged masthead value.)

Rig-area-weighted **effective dynamic pressure**:

```
q_eff = ( 1 / Ā ) · ∫₀ᴴ a(z) · ½ ρ · [ V(z) · G(z) ]²  dz ,     Ā = ∫₀ᴴ a(z) dz
```

**Reference** (a "standard day" — standard density, this masthead speed, a neutral profile, no gust enhancement):

```
q_ref = ½ · ρ_ref · V_H² · S_ref ,     S_ref = (1/Ā) ∫₀ᴴ a(z) (V_log(z)/V_H)² dz
                                        V_log(z) = V_H · ln(z/z0)/ln(H/z0)  (neutral log profile, z0 ≈ 2e-4 m, ρ_ref = 1.20)
```

**Windweight index** (100 = standard day):

```
WW%  =  100 · q_eff / q_ref
```

and the intuitive companion, **effective TWS** — the standard-day wind speed that would give the same rig load:

```
V_eff  =  V_H · √( WW% / 100 )           e.g. "21 kt on the dial, weighs like 23."
```

### 3.2 Transparent decomposition
`WW%` factorises into four ~1.0 multipliers so the crew sees *why* a day is heavy, not just a black-box number:

```
WW%  ≈  100 · f_ρ · f_profile · f_gust · f_funnel
```

| Factor | Meaning | Driver | Typical range |
|---|---|---|---|
| `f_ρ = ρ / ρ_ref` | air density | 2 m T, RH/Td, MSLP | 0.97 – 1.02 |
| `f_profile = S_act / S_ref` | rig fullness vs masthead, `S = (1/Ā)∫a(z)(V(z)/V_H)² dz` | stability → `α` (or direct profile) | 0.85 – 1.05 |
| `f_gust = ⟨G²⟩_eff` (fraction applied) | dynamic / peak loading | `TI` from stability, hpbl, TKE | 1.00 – 1.10 |
| `f_funnel` | sub-grid acceleration + extra gust | 1 km funnelling field | 1.00 – 1.08 |

Net swing of roughly **0.8 – 1.2** → a believable **±20 %** of weight at constant masthead TWS, i.e. up to ~2–3 "effective knots" either way at 20 kt. That is exactly the magnitude crews argue about.

### 3.3 Parameterisations

**Density (Phase 0 — compute today).** Moist-air density from 2 m temperature, humidity and sea-level pressure:

```
es(T)  = 6.112 · exp( 17.67·T / (T + 243.5) )      [hPa, T in °C]   (Magnus)
e      = RH · es(T)            (or es(Td) if dewpoint given)
ρ      = ( (p − e)·100 ) / (R_d·T_K)  +  ( e·100 ) / (R_v·T_K)
         R_d = 287.05,  R_v = 461.5,  T_K = T + 273.15,  p,e in hPa
```

**Profile — compare the forecast profile against a standard log profile.** The cleanest, most decision-useful formulation of `f_profile` is a direct **ratio of the forecast rig-integrated `q` to that of a neutral, standard-atmosphere log profile anchored at the same masthead speed**. This needs *no* `α` assumption and *no* stability table on the critical path — stability is already baked into the modelled profile.

- **Reference (standard log profile):** neutral surface-layer log law over open water,
  `V_log(z) = V_H · ln(z/z0) / ln(H/z0)`, with `z0 ≈ 2×10⁻⁴ m` (open sea; or a Charnock-based roughness). This is the "standard day" the index is measured against.
- **Actual:** the **modelled low-level wind profile** `V(z)` we already publish — the `_pbl` stream / SSA-Race sounding gives wind on the lowest model levels, which is the rig band. Reuse the existing **Lagrange-in-log-height fit** (already used for mast speed) to resample `V(z)` onto the integration grid.
- **Factor:**

  ```
  f_profile = S_act / S_ref ,   S = (1/Ā) ∫₀ᴴ a(z) (V(z)/V_H)² dz
  ```

  with `S_ref` computed from `V_log`. `f_profile > 1` ⇒ the forecast column is *fuller than standard* (low-shear/unstable, heavy); `< 1` ⇒ *more sheared than standard* (stable, light/soft). *Fallback* where only coarse data exists: power law `V(z)=V_H(z/H)^α` with `α` from stability (table below).

**Stability → α and TI.** Use the **bulk air–sea temperature difference** `ΔT = T_air(2 m) − SST` (and, where available, a bulk Richardson number from the sounding — we already compute stability-from-sounding for the sea-breeze diagnostics). Suggested smooth map (calibrate later):

| Regime | `ΔT = T_air − SST` | `α` | `TI` | Feel |
|---|---|---|---|---|
| Strongly unstable | `< −2 °C` | 0.06–0.08 | 0.15–0.22 | heavy, punchy, gusty |
| Neutral | `−0.5 … +0.5` | 0.11 | 0.10 | standard |
| Stable | `+1 … +3 °C` | 0.16–0.22 | 0.06–0.08 | soft, sheared, twisty |
| Strongly stable | `> +3 °C` | 0.22–0.28 | 0.04–0.06 | very light feel, big gradient |

`G = 1 + k·TI` with `k ≈ 2.5` (peak/mean over ~3 s gusts); apply a response fraction `β` (≈0.4–0.7, tunable) so `f_gust = 1 + β·(G² − 1)`. Where the model exposes **TKE** or we have hpbl/CIN, prefer those over the `ΔT→TI` table.

**Funnelling.** Read the existing **1 km funnelling index**. If the 1 km wind already shows the acceleration, set `f_funnel = 1 + γ·(funnel_index)` acting *only* on the gust/turbulence channel (channelled flow is gustier); add a separate sub-grid speed correction *only* where we know the grid under-resolves a gap. Default `γ` small; calibrate.

**Sail-area weighting `a(z)`.** The rig is not uniform — most area is low. Use a default centroid at ≈35–40 % of luff height (triangular-ish main + jib). Because the **jib is shorter than the main**, integrate each sail over **its own** height band → optionally emit a **per-sail** windweight (the main and a low J3 do not feel the same column). This dovetails with the design-shape work: the grey design target already varies with TWS; windweight explains part of the *residual* between design and measured.

---

## 4. Inputs — all but one already exist

| Term | Field | Source in our stack | Status |
|---|---|---|---|
| `ρ` | 2 m T, RH/Td, MSLP | ICON surface fields | ✅ available |
| `V(z)` profile | wind on low levels 10–200 m | `_pbl` stream / SSA-Race sounding | ✅ available |
| stability `ΔT` | `T_air(2 m) − SST` | 2 m T ✅; **SST per venue** | ⚠️ SST publish is the one open box-side task |
| `Ri` / inversion | sounding-derived stability | racing-forecast-diagnostics | ✅ available |
| `TI` / gust | TKE or hpbl/CIN proxy | hpbl ✅, TKE if streamed | ✅/⚠️ |
| funnelling | 1 km funnelling index | existing field | ✅ available |
| validation labels | **heel vs heel-target (upwind, primary)**, forestay/rake/loads, depower, BSP-vs-target, sail changes | Expedition raw-log + targets + rig-tune + sailscan | ✅ parsed |

The **only new upstream dependency is publishing SST per venue** (already on the board for the ΔT/sea-breeze work). Everything else is a post-process over fields we already generate.

### 4.1 Vertical resolution — current state and what to add

The profile factor is only as good as the vertical sampling **inside the rig band (0–34 m)**. Two distinct things to keep separate:

- **Native model levels (`num_lev`)** — set in the box-side ICON namelist (`run_icon.sh` / run config), **not in this repo**, so confirm the current value on the box. ICON-LAM typically runs ~60–80 terrain-following levels; for windweight what matters is the **near-surface spacing** (the SLEVE stretching / `min_lay_thckn`), i.e. how many *native* levels fall below ~100 m. Raising near-surface resolution there is the real "higher resolution would help" lever, but it is a model-rerun change with a cost.
- **Published diagnostic heights (`h_levels`)** — what we actually post-process. Today `run_icon.sh` emits **13 fixed heights**: `10, 50, 100, 200, 300, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000 m`. **Within the 0–34 m rig, only the 10 m level sits inside it and the next is 50 m (above the masthead)** — so the rig profile is currently pinned by essentially *one* point plus the masthead inference. The current mast-speed estimate is a Lagrange fit in log-height through the 3 nearest levels (10/50/100 m).

**Cheap, high-value change (independent of `num_lev`):** add diagnostic output heights in the rig band to the `h_levels` list — e.g. **`5, 15, 25, 34 m`** — so the published profile resolves the column the sails actually live in. These are interpolated from the existing native levels at publish time (a one-line `h_levels` edit + a re-run), giving the windweight integral real points to fit instead of extrapolating from 10 m.

**Adding native PBL levels (the real resolution lever).** Refining the *native* grid below 100 m is worth it and is sound on our HEVI core, but has rules — see the companion note **`icon-vertical-levels-pbl.md`**. In short: raise `num_lev` (~80–90) and shape the low-level SLEVE stretch (smaller `stretch_fac`, moderate `max_lay_thckn`) to land ~8–10 full levels below 100 m; **keep the first full level ≳10 m** (ICON's Monin-Obukhov surface layer is invalid in the roughness sublayer — do *not* chase AROME's 5 m); thin near-surface layers are **free on the acoustic CFL** (vertical-implicit), so `dtime` stays at the proven **6 s**, with the only watch-item being convective vertical-advection CFL on a full-day test; re-run parent→nest. Do the `h_levels` change first; promote native refinement as a tested experiment.

---

## 5. Output for the racing window

For each venue, produce an **hourly** series across the racing window (e.g. 10:00–18:00 local):

- **WW%** and **V_eff** (effective TWS) — the headline.
- The **four sub-factors** (density, profile/`α`, gust, funnel) so the number is interpretable.
- A one-word **class**: `Light` (<92), `Standard` (92–108), `Heavy` (>108), plus the trend through the window.
- A short rationale string for the deck and the Claude exec-summary brief, e.g. *"Heavy (113 %): cool post-frontal air over warm sea — low shear, gusty (TI 0.18), +2 effective kt; expect to depower early and favour the heavier jib a knot below its usual crossover."*

Surfacing: a row/strip in the forecast deck and the wind-field viewer time-series; an extra line in the Claude deck-brief payload; and — most importantly for analysis — a stored hourly `windweight` column joined onto every logged sample.

---

## 6. Calibration & validation (closing the loop with our own data)

This is where windweight earns its keep.

**Primary post-processing variable — heel vs heel-target, upwind.** The cleanest single signal we already have is the **upwind heel residual**: `Δheel = heel − targHeel`. Both channels are already in the parsed Expedition raw log (`expLogParse.ts`: `heel` and `targHeel` ← the boat's `TargHeel` channel; `vs_targ_pct` is there too as a corroborating BSP-vs-target signal). Heel is, to first order, a direct read-out of the heeling moment, i.e. of the dynamic pressure on the rig — so at a *fixed* masthead TWS, a boat heeling **above** its target is being given more weight than the number implies, and **below** target, less. `Δheel` is therefore the natural label to regress windweight against, and it is convenient: it needs no extra modelling (the boat computes `targHeel` live), it is continuous (no sail-change discretisation), and it is available on **every upwind second** rather than only at scan times. (Filter to upwind: `|TWA| < ~55°`, steady-state — exclude tacks/manoeuvres.)

Acceptance test: `WW%` should be **monotonic in `Δheel`** at constant TWS, and adding `WW%` to a `Δheel ~ f(TWS)` model should cut the residual variance. Use the slope of `Δheel` vs `WW%` to *set the gain* of the index (so "+10 % windweight" maps to a real, measured degrees-of-extra-heel).

**Secondary / corroborating labels** (already parsed):

- **Forestay (rake) / jib-tack / cunningham / backstay-traveller** loads from the Expedition raw log — depower effort.
- **Target-vs-actual BSP** (polars) and **mode** (height vs speed).
- **Sail crossover transitions** and **measured-vs-design shape residuals** (SailScan + design overlay).

Procedure: at **constant masthead TWS bins**, regress these power proxies against `WW%`, with **`Δheel` upwind as the headline**. A good index *explains the residual variance that TWS alone leaves* — on high-WW% hours we expect, at the same TWS: more heel above target, more forestay load and earlier depower, the heavier sail chosen below its nominal crossover, flatter/more-twisted measured shapes. Tune the open constants (`z0`/`α`-map, `k`, `β`, `γ`, `ρ_ref`, `a(z)` centroid) to maximise the explained residual. Report the **R²-gain ("TWS alone" vs "TWS + WW")** on `Δheel` as the acceptance metric.

---

## 7. Phased build

- **Phase 0 — Density only.** `f_ρ` from 2 m T/RH/MSLP. Trivial, immediate, removes a known bias; ship as the first `windweight` column. *(hours)*
- **Phase 1 — Profile.** Integrate the `_pbl`/sounding `V(z)` with `a(z)`; add `α`-from-`ΔT` fallback. Needs **SST per venue** published. This is the big mover. *(depends on SST task)*
- **Phase 2 — Gust.** `TI`/`G` from stability + hpbl/TKE; add `f_gust`. *(small)*
- **Phase 3 — Funnel + per-sail + surfacing.** Wire the 1 km funnelling index; optional per-sail WW; add WW%/V_eff to the deck, the viewer time-series, the Claude brief, and the stored covariate. *(medium)*
- **Phase 4 — Calibrate.** Regress against logged loads/shapes/targets; tune constants; publish acceptance R²-gain and lock v1. *(ongoing, data-gated)*

A natural home for the computation is the box-side publish step alongside hpbl/funnelling (one extra 2D/time-series product per venue), with the app reading it like the other forecast layers and the analysis pipeline joining the hourly value onto samples.

---

## 8. Open questions / decisions

1. **Reference anchor** — masthead (recommended, matches the instrument and crossovers) vs 10 m (matches raw model). Pick one and keep it everywhere; this doc assumes masthead.
2. **`ρ_ref` and `S_ref`** — fix to a Med-summer "standard day" (proposed `ρ_ref = 1.20`, `α_n = 0.11`) so WW% reads as deviation from *our* normal, not ISA.
3. **One number vs per-sail** — start with a single rig WW%; add per-sail once the main-vs-jib difference proves it earns the complexity.
4. **Gust response fraction `β`** — how much of `G²` the sails actually feel; pure calibration parameter.
5. **Funnelling double-count** — confirm whether the 1 km wind already contains the venturi acceleration before applying any speed multiplier (it almost certainly does; default to gust-only).

---

### Appendix A — worked sketch (illustrative numbers)

20 kt masthead, two days:

- **Day A (stable sea-breeze):** warm air over cool sea, `ΔT=+2`, `α≈0.20`, `TI≈0.07`, `ρ=1.17`. Profile starves the lower rig → `f_profile≈0.90`; `f_gust≈1.01`; `f_ρ≈0.975`. **WW ≈ 89 %**, `V_eff ≈ 18.9 kt` → *light/soft, twist on, full-power sail.*
- **Day B (post-frontal):** cool air over warm sea, `ΔT=−2.5`, `α≈0.07`, `TI≈0.18`, `ρ=1.21`. Uniform, gusty column → `f_profile≈1.03`; `f_gust≈1.06`; `f_ρ≈1.008`. **WW ≈ 110 %**, `V_eff ≈ 21.0 kt` → *heavy/punchy, depower early, heavier jib.*

Same dial reading, ~2 effective knots apart — and now a number to forecast it and a covariate to clean the analysis.
