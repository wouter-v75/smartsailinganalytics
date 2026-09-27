// The sail's DEPTH — "draft %" — from several stern shots of one stripe.
//
//   npx vite-node scripts/sailtrim-camber.ts --boat "Northstar 76" --around 2026-09-27T11:43 --sail main --station stripe50
//
// Read-only. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// Needs, on each frame: the stripe's station marked, a measured psi, and draft
// dots in the front/back steps. Needs the station's DEPTH, which comes from
// sailtrim-triangulate.ts having been run on the same set.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { fitCamberMultiView, multiViewNote, type MultiViewFrame } from '../src/lib/sailCamberMultiView'
import { migrateRigModel, depthFor, type RigModel } from '../src/lib/rigModel'
import { widthAt, STATION_FRACTION } from '../src/lib/sailTwist'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const BOAT = flag('--boat'), AROUND = flag('--around')
const SAIL = flag('--sail') || 'main', STATION = flag('--station') || 'stripe50'
if (!BOAT || !AROUND) { console.error('usage: --boat NAME --around ISO_PREFIX [--sail main] [--station stripe50]'); process.exit(1) }

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const D2R = Math.PI / 180

async function main() {
  const { data: boats } = await sb.from('boats').select('id, name, rig_model')
  const boat = (boats ?? []).find((b) => b.name.toLowerCase() === BOAT!.toLowerCase())
  if (!boat) { console.error(`no boat called "${BOAT}"`); process.exit(1) }
  const rig = migrateRigModel((boat.rig_model || {}) as RigModel, boat.name)

  const frac = STATION_FRACTION[STATION as keyof typeof STATION_FRACTION]
  const w = rig.widths?.[SAIL as 'main' | 'jib']
  if (frac == null || !w) { console.error('no width or fraction for that station'); process.exit(1) }
  const width = widthAt(w, frac)
  if (!width) { console.error('no certificate width at that station'); process.exit(1) }
  const chordMm = width.m * 1000
  const depth = depthFor(rig, SAIL, STATION)

  const { data: photos } = await sb.from('photos').select('taken_utc, analysis_data')
  const frames: MultiViewFrame[] = []
  let leechY = 0, nLeech = 0
  for (const p of (photos ?? []).filter((x) => (x.taken_utc || '').startsWith(AROUND!)).sort((a, b) => (a.taken_utc! < b.taken_utc! ? -1 : 1))) {
    const st = (p.analysis_data as { sailTrim?: { annotation?: any; result?: any } } | null)?.sailTrim
    if (!st?.annotation?.psiMeasured) { console.log(`  ${p.taken_utc!.slice(11, 19)}  psi not measured — skipped`); continue }
    const A = st.annotation, m = st.result?.marks?.marks || {}
    const front = m[`camber:${SAIL}:front`] || [], back = m[`camber:${SAIL}:back`] || []
    const dots = [...front, ...back]
    if (dots.length < 2) { console.log(`  ${p.taken_utc!.slice(11, 19)}  no draft dots — skipped`); continue }

    // The dots, measured the way a TARGET is: perpendicular to the mast axis,
    // and RAW — the psi correction is what the fit is solving for.
    const lo = A.axis.low, hi = A.axis.high
    const L = Math.hypot(hi.x - lo.x, hi.y - lo.y)
    const up = { x: (hi.x - lo.x) / L, y: (hi.y - lo.y) / L }
    const across = { x: -up.y, y: up.x }
    const sc = m.scale, scPx = Math.hypot(sc[1].x - sc[0].x, sc[1].y - sc[0].y)
    const ref = st.result.marks.rig.scaleRefs.find((r: any) => r.key === st.result.marks.scaleKey)
    const range = st.result?.calibration?.rangeMm ?? null
    let mmPerPx = ref.mm / scPx
    if (range && ref.depthMm) mmPerPx *= range / (range + ref.depthMm)

    const raw = (q: { x: number; y: number }) => ((q.x - lo.x) * across.x + (q.y - lo.y) * across.y) * mmPerPx
    // Order along the stripe: outward from the mast.
    const ordered = dots.map(raw).sort((a, b) => Math.abs(a) - Math.abs(b))
    frames.push({ psiDeg: A.psiDeg, dots: ordered.map((r) => ({ rawMm: r })) })
    const t = A.targets.find((x: any) => x.key === `${SAIL}@${STATION}`)
    if (t) { leechY += t.mm; nLeech++ }
    console.log(`  ${p.taken_utc!.slice(11, 19)}  psi ${A.psiDeg.toFixed(2).padStart(6)}°  ${dots.length} dots  (${front.length} front, ${back.length} back)`)
  }
  if (!nLeech) { console.error('no leech station on any frame'); process.exit(1) }
  const LY = leechY / nLeech

  console.log(`\n  ${SAIL} @ ${STATION}: chord ${Math.round(chordMm)} mm (${width.source}), leech ${Math.round(LY)} mm out,`
    + ` depth ${Math.round(depth.mm)} mm (${depth.source})`)
  const f = fitCamberMultiView({ frames, chordMm, leechAthwartshipsMm: LY, leechDepthMm: depth.mm })
  if (!f) { console.log('\n  not enough to fit — two frames with a real angle between them, and six dots'); return }
  console.log(`\n  DRAFT  ${(f.camber * 100).toFixed(1)} %   (peak at ${(f.draft * 100).toFixed(0)} % of chord)`)
  console.log(`  from ${f.dots} dots over ${f.frames} frames spanning ${f.baselineDeg.toFixed(1)}°, residual ${f.rmsMm.toFixed(0)} mm`)
  const note = multiViewNote(f)
  if (note) console.log(`\n  ${note}`)
}
main()
