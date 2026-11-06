// scripts/jib-luff-rake-backfill.ts
// ─────────────────────────────────────────────────────────────────────────────
// Put `widths.jib.luffRakeDeg` on every stored rig model, from the J and HLU
// already in it.
//
//   npx vite-node scripts/jib-luff-rake-backfill.ts          # what would change
//   npx vite-node scripts/jib-luff-rake-backfill.ts --write
//
// WHY IT IS NEEDED SEPARATELY FROM THE CODE CHANGE. Both rules girth a headsail
// PERPENDICULAR TO THE LUFF while the chord measured off a photograph is
// horizontal, and `widthAt` now divides by cos of the luff's rake to convert —
// but it reads that rake off the BOAT'S STORED RIG MODEL, and no stored model
// has one. The certificate readers populate it going forward; the eight boats
// already in the database were seeded before it existed.
//
// Nothing has to be re-measured to fix that. The rake is asin(J / HLU) and both
// are already stored — J as the `tack-mast` baseline, HLU as a scale reference —
// so this derives it in place. It comes out 16.4° to 17.7° across the fleet,
// which is 4.3 % to 4.9 % on every jib chord angle.
//
// RUN IT BEFORE REDOING ANY FRAME. A redo reads the model as it stands: with no
// rake there, the frame is recomputed with NO correction and then stamped
// v0.7-jib-luff-rake, which marks it current. It would then never be offered
// again, and the 4-5 % would be baked in behind a version that claims to have
// fixed it. That is the one ordering that loses silently.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { migrateRigModel, type RigModel } from '../src/lib/rigModel'

const WRITE = process.argv.includes('--write')
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  const { data: boats, error } = await sb.from('boats').select('id, name, rig_model')
  if (error) { console.error(`boats: ${error.message}`); process.exit(1) }
  console.log(`${(boats ?? []).length} boat(s)${WRITE ? ' · WRITING' : ' · dry run'}\n`)
  console.log('boat               J mm    HLU mm   rake      widths lift   note')

  let done = 0, skipped = 0
  for (const b of boats ?? []) {
    const m = migrateRigModel((b.rig_model || {}) as RigModel, b.name as string)
    const jib = m.widths?.jib
    if (!jib) { skipped++; continue }
    const hlu = m.scaleRefs?.find((r) => r.key === 'HLU')
    const j = m.baselines?.find((x) => x.key === 'tack-mast')
    const name = String(b.name).padEnd(16)
    if (!(hlu && hlu.mm > 0 && j && j.mm > 0 && j.mm < hlu.mm)) {
      console.log(`${name} ${String(j?.mm ?? '—').padStart(6)}  ${String(hlu?.mm ?? '—').padStart(6)}   —         —            no J or HLU — leave it alone`)
      skipped++
      continue
    }
    const rakeDeg = (Math.asin(j.mm / hlu.mm) * 180) / Math.PI
    const lift = 1 / Math.cos((rakeDeg * Math.PI) / 180)
    const had = jib.luffRakeDeg
    console.log(`${name} ${String(j.mm).padStart(6)}  ${String(hlu.mm).padStart(6)}   ${rakeDeg.toFixed(2)}°`
      + `    ${((lift - 1) * 100).toFixed(1)} %`
      + `        ${had == null ? 'adding' : `already ${had.toFixed(2)}°`}`)
    if (had != null) { skipped++; continue }
    if (WRITE) {
      const next: RigModel = {
        ...m,
        widths: { ...m.widths, jib: { ...jib, luffRakeDeg: Number(rakeDeg.toFixed(3)) } },
      }
      const { error: uErr } = await sb.from('boats').update({ rig_model: next }).eq('id', b.id)
      if (uErr) { console.error(`  ! ${uErr.message}`); process.exit(1) }
    }
    done++
  }

  console.log(`\n${done} ${WRITE ? 'written' : 'to write'}${skipped ? ` · ${skipped} skipped` : ''}`)
  console.log('\nThe MAIN is deliberately untouched: its luff is the mast, raked 2-4°, which')
  console.log('is 0.14 % — and no certificate carries the figure to derive it from.')
  if (!WRITE && done) {
    console.log('\nRe-run with --write, and do it BEFORE redoing any frame: a redo with no rake')
    console.log('stored recomputes without the correction and stamps the frame v0.7 anyway.')
  }
}
main()
