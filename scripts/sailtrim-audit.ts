// scripts/sailtrim-audit.ts
// ─────────────────────────────────────────────────────────────────────────────
// Which stored sail-geometry frames were measured against a datum that has since
// moved — and therefore which ones to reopen and save again.
//
//   npx vite-node scripts/sailtrim-audit.ts               every frame, verdict each
//   npx vite-node scripts/sailtrim-audit.ts --todo        only the ones needing action
//   npx vite-node scripts/sailtrim-audit.ts --boat "Northstar 76"
//
// THREE VERDICTS, and the third is the point: redo / ok / CANNOT TELL. The first
// version of this script folded "cannot tell" into "ok" — a frame whose boat was
// not recorded has no rig model to compare against, `scaleDrift` returned
// `stale: false`, and ten frames reported clean when nothing had been checked at
// all. Unknown is not a pass. It is printed whatever the filter, and counted
// apart.
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
const TODO_ONLY = args.includes('--todo') || args.includes('--stale')

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
  result?: {
    boat?: string
    marks?: MarksBundle & { marks?: Record<string, unknown>; rig?: { boat?: string } }
    calibration?: ResultCalibration
  }
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
  const nameById = new Map<string, string>()
  for (const b of boats ?? []) {
    rigFor.set(b.name.toLowerCase(), migrateRigModel((b.rig_model || {}) as RigModel, b.name))
    nameById.set(b.id as string, b.name as string)
  }

  const rows = (photos ?? [])
    .map((p) => ({ p, st: (p.analysis_data as { sailTrim?: StoredSailTrim } | null)?.sailTrim }))
    .filter((r): r is { p: typeof r.p; st: StoredSailTrim } => !!r.st?.annotation)
    .sort((a, b) => String(a.p.taken_utc).localeCompare(String(b.p.taken_utc)))

  if (!rows.length) { console.log('no photos carry sail geometry yet'); return }

  let redo = 0, ok = 0, unknown = 0, unredoable = 0, fromSnapshot = 0
  const byDay = new Map<string, string[]>()
  const push = (day: string, line: string) => byDay.set(day, [...(byDay.get(day) ?? []), line])

  for (const { p, st } of rows) {
    const a = st.annotation!
    const bundle = st.result?.marks

    // FOUR places name the boat, and the older the frame the further down the
    // list it is. Without one there is no rig model to compare against — which
    // is "cannot tell", never "fine".
    const subjects = ((p.subject_boat_ids || []) as string[]).map((id) => nameById.get(id)).filter(Boolean) as string[]
    const boatName = a.scale?.boat
      || st.result?.boat
      || bundle?.rig?.boat
      // Two subjects in the frame cannot say which one it was MEASURED as, and
      // that is the question — three Capricorno frames were marked as Northstar.
      || (subjects.length === 1 ? subjects[0] : null)
      || null

    if (BOAT && (boatName || '').toLowerCase() !== BOAT.toLowerCase()) continue

    const at = String(p.taken_utc || '')
    const day = at.slice(0, 10) || 'undated'
    const clock = at.slice(11, 19) || '--:--:--'
    const who = (boatName ?? '(boat not recorded)').padEnd(16)

    const clicks = bundle?.marks
    const redoable = !!clicks && Object.keys(clicks as object).length > 0
    const marksNote = redoable ? '' : '  [NO MARKS — needs re-marking, not just reopening]'

    const cannot = (why: string) => {
      unknown++
      if (!redoable) unredoable++
      push(day, `  ${clock}  ${who}  CANNOT TELL — ${why}${marksNote}`)
    }

    const resolved = resolveStoredScale(a.scale, bundle, st.result?.calibration, boatName ?? undefined)
    if (!resolved) { cannot('neither a scale block nor a rig snapshot records what it was measured against'); continue }
    if (resolved.from === 'rig-snapshot') fromSnapshot++

    const rig = boatName ? rigFor.get(boatName.toLowerCase()) : undefined
    if (!rig) {
      cannot(boatName ? `no rig model stored for "${boatName}"` : 'the boat is not recorded, so there is no rig model to compare against')
      continue
    }
    const ref = rig.scaleRefs.find((s) => s.key === resolved.scale.key)
    if (!ref) { cannot(`"${resolved.scale.key}" is not a scale reference on this boat any more`); continue }

    const drift = scaleDrift(resolved.scale, { mm: ref.mm, depthMm: ref.depthMm ?? 0 })
    const base = baselineDrift(bundle, rig.baselines)
    const stale = drift.stale || base.stale

    if (stale) { redo++; if (!redoable) unredoable++ } else ok++
    if (TODO_ONLY && !stale) continue

    const detail: string[] = []
    if (drift.stale) detail.push(`scale: ${drift.reasons.join('; ')} → ${driftNote(drift.ratio)}`)
    if (base.stale) {
      detail.push(`baseline ${base.key}: ${base.storedMm} → ${base.currentMm} mm (${(base.fraction! * 100).toFixed(1)} %)`
        + ' — ψ was solved across it, so ψ moves too, and ψ is worth 17 mm per metre a target sits abaft the mast')
    }

    push(day, [
      `  ${clock}`, who,
      `${resolved.scale.key}`.padEnd(10),
      `ψ ${a.psiMeasured ? `${(a.psiDeg ?? 0).toFixed(2)}°` : 'not measured'}`.padEnd(18),
      `${a.targets?.length ?? 0} targets`,
      resolved.from === 'rig-snapshot' ? '  (rig snapshot)' : '',
      stale ? '  ← REDO' : '  ok',
      marksNote,
    ].join('  ') + detail.map((d) => `\n${' '.repeat(6)}${d}`).join(''))
  }

  for (const [day, lines] of Array.from(byDay)) {
    console.log(`\n${day}`)
    for (const l of lines) console.log(l)
  }

  console.log(`\n${rows.length} frames with geometry · ${redo} to redo · ${ok} ok · ${unknown} CANNOT TELL`)
  if (fromSnapshot) console.log(`${fromSnapshot} were checked against the rig snapshot in result.marks — they predate the scale block`)
  if (unredoable) console.log(`${unredoable} of those needing attention have no stored clicks, so they need re-marking rather than reopening`)
  if (unknown) console.log('A frame that cannot be told about has NOT been checked. Reopening and saving it settles both questions at once: it gets the current datums, and it stores the provenance so this is answerable next time.')
  if (redo || unknown) {
    console.log('\nTo redo one: Photos → the frame → Analyse sail geometry → Edit points → Save.')
    console.log("That reruns the app's own pipeline, which is the only implementation of the maths.")
    console.log('The percentages above are the size to expect, not the answer — twist and camber')
    console.log('are not linear in the scale, so they move by their own amounts.')
  }
}
main()
