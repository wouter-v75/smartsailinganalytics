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
import { triangulate, triangulateNote, worstView, type TriangulateView } from '../src/lib/sailTrimTriangulate'
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
/**
 * How well attested the model's own depth for a key is.
 *
 * The external check is only a check against something ATTESTED. Comparing a
 * solve with a guess says nothing — and worse, it says it loudly: on Baraka the
 * boom read "46 % of the model's -10000 mm" while -10000 was the generic maxi
 * shape and her certificate's E is 5700, against which the same solve is 81 %.
 * A warning that fires on a number nobody believes teaches people to skip it.
 */
const depthSourceFor = (key: string, rig: RigModel): string | null => {
  if (key === 'boom') return rig.depths?.boom?.source ?? null
  if (key === 'clew') return rig.depths?.clew?.source ?? null
  return null
}

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
  let usable = frames.filter((f) => (f.st!.annotation as { psiMeasured?: boolean }).psiMeasured)
  for (const f of frames) {
    const a = f.st!.annotation as { psiDeg: number; psiMeasured?: boolean }
    console.log(`  ${f.at.slice(11, 19)}  ψ ${a.psiDeg.toFixed(2).padStart(6)}°  ${a.psiMeasured ? 'measured' : 'ASSUMED — skipped, mark a centreplane baseline on it'}`)
  }
  if (usable.length < 2) { console.log('\n  fewer than two frames with a measured ψ'); return }

  // ONE TACK PER SOLVE, and this one is not a precision argument — pooling two
  // tacks is arithmetically meaningless.
  //
  // A target's stored `mm` is LEEWARD-POSITIVE: measureTarget multiplies by
  // leewardSign(tack), which is +1 on port and -1 on starboard. So the two tacks
  // store the same physical offset with opposite signs, and the solve, which
  // reads `measuredMm` straight, is fitting one line through two mirrored sets.
  //
  // It is easy to do by accident because --around matches the CLOCK: Baraka's
  // 08:26 window holds three starboard frames and one port one taken mid-tack,
  // and the pooled run reported residuals of 110-410 mm on every target while
  // still offering a depth to store.
  const tacks = new Map<string, string[]>()
  for (const f of usable) {
    const t = (f.st!.annotation as { tack?: string | null }).tack ?? '(unknown)'
    if (!tacks.has(t)) tacks.set(t, [])
    tacks.get(t)!.push(f.at.slice(11, 19))
  }
  if (tacks.size > 1) {
    const [keep] = Array.from(tacks).sort((a, b) => b[1].length - a[1].length)
    console.log('\n  ⚠ TWO TACKS IN ONE WINDOW — the stored millimetres are leeward-positive,')
    console.log('    so port and starboard carry the same offset with opposite signs and')
    console.log('    cannot be fitted together. Solving the larger group only:')
    for (const [t, times] of Array.from(tacks)) {
      console.log(`      ${t.padEnd(10)} ${times.join(', ')}${t === keep[0] ? '   ← kept' : '   ← DROPPED'}`)
    }
    usable = usable.filter((f) =>
      (((f.st!.annotation as { tack?: string | null }).tack ?? '(unknown)') === keep[0]))
    if (usable.length < 2) { console.log('\n  fewer than two frames left on one tack'); return }
  }

  // ONE SCALE PER SOLVE. ψ is derived from the frame's mm-per-pixel, so a scale
  // reference whose own depth or length is off scales ψ — and the solve absorbs
  // that into the depth. Pooling frames measured against different references
  // therefore blends two different ψ scalings into one answer that belongs to
  // neither, and the residual stays small while it does it.
  //
  // Baraka's boom, from one set of clicks: 101 % of her certificate E off P,
  // 88 % off the stern rail, and 74 % off a set that mixed the two. The mixed
  // answer was the worst of the three and looked no different.
  const byScale = new Map<string, string[]>()
  for (const f of usable) {
    const k = ((f.st!.annotation as { scale?: { key?: string } }).scale?.key) || '(none)'
    if (!byScale.has(k)) byScale.set(k, [])
    byScale.get(k)!.push(f.at.slice(11, 19))
  }
  if (byScale.size > 1) {
    console.log('\n  ⚠ MIXED SCALE REFERENCES — these frames are not comparable:')
    for (const [k, times] of Array.from(byScale)) {
      console.log(`      ${k.padEnd(18)} ${times.join(', ')}`)
    }
    console.log('    A reference whose length or depth is off scales ψ, and the solve absorbs')
    console.log('    that into the DEPTH. Pooling two of them blends the error and the residual')
    console.log('    will not show it. Re-measure the odd ones out onto one reference, then re-run.')
  }

  const keys = new Set<string>()
  for (const f of usable) for (const t of (f.st!.annotation as { targets: { key: string }[] }).targets) keys.add(t.key)

  const solved: Record<string, RigValue> = {}
  const legacyDepth = new Set<string>()
  console.log('\n  target           athwartships        DEPTH    residual   note')
  for (const key of Array.from(keys).sort()) {
    const views: TriangulateView[] = []
    // Which frame each view came from, so a disagreement can be NAMED. An rms
    // is an average and an average hides one bad frame among good ones.
    const viewAt: string[] = []
    for (const f of usable) {
      const ann = f.st!.annotation as {
        psiDeg: number; heelDeg?: number | null
        scale?: { rangeMm?: number | null }
        targets: { key: string; mm: number; depthMm?: number }[]
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
      // Range and heel turn the solve from a long-range approximation into the
      // real thing: a target images at k(R+D)/R, so the millimetres a frame
      // reports depend on the depth it assumed. 4 % at 260 m, 45 % at 22 m.
      views.push({
        psiDeg: ann.psiDeg,
        measuredMm: t.mm,
        // t.mm is leeward-positive; assumedDepthMm is not. The solve takes the
        // flip back out, and cannot do that unless it is told which it is.
        leewardSign: (ann as { tack?: string | null }).tack === 'stbd' ? -1 : 1,
        assumedDepthMm,
        rangeMm: ann.scale?.rangeMm ?? null,
        heelDeg: ann.heelDeg ?? null,
      })
      viewAt.push(f.at.slice(11, 19))
    }
    const r = triangulate(views)
    if (!r) continue
    const note = triangulateNote(r)
    console.log(`  ${key.padEnd(15)} ${String(Math.round(r.athwartshipsMm)).padStart(9)} mm ${String(Math.round(r.depthMm)).padStart(9)} mm`
      + ` ${r.rmsMm.toFixed(0).padStart(6)} mm   ${note || 'ok'}`)
    // When one frame is carrying the disagreement, say which and what the set
    // becomes without it. On Baraka's 08:22 boom that was 94 mm -> 12 mm, and
    // the depth went from 79 % of her certificate E to 89 %.
    // THE EXTERNAL CHECK. boom and clew have a depth in the rig model that this
    // solve was never told — the boom's comes straight off the certificate's E.
    // Comparing them is the only way to catch a ψ error COMMON to every frame,
    // which no residual can see: on Baraka the same clicks gave 88 % of E when
    // scaled off the stern rail and 101 % off P, with residuals of 12 and 7 mm.
    // The rail's depth was wrong and only this said so.
    const rigNow = migrateRigModel((boat.rig_model || {}) as RigModel, boat.name)
    const expected = depthAssumedFor(key, rigNow)
    const attested = ['measured', 'designer'].includes(depthSourceFor(key, rigNow) ?? '')
    if ((key === 'boom' || key === 'clew') && attested && Math.abs(expected) > 500) {
      const pct = (100 * Math.abs(r.depthMm)) / Math.abs(expected)
      const off = Math.abs(pct - 100) > 10
      console.log(`${' '.repeat(19)}${off ? '⚠ ' : ''}${pct.toFixed(0)}% of the model's ${Math.round(expected)} mm`
        + (off ? ' — a ψ error common to every frame looks exactly like this, and no residual can see it' : ''))
    }

    if ((key === 'boom' || key === 'clew') && !attested) {
      console.log(`${' '.repeat(19)}no attested depth to check against — the model's`
        + ` ${Math.round(expected)} mm for ${key} is itself a guess`)
    }

    const bad = worstView(views)
    if (bad) {
      console.log(`${' '.repeat(19)}↳ ${viewAt[bad.index]} is carrying it: drop that frame and this`
        + ` becomes ${Math.round(bad.without.depthMm)} mm at ${bad.without.rmsMm.toFixed(0)} mm rms`
        + ` over ${bad.without.views} views`)
    }
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
