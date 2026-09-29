// A day's drone/RIB footage → clips the team can watch, in one command.
//
//   npm run clips:day -- 2026-09-28                  what it would cut
//   npm run clips:day -- 2026-09-28 --write          cut it
//   npm run clips:day -- 2026-09-28 --turns --write  add the race manoeuvres
//
// WHY THIS EXISTS.
//
// select-race-clips.mjs does the work, but on 28 September getting to the point
// of running it took: a SQL query for the Grab video times, a second one to find
// which rounding was really the finish, a hunt for the card's mount point, a
// hunt for the event file, and a hand-built --at list. None of that is a
// decision. All of it is a lookup, and every one of them is somewhere this
// script can reach.
//
// So this resolves the day and calls the cutter. What it will not do is choose
// for you: it prints the plan and stops, and only --write encodes anything —
// the same shape as `npm run media:upload`.
//
// Needs .env.local (Supabase URL + service key), exiftool and ffmpeg on PATH,
// and the card mounted. In Claude Code's sandbox, run it outside the sandbox —
// /Volumes does not exist in there and neither does ffmpeg.

import { readFileSync, existsSync, readdirSync, unlinkSync, mkdirSync, renameSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'
// Plain JS, shared with the app, so the guns and roundings are read exactly
// as the tagger reads them.
import { parseXmlEvents } from '../src/lib/xmlEventParse.js'
import { inferFinish } from '../src/lib/tagging/raceWindow'
import { planOutbox } from '../src/lib/clipOutbox'

const USAGE = `Cut a day's footage into the clips worth watching.

Usage:
  npm run clips:day -- YYYY-MM-DD [--write] [--turns] [options]

  --write       encode (without this: report the plan and stop)
  --turns       include the race's tacks and gybes (default: starts, roundings
                and the moments the crew marked with Grab video)
  --card PATH   the footage folder, if it is not found under /Volumes
  --events PATH the .ev.xml, if it is not in ~/Downloads
  --finish TIME local HH:MM:SS, if SSA has no finish tag for the day
  --practice TIME  a gun that was a PRACTICE start: its start is cut, the
                milling about after it is not. Repeatable or comma-separated.
  --out DIR     the outbox (default: ~/clips — ONE folder, so the Upload tab's
                watcher is pointed at it once and never again)
  --keep        do not clear clips the cloud already has
  --boat ID     boat id, when more than one boat matches
  --all         do not restrict to the race — cut the training too
  --help        this text

Everything else is read from the day: the event file gives the guns, the
roundings and the venue offset; SSA gives the Grab video moments and the finish.
`

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
if (has('--help') || !args.length) { console.log(USAGE); process.exit(0) }

const fail = (m: string): never => { console.error(`✕ ${m}`); process.exit(1) }
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || fail('give a date: YYYY-MM-DD')
const compact = date.replace(/-/g, '')          // 20260928
const short = compact.slice(2)                  // 260928
const write = has('--write')
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19)

// ── env ──────────────────────────────────────────────────────────────────────
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

// ── the card ─────────────────────────────────────────────────────────────────
// Every camera and every trip names its folders differently, so look for the
// day's number anywhere under a mounted volume rather than insisting on a shape.
function findCard(): { path: string; raw: boolean } | null {
  const given = val('--card')
  if (given) {
    if (!existsSync(given)) fail(`--card: ${given} does not exist`)
    return { path: given, raw: /dcim/i.test(given) }
  }
  const vols = existsSync('/Volumes') ? readdirSync('/Volumes') : []

  // A card someone has already filed by day. Preferred, because it holds only
  // this day and the exiftool pass is over in seconds.
  for (const v of vols) {
    for (const sub of [`${compact}/Drone`, `${compact}/drone`, compact, `${date}/Drone`, date]) {
      const p = join('/Volumes', v, sub)
      if (existsSync(p)) return { path: p, raw: false }
    }
  }

  // A card straight out of the drone: DCIM/DJI_001, DCIM/100MEDIA, and the
  // volume itself is usually called "Untitled". The cutter recurses, so DCIM
  // covers every folder under it.
  //
  // Such a card holds EVERY day it has recorded, not just this one. That is
  // safe — a clip only becomes a segment if it overlaps a window from this
  // day's event file — but the timestamp pass reads all of them, so it is
  // slower and worth saying so rather than leaving it to look like a hang.
  for (const v of vols) {
    const dcim = join('/Volumes', v, 'DCIM')
    if (existsSync(dcim)) return { path: dcim, raw: true }
  }
  return null
}

// ── the event file ───────────────────────────────────────────────────────────
function findEvents(): string | null {
  const given = val('--events')
  if (given) return existsSync(given) ? given : fail(`--events: ${given} does not exist`)
  const dl = join(homedir(), 'Downloads')
  if (!existsSync(dl)) return null
  const hits = readdirSync(dl)
    .filter((f) => f.endsWith('.ev.xml') && (f.includes(short) || f.includes(compact)))
    .map((f) => join(dl, f))
  return hits.sort().reverse()[0] || null
}

// ── the windows ──────────────────────────────────────────────────────────────
// Set HERE, not left to the cutter's defaults, for one reason: the output
// filename starts with the segment's start time, so a lead that changes between
// two runs renames every clip and the second run encodes the whole day again
// beside the first. Owning them is what makes "run it again with the tacks" a
// seven-clip job instead of a twenty-clip one.
//
// 30/60 on a rounding and 30/30 on a marked moment are the crew's numbers, not
// the cutter's 60/90 and 45/75 — a rounding wants the exit more than the
// approach, and somebody presses Grab video just after they see the thing.
const WINDOWS = [
  '--top-lead', '30', '--top-lag', '60',
  '--gate-lead', '60', '--gate-lag', '60',
  '--photo-lead', '30', '--photo-lag', '30',
]

// ── the moments SSA knows about and the event file does not ──────────────────
/** Grab video presses, as local HH:MM:SS. Two shifts, both deliberate: t0 sits
 *  leadSec before the press, so the press itself is what goes to --at; and the
 *  database stores a true UTC instant, so it has to be brought into the event
 *  file's local frame, which is the one the cutter works in. */
async function grabVideoTimes(offsetMin: number): Promise<string[]> {
  const { data, error } = await sb
    .from('ssa_tag_events')
    .select('t0, slug, rejected')
    .eq('session_date', date).eq('slug', 'grab-video').eq('rejected', false)
    .order('t0')
  if (error) fail(`reading Grab video tags: ${error.message}`)
  const LEAD_MS = 30_000
  return (data || []).map((r) => clock(Date.parse(r.t0 as string) + LEAD_MS + offsetMin * 60_000))
}

/** When the race ended. The inference lives in lib/tagging/raceWindow, under
 *  test, because a wrong finish silently throws away the end of the race. */
async function finishTime(offsetMin: number, ev: any): Promise<{ time: string | null; how: string }> {
  const given = val('--finish')
  if (given) return { time: given, how: 'given on the command line' }

  const { data } = await sb
    .from('ssa_tag_events')
    .select('t0')
    .eq('session_date', date).eq('slug', 'race-finish').eq('rejected', false)
    .order('t0', { ascending: false }).limit(1)
  const tagged = (data || [])[0]

  // TWO CLOCKS, and they are not the same one. parseXmlEvents returns the
  // event file's LOCAL wall clock labelled as UTC — which is what the whole
  // cutter works in, so that no offset has to be supplied and none can be
  // applied twice. The database returns a true UTC instant. So the tag is
  // brought INTO the file's frame on the way in, and nothing is shifted on the
  // way out. Getting this wrong put the finish at 17:17 and threw away the
  // last two hours of the race.
  const r = inferFinish(ev.raceGuns || [], ev.markRoundings || [], {
    taggedUtc: tagged ? Date.parse(tagged.t0 as string) + offsetMin * 60_000 : null,
    dayStopUtc: ev.dayStopUtc ?? null,
  })
  return { time: r.utc == null ? null : clock(r.utc), how: r.how }
}

/**
 * Clear out clips the cloud already holds.
 *
 * One outbox, pointed at once by the watcher, means last night's clips are
 * still sitting in it tonight — and the watcher would cheerfully send them up a
 * second time. So they go, but only the ones the cloud demonstrably has: a
 * video row with nothing behind it in storage is not an upload, and deleting
 * against one throws away the only copy of that footage there is.
 *
 * Matching is by NAME (lib/clipOutbox), not by timestamp: a clip's start_utc
 * has been through the app's video-timezone setting on the way in, and a wrong
 * guess there would delete footage that was never uploaded.
 */
async function tidyOutbox(dir: string) {
  const files = existsSync(dir) ? readdirSync(dir) : []
  if (!files.length) return

  const { data, error } = await sb
    .from('videos')
    .select('title, bunny_storage_path, bunny_stream_id')
    .order('created_at', { ascending: false })
    .limit(2000)
  if (error) {
    console.log(`  outbox   could not check the cloud (${error.message}) — nothing removed`)
    return
  }
  const cloud = (data || []).map((v) => ({
    title: v.title as string | null,
    stored: !!(v.bunny_storage_path || v.bunny_stream_id),
  }))

  const plan = planOutbox(files, cloud)
  if (!plan.uploaded.length && !plan.pending.length) return

  if (!write) {
    console.log(`  outbox   ${plan.uploaded.length} clip(s) already uploaded would be removed` +
      (plan.pending.length ? `, ${plan.pending.length} kept (not up yet)` : ''))
    return
  }
  let gone = 0
  for (const f of plan.uploaded) {
    try { unlinkSync(join(dir, f)); gone++ } catch { /* already gone is fine */ }
  }
  console.log(`  outbox   removed ${gone} clip(s) the cloud already has` +
    (plan.pending.length ? `, kept ${plan.pending.length} not yet uploaded` : ''))
}

// ── go ───────────────────────────────────────────────────────────────────────
const main = async () => {
  const events = findEvents()
  if (!events) fail(`no .ev.xml for ${date} in ~/Downloads — pass --events`)
  const found = findCard()
  if (!found) fail(`no footage folder for ${date} under /Volumes — is the card mounted? pass --card`)
  const card = found!.path

  // The venue offset the event file itself declares, so nothing has to be typed
  // and nothing can be applied twice.
  const xml = readFileSync(events!, 'utf8')
  const offsetMin = Number(/<event_file hours="(-?\d+(?:\.\d+)?)"/.exec(xml)?.[1] ?? 0) * 60

  const ev = parseXmlEvents(xml)
  const at = await grabVideoTimes(offsetMin)
  const finish = await finishTime(offsetMin, ev)
  const out = val('--out') || join(homedir(), 'clips')
  mkdirSync(out, { recursive: true })

  console.log(`\n${date}  ${ev.meta?.boat || ''} ${ev.meta?.location || ''} (venue UTC${offsetMin >= 0 ? '+' : ''}${offsetMin / 60})`)
  console.log(`  events   ${events}`)
  console.log(`  footage  ${card}${found!.raw ? '  (card as the drone wrote it — every day on it is scanned, so the timestamp pass is slower)' : ''}`)
  console.log(`  clips    ${out}`)
  console.log(`  marked   ${at.length ? at.join(', ') : '(no Grab video tags on this day)'}`)
  console.log(`  finish   ${finish.time || '—'}  · ${finish.how}`)
  if (!has('--turns')) {
    const gun = Math.min(...(ev.raceGuns || []).map((g: any) => g.utc))
    const end = finish.time
      ? Date.parse(`${date}T${finish.time}Z`) - offsetMin * 60_000
      : (ev.dayStopUtc ?? Infinity)
    const n = (ev.tackJibes || []).filter((t: any) => t.utc >= gun && t.utc < end).length
    if (n) console.log(`  (${n} tacks/gybes in the race, left out — add --turns for those too)`)
  }

  const argv = ['-e', events!, card!, '--trim', '--tag', compact, '-o', out, ...WINDOWS]
  if (!has('--all')) argv.push('--racing')
  // Only the crew know which gun was a practice start; nothing in the event
  // file distinguishes it.
  const practice = val('--practice')
  if (practice) argv.push('--practice', practice)
  if (finish.time) argv.push('--finish', finish.time)
  if (at.length) argv.push('--at', at.join(','))
  if (!has('--turns')) argv.push('--no-turns')
  if (!write) argv.push('-n')

  if (!has('--keep')) await tidyOutbox(out)

  console.log('')
  const cutter = fileURLToPath(new URL('./select-race-clips.mjs', import.meta.url))
  const r = spawnSync('node', [cutter, ...argv], { stdio: 'inherit' })
  if (r.status === 0) {
    const progress = fileURLToPath(new URL('./clip-progress.mjs', import.meta.url))
    if (!write) {
      console.log('\nThat was a dry run. Same command with --write to encode.')
    } else {
      // One outbox means one manifest.json, overwritten by the next day's run.
      // --full-res replays a manifest, so the day's own is kept beside it.
      const m = join(out, 'manifest.json')
      if (existsSync(m)) {
        try { renameSync(m, join(out, `${compact}.manifest.json`)) } catch { /* not fatal */ }
      }
      console.log(`\nIn the Upload tab, hit Watch — it is pointed at ${out} and will take them as they land.`)
    }
    console.log(`Progress, in another terminal:\n  node ${progress} ${out} --watch`)
  }
  process.exit(r.status ?? 1)
}
main()
