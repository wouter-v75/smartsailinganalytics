// scripts/clip-row-check.ts — does the cloud row agree with the clip's own name?
//
//   npx vite-node scripts/clip-row-check.ts -- 2026-10-02
//   npx vite-node scripts/clip-row-check.ts -- 2026-10-02 --write
//
// WHY. A clip is shown from two different places and they can disagree. The
// Videos tab reads this device's local record, whose start time settles after
// the timestamp probe finishes. The TIMELINE reads the cloud `videos` row — and
// that row is written once, at upload, from the local record as it stood at that
// instant, then never rewritten. A clip uploaded mid-probe keeps its provisional
// start for ever: on 2 October some sat in the timeline at 11:00, the hour they
// were encoded, while the Videos tab showed them correctly.
//
// The cutter's filenames are the one thing that is certainly right — a segment
// is named for the moment it was cut from, in venue-local time. So this compares
// the two and says which rows disagree.
//
// It can only speak for clips whose NAME carries a stamp: the cutter's own, and
// anything off a DJI. A RIB camera that names its files GX010041.MP4 says
// nothing, and those rows are listed as unverifiable rather than guessed at.
//
// Read-only without --write, like everything else here.

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { planRowFixes, stampInName, type ClipRow } from '../src/lib/clipRowRepair'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }

const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || fail('give a date: YYYY-MM-DD')
const write = has('--write')

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

const clock = (iso: string | null, tzMin: number) =>
  iso ? new Date(Date.parse(iso) + tzMin * 60_000).toISOString().slice(11, 19) : '—'

const main = async () => {
  // The venue offset decides what the name's wall clock MEANS. Never guessed.
  let tzMin: number | null = has('--tz') ? Math.round(Number(val('--tz') ?? 0) * 60) : null
  let tzFrom = '--tz'
  const { data: sessions } = await sb
    .from('sessions').select('id, tz_offset_minutes').eq('date', date).limit(1)
  const session = sessions?.[0]
  if (tzMin == null && session?.tz_offset_minutes != null) {
    tzMin = Number(session.tz_offset_minutes); tzFrom = "the session's stored offset"
  }
  if (tzMin == null) fail(`no venue offset for ${date}: the session has none stored. Pass --tz 2 for UTC+2.`)
  if (!session?.id) fail(`no session row for ${date}`)

  const { data, error } = await sb
    .from('videos').select('id, title, start_utc, tags')
    .eq('session_id', session.id)
    .order('start_utc')
  if (error) fail(`reading videos: ${error.message}`)
  const rows = (data || []) as ClipRow[]
  if (!rows.length) { console.log(`\n${date}  no video rows in the cloud for this day\n`); return }

  const unverifiable = rows.filter((r) => stampInName(String(r.title || '')) == null)
  const fixes = planRowFixes(rows, tzMin)

  console.log(`\n${date}  ${rows.length} cloud row(s) · venue UTC${tzMin >= 0 ? '+' : ''}${tzMin / 60} (from ${tzFrom})`)
  console.log(`  ${rows.length - unverifiable.length} carry a timestamp in the name and can be checked` +
    (unverifiable.length ? `, ${unverifiable.length} cannot` : ''))

  if (!fixes.length) console.log('  ✓ every checkable row agrees with its own filename')
  for (const f of fixes) {
    const drift = f.driftMs == null ? 'no start stored' : `${f.driftMs > 0 ? '+' : ''}${Math.round(f.driftMs / 1000)}s`
    console.log(`  ${f.title}`)
    if (f.startUtc) {
      console.log(`      timeline shows ${clock(f.wasStartUtc, tzMin)} · the name says ${clock(f.startUtc, tzMin)}  (${drift})`)
    }
    if (f.tags) console.log(`      tags: + drone`)
  }

  if (unverifiable.length) {
    console.log(`\n  No timestamp in the name, so nothing here can check them — if one of these is`)
    console.log(`  wrong in the timeline, re-save its start time in the Videos tab, which pushes`)
    console.log(`  the local record (the right one) to the cloud row:`)
    for (const r of unverifiable) console.log(`      ${r.title || r.id}   timeline shows ${clock(r.start_utc, tzMin)}`)
  }

  if (!fixes.length) { console.log('') ; return }
  if (!write) { console.log(`\nThat was a dry run. Same command with --write to correct ${fixes.length} row(s).\n`); return }

  let done = 0
  for (const f of fixes) {
    const patch: Record<string, unknown> = {}
    if (f.startUtc) patch.start_utc = f.startUtc
    if (f.tags) patch.tags = f.tags
    const { error: e } = await sb.from('videos').update(patch).eq('id', f.id)
    if (e) console.log(`  ✕ ${f.title}: ${e.message}`)
    else done++
  }
  console.log(`\n✓ corrected ${done} of ${fixes.length} row(s) — reload the timeline\n`)
}
main()
