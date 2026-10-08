// scripts/auth-selftest.ts — does Road 1 actually work, end to end, today?
//
//   npm run auth:selftest                 (against http://localhost:3000)
//   npm run auth:selftest -- --base https://ssa.wvsailing.co.uk
//
// WHY A SCRIPT. Road 1 has now been rebuilt twice because it broke in a way no
// test could see: the first version could not work for anybody, the second
// worked until a mail client fetched the link. Both were found by a person
// failing to get in, days later. This drives the real thing — a real
// invitation row, the real route, the real database — so the answer is known
// before somebody is standing on a dock with a phone.
//
// It creates ONE inert invitation row for an address that cannot exist
// (@example.invalid is reserved by RFC 2606), reads it back through
// /welcome/<token>, and deletes it. No account is created, nothing is emailed,
// and the row is removed whether the checks pass or fail.
//
// It does NOT set a password: that needs a real account, and making one on the
// live database to test with is how test users end up in a team's crew list.
// The last step — a real invite to a real address — is the one a human does.

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { retryingFetch, why } from './lib/netFetch'

const args = process.argv.slice(2)
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const base = (val('--base') || 'http://localhost:3000').replace(/\/$/, '')
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }

const envPath = resolve(process.cwd(), '.env.local')
if (!existsSync(envPath)) fail('.env.local not found — run from the repo root')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
)
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) fail(`${k} missing from .env.local — the welcome page needs it too, so this is itself the bug`)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  global: { fetch: retryingFetch },
})

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

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✕'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

const main = async () => {
  console.log(`\nRoad 1 self-test against ${base}\n`)

  const warn = mailWarning()
  if (warn) console.log(`${warn}\n`)

  const { data: team } = await sb.from('teams').select('id, name').limit(1).maybeSingle()
  if (!team) fail('no teams in the database to attach a test invitation to')

  const token = `ssa-selftest-${Date.now().toString(36)}`
  const { data: row, error } = await sb.from('invitations').insert({
    team_id: team.id,
    email: 'selftest@example.invalid',
    role: 'tl1',
    token,
    auto_approve: true,
    max_uses: 1,
    used_count: 0,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }).select('id').single()
  if (error || !row) fail(`could not create the test invitation: ${error ? why(error) : 'no row came back'}`)

  try {
    const res = await fetch(`${base}/welcome/${token}`)
    const html = await res.text()
    check('the page answers 200', res.status === 200, `got ${res.status}`)
    check('it is the password form', /name="password"/.test(html) && /name="confirm"/.test(html))
    check('the address is shown, read-only', /selftest@example\.invalid/.test(html) && /readonly/.test(html))
    check('it does not submit the address', !/name="email"/.test(html))
    check('the team is named', html.includes(team.name))
    check('the token is carried into the POST', html.includes(token))
    check('search engines are told to stay out', /noindex/.test(html))
    check('nothing may cache it', (res.headers.get('cache-control') || '').includes('no-store'))

    // THE ONE THAT MATTERS: a GET must not spend the invitation. This is the
    // failure that killed Gwen's link — a mail client fetched it first.
    const { data: afterGet } = await sb.from('invitations').select('used_count').eq('id', row.id).single()
    check('a GET spends nothing', afterGet?.used_count === 0, `used_count=${afterGet?.used_count}`)

    // A mistyped confirmation must cost a retype, not the invitation.
    const body = new URLSearchParams({ password: 'a-long-enough-one', confirm: 'not-the-same' })
    const bad = await fetch(`${base}/welcome/${token}`, {
      method: 'POST', body, redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    const badHtml = await bad.text()
    check('a mismatch says so', /do not match/.test(badHtml))
    const { data: afterBad } = await sb.from('invitations').select('used_count').eq('id', row.id).single()
    check('a mismatch spends nothing', afterBad?.used_count === 0, `used_count=${afterBad?.used_count}`)

    // An expired invitation must say "expired", not "not found".
    await sb.from('invitations')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', row.id)
    const dead = await fetch(`${base}/welcome/${token}`)
    const deadHtml = await dead.text()
    check('an expired link says it expired', /expired/i.test(deadHtml) && dead.status === 410, `got ${dead.status}`)
    check('and points at Forgot password', /Forgot password/i.test(deadHtml))
  } finally {
    await sb.from('invitations').delete().eq('id', row.id)
    const { data: gone } = await sb.from('invitations').select('id').eq('id', row.id).maybeSingle()
    console.log(`\n  ${gone ? '✕ TEST ROW LEFT BEHIND — delete it by hand' : '✓ test invitation removed'}`)
  }

  console.log(failures
    ? `\n✕ ${failures} check(s) failed — Road 1 is not safe to send to anybody.\n`
    : '\n✓ Road 1 is sound: the form serves, the link survives being fetched, and a dead one says why.\n')
  process.exit(failures ? 1 : 0)
}
// Any throw still ends in a sentence rather than a promise-rejection trace.
main().catch((e) => fail(why(e)))
