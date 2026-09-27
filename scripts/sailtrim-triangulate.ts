// Measure the fore-and-aft DEPTHS of a boat's targets from several stern shots,
// and store them on the boat so every later measurement uses them.
//
//   npx vite-node scripts/sailtrim-triangulate.ts --boat "Northstar 76" --around 2026-09-27T11:43
//   …                                             --write
//
// Dry-run by default. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// WHY. One stern shot cannot see depth — the camera looks along the boat — so
// every measurement is corrected using a depth the rig model GUESSES: the main's
// leech at -6000 ± 2500 mm for every height, when the truth is a leech sweeping
// forward as it rises. It is the largest error in the tool, because a degree of
// ψ is worth 17 mm for every metre a target sits abaft the mast, so it goes
// wrong most where the leech is furthest aft.
//
// Several frames of the same sail at different ψ fix it. On the 27 Sep 11:43 set
// — three frames spanning 8.0° — every target solved with a residual under
// 12 mm, and the boom came back at -9839 mm against a certificate E of 10330
// that the solve was never told.
//
// WHAT MAKES A USABLE SET: the same boat, seconds apart so the sail has not
// moved, and a real angle between the frames. Three or more, because two solve
// exactly and leave nothing to check by.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { triangulate, triangulateNote, type TriangulateView } from '../src/lib/sailTrimTriangulate'
import { migrateRigModel, type RigModel, type RigValue } from '../src/lib/rigModel'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const WRITE = args.includes('--write')
const BOAT = flag('--boat')
const AROUND = flag('--around')
if (!BOAT || !AROUND) {
  console.error('usage: --boat "Northstar 76" --around 2026-09-27T11:43 [--write]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const depthAssumedFor = (key: string, d: RigModel['depths']) =>
  key.startsWith('main@') ? d.mainLeech.mm
    : key.startsWith('jib@') ? d.leech.mm
      : key === 'clew' ? d.clew.mm
        : key === 'boom' ? d.boom.mm : 0

async function main() {
  const { data: boats } = await sb.from('boats').select('id, name, rig_model')
  const boat = (boats ?? []).find((b) => b.name.toLowerCase() === BOAT!.toLowerCase())
  if (!boat) { console.error(`no boat called "${BOAT}"`); process.exit(1) }

  const { data: photos } = await sb.from('photos').select('taken_utc, analysis_data')
  const frames = (photos ?? [])
    .filter((p) => (p.taken_utc || '').startsWith(AROUND!))
    .map((p) => {
      const st = (p.analysis_data as { sailTrim?: { annotation?: Record<string, unknown>; result?: Record<string, unknown> } } | null)?.sailTrim
      return { at: p.taken_utc as string, st }
    })
    .filter((f) => f.st?.annotation)
    .sort((a, b) => a.at.localeCompare(b.at))

  console.log(`${BOAT} · ${frames.length} measured frame(s) at ${AROUND}${WRITE ? ' · WRITING' : ' · dry run'}\n`)
  if (frames.length < 2) { console.log('  need at least two measured frames'); return }

  // A frame whose ψ was ASSUMED says nothing about depth: it is the one input
  // this cannot do without, and including it would quietly bias every answer.
  const usable = frames.filter((f) => (f.st!.annotation as { psiMeasured?: boolean }).psiMeasured)
  for (const f of frames) {
    const a = f.st!.annotation as { psiDeg: number; psiMeasured?: boolean }
    console.log(`  ${f.at.slice(11, 19)}  ψ ${a.psiDeg.toFixed(2).padStart(6)}°  ${a.psiMeasured ? 'measured' : 'ASSUMED — skipped, mark a centreplane baseline on it'}`)
  }
  if (usable.length < 2) { console.log('\n  fewer than two frames with a measured ψ'); return }

  const keys = new Set<string>()
  for (const f of usable) for (const t of (f.st!.annotation as { targets: { key: string }[] }).targets) keys.add(t.key)

  const solved: Record<string, RigValue> = {}
  console.log('\n  target           athwartships        DEPTH    residual   note')
  for (const key of Array.from(keys).sort()) {
    const views: TriangulateView[] = []
    for (const f of usable) {
      const ann = f.st!.annotation as { psiDeg: number; targets: { key: string; mm: number }[] }
      const t = ann.targets.find((x) => x.key === key)
      const rig = (f.st!.result as { marks?: { rig?: RigModel } })?.marks?.rig
      if (!t || !rig) continue
      views.push({ psiDeg: ann.psiDeg, measuredMm: t.mm, assumedDepthMm: depthAssumedFor(key, rig.depths) })
    }
    const r = triangulate(views)
    if (!r) continue
    const note = triangulateNote(r)
    console.log(`  ${key.padEnd(15)} ${String(Math.round(r.athwartshipsMm)).padStart(9)} mm ${String(Math.round(r.depthMm)).padStart(9)} mm`
      + ` ${r.rmsMm.toFixed(0).padStart(6)} mm   ${note || 'ok'}`)
    // Only a leech station belongs in stationDepths; the clew and boom already
    // have their own fields, and they are checks rather than inputs.
    if (/^(main|jib)@stripe/.test(key) && !note) {
      solved[key] = { mm: Math.round(r.depthMm), sigmaMm: Math.max(10, Math.round(r.rmsMm)), source: 'measured' }
    }
  }

  const n = Object.keys(solved).length
  console.log(`\n  ${n} station depth(s) good enough to store`)
  if (!n) return
  if (WRITE) {
    const current = migrateRigModel((boat.rig_model || {}) as RigModel, boat.name)
    const next: RigModel = { ...current, stationDepths: { ...(current.stationDepths || {}), ...solved } }
    const up = await sb.from('boats').update({ rig_model: next }).eq('id', boat.id)
    console.log(up.error ? `  ! ${up.error.message}` : '  stored on the boat.')
  } else {
    console.log('  (dry run — pass --write to store)')
  }
}
main()
