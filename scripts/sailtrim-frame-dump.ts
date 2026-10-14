// scripts/sailtrim-frame-dump.ts
// ─────────────────────────────────────────────────────────────────────────────
// Everything a measured frame recorded, side by side with the other frames of
// the same day — so two numbers that disagree can be told apart from two
// measurements of different things.
//
//   npx vite-node scripts/sailtrim-frame-dump.ts --date 2026-10-11
//   npx vite-node scripts/sailtrim-frame-dump.ts --date 2026-10-11 --target boom
//
// READ-ONLY. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// WHY. "The boom reads 310 on one tack and 682 on the other" has at least four
// causes and they need different fixes: a scale that differs between the frames,
// a range that is wrong (so the depth correction is), a depth assumed for the
// target that the boat cannot physically have, or a boom that really was
// somewhere else. Reasoning about it from two numbers on a screen produced three
// wrong explanations in a row here; the stored annotation settles it.
//
// --why TAKES THE NUMBER APART. A target's millimetres are
//
//     mm = (Du + d*sin(psi)*cos(heel)) / cos(psi)
//
// where Du is the clicked pixel's perpendicular offset from the MAST AXIS times
// the mm/px at that target's depth. Four inputs, and only one of them is the
// photograph. Printing the terms separately says which one differs between two
// frames that disagree — and in particular whether the pixels disagree (the
// operator clicked different things) or the conversion does (psi, depth, scale).
//
// The psi term is worth watching on its own: it is d*sin(psi), so on a boom at
// E = 5.7 m it is 107 mm at psi = 1.1 deg and 482 mm at psi = 5.0 deg. When it
// is larger than the answer, the answer is mostly a correction.
//
// THE SPREAD IS THE POINT. Several frames per tack, seconds apart, measure the
// same trim — so the spread WITHIN a tack is the measurement's own noise, and
// only a difference between tacks that is large against THAT is a real
// asymmetry. One frame per tack cannot tell you which you are looking at.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { isAnnotation, type SailTrimAnnotation } from '../src/lib/sailTrimOverlay'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const DATE = flag('--date')
const TARGET = flag('--target')
const WHY = args.includes('--why')
if (!DATE) {
  console.error('usage: --date 2026-10-11 [--target boom] [--why]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const f1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1))
const f0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : Math.round(v).toString())

async function main() {
  const { data: photos, error } = await sb.from('photos').select('taken_utc, analysis_data')
  if (error) { console.error(`photos: ${error.message}`); process.exit(1) }

  const frames = (photos ?? [])
    .filter((p) => String(p.taken_utc || '').startsWith(DATE!))
    .map((p) => {
      const a = p.analysis_data as {
        inst?: { heel?: number; twa?: number }
        sailTrim?: { annotation?: SailTrimAnnotation; result?: { marks?: { baselineKey?: string } } }
      } | null
      // The baseline is the one input the annotation does not carry, and psi is
      // divided by its EFFECTIVE separation — which depends on where its two
      // landmarks sit. Two frames solved against different baselines are not
      // directly comparable, and nothing else here would say so.
      return { at: String(p.taken_utc), inst: a?.inst, ann: a?.sailTrim?.annotation,
               baseline: a?.sailTrim?.result?.marks?.baselineKey ?? null }
    })
    .filter((f) => isAnnotation(f.ann))
    .sort((a, b) => a.at.localeCompare(b.at))

  if (!frames.length) { console.log(`no measured frames on ${DATE}`); return }
  console.log(`${DATE}: ${frames.length} measured frame(s)\n`)

  // The scale and the range first: if these differ between frames, every
  // millimetre does, and nothing about the sails is comparable.
  // psiMeasured is the column this most needs. An UNMEASURED psi comes from
  // psiFromHeelShortening, which the library itself calls indicative only and
  // "not for correcting anything" — yet it still multiplies the depth, so on a
  // clew at E it moves the answer by 107 mm at 1.1 deg and 482 mm at 5 deg, with
  // a sign nothing in the photograph has pinned down.
  console.log('time      tack  psi    from      heel(log/img)  defn   scale        mm/px@mast  range m  baseline')
  for (const f of frames) {
    const a = f.ann!
    const s = a.scale
    console.log(`${f.at.slice(11, 19)}  ${(a.tack ?? '—').padEnd(5)} ${f1(a.psiDeg).padStart(5)}  `
      + `${(a.psiMeasured ? 'MEASURED' : 'inferred').padEnd(9)} `
      + `${f1(f.inst?.heel).padStart(5)} / ${f1(a.heelDeg).padStart(5)}   `
      + `${(a.defn ?? '—').padEnd(6)} `
      + `${(s?.key ?? '—').padEnd(12)} ${f1(s?.mmPerPxAtMast).padStart(10)}  `
      + `${s?.rangeMm != null ? (s.rangeMm / 1000).toFixed(0).padStart(6) : '     —'}`
      + `  ${f.baseline ?? '—'}`)
  }

  // Then the targets, grouped so the within-tack spread is visible.
  const keys = Array.from(new Set(frames.flatMap((f) => (f.ann!.targets || []).map((t) => t.key))))
    .filter((k) => !TARGET || k.toLowerCase().includes(TARGET.toLowerCase()))
  for (const key of keys) {
    console.log(`\n── ${key} ──  (leeward-positive: ${frames.some((f) => f.ann!.leewardPositive) ? 'yes' : 'NO — signs only say which way round the photo is'})`)
    const byTack = new Map<string, number[]>()
    for (const f of frames) {
      const t = (f.ann!.targets || []).find((x) => x.key === key)
      if (!t) continue
      const tack = f.ann!.tack ?? 'unknown'
      console.log(`  ${f.at.slice(11, 19)}  ${tack.padEnd(7)} ${f0(t.mm).padStart(7)} mm  ±${f0(t.sigmaMm)}`
        + `  depth ${f0(t.depthMm).padStart(7)}`)
      if (!byTack.has(tack)) byTack.set(tack, [])
      byTack.get(tack)!.push(t.mm)
    }
    for (const [tack, vals] of Array.from(byTack)) {
      if (vals.length < 2) { console.log(`    ${tack}: one frame only — no spread to judge it against`); continue }
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length
      const spread = Math.max(...vals) - Math.min(...vals)
      console.log(`    ${tack}: mean ${f0(mean)} mm over ${vals.length} frames, spread ${f0(spread)} mm`
        + '   ← the measurement\'s own noise')
    }
  }

  if (WHY) {
    console.log('\n── where each millimetre comes from ──')
    console.log('Du = clicked pixel perpendicular to the MAST AXIS, in mm at the target\'s depth.')
    console.log('psi term = d*sin(psi)*cos(heel). stored = what the annotation says. Those should agree.\n')
    console.log('time      target        px off   mm/px   Du mm   psi term   /cos psi   = mm   stored   up-axis px')
    for (const f of frames) {
      const a = f.ann!
      const ax = a.axis
      const s = a.scale
      if (!ax || !s) { console.log(`${f.at.slice(11, 19)}  (no axis or scale stored)`); continue }
      // Unit vectors up the mast and across it, from the two stored axis points.
      const dx = ax.high.x - ax.low.x, dy = ax.high.y - ax.low.y
      const L = Math.hypot(dx, dy) || 1
      const up = { x: dx / L, y: dy / L }
      const across = { x: -up.y, y: up.x }
      const psi = (a.psiDeg || 0) * Math.PI / 180
      const cosHeel = a.heelDeg == null || !Number.isFinite(a.heelDeg)
        ? 1 : Math.cos(a.heelDeg * Math.PI / 180)
      for (const t of a.targets || []) {
        if (TARGET && !t.key.toLowerCase().includes(TARGET.toLowerCase())) continue
        const d = t.depthMm ?? 0
        const mmPerPx = s.rangeMm != null && s.rangeMm > 0
          ? s.mmPerPxAtMast * ((s.rangeMm + d) / s.rangeMm)
          : s.mmPerPxAtMast
        const rx = t.point.x - ax.low.x, ry = t.point.y - ax.low.y
        const pxOff = rx * across.x + ry * across.y
        const upPx = rx * up.x + ry * up.y
        const duMm = pxOff * mmPerPx
        const psiTerm = d * Math.sin(psi) * cosHeel
        const mm = (duMm + psiTerm) / Math.cos(psi)
        console.log(`${f.at.slice(11, 19)}  ${t.key.padEnd(12)} ${f1(pxOff).padStart(7)} `
          + `${f1(mmPerPx).padStart(7)} ${f0(duMm).padStart(7)} ${f0(psiTerm).padStart(10)} `
          + `${(1 / Math.cos(psi)).toFixed(4).padStart(10)} ${f0(mm).padStart(6)} ${f0(t.mm).padStart(8)}`
          + `   ${f0(upPx).padStart(7)}`)
      }
    }
    console.log('\n"= mm" against "stored" with opposite SIGNS is just the leeward flip.')
    console.log('A difference in magnitude means the annotation was written by different maths')
    console.log('than this, which is the one thing here that would be a bug in the save.')
    console.log('\nup-axis px is how far UP THE MAST the click was, from axis.low. Two frames')
    console.log('whose boom clicks differ in this were not clicking the same point on the boom —')
    console.log('and a boom point L abaft the mast has athwartships offset L*sin(boom angle), so')
    console.log('the number scales with L. Mid-boom reads half what the outer band reads.')
  }

  console.log('\nA difference BETWEEN tacks only means something if it is large against the')
  console.log('spread WITHIN each tack. If the within-tack spread is comparable, the frames')
  console.log('disagree with each other as much as the tacks do, and the asymmetry is noise.')
}
main()
