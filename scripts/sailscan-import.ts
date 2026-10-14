// scripts/sailscan-import.ts
// ─────────────────────────────────────────────────────────────────────────────
// Import a SailScan / Sail Vision PDF report into `sail_scans`.
//
//   npx vite-node scripts/sailscan-import.ts -- \
//     ~/Downloads/sail_report_20261012_105938_v3.pdf \
//     --boat "Baraka GP" --tz Europe/London
//   …then the same line with --write
//
// DRY RUN by default. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// WHY A SCRIPT. The app route (/api/teams/[teamId]/sail-scans) does this from
// the browser, one report at a time, and it is the right path for a single scan
// taken on the boat. A twenty-page back-catalogue is a different job: it wants
// the sail mapping shown before anything is written, the parse arithmetic
// checked, and re-runs to be safe. None of which belongs in a file dialog.
//
// WHAT IT DOES NOT IMPORT. Every instrument on the page — boat speed, wind,
// upwind angle, runner load, tack load. They are all better in the Expedition
// log, and the report's wind is actively wrong on at least one page ("Boat speed
// 8.6 kn Wind strength 0.0 kn"). `tws_kn` and `twa_deg` are left NULL so the
// log fills them; see the note in sailScanParse.ts. What comes in is the SHAPE:
// draft, camber, entry, exit and twist per stripe, plus the trimmer's notes.
//
// THE CLOCK. "Captured 2026-10-11 09:51" is VENUE-LOCAL wall time with no zone,
// like every other stamp in this project. --tz says which zone that is and the
// script prints the offset it used. Baraka's October days are UK, so
// Europe/London (BST, +1) — NOT the Med default. Get it wrong and every scan
// lands an hour from the log rows it should sit beside.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { extractPdfText } from '../src/lib/pdfText'
import { parseSailScanReport, sailVisionTwistCheck, type ParsedScan } from '../src/lib/sailScanParse'
import { matchSailToInventory } from '../src/lib/sailCodeMatch'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const WRITE = args.includes('--write')
const PDF = args.find((a) => /\.pdf$/i.test(a))
const BOAT = flag('--boat')
const TZ = flag('--tz') || 'Europe/London'
// Repeatable: --map "Main 2=MN 4". Applied to the report's sail NAME before the
// inventory match, because an analyst's label and a sail's name need not agree.
const MAPS = args.reduce<Record<string, string>>((acc, a, i) => {
  if (a !== '--map') return acc
  const [from, to] = String(args[i + 1] || '').split('=')
  if (from && to) acc[from.trim().toLowerCase()] = to.trim()
  return acc
}, {})

if (!PDF || !BOAT) {
  console.error('usage: <report.pdf> --boat "Baraka GP" [--tz Europe/London] [--map "Main 2=MN 4"] [--write]')
  process.exit(1)
}

// Per-boat label → inventory name. Baraka's analyst writes the mainsail as
// "Main 2" (and once as bare "Main"); the inventory calls it MN 4. Without this
// the main would fall through to matchSailToInventory's "only one mainsail on
// the boat" rule, which is right by accident today and wrong the moment a
// second main is added.
const DEFAULT_MAPS: Record<string, Record<string, string>> = {
  'baraka gp': { 'main 2': 'MN 4', main: 'MN 4' },
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  const text = await extractPdfText(readFileSync(PDF!))
  const report = parseSailScanReport(text, { tz: TZ })
  if (report.format === 'unknown' || !report.scans.length) {
    console.error(`could not read ${PDF} — format ${report.format}, ${report.scans.length} scan(s)`)
    process.exit(1)
  }
  const offsetNote = (() => {
    const s = report.scans.find((x) => x.capturedLocal && x.capturedAt)
    if (!s) return ''
    const mins = (Date.parse(s.capturedLocal + 'Z') - Date.parse(s.capturedAt!)) / 60_000
    return `  (${TZ} = UTC${mins >= 0 ? '+' : ''}${mins / 60})`
  })()
  console.log(`${PDF}\n  format ${report.format} · ${report.scans.length} scan(s) · times read as ${TZ}${offsetNote}\n`)

  // The parse's own check before anything is resolved or written.
  const bad = report.scans.filter((s) => !sailVisionTwistCheck(s).ok)
  for (const s of bad) {
    const c = sailVisionTwistCheck(s)
    console.log(`  ⚠ ${s.imageName}: twist total ${c.reportedDeg}° but the stripes accumulate to ${c.accumulatedDeg}°`)
  }
  console.log(bad.length
    ? `  ${report.scans.length - bad.length}/${report.scans.length} pages pass the twist check — a mismatch means a stripe row was dropped\n`
    : `  twist check: all ${report.scans.length} pages agree with their own total\n`)

  const { data: boats, error: bErr } = await sb.from('boats').select('id, name, team_id')
  if (bErr) { console.error(`boats: ${bErr.message}`); process.exit(1) }
  const boat = (boats ?? []).find((b) => String(b.name).toLowerCase() === BOAT!.toLowerCase())
    ?? (boats ?? []).find((b) => String(b.name).toLowerCase().includes(BOAT!.toLowerCase()))
  if (!boat) {
    console.error(`no boat matching "${BOAT}". Have: ${(boats ?? []).map((b) => b.name).join(', ')}`)
    process.exit(1)
  }

  const [{ data: sails }, { data: existing }] = await Promise.all([
    sb.from('sails').select('id, name, category, kind, retired').eq('boat_id', boat.id),
    sb.from('sail_scans').select('id, report_ref, captured_at').eq('boat_id', boat.id),
  ])
  const byRef = new Set((existing ?? []).map((r) => `${r.report_ref}|${r.captured_at}`))
  const sailName = new Map((sails ?? []).map((s) => [s.id as string, s.name as string]))
  const maps = { ...(DEFAULT_MAPS[String(boat.name).toLowerCase()] || {}), ...MAPS }

  console.log(`boat "${boat.name}" · ${(sails ?? []).length} sail(s) in inventory`)
  if (Object.keys(maps).length) {
    console.log(`sail aliases: ${Object.entries(maps).map(([f, t]) => `"${f}" → "${t}"`).join(', ')}`)
  }
  console.log()
  console.log('captured (local)     sail in report   → inventory sail        stripes  twist°   notes  status')

  const rows: Record<string, unknown>[] = []
  let skipped = 0
  for (const s of report.scans) {
    const alias = maps[String(s.sailName || '').toLowerCase()] || null
    const sailId = matchSailToInventory(sails ?? [], alias, alias || s.sailName, s.sailType)
    const dup = byRef.has(`${s.imageName}|${s.capturedAt}`)
    const status = dup ? 'already in' : !sailId ? 'NO SAIL MATCH' : WRITE ? 'insert' : 'would insert'
    console.log(
      `${(s.capturedLocal || '—').replace('T', ' ').padEnd(20)} `
      + `${String(s.sailName || '—').padEnd(16)} → ${String(sailId ? sailName.get(sailId) : '—').padEnd(22)} `
      + `${String(s.stripes.length).padStart(7)}  ${String(s.twistTotalDeg ?? '—').padStart(6)}  `
      + `${(s.notes ? 'yes' : '—').padEnd(5)}  ${status}`,
    )
    if (dup) { skipped++; continue }
    rows.push(rowFor(s, boat, sailId))
  }

  const unmatched = rows.filter((r) => !r.sail_id).length
  console.log(`\n${rows.length} to insert · ${skipped} already present`
    + (unmatched ? ` · ${unmatched} with NO sail matched (they still import; sail_id stays null)` : ''))

  if (!WRITE) { console.log('\nDry run. Add --write to insert.'); return }
  if (!rows.length) { console.log('\nNothing to do.'); return }

  const { data, error } = await sb.from('sail_scans').insert(rows).select('id')
  if (error) {
    if (/sail_scans_source_check|violates check constraint/i.test(error.message)) {
      console.error(`\n${error.message}\n`)
      console.error("The 'sailvision' source is not accepted yet. Paste")
      console.error('supabase/migrations/0100_sail_scans_sailvision.sql into the Supabase SQL editor, then re-run.')
      process.exit(1)
    }
    console.error(`insert: ${error.message}`); process.exit(1)
  }
  console.log(`\ninserted ${data?.length ?? 0} scan(s).`)
}

function rowFor(s: ParsedScan, boat: { id: string; team_id: string }, sailId: string | null) {
  return {
    team_id: boat.team_id,
    boat_id: boat.id,
    sail_id: sailId,
    captured_at: s.capturedAt,
    source: s.source,
    // Deliberately null: the log is the instrument record. See the header.
    tws_kn: null,
    twa_deg: null,
    conditions: {
      sail_name_in_report: s.sailName,
      sail_type: s.sailType,
      image_name: s.imageName,
      captured_local: s.capturedLocal,
      report_format: s.format,
      twist_total_deg: s.twistTotalDeg,
      // So a reader knows the stripe heights are the BOAT'S convention
      // (25/50/75/87 from the foot) and not printed in the report.
      stripe_pos_from_convention: !!s.posFromConvention,
      instruments_from_log: true,
    },
    stripes: s.stripes,
    summary: s.summary,
    report_ref: s.imageName,
    notes: s.notes,
  }
}

main()
