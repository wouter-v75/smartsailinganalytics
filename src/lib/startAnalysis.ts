// src/lib/startAnalysis.ts
// ─────────────────────────────────────────────────────────────────────────────
// The KND "Starts" tab: for every start gun in the event file, the run-in to the line
// as a table of 5 s rows (time to gun, event, distance to line, BSP_trg%, TWA,
// ΔTwaTrg, VMG%, BSP, rudder, burn, TWD, TWS), what the boat had at the gun and 30 s
// later, and the track against the start line.
//
// Channels, checked against KND's readout for 11 Sep Race 5 at −5:00 (BSP 16.52,
// BSP_trg% 87.8, TWA −119.5, ΔTwaTrg −28.7, VMG% 50.8, RUDDER 7.1):
//   DistLn  ← DST_LINE, in boat lengths (0 = Expedition has no line: no value)
//   BSP_trg% ← vsTargPct · ΔTwaTrg = |TWA| − target TWA · Burn ← Burn (+ early, − late)
//   VMG%    ← |VMG| against the polar's best upwind / downwind VMG for the TWS
//   Rudder  ← tack-relative, as in the phase stats (stbd: port rudder, port: −stbd rudder)
//
// The cloud copy of a log keeps a row every ~6 s, so the 5 s rows are interpolated —
// never across a gap over 15 s, and angles never through head-to-wind or a gybe. Its
// positions are rounded to ~1 km, which is too coarse for a track against the line.
// ─────────────────────────────────────────────────────────────────────────────

import { activeSailsAt } from './scanEnrich'
import { sailComboLabel } from './phaseStats'
import { polarVMGTarget } from './polarCalc'

export const START_FROM_S = -300
export const START_TO_S = 60
export const START_STEP_S = 5
const MAX_GAP_MS = 15_000
const NEAR_MS = 3_000

type Row = { utc: number; [key: string]: unknown }
export type ValueKind = 'lin' | 'twa' | 'deg360'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const rad = (d: number) => (d * Math.PI) / 180

// Rows bracketing utc (rows sorted by utc); [-1, -1] outside the log.
function bracket(rows: Row[], utc: number): [number, number] {
  if (!rows.length || utc < rows[0].utc || utc > rows[rows.length - 1].utc) return [-1, -1]
  let lo = 0, hi = rows.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (rows[mid].utc <= utc) lo = mid
    else hi = mid
  }
  return [lo, hi]
}

// A channel's value at utc, interpolated between the nearest rows either side that have one.
// A row without the value (a dropped sample, or Expedition's 0 for "no line") is looked past,
// so one missing row in the ~6 s cloud copy doesn't blank the 5 s samples around it — but never
// across a stretch longer than MAX_GAP_MS.
export function valueAt(rows: Row[], utc: number, key: string, kind: ValueKind = 'lin', zeroIsNull = false): number | null {
  const [i, j] = bracket(rows, utc)
  if (i < 0) return null
  if (rows[j].utc - rows[i].utc > MAX_GAP_MS) return null
  const get = (r: Row) => { const v = num(r[key]); return zeroIsNull && v === 0 ? null : v }
  let ia = i
  while (ia >= 0 && get(rows[ia]) == null && utc - rows[ia].utc <= MAX_GAP_MS) ia--
  let ib = j
  while (ib < rows.length && get(rows[ib]) == null && rows[ib].utc - utc <= MAX_GAP_MS) ib++
  const a = ia >= 0 && get(rows[ia]) != null ? rows[ia] : null
  const b = ib < rows.length && get(rows[ib]) != null ? rows[ib] : null
  if (!a || !b || a === b || b.utc - a.utc > MAX_GAP_MS) {
    // Only one side has a value (or both are the same row): use it when it is close enough to
    // stand for this moment.
    const near = [a, b]
      .filter((r): r is Row => r != null && Math.abs(r.utc - utc) <= NEAR_MS)
      .sort((x, y) => Math.abs(x.utc - utc) - Math.abs(y.utc - utc))
    return near.length ? get(near[0]) : null
  }
  const va = get(a) as number, vb = get(b) as number
  const f = (utc - a.utc) / (b.utc - a.utc)
  if (kind === 'deg360') {
    const d = ((vb - va + 540) % 360) - 180
    return (va + d * f + 360) % 360
  }
  // TWA through a tack or gybe jumps sign: the in-between value would be a wind angle never sailed.
  if (kind === 'twa' && Math.abs(vb - va) > 90) return f < 0.5 ? va : vb
  return va + (vb - va) * f
}

export interface StartSample {
  t: number               // seconds to the gun (negative before it)
  utc: number
  event: string           // 'gun', 'tack', 'gybe' or ''
  distLn: number | null   // boat lengths
  bspTrgPct: number | null
  twa: number | null
  dTwaTrg: number | null
  vmgPct: number | null
  bsp: number | null
  rudder: number | null
  burn: number | null     // s: + early (time to burn), − late
  twd: number | null
  tws: number | null
  lat: number | null
  lon: number | null
}

export interface TrackPoint { t: number; along: number; over: number }   // metres: along the line from the pin; over = towards the course side

export interface StartAnalysis {
  raceNum: number
  gunUtc: number
  sails: string
  twsAtGun: number | null   // mean of the last minute
  twdAtGun: number | null
  samples: StartSample[]
  atGun: StartSample | null
  plus30: StartSample | null
  line: { lengthM: number; gunAlongPct: number | null } | null
  track: TrackPoint[] | null
  trackNote: string | null
  rowSpacingS: number | null
}

function circularMean(deg: number[]): number | null {
  if (!deg.length) return null
  const s = deg.reduce((a, d) => a + Math.sin(rad(d)), 0), c = deg.reduce((a, d) => a + Math.cos(rad(d)), 0)
  return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function startAnalyses(rows: Row[] | null | undefined, xml: any, polar: any = null): StartAnalysis[] {
  const guns = ((xml?.raceGuns || []) as { utc: number; raceNum: number }[])
    .filter(g => Number.isFinite(g?.utc)).sort((a, b) => a.utc - b.utc)
  if (!rows?.length || !guns.length) return []
  const manoeuvres = ((xml?.tackJibes || []) as { utc: number; isTack?: boolean; isValid?: boolean }[]).filter(m => m.isValid !== false && Number.isFinite(m.utc))

  return guns.map(gun => {
    const samples: StartSample[] = []
    for (let t = START_FROM_S; t <= START_TO_S; t += START_STEP_S) {
      const utc = gun.utc + t * 1000
      const at = (key: string, kind: ValueKind = 'lin', zeroIsNull = false) => valueAt(rows, utc, key, kind, zeroIsNull)
      const twa = at('twa', 'twa'), tws = at('tws'), vmg = at('vmg'), twaTarg = at('twaTarg')
      const tack = twa == null ? null : twa >= 0 ? 'stbd' : 'port'
      const ruddS = at('ruddS')
      const rudder = at('rudder') ?? (tack === 'stbd' ? at('ruddP') : tack === 'port' && ruddS != null ? -ruddS : null)
      let vmgPct: number | null = null
      if (polar && vmg != null && tws != null && twa != null) {
        const tg = polarVMGTarget(polar, tws)
        const target = Math.abs(twa) < 90 ? tg.upVMG : tg.downVMG
        if (target > 0.5) vmgPct = (100 * Math.abs(vmg)) / target
      }
      const events = manoeuvres.filter(m => m.utc >= utc - 2500 && m.utc < utc + 2500).map(m => (m.isTack ? 'tack' : 'gybe'))
      samples.push({
        t, utc,
        event: [t === 0 ? 'gun' : '', ...events].filter(Boolean).join(' · '),
        distLn: at('dstLine', 'lin', true),
        bspTrgPct: at('vsTargPct'),
        twa,
        dTwaTrg: twa != null && twaTarg != null ? Math.abs(twa) - twaTarg : null,
        vmgPct,
        bsp: at('bsp'),
        rudder,
        burn: at('tmLine'),
        twd: at('twd', 'deg360'),
        tws,
        lat: at('lat'),
        lon: at('lon'),
      })
    }
    const lastMinute = samples.filter(s => s.t >= -60 && s.t <= 0)
    const twsAtGun = lastMinute.some(s => s.tws != null) ? lastMinute.filter(s => s.tws != null).reduce((a, s) => a + (s.tws as number), 0) / lastMinute.filter(s => s.tws != null).length : null
    const twdAtGun = circularMean(lastMinute.map(s => s.twd).filter((v): v is number => v != null))
    const atGun = samples.find(s => s.t === 0) || null
    const plus30 = samples.find(s => s.t === 30) || null

    const windowRows = rows.filter(r => r.utc >= gun.utc + START_FROM_S * 1000 && r.utc <= gun.utc + START_TO_S * 1000)
    const rowSpacingS = median(windowRows.slice(1).map((r, i) => (r.utc - windowRows[i].utc) / 1000).filter(d => d > 0))

    // ── The start line and the track against it ─────────────────────────────
    const lines = (xml?.startLines || []) as { raceNum: number; pin?: { lat: number; lon: number }; boat?: { lat: number; lon: number } }[]
    const sl = lines.find(l => l.raceNum === gun.raceNum) || (lines.length === 1 ? lines[0] : null)
    let line: StartAnalysis['line'] = null
    let track: TrackPoint[] | null = null
    let trackNote: string | null = null
    const rounded = windowRows.length > 3 && windowRows.every(r => {
      const lat = num(r.lat), lon = num(r.lon)
      return lat == null || lon == null || (Math.abs(lat * 100 - Math.round(lat * 100)) < 1e-6 && Math.abs(lon * 100 - Math.round(lon * 100)) < 1e-6)
    })
    if (!sl?.pin || !sl?.boat) {
      trackNote = 'No start line (pin and committee boat) in the event file for this race.'
    } else {
      const mLat = 110_574, mLon = 111_320 * Math.cos(rad(sl.pin.lat))
      const xy = (lat: number, lon: number) => ({ x: (lon - sl.pin!.lon) * mLon, y: (lat - sl.pin!.lat) * mLat })
      const b = xy(sl.boat.lat, sl.boat.lon)
      const lengthM = Math.hypot(b.x, b.y)
      if (lengthM > 1) {
        const u = { x: b.x / lengthM, y: b.y / lengthM }
        let n = { x: -u.y, y: u.x }
        // The course side is to windward: TWD is where the wind comes FROM.
        if (twdAtGun != null && n.x * Math.sin(rad(twdAtGun)) + n.y * Math.cos(rad(twdAtGun)) < 0) n = { x: -n.x, y: -n.y }
        const project = (s: StartSample) => {
          const p = xy(s.lat as number, s.lon as number)
          return { along: p.x * u.x + p.y * u.y, over: p.x * n.x + p.y * n.y }
        }
        const gunPos = atGun?.lat != null && atGun?.lon != null && !rounded ? project(atGun) : null
        line = { lengthM, gunAlongPct: gunPos ? (100 * gunPos.along) / lengthM : null }
        if (rounded) {
          trackNote = 'Positions in the cloud copy of the log are rounded to about 1 km — the track needs the full log (open the day on the device that imported it).'
        } else {
          track = samples.filter(s => s.lat != null && s.lon != null).map(s => ({ t: s.t, ...project(s) }))
          if (track.length < 2) { track = null; trackNote = 'No positions in the log around this start.' }
        }
      }
    }

    return {
      raceNum: gun.raceNum,
      gunUtc: gun.utc,
      sails: sailComboLabel(activeSailsAt(xml, gun.utc)),
      twsAtGun, twdAtGun,
      samples, atGun, plus30,
      line, track, trackNote, rowSpacingS,
    }
  })
}
