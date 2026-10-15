// scripts/sailscan-conditions-backfill.ts
// ─────────────────────────────────────────────────────────────────────────────
// Put the day's TWS and TWA on sail scans that were imported without them, so
// they stop filing under "TWS unknown" in the boat view, the sail inventory and
// sail media.
//
//   npx vite-node scripts/sailscan-conditions-backfill.ts --boat "Baraka GP"
//   …then the same line with --write
//
// WHY THEY ARE EMPTY, which is two things and not one:
//
//   1. The IMPORT leaves tws_kn/twa_deg NULL on purpose. The Sail Vision report
//      prints its own wind and it is actively wrong on at least one page
//      ("Boat speed 8.6 kn Wind strength 0.0 kn"), so the import refuses it and
//      leaves the field for the log to fill. Nothing filled it.
//   2. The scans have no SESSION either, so nothing could find the day's log to
//      fill it from. `enrichScan` derives a 120 s window average perfectly well
//      — but it is pure, and the caller hands it the rows. In the browser those
//      rows come from IndexedDB, so the panel shows a TWS to whoever imported
//      that day's CSV and "unknown" to everybody else. Exactly the trap
//      CLAUDE.md records for a photo's instrument data.
//
// So this reads the CLOUD log, as `media:upload` does for photos, and stores the
// answer on the row where every reader can see it.
//
// IT DROPS FROZEN ROWS FIRST. Baraka's instruments blanked for periods, and a
// blanked channel keeps being logged at its last value — on 11 Oct twa/tws/awa
// held 08:21:00's values until 08:26:30. Four of her scans are at 08:27-08:32,
// so a 120 s window centred there reaches back into that span and would average
// a stale number in with live ones. A repeated value is not a reading, so
// `frozenReport` is used to take them out, and a window that loses rows that way
// says so.
//
// The window is computed by `computeScanWindow` — the same function the app
// calls — because the one time this codebase grew a second implementation of a
// derived quantity the two agreed until they didn't.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { computeScanWindow } from '../src/lib/scanConditions'
import { frozenReport, frozenAt, type LogRowLike } from '../src/lib/logFrozen'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const FORCE = args.includes('--force')
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const BOAT = flag('--boat')
const WINDOW_SEC = Number(flag('--window') ?? 120)
if (!BOAT) {
  console.error('usage: sailscan-conditions-backfill.ts --boat "Baraka GP" [--window 120] [--force] [--write]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19)
const f1 = (v: number | null | undefined) => (v == null ? '   —' : v.toFixed(1).padStart(5))

async function main() {
  const { data: boats } = await sb.from('boats').select('id, name').ilike('name', BOAT!)
  if (!boats?.length) { console.error(`no boat matching "${BOAT}"`); process.exit(1) }
  if (boats.length > 1) { console.error(`"${BOAT}" matches ${boats.length} boats`); process.exit(1) }
  const boat = boats[0]

  const { data: sails } = await sb.from('sails').select('id, name').eq('boat_id', boat.id)
  const sailName = new Map((sails ?? []).map((s) => [s.id, s.name as string]))
  const { data: scans, error } = await sb.from('sail_scans')
    .select('id, sail_id, session_id, captured_at, tws_kn, twa_deg')
    .in('sail_id', (sails ?? []).map((s) => s.id)).order('captured_at')
  if (error) { console.error(`sail_scans: ${error.message}`); process.exit(1) }
  const todo = (scans ?? []).filter((s) => FORCE || s.tws_kn == null || s.twa_deg == null)
  console.log(`${boat.name} · ${(scans ?? []).length} scan(s), ${todo.length} without conditions`
    + `${WRITE ? ' · WRITING' : ' · dry run'}\n`)
  if (!todo.length) return

  // One session per DAY, found by date — the scans carry no session_id, which is
  // half the reason they are empty.
  const days = Array.from(new Set(todo.map((s) => String(s.captured_at).slice(0, 10))))
  const { data: sessions } = await sb.from('sessions')
    .select('id, date, log_data').eq('boat_id', boat.id).in('date', days)
  const byDay = new Map((sessions ?? []).map((s) => [s.date as string, s]))

  let done = 0, noSession = 0, noLog = 0, noWindow = 0
  for (const day of days) {
    const ses = byDay.get(day)
    const rows = ((ses?.log_data as { rows?: LogRowLike[] } | null)?.rows ?? []) as LogRowLike[]
    console.log(`── ${day}  ${ses ? `session ${String(ses.id).slice(0, 8)}` : 'NO SESSION'}`
      + `  ${rows.length} log row(s)`)
    if (!ses) { noSession += todo.filter((s) => String(s.captured_at).startsWith(day)).length; console.log('   nothing to enrich from\n'); continue }
    if (!rows.length) { noLog += todo.filter((s) => String(s.captured_at).startsWith(day)).length; console.log('   session has no log\n'); continue }

    // Only the spans heel says are DEAD. A channel holding a value is not
    // automatically broken: the same day has bsp and vmg at exactly 0 for ten
    // minutes with the boat stopped, which is a true reading and the commonest
    // span there is. Dropping those rows threw away their live WIND readings
    // too — 1099 rows of 5719 on 10 Oct, a fifth of the day — because a row was
    // dropped if any channel on it was frozen. Heel moving across the span is
    // what separates a dead feed from a boat sitting still, and it is already
    // computed, so it decides this.
    // ...and only the WIND channels, which are the ones being averaged here. A
    // frozen bsp cannot bias a TWS average, and judging it would mean settling
    // whether a boat at exactly 0 kn is stopped or has a dead paddlewheel —
    // 10 Oct holds bsp and vmg at 0 for 698 rows while heel rolls through 10°,
    // which is a boat lying in a swell, not a fault. Not a question this script
    // needs an answer to, so it does not ask it.
    const spans = frozenReport(rows, { minSeconds: 30, channels: ['twa', 'tws', 'awa', 'aws', 'twd'] })
      .filter((f) => (f.witnessRange ?? 0) > 5)
    const live = rows.filter((r) => !frozenAt(spans, r.utc).length)
    if (live.length !== rows.length) {
      console.log(`   ${rows.length - live.length} row(s) dropped — the feed was dead across them`
        + ` (${spans.map((s) => s.channel).filter((c, i, a) => a.indexOf(c) === i).join(',')};`
        + ` heel moved ${Math.max(...spans.map((s) => s.witnessRange ?? 0)).toFixed(1)}°)`)
    }

    for (const s of todo.filter((x) => String(x.captured_at).startsWith(day))) {
      const ms = Date.parse(String(s.captured_at))
      const win = computeScanWindow(live, ms, WINDOW_SEC)
      const tws = win?.averages?.tws ?? null
      const twa = win?.averages?.twa ?? null
      const lost = computeScanWindow(rows, ms, WINDOW_SEC)
      const note = win == null ? '  ← no live rows in the window'
        : lost && lost.averages.tws != null && tws != null && Math.abs(lost.averages.tws - tws) > 0.2
          ? `  (frozen rows would have made it ${f1(lost.averages.tws)})`
          : ''
      console.log(`   ${hms(ms)}  ${String(sailName.get(s.sail_id) ?? '?').padEnd(6)}`
        + `  tws ${f1(tws)} kn  twa ${f1(twa)}°${note}`)
      if (tws == null && twa == null) { noWindow++; continue }
      if (WRITE) {
        const { error: uErr } = await sb.from('sail_scans')
          .update({ tws_kn: tws, twa_deg: twa, session_id: s.session_id ?? ses.id }).eq('id', s.id)
        if (uErr) { console.error(`   ! ${uErr.message}`); process.exit(1) }
      }
      done++
    }
    console.log('')
  }

  console.log(`${done} ${WRITE ? 'written' : 'to write'}`
    + (noSession ? ` · ${noSession} with no session for the day` : '')
    + (noLog ? ` · ${noLog} whose session has no log` : '')
    + (noWindow ? ` · ${noWindow} with no live log rows within ${WINDOW_SEC / 2}s` : ''))
  if (!WRITE && done) console.log('\nRe-run with --write to store. It also sets session_id, which is what lets')
  console.log('the app re-derive the rest (point of sail, sails up) for itself.')
}
main()
