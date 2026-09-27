// Bulk-set recording consent for a team's debrief-gating members.
//
//   npx vite-node scripts/recording-consent-bulk.ts --team "Northstar"     dry run
//   …  --write                                                            apply it
//   …  --roles coach,tl1,tl2,tl3                                          override the gate
//
// WHY THIS SCRIPT EXISTS, AND WHAT IT COSTS.
//
// Migration 0078 makes recording consent affirmative and self-service: default
// false, "never treat unanswered as yes", held per user, changed by that user,
// with recording_consent_at stamped by a trigger "so it cannot be forged or
// forgotten". Written through the service role, auth.uid() is NULL, the trigger
// takes the admin branch, and the row that results is INDISTINGUISHABLE from one
// the person set themselves.
//
// So a run of this script destroys the evidential value of the column for the
// users it touches. There is no recording_consent_source column to say
// otherwise. That is a deliberate trade the operator is making, not a bug, and
// this file is the only record of it — which is why it is committed rather than
// run as an ad-hoc query, and why --note is mandatory for a write.
//
// Under GDPR Art. 7(1) the controller must be able to DEMONSTRATE consent. A
// bare `true` does not. If that demonstration ever matters, the durable fix is
// to have each person set their own flag in their profile: their self-set
// timestamp overwrites whatever this wrote, and the record becomes real.
//
// SCOPE NOTE. recording_consent lives on public.users, not on a membership.
// There is no per-boat consent: setting it for "the 76" sets it for every boat
// that user sails in this team and any other.
//
// Reads .env.local. Writes NOTHING without --write. Run OUTSIDE the sandbox.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const val = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : null)

const WRITE = flag('write')
const TEAM = val('team') ?? 'Northstar'
const NOTE = val('note')
// Migration 0078: "Only the people who are actually in the debrief: the sailing
// roles and their coach". A team_manager, owner, consultant or guest is not in
// the room and does not gate the recorder, so they are not touched.
const ROLES = (val('roles') ?? 'coach,tl1,tl2,tl3').split(',').map((r) => r.trim())

if (flag('help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'))
  process.exit(0)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Supabase URL / service key missing in .env.local'); process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

async function main() {
  const { data: teams, error: tErr } = await sb.from('teams').select('id, name')
  if (tErr) { console.error(tErr.message); process.exit(1) }
  const team = (teams ?? []).find((t) => (t.name ?? '').toLowerCase().includes(TEAM.toLowerCase()))
  if (!team) { console.error(`no team matching "${TEAM}"`); process.exit(1) }

  const { data: ms } = await sb.from('memberships').select('user_id, role').eq('team_id', team.id)
  const { data: users } = await sb.from('users').select('id, name, email, status, recording_consent')
  const byId = new Map((users ?? []).map((u) => [u.id, u]))

  // A user gates if ANY of their memberships in this team is a gating role.
  const gating = new Set(
    (ms ?? []).filter((m) => ROLES.includes(m.role)).map((m) => m.user_id),
  )

  const targets = Array.from(gating)
    .map((id) => byId.get(id))
    .filter((u): u is NonNullable<typeof u> => !!u && u.status === 'active' && !u.recording_consent)
    .sort((a, b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? ''))

  const alreadyCount = Array.from(gating).filter((id) => byId.get(id)?.status === 'active' && byId.get(id)?.recording_consent).length

  console.log(`team ${team.name}  ·  gating roles: ${ROLES.join(', ')}`)
  console.log(`active gating members: ${gating.size ? Array.from(gating).filter((id) => byId.get(id)?.status === 'active').length : 0}`)
  console.log(`  already consented: ${alreadyCount}`)
  console.log(`  to set:            ${targets.length}\n`)
  for (const u of targets) console.log(`  ${u.name ?? u.email}`)

  if (!targets.length) { console.log('\nnothing to do.'); return }

  if (!WRITE) {
    console.log('\nDRY RUN — nothing written. Re-run with --write --note "…" to apply.')
    return
  }
  if (!NOTE) {
    console.error('\n--write requires --note "why, and on whose authority". It is the only provenance that will exist.')
    process.exit(1)
  }

  console.log(`\nnote: ${NOTE}`)
  console.log('writing…')
  let ok = 0
  for (const u of targets) {
    const { error } = await sb.from('users').update({ recording_consent: true }).eq('id', u.id)
    if (error) console.error(`  ! ${u.name ?? u.email}: ${error.message}`)
    else ok++
  }
  console.log(`\nset ${ok}/${targets.length}. recording_consent_at stamped by trigger.`)
  console.log('Each person can still change it themselves in their profile, and should be told they can.')
}

main().catch((e) => { console.error(e); process.exit(1) })
