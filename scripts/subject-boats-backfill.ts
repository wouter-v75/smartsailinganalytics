// Fill photos.subject_boat_ids from what is already known about each frame.
//
//   npx vite-node scripts/subject-boats-backfill.ts            what would change
//   npx vite-node scripts/subject-boats-backfill.ts --write    store it
//
// Dry-run by default. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// THE ONLY RELIABLE SIGNAL TODAY is a sail-geometry measurement: SailTrim
// records which boat's rig model it measured against, and nobody measures
// Capricorno's stripes with Northstar's certificate by accident. `boat_id` is
// no use — it is whose SESSION the frame belongs to, and all 354 stored photos
// carry our own boat there including the pictures of other people's.
//
// `analysis_data.boat` is no use either, for the same reason: it is an overlay
// variable describing the boat that was sailing, and every photo that has it
// says "Northstar 76".
//
// So an unmeasured frame gets nothing. That is correct — we do not know who is
// in a picture nobody has identified, and guessing from the session would fill
// the column with exactly the wrong answer.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter(l => /^[A-Z0-9_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  const { data: boats } = await sb.from('boats').select('id, name, is_competitor')
  const byName = new Map((boats ?? []).map(b => [b.name.trim().toLowerCase(), b]))
  const { data: photos, error } = await sb.from('photos').select('id, taken_utc, analysis_data, subject_boat_ids')
  if (error) { console.error(error.message); process.exit(1) }

  let changed = 0, already = 0, unknown = 0
  for (const p of photos ?? []) {
    const st = (p.analysis_data as { sailTrim?: { result?: { marks?: { rig?: { boat?: string } } } } } | null)?.sailTrim
    const measured = st?.result?.marks?.rig?.boat?.trim()
    if (!measured) { unknown++; continue }
    const boat = byName.get(measured.toLowerCase())
    if (!boat) {
      console.log(`  ${p.taken_utc}  measured against "${measured}" — no such boat in the table`)
      continue
    }
    const have = (p.subject_boat_ids as string[] | null) ?? []
    if (have.includes(boat.id)) { already++; continue }
    console.log(`  ${p.taken_utc}  -> ${boat.name}${boat.is_competitor ? '  (competitor)' : ''}`)
    changed++
    if (WRITE) {
      const up = await sb.from('photos').update({ subject_boat_ids: [...have, boat.id] }).eq('id', p.id)
      if (up.error) console.error(`    ! ${up.error.message}`)
    }
  }
  console.log(`\n${changed} photo(s) ${WRITE ? 'updated' : 'would change'} · ${already} already set`
    + ` · ${unknown} carry no sail-geometry measurement, so who is in them is unknown`
    + `${WRITE ? '' : '  (dry run — pass --write to store)'}`)
}
main()
