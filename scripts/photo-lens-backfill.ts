// scripts/photo-lens-backfill.ts
// ─────────────────────────────────────────────────────────────────────────────
// Put the LENS on photos already in SSA, read from the originals on this
// machine.
//
//   npx vite-node scripts/photo-lens-backfill.ts -- \
//     "/Users/wouterverbraak/Downloads/NS_MaxiWorlds/Sternshots/stern_20260905" \
//     --date 2026-09-05
//
// With no --tz it MEASURES the venue offset (see "which venue offset?" below)
// and tells you which one to re-run with. --write then needs that --tz, so the
// offset is always a decision rather than a default nobody checked.
//
// DRY RUN by default. Reads .env.local; needs exiftool; run OUTSIDE Claude
// Code's Bash sandbox.
//
// WHY. SailTrim turns a scale into a RANGE with the focal length, and the range
// corrects every target's depth and ψ's effective separation. Without one both
// are SKIPPED — not applied badly, skipped — and the frame still produces
// numbers that sit beside corrected ones without complaint. Northstar's 5 Sept
// set is five frames out of six like that, and its boom agrees to 73 mm across
// all six, which reads as precision and is agreement between different maths.
//
// It cannot come from the cloud copy: those are re-exports with the overlay
// burned in and the EXIF stripped. The camera original is the only place it
// still exists.
//
// HOW THE JOIN WORKS, after three attempts:
//
//   by filename   — no. The upload stores `sessions/<date>/photos/<id>.jpg`
//                   and discards the photographer's name.
//   by byte count — no. The copy in SSA is a re-export; it shares no bytes
//                   with the original. 648 files, 0 matched.
//   by CAPTURE TIME — yes, and it is the only thing both still carry.
//
// EXIF DateTimeOriginal is a venue-LOCAL wall clock with no zone, so something
// has to supply the shift to a stored taken_utc. The script measures it rather
// than defaulting, because a wrong offset matches NOTHING and reads as "these
// are not the right originals" — which is a different and much more alarming
// conclusion than "try +1".
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { execFileSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const DATE = flag('--date')
const SHIFT_RAW = flag('--shift')   // seconds, as measureShift() reports it
const TZ_RAW = flag('--tz') ?? (SHIFT_RAW == null ? null : String(Number(SHIFT_RAW) / 60))
const TZ_MIN = Number(TZ_RAW ?? 0)   // the sweep re-offsets; 0 keeps stamps as read
const SWEEP = TZ_RAW == null
// EXACT second by default. Both sides of this join came out of the SAME EXIF
// field — taken_utc was read from DateTimeOriginal at upload — so they should be
// equal, not merely close, and any slack is pure downside. At 17 fps a 2 s
// window held 34 candidates on one row and the photographer zoomed 109 → 118 mm
// across them, which the script then had to report as an ambiguity. It was not
// ambiguous; the window was too wide. Raise it only if a day's rows turn out to
// have been stored from a different clock.
const TOL_S = Number(flag('--tol') ?? 0)
const ANALYSED = args.includes('--analysed')
const FLAGGED = new Set(['--date', '--tz', '--tol', '--shift'])
const DIRS = args.filter((a, i) => !a.startsWith('--') && !FLAGGED.has(args[i - 1] ?? ''))
if (!DIRS.length) {
  console.error('usage: photo-lens-backfill.ts -- /path/to/originals [--date 2026-09-05] [--tz 120] [--write]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const IMG = /\.(jpe?g|png|heic|tiff?)$/i
const num = (v: string | undefined) => {
  const x = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''))
  return Number.isFinite(x) && x > 0 ? x : null
}

interface Shot {
  path: string; ms: number
  camera: string | null; lensModel: string | null
  focalMm: number | null; focal35Mm: number | null
}

/** One exiftool call for the whole folder — 648 separate ones takes minutes.
 *
 *  `-T` is tab-separated, not CSV, deliberately: exiftool quotes CSV fields that
 *  contain a comma and lens names do ("RF100-500mm F4.5-7.1 L IS USM" does not,
 *  but plenty do), and a hand-rolled CSV splitter is exactly the kind of thing
 *  that works on every file until it doesn't. A tab cannot occur in any of these
 *  fields. Missing values come back as a bare `-`. */
const FIELDS = ['DateTimeOriginal', 'Model', 'LensModel', 'FocalLength', 'FocalLengthIn35mmFormat'] as const

function readFolder(dir: string): Shot[] {
  let files: string[]
  try { files = readdirSync(dir).filter((f) => IMG.test(f)) }
  catch { console.error(`no such folder: ${dir}`); return [] }
  const paths = files.map((f) => join(dir, f)).filter((p) => statSync(p).isFile())
  if (!paths.length) return []
  const out = execFileSync('exiftool',
    ['-T', ...FIELDS.map((f) => `-${f}`), '-FileName', ...paths],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  const shots: Shot[] = []
  for (const line of out.trim().split('\n')) {
    const c = line.split('\t').map((x) => (x === '-' ? '' : x.trim()))
    if (c.length < FIELDS.length + 1) continue
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(c[0])
    if (!m) continue
    shots.push({
      path: join(dir, c[FIELDS.length]),
      ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
      camera: c[1] || null,
      lensModel: c[2] || null,
      focalMm: num(c[3]),
      focal35Mm: num(c[4]),
    })
  }
  return shots
}

async function main() {
  try { execFileSync('exiftool', ['-ver'], { stdio: 'ignore' }) }
  catch { console.error('exiftool not on PATH — brew install exiftool'); process.exit(1) }

  const shots = DIRS.flatMap(readFolder)
  if (!shots.length) { console.error('no originals with a readable DateTimeOriginal'); process.exit(1) }
  console.log(`${shots.length} original(s) with a readable DateTimeOriginal`)

  let q = sb.from('photos').select('id, taken_utc, exif_data, analysis_data')
  // Range, not `like`: taken_utc is a timestamptz and Postgres refuses ~~ on one.
  // The day plus THREE HOURS either side, not more. It was 36 hours on the first
  // pass, justified as "loose enough not to clip", and that pulled the next
  // morning's rows into a query for the day before — so "69 photos on 4 Sept"
  // counted 5 Sept's as well and the offset measurement below was fed rows that
  // could never match. Three hours covers a venue-local day whose edges fall
  // outside the UTC one, which is the only reason for any slack at all.
  if (DATE) {
    const t0 = Date.parse(`${DATE}T00:00:00Z`)
    q = q.gte('taken_utc', new Date(t0 - 3 * 3600_000).toISOString())
      .lt('taken_utc', new Date(t0 + 27 * 3600_000).toISOString())
  }
  const { data: photos, error } = await q
  if (error) { console.error(`photos: ${error.message}`); process.exit(1) }
  console.log(`${(photos ?? []).length} photo(s) in SSA${DATE ? ` on ${DATE}` : ''}\n`)

  // ── which venue offset? ────────────────────────────────────────────────────
  //
  // DateTimeOriginal is a venue-LOCAL wall clock carrying no zone (CLAUDE.md,
  // "Clocks are local wall-time even when something calls them UTC"), so the
  // shift from it to a stored taken_utc has to come from somewhere. Guessing it
  // has been wrong twice in one evening — and worse, a wrong guess does not fail
  // loudly: it just matches nothing, which reads as "these are not the right
  // originals". So with no --tz the script MEASURES it, by asking which whole
  // offset aligns the most rows, and refuses to write until told which to use.
  //
  // One day's folder here starts at 11:50 local against an 11:50 row, and the
  // next starts at 11:53 local against a 10:37 row. They cannot both be right,
  // and the answer is a property of the data, not of my recollection.
  const rowsAll = (photos ?? []).filter((r) => Number.isFinite(Date.parse(String(r.taken_utc ?? ''))))

  // ── only the frames that NEED a focal ──────────────────────────────────────
  //
  // A focal length does one job here: it turns a scale into a RANGE, and the
  // range corrects every target's depth and ψ's effective separation. A photo
  // nobody has measured has no use for one. So --analysed keeps the frames
  // carrying `sailTrim.annotation` and drops the rest, which is the difference
  // between 19 rows of which 13 are other cameras, and the six that were
  // actually analysed.
  interface Ann { scale?: { rangeMm?: number | null; mmPerPxAtMast?: number }; imageSize?: { w: number; h: number } }
  const annOf = (r: { analysis_data?: unknown }): Ann | null =>
    (r.analysis_data as { sailTrim?: { annotation?: Ann } } | null)?.sailTrim?.annotation ?? null

  let rows = rowsAll
  if (ANALYSED) {
    const before = rows.length
    rows = rows.filter((r) => !!annOf(r))
    console.log(`${rows.length} of those ${before} carry sail geometry — the rest need no focal\n`)
  }

  /** The focal a frame was MEASURED on, recovered from the range it stored.
   *
   *  Not a tautology: the stored range came from a focal somebody TYPED, and the
   *  EXIF focal is an independent witness. This is what shows a 254 that was
   *  never a real focal length sitting on a frame beside a correct 100.
   *  A null range means no focal at all, so no depth correction was applied —
   *  the frame still produced numbers, which is the whole problem. */
  function focalUsed(a: Ann | null): number | null {
    const r = a?.scale?.rangeMm, s = a?.scale?.mmPerPxAtMast
    // The LONG EDGE, which is what SailTrimTab divides the sensor width by
    // (`imageLongEdgePx: Math.max(w, h)`). Using `w` instead inflates this by
    // h/w on a PORTRAIT frame — exactly 1.5 on a 3:2 body — and these stern
    // shots are portrait, which is how four frames measured on a typed 114 mm
    // came out of here reported as 171 and 172 and sent off to be redone.
    const px = Math.max(a?.imageSize?.w ?? 0, a?.imageSize?.h ?? 0)
    if (r == null || !(r > 0) || !(s && s > 0) || !(px > 0)) return null
    // 36 mm is the rig model's default sensor width and nothing here has
    // overridden it; a boat that did would make this read high by 36/its own.
    return (r * (36 / px)) / s      // range = mmPerPx · focal ÷ pitch
  }

  interface Hit { row: typeof rows[number]; when: string; shot: Shot; burst: number }
  function tryOffset(shift: number): { hits: Hit[]; disagree: string[]; missed: string[] } {
    const hits: Hit[] = []; const disagree: string[] = []; const missed: string[] = []
    for (const row of rows) {
      const rowMs = Date.parse(String(row.taken_utc))
      const when = String(row.taken_utc).slice(11, 19)
      const near = shots.filter((s) => Math.abs(s.ms - shift - rowMs) <= TOL_S * 1000)
        .sort((a, b) => Math.abs(a.ms - shift - rowMs) - Math.abs(b.ms - shift - rowMs))
      if (!near.length) { missed.push(when); continue }
      // A BURST IS NOT A PROBLEM. 114 of these instants hold more than one frame,
      // so a second does not identify a file — and it does not need to. This is
      // after the LENS, and you cannot zoom between frames 40 ms apart, so
      // several candidates are fine as long as they AGREE. When they disagree it
      // says so rather than picking one.
      const distinct = new Set(near.map((s) => `${s.focalMm}|${s.focal35Mm}`))
      if (distinct.size > 1) {
        const mm = near.map((s) => s.focalMm).filter((f): f is number => f != null).sort((a, b) => a - b)
        disagree.push(`${when}  ${near.length} originals within ${TOL_S}s span ${mm[0]}-${mm[mm.length - 1]} mm`
          + ` — the lens moved inside the window, so narrow --tol rather than trust any of them`)
        continue
      }
      hits.push({ row, when, shot: near[0], burst: near.length })
    }
    return { hits, disagree, missed }
  }

  // ── MEASURE the shift, don't sweep a list of guesses ───────────────────────
  //
  // The first version tried whole hours — 0, ±1, +2, +3 — which found +2 on
  // 5 Sept and nothing at all on 4 Sept, reporting "these are not the files that
  // were uploaded". They are: local 11:50:27 against a stored 11:50:17 is TEN
  // SECONDS, and no list of whole hours can see that. A camera clock set by hand
  // is not on the hour, and two bodies on the same boat are not on each other.
  //
  // So take every row's NEAREST original and look at the deltas. A real shift
  // shows up as one value shared by most rows; noise scatters. That measures
  // hours and seconds together and needs no candidate list.
  function measureShift(): { ms: number; n: number; table: string[] } | null {
    const tally = new Map<number, number>()
    for (const row of rows) {
      const rowMs = Date.parse(String(row.taken_utc))
      let best: number | null = null
      for (const sh of shots) {
        const d = sh.ms - rowMs
        if (best == null || Math.abs(d) < Math.abs(best)) best = d
      }
      if (best == null) continue
      const sec = Math.round(best / 1000)
      tally.set(sec, (tally.get(sec) ?? 0) + 1)
    }
    const ranked = Array.from(tally.entries()).sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))
    if (!ranked.length) return null
    const fmt = (sec: number) => {
      const a = Math.abs(sec), sign = sec < 0 ? '-' : '+'
      return `${sign}${Math.floor(a / 3600)}h ${String(Math.floor((a % 3600) / 60)).padStart(2, '0')}m `
        + `${String(a % 60).padStart(2, '0')}s`
    }
    return {
      ms: ranked[0][0] * 1000,
      n: ranked[0][1],
      table: ranked.slice(0, 5).map(([sec, n]) => `  ${fmt(sec)}  ${n} of ${rows.length} rows`),
    }
  }

  let shiftMs = SWEEP ? 0 : TZ_MIN * 60_000
  if (SWEEP) {
    const m = measureShift()
    if (!m) { console.log('no rows to measure against'); return }
    console.log('no --tz given, so measuring the shift from the data:')
    for (const line of m.table) console.log(line)
    if (m.n < 2) {
      console.log('\nNo shift is shared by even two rows, so there is no systematic offset')
      console.log('to find — these originals are not the files that were uploaded.')
      return
    }
    shiftMs = m.ms
    console.log(`\nTaking ${m.n} of ${rows.length} rows agreeing. Re-run with --shift ${m.ms / 1000} --write.\n`)
  }

  const { hits, disagree, missed } = tryOffset(shiftMs)
  for (const d of disagree) console.log(d)

  let done = 0, already = 0
  for (const h of hits) {
    const exif = (h.row.exif_data || {}) as Record<string, unknown>
    if (exif.focalMm || exif.focal35Mm) { already++; continue }
    const s = h.shot
    const a = annOf(h.row)
    const used = focalUsed(a)
    const verdict = !a ? ''
      : used == null ? '  ← measured with NO focal, so no depth correction at all'
      : Math.abs(used - (s.focalMm ?? 0)) < 2 ? '  ✓ already measured on this focal'
      : `  ← measured on ${used.toFixed(0)} mm (${a.imageSize?.w}×${a.imageSize?.h}), so REDO it`
    console.log(`${h.when}  ${basename(s.path)}${h.burst > 1 ? ` (+${h.burst - 1} same second)` : ''}`
      + `  ${s.focalMm ?? '—'} mm${s.focal35Mm ? ` (${s.focal35Mm} at 36 mm)` : ''}${verdict}`)
    if (WRITE && !SWEEP) {
      const { error: uErr } = await sb.from('photos').update({
        exif_data: {
          ...exif, camera: s.camera, lensModel: s.lensModel,
          focalMm: s.focalMm, focal35Mm: s.focal35Mm, focalFrom: 'original-exif',
        },
      }).eq('id', h.row.id)
      if (uErr) { console.error(`  ! ${uErr.message}`); process.exit(1) }
    }
    done++
  }

  console.log(`\n${done} ${WRITE && !SWEEP ? 'written' : 'to write'}`
    + (already ? ` · ${already} already had a lens` : '')
    + (disagree.length ? ` · ${disagree.length} with disagreeing candidates` : '')
    + (missed.length ? ` · ${missed.length} rows with no original within ${TOL_S}s` : ''))
  if (missed.length) {
    const span = shots.length
      ? `${new Date(Math.min(...shots.map((s) => s.ms)) - shiftMs).toISOString().slice(11, 19)}`
        + `-${new Date(Math.max(...shots.map((s) => s.ms)) - shiftMs).toISOString().slice(11, 19)}`
      : '(none)'
    console.log(`\nNo original for: ${missed.join(', ')}`)
    console.log(`This folder covers ${span} UTC. A row outside that is another camera`)
    console.log('or another folder, not a broken join — point the script at that folder too.')
  }
  if (WRITE && SWEEP) console.log('Nothing written: --write needs an explicit --tz, so the offset is a decision and not a guess.')
}
main()
