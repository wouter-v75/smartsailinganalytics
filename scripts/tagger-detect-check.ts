// Why does the tagger show no tacks, gybes or roundings for this day?
//
//   npx vite-node scripts/tagger-detect-check.ts -- --boat "Baraka GP" --date 2026-10-09
//   …or --date alone, to take whichever boat has that day
//
// READ-ONLY. There is no --write: this answers a question, it does not fix
// anything.
//
// The tagger derives everything from the day's log the moment it opens — the
// same detectDay() the app calls, no event file required. So "nothing is
// showing" has exactly four possible causes, and they need different fixes:
//
//   1. THE ROWS ARE NOT THERE.        No session, or log_data.rows empty — the
//                                     log never parsed or never synced.
//   2. THE ROWS LACK twa OR bsp.      detectFromLog() needs both: it finds a
//                                     manoeuvre where TWA changes sign above
//                                     minBsp. A log profile that maps neither
//                                     gives a perfect track and no manoeuvres.
//   3. TWA IS UNSIGNED.               Some Expedition setups log 0-180 rather
//                                     than ±180. Nothing ever changes sign, so
//                                     the detector finds nothing, for ever, on
//                                     a day that is full of tacks.
//   4. NOTHING WAS FAST ENOUGH.       minBsp is 6 kn. A light day, or a boat
//                                     logging BSP in km/h or m/s, detects
//                                     nothing.
//
// It also says what CANNOT be detected without an event file, because that is
// not a fault to hunt: race starts, the day's two ends and sail changes come
// from the file only. The gun is a sound; nothing in a track marks it.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { retryingFetch, why } from './lib/netFetch'
import { detectDay } from '../src/lib/tagging/detect'
import { gunsFromLog } from '../src/lib/tagging/gunFromLog'
import { detectFromLog } from '../src/lib/manoeuvres'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const BOAT = arg('boat')
const DATE = arg('date')
/** A log file on disk, read with the CURRENT parser and no database at all. */
const FILE = arg('file')
const fail: (m: string) => never = (m) => { console.error(`✕ ${m}`); process.exit(1) }

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
  global: { fetch: retryingFetch },
})

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—')

/**
 * The file itself, parsed here and now.
 *
 * `--date` reads the STORED rows, which were parsed by whatever version of the
 * app did the import — so "tmGun on 0 %" there is two different answers: the
 * column is not in the data, or it is and the import predates the parser
 * carrying it. A browser tab holds the bundle it loaded, so an import after a
 * `git pull` can easily have run the old one.
 *
 * This mode takes the database out of it. Same parser the app calls, run
 * against the file on disk.
 */
const fromFile = async (path: string): Promise<never> => {
  const { parseLog } = await import('../src/lib/logParse')
  const { getBoatLogProfile } = await import('../src/lib/logProfile')
  const { BOAT_LOG_PROFILES } = await import('../src/lib/boatLogProfiles')
  const { basename } = await import('path')

  const text = readFileSync(path, 'utf8')
  const head = text.replace(/\r/g, '').split('\n').slice(0, 2)
  const profile = BOAT && BOAT_LOG_PROFILES[BOAT] ? BOAT_LOG_PROFILES[BOAT] : getBoatLogProfile(null)
  const p = parseLog(text, { boatProfile: profile })

  // Minutes east of UTC, for printing. The file's own clock is UTC; this is
  // only so the window can be read against when somebody actually sailed.
  const tz = Number(arg('tz') ?? 60)
  const hhmm = (u: number) => new Date(u + tz * 60_000).toISOString().slice(11, 19)

  console.log(`\n${basename(path)}`)
  console.log(`  format: ${p.format}   rows: ${p.rows.length.toLocaleString()}`)
  if (p.rows.length) {
    const t0 = (p.rows[0] as { utc: number }).utc
    const t1 = (p.rows[p.rows.length - 1] as { utc: number }).utc
    console.log(`  the FILE runs ${hhmm(t0)}–${hhmm(t1)} at UTC+${tz / 60}`)
    console.log('  Compare that against the stored day: a shorter stored window means the')
    console.log('  import trimmed it, and anything tagged past its end cannot be drawn.')
  }
  if (BOAT) console.log(`  profile: "${BOAT}"${BOAT_LOG_PROFILES[BOAT] ? '' : ' (none transcribed — defaults only)'}`)
  if (!p.rows.length) {
    console.log('\n  ✕ ZERO ROWS. The parser did not recognise this file, so nothing downstream can.')
    console.log(`     first line: ${head[0]?.slice(0, 120) || '(empty)'}`)
    process.exit(1)
  }

  // Is the column in the HEADER at all, whatever the rows say? The two are
  // different failures: a header without it means the boat does not log it; a
  // header with it and no values means the timer was never running.
  const cols = head[0].replace(/^!/, '').split(',').map((c) => c.trim())
  const named = cols.filter((c) => /tm.*gun|time.*gun/i.test(c))
  console.log(`  header names: ${named.length ? named.join(', ') : 'nothing matching *gun*'}`)

  const rows = p.rows as Array<Record<string, unknown>>
  const have = (k: string) => rows.filter((r) => typeof r[k] === 'number' && Number.isFinite(r[k] as number)).length
  for (const k of ['tmGun', 'tmLine', 'twa', 'bsp']) {
    console.log(`  ${k.padEnd(7)} on ${pct(have(k), rows.length)} of rows`)
  }

  const vals = rows.map((r) => r.tmGun).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (vals.length) {
    console.log(`  tmGun range ${Math.min(...vals).toFixed(1)}…${Math.max(...vals).toFixed(1)} s`)
    const { gunsFromLog } = await import('../src/lib/tagging/gunFromLog')
    const guns = gunsFromLog(rows as never)
    console.log(`\n  guns read: ${guns.length || 'none — the rows do not agree on an instant'}`)
    for (const g of guns) {
      console.log(`    race ${g.raceNum}  ${hhmm(g.utc)} local   `
        + `${g.rows} rows over ${g.spanSec}s, spread ${(g.spreadMs / 1000).toFixed(1)}s, confidence ${g.confidence}`)
      // A sequence that was abandoned and re-armed is one start, not two races.
      for (const r of g.restarts || []) {
        console.log(`              ↳ a countdown to ${hhmm(r)} was abandoned and re-armed for this`)
      }
    }
    console.log('\n  So the FILE has it. If the stored day says 0 %, the import ran an older')
    console.log('  parser: restart the dev server, hard-reload the tab, and re-import.')
  } else {
    console.log('\n  ✕ The parser finds NO tmGun value on any row of this file.')
    console.log(named.length
      ? '    The column is in the header, so the cells are empty — Expedition writes the\n'
        + '    countdown only while a start timer is actually running. Nothing can read a\n'
        + '    gun that was never counted to.'
      : '    And nothing in the header looks like a countdown, so this boat does not log it.')
  }
  console.log('')
  process.exit(0)
}

const main = async () => {
  if (FILE) await fromFile(FILE)
  if (!DATE) fail('--date YYYY-MM-DD is required (and --boat "<name>" when two boats share the day), '
    + 'or --file <logfile> to parse a file on disk with no database at all')

  let q = sb.from('sessions')
    .select('id, date, boat_id, tz_offset_minutes, log_data, xml_data, boats(name)')
    .eq('date', DATE)
  const { data: sessions, error } = await q
  if (error) fail(`sessions: ${why(error)}`)
  let rowsFor = sessions || []
  if (BOAT) {
    rowsFor = rowsFor.filter((s: any) => String(s.boats?.name || '').toLowerCase() === BOAT.toLowerCase())
  }
  if (!rowsFor.length) {
    const had = (sessions || []).map((s: any) => s.boats?.name || s.boat_id).join(', ')
    fail(`no session for ${DATE}${BOAT ? ` and "${BOAT}"` : ''}${had ? ` — that day has: ${had}` : ''}.`
       + '\n    CAUSE 1: the day was never imported, or it is filed under a different boat.')
  }
  if (rowsFor.length > 1) {
    fail(`${rowsFor.length} sessions on ${DATE} — pass --boat: `
       + rowsFor.map((s: any) => `"${s.boats?.name}"`).join(', '))
  }
  const s = rowsFor[0] as any
  const rows = (s.log_data?.rows || []) as Array<Record<string, unknown>>
  const name = s.boats?.name || s.boat_id

  console.log(`\n${name} — ${DATE}`)
  console.log(`  session ${s.id}   tz ${s.tz_offset_minutes ?? '—'} min`)

  if (!rows.length) {
    console.log('\n  ✕ CAUSE 1 — the session has NO LOG ROWS.')
    console.log('    Nothing can be detected from a day with no log. Re-import the track in')
    console.log('    the Upload tab and watch the row count it reports; a format it does not')
    console.log('    recognise parses to zero rows.\n')
    process.exit(1)
  }

  const twa = rows.map((r) => num(r.twa)).filter((v): v is number => v != null)
  const bsp = rows.map((r) => num(r.bsp)).filter((v): v is number => v != null)
  const pos = rows.filter((r) => num(r.lat) != null && num(r.lon) != null).length
  const t0 = num(rows[0].utc), t1 = num(rows[rows.length - 1].utc)
  const hhmm = (u: number | null) => (u == null ? '—'
    : new Date(u + (s.tz_offset_minutes || 0) * 60000).toISOString().slice(11, 16))

  console.log(`  ${rows.length.toLocaleString()} rows, ${hhmm(t0)}–${hhmm(t1)} local   position on ${pct(pos, rows.length)}`)
  console.log(`  twa on ${pct(twa.length, rows.length)}   bsp on ${pct(bsp.length, rows.length)}`)

  const problems: string[] = []
  if (!twa.length) problems.push('CAUSE 2 — NO twa ON ANY ROW. detectFromLog needs it; check the boat\'s log profile '
    + '(npm run log:profile -- --boat "<name>" --against <logfile>).')
  if (!bsp.length) problems.push('CAUSE 2 — NO bsp ON ANY ROW, same fix as above.')

  if (twa.length) {
    const neg = twa.filter((v) => v < 0).length
    const lo = Math.min(...twa), hi = Math.max(...twa)
    console.log(`  twa range ${lo.toFixed(1)}…${hi.toFixed(1)}   negative on ${pct(neg, twa.length)}`)
    if (!neg) problems.push('CAUSE 3 — TWA NEVER GOES NEGATIVE, so it is logged 0-180 rather than ±180 and '
      + 'nothing ever changes sign. No tack or gybe can be found from this log, on any day.')
  }
  if (bsp.length) {
    const hi = Math.max(...bsp)
    const over6 = bsp.filter((v) => v >= 6).length
    console.log(`  bsp max ${hi.toFixed(1)}   at or above the 6 kn floor on ${pct(over6, bsp.length)}`)
    if (!over6) problems.push(`CAUSE 4 — NOTHING REACHED 6 kn (max ${hi.toFixed(1)}). Either it was very light, or `
      + 'bsp is not in knots. minBsp is 6 by default.')
  }

  const xml = s.xml_data || null
  console.log(`  event file: ${xml ? 'stored' : 'NONE'}`)

  // The gun, read off the log's own countdown. Reported before detectDay
  // because it decides the day's SHAPE as well as its starts: no guns means one
  // undivided "Session" and every tag in it filed under nothing.
  const tmGun = rows.map((r) => num(r.tmGun)).filter((v): v is number => v != null)
  console.log(`  tmGun (countdown to the gun) on ${pct(tmGun.length, rows.length)}`)
  if (!tmGun.length) {
    problems.push('NO tmGun ON ANY ROW — so no start can be read. Either this boat\'s Expedition '
      + 'does not log TmToGun, the log predates the parser carrying it (re-import to fix), or the '
      + 'column is named something the profile does not know.')
  } else {
    const guns = gunsFromLog(rows as never)
    if (!guns.length) {
      problems.push(`tmGun is present on ${tmGun.length} rows but NO GUN agrees. The rows have to name `
        + 'one instant between them: a frozen timer, or a countdown that runs the other way, names a '
        + 'different instant every row and is refused rather than guessed at.')
    } else {
      console.log(`\n  guns read from the countdown:`)
      for (const g of guns) {
        console.log(`    race ${g.raceNum}  ${hhmm(g.utc)} local   `
          + `${g.rows} rows agreeing over ${g.spanSec}s, spread ${(g.spreadMs / 1000).toFixed(1)}s, `
          + `confidence ${g.confidence}`)
      }
    }
  }

  // What the app itself would produce, with and without the event file.
  const got = detectDay({ boatId: s.boat_id, date: DATE, rows: rows as never, xml })
  const bySlug = new Map<string, number>()
  for (const d of got) bySlug.set(d.slug, (bySlug.get(d.slug) || 0) + 1)

  console.log('\n  detectDay() finds:')
  if (!got.length) console.log('    — nothing —')
  for (const [slug, n] of Array.from(bySlug.entries()).sort()) {
    console.log(`    ${String(n).padStart(4)}  ${slug}`)
  }

  // The manoeuvre floor, swept — this is what says "it was light" rather than
  // "it is broken".
  if (twa.length && bsp.length) {
    const sweep = [6, 4, 2, 0.5].map((m) => `${m} kn → ${detectFromLog(rows as never, m).length}`)
    console.log(`\n  tacks+gybes by minBsp:  ${sweep.join('   ')}`)
  }

  if (!xml) {
    console.log('\n  WITHOUT AN EVENT FILE, these are not a fault — nothing can detect them:')
    console.log('    day-start / day-end   recorded facts in the file')
    console.log('    sail-change  the file names the sails that went up')
    console.log('  Press them in the tagger: the Racing group button holds the day\'s fixed points.')
    console.log('  A race START is the exception: it is read off the log\'s own countdown, above.')
  }

  if (problems.length) {
    console.log('')
    for (const p of problems) console.log(`  ✕ ${p}`)
  } else if (got.length) {
    console.log('\n  ✓ The detections exist. If the tagger shows none, they are UNSYNCED:')
    console.log('    the track and the list draw stored tags only, and the "Sync" bar is what')
    console.log('    turns a detection into one. Open the Tags tab and press it.')
  }
  console.log('')
}

main().catch((e) => fail(why(e)))
