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
import { migrateRigModel, depthFor, type RigModel, type RigValue } from '../src/lib/rigModel'

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

/**
 * The depth the APP already corrected this target with — which is what has to be
 * un-done to recover the raw image offset.
 *
 * It has to be `depthFor`, the same function the app calls, and it was not: this
 * read `depths.mainLeech` for every main station. That agreed with the app right
 * up until the first run of this script stored per-station depths, after which
 * the app corrected each station with its own and the script un-corrected all of
 * them with the single -6000 fallback. The mismatch is a constant offset that
 * varies per station, so the fit absorbs it into D and every station collapses
 * onto the fallback: Capricorno's main came back -5760/-5785/-5595/-5727 where
 * the first run had -7951/-6076/-4168/-3284 and the leech genuinely does sweep
 * forward as it rises. The residuals stayed small throughout, because the three
 * views agree with each other about the wrong answer.
 */
const depthAssumedFor = (key: string, rig: RigModel) => {
  if (key.includes('@')) {
    const [sail, tag] = key.split('@')
    return depthFor(rig, sail, tag).mm
  }
  return key === 'clew' ? rig.depths.clew.mm : key === 'boom' ? rig.depths.boom.mm : 0
}

async function main() {
  const { data: boats } = await sb.from('boats').select('id, name, rig_model')
  const boat = (boats ?? []).find((b) => b.name.toLowerCase() === BOAT!.toLowerCase())
  if (!boat) { console.error(`no boat called "${BOAT}"`); process.exit(1) }

  const { data: photos } = await sb.from('photos').select('taken_utc, analysis_data, subject_boat_ids')
  const frames = (photos ?? [])
    .filter((p) => (p.taken_utc || '').startsWith(AROUND!))
    .map((p) => {
      const st = (p.analysis_data as { sailTrim?: { annotation?: Record<string, unknown>; result?: Record<string, unknown> } } | null)?.sailTrim
      return { at: p.taken_utc as string, st, subjects: (p.subject_boat_ids || []) as string[] }
    })
    .filter((f) => f.st?.annotation)
    .sort((a, b) => a.at.localeCompare(b.at))

  console.log(`${BOAT} · ${frames.length} measured frame(s) at ${AROUND}${WRITE ? ' · WRITING' : ' · dry run'}\n`)
  if (frames.length < 2) { console.log('  need at least two measured frames'); return }

  // Every frame must have been measured against THIS boat's rig model, and
  // --around alone does not check it. Three 26 Sep frames of Capricorno were
  // marked with Northstar selected in the tool — so Northstar's P (31440, not
  // 34000) set the scale, Northstar's half-width (7.04, not 7.44) set the chord,
  // and this script wrote the resulting depths onto Capricorno's boat record
  // twice without a murmur, because it matched on the timestamp and took the
  // boat's name from the command line. The frame says who it was measured as;
  // believe the frame.
  // TWO questions, and both have to answer this boat.
  //
  //   what is IN the picture — photos.subject_boat_ids, set by whoever tagged it
  //   what it was MEASURED AS — the rig model snapshot on the frame
  //
  // Checking only the second is not enough: the 26 Sep 10:36 frames are of
  // Capricorno and were measured with Northstar selected, so they claim
  // "Northstar 76" and a Northstar run over a wider window would swallow them
  // silently. Checking only the first is not enough either, because a correctly
  // tagged frame can still have been scaled by the wrong boat's P.
  const bad = frames.map((f) => {
    const rigBoat = ((f.st!.result as { marks?: { rig?: { boat?: string } } })?.marks?.rig?.boat || '').trim()
    const measuredAs = rigBoat && rigBoat.toLowerCase() !== boat.name.toLowerCase() ? rigBoat : null
    const subjectWrong = f.subjects.length > 0 && !f.subjects.includes(boat.id)
    return { f, measuredAs, subjectWrong }
  }).filter((x) => x.measuredAs || x.subjectWrong)
  if (bad.length) {
    console.log(`  REFUSING: ${bad.length} frame(s) do not describe ${boat.name} —`)
    for (const { f, measuredAs, subjectWrong } of bad) {
      const why = [
        subjectWrong ? 'tagged as another boat' : null,
        measuredAs ? `measured as "${measuredAs}", so its scale, widths and depths are that boat's` : null,
      ].filter(Boolean).join('; ')
      console.log(`    ${f.at.slice(11, 19)}  ${why}`)
    }
    console.log(`\n  Reopen each one with ${boat.name} selected and save it again, or narrow --around.`)
    return
  }

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
  const legacyDepth = new Set<string>()
  console.log('\n  target           athwartships        DEPTH    residual   note')
  for (const key of Array.from(keys).sort()) {
    const views: TriangulateView[] = []
    for (const f of usable) {
      const ann = f.st!.annotation as {
        psiDeg: number; targets: { key: string; mm: number; depthMm?: number }[]
      }
      const t = ann.targets.find((x) => x.key === key)
      const rig = (f.st!.result as { marks?: { rig?: RigModel } })?.marks?.rig
      if (!t || !rig) continue
      // The depth the frame RECORDS, when it has one. Inferring it from the rig
      // model is a fallback for frames saved before 2026-09-27, and an unsound
      // one: the model moves, and a d that is wrong by a per-station constant
      // disappears into D while the residuals stay small.
      const assumedDepthMm = Number.isFinite(t.depthMm as number)
        ? (t.depthMm as number)
        : depthAssumedFor(key, rig)
      if (!Number.isFinite(t.depthMm as number)) legacyDepth.add(f.at.slice(11, 19))
      views.push({ psiDeg: ann.psiDeg, measuredMm: t.mm, assumedDepthMm })
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

  if (legacyDepth.size) {
    console.log(`\n  NOTE: ${legacyDepth.size} frame(s) record no per-target depth (${Array.from(legacyDepth).join(', ')}).`)
    console.log('  Their depth was inferred from the rig model AS IT STANDS NOW, which is not')
    console.log('  necessarily what corrected them. Re-save those frames to pin it down.')
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
