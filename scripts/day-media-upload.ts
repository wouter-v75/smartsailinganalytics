// Upload a day's photos (and the speed-team meeting's pictures/documents) to the
// cloud, from a folder on disk. Works the same on the evening of a sailing day
// and on a folder of a whole regatta week weeks later.
//
//   npm run media:upload -- ~/Downloads/SSA-upload/photos                       dry run
//   npm run media:upload -- ~/Downloads/SSA-upload/photos --write               do it
//   npm run media:upload -- ~/Downloads/day4 --speed 2026-09-06 --write         speed-team
//
// WHY THIS EXISTS, rather than dragging the files into the Upload tab:
//
// The browser import tags a photo with the boat's instruments by reading that
// day's log out of IndexedDB — and the log is only ever in IndexedDB on the
// machine that imported its CSV (loading a day from the cloud does not cache
// it). Import a day's photos from any other laptop and every photo lands with
// an empty analysis_data: the person who imported them sees instruments,
// because PhotosTab re-derives them on screen, and nobody else ever does. That
// is what happened to the whole Porto Cervo week on 18 Sept 2026.
//
// This script reads the log from the CLOUD instead, so it does not care which
// machine it runs on or whether the day was sailed today or last month.
//
// It is idempotent: a photo already in the day (same byte size AND same capture
// second) is skipped, so re-running after adding a few more files uploads only
// the new ones.
//
// Needs .env.local (Supabase URL + service key, and the Bunny storage WRITE
// key). Needs `exiftool` and `ffmpeg` on PATH — both are Homebrew one-liners.
// In Claude Code's sandbox, run it outside the sandbox.

import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { join, resolve, basename, extname } from 'path'
import { homedir, tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'

const USAGE = `Upload a day's photos, or a speed-team meeting's files, to the cloud.

Usage:
  npm run media:upload -- PATH [PATH …] [--write] [--boat ID] [--tz MIN]
  npm run media:upload -- PATH --speed YYYY-MM-DD [--docs] [--write]

  PATH       a folder (recursed) or a single image; quote paths with spaces
  --write    do it (without this: dry run, nothing is uploaded)
  --boat     boat id, when more than one boat matches "Northstar 76"
  --tz       venue offset in MINUTES for reading EXIF clocks (default: the
             day's stored tzOffset, else +120). EXIF carries no timezone, so
             this decides which day a photo lands in and which log rows it
             matches — get it wrong and everything is shifted.
  --speed    treat the files as speed-team meeting material for THAT date's
             notes. Remember the convention: a meeting on the morning of day
             N+1 discusses day N, so pass the MEETING's date, not the sailing
             date. Images become Pictures, everything else Documents.
  --docs     with --speed, force everything to Documents.
  --help     this text

Examples:
  npm run media:upload -- ~/Downloads/week/photos --write
  npm run media:upload -- ~/Downloads/20260905/compilations --speed 2026-09-06 --write
  npm run media:upload -- ~/Downloads/sailcomparison.pdf --speed 2026-09-03 --write

Needs .env.local, plus exiftool and ffmpeg. In Claude Code's sandbox, run it
outside the sandbox.`

const args = process.argv.slice(2)
if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0) }
const write = args.includes('--write')
const forceDocs = args.includes('--docs')
const argVal = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null)
const boatArg = argVal('--boat')
const tzArg = argVal('--tz')
const speedDate = argVal('--speed')
const paths = args.filter((a, i) =>
  !a.startsWith('--') && !['--boat', '--tz', '--speed'].includes(args[i - 1]))

const fail = (msg: string): never => { console.error(msg); process.exit(1) }
if (speedDate && !/^\d{4}-\d{2}-\d{2}$/.test(speedDate)) fail('--speed needs YYYY-MM-DD')

// ── env ───────────────────────────────────────────────────────────────────────
const envPath = resolve(process.cwd(), '.env.local')
if (!existsSync(envPath)) fail('.env.local not found — run from the repo root')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
) as Record<string, string>

for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BUNNY_STORAGE_ZONE']) {
  if (!env[k]) fail(`${k} missing from .env.local`)
}
// The read-only key cannot PUT. This is the one credential people leave out.
if (write && !env.BUNNY_STORAGE_WRITE_KEY) {
  fail('BUNNY_STORAGE_WRITE_KEY missing from .env.local — that is the read/WRITE\n' +
       'password from Bunny → Storage → your zone → FTP & API Access, not the\n' +
       'read-only one in BUNNY_STORAGE_API_KEY. Nothing can be uploaded without it.')
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const REGION = env.BUNNY_STORAGE_REGION || 'de'
const STORAGE_HOST = REGION === 'de' ? 'https://storage.bunnycdn.com' : `https://${REGION}.storage.bunnycdn.com`
const ZONE = env.BUNNY_STORAGE_ZONE

// ── external tools ────────────────────────────────────────────────────────────
function need(bin: string, hint: string) {
  try { execFileSync('which', [bin], { stdio: 'pipe' }) }
  catch { fail(`${bin} not found — ${hint}`) }
}
need('exiftool', 'brew install exiftool')
need('ffmpeg', 'brew install ffmpeg')

/** EXIF DateTimeOriginal as "YYYY:MM:DD HH:MM:SS" — LOCAL wall clock, no zone. */
function exifLocal(file: string): string | null {
  try {
    const out = execFileSync('exiftool', ['-s3', '-DateTimeOriginal', '-CreateDate', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const first = out.split('\n').map(s => s.trim()).filter(Boolean)[0]
    return /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(first || '') ? first : null
  } catch { return null }
}

/** Local wall clock + venue offset → true UTC ms. */
function toUtc(local: string, tzMin: number): number {
  const [d, t] = local.split(' ')
  const [Y, M, D] = d.split(':').map(Number)
  const [h, m, s] = t.split(':').map(Number)
  return Date.UTC(Y, M - 1, D, h, m, s) - tzMin * 60000
}

/** The venue-local calendar date of an instant — the day a photo belongs to. */
function dayOf(utc: number, tzMin: number): string {
  return new Date(utc + tzMin * 60000).toISOString().slice(0, 10)
}

function thumbnail(src: string, tmp: string): Buffer | null {
  const out = join(tmp, 'thumb.jpg')
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src,
      '-vf', "scale='min(480,iw)':-2", '-q:v', '4', out], { stdio: 'pipe' })
    return readFileSync(out)
  } catch { return null }
}

async function putBunny(key: string, body: Buffer, contentType: string) {
  const r = await fetch(`${STORAGE_HOST}/${ZONE}/${key}`, {
    method: 'PUT',
    headers: { AccessKey: env.BUNNY_STORAGE_WRITE_KEY, 'Content-Type': contentType },
    // Buffer is not a BodyInit in these lib types; the view over the same bytes is.
    body: new Uint8Array(body),
  })
  if (!r.ok) throw new Error(`bunny PUT ${key}: ${r.status} ${await r.text().catch(() => '')}`)
}

async function getBunnyJson<T>(key: string): Promise<T | null> {
  const r = await fetch(`${STORAGE_HOST}/${ZONE}/${key}`, {
    headers: { AccessKey: env.BUNNY_STORAGE_API_KEY || env.BUNNY_STORAGE_WRITE_KEY },
  })
  if (!r.ok) return null
  return (await r.json().catch(() => null)) as T | null
}

// ── files ─────────────────────────────────────────────────────────────────────
const IMG = /\.(jpe?g|png|heic|heif|webp|tiff?)$/i
function walk(p: string, out: string[] = []): string[] {
  const st = statSync(p)
  if (st.isFile()) { out.push(p); return out }
  for (const e of readdirSync(p, { withFileTypes: true })) {
    // macOS AppleDouble sidecars are 4 KB of nothing and look like real files.
    if (e.name.startsWith('.')) continue
    walk(join(p, e.name), out)
  }
  return out
}
const expand = (p: string) => p.replace(/^~/, homedir())

// ── the day's log, from the CLOUD (the whole point of this script) ────────────
interface LogRow { utc: number; tws?: number; twa?: number; awa?: number; bsp?: number; heel?: number; vmg?: number }
interface DayData { rows: LogRow[]; sails: { utc: number; sails: string[] }[]; boat: string | null; location: string | null }
const dayCache = new Map<string, DayData | null>()

async function cloudDay(date: string): Promise<DayData | null> {
  if (dayCache.has(date)) return dayCache.get(date)!
  const log = await getBunnyJson<{ rows?: LogRow[] }>(`sessions/${date}/log.json`)
  const ev = await getBunnyJson<{ sailsUpEvents?: { utc: number; sails: string[] }[]; meta?: { boat?: string; location?: string } }>(`sessions/${date}/events.json`)
  const d: DayData | null = (log?.rows?.length || ev)
    ? { rows: log?.rows || [], sails: ev?.sailsUpEvents || [], boat: ev?.meta?.boat || null, location: ev?.meta?.location || null }
    : null
  dayCache.set(date, d)
  return d
}

/** Same rule as the app: nearest row, but only within five minutes. */
function nearestRow(rows: LogRow[], utc: number): LogRow | null {
  if (!rows.length) return null
  let lo = 0, hi = rows.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].utc < utc) lo = mid + 1; else hi = mid }
  if (lo > 0 && Math.abs(rows[lo - 1].utc - utc) < Math.abs(rows[lo].utc - utc)) lo--
  return Math.abs(rows[lo].utc - utc) < 300000 ? rows[lo] : null
}

/** The analysis_data blob — the shape the Timeline and every other device read. */
function analysisFor(day: DayData | null, utc: number) {
  const row = day ? nearestRow(day.rows, utc) : null
  const sails = day ? (day.sails.filter(s => s.utc <= utc).sort((a, b) => b.utc - a.utc)[0]?.sails || []) : []
  return {
    sails, raceTags: [], boat: day?.boat || null, location: day?.location || null,
    inst: {
      tws: row?.tws ?? null, twa: row?.twa ?? null, awa: row?.awa ?? null,
      bsp: row?.bsp ?? null, heel: row?.heel ?? null, vmg: row?.vmg ?? null,
    },
  }
}

const safeName = (n: string) => n.replace(/[^\w.\-]+/g, '_').slice(0, 120)

async function main() {
  // ── boat ────────────────────────────────────────────────────────────────────
  const { data: boats, error: boatErr } = await sb.from('boats').select('id, name, team_id')
  if (boatErr) fail(`boats: ${boatErr.message}`)
  const matches = boatArg ? boats!.filter(b => b.id === boatArg)
                          : boats!.filter(b => /northstar\s*76|\bns\s*76\b|\b76\b/i.test(b.name || ''))
  if (matches.length !== 1) {
    fail(matches.length
      ? `boat ambiguous — pass --boat:\n${matches.map(b => `  ${b.id}  ${b.name}`).join('\n')}`
      : 'no boat matched; pass --boat <id>')
  }
  const boat = matches[0]
  console.log(`boat: ${boat.name} (${boat.id})`)

  const files = paths.flatMap(p => {
    const full = expand(p)
    if (!existsSync(full)) fail(`not found: ${full}`)
    return walk(full)
  })
  if (!files.length) fail('no files found')

  const tmp = mkdtempSync(join(tmpdir(), 'ssa-media-'))
  try {
    if (speedDate) await uploadSpeed(files, boat, tmp)
    else await uploadPhotos(files, boat, tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (!write) console.log('\nDRY RUN — nothing was uploaded. Re-run with --write.')
}

// ── photos ────────────────────────────────────────────────────────────────────
async function uploadPhotos(files: string[], boat: { id: string; team_id: string }, tmp: string) {
  const imgs = files.filter(f => IMG.test(f))
  const skippedType = files.length - imgs.length
  if (skippedType) console.log(`${skippedType} non-image file(s) ignored (use --speed for documents)`)

  // Group by the day each photo belongs to, so we fetch each day's log once.
  const byDay = new Map<string, { file: string; utc: number; bytes: number }[]>()
  const noExif: string[] = []
  for (const f of imgs) {
    const local = exifLocal(f)
    if (!local) { noExif.push(basename(f)); continue }
    // tz: explicit flag wins; otherwise +120 (CEST) — corrected per day below
    // once we know the session's own offset.
    const tz = tzArg != null ? Number(tzArg) : 120
    const utc = toUtc(local, tz)
    const day = dayOf(utc, tz)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day)!.push({ file: f, utc, bytes: statSync(f).size })
  }
  if (noExif.length) {
    console.log(`\n⚠ ${noExif.length} file(s) have no EXIF capture time and were skipped:`)
    noExif.slice(0, 8).forEach(n => console.log(`    ${n}`))
    console.log('    (the import needs a capture time to know which day they belong to)')
  }

  let uploaded = 0, skipped = 0
  for (const [date, items] of Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const { data: session } = await sb.from('sessions').select('id')
      .eq('team_id', boat.team_id).eq('boat_id', boat.id).eq('date', date).maybeSingle()

    const { data: existing } = session
      ? await sb.from('photos').select('bytes, taken_utc').eq('session_id', session.id)
      : { data: [] as { bytes: number; taken_utc: string }[] }
    // Idempotency: same size AND same capture second is the same photo.
    const have = new Set((existing || []).map(p => `${p.bytes}@${Date.parse(p.taken_utc)}`))

    const day = await cloudDay(date)
    const todo = items.filter(i => !have.has(`${i.bytes}@${i.utc}`))
    skipped += items.length - todo.length

    console.log(`\n${date}  ${items.length} file(s), ${todo.length} new` +
      `${day ? `, log ${day.rows.length} rows` : ', NO CLOUD LOG — photos will have no instruments'}` +
      `${session ? '' : ', no session row yet'}`)

    if (!write) { todo.slice(0, 4).forEach(t => console.log(`    would upload ${basename(t.file)}`)); continue }

    let sessionId = session?.id
    if (!sessionId) {
      const r = await sb.from('sessions')
        .insert({ team_id: boat.team_id, boat_id: boat.id, date }).select('id').single()
      if (r.error) { console.log(`  ✕ session: ${r.error.message}`); continue }
      sessionId = r.data.id
    }

    for (const it of todo) {
      try {
        const id = `p_${Date.now()}_${Math.random().toString(36).slice(2)}`
        const original = `sessions/${date}/photos/${id}.jpg`
        const thumbKey = `sessions/${date}/photos/${id}_thumb.jpg`
        const buf = readFileSync(it.file)
        await putBunny(original, buf, 'image/jpeg')
        const tb = thumbnail(it.file, tmp)
        if (tb) await putBunny(thumbKey, tb, 'image/jpeg')

        const { error } = await sb.from('photos').insert({
          session_id: sessionId, team_id: boat.team_id, boat_id: boat.id,
          taken_utc: new Date(it.utc).toISOString(),
          exif_data: { utc: it.utc, camera: null, lat: null, lon: null },
          thumbnail_url: tb ? thumbKey : null,
          bunny_storage_path: original,
          bytes: it.bytes,
          analysis_data: analysisFor(day, it.utc),
        })
        if (error) throw new Error(error.message)
        uploaded++
        const inst = analysisFor(day, it.utc).inst
        console.log(`  ✓ ${basename(it.file).slice(0, 40)}` +
          (inst.tws != null ? `  TWS ${inst.tws} TWA ${inst.twa}` : '  (no log match — outside the sailing window?)'))
      } catch (e) {
        console.log(`  ✕ ${basename(it.file).slice(0, 40)}: ${(e as Error).message}`)
      }
    }
  }
  console.log(`\n${uploaded} uploaded, ${skipped} already present.`)
}

// ── speed-team meeting material ───────────────────────────────────────────────
async function uploadSpeed(files: string[], boat: { id: string; team_id: string }, tmp: string) {
  const date = speedDate!
  console.log(`\nspeed-team notes for ${date}  (${files.length} file(s))`)
  console.log('  reminder: this is the MEETING date — a meeting on day N+1 discusses day N')

  const { data: session } = await sb.from('sessions').select('id')
    .eq('team_id', boat.team_id).eq('boat_id', boat.id).eq('date', date).maybeSingle()
  const { data: debrief } = session
    ? await sb.from('debriefs').select('id, documents').eq('session_id', session.id).maybeSingle()
    : { data: null }
  const existing: { name?: string }[] = Array.isArray(debrief?.documents) ? debrief!.documents : []
  const haveNames = new Set(existing.map(d => d.name))

  const todo = files.filter(f => !haveNames.has(basename(f)))
  console.log(`  ${existing.length} already attached, ${todo.length} to add`)
  if (!write) { todo.slice(0, 6).forEach(f => console.log(`    would attach ${basename(f)}`)); return }

  let sessionId = session?.id
  if (!sessionId) {
    const r = await sb.from('sessions').insert({ team_id: boat.team_id, boat_id: boat.id, date }).select('id').single()
    if (r.error) return console.log(`  ✕ session: ${r.error.message}`)
    sessionId = r.data.id
  }
  let debriefId = debrief?.id
  if (!debriefId) {
    const r = await sb.from('debriefs').insert({ session_id: sessionId, team_id: boat.team_id, boat_id: boat.id })
      .select('id, documents').single()
    if (r.error) return console.log(`  ✕ debrief: ${r.error.message}`)
    debriefId = r.data.id
  }

  const docs = [...existing]
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i]
    try {
      const name = basename(f)
      const isImg = !forceDocs && IMG.test(name)
      const key = `campaign/speed/${date}/${Date.now()}-${i}-${safeName(name)}`
      const buf = readFileSync(f)
      const ct = isImg ? 'image/jpeg' : extname(name).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream'
      await putBunny(key, buf, ct)
      let thumb_key: string | null = null
      if (isImg) {
        const tb = thumbnail(f, tmp)
        // Compilations are 20-48 MB and up to 170 megapixels; without a thumb the
        // picture grid downloads the original to paint a 94px box.
        if (tb) { thumb_key = `${key}.thumb.jpg`; await putBunny(thumb_key, tb, 'image/jpeg') }
      }
      docs.push({ key, thumb_key, name, bytes: buf.length, content_type: ct, scope: 'speed', uploaded_at: new Date().toISOString() } as never)
      console.log(`  ✓ ${name.slice(0, 48)}${isImg ? ' (picture)' : ' (document)'}`)
    } catch (e) {
      console.log(`  ✕ ${basename(f).slice(0, 40)}: ${(e as Error).message}`)
    }
  }
  const { error } = await sb.from('debriefs').update({ documents: docs }).eq('id', debriefId)
  if (error) console.log(`  ✕ documents: ${error.message}`)
  else console.log(`\n${docs.length - existing.length} attached to the ${date} speed-team notes.`)
}

main().catch(e => fail(String(e?.stack || e)))
