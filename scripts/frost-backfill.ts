// Backfill MET Norway's Frost wind history into wind_observations.
//
//   npx vite-node scripts/frost-backfill.ts                      # dry run, 3 years
//   npx vite-node scripts/frost-backfill.ts -- --write
//   npx vite-node scripts/frost-backfill.ts -- --from 1994-01-01 --write
//   npx vite-node scripts/frost-backfill.ts -- --station SN27500 --write
//   npx vite-node scripts/frost-backfill.ts -- --all --write      # probation sites too
//
// WHY. The poller only ever stores "now", so a station's trace begins the day
// someone adds it. Frost is the one source here that serves deep history —
// Strømtangen and Jomfruland hourly back to 1994, Færder to 1999 — and those
// rows are the MOS training set, which is the thing the table exists for. A
// backfill buys thirty years of it for seven stations in a few minutes.
//
// FIT TIER ONLY, by default. `fit` is the permission to be fitted against, so
// those are the stations worth years of rows. The inland Frost sites are
// probation and are only fetched with --all. (Of the 23 in FROST_SITES, seven
// are fit: the lighthouses and islands.)
//
// ARCHIVE ROWS ARE EXEMPT FROM RETENTION, and this is not optional. The poller
// deletes anything older than RETAIN_DAYS on every run, which is right for a
// rolling record and fatal for an import: without archive=TRUE the next poll
// wipes everything older than three years within half an hour, and the import
// looks like it worked. Migration 0103 added the column; the sweep in
// src/app/api/obs/poll/route.ts filters on it.
//
// validated=TRUE here, unlike the ISPRA import's FALSE. Frost publishes a
// qualityCode per reading and parseFrostObs keeps only code 0, which Frost
// documents as the value being correct. ISPRA's real-time series is level L0,
// explicitly unvalidated. Those are different quantities and the column is
// what stops them being averaged together.
//
// ONE RESOLUTION PER STATION, chosen by asking. Requesting both PT1H and PT10M
// would return two different readings for the same instant — an hourly value
// and a ten-minute one — which upsert would collapse into whichever arrived
// last. So each station is resolved to a single series first:
//
//   - PT1H where it exists. It is both the deeper record (1994-2000 against
//     2014-2025 for PT10M) and what MOS actually needs, since the models are
//     hourly.
//   - PT10M sampled ON THE HOUR otherwise. Larvik - Fugløya has no PT1H at
//     all, so without this fallback it would silently return nothing — the
//     exact failure this project keeps paying for.
//
// It prints the chosen series and the record count per station, because a
// station contributing zero rows must be visible rather than inferred.

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { FROST_SITES, obsRow, nmToNearestVenue } from '../src/lib/obsSources'
import { parseFrostObs, type WindObs } from '../src/lib/windObs'
import { tierFor } from '../src/lib/obsTier'
import { monthSpans, onTheHour } from '../src/lib/frostBackfill'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const ALL = argv.includes('--all')
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const env: Record<string, string> = (() => {
  const p = new URL('../.env.local', import.meta.url)
  if (!existsSync(p)) return {}
  return Object.fromEntries(
    readFileSync(p, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
  )
})()

// Three years by default: it matches the mental model of the rolling record
// these rows sit beside, and it is about 184k rows for the fit set. The full
// series is roughly 1.3M rows — fine against the table's budget, but that is a
// storage decision, so it is a flag rather than the default.
const DEFAULT_YEARS = 3
const FROM = flag('from') || new Date(Date.now() - DEFAULT_YEARS * 365.25 * 86400_000).toISOString().slice(0, 10)
const TO = flag('to') || new Date().toISOString().slice(0, 10)
const ONLY = flag('station', '')!
const CLIENT = env.FROST_CLIENT_ID || process.env.FROST_CLIENT_ID
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const ELEMENTS = 'wind_speed,wind_from_direction,max(wind_speed_of_gust PT1H)'

if (!CLIENT) {
  console.error('No FROST_CLIENT_ID in .env.local — frost.met.no/auth/requestCredentials.html')
  process.exit(1)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
  console.error('--from and --to want YYYY-MM-DD')
  process.exit(1)
}

const auth = `Basic ${Buffer.from(`${CLIENT}:`).toString('base64')}`

async function frost(path: string): Promise<any> {
  const r = await fetch(`https://frost.met.no${path}`, {
    headers: { Authorization: auth, accept: 'application/json', 'User-Agent': UA },
  })
  const body = await r.text()
  // Frost 404s a query that matches nothing, which is not an error here: a
  // station with no readings in one month is an ordinary gap.
  if (r.status === 404) return { data: [] }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`)
  return JSON.parse(body)
}

interface Plan {
  id: string
  name: string
  res: 'PT1H' | 'PT10M'
  /** Earliest reading of the chosen series, so a month before it is not asked for. */
  since: string
}

/**
 * Resolve each station to ONE series, and say which.
 *
 * Asking is the whole point. Larvik - Fugløya has PT10M only, and Nordkoster
 * has three days of record because Frost began serving it on 23 Oct 2026 —
 * neither is visible from a station list, and both would otherwise show up as
 * a station that contributed nothing for no stated reason.
 */
async function planStations(sites: typeof FROST_SITES): Promise<{ plans: Plan[]; skipped: string[] }> {
  const plans: Plan[] = []
  const skipped: string[] = []
  for (let i = 0; i < sites.length; i += 20) {
    const chunk = sites.slice(i, i + 20)
    const ts = await frost('/observations/availableTimeSeries/v0.jsonld'
      + `?sources=${chunk.map((s) => s.id).join(',')}&elements=${encodeURIComponent('wind_speed')}`)
    const by = new Map<string, Array<{ res: string; from: string }>>()
    for (const t of ts.data || []) {
      const sid = String(t.sourceId || '').split(':')[0]
      if (!sid) continue
      const a = by.get(sid) || []
      a.push({ res: String(t.timeResolution), from: String(t.validFrom || '').slice(0, 10) })
      by.set(sid, a)
    }
    for (const s of chunk) {
      const have = by.get(s.id) || []
      const hourly = have.find((x) => x.res === 'PT1H')
      const tenMin = have.find((x) => x.res === 'PT10M')
      const pick = hourly || tenMin
      if (!pick) { skipped.push(`${s.id} ${s.name} — no PT1H or PT10M wind_speed`); continue }
      plans.push({ id: s.id, name: s.name, res: pick === hourly ? 'PT1H' : 'PT10M', since: pick.from })
    }
  }
  return { plans, skipped }
}

async function main() {
  const chosen = FROST_SITES.filter((s) => {
    if (ONLY) return s.id === ONLY
    return ALL || tierFor({ id: `frost:${s.id}`, source: 'synop' } as WindObs).mayFit
  })
  if (!chosen.length) {
    console.error(ONLY ? `No station ${ONLY} in FROST_SITES.` : 'No stations selected.')
    process.exit(1)
  }

  console.log(`\nFrost backfill — ${FROM} to ${TO}`)
  console.log(`${chosen.length} station(s)${ONLY ? '' : ALL ? ' (all tiers)' : ' (fit tier only; --all for the rest)'}\n`)

  const { plans, skipped } = await planStations(chosen)
  for (const p of plans) {
    const nm = nmToNearestVenue(
      FROST_SITES.find((s) => s.id === p.id)!.lat,
      FROST_SITES.find((s) => s.id === p.id)!.lon,
    )
    const late = p.since > FROM ? `  (record starts ${p.since})` : ''
    console.log(`  ${p.id.padEnd(9)} ${p.name.padEnd(22)} ${p.res.padEnd(6)} ${nm.toFixed(1).padStart(5)} nm${late}`)
  }
  for (const s of skipped) console.log(`  SKIP  ${s}`)

  const spans = monthSpans(FROM, TO)
  console.log(`\n${spans.length} month(s) per station.`)

  if (!WRITE) {
    console.log('\n(dry run — add --write to fetch and store)')
    console.log('A PT1H station yields ~730 rows a month; the fit set over 3 years is ~184k rows.')
    console.log('--from 1994-01-01 takes the whole record, roughly 1.3M rows.')
    return
  }

  const url = env.NEXT_PUBLIC_SUPABASE_URL || ''
  const svc = env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !svc) {
    console.error('\nNEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env.local')
    process.exit(1)
  }
  const sb = createClient(url, svc, { auth: { persistSession: false } })

  const sites = new Map(FROST_SITES.map((f) => [f.id, f]))
  let stored = 0
  const perStation = new Map<string, number>()

  for (const p of plans) {
    // Do not ask for months before the series began: Frost 404s them, which is
    // handled, but it is thirty wasted requests for a station added last year.
    const start = p.since > FROM ? p.since : FROM
    const mine = monthSpans(start, TO)
    for (let i = 0; i < mine.length; i++) {
      const [a, b] = mine[i]
      let payload: any
      try {
        payload = await frost(`/observations/v0.jsonld?sources=${p.id}`
          + `&elements=${encodeURIComponent(ELEMENTS)}`
          + `&referencetime=${encodeURIComponent(`${a}/${b}`)}`
          + `&timeresolutions=${p.res}`)
      } catch (e) {
        console.log(`\n  ${p.id} ${a.slice(0, 7)}: ${(e as Error).message}`)
        continue
      }
      let obs = parseFrostObs(payload, sites)
      if (p.res === 'PT10M') obs = onTheHour(obs)
      if (!obs.length) continue

      const batch = obs.map((o) => ({ ...obsRow(o), archive: true, validated: true }))
      for (let k = 0; k < batch.length; k += 1000) {
        const chunk = batch.slice(k, k + 1000)
        const { error } = await sb.from('wind_observations').upsert(chunk, { onConflict: 'station_id,t' })
        if (error) {
          console.error(`\nupsert failed on ${p.id} ${a.slice(0, 7)}: ${error.message}`)
          if (/archive|validated/.test(error.message)) {
            console.error('Paste supabase/migrations/0103_wind_observations_archive.sql first.')
          }
          process.exit(1)
        }
        stored += chunk.length
      }
      perStation.set(p.id, (perStation.get(p.id) ?? 0) + obs.length)
      process.stdout.write(`\r  ${p.id} ${p.name.slice(0, 18).padEnd(18)} `
        + `${a.slice(0, 7)}  [${i + 1}/${mine.length}]  ${stored.toLocaleString('en-GB')} stored     `)
    }
    process.stdout.write('\n')
  }

  console.log(`\n${stored.toLocaleString('en-GB')} row(s) stored.\n`)
  for (const p of plans) {
    const n = perStation.get(p.id) ?? 0
    console.log(`  ${p.id.padEnd(9)} ${p.name.padEnd(22)} ${p.res.padEnd(6)} ${n.toLocaleString('en-GB').padStart(9)} rows`
      + (n === 0 ? '   ← contributed NOTHING' : ''))
  }
  console.log('\nAll marked archive=true, so the poller\'s retention sweep will not prune them,')
  console.log('and validated=true, because Frost states a qualityCode and only code 0 is kept.')
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
