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

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'

const USAGE = `Cut a day's footage into the clips worth watching.

Usage:
  npm run clips:day -- YYYY-MM-DD [--write] [--turns] [options]

  --write       encode (without this: report the plan and stop)
  --turns       include the race's tacks and gybes (default: starts, roundings
                and the moments the crew marked with Grab video)
  --card PATH   the footage folder, if it is not found under /Volumes
  --events PATH the .ev.xml, if it is not in ~/Downloads
  --finish TIME local HH:MM:SS, if SSA has no finish tag for the day
  --out DIR     where clips go (default: ~/clips/<YYYYMMDD>)
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
function findCard(): string | null {
  const given = val('--card')
  if (given) return existsSync(given) ? given : fail(`--card: ${given} does not exist`)
  const vols = existsSync('/Volumes') ? readdirSync('/Volumes') : []
  const tries: string[] = []
  for (const v of vols) {
    for (const sub of [`${compact}/Drone`, `${compact}/drone`, compact, `${date}/Drone`, date]) {
      tries.push(join('/Volumes', v, sub))
    }
  }
  return tries.find((p) => existsSync(p)) || null
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

// ── the moments SSA knows about and the event file does not ──────────────────
/** Grab video presses, as local HH:MM:SS. t0 sits leadSec before the press, so
 *  the press itself is what goes to --at. */
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

/** When the race ended. Expedition does not record it; SSA's finish tag does. */
async function finishTime(offsetMin: number): Promise<string | null> {
  const given = val('--finish')
  if (given) return given
  const { data } = await sb
    .from('ssa_tag_events')
    .select('t0')
    .eq('session_date', date).eq('slug', 'race-finish').eq('rejected', false)
    .order('t0', { ascending: false }).limit(1)
  const row = (data || [])[0]
  return row ? clock(Date.parse(row.t0 as string) + offsetMin * 60_000) : null
}

// ── go ───────────────────────────────────────────────────────────────────────
const main = async () => {
  const events = findEvents()
  if (!events) fail(`no .ev.xml for ${date} in ~/Downloads — pass --events`)
  const card = findCard()
  if (!card) fail(`no footage folder for ${date} under /Volumes — is the card mounted? pass --card`)

  // The venue offset the event file itself declares, so nothing has to be typed
  // and nothing can be applied twice.
  const xml = readFileSync(events!, 'utf8')
  const offsetMin = Number(/<event_file hours="(-?\d+(?:\.\d+)?)"/.exec(xml)?.[1] ?? 0) * 60

  const at = await grabVideoTimes(offsetMin)
  const finish = await finishTime(offsetMin)
  const out = val('--out') || join(homedir(), 'clips', compact)

  console.log(`\n${date}  (venue UTC${offsetMin >= 0 ? '+' : ''}${offsetMin / 60})`)
  console.log(`  events   ${events}`)
  console.log(`  footage  ${card}`)
  console.log(`  clips    ${out}`)
  console.log(`  marked   ${at.length ? at.join(', ') : '(no Grab video tags)'}`)
  console.log(`  finish   ${finish || '(no finish tag — the race runs to the end of the day)'}`)

  const argv = ['-e', events!, card!, '--trim', '--tag', compact, '-o', out]
  if (!has('--all')) argv.push('--racing')
  if (finish) argv.push('--finish', finish)
  if (at.length) argv.push('--at', at.join(','), '--photo-lead', '45', '--photo-lag', '75')
  if (!has('--turns')) argv.push('--no-turns')
  if (!write) argv.push('-n')

  console.log('')
  const cutter = fileURLToPath(new URL('./select-race-clips.mjs', import.meta.url))
  const r = spawnSync('node', [cutter, ...argv], { stdio: 'inherit' })
  if (!write && r.status === 0) {
    console.log('\nThat was a dry run. Add --write to encode.')
    console.log(`Progress, in another terminal:  node scripts/clip-progress.mjs ${out} --watch`)
  }
  process.exit(r.status ?? 1)
}
main()
