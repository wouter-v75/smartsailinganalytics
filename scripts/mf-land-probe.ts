// Does Météo-France's LAND network answer, and is Cap Camarat in it?
//
//   npx vite-node scripts/mf-land-probe.ts
//   npx vite-node scripts/mf-land-probe.ts -- --lat 43.266897 --lon 6.698371 --probe 8
//   npx vite-node scripts/mf-land-probe.ts -- --id 83101001        just that station
//
// Read-only. Nothing to --write.
//
// WHY IT EXISTS. SSA called Météo-France for buoys and ships only, so at a
// French venue it drew American buoys, amateur Davis gardens and nothing from
// the national network. parseMfLand and the mf-land source were written to fix
// that — but they were written WITHOUT ever being run against the land
// endpoint, because the sandbox this was built in has no network. They reuse
// MF_KEYS (`ff` m/s, `dd` degrees, `fxi`/`fx` gust) on the grounds that the
// marine feeds use the same vocabulary, which is an inference, not a
// measurement.
//
// SO READ THE HEADER LINES BELOW FIRST. If `ff` and `dd` are not there, the
// adapter is returning nothing and that is WHY — it refuses rather than
// guessing, which is the right failure but a silent one.
//
// THE CAP CAMARAT QUESTION. Météo-France has a climatological sheet for
// station 83101001 "CAP CAMARAT" at 107 m, and Windfinder says a station once
// existed at that spot but no longer reports. Whether it is still in the LIVE
// network is the thing this settles: if 83101001 is in /liste-stations and
// /station/infrahoraire-6m returns a `ff` for it, SSA can have it. If not,
// there is no live public wind observation at Cap Camarat and the nearest
// alternatives printed below are the honest answer.

import { readFileSync, existsSync } from 'node:fs'
import { parseMfCsv, parseMfStationList, parseMfLand } from '../src/lib/windObs'
import { nmBetween, gradedPick, bandCounts } from '../src/lib/obsDensity'

const argv = process.argv.slice(2)
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

// The middle of the Golfe de Saint-Tropez.
const lat = Number(flag('lat', '43.266897'))
const lon = Number(flag('lon', '6.698371'))
const PROBE = Number(flag('probe', '10'))
const ONLY = flag('id')

const envPath = new URL('../.env.local', import.meta.url)
const env: Record<string, string> = existsSync(envPath)
  ? Object.fromEntries(
      readFileSync(envPath, 'utf8')
        .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
    )
  : {}

const KEY = flag('key') || env.METEOFRANCE_API_KEY || process.env.METEOFRANCE_API_KEY
if (!KEY) {
  console.error('No key. Put METEOFRANCE_API_KEY in .env.local, or pass --key <value>.')
  process.exit(1)
}

const BASE = flag('base', 'https://public-api.meteofrance.fr/public/DPObs/v2')!
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'

async function get(path: string): Promise<string> {
  const r = await fetch(`${BASE}${path}`, { headers: { apikey: KEY!, 'User-Agent': UA } })
  const body = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status} ${body.slice(0, 200)}`)
  return body
}

async function main() {
  process.stdout.write('/liste-stations … ')
  const csv = await get('/liste-stations?format=csv')
  const header = csv.split(/\r?\n/)[0]
  const meta = parseMfStationList(csv)
  console.log(`${meta.size} stations`)
  console.log(`  header: ${header}`)

  const placed = Array.from(meta.entries())
    .filter(([, m]) => Number.isFinite(m.lat) && Number.isFinite(m.lon))
    .map(([id, m]) => ({ id, name: m.name || '', lat: m.lat as number, lon: m.lon as number, alt: m.alt }))
  console.log(`  ${placed.length} with a position`)
  if (placed.length !== meta.size) {
    console.log('  ^ positions missing for some: check the header above for the lat/lon column names.')
  }

  // Cap Camarat, by id and by name.
  const byId = meta.get('83101001')
  const byName = placed.filter((s) => /camarat/i.test(s.name))
  console.log(`\nCAP CAMARAT`)
  console.log(`  id 83101001 in the list: ${byId ? `YES — ${byId.name} (${byId.lat}, ${byId.lon}, ${byId.alt ?? '?'} m)` : 'no'}`)
  console.log(`  anything named /camarat/i: ${byName.length ? byName.map((s) => `${s.id} ${s.name}`).join(', ') : 'none'}`)

  const near = placed
    .map((s) => ({ ...s, d: nmBetween(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d)
  console.log(`\nAVAILABLE around ${lat}, ${lon}: ${JSON.stringify(bandCounts(placed, lat, lon))}`)
  const picked = gradedPick(placed, lat, lon)
  console.log(`GRADED PICK keeps ${picked.length}: ${JSON.stringify(bandCounts(picked, lat, lon))}`)

  const targets = ONLY
    ? near.filter((s) => s.id === ONLY)
    : [...(byId ? near.filter((s) => s.id === '83101001') : []), ...near.filter((s) => s.id !== '83101001')].slice(0, PROBE)

  console.log(`\nProbing ${targets.length} station(s) with /station/infrahoraire-6m:`)
  let first = true
  for (const s of targets) {
    try {
      const body = await get(`/station/infrahoraire-6m?id_station=${encodeURIComponent(s.id)}&format=csv`)
      if (first) {
        // THE LINE THAT MATTERS. Everything else is downstream of these names.
        console.log(`  observation header: ${body.split(/\r?\n/)[0]}`)
        first = false
      }
      const rows = parseMfCsv(body)
      const obs = parseMfLand(rows, meta)
      if (!obs.length) {
        console.log(`  ${s.d.toFixed(1).padStart(5)} nm  ${s.id}  ${(s.name || '').padEnd(28)} rows=${rows.length} but NO WIND PARSED`)
        if (rows.length) console.log(`        keys present: ${Object.keys(rows[rows.length - 1]).join(',')}`)
        continue
      }
      const o = obs[obs.length - 1]
      const ageMin = Math.round((Date.now() - Date.parse(o.t)) / 60000)
      console.log(`  ${s.d.toFixed(1).padStart(5)} nm  ${s.id}  ${(s.name || '').padEnd(28)}`
        + ` ${o.twsKn.toFixed(1).padStart(5)} kn  ${o.twdDeg == null ? '---' : String(Math.round(o.twdDeg)).padStart(3)}°`
        + `  gust ${o.gustKn == null ? ' --' : o.gustKn.toFixed(1)}  ${String(ageMin).padStart(4)} min  ${o.elevM ?? '?'} m`)
    } catch (e) {
      console.log(`  ${s.d.toFixed(1).padStart(5)} nm  ${s.id}  ${(s.name || '').padEnd(28)} ${(e as Error).message}`)
    }
  }

  console.log(`
READ IT IN THIS ORDER:
  1. The observation header. If it has no 'ff' and 'dd', mf-land returns
     nothing for every station and MF_KEYS needs the real names.
  2. Cap Camarat. Present in the list AND showing a kn figure means SSA can
     have it. Present but "NO WIND PARSED" means the station is in the network
     without a live anemometer, which is what Windfinder implies.
  3. The ages. Tens of minutes is right. A tidy 60 or 120 means validity_time
     is being read in the wrong zone.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
