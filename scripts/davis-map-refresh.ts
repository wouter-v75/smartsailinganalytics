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
// HOW MANY PER VENUE. This defaulted to 6, which was never a judgement about
// coverage — it was the number that matched the live map's old fetch cap. There
// are 124 public Davis stations within 20 nm of Cowes and the nearest 24 were
// ALL live when measured on 22 Oct 2026, so 6 was throwing away a working
// network: Windycator showed 24 stations around the Solent where SSA showed 6.
// The default is now 24, which with two overlapping Solent venues puts the
// area past Windycator. Raising it further costs the POLLER, not the map —
// every station in this file is read every 15 minutes, so 24 per venue over
// 12 venues is around 19,000 calls a day to somebody else's public endpoint.
//
// Run it when a venue is added, or once a season — station positions change
// when somebody installs an anemometer, which is not often.

import { writeFileSync } from 'node:fs'
import { VENUES } from '../src/lib/obsSources'
import { DAVIS_MAP_STATIONS } from '../src/lib/windObsDavisMap'
import { parseWeatherLinkMapIndex, parseWeatherLinkMapStation } from '../src/lib/windObs'
import { gradedPick, bandCounts, nmBetween, GRADED_DEFAULTS } from '../src/lib/obsDensity'
import { keepInRegistry, type ProbeOutcome } from '../src/lib/obsRegistryMerge'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const flag = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const PER = Number(flag('per', '24'))
// Graded selection: everything inside --inner, thinning to --outer. This is
// the default now; --per <n> switches back to the flat nearest-n.
const FLAT = argv.includes('--per')
const INNER = Number(flag('inner', String(GRADED_DEFAULTS.innerNm)))
const OUTER = Number(flag('outer', String(GRADED_DEFAULTS.outerNm)))
const MAXSEP = Number(flag('maxsep', String(GRADED_DEFAULTS.maxSepNm)))
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

  const kept: Array<{ venue: string; id: string; name: string; lat: number; lon: number; nm: number; note: string }> = []
  const seen = new Set<string>()
  let checked = 0, dropped = 0, rescued = 0

  // Stations already in the registry, by id. A candidate that is one of these
  // gets the benefit of the doubt — see obsRegistryMerge for why that matters.
  const known = new Map(DAVIS_MAP_STATIONS.map((s) => [s.id, s]))

  for (const [venue, la, lo] of VENUES) {
    // CANDIDATES ARE THE INDEX **PLUS WHAT WE ALREADY HAVE**. A station can
    // drop out of the public index while answering perfectly — the Yacht Club
    // de Saint-Tropez did exactly that — and building only from the index
    // deletes it with no error anywhere.
    const fromIndex = index.filter((s) => nmBetween(la, lo, s.lat, s.lon) <= OUTER)
    const fromRegistry = DAVIS_MAP_STATIONS
      .filter((s) => nmBetween(la, lo, s.lat, s.lon) <= OUTER && !fromIndex.some((i) => i.id === s.id))
      .map((s) => ({ id: s.id, lat: s.lat, lon: s.lon }))
    const pool = [...fromIndex, ...fromRegistry]

    const near = FLAT
      ? pool
        .map((s) => ({ s, d: nmBetween(la, lo, s.lat, s.lon) }))
        .filter((x) => x.d <= NM)
        .sort((a, b) => a.d - b.d)
        .slice(0, PER)
        .map((x) => x.s)
      : gradedPick(pool, la, lo, { innerNm: INNER, outerNm: OUTER, maxSepNm: MAXSEP })

    const offIndex = near.filter((s) => !fromIndex.some((i) => i.id === s.id)).length
    console.log(`\n${venue}: ${pool.length} in range, ${near.length} selected`
      + `${offIndex ? ` (${offIndex} carried from the registry, absent from the index)` : ''}`)
    console.log(`  available: ${JSON.stringify(bandCounts(pool, la, lo))}`)
    console.log(`  selected:  ${JSON.stringify(bandCounts(near, la, lo))}`)

    for (const s of near) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      checked++
      const d = nmBetween(la, lo, s.lat, s.lon)
      const isKnown = known.has(s.id)
      let outcome: ProbeOutcome = 'no-answer'
      let name = known.get(s.id)?.name ?? ''
      let detail = ''

      try {
        const r = await fetch(`${BASE}/map/data/station/${encodeURIComponent(s.id)}`, { headers: { 'User-Agent': UA } })
        if (!r.ok) {
          detail = `HTTP ${r.status}`
        } else {
          const raw = await r.json()
          const fromFeed = typeof (raw as { sStation?: unknown }).sStation === 'string'
            ? (raw as { sStation: string }).sStation.trim() : ''
          if (fromFeed) name = fromFeed
          const o = parseWeatherLinkMapStation(raw, s.id)
          if (!o) {
            outcome = 'answered-no-wind'
            detail = 'no wind'
          } else {
            const ageMin = (Date.now() - Date.parse(o.t)) / 60000
            outcome = ageMin > MAX_AGE_MIN ? 'stale' : 'wind'
            detail = outcome === 'wind' ? `${o.twsKn.toFixed(1)} kn` : `${Math.round(ageMin)} min old`
          }
        }
      } catch (e) {
        detail = (e as Error).message
      }

      const { keep, why } = keepInRegistry(outcome, isKnown)
      console.log(`  ${d.toFixed(1).padStart(5)} nm  ${detail.padEnd(14)} ${name || s.id.slice(0, 8)}  — ${why}`)
      if (!keep) { dropped++; continue }
      if (outcome !== 'wind') rescued++
      kept.push({
        venue, id: s.id, name: name || `Davis ${s.id.slice(0, 8)}`,
        lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), nm: +d.toFixed(1),
        note: outcome === 'wind' ? '' : ` // ${why.replace(/^KEPT — /, '')}`,
      })
    }
  }

  console.log(`\n${kept.length} kept (${rescued} carried without a live reading), ${dropped} dropped of ${checked} checked`)

  const byVenue = new Map<string, typeof kept>()
  for (const k of kept) { const a = byVenue.get(k.venue) || []; a.push(k); byVenue.set(k.venue, a) }
  let rows = ''
  for (const [venue, list] of Array.from(byVenue.entries())) {
    rows += `  // ${venue}\n`
    for (const k of list.sort((a, b) => a.nm - b.nm)) {
      rows += `  { id: '${k.id}', name: ${JSON.stringify(k.name)}, lat: ${k.lat}, lon: ${k.lon} },  // ${k.nm} nm${k.note}\n`
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

  // The provenance block is GENERATED. The header used to carry a hand-written
  // "built <date>" plus an instruction to update it and the dropped tally by
  // hand, which is an instruction that is wrong the second time it is ignored.
  const open = '// <generated>'
  const close = '// </generated>'
  const a = head.indexOf(open)
  const b = head.indexOf(close)
  if (a < 0 || b < a) {
    console.error(`\nThe ${open} … ${close} block is missing from the header of`)
    console.error('src/lib/windObsDavisMap.ts, so there is nowhere to record what this run')
    console.error('found. Put it back rather than letting the file claim a stale tally.')
    process.exit(1)
  }
  const when = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const perVenue = Array.from(byVenue.entries()).map(([v, l]) => `//   ${v}: ${l.length}`).join('\n')
  const block = [
    open,
    FLAT
      ? `// ${kept.length} stations, the nearest ${PER} per venue within ${NM} nm, built ${when}.`
      : `// ${kept.length} stations, graded: ALL within ${INNER} nm, thinning to ${MAXSEP} nm spacing`,
    FLAT ? '//' : `// at ${OUTER} nm. Built ${when}.`,
    `// ${dropped} of ${checked} candidates dropped as stale (over ${MAX_AGE_MIN} min), silent or`,
    '// publishing no wind. Per venue:',
    perVenue,
    close,
  ].join('\n')
  const newHead = head.slice(0, a) + block + head.slice(b + close.length)

  writeFileSync(path, `${newHead}export const DAVIS_MAP_STATIONS: DavisMapStation[] = [\n${rows}]\n`)
  console.log(`\nwrote ${kept.length} station(s) to src/lib/windObsDavisMap.ts`)
  console.log('The provenance block in the header was rewritten too — nothing to update by hand.')
}

main().catch((e) => { console.error(e); process.exit(1) })
