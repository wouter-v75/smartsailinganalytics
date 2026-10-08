// scripts/auth-status.ts — is this person clear to get in, and if not, why?
//
//   npm run auth:status -- gwenael.leguen@gmail.com
//   npm run auth:status -- gwenael.leguen@gmail.com --team Northstar
//
// Read-only. Nothing is written, nothing is sent.
//
// WHY. "Can they sign up?" is five tables' worth of answer — the account and
// its status, the membership, the invitation and whether its link is still
// live, whether they have ever signed in, and what the last few attempts
// recorded. Asked one column at a time it takes twenty minutes and misses the
// one that matters; this reads all five and ends with a verdict.
//
// It exists because the invite flow cost several days across three rebuilds,
// and every one of those days started with somebody asking exactly this
// question and getting a partial answer.

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { classifyInvite, type InviteState } from '../src/lib/welcome-invite'
import { describeAuthEvent, isAuthProblem, type AuthEventDetails } from '../src/lib/authEvents'
import { normaliseEmail } from '../src/lib/provision-member'

const args = process.argv.slice(2)
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }

const email = normaliseEmail(args.find((a) => a.includes('@')) || '')
if (!email) fail('give an email address')
const teamWanted = val('--team')

const envPath = resolve(process.cwd(), '.env.local')
if (!existsSync(envPath)) fail('.env.local not found — run from the repo root')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
)
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) fail(`${k} missing from .env.local`)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})
const site = process.env.SSA_SITE_URL || env.SSA_SITE_URL || 'https://ssa.wvsailing.co.uk'

const when = (s: string | null | undefined) =>
  s ? new Date(s).toISOString().slice(0, 16).replace('T', ' ') : '—'
const ago = (s: string | null | undefined) => {
  if (!s) return ''
  const h = (Date.now() - Date.parse(s)) / 36e5
  if (!Number.isFinite(h)) return ''
  return h < 1 ? ` (${Math.round(h * 60)} min ago)`
    : h < 48 ? ` (${Math.round(h)} h ago)`
      : ` (${Math.round(h / 24)} days ago)`
}

const main = async () => {
  console.log(`\n${email}\n${'─'.repeat(email.length)}`)
  const blockers: string[] = []
  const notes: string[] = []

  // ── 1. the account ────────────────────────────────────────────────────────
  const { data: person } = await sb
    .from('users')
    .select('id, email, name, status, global_role, approved_at, created_at, recording_consent, recording_consent_at, privacy_accepted_at, requested_team_id, requested_role')
    .ilike('email', email).maybeSingle()

  if (!person) {
    console.log('\nACCOUNT   none — no row in public.users')
    console.log('          On Road 1 the manager\'s invite CREATES the account, so if you have')
    console.log('          just sent one and this says none, the invite did not provision.')
    blockers.push('there is no account for this address')
  } else {
    console.log(`\nACCOUNT   ${person.name || '(no name)'} · ${person.status}`
      + `${person.global_role ? ` · global ${person.global_role}` : ''}`)
    console.log(`          created ${when(person.created_at as string)}${ago(person.created_at as string)}`)
    if (person.status === 'disabled') blockers.push('the account is DISABLED — a global admin must reactivate it')
    if (person.status === 'pending') {
      blockers.push('the account is PENDING — on Road 1 it should be active; approve it or re-send the invite')
    }
    if (person.requested_team_id) {
      notes.push('it carries requested_team/role hints, which only the QR road sets — this account came in that way')
    }
    console.log(`          consent: recording ${person.recording_consent ? `yes, ${when(person.recording_consent_at as string)}` : 'NOT GIVEN'}`
      + ` · data clause ${person.privacy_accepted_at ? when(person.privacy_accepted_at as string) : 'NOT GIVEN'}`)
    if (!person.recording_consent) {
      notes.push('no recording consent yet — he gives it on the welcome form, so this is expected before he sets a password')
    }

    // Has he ever been in? The auth row knows; public.users does not.
    const { data: authUser } = await sb.auth.admin.getUserById(person.id as string)
    const u = authUser?.user
    if (u) {
      console.log(`          email confirmed ${u.email_confirmed_at ? when(u.email_confirmed_at) : 'NO'}`
        + ` · last sign-in ${u.last_sign_in_at ? when(u.last_sign_in_at) + ago(u.last_sign_in_at) : 'never'}`)
      if (!u.email_confirmed_at) {
        blockers.push('the address is not confirmed in auth — provisioning sets email_confirm, so something else made this account')
      }
      if (u.last_sign_in_at) {
        notes.push('he has signed in before, so he already has a password — the welcome link is not needed, "Forgot password?" is')
      }
    }
  }

  // ── 2. memberships ────────────────────────────────────────────────────────
  const { data: teams } = await sb.from('teams').select('id, name')
  const teamName = new Map((teams || []).map((t) => [t.id as string, t.name as string]))
  const match = (id: string) =>
    !teamWanted || (teamName.get(id) || '').toLowerCase().includes(teamWanted.toLowerCase())

  if (person) {
    const { data: mems } = await sb
      .from('memberships')
      .select('id, team_id, boat_id, role, valid_from, valid_to')
      .eq('user_id', person.id as string)
    const { data: boats } = await sb.from('boats').select('id, name')
    const boatName = new Map((boats || []).map((b) => [b.id as string, b.name as string]))
    const mine = (mems || []).filter((m) => match(m.team_id as string))
    console.log(`\nMEMBERSHIP${mine.length ? '' : '  none'
      + (teamWanted ? ` in a team matching "${teamWanted}"` : '')}`)
    for (const m of mine) {
      const window = m.valid_from || m.valid_to
        ? ` · ${when(m.valid_from as string)} → ${when(m.valid_to as string)}`
        : ''
      console.log(`          ${teamName.get(m.team_id as string) || m.team_id} · ${m.boat_id ? boatName.get(m.boat_id as string) || '(boat gone)' : 'all boats'}`
        + ` · ${m.role}${window}`)
    }
    if (!mine.length) {
      blockers.push(teamWanted
        ? `no membership in ${teamWanted} — he would sign in to nothing`
        : 'no membership at all — he would sign in to nothing')
    }
  }

  // ── 3. the invitation, and whether its link still works ───────────────────
  const { data: invs } = await sb
    .from('invitations')
    .select('id, team_id, boat_id, role, token, used_count, max_uses, expires_at, revoked_at, created_at')
    .ilike('email', email)
    .order('created_at', { ascending: false })
  const relevant = (invs || []).filter((i) => match(i.team_id as string))

  console.log(`\nINVITES   ${relevant.length || 'none'}`)
  let liveLink: string | null = null
  for (const [n, i] of Array.from(relevant.entries())) {
    const state: InviteState = classifyInvite(i)
    const tag = state === 'valid' ? 'LIVE' : state.toUpperCase()
    console.log(`          ${n === 0 ? '→' : ' '} ${tag.padEnd(8)} ${teamName.get(i.team_id as string) || i.team_id} · ${i.role}`
      + ` · made ${when(i.created_at as string)}${ago(i.created_at as string)}`
      + ` · expires ${when(i.expires_at as string)} · used ${i.used_count}/${i.max_uses}`)
    if (state === 'valid' && !liveLink) liveLink = `${site}/welcome/${i.token}`
  }
  if (!relevant.length) {
    blockers.push('no invitation row for this address — the welcome link cannot be verified without one')
  } else if (!liveLink) {
    blockers.push('every invitation is used, expired or revoked — press Re-send on the team page, which unspends it and pushes the expiry out')
  }

  // ── 4. what actually happened, in words ──────────────────────────────────
  const { data: evs } = await sb
    .from('events')
    .select('ts, action, details')
    .order('ts', { ascending: false })
    .limit(400)
  const his = (evs || []).filter((e) => {
    const d = (e.details || {}) as AuthEventDetails
    return String(d.to || '').toLowerCase() === email
      || String(d.email || '').toLowerCase() === email
      || (person && d.member_user_id === person.id)
  }).slice(0, 12)

  console.log(`\nHISTORY   ${his.length || 'nothing recorded'}`)
  for (const e of his) {
    const d = (e.details || {}) as AuthEventDetails
    console.log(`          ${isAuthProblem(e.action) ? '!' : ' '} ${when(e.ts as string)}  ${describeAuthEvent(e.action, d)}`)
  }

  // ── the verdict ──────────────────────────────────────────────────────────
  console.log('')
  if (blockers.length) {
    console.log(`✕ NOT CLEAR — ${blockers.length} thing(s) in the way:`)
    for (const b of blockers) console.log(`    · ${b}`)
  } else {
    console.log('✓ CLEAR — the account is active, the membership is in place, and the invitation link is live.')
    console.log('  He opens the link, chooses a password twice, ticks both consents, and is in.')
    console.log('  Nothing to confirm and nothing to approve.')
  }
  for (const n of notes) console.log(`  note: ${n}`)
  if (liveLink) {
    console.log(`\n  The live link, if the email did not reach him — treat it like a password,`)
    console.log(`  because it sets his:\n    ${liveLink}`)
  }
  console.log('')
}
main()
