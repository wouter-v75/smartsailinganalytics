// Where did that tag go?
//
//   npx vite-node scripts/tag-find.ts -- --slug race-finish
//   …plus --boat "Baraka GP", --days 14, --date 2026-10-09, --all
//
// READ-ONLY. No --write.
//
// A tag carries TWO times and nothing keeps them in step:
//
//   t0            the instant the crew pressed the button. Always right.
//   session_date  the day the app HAPPENED TO BE SHOWING when they pressed it.
//
// So a tag made on a phone that was showing yesterday is filed under yesterday:
// correctly timed, stored, never rejected, and invisible on the day it belongs
// to. That is the bug 0095 refiled a batch of — but only the ones filed in the
// FUTURE, because that is the only case needing no judgement (nobody has sailed
// tomorrow). A tag filed a day or two EARLY looks exactly like a legitimate tag
// from a session that ran through local midnight, so nothing can refile it
// automatically and nothing has ever pointed it out.
//
// This points it out. Every tag is listed with where it is FILED and where its
// own t0 says it belongs, and the two are compared.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { retryingFetch, why } from './lib/netFetch'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const SLUG = arg('slug')
const BOAT = arg('boat')
const DATE = arg('date')
const DAYS = Number(arg('days') || 14)
const ALL = process.argv.includes('--all')
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
  global: { fetch: retryingFetch },
})

const pad = (s: unknown, n: number) => String(s ?? '').slice(0, n).padEnd(n)

const main = async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10)

  let q = sb.from('ssa_tag_events')
    .select('id, boat_id, session_date, slug, label, t0, source, producer, rejected, '
          + 'owner_user_id, scope, created_by_user_id, created_at, boats(name)')
    .order('created_at', { ascending: false })
    .limit(200)
  if (SLUG) q = q.eq('slug', SLUG)
  if (DATE) q = q.eq('session_date', DATE)
  else if (!ALL) q = q.gte('created_at', `${since}T00:00:00Z`)

  const { data, error } = await q
  if (error) fail(`ssa_tag_events: ${why(error)}`)
  let rows = (data || []) as any[]
  if (BOAT) rows = rows.filter((r) => String(r.boats?.name || '').toLowerCase() === BOAT.toLowerCase())

  if (!rows.length) {
    console.log(`\n  No ${SLUG ? `"${SLUG}" ` : ''}tags ${DATE ? `on ${DATE}` : `created in the last ${DAYS} days`}`
      + `${BOAT ? ` for "${BOAT}"` : ''}.`)
    console.log('\n  If you are sure you pressed it, the press did not reach the database —')
    console.log('  not a filing problem. Check the phone was signed in and online, and that the')
    console.log('  tag sheet did not show an error when it closed.\n')
    return
  }

  // Each boat's sessions, for the venue offset its own day was recorded with.
  const dates = Array.from(new Set(rows.map((r) => r.session_date)))
  const { data: sessions } = await sb.from('sessions')
    .select('boat_id, date, tz_offset_minutes').in('date', dates)
  const tzOf = (boatId: string, date: string) =>
    (sessions || []).find((s: any) => s.boat_id === boatId && s.date === date)?.tz_offset_minutes ?? null

  console.log(`\n  ${rows.length} tag(s)${SLUG ? ` of "${SLUG}"` : ''}, newest first\n`)
  console.log(`  ${pad('filed under', 12)}${pad('t0 (local)', 18)}${pad('slug', 14)}`
            + `${pad('boat', 14)}${pad('by', 10)}where t0 says it belongs`)

  let mismatched = 0
  for (const r of rows) {
    const tz = tzOf(r.boat_id, r.session_date)
    const off = (tz ?? 120) * 60_000          // 120 = CEST, the usual venue
    const t0 = new Date(r.t0).getTime()
    const localIso = new Date(t0 + off).toISOString()
    const belongs = localIso.slice(0, 10)
    const bad = belongs !== r.session_date
    if (bad) mismatched++
    console.log(`  ${pad(r.session_date, 12)}${pad(localIso.slice(0, 16).replace('T', ' '), 18)}`
      + `${pad(r.slug, 14)}${pad(r.boats?.name, 14)}${pad(r.source, 10)}`
      + `${bad ? `⚠ ${belongs}${tz == null ? '  (no session row: assumed +2 h)' : ''}` : 'same day ✓'}`)
  }

  if (mismatched) {
    console.log(`\n  ⚠ ${mismatched} tag(s) are filed under a day their own t0 disagrees with.`)
    console.log('    That is what makes a tag invisible: the tagger asks for one session_date')
    console.log('    and these answer to another. A session running through local midnight is')
    console.log('    the legitimate version of this, so check the times before moving anything.')
    console.log('    To refile one, open the day it IS filed under and drag it, or ask for a')
    console.log('    migration naming these ids.')
  } else {
    console.log('\n  ✓ Every tag is filed under the day its own t0 agrees with.')
    console.log('    So if one is not on screen, it is not a filing problem — check the BOAT')
    console.log('    (a tag belongs to one boat; another boat\'s day will not show it) and that')
    console.log('    the tagger is open on the date in the "filed under" column.')
  }
  console.log('')
}

main().catch((e) => fail(why(e)))
