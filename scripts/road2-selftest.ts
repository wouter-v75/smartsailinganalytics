// scripts/road2-selftest.ts — does the QR road work, end to end, today?
//
//   npm run auth:selftest2                  (refusals only — creates nothing, emails nobody)
//   npm run auth:selftest2 -- --full        (also creates a real pending account, then deletes it)
//   npm run auth:selftest2 -- --full --keep (leaves it, so you can press Approve)
//   npm run auth:selftest2 -- --delete <email>        (removes a kept one)
//   npm run auth:selftest2 -- --base https://ssa.wvsailing.co.uk
//
// TWO MODES, because the honest version of this test has a side effect.
//
// The default runs only the REFUSALS: every way the route should say no. It
// creates no account and sends no mail, so it is safe to run whenever, against
// anything, as often as you like. It is also where the interesting bugs live —
// a road that lets somebody in is easy to notice; a road that lets the wrong
// somebody in is not.
//
// --full additionally walks the happy path: it creates a real pending account
// against a temporary join code and then deletes it. Two things to know before
// running it. It EMAILS THE TEAM'S MANAGERS, because that is the step being
// tested — you will get a "wants to join" message for a fictional person. And
// the account it makes is pending with NO membership, so even if cleanup fails
// it can sign in to nothing and appears only in the pending queue; the script
// says loudly if anything is left behind.
//
// The address used is @example.invalid, reserved by RFC 2606 and deliverable
// nowhere, so a mistake here cannot mail a stranger.
//
// --keep EXISTS FOR THE ONE STEP A SCRIPT CANNOT TAKE. Approving goes through a
// route that needs a signed-in manager, so nothing here can press the button —
// which means sendApprovedEmail is the last thing in either road that has never
// run outside production. With --keep the pending account is left in place, you
// press Approve in SSA, and you see whether that email arrives. Then
// --delete <email> removes it. It is the only part of this script that leaves
// something behind, so it says so loudly and tells you the line to clean up
// with.

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const base = (val('--base') || 'http://localhost:3000').replace(/\/$/, '')
const full = has('--full')
const keep = has('--keep')
const deleteWho = val('--delete')
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }

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

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✕'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

/**
 * Can the thing under test send email at all?
 *
 * Only answerable for localhost, where .env.local IS the server's environment.
 * Worth saying out loud because of how 6 October went: every check passed, the
 * approval was pressed, and only then did "RESEND_API_KEY / RESEND_FROM not
 * set" appear — a dev server cannot email anybody, which is fine, but it is
 * better known before the test than after it.
 */
function mailWarning(): string | null {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|$|\/)/.test(base)) return null
  if (env.RESEND_API_KEY && env.RESEND_FROM) return null
  return '  ⚠ This dev server cannot send email: RESEND_API_KEY / RESEND_FROM are not in .env.local.\n'
       + '    Everything below still works; the messages simply go nowhere. Production is configured\n'
       + '    separately (Vercel → Settings → Environment Variables), so this says nothing about it.'
}

const GOOD_PW = 'a-long-enough-one'
interface Reply { status: number; error?: string; ok?: boolean; message?: string }

/**
 * Is anything actually listening?
 *
 * Asked BEFORE a single test row is written, because the alternative is what
 * happened on 8 October: the first POST threw ECONNREFUSED, the cleanup ran,
 * and the whole thing ended in a Node stack trace — a page of `internalConnect`
 * frames whose message is really "start the dev server".
 */
async function unreachable(): Promise<string | null> {
  try {
    await fetch(`${base}/login`, { redirect: 'manual' })
    return null
  } catch (e) {
    return (e as { cause?: { code?: string } })?.cause?.code === 'ECONNREFUSED'
      ? `nothing is listening on ${base}.`
        + `\n    Start it in another terminal:  cd ${process.cwd()} && npm run dev`
        + '\n    Or test the deployed one:       npm run auth:selftest2 -- --base https://ssa.wvsailing.co.uk'
      : `could not reach ${base}: ${(e as Error).message}`
  }
}

async function post(token: string, body: Record<string, unknown>): Promise<Reply> {
  let r: Response
  try {
    r = await fetch(`${base}/api/join/${token}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    // A server that dies halfway through — a dev server restarting on a file
    // save is the usual way — must not read as a code defect.
    fail(`${base} stopped answering (${(e as Error).message}). Is the server still up?`)
  }
  const j = (await r.json().catch(() => ({}))) as { error?: string; ok?: boolean; message?: string }
  return { status: r.status, ...j }
}

const freshEmail = () => `selftest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.invalid`

/** An open join code, as the QR panel makes one. */
async function makeCode(teamId: string, over: Record<string, unknown> = {}) {
  const token = `ssa-selftest2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const { data, error } = await sb.from('invitations').insert({
    team_id: teamId, email: null, role: 'tl1', token,
    auto_approve: false, max_uses: 1, used_count: 0,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...over,
  }).select('id').single()
  if (error || !data) fail(`could not create a test join code: ${error?.message}`)
  return { id: data.id as string, token }
}

/**
 * Remove an account --keep left behind.
 *
 * Guarded hard. This script holds the service key, which can delete anybody, so
 * it will only touch an address that this script itself could have made: the
 * selftest- prefix AND the @example.invalid domain, which is reserved by RFC
 * 2606 and belongs to no one. A typo here must bounce off, not take a crew
 * member's account with it.
 */
async function removeKept(email: string): Promise<never> {
  const addr = email.trim().toLowerCase()
  if (!/^selftest-[a-z0-9-]+@example\.invalid$/.test(addr)) {
    fail(`refusing to delete ${addr} — this only ever removes its own selftest-…@example.invalid accounts`)
  }
  const { data: person } = await sb.from('users').select('id, status').ilike('email', addr).maybeSingle()
  if (!person?.id) {
    console.log(`\n  nothing to delete — no account for ${addr}\n`)
    process.exit(0)
  }
  const { error } = await sb.auth.admin.deleteUser(person.id as string)
  if (error) fail(`could not delete ${addr}: ${error.message}`)
  console.log(`\n  ✓ removed ${addr}${person.status === 'active' ? ' (it had been approved — its membership goes with it)' : ''}\n`)
  process.exit(0)
}

const main = async () => {
  if (deleteWho) await removeKept(deleteWho)
  if (keep && !full) fail('--keep only means something with --full — there is nothing to keep otherwise')
  console.log(`\nRoad 2 self-test against ${base}${full ? '  (--full: WILL create an account and email the managers)' : ''}\n`)

  const warn = mailWarning()
  if (warn) console.log(`${warn}\n`)

  const down = await unreachable()
  if (down) fail(down)

  const { data: teams } = await sb.from('teams').select('id, name').order('name').limit(2)
  const team = (teams || [])[0]
  if (!team) fail('no teams in the database to attach a test join code to')
  // A SECOND team, for the multi-team case. With only one team in the database
  // the same team stands in: the account still has no membership in it, which
  // is the condition the route actually turns on, so the check still means
  // something — it just stops being a story about two boats.
  const otherTeam = (teams || [])[1] || team

  const made: string[] = []
  const users: string[] = []
  // Accounts this script makes for a single check and always removes, --keep or
  // not: --keep is for the one pending account a human has to press Approve on.
  const tempUsers: string[] = []
  let keptEmail = ''
  try {
    // ── the refusals ────────────────────────────────────────────────────────
    console.log('  Refusals (nothing is created):')
    const live = await makeCode(team.id); made.push(live.id)

    const noEmail = await post(live.token, { name: 'T', email: 'not-an-address', password: GOOD_PW, confirm: GOOD_PW, privacy_accepted: true, recording_consent: true })
    check('a malformed address is refused', noEmail.status === 400, `${noEmail.status} ${noEmail.error || ''}`)

    const shortPw = await post(live.token, { name: 'T', email: freshEmail(), password: 'short', confirm: 'short', privacy_accepted: true, recording_consent: true })
    check('a short password is refused, and says how short', shortPw.status === 400 && /at least 8/.test(shortPw.error || ''))

    const mismatch = await post(live.token, { name: 'T', email: freshEmail(), password: GOOD_PW, confirm: 'something-else', privacy_accepted: true, recording_consent: true })
    check('a mismatched confirmation is refused', mismatch.status === 400 && /do not match/.test(mismatch.error || ''))

    // The one this task is about: no recording consent, no account.
    const noRec = await post(live.token, { name: 'T', email: freshEmail(), password: GOOD_PW, confirm: GOOD_PW, privacy_accepted: true, recording_consent: false })
    check('NO recording consent, no account', noRec.status === 400 && /voice-recorded/.test(noRec.error || ''), noRec.error || '')

    const noPriv = await post(live.token, { name: 'T', email: freshEmail(), password: GOOD_PW, confirm: GOOD_PW, privacy_accepted: false, recording_consent: true })
    check('no privacy agreement, no account', noPriv.status === 400 && /handles your data/.test(noPriv.error || ''))

    const neither = await post(live.token, { name: 'T', email: freshEmail(), password: GOOD_PW, confirm: GOOD_PW })
    check('neither consent, and it says both', neither.status === 400 && /both/.test(neither.error || ''))

    const { data: untouched } = await sb.from('invitations').select('used_count').eq('id', live.id).single()
    check('none of that spent a use of the code', untouched?.used_count === 0, `used_count=${untouched?.used_count}`)

    const ok = { name: 'T', password: GOOD_PW, confirm: GOOD_PW, privacy_accepted: true, recording_consent: true }

    const expired = await makeCode(team.id, { expires_at: new Date(Date.now() - 1000).toISOString() }); made.push(expired.id)
    const expRes = await post(expired.token, { ...ok, email: freshEmail() })
    check('an expired code says expired', expRes.status === 410 && /expired/i.test(expRes.error || ''))

    const revoked = await makeCode(team.id, { revoked_at: new Date().toISOString() }); made.push(revoked.id)
    const revRes = await post(revoked.token, { ...ok, email: freshEmail() })
    check('a withdrawn code says withdrawn', revRes.status === 410 && /withdrawn/i.test(revRes.error || ''))

    const spent = await makeCode(team.id, { max_uses: 1, used_count: 1 }); made.push(spent.id)
    const spentRes = await post(spent.token, { ...ok, email: freshEmail() })
    check('a used-up code says so', spentRes.status === 410 && /as many times/i.test(spentRes.error || ''))

    const bogus = await post('ssa-selftest2-no-such-code', { ...ok, email: freshEmail() })
    check('an unknown code does not leak that it is unknown', bogus.status === 410 && /Ask your team manager/.test(bogus.error || ''))

    // An address that already has an account IS allowed to join another team —
    // that is the point of the second block below — but only with its own
    // password. Holding the QR code must never be a way into, or a way to
    // reset, somebody else's account. Whichever way the route says no (401 for
    // a password that is not theirs, 409 for a team they are in already), what
    // must never happen is a 200.
    const { data: someone } = await sb.from('users').select('email').not('email', 'is', null).limit(1).maybeSingle()
    if (someone?.email) {
      const dup = await post(live.token, { ...ok, email: someone.email as string })
      check(
        'somebody else\'s address, with a password that is not theirs, gets nowhere',
        dup.status !== 200 && (dup.status === 401 || dup.status === 409 || dup.status === 403),
        `${dup.status} ${dup.error || ''}`
      )
      const { data: stillUnspent } = await sb.from('invitations').select('used_count').eq('id', live.id).single()
      check('and did not spend a use either', stillUnspent?.used_count === 0, `used_count=${stillUnspent?.used_count}`)
    } else {
      check('somebody else\'s address, with a password that is not theirs, gets nowhere', true, '(skipped — no users to try)')
    }

    if (!full) {
      console.log('\n  The happy path needs --full: it creates a real pending account and emails the managers.')
      return
    }

    // ── the happy path ──────────────────────────────────────────────────────
    console.log('\n  Happy path (creates an account, emails the managers):')
    const code = await makeCode(team.id); made.push(code.id)
    const email = freshEmail()
    keptEmail = email
    const res = await post(code.token, { ...ok, name: 'SSA self-test', email })
    check('the request is accepted', res.status === 200 && res.ok === true, `${res.status} ${res.error || ''}`)
    check('and says what happens next', /team manager/i.test(res.message || ''))

    const { data: person } = await sb
      .from('users')
      .select('id, status, requested_team_id, requested_role, recording_consent, recording_consent_at, privacy_accepted_at')
      .ilike('email', email).maybeSingle()
    if (person?.id) users.push(person.id as string)

    check('the account exists', !!person?.id)
    check('it is PENDING — it can sign in to nothing', person?.status === 'pending', `status=${person?.status}`)
    check('it asked for this team', person?.requested_team_id === team.id)
    check('it kept the code\'s role', person?.requested_role === 'tl1', `role=${person?.requested_role}`)
    check('recording consent is recorded', person?.recording_consent === true)
    check('and dated by the database, not the app', !!person?.recording_consent_at)
    check('the data clause is dated too', !!person?.privacy_accepted_at)

    const { data: membership } = await sb.from('memberships')
      .select('id').eq('user_id', person?.id as string).maybeSingle()
    check('NO membership until a manager approves', !membership)

    const { data: afterUse } = await sb.from('invitations').select('used_count').eq('id', code.id).single()
    check('one use of the code was spent', afterUse?.used_count === 1, `used_count=${afterUse?.used_count}`)

    const { data: ev } = await sb.from('events')
      .select('action, details').eq('action', 'join.requested')
      .order('ts', { ascending: false }).limit(5)
    const mine = (ev || []).find((e) => (e.details as { to?: string })?.to === email)
    check('the manager and admin can see it happened', !!mine)

    // ── a second team, for an account that already exists ───────────────────
    //
    // Wijbren's case, 8 October: a coach in one team scans another team's QR
    // code. The route used to refuse him with "sign in first, then open this
    // link again", which was a loop — the sign-in page has never sent anybody
    // back to a join link. A user may hold several memberships, so this is an
    // ordinary request; what it must NOT do is make a second account, change
    // the password of the first, or grant anything before a manager presses
    // Approve.
    console.log(`\n  A second team for an account that already exists${otherTeam.id === team.id ? ' (one team in the database, so: a team they are not in)' : ''}:`)
    const email2 = freshEmail()
    const madeUser = await sb.auth.admin.createUser({
      email: email2, password: GOOD_PW, email_confirm: true,
      user_metadata: { name: 'SSA self-test, already a member', privacy_accepted: true, recording_consent: true },
    })
    const id2 = madeUser.data?.user?.id as string | undefined
    if (madeUser.error || !id2) fail(`could not set up the existing-account case: ${madeUser.error?.message}`)
    tempUsers.push(id2)
    // As if a manager had admitted them once already: active, and — when there
    // are two teams — a membership in the OTHER one.
    await sb.from('users').update({ status: 'active' }).eq('id', id2)
    let firstMembership: string | null = null
    if (otherTeam.id !== team.id) {
      const { data: m } = await sb.from('memberships')
        .insert({ user_id: id2, team_id: team.id, boat_id: null, role: 'tl1' })
        .select('id').maybeSingle()
      firstMembership = (m?.id as string) || null
    }

    const code2 = await makeCode(otherTeam.id); made.push(code2.id)

    const wrongPw = await post(code2.token, {
      ...ok, email: email2, password: 'definitely-not-the-password', confirm: 'definitely-not-the-password',
    })
    check('the wrong password for an existing account is refused',
      wrongPw.status === 401 && /not its password/i.test(wrongPw.error || ''),
      `${wrongPw.status} ${wrongPw.error || ''}`)
    const { data: unspent2 } = await sb.from('invitations').select('used_count').eq('id', code2.id).single()
    check('a wrong password spends no use of the code', unspent2?.used_count === 0, `used_count=${unspent2?.used_count}`)

    const second = await post(code2.token, { ...ok, email: email2 })
    check('their own password files a second-team request',
      second.status === 200 && second.ok === true, `${second.status} ${second.error || ''}`)
    check('and says it is on the account they already have',
      /already have/i.test(second.message || ''), second.message || '')

    const { data: dupRows } = await sb.from('users').select('id').ilike('email', email2)
    check('no second account was made', (dupRows || []).length === 1, `${(dupRows || []).length} row(s)`)

    const { data: after2 } = await sb.from('users')
      .select('id, status, requested_team_id, requested_role').eq('id', id2).maybeSingle()
    check('they are still ACTIVE — joining a second team does not demote them',
      after2?.status === 'active', `status=${after2?.status}`)
    check('the new team is on the request, where the manager\'s queue looks',
      after2?.requested_team_id === otherTeam.id)
    check('with the code\'s role', after2?.requested_role === 'tl1', `role=${after2?.requested_role}`)

    const { data: mems2 } = await sb.from('memberships').select('id, team_id').eq('user_id', id2)
    check('NO membership in the new team until a manager approves',
      !(mems2 || []).some((m) => m.team_id === otherTeam.id), `${(mems2 || []).length} membership(s)`)
    if (firstMembership) {
      check('and the team they were already in is untouched',
        (mems2 || []).some((m) => m.id === firstMembership))
    }

    const { data: spent2 } = await sb.from('invitations').select('used_count').eq('id', code2.id).single()
    check('one use of the code was spent', spent2?.used_count === 1, `used_count=${spent2?.used_count}`)

    // The guard that was always the real point of refusing an existing address:
    // their password must still be their password. Needs the anon key, because
    // the service key can sign in as anybody and so proves nothing.
    if (env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
      })
      const { error: pwErr } = await anon.auth.signInWithPassword({ email: email2, password: GOOD_PW })
      check('their password is still their password — the QR code reset nothing',
        !pwErr, pwErr?.message || '')
      await anon.auth.signOut()
    } else {
      check('their password is still their password — the QR code reset nothing',
        true, '(skipped — NEXT_PUBLIC_SUPABASE_ANON_KEY not in .env.local)')
    }

    const { data: ev2 } = await sb.from('events')
      .select('action, details').eq('action', 'join.requested')
      .order('ts', { ascending: false }).limit(10)
    const mine2 = (ev2 || []).find((e) => (e.details as { to?: string })?.to === email2)
    check('the audit trail says it was an existing account',
      (mine2?.details as { existing_account?: boolean })?.existing_account === true)
  } finally {
    console.log('')
    for (const id of tempUsers) {
      // Memberships first: this one was given one on purpose, and a leftover
      // membership is somebody in a team nobody put there.
      await sb.from('memberships').delete().eq('user_id', id)
      const { error } = await sb.auth.admin.deleteUser(id)
      console.log(`  ${error ? `✕ EXISTING-ACCOUNT TEST USER ${id} LEFT BEHIND — delete it by hand (${error.message})` : '✓ existing-account test user removed'}`)
      if (error) failures++
    }
    for (const id of users) {
      if (keep) {
        // Deliberately left. Say exactly what to do with it, because an account
        // nobody remembers making is worse than no test at all.
        console.log(`  ⚠ KEPT: ${keptEmail} is pending in ${team.name}.`)
        console.log(`      Approve it in SSA → ${base}/admin/teams/${team.id}`)
        console.log('      That is the last step in either road that no script can take:')
        console.log('      watch for the "You are in" email, and check the panel for a')
        console.log('      warning if it did not send.')
        console.log('      Then remove it:')
        console.log(`      npm run auth:selftest2 -- --delete ${keptEmail}`)
        continue
      }
      // Deleting the auth user cascades to public.users.
      const { error } = await sb.auth.admin.deleteUser(id)
      console.log(`  ${error ? `✕ TEST ACCOUNT ${id} LEFT BEHIND — delete it by hand (${error.message})` : '✓ test account removed'}`)
      if (error) failures++
    }
    for (const id of made) await sb.from('invitations').delete().eq('id', id)
    const { data: left } = await sb.from('invitations').select('id').in('id', made.length ? made : ['none'])
    console.log(`  ${left && left.length ? '✕ TEST CODES LEFT BEHIND' : '✓ test join codes removed'}`)
    if (left && left.length) failures++
  }

  console.log(failures
    ? `\n✕ ${failures} check(s) failed — Road 2 is not safe to put on a boat.\n`
    : keep
      ? '\n✓ Road 2 is sound up to the approval — that part is yours to press, above.\n'
      : `\n✓ Road 2 is sound${full ? '' : ' as far as the refusals go — run --full for the rest'}.\n`)
  process.exit(failures ? 1 : 0)
}
// Anything that got past the guards above still ends in a sentence, not in a
// promise rejection trace.
main().catch((e) => fail((e as Error)?.message || String(e)))
