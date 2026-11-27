// scripts/video-row-dedupe.ts
// ─────────────────────────────────────────────────────────────────────────────
// Duplicate `videos` ROWS — the same clip filed more than once.
//
// Read-only. There is no --write: deciding which row survives is a judgement
// about which copy the team has been tagging and favouriting, and that is not
// a call a script should make on its own. It prints the groups, says which row
// it would keep and why, and gives you the SQL.
//
// NOT the same thing as scripts/stream-dedupe.ts, which is about duplicate
// VIDEOS IN BUNNY STREAM (one clip encoded two or three times). This is about
// duplicate ROWS pointing at them. It needs Bunny too, though — see below.
//
// HOW THE DUPLICATES GET IN. The upsert at
// /api/teams/[teamId]/boats/[boatId]/videos dedupes on `bunny_stream_id`, then
// on `external_id`. `external_id` is the IMPORTING DEVICE's IndexedDB key, and
// that is minted fresh on every import — so nothing matches and a new row is
// inserted. Two workflows walk into it:
//
//   • the same files imported twice (a retried or repeated drag-and-drop);
//   • `clips:day` re-run for a day already uploaded. The cut is deterministic
//     in NAME — `20260929153553 topmark 20260929 drone` — but NOT in bytes, so
//     two runs give two near-identical encodes under one title.
//
// WHAT IS NOT A DUPLICATE, and why the key is what it is: on 10 Sept two rows
// share a start time to the second and are different clips — `…race start day8
// drone` (146 MB) and `…race start day8 Camera` (36 MB), two cameras on the
// same moment. So the grouping key includes the TITLE. Start time alone would
// have merged them.
//
// THE DECISION IS NOT IN THIS FILE. It is `plan()` in
// src/lib/videoRowDedupe.ts, with the seven live groups pinned in
// src/lib/__tests__/videoRowDedupe.test.ts. Three versions of that rule have
// been wrong — each time because it counted non-null locator COLUMNS and called
// the number "renditions", and each time only real rows showed it:
//
//   a column is not a copy        two `IMG 2894` rows both read "1 rendition",
//                                 both legacy-guid-only, and one of those guids
//                                 points at a DELETED Stream video.
//   a different length is a       `20260929153553` is 100 s on one row and 90 s
//   different cut                 on the other. Not a duplicate.
//   nothing playing is not a      all four `11591` rows have no copy anywhere.
//   dedupe question
//
// So this file FETCHES — rows from Supabase, the Stream library from Bunny so
// every guid can be marked ✓ present or ✕ gone — and prints. Groups that need a
// human are held back from the SQL rather than listed under "redundant rows",
// because the SQL is the thing that gets pasted.
//
// Needs .env.local (Supabase + Bunny Stream) and must run OUTSIDE Claude Code's
// Bash sandbox. STORAGE paths are shape-checked, not probed, and shown `?`:
// that needs the Storage API and no group here turns on one. 0110 already
// cleared the invented-path shape, which is reported ✕.
//
//   npx vite-node scripts/video-row-dedupe.ts
//   npx vite-node scripts/video-row-dedupe.ts --boat "Northstar 76"
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { copies, describe, plan } from '../src/lib/videoRowDedupe'

const argv = process.argv.slice(2)
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }
const argOf = (flag: string): string | null => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}
const boatName = argOf('--boat')

// Same .env.local handling as the other scripts here — dotenv is not a
// dependency of this repo.
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
})

interface Row {
  id: string
  boat_id: string | null
  external_id: string | null
  title: string | null
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
  sessions: { date: string } | null
}

// ── Bunny: which Stream guids exist, and which of them hold bytes ────────────

interface Vid { guid: string; status: number; storageSize: number }

/** Identical paging to stream-dedupe.ts, including the repeat-last-page quirk. */
async function streamLibrary(): Promise<Map<string, Vid>> {
  const out = new Map<string, Vid>()
  for (let page = 1; page <= 200; page++) {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${env.BUNNY_STREAM_LIBRARY_ID}` +
      `/videos?page=${page}&itemsPerPage=100&orderBy=date`,
      { headers: { AccessKey: env.BUNNY_STREAM_API_KEY } }
    )
    if (!res.ok) fail(`Bunny list HTTP ${res.status} on page ${page}`)
    const j = (await res.json()) as { items?: Vid[]; totalItems?: number }
    const items = j.items || []
    if (!items.length) break
    let fresh = 0
    for (const v of items) { if (!out.has(v.guid)) { out.set(v.guid, v); fresh++ } }
    if (!fresh) break
    if (j.totalItems && out.size >= j.totalItems) break
  }
  return out
}

// ── Report ──────────────────────────────────────────────────────────────────

async function main() {
  let boatFilter: string | null = null
  if (boatName) {
    const { data } = await db.from('boats').select('id, name').ilike('name', boatName).maybeSingle()
    if (!data) { console.error(`no boat called "${boatName}"`); process.exit(1) }
    boatFilter = data.id
  }

  let q = db.from('videos').select(
    'id, boat_id, external_id, title, start_utc, duration_ms, bytes, tags, created_at,' +
    ' has_proxy, has_original, bunny_stream_id, bunny_proxy_stream_id, bunny_original_stream_id,' +
    ' bunny_proxy_path, bunny_original_path, sessions:sessions(date)'
  )
  if (boatFilter) q = q.eq('boat_id', boatFilter)
  const [{ data, error }, lib] = await Promise.all([q, streamLibrary()])
  // The lib listing, as the shared decision wants it: bytes per guid, 0 for a
  // guid that is absent or is an abandoned upload holding nothing.
  const bytesOf = (guid: string) => lib.get(guid)?.storageSize || 0
  if (error) { console.error(error.message); process.exit(1) }
  const rows = (data || []) as unknown as Row[]

  // One clip = one boat, one day, one title, one start second. Title is in the
  // key on purpose — see the header's 10 Sept case.
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const day = r.sessions?.date
    if (!day || !r.title) continue
    const k = `${r.boat_id}|${day}|${r.title}|${r.start_utc ?? 'no-start'}`
    const g = groups.get(k)
    if (g) g.push(r); else groups.set(k, [r])
  }
  const dupes = Array.from(groups.entries()).filter(([, g]) => g.length > 1)
    .sort((a, b) => (a[1][0].sessions?.date || '').localeCompare(b[1][0].sessions?.date || ''))

  console.log(`${rows.length} rows${boatFilter ? ` for ${boatName}` : ''} · ` +
    `${lib.size} videos in the Stream library`)
  if (!dupes.length) { console.log('no duplicate rows — nothing to do.'); return }

  const drop: string[] = []
  const merges: { id: string; tags: string[] }[] = []
  const held: { date: string; title: string; note: string }[] = []
  let redundant = 0

  for (const [, g] of dupes) {
    const p = plan(g, bytesOf)
    const d = g[0].sessions?.date || '—'
    console.log(`\n── ${d}  ${g[0].title}  (${g.length} rows)`)
    for (const r of g) {
      const isKeep = p.keep?.id === r.id
      const flag = p.verdict === 'safe' ? (isKeep ? 'KEEP' : 'drop') : '   ?'
      const mb = r.bytes ? (r.bytes / 1e6).toFixed(1) + ' MB' : '—'
      const dur = r.duration_ms ? (r.duration_ms / 1000).toFixed(0) + ' s' : '—'
      console.log(
        `   ${flag}  ${r.id}  ${mb.padStart(9)}  ${dur.padStart(6)}  ` +
        `${describe(copies(r, bytesOf)).padEnd(22)}  tags ${String(r.tags?.length || 0).padStart(2)}  ` +
        `imported ${r.created_at?.slice(0, 16) || '—'}`
      )
    }

    if (p.verdict === 'safe' && p.keep) {
      redundant += g.length - 1
      console.log(`   → keep ${p.keep.id.slice(0, 8)}: ${p.why}`)
      if (p.note) console.log(`   ⚠ ${p.note}`)
      for (const r of g) if (r.id !== p.keep.id) drop.push(r.id)
      if (p.shared.length) {
        console.log(`   ⚠ ONE OBJECT, TWO ROWS — the keeper SHARES ${p.shared.length} locator(s)`)
        console.log(`     with a row that would go: ${p.shared.join(', ')}`)
        console.log(`     Use the SQL below, NOT the app's delete, unless the deployment has`)
        console.log(`     splitPurge (27 Nov 2026): the old route purges every locator the`)
        console.log(`     deleted row NAMED, which takes the bytes the keeper depends on.`)
      }
      if (p.tagsToCarry.length) {
        console.log(`   ⚠ ${p.tagsToCarry.length} tag(s) live ONLY on rows that would go: ${p.tagsToCarry.join(', ')}`)
        merges.push({ id: p.keep.id, tags: Array.from(new Set((p.keep.tags || []).concat(p.tagsToCarry))) })
      }
    } else {
      console.log(`   ⛔ HELD BACK — ${p.note}`)
      if (p.shared.length) {
        console.log(`   ⚠ and these rows SHARE ${p.shared.length} locator(s): ${p.shared.join(', ')}`)
      }
      held.push({ date: d, title: g[0].title || '', note: p.note })
    }
  }

  console.log(`\n${dupes.length} clip${dupes.length === 1 ? '' : 's'} filed more than once, ` +
    `of ${rows.length} rows.`)
  console.log(`  ${dupes.length - held.length} resolved→ ${redundant} redundant row(s) to drop`)
  console.log(`  ${held.length} held back for a decision`)
  console.log(`\nNothing has been changed.`)

  if (held.length) {
    console.log(`\n── HELD BACK ── these are NOT in the SQL below ───────────`)
    for (const h of held) console.log(`  ${h.date}  ${h.title}\n      ${h.note}`)
  }

  if (!drop.length) { console.log(`\nNothing is safe to drop automatically.`); return }

  if (merges.length) {
    console.log(`\n── 1. CARRY THE TAGS FIRST ─────────────────────────`)
    console.log(`Tags were typed by a person and nothing regenerates them. Run these BEFORE`)
    console.log(`the delete, or they go with the rows.\n`)
    for (const m of merges) {
      console.log(`  update videos set tags = '${JSON.stringify(m.tags)}'::jsonb where id = '${m.id}';`)
    }
  }
  console.log(`\n── ${merges.length ? '2. ' : ''}THEN THE ROWS ─────────────────────────────`)
  console.log(`Deleting the ROW does not remove the bytes from Bunny — the videos DELETE`)
  console.log(`route purges those (see videoPurge.ts), so prefer deleting through the app`)
  console.log(`where you want the storage back. A favourite or a share link pointing at a`)
  console.log(`dropped row breaks.\n`)
  console.log(`  delete from videos where id in (`)
  console.log(drop.map((id) => `    '${id}'`).join(',\n'))
  console.log(`  );`)
}

main().catch((e) => { console.error(e); process.exit(1) })
