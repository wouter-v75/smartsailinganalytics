// scripts/sailtrim-audit.ts
// ─────────────────────────────────────────────────────────────────────────────
// Which stored sail-geometry frames were measured against a datum that has since
// moved — and therefore which ones to reopen and save again.
//
//   npx vite-node scripts/sailtrim-audit.ts
//   npx vite-node scripts/sailtrim-audit.ts --boat "Northstar 76" --stale
//
// READ-ONLY. There is no --write and there should not be: it does not recompute
// anything. Reopening a frame in SailTrim and saving it runs the app's own
// pipeline, which is the single implementation of the depth correction, the
// chord angles and the camber fit. The one time this repo grew a second one the
// two agreed until they silently didn't. So this says which frames, in what
// order, and what size of change to expect — and an unchanged number after a
// redo is then recognisable as the bug it would be.
//
// Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { migrateRigModel, type RigModel } from '../src/lib/rigModel'
import {
  scaleDrift, driftNote, resolveStoredScale, baselineDrift,
  type StoredScale, type MarksBundle, type ResultCalibration,
} from '../src/lib/sailTrimAudit'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const BOAT = flag('--boat')
const STALE_ONLY = args.includes('--stale')

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

interface StoredSailTrim {
  annotation?: {
    scale?: StoredScale
    psiDeg?: number
    psiMeasured?: boolean
    targets?: unknown[]
    measuredAt?: number
  }
  result?: { marks?: MarksBundle & { marks?: Record<string, unknown> }; calibration?: ResultCalibration }
}

async function main() {
  const { data: boats, error: bErr } = await sb.from('boats').select('id, name, rig_model')
  // Say so rather than reading an error as "none": selecting a column that is
  // not there returns an error and an empty payload, which reads as no rows.
  if (bErr) { console.error(`boats: ${bErr.message}`); process.exit(1) }

  const { data: photos, error: pErr } = await sb
    .from('photos').select('id, taken_utc, analysis_data, subject_boat_ids')
  if (pErr) { console.error(`photos: ${pErr.message}`); process.exit(1) }

  const rigFor = new Map<string, RigModel>()
  for (const b of boats ?? []) rigFor.set(b.name.toLowerCase(), migrateRigModel((b.rig_model || {}) as RigModel, b.name))

  const rows = (photos ?? [])
    .map((p) => ({ p, st: (p.analysis_data as { sailTrim?: StoredSailTrim } | null)?.sailTrim }))
    .filter((r): r is { p: typeof r.p; st: StoredSailTrim } => !!r.st?.annotation)
    .sort((a, b) => String(a.p.taken_utc).localeCompare(String(b.p.taken_utc)))

  if (!rows.length) { console.log('no photos carry sail geometry yet'); return }

  let stale = 0, unredoable = 0, noScale = 0, fromSnapshot = 0
  const byDay = new Map<string, string[]>()

  for (const { p, st } of rows) {
    const a = st.annotation!
    const boatName = a.scale?.boat || null
    if (BOAT && (boatName || '').toLowerCase() !== BOAT.toLowerCase()) continue

    const at = String(p.taken_utc || '')
    const day = at.slice(0, 10) || 'undated'
    const clock = at.slice(11, 19) || '--:--:--'

    // No scale block only means the frame predates provenance being stored. The
    // rig snapshot in result.marks says the same thing, so it is still checkable.
    const bundle = st.result?.marks
    const resolved = resolveStoredScale(a.scale, bundle, st.result?.calibration, boatName ?? undefined)
    if (!resolved) {
      noScale++
      byDay.set(day, [...(byDay.get(day) ?? []), `  ${clock}  ${(boatName ?? '(boat not recorded)').padEnd(16)}  neither a scale block nor a rig snapshot — nothing records what this was measured against. Reopen and save.`])
      continue
    }

    const rig = boatName ? rigFor.get(boatName.toLowerCase()) : undefined
    const ref = rig?.scaleRefs.find((s2) => s2.key === resolved.scale.key)
    const drift = scaleDrift(resolved.scale, ref ? { mm: ref.mm, depthMm: ref.depthMm ?? 0 } : null)
    const base = baselineDrift(bundle, rig?.baselines)

    const stale_ = drift.stale || base.stale
    if (STALE_ONLY && !stale_) continue

    // Reopening replays the stored clicks; without them it is a re-mark.
    const clicks = bundle?.marks
    const redoable = !!clicks && Object.keys(clicks as object).length > 0
    if (stale_) stale++
    if (stale_ && !redoable) unredoable++
    if (resolved.from === 'rig-snapshot') fromSnapshot++

    const detail: string[] = []
    if (drift.stale) detail.push(`scale: ${drift.reasons.join('; ')} → ${driftNote(drift.ratio)}`)
    if (base.stale) detail.push(`baseline ${base.key}: ${base.storedMm} → ${base.currentMm} mm (${(base.fraction! * 100).toFixed(1)} %) — ψ was solved across it, so ψ moves too`)

    const line = [
      `  ${clock}`,
      (boatName ?? '(boat not recorded)').padEnd(16),
      `${resolved.scale.key}`.padEnd(10),
      `ψ ${a.psiMeasured ? `${(a.psiDeg ?? 0).toFixed(2)}°` : 'not measured'}`.padEnd(18),
      `${(a.targets?.length ?? 0)} targets`,
      resolved.from === 'rig-snapshot' ? '  (from rig snapshot)' : '',
      stale_ ? '  ← REDO' : '  ok',
      stale_ && !redoable ? '  [NO MARKS — needs re-marking]' : '',
    ].join('  ')
    const lines = byDay.get(day) ?? []
    lines.push(line + (detail.length ? detail.map((d) => `\n${' '.repeat(6)}${d}`).join('') : ''))
    byDay.set(day, lines)
    continue

  }

  for (const [day, lines] of Array.from(byDay)) {
    console.log(`\n${day}`)
    for (const l of lines) console.log(l)
  }

  console.log(`\n${rows.length} frames with geometry · ${stale} measured against a datum that has since moved`)
  if (fromSnapshot) console.log(`${fromSnapshot} were checked against the rig snapshot in result.marks — they predate the scale block`)
  if (noScale) console.log(`${noScale} record nothing at all about what they were measured against`)
  if (unredoable) console.log(`${unredoable} of the stale ones have no stored marks, so they need re-marking rather than reopening`)
  if (stale) {
    console.log('\nTo redo one: Photos → the frame → Analyse sail geometry → Edit points → Save.')
    console.log('That reruns the app\'s own pipeline, which is the only implementation of the maths.')
    console.log('The per-frame percentage above is the size to expect, not the answer — twist and')
    console.log('camber are not linear in the scale, so they move by their own amounts.')
  }
}
main()
