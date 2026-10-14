// scripts/sailtrim-frame-audit.ts
// ─────────────────────────────────────────────────────────────────────────────
// Every stored input behind a measured frame, at FULL PRECISION, with ψ
// recomputed from the clicks it was solved from.
//
//   npx vite-node scripts/sailtrim-frame-audit.ts --date 2026-10-11
//   npx vite-node scripts/sailtrim-frame-audit.ts --date 2026-10-11 --target boom
//
// READ-ONLY. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// WHY, AND IT IS NOT THE SAME AS sailtrim-frame-dump. That one prints what the
// frames REPORT, rounded for reading: ψ to 0.1°, the range to whole metres,
// mm/px to 0.1. On Baraka's boom 0.1° of ψ is ±10 mm and half a metre of range
// is ±3 mm, so an argument conducted in that output cannot resolve the 20-40 mm
// effects it was being used to argue about. Several were.
//
// And ψ itself was never checked. It is the largest term in the whole chain —
// d·sinψ on a clew at E — and it is DERIVED, from two clicks and a separation
// out of the rig model. A frame can carry a perfectly consistent ψ that came
// from the wrong pair of landmarks, or from a separation that has since moved,
// and nothing downstream would show it. So this re-solves ψ from the stored
// marks with the CURRENT maths and prints it beside what the frame stored:
// a difference means the frame predates a fix, and the size of it is the size
// of the error still in that frame's numbers.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { solvePsi, effectiveSeparationMm, type Px } from '../src/lib/sailTrim'
import { baselineLandmarkDepths, migrateRigModel, type RigModel } from '../src/lib/rigModel'
import { isAnnotation, type SailTrimAnnotation } from '../src/lib/sailTrimOverlay'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const DATE = flag('--date')
const TARGET = flag('--target')
if (!DATE) { console.error('usage: --date 2026-10-11 [--target boom]'); process.exit(1) }

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const sub = (a: Px, b: Px) => ({ x: a.x - b.x, y: a.y - b.y })
const len = (p: Px) => Math.hypot(p.x, p.y)

async function main() {
  const { data: photos, error } = await sb.from('photos').select('taken_utc, analysis_data')
  if (error) { console.error(`photos: ${error.message}`); process.exit(1) }

  const frames = (photos ?? [])
    .filter((p) => String(p.taken_utc || '').startsWith(DATE!))
    .map((p) => {
      const a = p.analysis_data as {
        inst?: { heel?: number; twa?: number }
        sailTrim?: { annotation?: SailTrimAnnotation; result?: { marks?: Record<string, unknown> } }
      } | null
      return { at: String(p.taken_utc), inst: a?.inst, ann: a?.sailTrim?.annotation, bundle: a?.sailTrim?.result?.marks }
    })
    .filter((f) => isAnnotation(f.ann))
    .sort((a, b) => a.at.localeCompare(b.at))

  if (!frames.length) { console.log(`no measured frames on ${DATE}`); return }
  console.log(`${DATE}: ${frames.length} measured frame(s) — FULL PRECISION\n`)

  for (const f of frames) {
    const a = f.ann!
    const b = (f.bundle ?? {}) as {
      marks?: Record<string, Px[]>; scaleKey?: string; baselineKey?: string
      heelDeg?: string; tack?: string; focalMm?: string; rig?: RigModel
    }
    const s = a.scale
    console.log(`── ${f.at} ── ${a.tack ?? 'tack unknown'}`)
    console.log(`   scale      ${s?.key} = ${s?.mm} ±${s?.sigmaMm} mm (${s?.source}), depth ${s?.depthMm} mm`)
    console.log(`              mmPerPxAtMast ${s?.mmPerPxAtMast}   rangeMm ${s?.rangeMm}`)
    // range/mmPerPx is focal/pitch, so it is constant only at a FIXED focal
    // length. On a ZOOM it moves with every frame and says nothing — do not
    // read a spread here as a mis-marked scale. Printed because it is the one
    // number that pins a prime lens, not because it proves anything on a zoom.
    if (s?.rangeMm && s.mmPerPxAtMast) {
      console.log(`              range / mmPerPx = ${(s.rangeMm / s.mmPerPxAtMast).toFixed(1)}`
        + '  ← = focal/pitch; constant only at a FIXED focal length, not on a zoom')
    }
    console.log(`   heel       geometry used ${a.heelDeg}   log ${f.inst?.heel ?? '—'}`)
    console.log(`   psi        stored ${a.psiDeg}  (${a.psiMeasured ? 'measured' : 'ASSUMED'})   baseline ${b.baselineKey ?? '—'}`)

    // ── ψ, re-solved from the clicks it came from ────────────────────────────
    const bl = b.marks?.baseline
    const axis = a.axis
    if (bl && bl.length >= 2 && axis) {
      const up = sub(axis.high, axis.low); const L = len(up) || 1
      const across = { x: -up.y / L, y: up.x / L }
      const rig = b.rig ? migrateRigModel(b.rig, b.rig.boat) : null
      const baseRef = rig?.baselines.find((x) => x.key === b.baselineKey)
      const sep = baseRef?.mm ?? 0
      const depths = rig && b.baselineKey ? baselineLandmarkDepths(rig, b.baselineKey) : null
      const again = solvePsi(
        { aft: bl[0], fwd: bl[1], separationMm: sep, ...(depths ?? {}) },
        across, s?.mmPerPxAtMast ?? 0, a.heelDeg,
        { clickSigmaPx: 1.5, rangeMm: s?.rangeMm ?? null },
      )
      const effSep = effectiveSeparationMm({ separationMm: sep, ...(depths ?? {}) }, s?.rangeMm ?? null)
      console.log(`              baseline marks ${bl.length} · separation ${sep} mm`
        + ` · effective ${effSep.toFixed(0)} mm (x${sep ? (effSep / sep).toFixed(3) : '—'})`)
      console.log(`              landmark depths ${depths ? `fwd ${depths.depthFwdMm} / aft ${depths.depthAftMm}` : 'NOT RESOLVED — ψ uncorrected for them'}`)
      console.log(`              re-solved ψ ${again.deg.toFixed(4)}° ±${again.sigmaDeg.toFixed(3)}`
        + `   Δ vs stored ${(again.deg - a.psiDeg).toFixed(4)}°`
        + (Math.abs(again.deg - a.psiDeg) > 0.05 ? '   ← FRAME PREDATES A FIX' : ''))
      console.log(`              clicks  aft (${bl[0].x.toFixed(1)}, ${bl[0].y.toFixed(1)})  fwd (${bl[1].x.toFixed(1)}, ${bl[1].y.toFixed(1)})`
        + `   apart ${len(sub(bl[1], bl[0])).toFixed(1)} px`)
    } else {
      console.log('              no baseline marks stored — ψ cannot be re-solved')
    }

    for (const t of a.targets || []) {
      if (TARGET && !t.key.toLowerCase().includes(TARGET.toLowerCase())) continue
      console.log(`   ${t.key.padEnd(14)} ${t.mm} ±${t.sigmaMm} mm   depth ${t.depthMm ?? '—'} ±${t.depthSigmaMm ?? '—'}`
        + `   point (${t.point.x.toFixed(1)}, ${t.point.y.toFixed(1)})`)
    }
    console.log()
  }
}
main()
