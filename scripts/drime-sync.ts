// scripts/drime-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// Match a Drime share's camera originals against what SSA already holds, and
// fetch the ones that are missing.
//
//   npx vite-node scripts/drime-manifest.ts -- <share-url> --out /tmp/drime.json
//   npx vite-node scripts/drime-sync.ts -- --manifest /tmp/drime.json           # report
//   npx vite-node scripts/drime-sync.ts -- --manifest /tmp/drime.json --write   # + download
//
// It DOWNLOADS. It does not upload: the download lands in a staging folder and
// `npm run media:upload -- <folder> --write` puts it in the cloud. That split is
// deliberate — day-media-upload.ts already knows how to read EXIF, pick the
// venue-local day, pull the day's log out of Bunny and fill analysis_data, and
// it already skips a photo the day already has. Re-implementing any of that here
// would be a second, less-tested copy of the thing that matters most.
//
// THE MATCH KEY IS BYTE SIZE. Not the filename: SSA renames on upload
// (`p_<ts>_<rand>.jpg`), so the camera's `_MG_1234.JPG` is not recoverable from
// a photo row. Not the capture time either, at this stage: that lives in EXIF
// inside the file, which is the thing we are trying to avoid downloading 8 GB
// of. Byte size is exact, free from the listing, and a JPEG's length is a
// 20-bit-ish fingerprint — two different frames colliding within one day is
// possible but rare, and a collision costs one skipped upload, not a wrong one.
//
// Runs OUTSIDE Claude Code's Bash sandbox (Node's fetch ignores the proxy).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const argVal = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : null)
const manifestPath = argVal('--manifest') || '/tmp/drime-manifest.json'
const write = args.includes('--write')
const stageArg = argVal('--stage')
const only = argVal('--date')
const alsoSpeed = args.includes('--speed')
// --kind speed downloads the compilations and documents instead of the camera
// originals, filed by the MEETING date they belong to (the day AFTER the sailing
// they were made from — docs/uploading-a-days-media.md).
const kind = argVal('--kind') || 'originals'
const fail = (m: string): never => { console.error(m); process.exit(1) }

const stage = (stageArg || join(homedir(), 'Downloads', 'drime-sync')).replace(/^~/, homedir())

// ── env ───────────────────────────────────────────────────────────────────────
const envPath = resolve(process.cwd(), '.env.local')
if (!existsSync(envPath)) fail('.env.local not found — run from the repo root')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
) as Record<string, string>
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// ── the manifest ──────────────────────────────────────────────────────────────
interface Entry {
  id: number; name: string; type: string
  file_size: number | null; dir: string
}
if (!existsSync(manifestPath)) fail(`${manifestPath} not found — run drime-manifest.ts first`)
const mf = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  origin: string; linkId: number; entries: Entry[]
}

const isOriginal = (e: Entry) => /^_MG_.*\.jpe?g$/i.test(e.name)
const isCompilation = (e: Entry) => /^\d{1,2}\.jpe?g$/i.test(e.name)
const isDoc = (e: Entry) => /\.(pdf|docx?|xlsx?|pptx?|csv|txt)$/i.test(e.name)

/** "20260904 finals" / "20260904 finals/pictures for leeway" → 2026-09-04. */
function dirDate(dir: string): string | null {
  const m = dir.match(/(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

async function main() {
  // ── what SSA has ────────────────────────────────────────────────────────────
  const { data, error } = await sb.from('photos')
    .select('id, bytes, taken_utc, bunny_storage_path, sessions:sessions(date)')
    .limit(5000)
  if (error) fail(`supabase: ${error.message}`)
  const have = (data || []) as unknown as
    { id: string; bytes: number | null; taken_utc: string | null; sessions: { date: string } | null }[]

  // Sizes SSA holds, globally and per day. Global matters: a photo filed on a
  // different day than its Drime folder is still present, and re-uploading it
  // would duplicate rather than fix anything.
  const haveGlobal = new Map<number, number>()
  const haveByDate = new Map<string, Set<number>>()
  for (const p of have) {
    if (p.bytes == null) continue
    haveGlobal.set(p.bytes, (haveGlobal.get(p.bytes) || 0) + 1)
    const d = p.sessions?.date || ''
    if (!haveByDate.has(d)) haveByDate.set(d, new Set())
    haveByDate.get(d)!.add(p.bytes)
  }

  const originals = mf.entries.filter(isOriginal)
    .filter(e => !only || dirDate(e.dir) === only)

  interface Row { e: Entry; date: string | null; inDay: boolean; anywhere: boolean }
  const rows: Row[] = originals.map(e => {
    const date = dirDate(e.dir)
    const sz = e.file_size || -1
    return {
      e, date,
      inDay: !!(date && haveByDate.get(date)?.has(sz)),
      anywhere: haveGlobal.has(sz),
    }
  })

  // ── the report ──────────────────────────────────────────────────────────────
  const byDate = new Map<string, Row[]>()
  for (const r of rows) {
    const k = r.date || '(undated)'
    if (!byDate.has(k)) byDate.set(k, [])
    byDate.get(k)!.push(r)
  }

  console.log('')
  console.log('Camera originals in the Drime share vs SSA')
  console.log('')
  console.log('day          drime   in SSA   elsewhere   MISSING   to fetch')
  console.log('─'.repeat(64))
  let totalMissing = 0, totalBytes = 0
  const toFetch: Row[] = []
  for (const [date, rs] of Array.from(byDate).sort()) {
    const inDay = (rs as Row[]).filter((r: Row) => r.inDay).length
    const elsewhere = (rs as Row[]).filter((r: Row) => !r.inDay && r.anywhere).length
    const miss = (rs as Row[]).filter((r: Row) => !r.anywhere)
    totalMissing += miss.length
    for (const r of miss) { toFetch.push(r); totalBytes += r.e.file_size || 0 }
    const flag = miss.length ? '  ←' : ''
    console.log(`${date.padEnd(12)} ${String(rs.length).padStart(5)} ${String(inDay).padStart(8)} ${String(elsewhere).padStart(11)} ${String(miss.length).padStart(9)} ${(miss.length ? (miss.reduce((a: number, r: Row) => a + (r.e.file_size || 0), 0) / 1e6).toFixed(0) + ' MB' : '—').padStart(10)}${flag}`)
  }
  console.log('─'.repeat(64))
  console.log(`${rows.length} originals in the share · ${rows.length - totalMissing} already in SSA · ` +
    `${totalMissing} missing (${(totalBytes / 1e9).toFixed(2)} GB)`)

  // Speed-team material is filed against the MEETING date, which is the day
  // AFTER the sailing the compilations were made from (docs/uploading-a-days-media.md).
  if (alsoSpeed) {
    const speed = mf.entries.filter(e => isCompilation(e) || isDoc(e))
    const sByDate = new Map<string, Entry[]>()
    for (const e of speed) {
      const d = dirDate(e.dir)
      if (!d) continue
      const meet = new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)
      if (!sByDate.has(meet)) sByDate.set(meet, [])
      sByDate.get(meet)!.push(e)
    }
    console.log('')
    console.log('Speed-team material, by the MEETING date it belongs to:')
    for (const [meet, es] of Array.from(sByDate).sort()) {
      console.log(`  ${meet}  ${String(es.length).padStart(3)} files  ` +
        `${(es.reduce((a, e) => a + (e.file_size || 0), 0) / 1e6).toFixed(0)} MB  ` +
        `(from ${dirDate(es[0].dir)} sailing)`)
    }
  }

  // ── speed-team material ─────────────────────────────────────────────────────
  if (kind === 'speed') {
    const { data: dbs } = await sb.from('debriefs')
      .select('documents, sessions:sessions(date)').limit(500)
    const attached = new Map<string, Set<string>>()
    for (const r of (dbs || []) as unknown as
      { documents: { name?: string; scope?: string }[] | null; sessions: { date: string } | null }[]) {
      const d = r.sessions?.date
      if (!d) continue
      const names = (Array.isArray(r.documents) ? r.documents : [])
        .filter(x => x?.scope === 'speed').map(x => x.name || '')
      attached.set(d, new Set(names))
    }

    const speed = mf.entries.filter(e => isCompilation(e) || isDoc(e))
    const byMeet = new Map<string, Entry[]>()
    for (const e of speed) {
      const d = dirDate(e.dir)
      if (!d) continue
      const meet = new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)
      if (only && meet !== only) continue
      if (!byMeet.has(meet)) byMeet.set(meet, [])
      byMeet.get(meet)!.push(e)
    }

    console.log('')
    console.log('Speed-team material (compilations + documents)')
    console.log('')
    console.log('meeting      drime   attached   MISSING   to fetch')
    console.log('─'.repeat(52))
    const want: { meet: string; e: Entry }[] = []
    let mb = 0
    for (const [meet, es] of Array.from(byMeet).sort()) {
      const has = attached.get(meet) || new Set()
      const miss = es.filter(e => !has.has(e.name))
      for (const e of miss) { want.push({ meet, e }); mb += e.file_size || 0 }
      console.log(`${meet.padEnd(12)} ${String(es.length).padStart(5)} ${String(has.size).padStart(10)} ${String(miss.length).padStart(9)} ${((miss.reduce((a, e) => a + (e.file_size || 0), 0) / 1e6).toFixed(0) + ' MB').padStart(10)}`)
    }
    console.log('─'.repeat(52))
    console.log(`${want.length} files missing, ${(mb / 1e9).toFixed(2)} GB`)
    if (!want.length) { console.log('\nNothing to fetch.'); return }
    if (!write) {
      console.log(`\nDry run. --write downloads them into ${stage}/speed/<meeting-date>/`)
      console.log('then, per date:  npm run media:upload -- <dir> --speed <meeting-date> --write')
      return
    }
    let ok = 0, bad = 0
    for (const w of want) {
      const dir = join(stage, 'speed', w.meet)
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, w.e.name)
      if (existsSync(dest) && statSync(dest).size === w.e.file_size) { ok++; continue }
      try {
        const res = await fetch(`${mf.origin}/api/v1/file-entries/${w.e.id}/raw?shareable_link=${mf.linkId}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length < 1024) throw new Error(`${buf.length} bytes — has the share expired?`)
        writeFileSync(dest, buf)
        ok++
      } catch (e) { bad++; console.log(`\n  ! ${w.e.name}: ${(e as Error).message}`) }
      process.stdout.write(`\r  ${ok + bad}/${want.length}  ${w.meet}  ${w.e.name.slice(0, 44)}          `)
    }
    console.log(`\n\ndownloaded ${ok}, failed ${bad} → ${stage}/speed/`)
    console.log('\nAttach them, one command per meeting date:')
    for (const meet of Array.from(new Set(want.map(w => w.meet))).sort()) {
      console.log(`  npm run media:upload -- ${stage}/speed/${meet} --speed ${meet} --write`)
    }
    return
  }

  if (!totalMissing) { console.log('\nNothing to fetch.'); return }
  if (!write) {
    console.log(`\nDry run. Re-run with --write to download the ${totalMissing} missing originals into`)
    console.log(`  ${stage}`)
    console.log('then upload them with:')
    console.log(`  npm run media:upload -- ${stage} --write`)
    return
  }

  // ── fetch ───────────────────────────────────────────────────────────────────
  // Into per-day folders for legibility only. day-media-upload re-derives the
  // day from each file's own EXIF, so a misfiled folder here cannot misfile a
  // photo there.
  mkdirSync(stage, { recursive: true })
  let done = 0, failed = 0
  for (const r of toFetch) {
    const dir = join(stage, r.date || 'undated')
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, r.e.name)
    if (existsSync(dest) && statSync(dest).size === r.e.file_size) {
      done++
      process.stdout.write(`\r  ${done + failed}/${toFetch.length}  (have) ${r.e.name}          `)
      continue
    }
    const url = `${mf.origin}/api/v1/file-entries/${r.e.id}/raw?shareable_link=${mf.linkId}`
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      // A share that has quietly expired serves an HTML login page with a 200.
      if (buf.length < 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) {
        throw new Error(`not a JPEG (${buf.length} bytes) — has the share expired?`)
      }
      writeFileSync(dest, buf)
      done++
    } catch (e) {
      failed++
      process.stdout.write(`\n  ! ${r.e.name}: ${(e as Error).message}\n`)
    }
    process.stdout.write(`\r  ${done + failed}/${toFetch.length}  ${r.e.name}          `)
  }
  console.log('')
  console.log(`\ndownloaded ${done}, failed ${failed} → ${stage}`)
  console.log('\nNow put them in the cloud (reads each file\'s own EXIF, files it on the right')
  console.log('day, and fills analysis_data from the day\'s log in Bunny):')
  console.log(`  npm run media:upload -- ${stage} --write`)
}

main().catch(e => fail(e?.message || String(e)))
