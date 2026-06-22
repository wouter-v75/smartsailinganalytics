# Multi-level 3D wind field — feasibility + plan

**Status:** feasibility confirmed · **Date:** 2026-06-22
**Verdict:** **Yes — and it's low-risk on our current stack.** The volumetric data already
exists and is already in the browser; the only new piece is rendering glyphs at true
altitude, which works on the MapLibre v3 we already run.

---

## 1. Data — we already have it

The SSA-Race `grid.json` (parsed by `fetchIconRaceField`) stores, per cell:
`cell.spd[height][t]` and `cell.dir[height][t]` across **13 height levels** —
`10, 50, 100, 200, 300, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000 m`
(from `run_icon.sh` `h_levels`, the ICON `hl` stream `u,v,temp,qv,pres`). The 2D field
viewer just picks one height via `cellAtHeight`; **the full vertical stack is already
fetched and sitting in memory.** No new download, no box change for a first version.

Caveat to confirm once: whether those `h_levels` are heights **above sea level** or
**above ground**. Over the race water (terrain ≈ 0) it's moot; over land we add the cell's
terrain elevation to get altitude-above-sea-level for placement. (Open question O1.)

Domain size is small (a coarse grid × 13 levels × hours = a few thousand vectors) — far
below any GPU or memory concern.

---

## 2. Rendering — deck.gl arrows at altitude, on our MapLibre v3

Recommended engine: **deck.gl `SimpleMeshLayer` (instanced arrow mesh) via
`MapboxOverlay({ interleaved: true })`** layered onto the existing MapLibre terrain map.

Why this and not hand-rolled three.js / threebox / Cesium:
- deck.gl treats MapLibre as a first-class base map, **auto-syncs the camera** (pan / zoom /
  rotate / pitch), and **instances thousands of meshes in one draw call** — far less code
  than a three.js custom layer, and it abstracts the projection-matrix churn that keeps
  breaking threebox.
- It places geometry at **`[lng, lat, z]` with z in metres above sea level** — exactly our
  height levels. (deck.gl's documented "z=0 renders at sea level, not snapped to terrain"
  behaviour is precisely what we want for wind-at-altitude.)
- Works on **maplibre-gl v3** (what we run); needs WebGL2 (falls back gracefully).
- Cesium would be marginally better for *true volumetric* particle/streamline advection, but
  means abandoning our MapLibre satellite-style + app integration for a heavier engine — not
  worth it for a small race domain whose value is near-surface vertical shear.

Placement sketch (deck.gl):
```js
import { MapboxOverlay } from '@deck.gl/mapbox'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
// one record per (grid point × level)
const layer = new SimpleMeshLayer({
  id: 'wind3d', data: vectors, mesh: arrowMesh,         // ~20-40 tri arrow, points +x
  getPosition: d => [d.lon, d.lat, d.altM],             // z = metres ASL
  getOrientation: d => [0, -d.dirToward, 0],            // yaw from wind direction
  getScale: d => [d.kn, d.kn, d.kn], sizeScale: 12,
  getColor: d => beaufortRGBA(d.kn), _instanced: true,
})
map.addControl(new MapboxOverlay({ interleaved: true, layers: [layer] }))  // camera sync automatic
```

Version caveat (not blocking): true **terrain occlusion** of custom 3D geometry (arrows
hidden behind a ridge) only works in MapLibre **v5**. On our v3, glyphs can draw "through"
hills. The first visualization is designed so this never matters (arrows float above the
water/terrain — see §3), and a v5 upgrade can add occlusion later.

---

## 3. Visualization — vertical profile-stacks first

The killer view for sailing is **vertical shear**: how the wind turns (veer/back) and changes
speed with height — sea breeze near the surface under a different gradient aloft, the depth
of the breeze, the thermal bend in 3D.

**First build: sparse vertical profile-stacks.** At each point of a coarse ground grid
(e.g. 8×8 over the race box), draw a *column* of arrows/barbs at the levels (10→~2000 m).
Each column is a 3D meteogram — you read the turning + speed change up the column at a
glance. It maps one-to-one onto the sea-breeze-vs-gradient question, stays uncluttered,
instances trivially, and reads correctly on v3 (no terrain-occlusion dependency).

Sequenced roadmap:
1. **Profile-stacks** (this build) — coarse grid of vertical arrow/barb columns; level &
   density controls; share the existing time bar.
2. **Vertical cross-section "curtain"** — a draggable transect plane through the domain
   showing wind (and later temperature/inversion) on a vertical slice — ideal for the
   sea-breeze front / return-flow structure.
3. **Per-level horizontal sheets** with a level selector (secondary mode).
4. **3D streamlines / GPU particles** — later visual flourish (best on a v5 upgrade or Cesium).

Readability target: a few hundred glyphs visible at once (well below the GPU ceiling) — the
real limit is visual clutter, which the sparse-grid profile-stack design controls.

---

## 4. Build plan (first version)

1. Add deck.gl deps: `@deck.gl/core @deck.gl/mapbox @deck.gl/mesh-layers` (and a small
   arrow/barb mesh — generate procedurally or a tiny glTF).
2. Extend `Field3D` (and the shared `field3dUtils`): a `buildProfileStacks(field, frameIdx,
   {gridStep, levels})` that walks the SSA-Race multi-height cells → `[{lon,lat,altM,kn,
   dirToward,band}]`, sub-sampling the grid and choosing a sensible level subset.
3. Mount a `MapboxOverlay({interleaved:true})` with a `SimpleMeshLayer`; update its data on
   time-bar (`frameIdx`) change. Reuse the upwind-orient + rotate/tilt controls.
4. UI: a "Levels" multi-select (or a low/mid/high preset), grid-density control, and a
   wind/profile toggle alongside the existing 2D/3D toggle. Gate to SSA-Race models (only
   they carry the vertical stack); fall back to the flat single-level arrows for others.
5. (Deck) optional: capture a profile-stack still for a "Vertical structure" slide.

Only available for SSA-Race fields (ICONRACE / ICONRACE_1KM); Open-Meteo models stay on the
flat single-level view.

---

## 5. Open questions

- **O1.** Are the published `h_levels` above sea level or above ground? (Determines whether we
  add terrain elevation per cell. Moot over the race water.)
- **O2.** Glyph style: 3D arrows (length∝speed, colour∝Beaufort) vs true wind **barbs**
  extruded in 3D (matches the sounding). Arrows read better in perspective; barbs are more
  "meteorological". Recommend arrows first.
- **O3.** Level subset for the stacks — all 13 is busy; a default of ~7 (10,100,300,600,1000,
  1500,2000 m) with a control to change it.
- **O4.** Add deck.gl as a dependency (≈ acceptable bundle add, lazy-loaded with the 3D view)
  — confirm OK.

---

## Key sources
- [deck.gl × MapLibre (interleaved, camera sync)](https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre)
- [@deck.gl/mapbox overview — altitude/terrain limitation](https://deck.gl/docs/api-reference/mapbox/overview)
- [SimpleMeshLayer](https://deck.gl/docs/api-reference/mesh-layers/simple-mesh-layer)
- [MapLibre 3D-models-on-terrain example](https://maplibre.org/maplibre-gl-js/docs/examples/adding-3d-models-using-threejs-on-terrain/) · [MercatorCoordinate](https://maplibre.org/maplibre-gl-js/docs/API/classes/MercatorCoordinate/)
- [MapLibre terrain depth for custom layers = v5 only](https://github.com/maplibre/maplibre-gl-js/discussions/4892)
- [Cesium GPU wind particles (volumetric reference)](https://cesium.com/blog/2019/04/29/gpu-powered-wind/)
