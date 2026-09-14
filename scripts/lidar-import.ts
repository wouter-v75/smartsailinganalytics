// Bulk-add lidar from a folder of lidar logs to the cloud stats of a boat.
//
//   npx vite-node scripts/lidar-import.ts ~/Downloads/Logs [more folders or .csv files]   dry run
//   … --write                                                                              store it
//   … --boat <boat id>                                    when the boat name match is ambiguous
//
// Each log (the Expedition flat export with MN_/JIB_/SPI_ CA/DR/TW columns, any rate) is split
// into the day's event-file phases (from the session in the cloud). Phases lying wholly inside
// one recording burst of the log (the start logs record ~5 min around each start, with gaps in
// between) get their lidar means (KND caps, ≥ 5 samples) merged into that day's stored phase
// stats (session_phase_stats) — everything else in the stored stats is left as it is, so a
// start log adds lidar to the minutes it covers and never replaces the day's full stats.
// A day with no stored phases (no log in the cloud) takes the log's own phases, stored without a
// resolution so that the day's full log replaces them when it is imported (keeping the lidar).
// Analytics and the stats route keep the lidar from then on (src/lib/lidarMerge.ts).
//
// Uses the service key from .env.local. Writes nothing without --write.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { createClient } from '@supabase/supabase-js'
import { parseLog } from '../src/lib/logParse'
import { computePhaseStats } from '../src/lib/phaseStats'
import { analyseManoeuvres } from '../src/lib/manoeuvres'
import { polarFromData } from '../src/lib/polarFile'
import { STATS_VERSION, compactPhases, compactManoeuvres, medianInterval, type StoredPhase } from '../src/lib/seasonCurves'
import { addLidar } from '../src/lib/lidarMerge'
import { logRateHz, lidarSailsIn } from '../src/lib/logResolution'

const args = process.argv.slice(2)
const write = args.includes('--write')
const boatArg = args.includes('--boat') ? args[args.indexOf('--boat') + 1] : null
const pathArgs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--boat')
if (!pathArgs.length) { console.error('usage: vite-node scripts/lidar-import.ts <folder|file.csv>… [--write] [--boat <id>]'); process.exit(1) }
const inputFiles = pathArgs.flatMap(a => {
  const p = resolve(a.replace(/^~(?=\/|$)/, homedir()))
  if (!statSync(p).isDirectory()) return [p]
  return readdirSync(p).filter(f => /\.csv$/i.test(f) && statSync(join(p, f)).isFile()).sort().map(f => join(p, f))
})

// Recording bursts: stretches of rows no more than 5 s apart.
const burstsOf = (rows: { utc: number }[]): [number, number][] => {
  const out: [number, number][] = []
  let start = 0
  for (let i = 1; i <= rows.length; i++) {
    if (i === rows.length || rows[i].utc - rows[i - 1].utc > 5000) { out.push([rows[start].utc, rows[i - 1].utc]); start = i }
  }
  return out
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => /^[A-Z0-9_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('Supabase URL / service key missing in .env.local'); process.exit(1) }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const hm = (utc: number) => new Date(utc).toISOString().slice(11, 16)
const fail = (msg: string) => { console.error(msg); process.exit(1) }

async function main() {
  // ── Boat ──────────────────────────────────────────────────────────────────
  const { data: boats, error: boatErr } = await sb.from('boats').select('id, name, team_id')
  if (boatErr) fail(`boats: ${boatErr.message}`)
  const matches = boatArg ? boats!.filter(b => b.id === boatArg) : boats!.filter(b => /northstar\s*76|\bns\s*76\b|\b76\b/i.test(b.name || ''))
  if (matches.length !== 1) {
    fail(`${matches.length ? 'More than one' : 'No'} boat matches — pass --boat <id>:\n  ${boats!.map(b => `${b.id}  ${b.name}`).join('\n  ')}`)
  }
  const boat = matches[0]
  const { data: polarRow } = await sb.from('polars').select('id, name, data').eq('boat_id', boat.id).eq('is_active', true).maybeSingle()
  const polar = polarFromData(polarRow?.data)
  console.log(`Boat ${boat.name} (${boat.id}) · polar ${polarRow?.name || 'none'} · ${write ? 'WRITING' : 'dry run — nothing is written'}\n`)

  if (!inputFiles.length) fail('No .csv files found')

  let written = 0
  for (const file of inputFiles) {
    const p = parseLog(readFileSync(file, 'utf8'))
    const rows = p.rows
    const tag = file.replace(homedir(), '~')
    if (!rows.length) { console.log(`✕ ${tag}: no rows read (format ${p.format})`); continue }
    const sails = lidarSailsIn(rows).map(s => s.label)
    const t0 = rows[0].utc, t1 = rows[rows.length - 1].utc
    const date = new Date(t0).toISOString().slice(0, 10)
    const head = `${tag}\n  ${date} ${hm(t0)}–${hm(t1)}Z · ${rows.length.toLocaleString()} rows · ${logRateHz(rows)} Hz · lidar ${sails.join('/') || 'none'}`
    if (!sails.length) { console.log(`${head}\n  ✕ no lidar columns — skipped\n`); continue }

    const { data: session, error: sErr } = await sb.from('sessions').select('id, team_id, xml_data').eq('boat_id', boat.id).eq('date', date).maybeSingle()
    if (sErr) { console.log(`${head}\n  ✕ session: ${sErr.message}\n`); continue }
    const xml = session?.xml_data as any
    if (!session || !xml?.phases?.length) { console.log(`${head}\n  ✕ no session with an event file for ${date} in the cloud — skipped\n`); continue }

    // Lidar means for the phases wholly inside one recording burst (a 4 Hz row every 250 ms,
    // so allow half a second at either end).
    const bursts = burstsOf(rows)
    const inside = computePhaseStats(rows, xml, { polar })
      .filter(s => bursts.some(([a, b]) => s.utc >= a - 500 && s.endUtc <= b + 500))
    const lidar = compactPhases(inside)

    const { data: stored, error: stErr } = await sb.from('session_phase_stats').select('id, phases, resolution_s, phase_count').eq('boat_id', boat.id).eq('date', date).maybeSingle()
    if (stErr) { console.log(`${head}\n  ✕ stored stats: ${stErr.message}\n`); continue }

    let base: StoredPhase[]
    let insertRow: Record<string, unknown> | null = null
    if (stored) {
      base = (stored.phases || []) as StoredPhase[]
    } else {
      // No stats stored for the day yet: compute them from the cloud log, as the app would.
      const { data: withLog } = await sb.from('sessions').select('log_data').eq('id', session.id).maybeSingle()
      const cloudRows = ((withLog?.log_data as any)?.rows || []) as any[]
      const dayStats = computePhaseStats(cloudRows, xml, { polar })
      base = compactPhases(dayStats)
      insertRow = {
        team_id: session.team_id, boat_id: boat.id, session_id: session.id, date,
        stats_version: STATS_VERSION, polar_id: polarRow?.id ?? null, polar_name: polarRow?.name ?? null,
        log_rows: cloudRows.length, resolution_s: medianInterval(cloudRows), phase_count: base.length,
        manoeuvres: compactManoeuvres(analyseManoeuvres(cloudRows, xml)),
        computed_at: new Date().toISOString(),
      }
    }
    const withLidar = lidar.filter(ph => Object.keys(ph.v).some(k => /^(mn|jib|spi)(Ca|Dr|Tw)\d+$/.test(k))).length
    // No phases for the day at all (no log in the cloud): the lidar log's own phases are all there is.
    // Stored without a resolution, so the day's full log replaces them when it arrives (lidar kept).
    const ownPhases = !base.length && withLidar > 0
    const { phases, merged } = ownPhases ? { phases: lidar, merged: withLidar } : addLidar(base, lidar)
    const dayNote = stored ? `${base.length} stored phases (${stored.resolution_s ?? 'no'} s log)` : `no stored stats — ${base.length} phases from the cloud log`
    console.log(`${head} · ${bursts.length} burst${bursts.length === 1 ? '' : 's'}\n  day: ${dayNote}` +
      ` · ${inside.length} phases inside a burst, ${withLidar} with lidar → ${ownPhases ? `${merged} phases stored from this log (the day has none)` : `${merged} merged`}`)

    if (!write || !merged) { console.log(''); continue }
    const own = ownPhases ? { phase_count: phases.length, log_rows: rows.length, resolution_s: null } : {}
    const res = insertRow
      ? await sb.from('session_phase_stats').insert({ ...insertRow, ...own, phases })
      : await sb.from('session_phase_stats').update({ ...own, phases }).eq('id', stored!.id)
    if (res.error) console.log(`  ✕ write failed: ${res.error.message}\n`)
    else { written++; console.log(`  ✓ stored\n`) }
  }
  if (write) console.log(`${written} day(s) updated.`)
}

main().catch(e => fail(String(e?.stack || e)))
