// Check Météo-France's marine feed against what src/lib/windObs.ts expects.
//
//   npx vite-node scripts/mf-obs-probe.ts                       nearest to St Tropez
//   npx vite-node scripts/mf-obs-probe.ts -- --lat 50.76 --lon -1.29 --nm 200   Solent
//   npx vite-node scripts/mf-obs-probe.ts -- --raw               dump the first rows too
//
// Read-only. There is nothing to --write: it fetches and prints.
//
// WHAT IT IS FOR. It was written to DISCOVER the payload, because Météo-France
// publish the endpoints but not the field names. It has done that (see below);
// what it is for now is noticing when the feed moves under us, because the
// adapter fails SILENTLY if it does — parseMfMarine simply returns nothing, the
// route's Promise.allSettled turns that into an absence, and the map shows
// "no stations nearby" rather than an error.
//
// WHAT WAS LEARNED, 22 Oct 2026, none of it guessable from the docs:
//
//   v1 is SUSPENDED — 500 `[State : SUSPENDED]` on every path. v2 only.
//   `/liste-bouees` is NOT a station list. It returns the full observations for
//     every buoy over the retention window, so buoys are ONE bulk call.
//   `/liste-bateaux` really is a list: geo_id_wmo;geo_id_wigos;name. No
//     position, no wind. Ships need /bateaux as well.
//   The gust is `rafper`, not the fxi/fx the land stations use.
//   `format` is REQUIRED on every call, list ones included, or it answers 400
//     "Vérifiez le paramètre format" wrapped in WSO2 XML.
//
// THREE THINGS TO READ IN THE OUTPUT, in order of what they cost if wrong:
//
//   1. UNITS. `ff` is m/s and the adapter multiplies by 1.943844. The feed is SI
//      throughout — `t` comes back in kelvin, `pmer` in pascals — which is the
//      corroboration. If it ever became km/h, every speed would be 3.6x too big
//      and still plausible in light airs.
//   2. THE CLOCK. Every other clock in this project is venue-local even when it
//      is called UTC (CLAUDE.md). `validity_time` carries a Z and is believed.
//      Ages printed below should be tens of minutes, not a tidy +/- 1 or 2 h.
//   3. UNKNOWN COLUMNS. Anything in the header the adapter does not read is
//      listed. A new name for an existing quantity is how this goes quiet.

import { readFileSync, existsSync } from 'node:fs'
import { parseMfCsv, parseMfMarine, parseMfStationList, latestPerStation, type WindObs } from '../src/lib/windObs'

const argv = process.argv.slice(2)
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const has = (n: string) => argv.includes(`--${n}`)

const lat = Number(flag('lat', '43.275'))
const lon = Number(flag('lon', '6.678'))
const nm = Number(flag('nm', '300'))      // marine stations are sparse; 40 nm often has none
const SHOW = Number(flag('show', '6'))

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
  console.error(`No key. Put METEOFRANCE_API_KEY in .env.local, or pass --key <value>.

It is the API key from portail-api.meteofrance.fr -> an API -> Configure API ->
token type "API Key". Their rule: a token only covers the APIs you had
SUBSCRIBED to when it was generated.`)
  process.exit(1)
}

// v1 answers 500 [State : SUSPENDED]; --base is there for the day v3 appears.
const BASE = flag('base', 'https://public-api.meteofrance.fr/public/DPObs/v2')!
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const MS_TO_KN = 1.943844

/** WSO2 wraps its complaints in XML; the useful sentence is the description. */
function why(text: string): string {
  const m = /<am:description>([^<]*)<\/am:description>/.exec(text) || /"description"\s*:\s*"([^"]*)"/.exec(text)
  return m ? m[1] : text.slice(0, 160).replace(/\s+/g, ' ')
}

async function csv(path: string): Promise<string | null> {
  const r = await fetch(`${BASE}${path}?format=csv`, { headers: { apikey: KEY!, 'User-Agent': UA } })
  const text = await r.text()
  if (!r.ok) {
    console.log(`  ${path} -> ${r.status}  ${why(text)}`)
    if (r.status === 401 || r.status === 403) {
      console.log('     401/403 means the token predates this subscription. Subscribe to')
      console.log('     everything FIRST, then generate the token once.')
    }
    return null
  }
  return text
}

// Everything the adapter reads, so anything else in the header is reported.
const KNOWN = new Set(['lat', 'lon', 'latitude', 'longitude', 'geo_id_wmo', 'geo_id_wigos',
  'id_station', 'numer_sta', 'name', 'nom_usuel', 'nom', 'validity_time', 'reference_time',
  'ff', 'dd', 'rafper', 'fxi', 'fx'])

function header(text: string): string[] {
  return (text.split(/\r?\n/)[0] || '').split(';').map((h) => h.trim().toLowerCase())
}

function report(kind: 'buoy' | 'ship', text: string, meta = new Map()) {
  const head = header(text)
  const rows = parseMfCsv(text)
  console.log(`  ${rows.length} row(s), ${head.length} column(s)`)

  const unread = head.filter((h) => h && !KNOWN.has(h))
  if (unread.length) console.log(`  columns the adapter ignores: ${unread.join(', ')}`)
  for (const need of ['ff', 'dd']) {
    if (!head.includes(need)) console.log(`  !! '${need}' IS NOT IN THE HEADER — the wind field has been renamed.`)
  }

  if (has('raw')) {
    console.log('  first 2 raw lines:')
    text.split(/\r?\n/).slice(0, 3).forEach((l) => console.log(`    ${l.slice(0, 200)}`))
  }

  const all = parseMfMarine(rows, kind, meta)
  const latest = latestPerStation(all)
  console.log(`  parsed ${all.length} reading(s) -> ${latest.length} station(s) after newest-per-station`)
  if (!latest.length) {
    console.log('  !! parseMfMarine produced NOTHING. Compare the header above with MF_KEYS')
    console.log('     in src/lib/windObs.ts — this is exactly how the map goes quiet.')
    return
  }

  const cos = Math.cos((lat * Math.PI) / 180)
  const near = latest
    .map((o: WindObs) => ({ o, d: Math.hypot((o.lat - lat) * 60, (o.lon - lon) * 60 * cos) }))
    .sort((a, b) => a.d - b.d)

  console.log(`\n  nearest to ${lat},${lon}:`)
  for (const { o, d } of near.slice(0, SHOW)) {
    const age = (Date.now() - Date.parse(o.t)) / 60000
    const flagStr = d <= nm ? '' : '   (beyond --nm, shown for reference)'
    console.log(`    ${o.name.slice(0, 26).padEnd(26)} ${d.toFixed(0).padStart(5)} nm  ` +
      `${o.twsKn.toFixed(1).padStart(5)} kn from ${String(o.twdDeg ?? '--').padStart(3)}deg  ` +
      `${o.gustKn != null ? `g${o.gustKn.toFixed(1).padStart(5)}` : '      '}  ${age.toFixed(0).padStart(4)} min old${flagStr}`)
    if (age < -5) console.log('        !! NEGATIVE AGE — the stamp is in the future. Timezone, not delay.')
  }

  const inRange = near.filter((x) => x.d <= nm).length
  console.log(`  ${inRange} within ${nm} nm`)

  const sample = rows.find((r) => typeof r.ff === 'number' && (r.ff as number) > 0)
  if (sample) {
    const ff = sample.ff as number
    console.log(`\n  units check: raw ff=${ff} -> ${(ff * MS_TO_KN).toFixed(1)} kn as m/s` +
      `, or ${((ff / 3.6) * MS_TO_KN).toFixed(1)} kn if that number were km/h`)
    if (typeof sample.t === 'number') {
      console.log(`               raw t=${sample.t} -> ${((sample.t as number) - 273.15).toFixed(1)} C as kelvin` +
        `  (sane kelvin corroborates m/s: the feed is SI throughout)`)
    }
  }
}

async function main() {
  console.log(`base ${BASE}\n`)

  console.log(`${'='.repeat(72)}\n=== BUOYS  /liste-bouees  (not a list: the observations themselves)\n${'='.repeat(72)}`)
  const buoys = await csv('/liste-bouees')
  if (buoys) report('buoy', buoys)

  console.log(`\n${'='.repeat(72)}\n=== SHIPS  /liste-bateaux (names) + /bateaux (readings)\n${'='.repeat(72)}`)
  const list = await csv('/liste-bateaux')
  const meta = list ? parseMfStationList(list) : new Map()
  if (list) console.log(`  ${meta.size} ship(s) named in the list`)
  const ships = await csv('/bateaux')
  if (ships) report('ship', ships, meta)
  else console.log('  no bulk /bateaux — ships may need id_station per vessel.')
}

main().catch((e) => { console.error(e); process.exit(1) })
