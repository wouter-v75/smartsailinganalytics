// scripts/phase-stats-day-audit.ts
// ─────────────────────────────────────────────────────────────────────────────
// Does every session_phase_stats row hold ITS OWN day's phases?
//
//   npx vite-node scripts/phase-stats-day-audit.ts                     audit, change nothing
//   npx vite-node scripts/phase-stats-day-audit.ts --boat "Baraka GP"  one boat
//   npx vite-node scripts/phase-stats-day-audit.ts --repair delete --write
//   npx vite-node scripts/phase-stats-day-audit.ts --repair rebuild --write
//
// READ-ONLY without --write. Reads .env.local; run OUTSIDE Claude Code's sandbox.
//
// WHAT IT CHECKS. A row is keyed by `date`, but the phases inside it carry their own
// epochs (`u` = start, `e` = end, venue-LOCAL wall time in epoch clothing — see the
// clock trap in CLAUDE.md). Nothing in the schema makes the two agree, and on
// 2026-09-27 and 2026-10-03 they did not: those rows held the phases of 29 Sept and
// 2 Oct, identical in count and span to those days' own rows. So this walks every
// row and compares the calendar day of its phase epochs against its `date`.
//
// WHY IT MATTERS. A day-mismatch is silent in BOTH directions. Anything that matches
// on time finds nothing and reads as "the camera was out at the wrong time"; anything
// that takes the day's phases WITHOUT matching on time gets another day's conditions
// and reports them as this day's. Neither says a word.
//
// DUPLICATE vs MIS-STAMPED, and why the distinction is the whole point:
//
//   DUPLICATE    the day the epochs land on has its OWN row, with the same phase
//                count and the same span. The second copy is redundant: the real
//                day is safe, and this row is simply wrong about which day it is.
//   MIS-STAMPED  no such row exists. Then THIS ROW IS THE ONLY COPY of that day's
//                phases, and deleting it loses them. It is reported and never
//                touched, whatever --repair says.
//
// REPAIR. Deleting a bogus row is the right repair. SHIFTING ITS EPOCHS TO LINE UP
// IS NOT, and this script will never do it: the epochs are not wrong, the filing is.
// Moving 29 September's sailing onto 27 September's date would make every later
// comparison — a photograph against the lidar, a day against the season curves —
// quietly compare one day's measurements against another day's sailing, and nothing
// downstream could ever tell.
//
//   --repair delete    remove the bogus row. The day is then left with no phase
//                      stats, which is what it genuinely has.
//   --repair rebuild   recompute the row's own day from the CLOUD log + event file
//                      in `sessions` (what the API route does server-side), and only
//                      delete when there is no cloud log to rebuild from. Better
//                      where it works: the day ends up with the stats it should
//                      always have had.
//
// Either way a day whose full-resolution log lives on somebody's laptop is best
// restored by opening it in Analytics on that machine — the cloud copy keeps a row
// every ~6 s, and the rebuild here can only be as good as that.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { computePhaseStats } from '../src/lib/phaseStats'
import { analyseManoeuvres } from '../src/lib/manoeuvres'
import { polarFromData } from '../src/lib/polarFile'
import {
  STATS_VERSION, compactPhases, compactManoeuvres, medianInterval, type StoredPhase,
} from '../src/lib/seasonCurves'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const flag = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : null)

const WRITE = has('--write')
const REPAIR = flag('--repair')               // null | 'delete' | 'rebuild'
const BOAT = flag('--boat')                   // boat name (substring, case-insensitive) or id
const FROM = flag('--from')
const TO = flag('--to')

if (has('--help') || has('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n')
    .filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(0)
}
if (REPAIR && !['delete', 'rebuild'].includes(REPAIR)) {
  console.error(`--repair takes "delete" or "rebuild", not "${REPAIR}"`)
  process.exit(1)
}
if (WRITE && !REPAIR) {
  console.error('--write needs --repair delete or --repair rebuild — say which repair you mean')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !SERVICE) { console.error('Supabase URL / service key missing in .env.local'); process.exit(1) }
const sb = createClient(URL_, SERVICE, { auth: { persistSession: false } })

/** The calendar day a stored phase's epoch lands on. The epochs are venue-local wall
 *  time in epoch clothing, so reading them back as UTC gives the venue's own day —
 *  which is what `date` holds. */
export const dayOfEpoch = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 19)
const dayGap = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000)

interface Row {
  id: string; team_id: string; boat_id: string; session_id: string | null; date: string
  stats_version: number; polar_id: string | null; phase_count: number; log_rows: number | null
  resolution_s: number | null; computed_at: string; computed_by_user_id: string | null
  phases: StoredPhase[] | null
}

/** What a row's phases say about themselves: the days they fall on, and their span. */
function shapeOf(r: Row) {
  const ph = (r.phases || []).filter((p) => Number.isFinite(p?.u))
  if (!ph.length) return null
  const first = Math.min(...ph.map((p) => p.u))
  const last = Math.max(...ph.map((p) => (Number.isFinite(p.e) ? p.e : p.u)))
  const days = Array.from(new Set(ph.map((p) => dayOfEpoch(p.u)))).sort()
  return { n: ph.length, first, last, days }
}

async function main() {
  const { data: boats, error: bErr } = await sb.from('boats').select('id, name, team_id')
  if (bErr) { console.error(`boats: ${bErr.message}`); process.exit(1) }
  const boatName = new Map((boats || []).map((b) => [b.id, b.name as string]))

  let boatIds: string[] | null = null
  if (BOAT) {
    const m = (boats || []).filter((b) => b.id === BOAT || (b.name || '').toLowerCase().includes(BOAT.toLowerCase()))
    if (!m.length) { console.error(`no boat matches "${BOAT}"`); process.exit(1) }
    boatIds = m.map((b) => b.id)
  }

  let q = sb.from('session_phase_stats')
    .select('id, team_id, boat_id, session_id, date, stats_version, polar_id, phase_count, log_rows, resolution_s, computed_at, computed_by_user_id, phases')
    .order('boat_id').order('date')
  if (boatIds) q = q.in('boat_id', boatIds)
  if (FROM) q = q.gte('date', FROM)
  if (TO) q = q.lte('date', TO)
  const { data, error } = await q
  if (error) { console.error(`session_phase_stats: ${error.message}`); process.exit(1) }
  const rows = (data || []) as Row[]
  if (!rows.length) { console.log('no stored phase stats match that filter'); return }

  // The row for any given boat+day, so a mismatch can be told from a duplicate.
  const byBoatDay = new Map(rows.map((r) => [`${r.boat_id}|${r.date}`, r]))
  // Which day each session_id belongs to: an independent witness to the filing.
  const sessionIds = rows.map((r) => r.session_id).filter((x): x is string => !!x)
  const sessionDay = new Map<string, string>()
  for (let i = 0; i < sessionIds.length; i += 200) {
    const { data: ss } = await sb.from('sessions').select('id, date').in('id', sessionIds.slice(i, i + 200))
    for (const s of ss || []) sessionDay.set(s.id as string, s.date as string)
  }

  console.log(`${rows.length} stored day(s)${BOAT ? ` · boat "${BOAT}"` : ''}`
    + `${WRITE ? ` · REPAIR ${REPAIR} — WRITING` : REPAIR ? ` · repair ${REPAIR} (dry run)` : ' · audit only'}\n`)

  const empty: Row[] = []
  const duplicates: { r: Row; day: string; twin: Row }[] = []
  const misStamped: { r: Row; day: string }[] = []
  const split: { r: Row; days: string[] }[] = []

  for (const r of rows) {
    const shape = shapeOf(r)
    if (!shape) { empty.push(r); continue }
    const day = dayOfEpoch(shape.first)
    if (shape.days.length > 1) split.push({ r, days: shape.days })
    if (day === r.date) continue
    const twin = byBoatDay.get(`${r.boat_id}|${day}`)
    const twinShape = twin ? shapeOf(twin) : null
    // A duplicate, not merely a neighbour: same count, same span to the second.
    const isDup = !!twinShape && twinShape.n === shape.n
      && twinShape.first === shape.first && twinShape.last === shape.last
    if (isDup) duplicates.push({ r, day, twin: twin! })
    else misStamped.push({ r, day })
  }

  // ── the report ────────────────────────────────────────────────────────────
  const line = (r: Row, extra: string) =>
    `  ${r.date}  ${(boatName.get(r.boat_id) || r.boat_id).padEnd(14)} ${String(r.phase_count).padStart(4)} phases  `
    + `${r.resolution_s == null ? '  no' : r.resolution_s.toFixed(1).padStart(4)} s log  computed ${r.computed_at.slice(0, 16).replace('T', ' ')}\n`
    + `      ${extra}`

  // What a rebuild would have to work with, so the choice between the two repairs
  // can be made before either is run rather than discovered halfway through one.
  const rebuildable = new Map<string, string>()
  for (const { r } of duplicates) {
    const { data: session } = await sb.from('sessions')
      .select('log_data, xml_data').eq('team_id', r.team_id).eq('boat_id', r.boat_id).eq('date', r.date).maybeSingle()
    const n = ((session?.log_data as { rows?: unknown[] } | null)?.rows || []).length
    const ph = ((session?.xml_data as { phases?: unknown[] } | null)?.phases || []).length
    rebuildable.set(r.id, !session ? 'no session at all — rebuild would delete'
      : !n ? 'no cloud log on the session — rebuild would delete'
      : !ph ? `cloud log of ${n.toLocaleString()} rows but no event-file phases — rebuild would delete`
      : `cloud log of ${n.toLocaleString()} rows + ${ph} event-file phases — rebuild can recompute the day`)
  }

  if (duplicates.length) {
    console.log(`*** ${duplicates.length} DUPLICATE row(s): the phases belong to another day that already has its own row ***\n`)
    for (const { r, day, twin } of duplicates) {
      const s = shapeOf(r)!
      const g = dayGap(day, r.date)
      console.log(line(r, `epochs land on ${day} (${g > 0 ? '+' : ''}${g} day) · ${hhmm(s.first)}–${hhmm(s.last)}`
        + ` · identical to the row for ${twin.date} (${twin.phase_count} phases, same span)`
        + `\n      session_id → ${r.session_id ? (sessionDay.get(r.session_id) || 'unknown day') : 'none'}`
        + `\n      → ${r.date} has NO phase stats of its own. ${rebuildable.get(r.id)}`))
      console.log('')
    }
  }

  if (misStamped.length) {
    console.log(`*** ${misStamped.length} MIS-STAMPED row(s): the phases belong to a day with NO row of its own ***\n`)
    for (const { r, day } of misStamped) {
      const s = shapeOf(r)!
      const g = dayGap(day, r.date)
      console.log(line(r, `epochs land on ${day} (${g > 0 ? '+' : ''}${g} day) · ${hhmm(s.first)}–${hhmm(s.last)} · no row exists for ${day}`
        + `\n      session_id → ${r.session_id ? (sessionDay.get(r.session_id) || 'unknown day') : 'none'}`
        + `\n      → THIS MAY BE THE ONLY COPY of ${day}'s phases. Left alone: deleting it loses them,`
        + `\n        and re-dating it is a guess about which of the two dates is the wrong one.`))
      console.log('')
    }
  }

  if (split.length) {
    console.log(`${split.length} row(s) whose phases span more than one calendar day (normal for a session through local midnight):`)
    for (const { r, days } of split) console.log(`  ${r.date}  ${days.join(', ')}`)
    console.log('')
  }

  if (empty.length) {
    console.log(`${empty.length} EMPTY row(s) — a row exists but holds no phases:`)
    for (const r of empty) {
      console.log(`  ${r.date}  ${(boatName.get(r.boat_id) || r.boat_id).padEnd(14)} phase_count ${r.phase_count}`
        + ` · log_rows ${r.log_rows ?? '—'} · ${r.resolution_s == null ? 'no' : `${r.resolution_s} s`} log`
        + ` · computed ${r.computed_at.slice(0, 16).replace('T', ' ')}`)
    }
    console.log('  An empty row is not a mis-filing: it is a day whose log produced no event-file')
    console.log('  phases. It blocks nothing — the API route and stats:backfill both replace it.\n')
  }

  const clean = rows.length - duplicates.length - misStamped.length - empty.length
  console.log(`${clean} row(s) hold their own day's phases · ${duplicates.length} duplicate · ${misStamped.length} mis-stamped · ${empty.length} empty`)

  if (!duplicates.length) return
  if (!WRITE) {
    console.log(`\nNothing was changed. To repair the ${duplicates.length} duplicate row(s):`)
    console.log(`  npx vite-node scripts/phase-stats-day-audit.ts --repair rebuild --write`)
    console.log(`  npx vite-node scripts/phase-stats-day-audit.ts --repair delete --write`)
    console.log('Mis-stamped rows are never touched by either.')
    return
  }

  // ── repair ────────────────────────────────────────────────────────────────
  // Only duplicates. The bogus array goes; the epochs are never moved.
  console.log(`\nrepairing ${duplicates.length} duplicate row(s) — ${REPAIR}\n`)
  let rebuilt = 0, deleted = 0, failed = 0
  for (const { r, day } of duplicates) {
    const tag = `${r.date} (${boatName.get(r.boat_id) || r.boat_id})`

    if (REPAIR === 'rebuild') {
      const { data: session } = await sb.from('sessions')
        .select('id, log_data, xml_data').eq('team_id', r.team_id).eq('boat_id', r.boat_id).eq('date', r.date).maybeSingle()
      const logRows = ((session?.log_data as { rows?: unknown[] } | null)?.rows || []) as { utc: number }[]
      const xml = session?.xml_data as { phases?: unknown[] } | null
      if (logRows.length && xml?.phases?.length) {
        const { data: polarRow } = await sb.from('polars').select('id, name, data')
          .eq('team_id', r.team_id).eq('boat_id', r.boat_id).eq('is_active', true).maybeSingle()
        const stats = computePhaseStats(logRows as never, xml, { polar: polarFromData(polarRow?.data) })
        if (!stats.length) {
          console.log(`  ✗ ${tag}  the cloud log rebuilds to zero phases — not overwriting; delete it instead`)
          failed++; continue
        }
        // The rebuilt day must BE this day, or we are about to repeat the bug.
        const built = compactPhases(stats)
        const builtDay = dayOfEpoch(Math.min(...built.map((p) => p.u)))
        if (builtDay !== r.date) {
          console.log(`  ✗ ${tag}  the cloud log for this date itself holds ${builtDay}'s rows — the session is wrong too; left alone`)
          failed++; continue
        }
        // No carryLidar here, deliberately: the lidar means on the old array were
        // merged onto ANOTHER day's phases and belong to that day's row, not this one.
        const patch = {
          phases: built,
          manoeuvres: compactManoeuvres(analyseManoeuvres(logRows as never, xml)),
          phase_count: built.length,
          log_rows: logRows.length,
          resolution_s: medianInterval(logRows),
          stats_version: STATS_VERSION,
          polar_id: polarRow?.id ?? null,
          polar_name: polarRow?.name ?? null,
          session_id: session!.id,
          headlines: null, headlines_model: null, headlines_at: null,
          computed_at: new Date().toISOString(),
        }
        const { error: upErr } = await sb.from('session_phase_stats').update(patch).eq('id', r.id)
        if (upErr) { console.log(`  ✗ ${tag}  ${upErr.message}`); failed++; continue }
        console.log(`  ✓ ${tag}  rebuilt from the cloud log · ${built.length} phases (was ${r.phase_count} of ${day}'s)`)
        rebuilt++; continue
      }
      console.log(`  · ${tag}  no cloud log + event file to rebuild from — deleting the duplicate instead`)
    }

    const { error: delErr } = await sb.from('session_phase_stats').delete().eq('id', r.id)
    if (delErr) { console.log(`  ✗ ${tag}  ${delErr.message}`); failed++; continue }
    console.log(`  ✓ ${tag}  deleted — it held ${r.phase_count} of ${day}'s phases, which ${day} still has`)
    deleted++
  }
  console.log(`\nrebuilt ${rebuilt} · deleted ${deleted} · failed ${failed}`)
  if (deleted) {
    console.log('A deleted day now has no phase stats, which is the truth about it. To give it real ones,')
    console.log('open it in Analytics on the machine holding its full-resolution log.')
  }
}

main().catch((e) => { console.error(String(e?.stack || e)); process.exit(1) })
