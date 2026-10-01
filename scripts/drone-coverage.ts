// scripts/drone-coverage.ts — where the drone was actually filming, on the track.
//
//   npm run drone:coverage -- 2026-09-30
//   npm run drone:coverage -- 2026-09-30 --write
//   npm run drone:coverage -- --all            (every dated folder on the card)
//
// Run it when the drive is plugged in. It reads the card, works out when the
// drone was recording and which parts are already cut, and stores both with the
// day — so the Tags tab track can draw them:
//
//   light green   footage exists here
//   dark green    and this part is already a clip
//
// WHY IT EXISTS. On 30 September the top mark at 14:42:24 and the gate at
// 15:05:33 were both tagged and neither produced a clip: the drone was on the
// deck through a 14-minute gap for one and had landed before the other. Nothing
// in the app could say so — "no clip" and "no footage" looked identical — and
// the only way to find out was to read the cutter's table line by line, on the
// one machine with the card in it.
//
// The scan is the CUTTER's, run dry with --coverage. It already has the only
// implementation of "when was this filmed" (the SRT sidecar where there is one,
// exiftool otherwise), and a second one would be a second thing to get wrong.
//
// Dry-run by default like every script here; --write stores it.

import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { spawnSync } from 'child_process'
import { join, resolve } from 'path'
import { homedir, tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import { mergeSpans, clampToFootage, spanTotal, type Span } from '../src/lib/droneCoverage'

const USAGE = `Where the drone was filming, drawn on the track.

Usage:
  npm run drone:coverage -- YYYY-MM-DD [--write] [options]
  npm run drone:coverage -- --all [--write]

  --write       store it (without this: report and stop)
  --all         every dated folder the card holds, not one day
  --card PATH   the footage folder, if it is not found under /Volumes
  --tz HOURS    venue offset, if the session has none stored
  --help        this text
`

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
if (has('--help')) { console.log(USAGE); process.exit(0) }

const fail: (m: string) => never = (m) => { console.error(`\n✕ ${m}\n`); process.exit(1) }

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

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19)
const mins = (ms: number) => `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`

/** Dated folders on the card: 20260930/Drone, 20260930/drone, 20260930. */
function cardFor(date: string): string | null {
  const given = val('--card')
  if (given) return existsSync(given) ? given : fail(`--card: ${given} does not exist`)
  const compact = date.replace(/-/g, '')
  let vols: string[] = []
  try { vols = readdirSync('/Volumes') } catch { /* not a Mac, or nothing mounted */ }
  for (const v of vols) {
    for (const sub of [`${compact}/Drone`, `${compact}/drone`, compact, `${date}/Drone`, date]) {
      const p = join('/Volumes', v, sub)
      try { if (statSync(p).isDirectory()) return p } catch { /* next */ }
    }
  }
  return null
}

/** Every dated folder the card holds, for --all. */
function datesOnCard(): string[] {
  const out = new Set<string>()
  let vols: string[] = []
  try { vols = readdirSync('/Volumes') } catch { /* */ }
  for (const v of vols) {
    let entries: string[] = []
    try { entries = readdirSync(join('/Volumes', v)) } catch { continue }
    for (const e of entries) {
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(e)
      if (m) out.add(`${m[1]}-${m[2]}-${m[3]}`)
    }
  }
  return Array.from(out).sort()
}

/** The venue offset: --tz, else the session's stored one. Never guessed — a
 *  wrong one puts every band an offset off the track it annotates. */
async function offsetFor(date: string): Promise<{ min: number; from: string }> {
  if (has('--tz')) return { min: Math.round(Number(val('--tz') ?? 0) * 60), from: '--tz' }
  const { data } = await sb.from('sessions').select('tz_offset_minutes').eq('date', date).limit(1)
  const m = data?.[0]?.tz_offset_minutes
  if (m != null) return { min: Number(m), from: "the session's stored offset" }
  return fail(`no venue offset for ${date}: the session has none stored. Pass --tz 2 for UTC+2.`)
}

interface CardScan { fileCount: number; footage: Span[]; clips: Span[] }

/** Run the cutter dry, purely for its scan. */
function scanCard(card: string, date: string): CardScan {
  const tmp = join(mkdtempSync(join(tmpdir(), 'ssa-cov-')), 'coverage.json')
  const cutter = fileURLToPath(new URL('./select-race-clips.mjs', import.meta.url))
  // --only-at with no --at selects nothing, so this is a pure scan: no windows,
  // no event file needed, and nothing is encoded because -n stops before that.
  const r = spawnSync('node', [cutter, card, '-n', '--coverage', tmp, '--only-at'], {
    encoding: 'utf8',
  })
  if (!existsSync(tmp)) {
    fail(`the scan produced nothing for ${date}.\n  ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n  ')}`)
  }
  const j = JSON.parse(readFileSync(tmp, 'utf8'))
  try { unlinkSync(tmp) } catch { /* */ }
  return { fileCount: j.fileCount || 0, footage: j.footage || [], clips: j.clips || [] }
}

/**
 * Which parts are already cut.
 *
 * From the day's manifest in the outbox, which is the record of what the cutter
 * actually made — not what a fresh selection WOULD make. A clip deleted from
 * SSA on purpose should not come back as a dark band saying it exists.
 */
function cutFromManifest(date: string): Span[] {
  const compact = date.replace(/-/g, '')
  const out = val('--out') || join(homedir(), 'clips')
  const path = join(out, `${compact}.manifest.json`)
  if (!existsSync(path)) return []
  try {
    const m = JSON.parse(readFileSync(path, 'utf8'))
    return (m.items || [])
      .filter((i: { startWall?: string }) => i.startWall)
      .map((i: { startWall: string; durSec?: number }) => {
        const from = Date.parse(`${i.startWall}Z`)
        return { from, to: from + (i.durSec || 0) * 1000 }
      })
      .filter((s: Span) => Number.isFinite(s.from) && s.to > s.from)
  } catch { return [] }
}

async function doDate(date: string, write: boolean): Promise<void> {
  const card = cardFor(date)
  if (!card) {
    console.log(`\n${date}  — no footage folder under /Volumes (is the drive connected?)`)
    return
  }
  const { min: tzMin, from: tzFrom } = await offsetFor(date)
  const scan = scanCard(card, date)
  const manifestCut = cutFromManifest(date)

  // WALL CLOCK → TRUE UTC, once, here. The card is venue-local; everything in
  // SSA is UTC. See CLAUDE.md's first trap.
  const toUtc = (s: Span): Span => ({ from: s.from - tzMin * 60_000, to: s.to - tzMin * 60_000 })
  const footage = mergeSpans(scan.footage.map(toUtc))
  const cut = clampToFootage(mergeSpans([...scan.clips, ...manifestCut].map(toUtc)), footage)

  console.log(`\n${date}  ${card}`)
  console.log(`  ${scan.fileCount} file(s) · venue UTC${tzMin >= 0 ? '+' : ''}${tzMin / 60} (from ${tzFrom})`)
  if (!footage.length) { console.log('  no timed footage on the card for this day'); return }
  console.log(`  filming  ${mins(spanTotal(footage))} across ${footage.length} recording(s)`)
  for (const s of footage) {
    const local = (ms: number) => clock(ms + tzMin * 60_000)
    console.log(`    ${local(s.from)} → ${local(s.to)}  (${mins(s.to - s.from)})`)
  }
  console.log(`  cut      ${mins(spanTotal(cut))} in ${cut.length} clip(s)` +
    (manifestCut.length ? ` · from ${date.replace(/-/g, '')}.manifest.json` : ' · nothing cut yet'))

  if (!write) return

  const { data: session } = await sb.from('sessions').select('id').eq('date', date).limit(1)
  const id = session?.[0]?.id
  if (!id) { console.log(`  ⚠ no session row for ${date} — nothing to attach it to`); return }
  const { error } = await sb.from('sessions').update({
    drone_coverage: {
      footage, clips: cut,
      scannedAt: new Date().toISOString(),
      tzOffsetMin: tzMin,
      fileCount: scan.fileCount,
    },
  }).eq('id', id)
  if (error) { console.log(`  ✕ ${error.message}`); return }
  console.log('  ✓ stored — the Tags tab track will show it')
}

const main = async () => {
  const write = has('--write')
  const dates = has('--all')
    ? datesOnCard()
    : [args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || fail('which day? e.g. 2026-09-30, or --all')]
  if (!dates.length) fail('no dated folders on the card — is the drive connected?')
  for (const d of dates) await doDate(d, write)
  if (!write) console.log('\nThat was a dry run. Same command with --write to store it.\n')
  else console.log('')
}
main()
