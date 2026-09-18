// Replace a day's cloud log with one reduced at the CURRENT precision.
//
//   npx vite-node scripts/cloud-log-reupload.ts ~/Downloads/Lidar_maxis            dry run
//   … --write                                                                      store it
//
// WHY. The cloud copy of a log is trimmed and downsampled to fit the upload route, and
// until 2026-09-17 it also rounded EVERY number to 2 dp. For instruments that is right;
// for position it is catastrophic — 0.01° of latitude is about 1.1 km, so a day of
// sailing snapped onto a kilometre grid and the track redrew itself as a staircase. One
// measured day: 2,430 rows holding 28 distinct positions. src/lib/cloudLogRound.ts fixed
// the rounding, but only for logs imported after it; days already in the cloud stay
// coarse until their full-resolution log is reduced again. That is this script.
//
// TWO MODES, and `patch` is the default because it changes only what we set out to
// change:
//
//   patch   Keep the stored rows, columns and time window EXACTLY as they are, and
//           overwrite lat/lon alone, interpolated from the full-resolution log to each
//           stored row's own timestamp. Nothing else moves.
//
//   reduce  Re-reduce the day from scratch with src/lib/cloudLogReduce.js, the same code
//           the app uses on import. Correct, and what a fresh import would produce — but
//           it also rebuilds the row set, and a source export whose channels differ from
//           the one originally imported changes the row COUNT and the column set as a
//           side effect. On 2026-09-08 it keeps 47 channels where the stored copy has 41,
//           which pushes 6,895 rows over the 4 MB budget and halves them to 3,448 —
//           trading half the time resolution for position precision nobody asked to
//           trade. It also drops pBurn/sBurn, which that export does not carry.
//
// Use `reduce` when the stored copy is wrong in more ways than position, or when there is
// no stored copy worth keeping.
//
// WHAT IT TOUCHES. `sessions.log_data`, and nothing else. Not tz_offset_minutes (already
// right), not xml_data, not phase stats. Sail-shape lidar is a separate write to
// session_phase_stats — use scripts/lidar-import.ts for that, on the same files.
//
// WHAT IT REFUSES. A day with no session row (nothing to update — import it in the app
// first). A day whose CSV parses to zero rows, which is how the UtcDate/UtcTime export
// used to fail: silently, with no error. And a day where the file does not COVER the
// window already stored, unless --allow-shorter is passed, because replacing a longer
// log with a shorter one loses the ends.
//
// Uses the service key from .env.local. Writes nothing without --write.
// In Claude Code's sandbox, run it outside the sandbox (Node's fetch ignores the proxy).

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, resolve, basename } from 'path'
import { homedir } from 'os'
import { createClient } from '@supabase/supabase-js'
import { parseLog } from '../src/lib/logParse'
import { isSubSecondLog, thinToOneHz } from '../src/lib/logResolution'
// @ts-ignore — plain JS, lifted out of the UI component unchanged
import { reduceLogForCloud } from '../src/lib/cloudLogReduce'

const USAGE = `Re-reduce a day's log and replace the coarse cloud copy.

Usage:
  npx vite-node scripts/cloud-log-reupload.ts PATH [PATH …] [--write] [--allow-shorter]

  PATH              a folder (every .csv in it) or a single .csv; quote paths with spaces
  --write           store the result (without it: dry run, nothing is written)
  --allow-shorter   also replace a day whose file does not cover the stored window
  --only DATE       just this date (repeatable)
  --mode patch      overwrite lat/lon only, keeping every stored row (DEFAULT)
  --mode reduce     rebuild the whole cloud copy from the file
  --help            this text

Needs .env.local (Supabase URL + service key).`

const args = process.argv.slice(2)
if (args.includes('--help') || !args.length) { console.log(USAGE); process.exit(0) }
const write = args.includes('--write')
const allowShorter = args.includes('--allow-shorter')
const modeArg = args[args.indexOf('--mode') + 1]
const mode: 'patch' | 'reduce' = args.includes('--mode') && modeArg === 'reduce' ? 'reduce' : 'patch'
if (args.includes('--mode') && !['patch', 'reduce'].includes(modeArg || '')) {
  console.error(`--mode must be patch or reduce\n\n${USAGE}`); process.exit(1)
}
const only = args.flatMap((a, i) => (a === '--only' ? [args[i + 1]] : [])).filter(Boolean)
const pathArgs = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--only' && args[i - 1] !== '--mode')

const inputFiles = pathArgs.flatMap(a => {
  const p = resolve(a.replace(/^~(?=\/|$)/, homedir()))
  if (!existsSync(p)) { console.error(`Not found: ${a}\n\n${USAGE}`); process.exit(1) }
  if (!statSync(p).isDirectory()) return [p]
  return readdirSync(p).filter(f => /\.csv$/i.test(f) && statSync(join(p, f)).isFile()).sort().map(f => join(p, f))
})

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter(l => /^[A-Z0-9_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Supabase URL / service key missing in .env.local'); process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const hms = (t: unknown) => (typeof t === 'number' && Number.isFinite(t)) ? new Date(t).toISOString().slice(11, 19) : '  ??  '
const dayOf = (f: string) => { const m = basename(f).match(/(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null }
/** Distinct lat/lon pairs — the number that shows the staircase for what it is. */
const distinctPos = (rows: any[]) => new Set(rows.filter(r => r.lat != null && r.lon != null).map(r => `${r.lat},${r.lon}`)).size
const maxDp = (rows: any[]) => {
  const d = (n: number) => { const s = String(n); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1 }
  const withPos = rows.filter(r => r.lat != null && r.lon != null).slice(0, 5000)
  return withPos.length ? Math.max(...withPos.map(r => Math.max(d(r.lat), d(r.lon)))) : 0
}

/**
 * Position at an exact instant, interpolated from the full-resolution log.
 *
 * The stored rows do not always sit on whole seconds — a day imported from a
 * sub-second log carries stamps like 09:02:07.836 — so snapping to the nearest 1 Hz
 * row would place the boat up to half a second out. At racing speed that is a couple
 * of metres: nothing beside the 1.1 km it replaces, but there is no reason to accept
 * it when the two bracketing rows make the exact answer available.
 *
 * Returns null when the instant is not bracketed within `tolMs` — a stored row from a
 * stretch this file does not cover keeps the position it already has rather than being
 * handed a guess.
 */
function positionAt(
  src: { utc: number; lat: number; lon: number }[], t: number, tolMs = 1500,
): { lat: number; lon: number } | null {
  // Five decimals, matching CLOUD_DP in src/lib/cloudLogRound.ts — about a metre, and
  // the same precision a fresh import would store. Applied on EVERY path out of here,
  // including the two boundary ones: leaving those unrounded put the raw seven decimals
  // on the first and last row of a day, which is harmless but means the stored copy no
  // longer has one consistent precision.
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5
  const at = (i: number) => ({ lat: r5(src[i].lat), lon: r5(src[i].lon) })

  if (!src.length) return null
  let lo = 0, hi = src.length - 1
  if (t <= src[0].utc) return Math.abs(src[0].utc - t) <= tolMs ? at(0) : null
  if (t >= src[hi].utc) return Math.abs(src[hi].utc - t) <= tolMs ? at(hi) : null
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (src[mid].utc <= t) lo = mid; else hi = mid }
  const a = src[lo], b = src[hi]
  if (t - a.utc > tolMs && b.utc - t > tolMs) return null
  const span = b.utc - a.utc
  if (span <= 0) return at(lo)
  const f = (t - a.utc) / span
  return { lat: r5(a.lat + (b.lat - a.lat) * f), lon: r5(a.lon + (b.lon - a.lon) * f) }
}

async function main() {
  if (!inputFiles.length) { console.error('No .csv files found'); process.exit(1) }

  // One file per day. Later paths win, so a folder of better exports can be passed
  // after a folder of plainer ones.
  const byDay = new Map<string, string>()
  const skippedNoDate: string[] = []
  for (const f of inputFiles) {
    const d = dayOf(f)
    if (!d) { skippedNoDate.push(basename(f)); continue }
    if (only.length && !only.includes(d)) continue
    byDay.set(d, f)
  }
  if (skippedNoDate.length) console.log(`No date in filename, skipped: ${skippedNoDate.join(', ')}\n`)

  // Array.from, not spread: tsconfig targets es5.
  const days = Array.from(byDay.keys()).sort()
  const { data: sessions, error } = await sb.from('sessions')
    .select('id, date, team_id, boat_id, tz_offset_minutes, log_data, xml_data, boats(name)')
    .in('date', days)
  if (error) { console.error(`sessions: ${error.message}`); process.exit(1) }

  const perDay = new Map<string, any[]>()
  for (const s of sessions || []) perDay.set(s.date, [...(perDay.get(s.date) || []), s])

  console.log(`mode=${mode}  ${write ? 'WRITING to sessions.log_data' : 'dry run — nothing is written'}\n`)
  console.log('day         boat          stored                          →  new                             positions')

  let ok = 0, wrote = 0
  const problems: string[] = []

  for (const day of days) {
    const rows = perDay.get(day) || []
    if (!rows.length) { problems.push(`${day}: no session row — import it in the app first`); continue }
    if (rows.length > 1) { problems.push(`${day}: ${rows.length} sessions (more than one boat) — not touching it`); continue }
    const s = rows[0]
    const file = byDay.get(day)!
    const tz = s.tz_offset_minutes ?? 120

    const parsed: any = parseLog(readFileSync(file, 'utf8'), { tzOffsetMin: tz })
    if (!parsed.rows.length) {
      problems.push(`${day}: ${basename(file)} parsed to ZERO rows — wrong format, not overwriting anything`)
      continue
    }
    // The app keeps a 1 Hz copy of a sub-second log before reducing; match it.
    const logRows = isSubSecondLog(parsed.rows) ? thinToOneHz(parsed.rows) : parsed.rows

    const before = s.log_data?.rows || []
    let cloudLog: any
    let patched = 0, unmatched = 0

    if (mode === 'patch') {
      if (!before.length) {
        problems.push(`${day}: nothing stored to patch — run with --mode reduce to build it`)
        continue
      }
      const src = logRows
        .filter((r: any) => Number.isFinite(r.lat) && Number.isFinite(r.lon))
        .map((r: any) => ({ utc: r.utc, lat: r.lat, lon: r.lon }))
        .sort((a: any, b: any) => a.utc - b.utc)
      // Only lat/lon are replaced. Every other field, the row order, the row count and
      // the window are the stored ones, untouched.
      const rows = before.map((r: any) => {
        const pos = positionAt(src, r.utc)
        if (!pos) { if (r.lat != null) unmatched++; return r }
        patched++
        return { ...r, lat: pos.lat, lon: pos.lon }
      })
      cloudLog = { ...s.log_data, rows }
    } else {
      cloudLog = reduceLogForCloud(
        { rows: logRows, fileName: basename(file), startUtc: parsed.startUtc, endUtc: parsed.endUtc, tzOffset: tz },
        s.xml_data,
      )
    }
    const b0 = before[0]?.utc, b1 = before[before.length - 1]?.utc
    const n0 = cloudLog.rows[0]?.utc, n1 = cloudLog.rows[cloudLog.rows.length - 1]?.utc
    const covers = !before.length || (n0 <= b0 + 60_000 && n1 >= b1 - 60_000)
    const mb = (JSON.stringify(cloudLog).length / 1048576).toFixed(2)

    console.log(
      `${day}  ${(s.boats?.name || '').padEnd(13)} ` +
      `${hms(b0)}..${hms(b1)} ${String(before.length).padStart(5)}r ${maxDp(before)}dp ${String(distinctPos(before)).padStart(5)}p  →  ` +
      `${hms(n0)}..${hms(n1)} ${String(cloudLog.rows.length).padStart(5)}r ${maxDp(cloudLog.rows)}dp ${String(distinctPos(cloudLog.rows)).padStart(5)}p  ` +
      `${mb}MB` +
      (mode === 'patch' ? `  patched ${patched}${unmatched ? `, ${unmatched} left as-is` : ''}` : covers ? '' : '  SHORTER')
    )

    // In patch mode the window is the stored one by construction, so the cover check
    // only means anything for a full re-reduce.
    // The reduce path enforces a 4 MB budget (see cloudLogReduce). Patching adds a few
    // bytes a row, which cannot realistically breach it — but the payload has to fit the
    // upload route or the day becomes unreadable, so it is checked rather than assumed.
    const bytes = JSON.stringify(cloudLog).length
    if (bytes > 4_000_000) {
      problems.push(`${day}: patched payload is ${(bytes / 1048576).toFixed(2)} MB, over the 4 MB budget — not writing it`)
      continue
    }

    if (mode === 'reduce' && !covers && !allowShorter) {
      problems.push(`${day}: file does not cover the stored window (${hms(n0)}..${hms(n1)} vs ${hms(b0)}..${hms(b1)}) — pass --allow-shorter to replace it anyway`)
      continue
    }
    ok++
    if (write) {
      const { error: upErr } = await sb.from('sessions').update({ log_data: cloudLog }).eq('id', s.id)
      if (upErr) problems.push(`${day}: update failed — ${upErr.message}`)
      else wrote++
    }
  }

  console.log(`\n${ok} day(s) ready${write ? `, ${wrote} written` : ''}`)
  if (problems.length) {
    console.log(`\n${problems.length} not done:`)
    for (const p of problems) console.log(`  · ${p}`)
  }
  if (!write && ok) console.log('\nAdd --write to store it.')
}

main().catch(e => { console.error(e); process.exit(1) })
