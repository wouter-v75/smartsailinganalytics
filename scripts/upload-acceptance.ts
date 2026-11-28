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

interface Vid {
  guid: string
  status: number
  storageSize: number
  height: number
  availableResolutions: string | null
  /** ISO, from Bunny. Needed to tell an upload IN FLIGHT from an abandoned stub. */
  dateUploaded?: string
  encodeProgress?: number
}

/**
 * Bunny's own status codes, so a ✕ can say which kind it is.
 * 0 queued · 1 processing · 2 encoding · 3 finished(ish) · 4 resolution ready
 * · 5 failed. Only 4 is "a player can have it".
 */
const STATUS_WORD: Record<number, string> = {
  0: 'queued', 1: 'processing', 2: 'encoding', 3: 'finished',
  4: 'ready', 5: 'FAILED',
}

/** A Stream video with no bytes yet is ambiguous until you know its age. */
const IN_FLIGHT_MINUTES = 20

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

  // Bytes are in Stream. Enough to say a copy EXISTS and is not an abandoned
  // TUS stub, which is what the A/B delivery lines are asking.
  const liveGuid = (g: string | null | undefined) =>
    !!g && (lib.get(g)?.storageSize || 0) > 0
  /**
   * Bytes in Stream AND the ladder finished — Bunny status 4.
   *
   * Not the same question, and conflating them made this script over-report.
   * `resolveOriginalHls` and `resolveProxy` both return null while an encode is
   * pending and fall through to the Storage MP4, so a fresh upload is served
   * progressive while the script was naming HLS. Harmless there, but the same
   * gap hides a real failure: a row whose Stream video never finishes encoding
   * and has no Storage path serves NOTHING, and this script would have called
   * it `originalHls` and `playable ✓`. Bunny's free queue "may take anywhere
   * from several hours to multiple days", so that is not a hypothetical.
   */
  const encodedGuid = (g: string | null | undefined) =>
    liveGuid(g) && lib.get(g!)?.status === 4
  const realPath = (p: string | null | undefined) => !!p && /\.mp4$/i.test(p)

  /**
   * WHY a guid is not counted as delivered — because "✕" was doing two
   * completely different jobs and the difference decides what to do next.
   *
   * A Stream video reports `storageSize: 0` until Bunny has accounted for the
   * bytes, so a TUS upload that finished SECONDS ago looks exactly like one of
   * the 192 abandoned stubs in this library. The only thing separating them is
   * AGE. Reported, not guessed: the verdict says "still landing" inside the
   * window and "no bytes" outside it, and a reader can see which.
   */
  const guidNote = (g: string | null | undefined): { text: string; inFlight: boolean } => {
    if (!g) return { text: '', inFlight: false }
    const v = lib.get(g)
    if (!v) return { text: 'not in the Stream library at all', inFlight: false }
    const word = STATUS_WORD[v.status] ?? `status ${v.status}`
    if ((v.storageSize || 0) > 0) {
      return { text: `${word}${v.encodeProgress != null ? ` ${v.encodeProgress}%` : ''}`, inFlight: false }
    }
    const ageMin = v.dateUploaded
      ? (Date.now() - Date.parse(v.dateUploaded)) / 60000
      : Number.POSITIVE_INFINITY
    if (Number.isFinite(ageMin) && ageMin < IN_FLIGHT_MINUTES) {
      return {
        text: `no bytes YET — ${word}, created ${Math.max(0, Math.round(ageMin))} min ago: `
          + `the upload is probably still landing, re-run this in a minute`,
        inFlight: true,
      }
    }
    return {
      text: `0 bytes, ${word}`
        + (Number.isFinite(ageMin) ? `, ${Math.round(ageMin)} min old` : '')
        + ' — an abandoned upload, not a copy',
      inFlight: false,
    }
  }

  console.log(`${date}: ${rows.length} clip row(s)${boatName ? ` on ${boatName}` : ''}` +
    ` · ${lib.size} videos in the Stream library\n`)
  if (!rows.length) { console.log('nothing to check.'); return }

  let aOk = 0, bOk = 0, servesNothing = 0, lying = 0, dayOff = 0, legacyOnly = 0
  for (const r of rows) {
    const A = liveGuid(r.bunny_proxy_stream_id) || realPath(r.bunny_proxy_path)
    const B = liveGuid(r.bunny_original_stream_id) || realPath(r.bunny_original_path)

    // What a player is actually handed — the app's own order over what EXISTS.
    // Each step gated the way the ROUTE gates it: an HLS step needs a finished
    // ladder, an MP4 step needs an object.
    const exists: Record<string, boolean> = {
      originalHls: encodedGuid(r.bunny_original_stream_id),
      proxy: encodedGuid(r.bunny_proxy_stream_id) || realPath(r.bunny_proxy_path),
      originalMp4: realPath(r.bunny_original_path),
      legacyStream: encodedGuid(r.bunny_stream_id),
      legacy: realPath(r.bunny_storage_path),
    }
    const served = renditionOrder('auto').find((s) => exists[s]) || null

    // An upload Bunny has not yet accounted for is a RACE, not a lie. Calling
    // it one makes the instrument cry wolf on the very run that is testing a
    // fresh upload — which is what it did on 28 Nov 2026, seconds after Flow B
    // finished.
    const origLanding = guidNote(r.bunny_original_stream_id).inFlight
    const proxyLanding = guidNote(r.bunny_proxy_stream_id).inFlight

    const flagIssues: string[] = []
    if (r.has_proxy && !A && !proxyLanding) flagIssues.push('has_proxy set, no proxy exists')
    if (!r.has_proxy && A) flagIssues.push('proxy exists, has_proxy NOT set')
    // An upload Bunny has not yet accounted for is a RACE, not a lie. Calling
    // it one makes the instrument cry wolf on the very run that is testing a
    // fresh upload — which is exactly what it did on 28 Nov 2026, seconds
    // after Flow B finished.
    if (r.has_original && !B && !origLanding) flagIssues.push('has_original set, no original exists')
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
    for (const [which, guid, ok] of [
      ['proxy', r.bunny_proxy_stream_id, A], ['original', r.bunny_original_stream_id, B],
    ] as [string, string | null, boolean][]) {
      if (guid && !ok) {
        const n = guidNote(guid)
        if (n.text) console.log(`   · the ${which} Stream video ${guid.slice(0, 8)}: ${n.text}`)
      }
    }
    console.log(`   a player gets: ${served || '✕ NOTHING — every locator on this row is empty or dead'}`)
    // Name a ladder still being built, so "serves the MP4" is not read as a
    // fault. Bunny's free queue can take hours to days, and until it finishes
    // the Storage copy is the ONLY thing standing between the team and a
    // blank player — which is the whole reason the upload puts one there.
    for (const [which, guid] of [
      ['proxy', r.bunny_proxy_stream_id], ['original', r.bunny_original_stream_id],
    ] as [string, string | null][]) {
      if (liveGuid(guid) && lib.get(guid!)?.status !== 4) {
        console.log(`   · the ${which} ladder is still encoding on Bunny ` +
          `(status ${lib.get(guid!)?.status}) — the Storage MP4 is carrying playback`)
      }
    }
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
  console.log(`  as a 720p proxy    ${aOk}/${rows.length}`)
  console.log(`  at full size       ${bOk}/${rows.length}   ` +
    `(Upload originals, or Flow A sending as-is on a fast link)`)
  console.log(`  via a SUPPORTED route ${rows.length - legacyOnly - servesNothing}/${rows.length}` +
    (legacyOnly ? `   ← ${legacyOnly} came ONLY via the REMOVED flow` : ''))
  console.log(`  playable           ${rows.length - servesNothing}/${rows.length}` +
    (servesNothing ? `   ← ${servesNothing} row(s) serve NOTHING` : ''))
  console.log(`  flags truthful     ${rows.length - lying}/${rows.length}` +
    (lying ? `   ← ${lying} row(s) claim a rendition they do not have` : ''))
  if (dayOff) console.log(`  ⚠ ${dayOff} row(s) filed under a different day than their own title`)
  // A clip delivered by EITHER route is delivered. Flow A no longer always
  // produces a proxy: on a link faster than the encoder it sends the file as it
  // is, which is honestly recorded as the original (uploadStrategy.ts). A row
  // with an original and no proxy is that clip, not a failure — and demanding a
  // proxy on every row would report the better outcome as the worse one.
  const delivered = rows.filter((r) =>
    liveGuid(r.bunny_proxy_stream_id) || realPath(r.bunny_proxy_path) ||
    liveGuid(r.bunny_original_stream_id) || realPath(r.bunny_original_path)).length
  console.log(`  delivered          ${delivered}/${rows.length}` +
    (delivered < rows.length ? `   \u2190 ${rows.length - delivered} arrived by NEITHER route` : ''))
  if (!servesNothing && !lying && !dayOff && !legacyOnly && delivered === rows.length) {
    console.log(`\n  ✓ every row came through a supported route, serves a real rendition,`)
    console.log(`    and says so truthfully.`)
  } else if (rows.length && legacyOnly === rows.length) {
    console.log(`\n  ✕ NOT A PASS: every clip here arrived by the REMOVED flow. The app in`)
    console.log(`    that browser is not the app in this repo — hard-reload and upload again.`)
  } else if (delivered < rows.length) {
    console.log(`\n  \u2715 NOT A PASS: ${rows.length - delivered} of ${rows.length} clip(s) reached NEITHER route.`)
    console.log(`    A row with no rendition is a clip the team cannot watch at all.`)
  }
  console.log(`\nNothing has been changed.`)
}

main().catch((e) => fail(why(e)))
