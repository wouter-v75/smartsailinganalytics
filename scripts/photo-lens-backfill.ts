// scripts/photo-lens-backfill.ts
// ─────────────────────────────────────────────────────────────────────────────
// Put the LENS on photos that are already in SSA, read from the originals on
// this machine.
//
//   npx vite-node scripts/photo-lens-backfill.ts -- "~/Pictures/2026-09-05"
//   …then the same line with --write
//
// DRY RUN by default. Reads .env.local; needs exiftool; run OUTSIDE Claude
// Code's Bash sandbox.
//
// WHY THIS EXISTS. SailTrim turns a scale into a RANGE with the focal length,
// and the range is what corrects every target's depth and ψ's effective
// separation. Without it both corrections are skipped silently — not applied
// badly, skipped — and the frame still produces numbers that sit happily beside
// corrected ones. Northstar's 5 Sept set is five frames out of six like that,
// and its boom agrees to 73 mm across all six, which reads as precision and is
// agreement between different maths.
//
// It cannot be recovered from the cloud copy. Those originals were re-exported
// with the overlay burned in and the EXIF stripped, so the file the tab fetches
// has no lens at all and the box is left empty or filled from whatever the last
// frame used. That is how 100 and 114 mm ended up on two frames a second apart.
//
// MATCHING IS BY THE MOMENT OF CAPTURE, which took three attempts to get right
// and the first two are worth recording.
//
// NOT by filename: the upload stores `sessions/<date>/photos/<id>.jpg` and
// discards the photographer's name, so there is nothing there to compare.
//
// NOT by byte count either, which was the obvious second answer and also wrong:
// the copies in SSA are RE-EXPORTS with the overlay burned in, so they share no
// bytes with the camera original sitting on disk. 648 files matched nothing.
//
// EXIF DateTimeOriginal is what survives both. It is a venue-LOCAL wall clock
// with no zone — the trap this whole project is built around — so --tz converts
// it the same way the upload did. A 5 Sept frame shot at 12:37:46 in Porto
// Cervo is taken_utc 10:37:46, and CEST is +120.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { execFileSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
/** Venue offset in MINUTES. EXIF carries no zone; the upload used the same. */
const TZ_MIN = Number(flag('--tz') ?? 120)
/** Seconds of slop allowed between the original's stamp and the stored row. */
const TOL_S = Number(flag('--tol') ?? 2)
const DIRS = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--tz' && args[i - 1] !== '--tol')
if (!DIRS.length) {
  console.error('usage: <folder of originals> [more folders] [--write]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const IMG = /\.(jpe?g|png|heic|tiff?)$/i
const num = (v: string) => {
  const x = parseFloat(String(v).replace(/[^\d.]/g, ''))
  return Number.isFinite(x) && x > 0 ? x : null
}

/**
 * DateTimeOriginal as true UTC ms, using the venue offset.
 *
 * The stamp is a LOCAL wall clock with no zone — read it as UTC and the whole
 * set lands hours from its rows. Converted the same way the upload converted
 * it, which is why --tz has to match what media:upload used for that day.
 */
function exifUtcMs(file: string): number | null {
  try {
    const out = execFileSync('exiftool', ['-s3', '-DateTimeOriginal', '-CreateDate', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const first = out.split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(first)
    if (!m) return null
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - TZ_MIN * 60_000
  } catch { return null }
}

/** BOTH focal lengths: they pair with different sensor widths. See focalForSensor. */
function lensOf(file: string) {
  const out = execFileSync('exiftool',
    ['-s3', '-Model', '-LensModel', '-FocalLength', '-FocalLengthIn35mmFormat', file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const [model, lens, focal, focal35] = out.split('\n').map((x) => x.trim())
  return {
    camera: model || null,
    lensModel: lens || null,
    focalMm: focal ? num(focal) : null,
    focal35Mm: focal35 ? num(focal35) : null,
  }
}

async function main() {
  try { execFileSync('exiftool', ['-ver'], { stdio: 'ignore' }) }
  catch { console.error('exiftool not on PATH — brew install exiftool'); process.exit(1) }

  // capture instant (ms, true UTC) → every local file taken then.
  const byTime = new Map<number, string[]>()
  const noStamp: string[] = []
  for (const dir of DIRS) {
    // A folder that is not there is a typo or a placeholder somebody pasted,
    // and a stack trace from node:fs says neither. Name it and carry on with
    // the folders that do exist.
    let entries: string[]
    try { entries = readdirSync(dir) }
    catch { console.error(`no such folder: ${dir}`); continue }
    for (const f of entries) {
      if (!IMG.test(f)) continue
      const p = join(dir, f)
      if (!statSync(p).isFile()) continue
      const t = exifUtcMs(p)
      if (t == null) { noStamp.push(basename(p)); continue }
      if (!byTime.has(t)) byTime.set(t, [])
      byTime.get(t)!.push(p)
    }
  }
  const locals = new Map<number, string>()
  for (const [t, paths] of Array.from(byTime)) {
    if (paths.length === 1) locals.set(t, paths[0])
  }
  const ambiguous = Array.from(byTime).filter(([, ps]) => ps.length > 1)
  if (!locals.size) {
    console.error('no images found in any of those folders — nothing to read a lens from')
    process.exit(1)
  }
  console.log(`${locals.size} original(s) on disk with a readable stamp, read as UTC${TZ_MIN >= 0 ? '+' : ''}${TZ_MIN / 60}`
    + (ambiguous.length ? ` · ${ambiguous.length} instant(s) shared by more than one file, skipped` : '')
    + (noStamp.length ? ` · ${noStamp.length} with no DateTimeOriginal` : '') + '\n')

  const { data: photos, error } = await sb.from('photos')
    .select('id, taken_utc, bunny_storage_path, bytes, exif_data')
  if (error) { console.error(`photos: ${error.message}`); process.exit(1) }

  let done = 0, already = 0, noLens = 0, noMatch = 0
  const unmatched: string[] = []
  const rowsUnmatched: string[] = []
  for (const row of photos ?? []) {
    const rowMs = Date.parse(String(row.taken_utc ?? ''))
    if (!Number.isFinite(rowMs)) continue
    // Nearest local capture within the tolerance. The stamps agree to the
    // second when the zone is right, and not at all when it is not — which is
    // the loudest symptom of a wrong --tz.
    let key: number | null = null
    for (const t of Array.from(locals.keys())) {
      if (Math.abs(t - rowMs) <= TOL_S * 1000) { key = t; break }
    }
    if (key == null) { rowsUnmatched.push(String(row.taken_utc)); continue }
    const local = locals.get(key)!
    locals.delete(key)
    const exif = (row.exif_data || {}) as Record<string, unknown>
    if (exif.focalMm || exif.focal35Mm) { already++; continue }
    const lens = lensOf(local)
    if (!lens.focalMm && !lens.focal35Mm) {
      noLens++
      console.log(`${basename(local).padEnd(28)} the ORIGINAL has no focal length either`)
      continue
    }
    console.log(`${basename(local).padEnd(28)} ${lens.camera ?? '—'}`
      + `  ${lens.focalMm ?? '—'} mm actual · ${lens.focal35Mm ?? '—'} mm at 36 mm`)
    if (WRITE) {
      const { error: uErr } = await sb.from('photos')
        .update({ exif_data: { ...exif, ...lens } }).eq('id', row.id)
      if (uErr) { console.error(`  ! ${uErr.message}`); process.exit(1) }
    }
    done++
  }
  for (const path of Array.from(locals.values())) { unmatched.push(basename(path)); noMatch++ }

  console.log(`\n${done} ${WRITE ? 'written' : 'to write'}`
    + (already ? ` · ${already} already had a lens` : '')
    + (noLens ? ` · ${noLens} originals with no EXIF lens` : '')
    + (noMatch ? ` · ${noMatch} on disk matched no photo` : ''))
  if (unmatched.length) {
    console.log(`  on disk, no row within ${TOL_S}s: ${unmatched.slice(0, 6).join(', ')}${unmatched.length > 6 ? ' …' : ''}`)
  }
  // Nothing matched at all is a WRONG ZONE far more often than a missing photo,
  // and the two look identical from a count. Show both clocks side by side.
  if (!done && !already) {
    const sampleLocal = Array.from(locals.keys()).sort().slice(0, 3)
      .map((t) => new Date(t).toISOString().slice(11, 19))
    console.log(`\n  Nothing matched. First local stamps as UTC: ${sampleLocal.join(', ') || '(none)'}`)
    console.log(`  First stored taken_utc:              ${rowsUnmatched.slice(0, 3).map((t) => t.slice(11, 19)).join(', ') || '(none)'}`)
    console.log('  A constant whole-hour gap between those two rows is the venue offset —')
    console.log('  pass it as --tz <minutes> (120 = CEST, 60 = BST, 0 = GMT).')
  }
  if (!WRITE && done) console.log('\nDry run. Add --write to store.')
}
main()
