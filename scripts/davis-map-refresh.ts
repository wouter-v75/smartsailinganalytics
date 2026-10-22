// Rebuild src/lib/windObsDavisMap.ts from WeatherLink's public map index.
//
//   npx vite-node scripts/davis-map-refresh.ts            print the file, change nothing
//   npx vite-node scripts/davis-map-refresh.ts -- --write overwrite it
//   npx vite-node scripts/davis-map-refresh.ts -- --per 8 --nm 30
//
// Runs on the laptop: it fetches 8.4 MB and the sandbox has no network.
//
// WHAT IT DOES. weatherlink.com/map/data lists every public Davis station on
// earth — 79,522 of them — with id and position. For each venue it takes the
// nearest few, asks each one for its current conditions, and KEEPS ONLY THE
// ONES THAT ANSWER. That last part is the point: when this list was first
// built, five of forty-eight candidates were dead — two stations at Ensenada
// silent for 47 and 45 hours, one at St Tropez for 56, one at Porto Cervo for
// 9, and one publishing no wind at all. Listed unchecked they would have been
// absences on the map with nothing to say which.
//
// Run it when a venue is added, or once a season — station positions change
// when somebody installs an anemometer, which is not often.

import { writeFileSync } from 'node:fs'
import { VENUES } from '../src/lib/obsSources'
import { parseWeatherLinkMapIndex, parseWeatherLinkMapStation } from '../src/lib/windObs'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const flag = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const PER = Number(flag('per', '6'))
const NM = Number(flag('nm', '25'))
const MAX_AGE_MIN = Number(flag('age', '180'))

const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const BASE = 'https://www.weatherlink.com'

async function main() {
  process.stdout.write('fetching the public-station index (8.4 MB)… ')
  const idxRes = await fetch(`${BASE}/map/data`, { headers: { 'User-Agent': UA } })
  if (!idxRes.ok) { console.error(`\nindex: HTTP ${idxRes.status}`); process.exit(1) }
  const index = parseWeatherLinkMapIndex(await idxRes.json())
  console.log(`${index.length} stations`)

  const kept: Array<{ venue: string; id: string; name: string; lat: number; lon: number; nm: number }> = []
  const seen = new Set<string>()
  let checked = 0, dropped = 0

  for (const [venue, la, lo] of VENUES) {
    const cos = Math.cos((la * Math.PI) / 180)
    const near = index
      .map((s) => ({ s, d: Math.hypot((s.lat - la) * 60, (s.lon - lo) * 60 * cos) }))
      .filter((x) => x.d <= NM)
      .sort((a, b) => a.d - b.d)
      .slice(0, PER)

    console.log(`\n${venue}: ${near.length} candidate(s) within ${NM} nm`)
    for (const { s, d } of near) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      checked++
      try {
        const r = await fetch(`${BASE}/map/data/station/${encodeURIComponent(s.id)}`, { headers: { 'User-Agent': UA } })
        if (!r.ok) { console.log(`  ${d.toFixed(1).padStart(5)} nm  HTTP ${r.status}  ${s.id.slice(0, 8)}`); dropped++; continue }
        const raw = await r.json()
        const o = parseWeatherLinkMapStation(raw, s.id)
        const name = typeof (raw as { sStation?: unknown }).sStation === 'string' ? (raw as { sStation: string }).sStation.trim() : ''
        if (!o) { console.log(`  ${d.toFixed(1).padStart(5)} nm  no usable wind    ${name || s.id.slice(0, 8)}`); dropped++; continue }
        const ageMin = (Date.now() - Date.parse(o.t)) / 60000
        if (ageMin > MAX_AGE_MIN) {
          console.log(`  ${d.toFixed(1).padStart(5)} nm  STALE ${Math.round(ageMin)} min  ${name || s.id.slice(0, 8)}`)
          dropped++; continue
        }
        console.log(`  ${d.toFixed(1).padStart(5)} nm  ${o.twsKn.toFixed(1).padStart(5)} kn  ${name}`)
        kept.push({ venue, id: s.id, name: name || `Davis ${s.id.slice(0, 8)}`, lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), nm: +d.toFixed(1) })
      } catch (e) {
        console.log(`  ${d.toFixed(1).padStart(5)} nm  ${(e as Error).message}`); dropped++
      }
    }
  }

  console.log(`\n${kept.length} kept, ${dropped} dropped of ${checked} checked`)

  const byVenue = new Map<string, typeof kept>()
  for (const k of kept) { const a = byVenue.get(k.venue) || []; a.push(k); byVenue.set(k.venue, a) }
  let rows = ''
  for (const [venue, list] of Array.from(byVenue.entries())) {
    rows += `  // ${venue}\n`
    for (const k of list.sort((a, b) => a.nm - b.nm)) {
      rows += `  { id: '${k.id}', name: ${JSON.stringify(k.name)}, lat: ${k.lat}, lon: ${k.lon} },  // ${k.nm} nm\n`
    }
  }

  const path = new URL('../src/lib/windObsDavisMap.ts', import.meta.url)
  if (!WRITE) {
    console.log('\n--- rows (DRY RUN; add --write to replace the file) ---\n')
    console.log(rows)
    return
  }
  const existing = (await import('node:fs')).readFileSync(path, 'utf8')
  const head = existing.slice(0, existing.indexOf('export const DAVIS_MAP_STATIONS'))
  writeFileSync(path, `${head}export const DAVIS_MAP_STATIONS: DavisMapStation[] = [\n${rows}]\n`)
  console.log(`\nwrote ${kept.length} station(s) to src/lib/windObsDavisMap.ts`)
  console.log('The header comment is kept — update its date and its dropped-station tally by hand.')
}

main().catch((e) => { console.error(e); process.exit(1) })
