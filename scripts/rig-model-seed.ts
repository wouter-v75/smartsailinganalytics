// Put each boat's rig model in the DATABASE, where every device can see it.
//
//   npx vite-node scripts/rig-model-seed.ts                 what would change
//   npx vite-node scripts/rig-model-seed.ts --write         store it
//   npx vite-node scripts/rig-model-seed.ts --boat "Northstar 76" --write
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
import { defaultRigModel, withMeasured, missingFrom, type RigModel } from '../src/lib/rigModel'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const boatArg = args.includes('--boat') ? args[args.indexOf('--boat') + 1] : null
const FORCE = args.includes('--force')

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

async function main() {
  const { data: boats, error } = await sb.from('boats').select('id, name, rig_model').order('name')
  if (error) { console.error(error.message); process.exit(1) }

  let changed = 0
  for (const b of boats ?? []) {
    if (boatArg && !b.name.toLowerCase().includes(boatArg.toLowerCase())) continue
    const existing = (b.rig_model ?? {}) as Partial<RigModel>
    const hasOne = existing && Object.keys(existing).length > 0 && (existing.scaleRefs?.length ?? 0) > 0

    const model = withMeasured(defaultRigModel(b.name))
    const real = realCount(model)
    const missing = missingFrom(model)

    if (hasOne && !FORCE) {
      console.log(`  ${b.name.padEnd(16)} already has a stored model — left alone (--force to overwrite)`)
      continue
    }
    console.log(`  ${b.name.padEnd(16)} ${real} value(s) better than a guess`
      + (real ? ': ' + [...model.scaleRefs, ...model.baselines]
        .filter(x => x.mm > 0 && x.source !== 'estimate')
        .map(x => `${x.key} ${x.mm}mm ±${x.sigmaMm} (${x.source})`).join(', ') : '')
      + `\n  ${''.padEnd(16)} still guesswork: ${missing.length ? missing.join(', ') : 'nothing'}`)
    changed++
    if (WRITE) {
      const up = await sb.from('boats').update({ rig_model: model }).eq('id', b.id)
      if (up.error) console.error(`    ! ${b.name}: ${up.error.message}`)
      else console.log(`    stored.`)
    }
  }
  console.log(`\n${changed} boat(s) ${WRITE ? 'written' : 'would change'}`
    + `${WRITE ? '' : '  (dry run — pass --write to store)'}`)
}
main()
