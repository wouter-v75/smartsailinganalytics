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
  const kit: { at: string; focal: number; mmPerPx: number }[] = []

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
    // The focal turns a scale into a RANGE, and the range drives the depth
    // correction and ψ's effective separation. It is TYPED, and nothing stored
    // can check it: rangeMm is computed FROM it, so "the focal implied by the
    // range" is the number you started with. I printed that comparison as a
    // check and it was a tautology — it agreed to 0.1 mm on a frame whose focal
    // was plainly wrong.
    //
    // What DOES check it is the next frame. Two shots seconds apart with the
    // same mm/px were taken at the same focal, whatever was typed on each.
    if (s?.rangeMm && s.mmPerPxAtMast) {
      console.log(`   focal      ${b.focalMm ?? '—'} mm (typed; nothing stored can verify it)`
        + `  → range ${(s.rangeMm / 1000).toFixed(1)} m`)
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
      // Without a scale there is no mm/px, so the re-solve returns 0 and the
      // Δ is the stored value itself — which read as "predates a fix" on a
      // frame whose only problem is that it predates the scale block.
      if (!(s?.mmPerPxAtMast)) {
        console.log('              cannot re-solve ψ: no scale block, so there is no mm/px to solve with')
      } else {
        console.log(`              re-solved ψ ${again.deg.toFixed(4)}° ±${again.sigmaDeg.toFixed(3)}`
          + `   Δ vs stored ${(again.deg - a.psiDeg).toFixed(4)}°`
          + (Math.abs(again.deg - a.psiDeg) > 0.05
            // Δψ costs 17.45 mm per DEGREE per metre of depth — stated that way
            // because it is the boat-agnostic form, and the boom is the target
            // it hurts most: 10 m abaft the mast, so 175 mm per degree.
            ? `   ← STALE: carries the old ψ, worth ${(Math.abs(again.deg - a.psiDeg) * Math.PI / 180 * 1000).toFixed(1)} mm per metre of target depth`
            : ''))
      }
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
    kit.push({ at: f.at.slice(11, 19), focal: Number(b.focalMm ?? NaN), mmPerPx: s?.mmPerPxAtMast ?? NaN })
  }

  // THE ONLY NON-CIRCULAR CHECK ON A TYPED FOCAL: the frame beside it. Two
  // shots whose mm/px agree were taken at the same focal length, whatever was
  // typed on each — if the lens had zoomed, the scale would have moved with it.
  //
  // Northstar's 4 Sept pair, one second apart: mm/px 3.925 and 3.913 (0.3 %
  // apart) with focals of 100 and 114 typed. One of them is wrong, and it is
  // worth 13 % on the range, which on an off-mast reference like the wheels
  // moves every millimetre on the frame.
  // NO FOCAL AT ALL is the loudest thing this set has, and it is not the same
  // as a wrong one. Number('') is 0, which is finite, so the pair check below
  // reported "114 vs 0 mm — one of those was typed wrong" about a frame whose
  // focal was never entered.
  //
  // Without a focal there is no range, and without a range there is NO depth
  // correction and NO ψ effective-separation correction. The frame is not
  // slightly off; it has skipped two corrections the others applied, so it
  // cannot be compared with them at all.
  const noFocal = kit.filter((k) => !(k.focal > 0))
  if (noFocal.length) {
    console.log(`\n⚠ ${noFocal.length} frame(s) carry NO focal length: ${noFocal.map((k) => k.at).join(', ')}`)
    console.log('  No focal ⇒ no range ⇒ no depth correction and no ψ correction. Those frames')
    console.log('  skipped two corrections the others applied, so the set is not internally')
    console.log('  comparable — and a tight spread across it is agreement about different maths.')
  }

  const usable = kit.filter((k) => k.focal > 0 && Number.isFinite(k.mmPerPx))
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i], b2 = usable[j]
      const scaleGap = Math.abs(a.mmPerPx - b2.mmPerPx) / Math.max(a.mmPerPx, b2.mmPerPx)
      const focalGap = Math.abs(a.focal - b2.focal) / Math.max(a.focal, b2.focal)
      if (scaleGap < 0.05 && focalGap > 0.05) {
        console.log(`⚠ ${a.at} and ${b2.at} have the same scale (${a.mmPerPx.toFixed(2)} vs ${b2.mmPerPx.toFixed(2)} mm/px)`)
        console.log(`  but different focals (${a.focal} vs ${b2.focal} mm). A zoom would have moved the scale too,`)
        console.log('  so one of those was typed wrong — and the range, which every depth correction uses, follows it.')
      }
    }
  }
}
main()
