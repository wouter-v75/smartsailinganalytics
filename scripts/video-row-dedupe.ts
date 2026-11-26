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
// duplicate ROWS pointing at them.
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
// Measured on the live library, 26 Nov 2026: 367 rows, 12 of them redundant.
// Four pairs on 29 Sept from a clips:day re-run (bytes within 0.03 %), seven
// rows for two clips on 12 July from repeated imports, and one dangling-guid
// row beside a good copy on 27 June.
//
// WHAT IS NOT A DUPLICATE, and why the key is what it is: on 10 Sept two rows
// share a start time to the second and are different clips — `…race start day8
// drone` (146 MB) and `…race start day8 Camera` (36 MB), two cameras on the
// same moment. So the grouping key includes the TITLE. Start time alone would
// have merged them.
//
//   npx vite-node scripts/video-row-dedupe.ts
//   npx vite-node scripts/video-row-dedupe.ts --boat "Northstar 76"
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const fail: (m: string) => never = (m) => { console.error(`\u2715 ${m}`); process.exit(1) }
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
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) fail(`${k} missing from .env.local`)
}
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

/** Renditions this row can actually play from. More is better. */
const renditions = (r: Row): number =>
  [r.bunny_proxy_stream_id, r.bunny_original_stream_id, r.bunny_proxy_path,
    r.bunny_original_path, r.bunny_stream_id].filter(Boolean).length

/**
 * Which row to keep, and what has to be carried onto it first.
 *
 * KEEP THE PLAYABLE ONE. A row with no rendition plays nothing, so it cannot be
 * the survivor however well-labelled it is.
 *
 * THEN LOOK AT THE TAGS, because on the real data they go the OTHER WAY. The
 * four 29 Sept pairs each have the renditions on one row and ALL the tags on
 * the other — `renditions 2 / tags 0` beside `renditions 1 / tags 11`. The
 * obvious rule, "keep the playable one and delete the rest", throws away eleven
 * tags a person typed. That is why this prints a MERGE before a delete and why
 * there is no --write.
 *
 * It happens because the two are written by different things at different
 * times: the second clips:day run uploads and creates a fresh row, while the
 * tags live on the row the team has been working with since the first run.
 */
function plan(group: Row[]): { keep: Row; why: string; tagsToCarry: string[] } {
  const byPlayable = [...group].sort((a, b) => {
    const d = renditions(b) - renditions(a)
    if (d) return d
    // Equal renditions: the oldest, because any share link already handed out
    // points at it, and its tags are the ones that have been accumulating.
    return (a.created_at || '').localeCompare(b.created_at || '')
  })
  const keep = byPlayable[0]
  const why = renditions(keep) > renditions(byPlayable[1])
    ? `the only one with ${renditions(keep)} rendition${renditions(keep) === 1 ? '' : 's'}`
    : 'equal renditions — the oldest, which any shared link points at'

  // Every tag on a row that is going away and not already on the keeper.
  const kept = new Set(keep.tags || [])
  const tagsToCarry = Array.from(new Set(
    group.filter((r) => r.id !== keep.id).flatMap((r) => r.tags || [])
  )).filter((t) => !kept.has(t))

  return { keep, why, tagsToCarry }
}

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
  const { data, error } = await q
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

  console.log(`${rows.length} rows${boatFilter ? ` for ${boatName}` : ''}`)
  if (!dupes.length) { console.log('no duplicate rows — nothing to do.'); return }

  const drop: string[] = []
  const merges: { id: string; tags: string[] }[] = []
  let redundant = 0
  let danglingRisk = 0
  for (const [, g] of dupes) {
    redundant += g.length - 1
    const { keep, why, tagsToCarry } = plan(g)
    // A legacy guid counts as a rendition here, and this script never asks
    // Bunny whether it still resolves. One such row on the live data pointed at
    // a Stream video that had been deleted. stream-dedupe.ts is what checks.
    if (keep.bunny_stream_id && !keep.bunny_proxy_stream_id && !keep.bunny_original_stream_id
        && !keep.bunny_proxy_path && !keep.bunny_original_path) danglingRisk++
    const d = g[0].sessions?.date
    console.log(`\n── ${d}  ${g[0].title}  (${g.length} rows)`)
    for (const r of g) {
      const mark = r.id === keep.id ? 'KEEP' : 'drop'
      const mb = r.bytes ? (r.bytes / 1e6).toFixed(1) + ' MB' : '—'
      const dur = r.duration_ms ? (r.duration_ms / 1000).toFixed(0) + ' s' : '—'
      console.log(
        `   ${mark}  ${r.id}  ${mb.padStart(9)}  ${dur.padStart(6)}  ` +
        `rend ${renditions(r)}  tags ${String(r.tags?.length || 0).padStart(2)}  ` +
        `imported ${r.created_at?.slice(0, 16) || '—'}`
      )
      if (r.id !== keep.id) drop.push(r.id)
    }
    console.log(`   → keep ${keep.id.slice(0, 8)}: ${why}`)
    if (tagsToCarry.length) {
      console.log(`   ⚠ ${tagsToCarry.length} tag(s) live ONLY on rows that would go: ${tagsToCarry.join(', ')}`)
      merges.push({ id: keep.id, tags: Array.from(new Set((keep.tags || []).concat(tagsToCarry))) })
    }
    if (renditions(keep) === 0) {
      console.log(`   ⚠ none of these rows can be played — the clip is not in the cloud at all`)
    }
  }

  console.log(`\n${dupes.length} clip${dupes.length === 1 ? '' : 's'} filed more than once; ` +
    `${redundant} redundant row${redundant === 1 ? '' : 's'} of ${rows.length}.`)
  console.log(`\nNothing has been changed.`)
  if (danglingRisk) {
    console.log(`\n${danglingRisk} kept row(s) rest on a LEGACY stream guid only, and this script`)
    console.log(`does not ask Bunny whether those still resolve — one on the live data pointed`)
    console.log(`at a deleted video. Run scripts/stream-dedupe.ts first; it checks.`)
  }
  if (merges.length) {
    console.log(`\n── 1. CARRY THE TAGS FIRST ──────────────────────────────────────────`)
    console.log(`Tags were typed by a person and nothing regenerates them. Run these BEFORE`)
    console.log(`the delete, or they go with the rows.\n`)
    for (const m of merges) {
      console.log(`  update videos set tags = '${JSON.stringify(m.tags)}'::jsonb where id = '${m.id}';`)
    }
  }
  console.log(`\n── ${merges.length ? '2. ' : ''}THEN THE ROWS ──────────────────────────────────────────────`)
  console.log(`Deleting the ROW does not remove the bytes from Bunny — the videos DELETE`)
  console.log(`route purges those (see videoPurge.ts), so prefer deleting through the app`)
  console.log(`where you want the storage back. A favourite or a share link pointing at a`)
  console.log(`dropped row breaks.\n`)
  console.log(`  delete from videos where id in (`)
  console.log(drop.map((id) => `    '${id}'`).join(',\n'))
  console.log(`  );`)
}

main().catch((e) => { console.error(e); process.exit(1) })
