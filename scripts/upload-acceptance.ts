// scripts/upload-acceptance.ts
// ─────────────────────────────────────────────────────────────────────────────
// DID BOTH UPLOAD ROUTES DELIVER, AND DOES EVERY TAB AGREE? Read-only.
//
// The acceptance check the two routes never had. src/lib/uploadFlows.ts says
// what the architecture IS; this says whether a day's clips actually came
// through it, by asking Bunny rather than trusting the row.
//
// WHY A ROW PROVES NOTHING. `ensureCloudVideoId()` creates the row so the
// upload has somewhere to land, and the bytes follow separately — or do not.
// So "the clip is in the cloud" and "a row exists" are different claims, and
// the live data has 7 rows with NO locator in any column: not failed uploads
// that reported failure, rows that were never going to hold anything. Nothing
// in the app distinguishes uploading from never-arrived.
//
// WHAT IT CHECKS, per clip:
//
//   A delivered   a proxy — bunny_proxy_stream_id live in Stream, or a
//                 bunny_proxy_path that looks like a real object.
//   B delivered   an original — bunny_original_stream_id live, or
//                 bunny_original_path.
//   served        which rendition a player is actually handed, by running the
//                 app's own renditionOrder against what EXISTS. This is the
//                 number that matters: a row with three locators that all
//                 point at nothing serves nothing.
//   flags agree   has_proxy / has_original against reality. A flag set with no
//                 locator behind it is why a tab shows a clip it cannot play —
//                 the player only calls /url when a flag is set.
//   session       the row's session day against the timestamp in its own
//                 title, since those are written by different things.
//
//   npx vite-node scripts/upload-acceptance.ts --date 2026-11-27
//   npx vite-node scripts/upload-acceptance.ts --date 2026-11-27 --boat "Northstar 76"
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { retryingFetch, why } from './lib/netFetch'
import { renditionOrder } from '../src/lib/renditionOrder'

const argv = process.argv.slice(2)
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }
const argOf = (f: string) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const date = argOf('--date')
const boatName = argOf('--boat')
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date YYYY-MM-DD is required')

const envPath = resolve(process.cwd(), '.env.local')
if (!existsSync(envPath)) fail('.env.local not found — run from the repo root')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
) as Record<string, string>
for (const k of [
  'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'BUNNY_STREAM_API_KEY', 'BUNNY_STREAM_LIBRARY_ID',
]) if (!env[k]) fail(`${k} missing from .env.local`)

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  global: { fetch: retryingFetch },
})

interface Vid { guid: string; status: number; storageSize: number; height: number; availableResolutions: string | null }

async function streamLibrary(): Promise<Map<string, Vid>> {
  const out = new Map<string, Vid>()
  const onePage = async (n: number) => {
    let last: unknown
    for (let a = 0; a < 3; a++) {
      try {
        const res = await retryingFetch(
          `https://video.bunnycdn.com/library/${env.BUNNY_STREAM_LIBRARY_ID}` +
          `/videos?page=${n}&itemsPerPage=100&orderBy=date`,
          { headers: { AccessKey: env.BUNNY_STREAM_API_KEY } }
        )
        if (!res.ok) fail(`Bunny list HTTP ${res.status} on page ${n}`)
        return (await res.json()) as { items?: Vid[]; totalItems?: number }
      } catch (e) { last = e; if (a < 2) await new Promise((r) => setTimeout(r, 500 * (a + 1))) }
    }
    fail(`Bunny list page ${n}: ${why(last)}`)
  }
  for (let page = 1; page <= 200; page++) {
    const j = await onePage(page)
    const items = j.items || []
    if (!items.length) break
    let fresh = 0
    for (const v of items) if (!out.has(v.guid)) { out.set(v.guid, v); fresh++ }
    if (!fresh) break
    if (j.totalItems && out.size >= j.totalItems) break
  }
  return out
}

interface Row {
  id: string
  title: string | null
  external_id: string | null
  start_utc: string | null
  duration_ms: number | null
  bytes: number | null
  tags: string[] | null
  created_at: string | null
  has_proxy: boolean | null
  has_original: boolean | null
  bunny_stream_id: string | null
  bunny_proxy_stream_id: string | null
  bunny_original_stream_id: string | null
  bunny_proxy_path: string | null
  bunny_original_path: string | null
  bunny_storage_path: string | null
  boats: { name: string } | null
  sessions: { date: string } | null
}

const mb = (b: number | null) => (b ? `${(b / 1e6).toFixed(1)} MB` : '—')

/** The timestamp a clip's own title claims, as a day. */
function dayFromTitle(t: string | null): string | null {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(t || '')
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

async function main() {
  let boatId: string | null = null
  if (boatName) {
    const { data } = await db.from('boats').select('id').ilike('name', boatName).maybeSingle()
    if (!data) fail(`no boat called "${boatName}"`)
    boatId = data.id
  }

  const { data: sessions } = await db.from('sessions').select('id, date, boat_id').eq('date', date)
  const sessionIds = (sessions || []).filter((s) => !boatId || s.boat_id === boatId).map((s) => s.id)
  if (!sessionIds.length) fail(`no session for ${date}${boatName ? ` on ${boatName}` : ''} — nothing has been uploaded for that day`)

  let q = db.from('videos').select(
    'id, title, external_id, start_utc, duration_ms, bytes, tags, created_at,' +
    ' has_proxy, has_original, bunny_stream_id, bunny_proxy_stream_id, bunny_original_stream_id,' +
    ' bunny_proxy_path, bunny_original_path, bunny_storage_path,' +
    ' boats:boats(name), sessions:sessions(date)'
  ).in('session_id', sessionIds).order('created_at', { ascending: true })
  const settled = await Promise.allSettled([q, streamLibrary()])
  if (settled[0].status === 'rejected') fail(`Supabase rows: ${why(settled[0].reason)}`)
  if (settled[1].status === 'rejected') fail(`Bunny Stream library: ${why(settled[1].reason)}`)
  const { data, error } = settled[0].value as { data: unknown; error: { message: string } | null }
  if (error) fail(`Supabase: ${error.message}`)
  const rows = (data || []) as unknown as Row[]
  const lib = settled[1].value

  const liveGuid = (g: string | null | undefined) =>
    !!g && (lib.get(g)?.storageSize || 0) > 0
  const realPath = (p: string | null | undefined) => !!p && /\.mp4$/i.test(p)

  console.log(`${date}: ${rows.length} clip row(s)${boatName ? ` on ${boatName}` : ''}` +
    ` · ${lib.size} videos in the Stream library\n`)
  if (!rows.length) { console.log('nothing to check.'); return }

  let aOk = 0, bOk = 0, servesNothing = 0, lying = 0, dayOff = 0, legacyOnly = 0
  for (const r of rows) {
    const A = liveGuid(r.bunny_proxy_stream_id) || realPath(r.bunny_proxy_path)
    const B = liveGuid(r.bunny_original_stream_id) || realPath(r.bunny_original_path)

    // What a player is actually handed — the app's own order over what EXISTS.
    const exists: Record<string, boolean> = {
      originalHls: liveGuid(r.bunny_original_stream_id),
      proxy: liveGuid(r.bunny_proxy_stream_id) || realPath(r.bunny_proxy_path),
      originalMp4: realPath(r.bunny_original_path),
      legacyStream: liveGuid(r.bunny_stream_id),
      legacy: realPath(r.bunny_storage_path),
    }
    const served = renditionOrder('auto').find((s) => exists[s]) || null

    const flagIssues: string[] = []
    if (r.has_proxy && !A) flagIssues.push('has_proxy set, no proxy exists')
    if (!r.has_proxy && A) flagIssues.push('proxy exists, has_proxy NOT set')
    if (r.has_original && !B) flagIssues.push('has_original set, no original exists')
    if (!r.has_original && B) flagIssues.push('original exists, has_original NOT set')

    const titleDay = dayFromTitle(r.title)
    const dayMismatch = titleDay && titleDay !== date

    // Served by a path that NO LONGER EXISTS. It plays, so a "serves a real
    // rendition" test passes it — and that is what this check was blind to on
    // its first live run: both supported routes delivered 0 of 2 and the
    // verdict still read ✓, because a warm browser bundle had uploaded through
    // the flow removed in 70dc9ba. A clip nothing current can reproduce is not
    // a pass.
    const viaRemovedFlow = !A && !B && (served === 'legacyStream' || served === 'legacy')
    if (A) aOk++
    if (B) bOk++
    if (viaRemovedFlow) legacyOnly++
    if (!served) servesNothing++
    if (flagIssues.length) lying++
    if (dayMismatch) dayOff++

    console.log(`── ${r.title || '(no title)'}`)
    console.log(`   ${r.id}  ${mb(r.bytes).padStart(9)}  ` +
      `${r.duration_ms ? (r.duration_ms / 1000).toFixed(0) + ' s' : '—'}  ` +
      `created ${r.created_at?.slice(0, 16) || '—'}  tags ${r.tags?.length || 0}`)
    console.log(`   A proxy    ${A ? '✓ delivered' : '✕ NOT in the cloud'}` +
      `   ${r.bunny_proxy_stream_id ? `stream ${r.bunny_proxy_stream_id.slice(0, 8)}${liveGuid(r.bunny_proxy_stream_id) ? '✓' : '✕'}` : ''}` +
      `${r.bunny_proxy_path ? `  path ${realPath(r.bunny_proxy_path) ? '✓' : '✕'}` : ''}`)
    console.log(`   B original ${B ? '✓ delivered' : '— not uploaded'}` +
      `   ${r.bunny_original_stream_id ? `stream ${r.bunny_original_stream_id.slice(0, 8)}${liveGuid(r.bunny_original_stream_id) ? '✓' : '✕'}` : ''}` +
      `${r.bunny_original_path ? `  path ${realPath(r.bunny_original_path) ? '✓' : '✕'}` : ''}`)
    console.log(`   a player gets: ${served || '✕ NOTHING — every locator on this row is empty or dead'}`)
    if (viaRemovedFlow) {
      console.log(`   ⚠ delivered ONLY by the upload flow removed in 70dc9ba — it plays, but`)
      console.log(`     nothing in the app can produce this any more. A warm browser bundle is`)
      console.log(`     the usual cause: hard-reload (Cmd-Shift-R) and upload again.`)
    }
    for (const f of flagIssues) console.log(`   ⚠ ${f}`)
    if (dayMismatch) {
      console.log(`   ⚠ the title says ${titleDay} but the row is filed under ${date}`)
    }
  }

  console.log(`\n════ VERDICT for ${date} ════`)
  console.log(`  Flow A (proxy)     ${aOk}/${rows.length} delivered`)
  console.log(`  Flow B (original)  ${bOk}/${rows.length} delivered`)
  console.log(`  via a SUPPORTED route ${rows.length - legacyOnly - servesNothing}/${rows.length}` +
    (legacyOnly ? `   ← ${legacyOnly} came ONLY via the REMOVED flow` : ''))
  console.log(`  playable           ${rows.length - servesNothing}/${rows.length}` +
    (servesNothing ? `   ← ${servesNothing} row(s) serve NOTHING` : ''))
  console.log(`  flags truthful     ${rows.length - lying}/${rows.length}` +
    (lying ? `   ← ${lying} row(s) claim a rendition they do not have` : ''))
  if (dayOff) console.log(`  ⚠ ${dayOff} row(s) filed under a different day than their own title`)
  if (!servesNothing && !lying && !dayOff && !legacyOnly && aOk === rows.length) {
    console.log(`\n  ✓ every row came through a supported route, serves a real rendition,`)
    console.log(`    and says so truthfully.`)
  } else if (rows.length && legacyOnly === rows.length) {
    console.log(`\n  ✕ NOT A PASS: every clip here arrived by the REMOVED flow. The app in`)
    console.log(`    that browser is not the app in this repo — hard-reload and upload again.`)
  } else if (aOk < rows.length) {
    console.log(`\n  ✕ NOT A PASS: ${rows.length - aOk} of ${rows.length} clip(s) have no proxy. Flow A is the`)
    console.log(`    automatic route, so a clip without one is a clip the team waits on.`)
  }
  console.log(`\nNothing has been changed.`)
}

main().catch((e) => fail(why(e)))
