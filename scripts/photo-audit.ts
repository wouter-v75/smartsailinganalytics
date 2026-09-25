// scripts/photo-audit.ts
// ─────────────────────────────────────────────────────────────────────────────
// Which photos have their ORIGINAL in the cloud, and which are a thumbnail and
// nothing else.
//
//   npx vite-node scripts/photo-audit.ts                    # every day
//   npx vite-node scripts/photo-audit.ts -- --date 2026-09-05
//   npx vite-node scripts/photo-audit.ts -- --csv > audit.csv
//
// A `photos` row names a `bunny_storage_path`. That is the ORIGINAL. The
// thumbnail lives beside it with `_thumb` before the extension (see
// day-media-upload.ts). A row whose original 404s is a photo the gallery will
// show as a soft 480 px thumbnail for ever and which nothing can be measured on
// — and until the viewer was fixed, that state looked identical to a photo that
// was simply slow.
//
// Read-only. It HEADs Bunny; it writes nothing anywhere.
//
// Runs OUTSIDE Claude Code's Bash sandbox (it needs the network).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const argVal = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : null)
const onlyDate = argVal('--date')
const asCsv = args.includes('--csv')
const fail = (m: string): never => { console.error(m); process.exit(1) }

const envPath = resolve(process.cwd(), '.env.local')
if (!existsSync(envPath)) fail('.env.local not found — run from the repo root')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
) as Record<string, string>

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const REGION = env.BUNNY_STORAGE_REGION || 'de'
const HOST = REGION === 'de' ? 'https://storage.bunnycdn.com' : `https://${REGION}.storage.bunnycdn.com`
const ZONE = env.BUNNY_STORAGE_ZONE
const KEY = env.BUNNY_STORAGE_API_KEY || env.BUNNY_STORAGE_WRITE_KEY

const thumbOf = (k: string) => k.replace(/(\.[^.]+)$/, '_thumb$1')

/** Bunny has no HEAD on the storage API; a ranged GET costs one byte. */
async function probe(key: string): Promise<{ ok: boolean; bytes: number | null }> {
  try {
    const r = await fetch(`${HOST}/${ZONE}/${key}`, {
      headers: { AccessKey: KEY, Range: 'bytes=0-0' },
    })
    if (!r.ok) return { ok: false, bytes: null }
    // 206 gives "bytes 0-0/12345"; a 200 gives the whole length.
    const cr = r.headers.get('content-range')
    const total = cr ? Number(cr.split('/')[1]) : Number(r.headers.get('content-length'))
    await r.arrayBuffer().catch(() => null)
    return { ok: true, bytes: Number.isFinite(total) ? total : null }
  } catch { return { ok: false, bytes: null } }
}

/** Run `jobs` with at most `n` in flight — Bunny rate-limits a flood. */
async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}

interface Row {
  id: string
  taken_utc: string | null
  bunny_storage_path: string | null
  bytes: number | null
  analysis_data: { inst?: Record<string, number | null> } | null
  sessions: { date: string } | null
}

async function main() {
  let q = sb.from('photos')
    .select('id, taken_utc, bunny_storage_path, bytes, analysis_data, sessions:sessions(date)')
    .order('taken_utc', { ascending: true })
    .limit(5000)
  const { data, error } = await q
  if (error) fail(`supabase: ${error.message}`)
  let rows = ((data || []) as unknown as Row[])
    .map(r => ({ ...r, date: r.sessions?.date || '(no session)' }))
  if (onlyDate) rows = rows.filter(r => r.date === onlyDate)
  if (!rows.length) fail('no photo rows found')

  console.error(`probing ${rows.length} photos…`)
  const res = await pool(rows, 8, async (r) => {
    if (!r.bunny_storage_path) return { orig: { ok: false, bytes: null }, thumb: { ok: false, bytes: null } }
    const [orig, thumb] = await Promise.all([
      probe(r.bunny_storage_path),
      probe(thumbOf(r.bunny_storage_path)),
    ])
    return { orig, thumb }
  })

  const merged = rows.map((r, i) => ({
    ...r,
    origOk: res[i].orig.ok,
    origBytes: res[i].orig.bytes,
    thumbOk: res[i].thumb.ok,
    hasInst: r.analysis_data?.inst?.tws != null,
  }))

  if (asCsv) {
    console.log('date,taken_utc,id,path,original_present,original_bytes,thumb_present,has_instruments')
    for (const m of merged) {
      console.log([m.date, m.taken_utc || '', m.id, m.bunny_storage_path || '',
        m.origOk ? 1 : 0, m.origBytes ?? '', m.thumbOk ? 1 : 0, m.hasInst ? 1 : 0].join(','))
    }
    return
  }

  const byDate = new Map<string, typeof merged>()
  for (const m of merged) {
    if (!byDate.has(m.date)) byDate.set(m.date, [])
    byDate.get(m.date)!.push(m)
  }

  console.log('')
  console.log('date          photos  original  thumb   instruments   median original')
  console.log('─'.repeat(74))
  let totMissing = 0
  for (const [date, ms] of Array.from(byDate).sort()) {
    const o = ms.filter(m => m.origOk).length
    const t = ms.filter(m => m.thumbOk).length
    const inst = ms.filter(m => m.hasInst).length
    const sizes = ms.filter(m => m.origOk && m.origBytes).map(m => m.origBytes!).sort((a, b) => a - b)
    const med = sizes.length ? `${(sizes[Math.floor(sizes.length / 2)] / 1e6).toFixed(1)} MB` : '—'
    totMissing += ms.length - o
    const flag = o === ms.length ? '' : '   ← ORIGINALS MISSING'
    console.log(
      `${date.padEnd(12)} ${String(ms.length).padStart(6)}  ${String(o).padStart(8)}  ${String(t).padStart(5)}  ${String(inst).padStart(11)}   ${med.padStart(9)}${flag}`)
  }
  console.log('─'.repeat(74))
  console.log(`${merged.length} photos, ${merged.length - totMissing} with an original in Bunny, ${totMissing} WITHOUT.`)

  // The small-original case: present, but it is plainly a thumbnail that was
  // uploaded to the original's key. 480 px of JPEG is ~40-80 kB; a camera
  // original off this fleet's bodies is 2-6 MB.
  const suspicious = merged.filter(m => m.origOk && m.origBytes != null && m.origBytes < 400_000)
  if (suspicious.length) {
    console.log('')
    console.log(`${suspicious.length} "originals" under 400 kB — a thumbnail written to the original's key:`)
    for (const m of suspicious.slice(0, 25)) {
      console.log(`  ${m.date}  ${m.taken_utc}  ${((m.origBytes || 0) / 1e3).toFixed(0)} kB  ${m.bunny_storage_path}`)
    }
    if (suspicious.length > 25) console.log(`  … and ${suspicious.length - 25} more`)
  }

  const missing = merged.filter(m => !m.origOk)
  if (missing.length) {
    console.log('')
    console.log('Missing originals, by capture time (this is the list to re-upload):')
    for (const m of missing.slice(0, 60)) {
      console.log(`  ${m.date}  ${m.taken_utc}  ${m.bunny_storage_path || '(no path)'}`)
    }
    if (missing.length > 60) console.log(`  … and ${missing.length - 60} more`)
  }
}

main().catch(e => fail(e?.message || String(e)))
