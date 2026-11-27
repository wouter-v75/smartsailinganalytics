// scripts/video-rows-provenance.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHERE DID THESE ROWS COME FROM? Read-only, no --write.
//
// Written 27 Nov 2026 because the row count went 367 -> 453 in a day and Wouter
// uploaded nothing. 86 rows is not a rounding error and "I didn't do that" is a
// fact to explain, not to dismiss.
//
// THE THING TO UNDERSTAND FIRST: a `videos` row is NOT evidence that a clip was
// uploaded. `ensureCloudVideoId()` mints the row so the proxy has somewhere to
// land, and the bytes follow separately — or do not. So a device that merely
// OPENS the app with a day's clips still in its IndexedDB can create rows
// without anyone choosing to upload anything. `external_id` is that device's own
// key, minted per import, so the dedupe in the upsert cannot match a row another
// device already made: the same clip arrives again as a new row.
//
// That is consistent with what the duplicate audit found — seven of the eleven
// redundant rows have NO LOCATOR IN ANY COLUMN. Those are not failed uploads.
// They are rows that were never going to hold anything.
//
// So this splits the rows by the DAY THEY WERE CREATED and, for each, says how
// many can actually play, how many are bare metadata, and which device
// (external_id prefix) and session they claim. A burst on one day from one
// device shape, all without locators, is the pattern above. A burst with
// locators is a real upload. A burst with no external_id at all is the admin
// backfill, which builds rows from Bunny objects.
//
//   npx vite-node scripts/video-rows-provenance.ts
//   npx vite-node scripts/video-rows-provenance.ts --since 2026-11-01
//   npx vite-node scripts/video-rows-provenance.ts --day 2026-11-26   # row by row
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }
const argOf = (f: string) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const since = argOf('--since')
const oneDay = argOf('--day')

const envPath = resolve(process.cwd(), '.env.local')
if (!existsSync(envPath)) fail('.env.local not found — run from the repo root')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
) as Record<string, string>
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) fail(`${k} missing from .env.local`)
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

interface Row {
  id: string
  created_at: string | null
  title: string | null
  external_id: string | null
  bytes: number | null
  tags: string[] | null
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

const locators = (r: Row) => [
  r.bunny_proxy_stream_id, r.bunny_original_stream_id, r.bunny_stream_id,
  r.bunny_proxy_path, r.bunny_original_path, r.bunny_storage_path,
].filter(Boolean).length

/**
 * The SHAPE of a device's external_id, not the id itself.
 *
 * A local IDB key looks like `v_1779…` — the prefix plus the length is enough to
 * tell one writer from another without printing keys that identify a device.
 */
const idShape = (x: string | null) => {
  if (!x) return 'none (server-made)'
  const m = x.match(/^([A-Za-z_-]+)/)
  return `${m ? m[1] : '?'}… (${x.length} ch)`
}

async function main() {
  let q = db.from('videos').select(
    'id, created_at, title, external_id, bytes, tags, has_proxy, has_original,' +
    ' bunny_stream_id, bunny_proxy_stream_id, bunny_original_stream_id,' +
    ' bunny_proxy_path, bunny_original_path, bunny_storage_path,' +
    ' boats:boats(name), sessions:sessions(date)'
  ).order('created_at', { ascending: true })
  if (since) q = q.gte('created_at', since)
  const { data, error } = await q
  if (error) fail(error.message)
  const rows = (data || []) as unknown as Row[]

  console.log(`${rows.length} rows${since ? ` created on or after ${since}` : ''}\n`)

  const byDay = new Map<string, Row[]>()
  for (const r of rows) {
    const d = (r.created_at || '').slice(0, 10) || 'unknown'
    const g = byDay.get(d) || []
    g.push(r); byDay.set(d, g)
  }

  console.log('created     rows  playable  bare  tagged   writer shapes')
  console.log('─────────────────────────────────────────────────────────────────────')
  for (const d of Array.from(byDay.keys()).sort()) {
    const g = byDay.get(d) || []
    const playable = g.filter((r) => locators(r) > 0).length
    const bare = g.length - playable
    const tagged = g.filter((r) => r.tags?.length).length
    const shapes = Array.from(new Set(g.map((r) => idShape(r.external_id))))
    console.log(
      `${d}  ${String(g.length).padStart(5)}  ${String(playable).padStart(8)}  ` +
      `${String(bare).padStart(4)}  ${String(tagged).padStart(6)}   ${shapes.join(' · ')}` +
      (bare === g.length && g.length > 1 ? '   ← NOTHING here holds bytes' : '')
    )
  }

  if (oneDay) {
    const g = byDay.get(oneDay) || []
    console.log(`\n── every row created ${oneDay} (${g.length}) ─────────────────────────`)
    for (const r of g) {
      console.log(
        `  ${r.created_at?.slice(11, 19)}  ${r.id.slice(0, 8)}  ` +
        `${(r.sessions?.date || 'no session').padEnd(12)} ${(r.boats?.name || '?').padEnd(14)} ` +
        `loc ${locators(r)}  tags ${String(r.tags?.length || 0).padStart(2)}  ` +
        `${idShape(r.external_id).padEnd(22)} ${r.title || ''}`
      )
    }
  }

  // The pattern worth naming: rows for a SESSION DAY long past, created in a
  // burst, with nothing behind them. That is a device catching up, not an
  // upload.
  const bare = rows.filter((r) => locators(r) === 0)
  if (bare.length) {
    const days = new Map<string, number>()
    for (const r of bare) {
      const d = r.sessions?.date || 'no session'
      days.set(d, (days.get(d) || 0) + 1)
    }
    console.log(`\n── ROWS WITH NO LOCATOR IN ANY COLUMN: ${bare.length} ───────────────────`)
    console.log(`These hold nothing and play nothing. A row is created BEFORE the bytes`)
    console.log(`are sent (ensureCloudVideoId), so this is the count of clips whose upload`)
    console.log(`never happened or never finished — not a count of lost footage.\n`)
    for (const [d, n] of Array.from(days.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  session ${d}: ${n}`)
    }
  }

  console.log(`\nNothing has been changed.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
