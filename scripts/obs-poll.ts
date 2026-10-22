// Poll the public wind-observation networks and keep our own history.
//
//   npx vite-node scripts/obs-poll.ts                 dry run — fetch, report, store nothing
//   npx vite-node scripts/obs-poll.ts -- --write      store it
//   npx vite-node scripts/obs-poll.ts -- --write --only ndbc,metar
//
// Runs on the regatta box from cron, every 15 minutes. It needs the network and
// the service key, so it never runs inside Claude Code's sandbox.
//
// WHY. The networks do not keep the same past. NDBC holds 45 days, METAR serves
// any &hours=, Météo-France 24 h — but the two that matter most keep NOTHING.
// A Davis club station and a Pioupiou beacon serve "now" and only "now", and
// those are the ones actually on the water. Without this table there is no
// trace for them at all, ever.
//
// FIFTEEN MINUTES, not five, and that is deliberate. Pioupiou's bulk feed is
// 660 KB; at five minutes that is 190 MB a day pulled off a network run by
// volunteers who bought the anemometers out of a bankruptcy. Their stations
// report every ~5 min over SIGFOX, so a 15-minute poll takes every third
// reading, which is plenty for a trace and a third of the load. NDBC is NOAA
// and 104 KB, so it would not care either way; one cadence for everything is
// simpler than one each.
//
// WHAT IS NEVER IN HERE: a boat's own instruments. Every row is somebody else's
// PUBLIC station. See the standing rule — team log data is not published, not
// to this table and not anywhere else.

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import {
  parseMetar, parseFfvl, parseNdbc, parseNdbcStations, parsePioupiou,
  parseWeatherLinkEmbed, withinNm, type WindObs,
} from '../src/lib/windObs'
import { WEATHERLINK_EMBEDS } from '../src/lib/windObsEmbeds'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const ONLY = (flag('only') || '').split(',').map((x) => x.trim()).filter(Boolean)
const RETAIN_DAYS = Number(flag('retain', '90'))

// Where we actually sail. A bulk feed hands over every station on earth, and
// storing all of them would be ~56 M rows a year to answer questions nobody
// asks. 60 nm is generous for a race area and still cuts NDBC's 865 stations
// and Pioupiou's 758 down to the hundred or so that could matter.
const VENUES: Array<[string, number, number]> = [
  ['Solent / Cowes', 50.766, -1.288],
  ['Lymington', 50.733, -1.533],
  ['St Tropez', 43.275, 6.678],
  ['Porto Cervo', 41.135, 9.538],
  ['La Spezia', 44.10, 9.83],
  ['San Juan Islands', 48.5627, -122.8946],
  ['Long Beach / San Pedro', 33.72, -118.27],
  ['Ensenada', 31.85, -116.62],
]
const VENUE_NM = 60

const env: Record<string, string> = (() => {
  const p = new URL('../.env.local', import.meta.url)
  if (!existsSync(p)) return {}
  return Object.fromEntries(
    readFileSync(p, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
  )
})()
const val = (k: string) => env[k] || process.env[k] || ''

const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const get = async (url: string, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r
}

// Rounded so the same box is asked for whichever venue is being polled.
function bbox(lat: number, lon: number, nm: number) {
  const dLat = nm / 60
  const dLon = nm / (60 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  const r = (v: number) => Math.round(v * 10) / 10
  return [r(lat - dLat), r(lon - dLon), r(lat + dLat), r(lon + dLon)]
}

const SOURCES: Array<{ name: string; run: () => Promise<WindObs[]> }> = [
  {
    name: 'ndbc',
    run: async () => {
      const [obs, stn] = await Promise.all([
        get('https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt'),
        get('https://www.ndbc.noaa.gov/data/stations/station_table.txt').catch(() => null),
      ])
      const meta = stn ? parseNdbcStations(await stn.text()) : new Map()
      return parseNdbc(await obs.text(), meta)
    },
  },
  {
    name: 'metar',
    run: async () => {
      // One box per venue rather than one huge box: a large bbox silently
      // TRUNCATES, and the cut falls at the end of the id sort order so foreign
      // stations are the ones lost. Measured 22 Oct 2026.
      const out: WindObs[] = []
      const seen = new Set<string>()
      for (const [, la, lo] of VENUES) {
        const [a, b, c, d] = bbox(la, lo, VENUE_NM)
        const r = await get(`https://aviationweather.gov/api/data/metar?bbox=${a},${b},${c},${d}&format=json`)
        for (const o of parseMetar(await r.json())) if (!seen.has(o.id)) { seen.add(o.id); out.push(o) }
      }
      return out
    },
  },
  {
    name: 'davis',
    run: async () => {
      const out: WindObs[] = []
      for (const st of WEATHERLINK_EMBEDS) {
        try {
          const r = await get(`https://www.weatherlink.com/embeddablePage/summaryData/${encodeURIComponent(st.uuid)}`)
          const o = parseWeatherLinkEmbed(await r.json(), st)
          if (o) out.push(o)
        } catch { /* one club's station down must not stop the coast */ }
      }
      return out
    },
  },
  {
    name: 'pioupiou',
    run: async () => parsePioupiou(await (await get('https://api.pioupiou.fr/v1/live-with-meta/all')).json()),
  },
  {
    name: 'ffvl',
    run: async () => {
      const key = val('FFVL_API_KEY')
      if (!key) { console.log('    (no FFVL_API_KEY — skipped)'); return [] }
      const q = (r: string) => `https://data.ffvl.fr/api/?base=balises&r=${r}&mode=json&key=${encodeURIComponent(key)}`
      const [rel, bal] = await Promise.all([get(q('releves')), get(q('list')).catch(() => null)])
      return parseFfvl(await rel.json(), bal ? await bal.json() : [])
    },
  },
]

/** Keep only what is near somewhere we sail. */
function nearAnyVenue(obs: WindObs[]): WindObs[] {
  const keep = new Map<string, WindObs>()
  for (const [, la, lo] of VENUES) for (const o of withinNm(obs, la, lo, VENUE_NM)) keep.set(o.id, o)
  return Array.from(keep.values())
}

async function main() {
  const url = val('NEXT_PUBLIC_SUPABASE_URL')
  const svc = val('SUPABASE_SERVICE_ROLE_KEY')
  if (WRITE && (!url || !svc)) {
    console.error('Supabase URL / service key missing in .env.local — cannot --write.'); process.exit(1)
  }

  const all: WindObs[] = []
  for (const s of SOURCES) {
    if (ONLY.length && !ONLY.includes(s.name)) continue
    const t0 = Date.now()
    try {
      const got = await s.run()
      const near = nearAnyVenue(got)
      all.push(...near)
      console.log(`  ${s.name.padEnd(9)} ${String(got.length).padStart(5)} station(s) -> ${String(near.length).padStart(4)} near a venue  (${Date.now() - t0} ms)`)
    } catch (e) {
      // One network down is not a failed run: the others still have something
      // to say, and a gap in one trace beats a gap in all of them.
      console.log(`  ${s.name.padEnd(9)} FAILED: ${(e as Error).message}`)
    }
  }

  // Two stations can never share an id; the same station twice in one run is a
  // bug upstream, and the newest wins.
  const byKey = new Map<string, WindObs>()
  for (const o of all) {
    const k = `${o.id}|${o.t}`
    const prev = byKey.get(k)
    if (!prev || Date.parse(o.t) > Date.parse(prev.t)) byKey.set(k, o)
  }
  const rows = Array.from(byKey.values()).map((o) => ({
    station_id: o.id, t: o.t, source: o.source, name: o.name,
    lat: o.lat, lon: o.lon, tws_kn: o.twsKn, gust_kn: o.gustKn,
    twd_deg: o.twdDeg, height_m: o.heightM, surface: o.surface, trust: o.trust,
  }))

  const fresh = rows.filter((r) => Date.now() - Date.parse(r.t) < 6 * 3600_000).length
  console.log(`\n  ${rows.length} row(s), ${fresh} of them under 6 h old`)
  const byVenue = VENUES.map(([n, la, lo]) =>
    `${n}: ${withinNm(Array.from(byKey.values()), la, lo, VENUE_NM).length}`).join('  |  ')
  console.log(`  ${byVenue}`)

  if (!WRITE) { console.log('\n  DRY RUN — nothing stored. Add --write.'); return }

  const sb = createClient(url, svc, { auth: { persistSession: false } })
  let stored = 0
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    // (station_id, t) is the key, so re-polling the same reading updates in
    // place instead of growing the table.
    const { error } = await sb.from('wind_observations').upsert(chunk, { onConflict: 'station_id,t' })
    if (error) { console.error(`  upsert failed: ${error.message}`); process.exit(1) }
    stored += chunk.length
  }
  console.log(`  stored ${stored} row(s)`)

  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400_000).toISOString()
  const { error: delErr, count } = await sb.from('wind_observations')
    .delete({ count: 'exact' }).lt('t', cutoff)
  if (delErr) console.error(`  retention sweep failed: ${delErr.message}`)
  else console.log(`  retention: removed ${count ?? 0} row(s) older than ${RETAIN_DAYS} days`)
}

main().catch((e) => { console.error(e); process.exit(1) })
