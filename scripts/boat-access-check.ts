// scripts/boat-access-check.ts
// ─────────────────────────────────────────────────────────────────────────────
// Why a boat you can see in the database does not appear in the app.
//
//   npx vite-node scripts/boat-access-check.ts --email wouterv@runbox.com
//   npx vite-node scripts/boat-access-check.ts --email … --boat "Baraka GP"
//
// READ-ONLY. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// THE TRAP THIS EXISTS FOR. Every script here uses the SERVICE KEY, which is
// blind to row-level security: it sees every row and reports that all is well.
// The app uses the user's own session, where RLS decides. So a boat can be
// present, correct and completely invisible, and the two tools disagree without
// either being wrong. "rig-model-seed lists Baraka GP" and "Baraka GP is not in
// the picker" were both true at the same time.
//
// `boats_select` passes on is_admin() OR has_boat_access(team_id, id) OR
// shares_squad_with(team_id). has_boat_access needs a membership row where ALL
// of these hold:
//
//   user_id  = you
//   team_id  = THE BOAT'S team — not the team you think the boat is in
//   boat_id  IS NULL, or exactly this boat — a membership scoped to ONE boat
//            hides every other boat in the same team, and looks normal
//   now()    between valid_from and valid_to where those are set
//
// This prints each condition separately, because "no access" is four different
// problems with four different fixes.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const EMAIL = flag('--email')
const BOAT = flag('--boat')
if (!EMAIL) {
  console.error('usage: --email you@example.com [--boat "Baraka GP"]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const inWindow = (from: string | null, to: string | null) => {
  const now = Date.now()
  if (from && Date.parse(from) > now) return false
  if (to && Date.parse(to) < now) return false
  return true
}

async function main() {
  // auth.users is not reachable through PostgREST; the admin API is.
  const { data: list, error: uErr } = await sb.auth.admin.listUsers({ perPage: 1000 })
  if (uErr) { console.error(`auth: ${uErr.message}`); process.exit(1) }
  const user = list.users.find((u) => (u.email || '').toLowerCase() === EMAIL!.toLowerCase())
  if (!user) { console.error(`no user with email ${EMAIL}`); process.exit(1) }
  console.log(`${EMAIL} → ${user.id}\n`)

  const [{ data: boats, error: bErr }, { data: teams }, { data: mships, error: mErr }] = await Promise.all([
    sb.from('boats').select('id, name, team_id, is_competitor'),
    sb.from('teams').select('id, name'),
    sb.from('memberships').select('id, team_id, boat_id, role, valid_from, valid_to').eq('user_id', user.id),
  ])
  if (bErr) { console.error(`boats: ${bErr.message}`); process.exit(1) }
  if (mErr) { console.error(`memberships: ${mErr.message}`); process.exit(1) }

  const teamName = new Map((teams ?? []).map((t) => [t.id as string, t.name as string]))
  const boatName = new Map((boats ?? []).map((b) => [b.id as string, b.name as string]))

  console.log(`memberships (${mships?.length ?? 0}):`)
  for (const m of mships ?? []) {
    const scope = m.boat_id ? `ONLY the boat "${boatName.get(m.boat_id as string) ?? m.boat_id}"` : 'every boat in the team'
    const live = inWindow(m.valid_from as string | null, m.valid_to as string | null)
    console.log(`  ${(teamName.get(m.team_id as string) ?? m.team_id).padEnd(18)} ${String(m.role).padEnd(14)} → ${scope}`
      + (live ? '' : `  ← OUTSIDE its valid window (${m.valid_from ?? '—'} … ${m.valid_to ?? '—'})`))
  }

  const wanted = (boats ?? []).filter((b) => !BOAT || String(b.name).toLowerCase().includes(BOAT.toLowerCase()))
  console.log(`\nboats${BOAT ? ` matching "${BOAT}"` : ''}:`)
  for (const b of wanted) {
    const team = teamName.get(b.team_id as string) ?? b.team_id
    // The same four conditions has_boat_access applies, one at a time.
    const sameTeam = (mships ?? []).filter((m) => m.team_id === b.team_id)
    const scoped = sameTeam.filter((m) => !m.boat_id || m.boat_id === b.id)
    const live = scoped.filter((m) => inWindow(m.valid_from as string | null, m.valid_to as string | null))

    const verdict = live.length ? 'VISIBLE' : 'HIDDEN'
    console.log(`\n  ${String(b.name).padEnd(18)} team "${team}"${b.is_competitor ? ' · rival' : ''}  → ${verdict}`)
    if (live.length) continue

    if (!sameTeam.length) {
      console.log(`    You have NO membership in "${team}", which is the team this boat row is in.`)
      const elsewhere = (mships ?? []).map((m) => teamName.get(m.team_id as string) ?? m.team_id)
      console.log(`    Your memberships are in: ${elsewhere.join(', ') || '(none)'}`)
      console.log('    → either the boat is filed under the wrong team, or you need a membership in this one.')
    } else if (!scoped.length) {
      const only = sameTeam.map((m) => boatName.get(m.boat_id as string) ?? m.boat_id).join(', ')
      console.log(`    You ARE in "${team}", but your membership is scoped to: ${only}.`)
      console.log('    → a membership with a boat_id hides every OTHER boat in the same team.')
      console.log('    → clear its boat_id for team-wide access, or add a membership for this boat.')
    } else {
      console.log('    The membership matches, but today is outside its valid_from/valid_to window.')
    }
  }

  console.log('\nThis is what RLS WOULD decide. Confirm in the browser, signed in as yourself:')
  console.log("  (await (await fetch('/api/boats')).json()).boats.map(b => b.name)")
}
main()
