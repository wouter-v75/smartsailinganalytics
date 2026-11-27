// scripts/stream-dedupe.ts — find and remove duplicate Bunny Stream videos.
//
//   npx vite-node scripts/stream-dedupe.ts                 # dry run, says everything
//   npx vite-node scripts/stream-dedupe.ts --write         # actually deletes
//   npx vite-node scripts/stream-dedupe.ts --orphans-only  # just the empty stubs
//   npx vite-node scripts/stream-dedupe.ts --dupes-only    # just the duplicate pairs
//
// WHY. The library audit of 26 Nov 2026 found 930 videos holding 416.5 GB for
// 17.7 hours of footage, and two kinds of waste inside it:
//
//   • 136 of 622 distinct clip names exist MORE THAN ONCE — always a .mov/.mp4
//     pair with two distinct GUIDs, the same duration and sizes within 0.2 %.
//     The same footage, uploaded twice, encoded twice, stored twice. The
//     redundant copies hold 113 GB, 27 % of the library.
//   • 192 videos sit at status `created` with zero dimensions and zero bytes —
//     a video object was made and the upload never finished. Dated March to
//     September, no transcodingMessages, so nothing failed in ENCODING: the TUS
//     upload was abandoned.
//
// WHAT MAKES THIS SAFE. A Stream video is only ever a candidate for deletion if
// NO database row points at it. Every `videos` row is read first and its three
// Stream columns — bunny_stream_id, bunny_proxy_stream_id,
// bunny_original_stream_id — are collected into a referenced set. Anything in
// that set is kept, whatever else is true of it.
//
// Within a duplicate group the rules are, in order:
//   1. exactly one copy referenced   -> keep that one, delete the rest
//   2. MORE than one referenced      -> keep everything, report the conflict.
//      Two rows pointing at two copies of one clip is a data question, not a
//      storage question, and deleting either would break a row.
//   3. none referenced               -> keep the LARGEST (most renditions
//      built), delete the rest. Reported separately because nothing in the app
//      is using any of them, which is worth knowing.
//
// Deletion is permanent — Bunny has no trash. Hence dry-run by default, and the
// dry run prints every GUID it would delete so the list can be read before any
// of it happens.
//
// Read-only without --write, like everything else here. Needs .env.local and
// must run OUTSIDE Claude Code's Bash sandbox (it needs the network).

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }

const write = has('--write')
const orphansOnly = has('--orphans-only')
const dupesOnly = has('--dupes-only')
const legacyOnly = has('--legacy-only')
const unreferenced = has('--unreferenced')
const fromList = (() => { const i = args.indexOf('--from-list'); return i >= 0 && args[i + 1] ? args[i + 1] : null })()

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

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const LIB = env.BUNNY_STREAM_LIBRARY_ID
const KEY = env.BUNNY_STREAM_API_KEY
const api = (path: string, init?: RequestInit) =>
  fetch(`https://video.bunnycdn.com/library/${LIB}${path}`, {
    ...init,
    headers: { AccessKey: KEY, ...(init?.headers || {}) },
  })

interface Vid {
  guid: string
  title: string
  status: number
  height: number
  width: number
  length: number
  storageSize: number
  dateUploaded: string
  availableResolutions: string | null
}

const STATUS: Record<number, string> = {
  0: 'created', 1: 'uploaded', 2: 'queued', 3: 'encoding',
  4: 'ready', 5: 'failed', 6: 'upload failed',
}

/** `IMG_2059.MOV` and `IMG_2059.mp4` are the same clip under two names. */
const stemOf = (t: string) => (t || '').replace(/\.(mov|mp4|m4v)$/i, '')
const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`
const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`

async function allVideos(): Promise<Vid[]> {
  const out: Vid[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= 200; page++) {
    const res = await api(`/videos?page=${page}&itemsPerPage=100&orderBy=date`)
    if (!res.ok) fail(`Bunny list HTTP ${res.status} on page ${page}`)
    const j = (await res.json()) as { items?: Vid[]; totalItems?: number }
    const items = j.items || []
    if (!items.length) break
    let fresh = 0
    for (const v of items) {
      if (seen.has(v.guid)) continue
      seen.add(v.guid); out.push(v); fresh++
    }
    // Bunny keeps serving the last page rather than returning an empty one.
    if (!fresh) break
    if (j.totalItems && out.length >= j.totalItems) break
  }
  return out
}

interface Row {
  id: string
  title: string | null
  bunny_stream_id: string | null
  bunny_proxy_stream_id: string | null
  bunny_original_stream_id: string | null
}
let ROWS: Row[] = []

/** Every Stream GUID any database row points at, and which column pointed. */
async function referenced(): Promise<Map<string, string[]>> {
  const ref = new Map<string, string[]>()
  const note = (guid: string | null, col: string) => {
    if (!guid) return
    const a = ref.get(guid) || []
    a.push(col); ref.set(guid, a)
  }
  // Paged: the table is larger than one default page and a silent truncation
  // here would make a referenced video look deletable.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('videos')
      .select('id, title, bunny_stream_id, bunny_proxy_stream_id, bunny_original_stream_id')
      .range(from, from + 999)
    if (error) fail(`Supabase: ${error.message}`)
    const rows = (data || []) as Row[]
    ROWS = ROWS.concat(rows)
    for (const r of rows) {
      note(r.bunny_stream_id, 'bunny_stream_id')
      note(r.bunny_proxy_stream_id, 'bunny_proxy_stream_id')
      note(r.bunny_original_stream_id, 'bunny_original_stream_id')
    }
    if (rows.length < 1000) break
  }
  return ref
}

async function remove(v: Vid): Promise<boolean> {
  const res = await api(`/videos/${v.guid}`, { method: 'DELETE' })
  if (res.ok) return true
  console.error(`    ✕ delete ${v.guid} → HTTP ${res.status}`)
  return false
}

const main = async () => {
  console.log(write ? '● WRITE MODE — deletions are permanent\n' : '○ Dry run — nothing will be deleted (add --write)\n')

  const [vids, ref] = await Promise.all([allVideos(), referenced()])
  const bytes = vids.reduce((s, v) => s + (v.storageSize || 0), 0)
  const secs = vids.reduce((s, v) => s + (v.length || 0), 0)
  console.log(`library ${LIB}: ${vids.length} videos · ${gb(bytes)} · ${(secs / 3600).toFixed(1)} h of footage`)
  console.log(`database rows point at ${ref.size} distinct Stream GUIDs\n`)

  const doomed: Vid[] = []

  // ── 0. An explicit GUID list ──────────────────────────────────────────────
  // The unreferenced pass is all-or-nothing, and the triage split it into a
  // part that is redundant and a part that is the only cloud copy of a day
  // (41 videos of hand-named Sept 2025 footage, 27 Nov 2026). So a chosen
  // subset has to be deletable — and every guid is re-checked against the
  // database HERE, at delete time, not trusted from the file. A row could have
  // been written between the triage and this run, and a list is a thing that
  // gets edited by hand.
  if (fromList) {
    if (!existsSync(fromList)) fail(`list not found: ${fromList}`)
    const wanted = Array.from(new Set(
      readFileSync(fromList, 'utf8').split('\n').map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    ))
    const byGuid = new Map(vids.map((v) => [v.guid, v]))
    const go: Vid[] = []
    let refused = 0, missing = 0
    for (const g of wanted) {
      const v = byGuid.get(g)
      if (!v) { console.log(`  \u2014 ${g} is not in the library (already gone)`); missing++; continue }
      if (ref.has(g)) {
        console.log(`  \u2715 REFUSED ${g} — a database row points at it (${v.title})`)
        refused++; continue
      }
      go.push(v)
    }
    const bytesGo = go.reduce((s2, v) => s2 + (v.storageSize || 0), 0)
    console.log(`\n${wanted.length} guid(s) listed: ${go.length} deletable · ${gb(bytesGo)}` +
      `${refused ? `, ${refused} REFUSED (still referenced)` : ''}` +
      `${missing ? `, ${missing} already gone` : ''}`)
    for (const v of go) {
      console.log(`  ${write ? 'DELETE' : 'would delete'} ${v.guid}  ${mb(v.storageSize)}  ` +
        `${v.height || '?'}p  ${(v.dateUploaded || '').slice(0, 10)}  ${v.title}`)
    }
    if (!write) {
      console.log(`\nDry run. Re-run with --write to delete the ${go.length} above.`)
      console.log(`Bunny has no trash — a delete here cannot be undone.`)
      return
    }
    let ok = 0
    for (const v of go) if (await remove(v)) ok++
    console.log(`\n${ok} of ${go.length} deleted · ${gb(bytesGo)} reclaimed`)
    return
  }

  // ── 1. Duplicate groups ───────────────────────────────────────────────────
  if (!orphansOnly && !legacyOnly) {
    const groups = new Map<string, Vid[]>()
    for (const v of vids) {
      const k = stemOf(v.title)
      if (!k) continue
      groups.set(k, (groups.get(k) || []).concat([v]))
    }
    const dupes = Array.from(groups.entries()).filter(([, vs]) => vs.length > 1)
    dupes.sort((a, b) =>
      b[1].reduce((s, v) => s + v.storageSize, 0) - a[1].reduce((s, v) => s + v.storageSize, 0))

    console.log(`── DUPLICATES ── ${dupes.length} clip names appear more than once\n`)
    let conflicts = 0, unused = 0, reclaim = 0, emptyRefd = 0

    for (const [stem, vs] of dupes) {
      const refd = vs.filter((v) => ref.has(v.guid))
      const withBytes = vs.filter((v) => (v.storageSize || 0) > 0)
      let keep: Vid
      let why: string

      // A referenced copy with NO BYTES must never win over a sibling that has
      // them. The first dry run surfaced `20260728 112202`, where the row points
      // at an empty 0 MB stub and the real 139 MB/720p encode sits beside it:
      // "keep the referenced one" would have deleted the clip and kept the
      // broken pointer. Neither is safe to delete on its own — removing the
      // empty one leaves the row dangling, removing the good one loses the
      // footage — so this is reported for a row repoint, like the other
      // conflicts, and nothing in the group is touched.
      if (refd.length && refd.every((v) => !(v.storageSize || 0)) && withBytes.length) {
        emptyRefd++
        console.log(`  ⚠ ${stem} — the referenced copy is EMPTY and a sibling has the bytes. KEEPING ALL.`)
        for (const v of vs) {
          const cols = ref.get(v.guid)
          console.log(`      ${v.guid}  ${mb(v.storageSize)}  ${v.height}p  ${v.title}  ${cols ? `← ${cols.join(', ')}` : '(unreferenced)'}`)
        }
        console.log(`      → repoint the row at the copy that has the bytes, then re-run.\n`)
        continue
      }

      // Nothing in the group has any bytes and nothing references it: the whole
      // group is worthless, so keep none of it rather than one empty stub.
      if (!withBytes.length && !refd.length) {
        for (const v of vs) { console.log(`    DELETE ${v.guid}  ${mb(v.storageSize)}  ${v.height}p  ${v.title}  (whole group is empty)`) }
        for (const v of vs) doomed.push(v)
        continue
      }

      if (refd.length === 1) { keep = refd[0]; why = 'referenced by a row' }
      else if (refd.length > 1) {
        conflicts++
        console.log(`  ⚠ ${stem} — ${refd.length} copies are each referenced by a row. KEEPING ALL.`)
        for (const v of vs) {
          const cols = ref.get(v.guid)
          console.log(`      ${v.guid}  ${mb(v.storageSize)}  ${v.title}  ${cols ? `← ${cols.join(', ')}` : '(unreferenced)'}`)
        }
        console.log('      → two rows pointing at two copies of one clip is a data question; resolve it before deleting either.\n')
        continue
      }
      else {
        unused++
        keep = vs.slice().sort((a, b) => b.storageSize - a.storageSize)[0]
        why = 'largest; NOTHING in the database points at any copy'
      }

      const drop = vs.filter((v) => v.guid !== keep.guid)
      reclaim += drop.reduce((s, v) => s + v.storageSize, 0)
      console.log(`  ${stem}`)
      console.log(`    keep   ${keep.guid}  ${mb(keep.storageSize)}  ${keep.height}p  ${keep.title}   (${why})`)
      for (const v of drop) {
        console.log(`    DELETE ${v.guid}  ${mb(v.storageSize)}  ${v.height}p  ${v.title}`)
        doomed.push(v)
      }
    }
    console.log(`\n  ${dupes.length} groups · ${conflicts} conflicts kept intact · ${emptyRefd} kept because the row points at an empty copy · ${unused} groups nothing references`)
    console.log(`  reclaimable from duplicates: ${gb(reclaim)}\n`)
  }

  // ── 2. Orphan stubs ───────────────────────────────────────────────────────
  if (!dupesOnly && !legacyOnly) {
    const stubs = vids.filter((v) =>
      v.status === 0 && !v.storageSize && !v.height && !ref.has(v.guid))
    const stubsRefd = vids.filter((v) => v.status === 0 && !v.storageSize && ref.has(v.guid))

    console.log(`── ORPHAN STUBS ── status 'created', no bytes, no dimensions\n`)
    console.log(`  ${stubs.length} unreferenced (deletable), ${stubsRefd.length} referenced by a row (kept)`)
    if (stubs.length) {
      const dates = stubs.map((v) => v.dateUploaded).sort()
      console.log(`  dates ${dates[0]?.slice(0, 10)} → ${dates[dates.length - 1]?.slice(0, 10)}`)
      for (const v of stubs.slice(0, 10)) console.log(`    DELETE ${v.guid}  ${v.title}  ${v.dateUploaded.slice(0, 10)}`)
      if (stubs.length > 10) console.log(`    … and ${stubs.length - 10} more`)
      for (const v of stubs) doomed.push(v)
    }
    if (stubsRefd.length) {
      console.log(`\n  ⚠ ${stubsRefd.length} empty stubs ARE referenced by a row — a clip the app believes is`)
      console.log(`    uploaded when no bytes ever arrived. Left alone here; they need a re-upload,`)
      console.log(`    not a delete.`)
      for (const v of stubsRefd.slice(0, 8)) console.log(`      ${v.guid}  ${v.title}  ← ${ref.get(v.guid)?.join(', ')}`)
    }
    console.log()
  }

  // ── 3. The legacy third copy ──────────────────────────────────────────────
  // A clip can be in Stream THREE times. `bunny_stream_id` is the old
  // session-sync TUS upload, removed from the app in Nov 2026 (see
  // src/lib/uploadFlows.ts); `bunny_proxy_stream_id` and
  // `bunny_original_stream_id` are the proxy/original pair that replaced it.
  // 105 rows carry all three, distinct — so the legacy copy is a full-size
  // duplicate of the original, and `url/route.ts` never reaches it:
  // resolveLegacy() is the LAST fallback in both branches (`:191`, `:194`),
  // so a row with a proxy or an original never serves it.
  //
  // Only deleted where a proxy OR an original exists. Where the legacy copy is
  // the clip's ONLY copy it is the thing being played, and it is kept.
  if (!orphansOnly && !dupesOnly) {
    const byGuid = new Map(vids.map((v) => [v.guid, v]))
    const supersededRows = ROWS.filter((r) =>
      r.bunny_stream_id &&
      r.bunny_stream_id !== r.bunny_proxy_stream_id &&
      r.bunny_stream_id !== r.bunny_original_stream_id &&
      (r.bunny_proxy_stream_id || r.bunny_original_stream_id) &&
      byGuid.has(r.bunny_stream_id))

    console.log(`── LEGACY THIRD COPY ── rows with a superseded bunny_stream_id\n`)
    console.log(`  ${supersededRows.length} rows have a legacy Stream copy AND a proxy or original`)

    let lb = 0
    const alreadyDoomed = new Set(doomed.map((v) => v.guid))
    for (const r of supersededRows) {
      const v = byGuid.get(r.bunny_stream_id!)!
      if (alreadyDoomed.has(v.guid)) continue
      lb += v.storageSize || 0
      doomed.push(v); alreadyDoomed.add(v.guid)
    }
    console.log(`  reclaimable from legacy copies: ${gb(lb)}`)
    if (!supersededRows.length) {
      console.log(`  (nothing to do — 0107 has already cleared the superseded ids.)\n`)
    } else {
    console.log(`\n  NOTE: deleting these leaves bunny_stream_id pointing at a video that is gone.`)
    console.log(`  Harmless for playback (it is the last fallback and never reached when a`)
    console.log(`  proxy or original exists), but the column should be nulled afterwards:`)
    console.log(`\n    update videos set bunny_stream_id = null`)
    console.log(`    where bunny_stream_id is not null`)
    console.log(`      and (bunny_proxy_stream_id is not null or bunny_original_stream_id is not null);\n`)
    }
  }

  // ── 3. Do it, or say what would happen ────────────────────────────────────
  // ── 4. Unreferenced videos that still hold bytes (OPT-IN: --unreferenced) ──
  // Nothing in the `videos` table points at these, and url/route.ts resolves
  // playback only from bunny_stream_id / bunny_proxy_stream_id /
  // bunny_original_stream_id — so the app cannot reach them by any route.
  //
  // This pass exists because migration 0107 was applied BEFORE the deletion.
  // 0107 nulls the superseded `bunny_stream_id`, which was the only record of
  // which Stream videos were the legacy third copies. With it cleared they are
  // no longer identifiable as legacy — they are simply unreferenced, and the
  // duplicate pass only catches the ones that share a name with a sibling.
  //
  // It is a WIDER claim than the other three passes: "no row points at it" is
  // not quite "nobody wants it" — a row deleted while its Stream video stayed
  // looks identical. So it is opt-in and it prints everything it would remove.
  if (unreferenced) {
    const alreadyDoomed = new Set(doomed.map((v) => v.guid))
    const orphaned = vids
      .filter((v) => !ref.has(v.guid) && (v.storageSize || 0) > 0 && !alreadyDoomed.has(v.guid))
      .sort((a, b) => b.storageSize - a.storageSize)
    const ob = orphaned.reduce((t, v) => t + v.storageSize, 0)

    console.log(`── UNREFERENCED, WITH BYTES ── opt-in pass\n`)
    console.log(`  ${orphaned.length} videos hold ${gb(ob)} and no database row points at any of them`)
    for (const v of orphaned.slice(0, 25))
      console.log(`    DELETE ${v.guid}  ${mb(v.storageSize)}  ${v.height}p  ${v.dateUploaded.slice(0, 10)}  ${v.title.slice(0, 44)}`)
    if (orphaned.length > 25) console.log(`    … and ${orphaned.length - 25} more`)
    console.log(`\n  Read this list before --write: an unreferenced video is unreachable from`)
    console.log(`  the app, but that is not proof nobody wants the footage.\n`)
    for (const v of orphaned) doomed.push(v)
  } else {
    const alreadyDoomed = new Set(doomed.map((v) => v.guid))
    const n = vids.filter((v) => !ref.has(v.guid) && (v.storageSize || 0) > 0 && !alreadyDoomed.has(v.guid))
    const nb = n.reduce((t, v) => t + v.storageSize, 0)
    if (n.length) {
      console.log(`── UNREFERENCED, WITH BYTES ── not included\n`)
      console.log(`  ${n.length} videos hold ${gb(nb)} that no database row points at.`)
      console.log(`  Add --unreferenced to list and delete them. Left out by default because`)
      console.log(`  "no row points at it" is a wider claim than the other passes make.\n`)
    }
  }

  // The passes overlap: a 0-byte stub can be both a duplicate non-keeper and an
  // orphan. Collapse by guid so the count is honest and no DELETE is sent twice.
  const unique = new Map<string, Vid>()
  for (const v of doomed) unique.set(v.guid, v)
  doomed.length = 0
  for (const v of Array.from(unique.values())) doomed.push(v)

  const freed = doomed.reduce((s, v) => s + (v.storageSize || 0), 0)
  console.log('─'.repeat(72))
  console.log(`${doomed.length} videos to delete · ${gb(freed)} reclaimed · ${gb(bytes - freed)} would remain`)

  if (!doomed.length) { console.log('\nNothing to do.'); return }
  if (!write) {
    console.log('\nDry run. Re-run with --write to delete the videos listed above.')
    console.log('Bunny has no trash — a delete here cannot be undone.')
    return
  }

  console.log('\nDeleting…')
  let ok = 0, bad = 0
  for (const v of doomed) {
    if (await remove(v)) { ok++; if (ok % 25 === 0) console.log(`  … ${ok}/${doomed.length}`) }
    else bad++
  }
  console.log(`\n✓ deleted ${ok}${bad ? `, ${bad} failed` : ''} · ${gb(freed)} reclaimed`)
  if (bad) console.log('Re-run to retry the failures; deletion is idempotent (a gone video 404s).')
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
