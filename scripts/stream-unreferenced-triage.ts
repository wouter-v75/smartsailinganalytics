// scripts/stream-unreferenced-triage.ts
// ─────────────────────────────────────────────────────────────────────────────
// For the 163 Stream videos no database row points at: IS THERE ANOTHER COPY?
//
// Read-only. There is no --write and never should be: this script exists to be
// read before `stream-dedupe.ts --write` deletes 81.7 GB that Bunny cannot
// restore. It deletes nothing itself.
//
// WHY IT IS NOT ENOUGH to know a video is unreferenced. `stream-dedupe.ts`
// proves no row points at it, which proves the app cannot REACH it — not that
// nobody wants the footage. Two very different things look identical in that
// pass:
//
//   • a whole-card original that was superseded by cut clips. The day's
//     footage is in the cloud, in the form the team actually watches, and the
//     raw file is redundant. Deleting it is free.
//   • a whole-card original whose row was deleted, or which was uploaded by a
//     flow that never wrote a row. Then those bytes are the ONLY cloud copy of
//     that day, and the card is the only other one.
//
// The first is safe and the second is not, and the difference is not in the
// Stream library — it is in whether the app holds anything else for the same
// FOOTAGE DAY.
//
// WHERE THE DAY COMES FROM. The camera's own filename, which is why this works
// at all: `DJI_20250905124907_0006_first_reach.MP4`, `20260729_145610.mp4`,
// `DJI 20260527152016 0013 D_720p.mp4` all carry YYYYMMDD. That is the day the
// footage was SHOT, which is the question — Stream's `dateUploaded` is not (one
// of these is Sept 2025 footage uploaded in April 2026, seven months later).
//
// A title with no parseable date is reported separately rather than guessed at.
// One of them is literally the string `undefined`, 3.5 GB of it.
//
// WHAT GROUP A DOES NOT SAY. "The day has playable clips" is not "this file's
// content is in them". A whole-card original is continuous footage; the cut
// clips are selections out of it. So A means redundant-by-day, not
// redundant-by-content, and the sharper signal is printed beside it: how many
// unreferenced files the day has against how many playable rows. Where the rows
// are at least as many, each unreferenced file plausibly has a live counterpart
// and is a superseded encode. Where they are FEWER, some of those files cover
// moments nothing in the app does — 2026-05-19 has 16 unreferenced against 10
// rows, so six of them are unaccounted for.
//
//   npx vite-node scripts/stream-unreferenced-triage.ts
//   npx vite-node scripts/stream-unreferenced-triage.ts --verbose   # every file
//
// --emit prints bare GUIDs, one per line, for one group — so a subset can be
// deleted. `stream-dedupe.ts --unreferenced --write` takes all three groups
// together and has no way to take one.
//
//   ... --emit derived > ~/reclaim.txt     # 720p-or-smaller, day covered
//   ... --emit A | --emit B | --emit C | --emit originals
//   npx vite-node scripts/stream-dedupe.ts --from-list ~/reclaim.txt
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const emitOf = () => { const i = args.indexOf('--emit'); return i >= 0 && args[i + 1] ? args[i + 1] : null }
const emit = emitOf()   // A | B | C | derived | originals -> bare guids, one per line
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }

// Same .env.local handling as the rest of scripts/ — dotenv is not a dependency.
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
const api = (path: string) =>
  fetch(`https://video.bunnycdn.com/library/${LIB}${path}`, {
    headers: { AccessKey: env.BUNNY_STREAM_API_KEY },
  })

interface Vid {
  guid: string; title: string; status: number; height: number
  length: number; storageSize: number; dateUploaded: string
}

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`
const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`
const hhmm = (s: number) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}`

/** Identical paging to stream-dedupe.ts, including Bunny's repeat-last-page quirk. */
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
    if (!fresh) break
    if (j.totalItems && out.length >= j.totalItems) break
  }
  return out
}

interface Row {
  id: string
  title: string | null
  tags: string[] | null
  bunny_stream_id: string | null
  bunny_proxy_stream_id: string | null
  bunny_original_stream_id: string | null
  bunny_proxy_path: string | null
  bunny_original_path: string | null
  sessions: { date: string } | null
}

const renditions = (r: Row): number =>
  [r.bunny_proxy_stream_id, r.bunny_original_stream_id, r.bunny_proxy_path,
    r.bunny_original_path, r.bunny_stream_id].filter(Boolean).length

/** Every row, paged — a silent truncation would invent a "nothing else exists". */
async function allRows(): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('videos').select(
      'id, title, tags, bunny_stream_id, bunny_proxy_stream_id, bunny_original_stream_id,' +
      ' bunny_proxy_path, bunny_original_path, sessions:sessions(date)'
    ).range(from, from + 999)
    if (error) fail(`Supabase: ${error.message}`)
    const rows = (data || []) as unknown as Row[]
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

/**
 * The footage day out of a camera filename, or null.
 *
 * Deliberately strict: a real month and a real day, or nothing. Guessing a day
 * here would file an orphan under a session that holds other footage and report
 * it as safe to delete.
 */
function footageDay(title: string): string | null {
  // An exec loop rather than matchAll: this tsconfig's target does not allow
  // iterating a RegExpStringIterator (TS2802).
  const re = /(20\d{2})(\d{2})(\d{2})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(title || '')) !== null) {
    const [, y, mo, d] = m
    const mn = Number(mo), dn = Number(d)
    if (mn >= 1 && mn <= 12 && dn >= 1 && dn <= 31) return `${y}-${mo}-${d}`
  }
  return null
}

/** A 720p-or-smaller file, or one that names itself a proxy, is a derived copy. */
const looksLikeProxy = (v: Vid) =>
  /_720p\b/i.test(v.title || '') || (v.height > 0 && v.height <= 720)

async function main() {
  const [vids, rows] = await Promise.all([allVideos(), allRows()])

  const ref = new Set<string>()
  for (const r of rows) {
    for (const g of [r.bunny_stream_id, r.bunny_proxy_stream_id, r.bunny_original_stream_id]) {
      if (g) ref.add(g)
    }
  }

  const orphans = vids.filter((v) => !ref.has(v.guid) && (v.storageSize || 0) > 0)
  const total = orphans.reduce((s, v) => s + v.storageSize, 0)
  if (!emit) {
    console.log(`library ${LIB}: ${vids.length} videos · ${rows.length} database rows`)
    console.log(`${orphans.length} unreferenced videos holding ${gb(total)}\n`)
  }

  // What the app holds per session day, and how much of it can actually play.
  const appByDay = new Map<string, { rows: number; playable: number; tagged: number }>()
  for (const r of rows) {
    const d = r.sessions?.date
    if (!d) continue
    const e = appByDay.get(d) || { rows: 0, playable: 0, tagged: 0 }
    e.rows++
    if (renditions(r) > 0) e.playable++
    if (r.tags?.length) e.tagged++
    appByDay.set(d, e)
  }

  // Group the orphans by the day their filename names.
  const byDay = new Map<string, Vid[]>()
  const undated: Vid[] = []
  for (const v of orphans) {
    const d = footageDay(v.title || '')
    if (!d) { undated.push(v); continue }
    const g = byDay.get(d) || []
    g.push(v); byDay.set(d, g)
  }

  const covered: string[] = []
  const bare: string[] = []
  for (const d of Array.from(byDay.keys()).sort()) {
    (appByDay.get(d)?.playable ? covered : bare).push(d)
  }

  const sum = (ds: string[]) =>
    ds.reduce((s, d) => s + (byDay.get(d) || []).reduce((t, v) => t + v.storageSize, 0), 0)
  const count = (ds: string[]) => ds.reduce((s, d) => s + (byDay.get(d) || []).length, 0)

  const show = (d: string) => {
    const g = (byDay.get(d) || []).sort((a, b) => b.storageSize - a.storageSize)
    const app = appByDay.get(d)
    const bytes = g.reduce((s, v) => s + v.storageSize, 0)
    const derived = g.filter(looksLikeProxy).length
    console.log(`\n── ${d}  ${g.length} unreferenced · ${gb(bytes)}` +
      (derived ? `  (${derived} are 720p or smaller)` : ''))
    console.log(`   the app holds: ` + (app
      ? `${app.rows} row${app.rows === 1 ? '' : 's'}, ${app.playable} playable, ${app.tagged} tagged`
      : `NOTHING for this day`))
    // The sharper test: a live row per unreferenced file, or not.
    if (app && app.playable < g.length) {
      console.log(`   \u26a0 ${g.length - app.playable} MORE unreferenced file(s) than playable rows — ` +
        `some of these cover footage nothing in the app does`)
    }
    const list = verbose ? g : g.slice(0, 4)
    for (const v of list) {
      console.log(`     ${v.guid.slice(0, 8)}  ${mb(v.storageSize).padStart(7)}  ` +
        `${String(v.height || '?').padStart(5)}p  ${hhmm(v.length || 0).padStart(7)}  ` +
        `up ${(v.dateUploaded || '').slice(0, 10)}  ${v.title}`)
    }
    if (!verbose && g.length > list.length) console.log(`     … and ${g.length - list.length} more (--verbose)`)
  }

  if (emit) {
    // Bare guids only: this is piped into a file, so nothing else may be printed
    // on stdout. The counts go to stderr so they are still seen.
    const pick: Vid[] =
      emit === 'A' ? covered.flatMap((d) => byDay.get(d) || [])
      : emit === 'B' ? bare.flatMap((d) => byDay.get(d) || [])
      : emit === 'C' ? undated
      : emit === 'derived' ? covered.flatMap((d) => (byDay.get(d) || []).filter(looksLikeProxy))
      : emit === 'originals' ? covered.flatMap((d) => (byDay.get(d) || []).filter((v) => !looksLikeProxy(v)))
      : fail(`--emit takes A, B, C, derived or originals (got ${emit})`)
    for (const v of pick) console.log(v.guid)
    console.error(`${pick.length} guid(s) · ${gb(pick.reduce((s2, v) => s2 + v.storageSize, 0))} · group ${emit}`)
    return
  }

  console.log('═══ A. THE DAY IS IN THE APP — the raw file is redundant ═══')
  console.log(`${covered.length} day(s) · ${count(covered)} videos · ${gb(sum(covered))}`)
  console.log(`These days have clips that play. The unreferenced file is the`)
  console.log(`whole-card original the cuts were made from.`)
  for (const d of covered) show(d)

  console.log(`\n\n═══ B. NOTHING ELSE FOR THIS DAY — these bytes may be the only cloud copy ═══`)
  console.log(`${bare.length} day(s) · ${count(bare)} videos · ${gb(sum(bare))}`)
  if (bare.length) {
    console.log(`Check the SSD card for each of these BEFORE deleting anything.`)
    console.log(`A day with no playable row is a day the app cannot show at all.`)
  }
  for (const d of bare) show(d)

  if (undated.length) {
    const b = undated.reduce((s, v) => s + v.storageSize, 0)
    console.log(`\n\n═══ C. NO DATE IN THE FILENAME — cannot be placed ═══`)
    console.log(`${undated.length} video(s) · ${gb(b)}. Judge these by eye.`)
    for (const v of undated.sort((a, x) => x.storageSize - a.storageSize)) {
      console.log(`     ${v.guid.slice(0, 8)}  ${mb(v.storageSize).padStart(7)}  ` +
        `${String(v.height || '?').padStart(5)}p  ${hhmm(v.length || 0).padStart(7)}  ` +
        `up ${(v.dateUploaded || '').slice(0, 10)}  ${JSON.stringify(v.title)}`)
    }
  }

  console.log(`\n────────────────────────────────────────────────────────────────`)
  console.log(`A  redundant, day covered      ${String(count(covered)).padStart(4)} videos  ${gb(sum(covered)).padStart(8)}`)
  console.log(`B  day NOT in the app          ${String(count(bare)).padStart(4)} videos  ${gb(sum(bare)).padStart(8)}`)
  console.log(`C  unplaceable                 ${String(undated.length).padStart(4)} videos  ${gb(undated.reduce((s, v) => s + v.storageSize, 0)).padStart(8)}`)
  console.log(`\nNothing has been changed, and this script cannot change anything.`)
  console.log(`stream-dedupe.ts --unreferenced --write deletes ALL THREE groups`)
  console.log(`together — it has no way to delete only A.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
