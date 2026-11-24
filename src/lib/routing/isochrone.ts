// Isochrone routing (James 1957; the modified method of Hagiwara 1989).
//
// From the set of points reachable at time t, every point is pushed along a fan
// of headings for one step; the union is the set reachable at t + dt; that set
// is thinned to its outer edge — the isochrone — and the process repeats.
//
// THE LAST-ISOCHRONE PROBLEM, which is the part that decides whether the answer
// can be trusted, and is where naive implementations go wrong:
//
// 1. QUANTISATION. The mark is reached BETWEEN two isochrones. Reporting the
//    time of the first isochrone that contains it overstates the elapsed time by
//    up to one step (30 min on a 30 min step — on a 2-day race that is a 1 %
//    bias, one-signed, larger than most of the differences the study is after).
//    Fix: every step, from EVERY expanded point, `approach()` computes the exact
//    time into the mark's circle (straight, or two legs on the VMG angles when
//    the mark is inside them) and the minimum over all points is the arrival.
//    The search stops only once the front's own time has passed the best
//    arrival, because no later point can improve on it.
// 2. PRUNING NEAR THE MARK. The isochrone is thinned by angular sector from the
//    leg's origin, keeping the point furthest out in each. Far from the origin a
//    sector is miles wide, and the point it keeps is the furthest — not the one
//    nearest the mark — so a naive router discards the very point that would
//    have finished first. Fix: the approach is evaluated on ALL expanded points,
//    before pruning, so pruning can never throw the winner away.
// 3. OVERSHOOT AND FOLDING. Once part of the front has passed the mark, its
//    sectors keep growing outwards in the wrong direction and start to fold
//    back. That is harmless here because those points are only ever candidates
//    for an approach (and the search ends soon after), but it is why the sector
//    count is capped and points behind the previous isochrone are dropped.
//
// MARKS ARE ROUTED LEG BY LEG, AND THAT IS EXACT, not a shortcut. A sailing boat
// can always slow down, so arriving earlier at a point is never worse than
// arriving later (the FIFO property). A mark is a point every route must pass
// through, so the optimal route through it arrives at its earliest possible time
// and the remainder of the race starts from there: the earliest arrival at mark
// k IS the start of leg k+1. (Tack side on arrival is carried across, so the
// rounding manoeuvre is charged.) A GATE — a line, not a point — would break
// this, because then which part of the line you cross matters to the next leg.

import { bearingDeg, distNm, norm180, norm360, type LatLon } from './geo'
import { advance, approach, signedTwa, type Env, type ApproachSeg } from './motion'
import { sampleWind, type WindSample } from './windField'
import type { Course } from './course'

export interface IsochroneOptions {
  /** Time step, minutes. Default 30. */
  stepMin?: number
  /** Heading fan resolution, degrees. Default 5 (plus the exact VMG headings). */
  headingStepDeg?: number
  /** Headings more than this far off the bearing to the mark are not tried. Default 140. */
  fanDeg?: number
  /**
   * Pruning resolution: the width of a sector, in nm, at half the leg's length.
   * Default 0.5. Measured on a 330 nm, 3-leg synthetic course in shifting wind:
   * fixed 1 deg sectors lost 0.8 % of elapsed time (2 % on the 110 nm leg) and
   * got WORSE as the step was refined — more prunes, more loss — while 0.5 nm
   * sat within 0.03 % of 0.25 deg at half its cost. Pruning, not the time step,
   * is what an isochrone router's answer converges on.
   */
  sectorNm?: number
  /** Fixed sector width in degrees, overriding sectorNm. 0 = use sectorNm. */
  sectorDeg?: number
  /** Give up after this many hours on one leg. Default 240. */
  maxLegHours?: number
  /** No heading may turn more than this from the parent's (anti-backtracking, as OpenCPN's MaxSearchAngle). Default 140. */
  maxTurnDeg?: number
  /**
   * 'exact' (default): the arrival is solved from every point (see the header).
   * 'naive': the time of the first isochrone that reaches the mark — kept ONLY so
   * the bias it carries can be measured against the exact answer.
   */
  arrival?: 'exact' | 'naive'
}

export interface PathPoint {
  lat: number; lon: number; t: number
  /** Over the segment that starts here. */
  twa: number; tws: number; bsp: number
  /** Index of the mark this segment is sailing towards. */
  leg: number
}

export interface RouteResult {
  ok: boolean
  reason?: string
  startMs: number
  finishMs: number | null
  elapsedSec: number | null
  legSec: number[]
  path: PathPoint[]
  tacks: number
  gybes: number
  sailedNm: number
}

interface Node {
  lat: number; lon: number; t: number
  side: number          // +1 starboard tack, -1 port, 0 not yet sailing
  parent: number        // index into the node store, -1 at the origin
  twa: number; tws: number; bsp: number   // over the step that ENDED here
  tacks: number; gybes: number
  hdg: number           // heading sailed into this node; NaN at the origin
}

const ws: WindSample = { tws: 0, twd: 0, u: 0, v: 0 }

/** The headings to try from one point: the fan, the four VMG headings, and straight at the mark. */
function headings(env: Env, p: LatLon, t: number, toMark: number, parentHdg: number, o: Required<IsochroneOptions>): number[] {
  if (!sampleWind(env.wind, p.lat, p.lon, t, ws)) return []
  const out: number[] = []
  const ok = (h: number) => Math.abs(norm180(h - toMark)) <= o.fanDeg
    && (!Number.isFinite(parentHdg) || Math.abs(norm180(h - parentHdg)) <= o.maxTurnDeg)
  for (let h = 0; h < 360; h += o.headingStepDeg) if (ok(h)) out.push(h)
  const vm = env.polar.vmg(ws.tws)
  for (const a of [vm.upTwa, -vm.upTwa, vm.dnTwa, -vm.dnTwa]) {
    const h = norm360(ws.twd - a)
    if (ok(h)) out.push(h)
  }
  if (ok(toMark)) out.push(toMark)
  return out
}

interface LegOut {
  ok: boolean; reason?: string
  arriveMs: number; end: LatLon; side: number
  points: { lat: number; lon: number; t: number; twa: number; tws: number; bsp: number }[]
  tacks: number; gybes: number
}

function routeLeg(
  env: Env, from: LatLon, startMs: number, startSide: number,
  mark: LatLon, radiusNm: number, o: Required<IsochroneOptions>,
): LegOut {
  const dtSec = o.stepMin * 60
  const store: Node[] = [{ lat: from.lat, lon: from.lon, t: startMs, side: startSide, parent: -1, twa: 0, tws: 0, bsp: 0, tacks: 0, gybes: 0, hdg: NaN }]
  let front = [0]
  const axis = bearingDeg(from.lat, from.lon, mark.lat, mark.lon)
  const back = bearingDeg(mark.lat, mark.lon, from.lat, from.lon)
  const legNm = distNm(from.lat, from.lon, mark.lat, mark.lon)
  const sectorDeg = o.sectorDeg > 0 ? o.sectorDeg
    : Math.max(0.15, Math.min(2, (o.sectorNm / Math.max(5, legNm / 2)) * 180 / Math.PI))
  const nSec = Math.ceil(360 / sectorDeg)
  // Per sector, the previous isochrone's reach: furthest from the origin in the
  // first half, nearest the mark in the second (Hagiwara's second-half sectors,
  // which keep the front from narrowing to a point as it closes on the mark).
  let prevReach = new Float64Array(nSec)
  let markMode = false

  type Best = { arrive: number; node: number; ap: NonNullable<ReturnType<typeof approach>> }
  // Held in a box: TypeScript narrows a `let` assigned only inside a closure to `never`.
  const box: { best: Best | null } = { best: null }
  const tryFinish = (id: number) => {
    const n = store[id]
    // Nothing further than the boat's top speed can cover in the window is a candidate.
    if (distNm(n.lat, n.lon, mark.lat, mark.lon) - radiusNm > (env.polar.maxBsp * 3 * dtSec) / 3600) return
    const ap = approach(env, n, n.t, n.side, mark, radiusNm, 2 * dtSec)
    if (!ap) return
    const arrive = n.t + ap.sec * 1000
    if (!box.best || arrive < box.best.arrive) box.best = { arrive, node: id, ap }
  }
  tryFinish(0)

  const maxSteps = Math.ceil((o.maxLegHours * 3600) / dtSec)
  let t = startMs
  for (let step = 0; step < maxSteps; step++) {
    if (box.best && t >= box.best.arrive) break
    const base = store.length
    const next: number[] = []
    for (const id of front) {
      const n = store[id]
      const toMark = bearingDeg(n.lat, n.lon, mark.lat, mark.lon)
      for (const h of headings(env, n, n.t, toMark, n.hdg, o)) {
        // The manoeuvre penalty is time NOT sailed in this step.
        let sec = dtSec, tk = 0, gy = 0
        if (!sampleWind(env.wind, n.lat, n.lon, n.t, ws)) continue
        const twa0 = signedTwa(h, ws.twd)
        const side = twa0 >= 0 ? 1 : -1
        if (n.side !== 0 && side !== n.side) {
          if (Math.abs(twa0) < 90) { sec -= env.polar.tackSec; tk = 1 } else { sec -= env.polar.gybeSec; gy = 1 }
        }
        if (sec <= 0) continue
        const leg = advance(env, n, n.t, h, sec)
        if (!leg) continue
        store.push({
          lat: leg.lat, lon: leg.lon, t: n.t + dtSec * 1000, side, parent: id,
          twa: leg.twa, tws: leg.tws, bsp: leg.bsp, tacks: n.tacks + tk, gybes: n.gybes + gy, hdg: h,
        })
        next.push(store.length - 1)
      }
    }
    t += dtSec * 1000
    if (!next.length) break

    if (o.arrival === 'naive') {
      // The first isochrone with any point in the circle, at the isochrone's time.
      for (const id of next) {
        const n = store[id]
        if (distNm(n.lat, n.lon, mark.lat, mark.lon) <= radiusNm && (!box.best || n.t < box.best.arrive)) {
          box.best = { arrive: n.t, node: id, ap: { sec: 0, end: n, segs: [], manoeuvres: { tacks: 0, gybes: 0 }, side: n.side } }
        }
      }
      if (box.best) break
    } else {
      // (1)+(2): the exact arrival, from every point, before anything is pruned.
      for (const id of next) tryFinish(id)
    }

    // Switch to mark-centred sectors once the front is half way.
    if (!markMode) {
      let dMin = Infinity
      for (const id of next) dMin = Math.min(dMin, distNm(store[id].lat, store[id].lon, mark.lat, mark.lon))
      if (dMin < legNm / 2) { markMode = true; prevReach = new Float64Array(nSec).fill(Infinity) }
    }

    // Prune to the outer edge, by sector.
    const keep = new Int32Array(nSec).fill(-1)
    const far = new Float64Array(nSec).fill(markMode ? Infinity : 0)
    for (const id of next) {
      const n = store[id]
      let s: number, r: number
      if (!markMode) {
        r = distNm(from.lat, from.lon, n.lat, n.lon)
        s = Math.min(nSec - 1, Math.floor(norm360(bearingDeg(from.lat, from.lon, n.lat, n.lon) - axis) / sectorDeg))
        // (3): a point inside the previous isochrone is a loop, not progress.
        if (r < prevReach[s] - 1e-3) continue
        if (r > far[s]) { far[s] = r; keep[s] = id }
      } else {
        r = distNm(mark.lat, mark.lon, n.lat, n.lon)
        s = Math.min(nSec - 1, Math.floor(norm360(bearingDeg(mark.lat, mark.lon, n.lat, n.lon) - back) / sectorDeg))
        if (r > prevReach[s] + 1e-3) continue
        if (r < far[s]) { far[s] = r; keep[s] = id }
      }
    }
    front = []
    for (let s = 0; s < nSec; s++) if (keep[s] >= 0) { front.push(keep[s]); prevReach[s] = far[s] }
    // Drop what the pruning discarded. Only the front is ever a parent, and the
    // best arrival so far is the only other node a walk back can start from, so
    // everything else this step made is garbage. Keeping it is ~30 candidates
    // per front point per step: on a 2,200 nm ocean leg that was ~35 million
    // nodes and the heap ran out before the first year finished.
    const survivors = front.map(id => store[id])
    const remap = new Map<number, number>()
    front.forEach((id, k) => remap.set(id, base + k))
    const bb = box.best
    if (bb && bb.node >= base && !remap.has(bb.node)) { remap.set(bb.node, base + survivors.length); survivors.push(store[bb.node]) }
    if (bb && bb.node >= base) bb.node = remap.get(bb.node)!
    store.length = base
    for (const n of survivors) store.push(n)
    front = front.map(id => remap.get(id)!)
    if (!front.length) break
  }

  const b = box.best
  if (!b) return { ok: false, reason: 'mark not reached (wind ran out, or the leg is blocked)', arriveMs: NaN, end: from, side: 0, points: [], tacks: 0, gybes: 0 }

  // Walk back from the finishing node.
  const chain: Node[] = []
  for (let id = b.node; id >= 0; id = store[id].parent) chain.push(store[id])
  chain.reverse()
  const points: LegOut['points'] = []
  for (let i = 0; i < chain.length - 1; i++) {
    const nx = chain[i + 1]
    points.push({ lat: chain[i].lat, lon: chain[i].lon, t: chain[i].t, twa: nx.twa, tws: nx.tws, bsp: nx.bsp })
  }
  for (const s of b.ap.segs as ApproachSeg[]) points.push({ lat: s.lat, lon: s.lon, t: s.t, twa: s.twa, tws: s.tws, bsp: s.bsp })
  const last = chain[chain.length - 1]
  return {
    ok: true, arriveMs: b.arrive, end: b.ap.end, side: b.ap.side, points,
    tacks: last.tacks + b.ap.manoeuvres.tacks, gybes: last.gybes + b.ap.manoeuvres.gybes,
  }
}

const DEFAULTS: Required<IsochroneOptions> = { stepMin: 30, headingStepDeg: 5, fanDeg: 140, sectorNm: 0.5, sectorDeg: 0, maxLegHours: 240, maxTurnDeg: 140, arrival: 'exact' }

/** Route the whole course from `startMs`, mark by mark. */
export function routeIsochrone(env: Env, course: Course, startMs: number, opts: IsochroneOptions = {}): RouteResult {
  const o = { ...DEFAULTS, ...opts }
  return chainLegs(course, startMs, (from, t, side, mark) => routeLeg(env, from, t, side, mark, mark.radiusNm, o))
}

/** Shared by both routers: run the legs in order and stitch the result. */
export function chainLegs(
  course: Course, startMs: number,
  leg: (from: LatLon, t: number, side: number, mark: Course['marks'][number]) => LegOut,
): RouteResult {
  const path: PathPoint[] = []
  const legSec: number[] = []
  let from: LatLon = course.marks[0], t = startMs, side = 0, tacks = 0, gybes = 0
  for (let k = 1; k < course.marks.length; k++) {
    const r = leg(from, t, side, course.marks[k])
    if (!r.ok) {
      return { ok: false, reason: `leg ${k} (to ${course.marks[k].name}): ${r.reason}`, startMs, finishMs: null, elapsedSec: null, legSec, path, tacks, gybes, sailedNm: 0 }
    }
    for (const p of r.points) path.push({ ...p, leg: k })
    legSec.push((r.arriveMs - t) / 1000)
    from = r.end; t = r.arriveMs; side = r.side; tacks += r.tacks; gybes += r.gybes
  }
  const fin = course.marks[course.marks.length - 1]
  path.push({ lat: from.lat, lon: from.lon, t, twa: 0, tws: 0, bsp: 0, leg: course.marks.length - 1 })
  void fin
  let sailed = 0
  for (let i = 1; i < path.length; i++) sailed += distNm(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon)
  return { ok: true, startMs, finishMs: t, elapsedSec: (t - startMs) / 1000, legSec, path, tacks, gybes, sailedNm: sailed }
}

export type { LegOut }
