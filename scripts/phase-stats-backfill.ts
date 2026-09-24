// scripts/phase-stats-backfill.ts
// ─────────────────────────────────────────────────────────────────────────────
// Recompute stored phase stats — for days behind STATS_VERSION, or days missing a
// channel that has since been added.
//
//   npm run stats:backfill                            what is stale, change nothing
//   npm run stats:backfill -- --missing toeIn         days with no toe-in yet
//   npm run stats:backfill -- --missing toeIn --write and store it
//   npm run stats:backfill -- --write --boat <id> --from 2026-07-01
//
// WHY IT EXISTS. Adding a channel to CHANNELS does not change any stored number, so
// STATS_VERSION deliberately does NOT move for it — see the note there. What it does
// leave behind is rows without the new key, and `--missing` is how they are filled.
//
// IT WILL NOT FILL THEM ALL, and that is not a bug to fix here. Of the 33 days stored
// on 24 Sep 2026 it could rebuild 13: five hold stats computed from a ~1 s device log
// that the ~2-6 s cloud copy must not overwrite, and eight have no event-file phases
// in the cloud session. Those days need whoever holds the original file to open them
// in Analytics. The query tools report the coverage rather than averaging over
// whichever days happen to have the channel.
//
// TWO THINGS IT IS CAREFUL ABOUT, both of which the API route also handles and
// which a naive rewrite would silently destroy:
//
//   • LIDAR. Sail-shape means arrive from a separate start-window log via
//     `npm run lidar:import`, and are not in the session's own rows. carryLidar()
//     moves them onto the rebuilt phases. Without it this script would wipe the
//     lidar off every day it touched, and the lidar tables are the ones validated
//     against the KND report.
//   • HEADLINES. The route clears them on recompute, because they were written
//     from numbers that just changed. This script keeps them, and it is right to,
//     ONLY while a bump adds a channel without altering any existing value —
//     which is what 3 → 4 did. If a future bump changes a number, pass
//     --clear-headlines, or the crew will be reading sentences about arithmetic
//     that no longer holds.
//
// It computes from the CLOUD log (~6 s a row), which is coarser than the ~1 s log a
// device holds. shouldReplace() is what the route uses to avoid overwriting finer
// stats with coarser ones; the same guard is applied here, and a day whose stored
// stats are finer is reported and left alone.
//
// Needs .env.local and network, so it runs outside Claude Code's sandbox.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'
import { computePhaseStats } from '../src/lib/phaseStats'
import { analyseManoeuvres } from '../src/lib/manoeuvres'
import { compactPhases, compactManoeuvres, STATS_VERSION, type StoredPhase } from '../src/lib/seasonCurves'
import { carryLidar } from '../src/lib/lidarMerge'
import { polarFromData } from '../src/lib/polarFile'

const has = (f: string) => process.argv.includes(`--${f}`)
const arg = (f: string) => {
  const i = process.argv.indexOf(`--${f}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const fail = (m: string): never => { console.error(m); process.exit(1) }

const WRITE = has('write')
const CLEAR_HEADLINES = has('clear-headlines')
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !SERVICE) fail('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — is .env.local loaded?')
const sb = createClient(URL!, SERVICE!, { auth: { persistSession: false } })

/** The cloud log's row spacing, the same way the API route measures it. */
function medianInterval(rows: { utc: number }[]): number | null {
  if (rows.length < 3) return null
  const gaps: number[] = []
  for (let i = 1; i < rows.length; i++) {
    const g = rows[i].utc - rows[i - 1].utc
    if (g > 0) gaps.push(g)
  }
  if (!gaps.length) return null
  gaps.sort((a, b) => a - b)
  return gaps[gaps.length >> 1] / 1000
}

async function main() {
  const boatFilter = arg('boat')
  const from = arg('from')
  const to = arg('to')
  const missing = arg('missing')

  let q = sb.from('session_phase_stats')
    .select('id, team_id, boat_id, session_id, date, stats_version, polar_id, resolution_s, phases')
    .order('date')
  if (boatFilter) q = q.eq('boat_id', boatFilter)
  if (from) q = q.gte('date', from)
  if (to) q = q.lte('date', to)
  const { data: stored, error } = await q
  if (error) fail(`reading stored stats: ${error.message}`)

  const rows = (stored || []) as {
    id: string; team_id: string; boat_id: string; session_id: string | null; date: string
    stats_version: number; polar_id: string | null; resolution_s: number | null; phases: StoredPhase[]
  }[]
  if (!rows.length) fail('no stored phase stats match that filter')

  // The active polar per boat, once — it is what VMG% and %Pol are computed against.
  const boats = Array.from(new Set(rows.map(r => `${r.team_id}|${r.boat_id}`)))
  const polars = new Map<string, { id: string | null; name: string | null; data: unknown }>()
  for (const key of boats) {
    const [teamId, boatId] = key.split('|')
    const { data } = await sb.from('polars').select('id, name, data')
      .eq('team_id', teamId).eq('boat_id', boatId).eq('is_active', true).maybeSingle()
    polars.set(key, { id: data?.id ?? null, name: data?.name ?? null, data: data?.data ?? null })
  }

  // A row needs rebuilding when the maths moved on (version) or when a channel it
  // never had has since been added (--missing). The second is the common case.
  const lacks = (r: { phases: StoredPhase[] }) =>
    !!missing && !(r.phases || []).some(p => p.v?.[missing] != null)
  const stale = rows.filter(r => r.stats_version !== STATS_VERSION || lacks(r))
  console.log(`${rows.length} stored days · ${stale.length} to rebuild`
    + `${missing ? ` (behind version, or without "${missing}")` : ` (behind STATS_VERSION ${STATS_VERSION})`}`
    + `${WRITE ? '' : '  (dry run — pass --write to store)'}\n`)
  if (!stale.length) { console.log('nothing to do'); return }

  let done = 0, skipped = 0, failed = 0
  for (const r of stale) {
    const key = `${r.team_id}|${r.boat_id}`
    const polar = polars.get(key)!
    const { data: session, error: sErr } = await sb.from('sessions')
      .select('id, log_data, xml_data, updated_at')
      .eq('team_id', r.team_id).eq('boat_id', r.boat_id).eq('date', r.date).maybeSingle()
    if (sErr || !session) {
      console.log(`  ✗ ${r.date}  no session to recompute from`)
      failed++; continue
    }
    const logRows = ((session.log_data as { rows?: unknown[] } | null)?.rows || []) as { utc: number }[]
    if (!logRows.length) {
      console.log(`  – ${r.date}  no cloud log on the session; leave it for whoever holds the file`)
      skipped++; continue
    }
    const resolution = medianInterval(logRows)
    // Never replace finer stats with the coarser cloud copy. A device that computed
    // from its ~1 s log holds better numbers than this script can produce.
    if (r.resolution_s != null && resolution != null && resolution > r.resolution_s + 0.5) {
      console.log(`  – ${r.date}  stored stats are finer (${r.resolution_s}s vs ${resolution.toFixed(1)}s cloud) — left alone`)
      skipped++; continue
    }

    const stats = computePhaseStats(logRows as never, session.xml_data, { polar: polarFromData(polar.data) })
    if (!stats.length) {
      console.log(`  ✗ ${r.date}  recomputed to zero phases — not overwriting ${r.phases?.length ?? 0}`)
      failed++; continue
    }
    // The lidar means came from another log and are not in these rows.
    const phases = carryLidar(compactPhases(stats), r.phases ?? null)
    const filled = missing ? phases.filter((p: StoredPhase) => p.v?.[missing] != null).length : phases.length
    const note = missing ? `${filled} with ${missing}` : `${phases.length} phases`

    if (!WRITE) {
      console.log(`  · ${r.date}  ${stats.length} phases, ${note}`)
      done++; continue
    }
    const patch: Record<string, unknown> = {
      phases,
      manoeuvres: compactManoeuvres(analyseManoeuvres(logRows as never, session.xml_data)),
      phase_count: stats.length,
      log_rows: logRows.length,
      resolution_s: resolution,
      stats_version: STATS_VERSION,
      polar_id: polar.id,
      polar_name: polar.name,
      computed_at: new Date().toISOString(),
    }
    // Kept by default — see the header. A bump that ADDS a channel leaves every
    // sentence in the headlines still true.
    if (CLEAR_HEADLINES) Object.assign(patch, { headlines: null, headlines_model: null, headlines_at: null })

    const { error: upErr } = await sb.from('session_phase_stats').update(patch).eq('id', r.id)
    if (upErr) {
      console.log(`  ✗ ${r.date}  ${upErr.message}`)
      failed++; continue
    }
    console.log(`  ✓ ${r.date}  ${stats.length} phases, ${note}`)
    done++
  }

  console.log(`\n${WRITE ? 'rebuilt' : 'would rebuild'} ${done} · skipped ${skipped} · failed ${failed}`)
  if (skipped || failed) {
    console.log('Days left behind keep every number they had; they are missing the new channel only.')
    console.log('To fill them, open each in Analytics on the machine holding its full-resolution log.')
  }
}

main().catch(e => fail(String(e?.stack || e)))
