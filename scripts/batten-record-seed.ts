// Record what the battens WERE on a day, from the card's row for that day.
//
//   npx vite-node scripts/batten-record-seed.ts --boat "Northstar 76" \
//     --date 2026-09-27 --sail "MAIN_B 2026" --band 0-8 [--write]
//
// THE CARD IS THE TARGET; THIS IS THE RECORD. `boat_battens` says what the
// battens SHOULD be per wind band. A sail-change tag says what they actually
// were at a moment, and "what were the battens on that beat" is the question a
// designer asks six months later. The two are deliberately separate — see
// src/lib/battens.ts.
//
// WHICH MEANS THIS SCRIPT ASSERTS SOMETHING IT DID NOT OBSERVE. It writes the
// card's row for a band as though it were the day's setting. That is only
// honest when somebody who was there says the battens were set to that row, so
// the band is an argument rather than something inferred from the log, and the
// tag's note records that it was entered afterwards and from where. Do not use
// it to fill days nobody remembers.
//
// Dry run by default. Reads .env.local, and must run OUTSIDE the Bash sandbox.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { normaliseBattenCard, WIND_BANDS, type BattenCard } from '../src/lib/battens'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const WRITE = process.argv.includes('--write')
const BOAT = arg('boat')
const DATE = arg('date')
const SAIL = arg('sail')
const BAND = arg('band')

if (!BOAT || !DATE || !SAIL || !BAND) {
  console.error('need --boat, --date (YYYY-MM-DD), --sail and --band')
  process.exit(1)
}
if (!WIND_BANDS.some((b) => b.key === BAND)) {
  console.error(`--band must be one of: ${WIND_BANDS.map((b) => b.key).join(', ')}`)
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  const { data: boats } = await sb.from('boats').select('id, team_id, name')
  const boat = (boats || []).find((b) => b.name.toLowerCase() === BOAT!.toLowerCase())
  if (!boat) { console.error(`no boat called "${BOAT}"`); process.exit(1) }

  const { data: sails } = await sb.from('sails').select('id, boat_id, name, kind, specs')
  const sail = (sails || []).find((s) => s.boat_id === boat.id && s.name === SAIL)
  if (!sail) { console.error(`no sail "${SAIL}" on ${boat.name}`); process.exit(1) }

  const { data: row } = await sb.from('boat_battens')
    .select('card').eq('boat_id', boat.id).eq('sail_id', sail.id).maybeSingle()
  if (!row) { console.error(`no batten card on "${SAIL}" — import the sheet first`); process.exit(1) }
  const card: BattenCard = normaliseBattenCard(row.card)

  // A tag's BattenRecord is { no, tension, turns } — no part reference. The
  // card's row for this band supplies the parts, which is why the note names
  // the band rather than leaving "all soft" to be interpreted.
  const battens = Array.from({ length: card.count }, (_, i) => {
    const cell = card.rows[i]?.[BAND!]
    return { no: i + 1, tension: cell?.tension ?? null, turns: cell?.turns ?? 0 }
  })
  if (battens.every((b) => b.tension == null && !b.turns)) {
    console.error(`the card says nothing for band ${BAND} — nothing to record`)
    process.exit(1)
  }

  const { data: session } = await sb.from('sessions')
    .select('id, date, log_data, tz_offset_minutes').eq('date', DATE!).eq('boat_id', boat.id).maybeSingle()
  if (!session) { console.error(`no session for ${boat.name} on ${DATE}`); process.exit(1) }

  // At the FIRST log row, because the battens were wound ashore before it: the
  // setting is true for the whole day, and a tag halfway through would leave the
  // morning reading as though nothing were set.
  const rows = ((session.log_data as { rows?: { utc: number }[] } | null)?.rows) || []
  const firstUtc = rows.length ? rows[0].utc : Date.parse(`${DATE}T08:00:00Z`)
  const t0 = new Date(firstUtc).toISOString()
  // t1 is NOT NULL. A batten setting has no duration — it holds until somebody
  // winds it — so this is the same nominal 40 s window the composer gives a
  // sail change, not a claim about how long the battens were like that.
  const t1 = new Date(firstUtc + 40_000).toISOString()

  const { data: defs } = await sb.from('ssa_tag_defs').select('id, color').eq('slug', 'sail-change').limit(1)
  if (!defs?.length) { console.error('no sail-change tag def'); process.exit(1) }

  const band = WIND_BANDS.find((b) => b.key === BAND)!
  const note = `Battens set to the ${band.label} kn row of ${sail.name}'s card`
    + ` (sheet IM-2 2026 v5). Entered retrospectively on ${new Date().toISOString().slice(0, 10)}`
    + ' from the card, not observed at the time.'

  console.log(`${boat.name} · ${DATE} · ${sail.name} · band ${band.label} kn${WRITE ? ' · WRITING' : ' · dry run'}\n`)
  console.log(`  t0 ${t0}  (first log row of ${rows.length})`)
  console.log(`  ${note}\n`)
  for (const b of battens) console.log(`    B${b.no}  ${(b.tension ?? '—').padEnd(7)} ${b.turns ? `${b.turns} turns` : ''}`)

  const { data: already } = await sb.from('ssa_tag_events')
    .select('id, t0, meta').eq('boat_id', boat.id).eq('session_date', DATE!).eq('slug', 'sail-change')
  const stated = (already || []).filter((r) =>
    ((r.meta as { sail?: { battens?: unknown[] } } | null)?.sail?.battens || []).some(
      (b) => !!b && typeof b === 'object' && ((b as { tension?: unknown }).tension != null || (b as { turns?: unknown }).turns)))
  if (stated.length) {
    console.log(`\n  ${DATE} ALREADY has ${stated.length} tag(s) stating battens — refusing rather than adding a second answer.`)
    return
  }

  if (!WRITE) { console.log('\n  (dry run — pass --write)'); return }

  const { error } = await sb.from('ssa_tag_events').insert({
    team_id: boat.team_id,
    boat_id: boat.id,
    session_id: session.id,
    session_date: DATE,
    tag_def_id: defs[0].id,
    slug: 'sail-change',
    label: `Battens — ${band.label} kn`,
    color: defs[0].color,
    scope: 'general',
    t0,
    t1,
    target_kind: 'track',
    note,
    source: 'human',
    producer: 'script',
    meta: { sail: { up: [{ id: sail.id, name: sail.name }], onBoard: [{ id: sail.id, name: sail.name }], battens } },
  })
  console.log(error ? `\n  FAILED ${error.message}` : '\n  recorded')
}

void main()
