// scripts/sailtrim-vs-lidar.ts
// ─────────────────────────────────────────────────────────────────────────────
// A day's photographed sail shape against the boat's own lidar, at the second
// each shutter fired.
//
//   npx vite-node scripts/sailtrim-vs-lidar.ts --date 2026-09-26
//   npx vite-node scripts/sailtrim-vs-lidar.ts --date 2026-09-26 --boat "Northstar 76"
//   …                                          --max-gap 60     (seconds, default 45)
//
// READ-ONLY. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// WHY IT IS WORTH RUNNING. A photo measurement has no ground truth inside it.
// The residual across several frames says the MARKING was consistent, and a
// uniform scale error is invisible in it — which is exactly the error the wheel
// depth turned out to be. The lidar is a different instrument measuring through
// different physics, so it is the one independent opinion available.
//
// The twist DIFFERENCE between two stripes is the number to look at: any common
// zero cancels, so it holds whatever KND measures its twist from. The absolute
// angles are printed too, and a constant offset across all of them is a datum
// disagreement rather than a shape disagreement — which is a useful thing to be
// able to see rather than guess at.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { expandPhases, type StoredPhase } from '../src/lib/seasonCurves'
import { isAnnotation, type SailTrimAnnotation } from '../src/lib/sailTrimOverlay'
import {
  photoInstantMs, phaseAt, angleRows, twistRows, agrees, LIDAR_SIGMA_DEG, toLogClockMs,
} from '../src/lib/sailTrimLidar'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const DATE = flag('--date')
const BOAT = flag('--boat')
const MAX_GAP_S = Number(flag('--max-gap') || 45)
// The venue offset, minutes east of UTC. Read from the session unless given:
// phase timestamps are venue-LOCAL wall time in epoch clothing (flatLogParse
// builds them with Date.UTC), while photos.taken_utc is a true instant.
const TZ_ARG = flag('--tz-offset-min')
if (!DATE) {
  console.error('usage: --date 2026-09-26 [--boat "Northstar 76"] [--max-gap 45]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const f2 = (n: number | null | undefined) => (n == null ? '   —  ' : n.toFixed(2).padStart(6))

async function main() {
  const { data: photos, error: pErr } = await sb
    .from('photos').select('id, taken_utc, analysis_data')
  if (pErr) { console.error(`photos: ${pErr.message}`); process.exit(1) }

  const { data: statRows, error: sErr } = await sb
    .from('session_phase_stats').select('date, phases').eq('date', DATE)
  if (sErr) { console.error(`session_phase_stats: ${sErr.message}`); process.exit(1) }

  let tzOffsetMin = TZ_ARG == null ? null : Number(TZ_ARG)
  let tzFrom = 'the --tz-offset-min flag'
  if (tzOffsetMin == null) {
    const { data: sess } = await sb
      .from('sessions').select('date, tz_offset_minutes').eq('date', DATE).limit(1)
    const v = sess?.[0]?.tz_offset_minutes
    if (typeof v === 'number') { tzOffsetMin = v; tzFrom = 'sessions.tz_offset_minutes' }
  }
  if (tzOffsetMin == null) {
    console.error(`No venue offset for ${DATE}: sessions.tz_offset_minutes is not set and --tz-offset-min was not given.`)
    console.error('Refusing to guess. The log\'s clock is venue-local and a photo\'s is UTC, so without it every')
    console.error('frame either falls outside the day or matches the WRONG phase and prints numbers anyway.')
    process.exit(1)
  }
  console.log(`venue offset ${tzOffsetMin >= 0 ? '+' : ''}${tzOffsetMin} min, from ${tzFrom}`)

  const phases = expandPhases((statRows?.[0]?.phases ?? []) as StoredPhase[])
  if (!phases.length) {
    console.log(`no stored phase stats for ${DATE} — nothing to compare against.`)
    console.log('Build the day\'s phases first; lidar reaches them via `npm run lidar:import`.')
    return
  }
  const withLidar = phases.filter((p) => Object.keys(p.mean).some((k) => /Tw\d\d$/.test(k))).length
  console.log(`${DATE}: ${phases.length} phases, ${withLidar} carrying lidar twist\n`)

  const frames = (photos ?? [])
    .filter((p) => String(p.taken_utc || '').startsWith(DATE!))
    .map((p) => {
      const st = (p.analysis_data as { sailTrim?: { annotation?: SailTrimAnnotation; result?: { boat?: string } } } | null)?.sailTrim
      return { at: String(p.taken_utc), a: st?.annotation, boat: st?.annotation?.scale?.boat || st?.result?.boat || '' }
    })
    .filter((f) => isAnnotation(f.a))
    .filter((f) => !BOAT || f.boat.toLowerCase() === BOAT.toLowerCase())
    .sort((x, y) => x.at.localeCompare(y.at))

  if (!frames.length) { console.log('no measured frames on that day'); return }

  // Both windows, in the log's clock, so a systematic miss is visible as one.
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 19)
  const first = Math.min(...phases.map((p) => p.utc)), last = Math.max(...phases.map((p) => p.endUtc))
  const shutters = frames.map((f) => photoInstantMs(f.at)).filter((x): x is number => x != null)
    .map((x) => toLogClockMs(x, tzOffsetMin!))
  console.log(`phases   ${hhmm(first)} → ${hhmm(last)}   (log clock)`)
  console.log(`shutters ${hhmm(Math.min(...shutters))} → ${hhmm(Math.max(...shutters))}   (log clock)\n`)
  if (shutters.every((t) => t < first || t > last)) {
    const shift = Math.round((first - Math.max(...shutters)) / 60_000)
    console.log(`EVERY frame falls outside the phases. If that is not simply when the sailing was,`)
    console.log(`the clocks still disagree: ${shift} more minutes of offset would reach the first phase.\n`)
  }

  let checked = 0, consistent = 0
  for (const f of frames) {
    const a = f.a as SailTrimAnnotation
    const ms = photoInstantMs(f.at)
    const clock = f.at.slice(11, 19)
    if (ms == null) { console.log(`  ${clock}  unreadable timestamp — skipped`); continue }

    // Onto the log's clock before anything is compared.
    const m = phaseAt(phases, toLogClockMs(ms, tzOffsetMin!))
    const gapS = m ? Math.round(m.gapMs / 1000) : null
    const usable = !!m && m.gapMs <= MAX_GAP_S * 1000
    const phase = usable ? m!.phase : null

    console.log(`  ${clock} UTC  ${f.boat || '(boat not recorded)'}  ψ ${a.psiDeg.toFixed(2)}°`
      + (phase ? `  · phase ${phase.mode}/${phase.tack} ${phase.sailCombo}${gapS ? ` (+${gapS}s)` : ''}`
        : `  · nearest phase is ${gapS}s away — beyond --max-gap ${MAX_GAP_S}s, so NOT compared`))
    if (!phase) { console.log(''); continue }

    const tw = twistRows(a, phase)
    if (!tw.length) console.log('      no twist on this frame — the leech needs two stripes for that')
    for (const r of tw) {
      const ok = agrees(r.photoSigmaDeg, r.diffDeg)
      if (r.diffDeg != null) { checked++; if (ok) consistent++ }
      console.log(`      TWIST ${r.sail.padEnd(4)} ${r.fromHeight}→${r.toHeight}%   photo ${f2(r.photoDeg)} ±${r.photoSigmaDeg.toFixed(2)}`
        + `   lidar ${f2(r.lidarDeg)}   diff ${f2(r.diffDeg)}`
        + (ok == null ? '' : ok ? '   ✓' : '   ✗ beyond 2σ')
        + (r.interpolated ? '   [width interpolated]' : ''))
    }

    const ang = angleRows(a, phase)
    for (const r of ang) {
      console.log(`      angle ${r.sail.padEnd(4)} @${String(r.height).padStart(2)}%      photo ${f2(r.photoDeg)} ±${r.photoSigmaDeg.toFixed(2)}`
        + `   lidar ${f2(r.lidarDeg)}   diff ${f2(r.diffDeg)}`)
    }
    // A constant offset down the angle column with the twists agreeing is a
    // zero-point difference between the two instruments, not a shape error.
    const diffs = ang.map((r) => r.diffDeg).filter((d): d is number => d != null)
    if (diffs.length >= 2) {
      const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length
      const spread = Math.max(...diffs) - Math.min(...diffs)
      if (Math.abs(mean) > 1 && spread < 1) {
        console.log(`      ↳ every angle is out by about ${mean.toFixed(2)}° and the spread is only ${spread.toFixed(2)}° —`
          + ' that is a different ZERO, not a different shape. Compare the twists.')
      }
    }
    console.log('')
  }

  console.log(`${checked} twist comparison(s); ${consistent} within 2σ`
    + (checked ? ` (${Math.round((consistent / checked) * 100)} %)` : ''))
  console.log(`The lidar is given ±${LIDAR_SIGMA_DEG}° — a STAND-IN: KND's own spread across a phase is not`)
  console.log('stored, so "within 2σ" here means "not obviously inconsistent", never "verified".')
}
main()
