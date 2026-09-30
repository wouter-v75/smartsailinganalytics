// Put each boat's rig model in the DATABASE, where every device can see it.
//
//   npx vite-node scripts/rig-model-seed.ts                 what would change
//   npx vite-node scripts/rig-model-seed.ts --write         store it
//   npx vite-node scripts/rig-model-seed.ts --boat "Northstar 76" --write
//
// A RIVAL, from its IRC certificate — which is how a boat we do not own becomes
// measurable at all. Parse the certificate first with irc-rigmodel.ts --out,
// then store what it produced:
//
//   npx vite-node scripts/rig-model-seed.ts --boat "Capricorno" \
//     --from /tmp/rig/capricorno.rigmodel.json \
//     --create --team Northstar --sail-no ITA30303 --length 24.98 --write
//
// `--create` is required to add a boat row, and says so in the dry run: a rival
// in a customer's boat list is a visible thing, not a side effect.
//
// Dry-run by default. Reads .env.local, and must run OUTSIDE Claude Code's
// Bash sandbox.
//
// WHY THIS EXISTS. The rig model — the handful of dimensions that turn pixels
// into millimetres — lived in two places that a teammate could not reach: a
// hardcoded MEASURED map in src/lib/rigModel.ts, and each browser's own
// localStorage. So the wheel-to-wheel measurement somebody took on the dock was
// present for whoever typed it and absent for everyone else, which is the same
// failure mode as a photo imported on one laptop (see CLAUDE.md). boats.rig_model
// is the fix; this seeds it from what is already known.
//
// It writes the WHOLE model, guesses included, because every value carries its
// own `source` and `sigmaMm`. A model that quietly omitted its estimates would
// read as complete when it is not, and the report's job is to keep saying which
// numbers are still guesswork.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import {
  defaultRigModel, withMeasured, missingFrom, migrateRigModel, deriveBaselines,
  type RigModel, type ScaleRef,
} from '../src/lib/rigModel'
// Tested, and out of this script on purpose: see the header of rigModelMerge.
import { mergeModels } from '../src/lib/rigModelMerge'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const WRITE = args.includes('--write')
const boatArg = flag('--boat')
const FORCE = args.includes('--force')
const FROM = flag('--from')
const CREATE = args.includes('--create')
const TEAM = flag('--team')
const MERGE = args.includes('--merge')
// Ties go to the CODE's model rather than to what is stored. For when a stored
// value claims a provenance it does not have — a typed depth stamped 'designer'.
const SUPERSEDE = args.includes('--supersede')
const SAIL_NO = flag('--sail-no')
const LENGTH = flag('--length')

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter(l => /^[A-Z0-9_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Supabase URL / service key missing in .env.local'); process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

/** Only the values somebody has actually measured or taken off a drawing. */
const realCount = (m: RigModel) =>
  [...m.scaleRefs, ...m.baselines].filter(x => x.mm > 0 && x.source !== 'estimate').length

/** A model parsed from a certificate, rather than built from the defaults. */
function modelFromFile(path: string, boat: string): RigModel {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RigModel
  // The boat is named by --boat: a certificate says CAPRICORNO in capitals and
  // the app should show it the way people write it.
  return { ...raw, boat }
}

async function main() {
  const { data: boats, error } = await sb.from('boats').select('id, name, rig_model').order('name')
  if (error) { console.error(error.message); process.exit(1) }

  // ── a boat that is not in the table yet ────────────────────────────────────
  if (boatArg && !boats!.some((b) => b.name.toLowerCase() === boatArg.toLowerCase())) {
    if (!CREATE) {
      console.log(`  no boat called "${boatArg}". Pass --create --team <name> to add one.`)
      return
    }
    if (!TEAM) { console.error('--create needs --team <team name>'); process.exit(1) }
    const { data: teams } = await sb.from('teams').select('id, name')
    const team = (teams || []).find((t) => t.name.toLowerCase() === TEAM.toLowerCase())
    if (!team) {
      console.error(`no team called "${TEAM}". Teams: ${(teams || []).map((t) => t.name).join(', ')}`)
      process.exit(1)
    }
    const model = FROM ? modelFromFile(FROM, boatArg) : withMeasured(defaultRigModel(boatArg))
    console.log(`  CREATE boat "${boatArg}" in team ${team.name}`
      + `${SAIL_NO ? `, sail no ${SAIL_NO}` : ''}${LENGTH ? `, LH ${LENGTH} m` : ''}`)
    console.log(`         ${realCount(model)} value(s) better than a guess; still guesswork: ${missingFrom(model).join(', ') || 'nothing'}`)
    console.log(`         it will appear in ${team.name}'s boat list — that is what makes it measurable, and it is a row you can delete.`)
    if (WRITE) {
      const ins = await sb.from('boats').insert({
        team_id: team.id, name: boatArg, rig_model: model,
        sail_number: SAIL_NO || null, length_m: LENGTH ? Number(LENGTH) : null,
      }).select('id')
      if (ins.error) { console.error(`    ! ${ins.error.message}`); process.exit(1) }
      console.log(`    created ${ins.data![0].id}`)
    } else {
      console.log('\n1 boat would be created  (dry run — pass --write to store)')
    }
    return
  }

  let changed = 0
  for (const b of boats ?? []) {
    if (boatArg && !b.name.toLowerCase().includes(boatArg.toLowerCase())) continue
    const existing = (b.rig_model ?? {}) as Partial<RigModel>
    const hasOne = existing && Object.keys(existing).length > 0 && (existing.scaleRefs?.length ?? 0) > 0

    const incoming = FROM ? modelFromFile(FROM, b.name) : withMeasured(defaultRigModel(b.name))
    const model = MERGE && hasOne
      ? mergeModels(migrateRigModel(existing as RigModel, b.name), incoming, SUPERSEDE)
      : incoming
    const real = realCount(model)
    const missing = missingFrom(model)

    if (hasOne && !FORCE && !MERGE) {
      console.log(`  ${b.name.padEnd(16)} already has a stored model — left alone (--force to overwrite)`)
      continue
    }
    console.log(`  ${b.name.padEnd(16)} ${real} value(s) better than a guess`
      + (real ? ': ' + [...model.scaleRefs, ...model.baselines]
        .filter(x => x.mm > 0 && x.source !== 'estimate')
        .map(x => `${x.key} ${x.mm}mm ±${x.sigmaMm} (${x.source})`
          // The depth is the other half of a scale reference and was not shown,
          // so a depth-only change printed identically to no change at all.
          + ('depthMm' in x && (x as ScaleRef).depthMm
            ? ` depth ${(x as ScaleRef).depthMm} (${(x as ScaleRef).depthSource ?? x.source})` : ''))
        .join(', ') : '')
      + `\n  ${''.padEnd(16)} still guesswork: ${missing.length ? missing.join(', ') : 'nothing'}`)
    changed++
    if (WRITE) {
      const patch: Record<string, unknown> = { rig_model: model }
      if (SAIL_NO) patch.sail_number = SAIL_NO
      if (LENGTH) patch.length_m = Number(LENGTH)
      const up = await sb.from('boats').update(patch).eq('id', b.id)
      if (up.error) console.error(`    ! ${b.name}: ${up.error.message}`)
      else console.log(`    stored.`)
    }
  }
  console.log(`\n${changed} boat(s) ${WRITE ? 'written' : 'would change'}`
    + `${WRITE ? '' : '  (dry run — pass --write to store)'}`)
}
main()
