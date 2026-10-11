// scripts/debrief-stored.ts
// ─────────────────────────────────────────────────────────────────────────────
// What is ACTUALLY in the database for a day's debrief — length, first line,
// and the last 200 characters.
//
//   npx vite-node scripts/debrief-stored.ts --date 2026-10-09
//   npx vite-node scripts/debrief-stored.ts --date 2026-10-09 --boat "Baraka GP"
//   …                                       --out ~/Downloads/stored.md
//
// READ-ONLY. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// WHY, because "the summary got cut short after saving" has three possible
// causes and they need completely different fixes:
//
//   the stored text is SHORT          → the save truncated or never landed;
//   the stored text is COMPLETE       → it saved fine and the display is at
//                                       fault, so look at the card, not the API;
//   the row is missing or older       → the save failed and was swallowed.
//
// Reading the last 200 characters settles it in one go: a note that ends
// mid-sentence was cut, a note that ends on a full stop was not. Guessing
// between those three from the screen has already cost two wrong diagnoses on
// this one bug — the box, then the model — and both were somewhere else.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const DATE = flag('--date')
const BOAT = flag('--boat')
const OUT = flag('--out')
if (!DATE) {
  console.error('usage: --date 2026-10-09 [--boat "Baraka GP"] [--out file.md]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const FIELDS = ['learnings', 'next_focus', 'speed_learnings', 'speed_focus_today', 'speed_long_term'] as const

/** A sentence that stops mid-flow is the signature of a cut. */
function endsMidSentence(s: string): boolean {
  const tail = s.trimEnd()
  if (!tail) return false
  return !/[.!?:)\]"'`»]$/.test(tail)
}

async function main() {
  let boatId: string | null = null
  if (BOAT) {
    const { data: boats, error } = await sb.from('boats').select('id, name')
    if (error) { console.error(`boats: ${error.message}`); process.exit(1) }
    const b = (boats ?? []).find((x) => String(x.name).toLowerCase() === BOAT.toLowerCase())
    if (!b) { console.error(`no boat called "${BOAT}"`); process.exit(1) }
    boatId = b.id as string
  }

  let q = sb.from('sessions').select('id, date, boat_id').eq('date', DATE)
  if (boatId) q = q.eq('boat_id', boatId)
  const { data: sessions, error: sErr } = await q
  if (sErr) { console.error(`sessions: ${sErr.message}`); process.exit(1) }
  if (!sessions?.length) {
    console.log(`No session on ${DATE}${BOAT ? ` for ${BOAT}` : ''} — so there is no debrief row either.`)
    console.log('A save that had to CREATE the session would have failed; that is worth knowing on its own.')
    return
  }

  for (const s of sessions) {
    // A literal list, not FIELDS.join(): supabase-js parses the select string at
    // the TYPE level and a template literal defeats it.
    const { data: rows, error } = await sb
      .from('debriefs')
      .select('learnings, next_focus, speed_learnings, speed_focus_today, speed_long_term, updated_at')
      .eq('session_id', s.id)
    if (error) { console.error(`debriefs: ${error.message}`); process.exit(1) }
    const row = rows?.[0] as unknown as Record<string, string | null> | undefined
    console.log(`\nsession ${s.id} · ${s.date}`)
    if (!row) { console.log('  no debrief row at all — nothing was ever saved for this day'); continue }
    console.log(`  updated_at ${row.updated_at ?? '(never)'}`)

    for (const f of FIELDS) {
      const v = row[f] ?? ''
      if (!v) { console.log(`  ${f.padEnd(18)} —`); continue }
      const cut = endsMidSentence(v)
      console.log(`  ${f.padEnd(18)} ${String(v.length).padStart(6)} chars  ${v.split('\n').length} lines  ${cut ? '← ENDS MID-SENTENCE' : 'ends cleanly'}`)
      console.log(`      starts: ${v.slice(0, 70).replace(/\n/g, ' ⏎ ')}`)
      console.log(`      ends:   …${v.slice(-200).replace(/\n/g, ' ⏎ ')}`)
    }

    if (OUT) {
      const text = FIELDS.filter((f) => row[f]).map((f) => `## ${f}\n\n${row[f]}`).join('\n\n')
      writeFileSync(OUT, `${text}\n`)
      console.log(`\n→ ${OUT}`)
    }
  }
}
main()
