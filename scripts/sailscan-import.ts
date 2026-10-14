// scripts/sailscan-import.ts
// ─────────────────────────────────────────────────────────────────────────────
// Import a SailScan / Sail Vision PDF report into `sail_scans`.
//
//   npx vite-node scripts/sailscan-import.ts -- \
//     ~/Downloads/sail_report_20261012_105938_v3.pdf \
//     --boat "Baraka GP" --tz Europe/London
//   …then the same line with --write
//
//   …and to put photos on scans that are already in the table, add
//   --backfill-photos (dry run first, as ever).
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
// THE PHOTOS. The report embeds one picture per page, and they come in with the
// scans — image i onto scan i, which holds because a Sail Vision report is one
// scan per page and the images decode in document order. If the counts do not
// match, photos are skipped rather than guessed at. Uploading needs
// BUNNY_STORAGE_WRITE_KEY in .env.local (the read/write zone password;
// BUNNY_STORAGE_API_KEY is read-only and will 401); without it the script SAYS
// SO and imports the shapes anyway, rather than leaving somebody to wonder why
// there are no pictures — which is what happened the first time round.
//
// --backfill-photos attaches them to scans that are ALREADY in the table,
// matched on the image name and capture time, so a set that went in before the
// photos could be read does not have to be deleted and imported again.
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
import { parseSailScanReport, sailVisionTwistCheck, scanIdentityKey, type ParsedScan } from '../src/lib/sailScanParse'
import { matchSailToInventory } from '../src/lib/sailCodeMatch'
import { extractJpegBytesList } from '../src/lib/pdfImageExtract'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const WRITE = args.includes('--write')
// Attach the report's photos to scans that are ALREADY in the table, instead of
// importing. For when the scans went in before the photos could be read — which
// is exactly what happened to the first Baraka import.
const BACKFILL = args.includes('--backfill-photos')
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
  console.error('usage: <report.pdf> --boat "Baraka GP" [--tz Europe/London] [--map "Main 2=MN 4"]'
    + ' [--backfill-photos] [--write]')
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

/**
 * PUT one object into Bunny Storage.
 *
 * The browser helper (bunny-storage-upload.ts) is XHR + /api/storage/credentials
 * and cannot run here, so this is the same PUT with the key read from
 * .env.local. BUNNY_STORAGE_WRITE_KEY is the read/write zone password;
 * BUNNY_STORAGE_API_KEY is READ-ONLY and will 401 — a laptop that is not meant
 * to upload simply does not have the write key, which is the intended default.
 */
async function putToStorage(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const zone = env.BUNNY_STORAGE_ZONE
  const accessKey = env.BUNNY_STORAGE_WRITE_KEY
  const region = env.BUNNY_STORAGE_REGION || 'de'
  const host = region === 'de' ? 'https://storage.bunnycdn.com' : `https://${region}.storage.bunnycdn.com`
  const res = await fetch(`${host}/${zone}/${key}`, {
    method: 'PUT',
    headers: { AccessKey: accessKey, 'Content-Type': contentType },
    body: Buffer.from(body),
  })
  if (!res.ok) throw new Error(`storage PUT ${key}: HTTP ${res.status} ${await res.text().catch(() => '')}`)
}

const canUpload = () => !!(env.BUNNY_STORAGE_ZONE && env.BUNNY_STORAGE_WRITE_KEY)

/**
 * The report's photos, one per scan, in page order — or null when that cannot
 * be said safely.
 *
 * The mapping is positional: image i belongs to scan i, because a Sail Vision
 * report is one scan per page and the images come out in document order. That
 * holds ONLY while the counts match. If they do not, something is embedded that
 * is not a scan photo (or a page has none), and a positional mapping would hang
 * the wrong picture on every scan after it — so it refuses rather than guesses.
 */
function photosFor(pdf: Uint8Array, scanCount: number): Uint8Array[] | null {
  const imgs = extractJpegBytesList(pdf)
  if (!imgs.length) {
    console.log('  no photos found in the PDF')
    return null
  }
  if (imgs.length !== scanCount) {
    console.log(`  ⚠ ${imgs.length} photo(s) for ${scanCount} scan(s) — not a 1:1 mapping, so photos are SKIPPED.`)
    console.log('    Positional matching only holds when every page carries exactly one picture.')
    return null
  }
  console.log(`  ${imgs.length} photo(s), one per page `
    + `(${Math.round(Math.min(...imgs.map((i) => i.length)) / 1024)}-${Math.round(Math.max(...imgs.map((i) => i.length)) / 1024)} kB)`)
  return imgs
}

async function main() {
  const pdfBytes = new Uint8Array(readFileSync(PDF!))
  const text = await extractPdfText(Buffer.from(pdfBytes))
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

  const photos = photosFor(pdfBytes, report.scans.length)
  if (photos && !canUpload()) {
    // Say it, loudly, rather than importing without pictures and leaving
    // somebody to wonder. BUNNY_STORAGE_API_KEY is read-only and is NOT this.
    console.log('  ⚠ BUNNY_STORAGE_WRITE_KEY (or _ZONE) is not in .env.local, so the photos')
    console.log('    CANNOT be uploaded. The scans will import without pictures.')
  }
  console.log()

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
    sb.from('sail_scans').select('id, report_ref, captured_at, conditions').eq('boat_id', boat.id),
  ])
  // scanIdentityKey, NOT string concatenation: the stored captured_at comes back
  // from PostgREST as "…+00:00" and the parser makes "….000Z" — the same instant,
  // never equal as text. That is what made a backfill report twenty scans "not
  // found" while they sat in the table.
  const byRef = new Map((existing ?? []).map((r) => [scanIdentityKey(r.report_ref, r.captured_at), r]))
  const sailName = new Map((sails ?? []).map((s) => [s.id as string, s.name as string]))
  const maps = { ...(DEFAULT_MAPS[String(boat.name).toLowerCase()] || {}), ...MAPS }

  console.log(`boat "${boat.name}" · ${(sails ?? []).length} sail(s) in inventory`)
  if (Object.keys(maps).length) {
    console.log(`sail aliases: ${Object.entries(maps).map(([f, t]) => `"${f}" → "${t}"`).join(', ')}`)
  }
  console.log()
  console.log('captured (local)     sail in report   → inventory sail        stripes  twist°   notes  status')

  // ── backfill: attach photos to scans that are already in the table ────────
  if (BACKFILL) {
    if (!photos) { console.error('\nNothing to attach — see above.'); process.exit(1) }
    if (!canUpload()) { console.error('\nCannot upload without the storage write key.'); process.exit(1) }
    let done = 0, missing = 0, already = 0
    for (let i = 0; i < report.scans.length; i++) {
      const sc = report.scans[i]
      const row = byRef.get(scanIdentityKey(sc.imageName, sc.capturedAt))
      if (!row) {
        missing++
        console.log(`${String(sc.imageName).padEnd(52)} no matching scan in the table`)
        continue
      }
      const cond = (row.conditions || {}) as Record<string, unknown>
      if (cond.photo_key) { already++; console.log(`${String(sc.imageName).padEnd(52)} already has a photo`); continue }
      const key = `teams/${boat.team_id}/boats/${boat.id}/sail-scans/${Date.now()}-${i}-photo.jpg`
      if (WRITE) {
        await putToStorage(key, photos[i], 'image/jpeg')
        const { error } = await sb.from('sail_scans')
          .update({ conditions: { ...cond, photo_key: key } }).eq('id', row.id)
        if (error) { console.error(`  update ${row.id}: ${error.message}`); process.exit(1) }
      }
      done++
      console.log(`${String(sc.imageName).padEnd(52)} ${WRITE ? 'attached' : 'would attach'} `
        + `${Math.round(photos[i].length / 1024)} kB`)
    }
    console.log(`\n${done} ${WRITE ? 'attached' : 'to attach'}`
      + (already ? ` · ${already} already had one` : '') + (missing ? ` · ${missing} not found` : ''))
    // Nothing matched at all → show what IS stored, side by side with what we
    // looked for. "Not found" twenty times out of twenty is never twenty
    // missing scans; it is one key that does not line up, and the two columns
    // say which part of it.
    if (!done && missing) {
      console.log(`\nNothing matched. ${(existing ?? []).length} scan(s) on this boat; the first few:`)
      for (const r of (existing ?? []).slice(0, 4)) {
        console.log(`  stored  ${String(r.report_ref ?? '(no report_ref)').padEnd(52)} ${r.captured_at}`)
      }
      for (const sc of report.scans.slice(0, 2)) {
        console.log(`  wanted  ${String(sc.imageName).padEnd(52)} ${sc.capturedAt}`)
      }
      console.log('  A different --tz moves captured_at, and a scan imported through the')
      console.log('  SailScan tab carries the PDF file name as report_ref, not the page image name.')
    }
    if (!WRITE) console.log('\nDry run. Add --write to upload and attach.')
    return
  }

  const rows: Record<string, unknown>[] = []
  const rowPhoto: number[] = [] // row index → photo index, kept in step
  let skipped = 0
  for (let i = 0; i < report.scans.length; i++) {
    const s = report.scans[i]
    const alias = maps[String(s.sailName || '').toLowerCase()] || null
    const sailId = matchSailToInventory(sails ?? [], alias, alias || s.sailName, s.sailType)
    const dup = byRef.has(scanIdentityKey(s.imageName, s.capturedAt))
    const status = dup ? 'already in' : !sailId ? 'NO SAIL MATCH' : WRITE ? 'insert' : 'would insert'
    console.log(
      `${(s.capturedLocal || '—').replace('T', ' ').padEnd(20)} `
      + `${String(s.sailName || '—').padEnd(16)} → ${String(sailId ? sailName.get(sailId) : '—').padEnd(22)} `
      + `${String(s.stripes.length).padStart(7)}  ${String(s.twistTotalDeg ?? '—').padStart(6)}  `
      + `${(s.notes ? 'yes' : '—').padEnd(5)}  ${status}`,
    )
    if (dup) { skipped++; continue }
    rows.push(rowFor(s, boat, sailId))
    rowPhoto.push(i)
  }

  const unmatched = rows.filter((r) => !r.sail_id).length
  console.log(`\n${rows.length} to insert · ${skipped} already present`
    + (unmatched ? ` · ${unmatched} with NO sail matched (they still import; sail_id stays null)` : ''))

  if (!WRITE) { console.log('\nDry run. Add --write to insert.'); return }
  if (!rows.length) { console.log('\nNothing to do.'); return }

  // Photos first: a scan row with a key pointing at nothing is worse than a scan
  // row with no key, because the detail view then shows a broken image instead
  // of saying there is no picture.
  if (photos && canUpload()) {
    process.stdout.write(`uploading ${rows.length} photo(s)… `)
    for (let r = 0; r < rows.length; r++) {
      const i = rowPhoto[r]
      const key = `teams/${boat.team_id}/boats/${boat.id}/sail-scans/${Date.now()}-${i}-photo.jpg`
      await putToStorage(key, photos[i], 'image/jpeg')
      const cond = rows[r].conditions as Record<string, unknown>
      cond.photo_key = key
    }
    console.log('done')
  }

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
