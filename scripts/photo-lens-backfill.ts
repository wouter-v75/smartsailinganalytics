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
// Matching is by FILE NAME against photos.bunny_storage_path, because that is
// what survives an upload. A name that matches nothing is reported rather than
// skipped: the whole point is to stop pretending absence is agreement.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import { execFileSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const DIRS = args.filter((a) => !a.startsWith('--'))
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

  const locals = new Map<string, string>()
  for (const dir of DIRS) {
    for (const f of readdirSync(dir)) {
      if (!IMG.test(f)) continue
      const p = join(dir, f)
      if (statSync(p).isFile()) locals.set(basename(f).toLowerCase(), p)
    }
  }
  console.log(`${locals.size} original(s) on disk\n`)

  const { data: photos, error } = await sb.from('photos')
    .select('id, taken_utc, bunny_storage_path, exif_data')
  if (error) { console.error(`photos: ${error.message}`); process.exit(1) }

  let done = 0, already = 0, noLens = 0, noMatch = 0
  const unmatched: string[] = []
  for (const row of photos ?? []) {
    const name = basename(String(row.bunny_storage_path || '')).toLowerCase()
    const local = locals.get(name)
    if (!local) continue
    locals.delete(name)
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
  for (const n of Array.from(locals.keys())) { unmatched.push(n); noMatch++ }

  console.log(`\n${done} ${WRITE ? 'written' : 'to write'}`
    + (already ? ` · ${already} already had a lens` : '')
    + (noLens ? ` · ${noLens} originals with no EXIF lens` : '')
    + (noMatch ? ` · ${noMatch} on disk matched no photo` : ''))
  if (unmatched.length) {
    console.log(`  not in SSA: ${unmatched.slice(0, 8).join(', ')}${unmatched.length > 8 ? ' …' : ''}`)
  }
  if (!WRITE && done) console.log('\nDry run. Add --write to store.')
}
main()
