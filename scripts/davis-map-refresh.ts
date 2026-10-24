// Rebuild src/lib/windObsDavisMap.ts from WeatherLink's public map index.
//
//   npx vite-node scripts/davis-map-refresh.ts            print the file, change nothing
//   npx vite-node scripts/davis-map-refresh.ts -- --write overwrite it
//   npx vite-node scripts/davis-map-refresh.ts -- --per 8 --nm 30     flat nearest-n
//   npx vite-node scripts/davis-map-refresh.ts -- --venue "St Tropez"  one venue only
//   npx vite-node scripts/davis-map-refresh.ts -- --venue "St Tropez" --coast
//        ... and bias the outer ring toward the water. Inland stations need
//        wider spacing, so Hyeres and Antibes get picked before Brignoles and
//        Le Luc. Distance from the sea is measured against the Open-Meteo
//        elevation DEM — the same "coastline dataset" the forecast
//        diagnostics use — and written into the registry, so a second run
//        costs nothing. --coast-bias <n> tunes it; 1.5 is the default and
//        means an inland station needs 2.5x the spacing of a coastal one.
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

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { VENUES, stationsForPoll, POLL_EVERY_MIN } from '../src/lib/obsSources'
import { decideVenues, FORCE_ALL } from '../src/lib/obsActivation'
import { DAVIS_MAP_STATIONS } from '../src/lib/windObsDavisMap'
import { parseWeatherLinkMapIndex, parseWeatherLinkMapStation } from '../src/lib/windObs'
import { gradedPick, bandCounts, nmBetween, GRADED_DEFAULTS } from '../src/lib/obsDensity'
import { seaProbePoints, seaNmFromElevations, seaProbeCost } from '../src/lib/coastSeaDistance'
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
// ONE VENUE AT A TIME. Graded selection out to 50 nm is dense, and applying it
// to all twelve venues at once would take the registry to several hundred
// stations — every one of them polled every half hour, which undoes the
// call-count reduction that moved the cadence to 0,30 in the first place.
// With --venue only that venue is re-picked and probed; every other venue's
// existing rows are carried through untouched, assigned to whichever venue
// they are nearest.
const VENUE = flag('venue', '')
// COAST BIAS. Inland stations need wider spacing, so the outer ring fills up
// with the coast first. Off by default: an inland station is the right answer
// on a land-breeze morning, and biasing against it is a choice.
const COAST = argv.includes('--coast')
const COAST_BIAS = Number(flag('coast-bias', '1.5'))
const NM = Number(flag('nm', '25'))
const MAX_AGE_MIN = Number(flag('age', '180'))

const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const BASE = 'https://www.weatherlink.com'

/**
 * Distance from the sea for each point, from the Open-Meteo elevation DEM.
 *
 * The same coastline-from-a-DEM approach as components/weather/coastline.js —
 * land above a metre, sea at or below — asked as "how far" rather than "which
 * way". Billed PER LOCATION, so the caller decides who is worth asking about
 * and the cost is printed before anything is fetched.
 */
async function measureSeaNm(pts: Array<{ lat: number; lon: number }>): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (!pts.length) return out

  const samples: Array<[number, number]> = []
  pts.forEach((s) => { for (const p of seaProbePoints(s.lat, s.lon)) samples.push(p) })
  const perStation = samples.length / pts.length

  const elev: Array<number | null> = new Array(samples.length).fill(null)
  const BATCH = 100              // the API's own per-request limit
  // PACED, because Open-Meteo bills and limits PER LOCATION, not per request:
  // 600 locations a minute from one address. A 100-point batch every 11 s sits
  // just under that. The first version of this fired ~24 batches as fast as it
  // could, which is 2,400 locations in a few seconds, and most came back
  // empty — see the coverage check below for why that was worse than useless.
  const GAP_MS = 11_000
  let failed = 0

  for (let i = 0; i < samples.length; i += BATCH) {
    const chunk = samples.slice(i, i + BATCH)
    const lat = chunk.map((c) => c[0].toFixed(4)).join(',')
    const lon = chunk.map((c) => c[1].toFixed(4)).join(',')
    let ok = false
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 20_000 * attempt))
      try {
        const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`)
        if (r.status === 429) { console.log(`\n  rate-limited on batch ${i / BATCH + 1}, backing off`); continue }
        if (!r.ok) { console.log(`\n  batch ${i / BATCH + 1}: HTTP ${r.status}`); continue }
        const j = await r.json() as { elevation?: unknown }
        const e = Array.isArray(j.elevation) ? j.elevation : null
        if (!e || e.length !== chunk.length) { console.log(`\n  batch ${i / BATCH + 1}: unexpected shape`); continue }
        e.forEach((v, k) => { elev[i + k] = typeof v === 'number' ? v : null })
        ok = true
      } catch (err) {
        console.log(`\n  batch ${i / BATCH + 1}: ${(err as Error).message}`)
      }
    }
    if (!ok) failed++
    process.stdout.write(`\r  DEM ${Math.min(i + BATCH, samples.length)}/${samples.length} points`
      + `${failed ? `, ${failed} batch(es) failed` : ''}…   `)
    if (i + BATCH < samples.length) await new Promise((r) => setTimeout(r, GAP_MS))
  }
  process.stdout.write('\n')

  pts.forEach((s, i) => {
    out.set(`${s.lat},${s.lon}`, seaNmFromElevations(elev.slice(i * perStation, (i + 1) * perStation)))
  })
  return out
}

/**
 * A LOCAL cache of measured sea distances, so the DEM is paid for once.
 *
 * Open-Meteo bills per LOCATION and the free budget is ~10,000 a day. A
 * Sorrento pick is ~3,100 locations, and before this the dry run spent them
 * and threw them away, then --write spent them all over again — about 6,400 of
 * a day's budget to pick ONE venue, for a quantity that cannot change: the
 * distance from a fixed station to the sea.
 *
 * Gitignored and local, deliberately. The registry's own seaNm is the durable
 * record and it is committed; this is only what stops a dry run and the write
 * run that follows it paying twice. Being untracked, writing it during a dry
 * run surprises nobody and cannot be committed by accident.
 *
 * ONLY SUCCESSES ARE CACHED. seaNmFromElevations returns a number when it
 * looked — including the outer radius for "no sea in the ring" — and null ONLY
 * when the measurement itself failed. Caching a null would make one
 * rate-limited batch permanent.
 */
const CACHE_PATH = new URL('../.coast-cache.json', import.meta.url)

function loadCoastCache(): Map<string, number> {
  try {
    if (!existsSync(CACHE_PATH)) return new Map()
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Record<string, unknown>
    const m = new Map<string, number>()
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) m.set(k, v)
    return m
  } catch {
    return new Map()   // a corrupt cache is a cache miss, not an error
  }
}

function saveCoastCache(m: Map<string, number>): void {
  try {
    writeFileSync(CACHE_PATH, `${JSON.stringify(Object.fromEntries(Array.from(m.entries())), null, 0)}\n`)
  } catch (e) {
    console.log(`  (could not write the coast cache: ${(e as Error).message})`)
  }
}

/**
 * How much of the pool the DEM actually answered for.
 *
 * A PARTIAL measurement is worse than none, which is the whole reason this
 * check exists. requiredSepNm deliberately does not penalise a station whose
 * distance from the sea is unknown — so if the DEM answers for a fifth of the
 * pool, the coast bias is not "weakly applied", it is applied ONLY to the
 * fifth that succeeded. Inland stations that happened to fail measurement sail
 * through unpenalised while coastal-adjacent ones that succeeded get thinned.
 * That is a bias in favour of failed lookups, and it produced a Sorrento
 * selection full of inland Apennine stations at 36-48 nm.
 */
export const COAST_MIN_COVERAGE = 0.9

async function main() {
  process.stdout.write('fetching the public-station index (8.4 MB)… ')
  const idxRes = await fetch(`${BASE}/map/data`, { headers: { 'User-Agent': UA } })
  if (!idxRes.ok) { console.error(`\nindex: HTTP ${idxRes.status}`); process.exit(1) }
  const index = parseWeatherLinkMapIndex(await idxRes.json())
  console.log(`${index.length} stations`)

  const kept: Array<{ venue: string; id: string; name: string; lat: number; lon: number; nm: number; note: string; seaNm?: number }> = []
  const seen = new Set<string>()
  let checked = 0, dropped = 0, rescued = 0

  // Stations already in the registry, by id. A candidate that is one of these
  // gets the benefit of the doubt — see obsRegistryMerge for why that matters.
  const known = new Map(DAVIS_MAP_STATIONS.map((s) => [s.id, s]))

  const chosenVenues = VENUE
    ? VENUES.filter((v) => (v.key + ' ' + v.name).toLowerCase().includes(VENUE.toLowerCase()))
    : VENUES
  if (VENUE && !chosenVenues.length) {
    console.error(`\nNo venue matches ${JSON.stringify(VENUE)}. They are:`)
    for (const v of VENUES) console.error(`  ${v.key.padEnd(14)} ${v.name}`)
    process.exit(1)
  }
  if (VENUE) {
    console.log(`\nOnly ${chosenVenues.map((v) => v.name).join(', ')} is being re-picked.`)
    console.log('Every other venue keeps the stations it already has.')
  }

  // Carry through the venues we are NOT touching. An existing row belongs to
  // whichever venue it is nearest, which is the same rule that put it there.
  if (VENUE) {
    const touched = new Set(chosenVenues.map((v) => v.name))
    for (const st of DAVIS_MAP_STATIONS) {
      let best = ''
      let bestD = Infinity
      for (const v of VENUES) {
        const d = nmBetween(v.lat, v.lon, st.lat, st.lon)
        if (d < bestD) { bestD = d; best = v.name }
      }
      if (touched.has(best)) continue
      seen.add(st.id)
      kept.push({ venue: best, id: st.id, name: st.name, lat: st.lat, lon: st.lon, nm: +bestD.toFixed(1), note: '' })
    }
    console.log(`Carried ${kept.length} station(s) through from the other venues, unprobed.`)
  }

  for (const { name: venue, lat: la, lon: lo } of chosenVenues) {
    // CANDIDATES ARE THE INDEX **PLUS WHAT WE ALREADY HAVE**. A station can
    // drop out of the public index while answering perfectly — the Yacht Club
    // de Saint-Tropez did exactly that — and building only from the index
    // deletes it with no error anywhere.
    const fromIndex = index.filter((s) => nmBetween(la, lo, s.lat, s.lon) <= OUTER)
    const fromRegistry = DAVIS_MAP_STATIONS
      .filter((s) => nmBetween(la, lo, s.lat, s.lon) <= OUTER && !fromIndex.some((i) => i.id === s.id))
      .map((s) => ({ id: s.id, lat: s.lat, lon: s.lon }))
    const pool = [...fromIndex, ...fromRegistry]

    // Sea distances, for the pick that is about to happen. Only stations
    // outside the inner circle can be affected by the bias, and anything the
    // registry already knows is not re-measured, so a second run is free.
    const seaNm = new Map<string, number | null>()
    if (COAST && !FLAT) {
      // Two sources of already-known values: the committed registry, and the
      // local cache a previous dry run left behind.
      for (const st of DAVIS_MAP_STATIONS) {
        if (typeof st.seaNm === 'number') seaNm.set(`${st.lat},${st.lon}`, st.seaNm)
      }
      const cache = loadCoastCache()
      let fromCache = 0
      for (const [k, v] of Array.from(cache.entries())) {
        if (!seaNm.has(k)) { seaNm.set(k, v); fromCache++ }
      }
      const needed = pool.filter((s) =>
        nmBetween(la, lo, s.lat, s.lon) > INNER && !seaNm.has(`${s.lat},${s.lon}`))
      console.log(`  coast bias ${COAST_BIAS}: measuring ${needed.length} station(s)`
        + ` = ${seaProbeCost(needed.length).toLocaleString('en-GB')} Open-Meteo locations`
        + ` (billed per location; ${pool.length - needed.length} already known`
        + `${fromCache ? `, ${fromCache} of them from .coast-cache.json` : ''})`)
      const measured = await measureSeaNm(needed)
      for (const [k, v] of Array.from(measured.entries())) {
        seaNm.set(k, v)
        if (typeof v === 'number') cache.set(k, v)
      }
      if (needed.length) saveCoastCache(cache)
      const asked = needed.length
      const got = needed.filter((s) => seaNm.get(`${s.lat},${s.lon}`) != null).length
      const coverage = asked ? got / asked : 1
      console.log(`  ${got}/${asked} measured (${(coverage * 100).toFixed(0)}% coverage)`)
      if (coverage < COAST_MIN_COVERAGE) {
        console.error(`\n  COAST BIAS ABANDONED for ${venue}: only ${(coverage * 100).toFixed(0)}% of the pool`)
        console.error('  could be measured, and a partially applied bias favours the stations whose')
        console.error('  lookup FAILED — it would thin the coast and keep the hinterland. Re-run when')
        console.error('  the elevation API is answering, or drop --coast to select without it.')
        process.exit(1)
      }
    }

    const near = FLAT
      ? pool
        .map((s) => ({ s, d: nmBetween(la, lo, s.lat, s.lon) }))
        .filter((x) => x.d <= NM)
        .sort((a, b) => a.d - b.d)
        .slice(0, PER)
        .map((x) => x.s)
      : gradedPick(
        pool, la, lo,
        { innerNm: INNER, outerNm: OUTER, maxSepNm: MAXSEP, coastBias: COAST ? COAST_BIAS : 0 },
        (s) => seaNm.get(`${s.lat},${s.lon}`) ?? null,
      )

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
      const sea = seaNm.get(`${s.lat},${s.lon}`)
      kept.push({
        venue, id: s.id, name: name || `Davis ${s.id.slice(0, 8)}`,
        lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), nm: +d.toFixed(1),
        seaNm: typeof sea === 'number' ? sea : undefined,
        note: outcome === 'wind' ? '' : ` // ${why.replace(/^KEPT — /, '')}`,
      })
    }
  }

  console.log(`\n${kept.length} kept (${rescued} carried without a live reading), ${dropped} dropped of ${checked} checked`)
  // WHAT THIS SELECTION COSTS. Not simply kept x 48: since the activation
  // gate, the far stations of a venue are only polled while that venue is
  // DENSE. Reporting the dense figure alone would make a perfectly cheap
  // selection look alarming, which is how a good default gets talked out of.
  const asStations = kept.map((k) => ({ lat: k.lat, lon: k.lon }))
  const idleCount = stationsForPoll(asStations, { venues: decideVenues(VENUES, {}) }).length
  const denseCount = stationsForPoll(asStations, { venues: decideVenues(VENUES, { force: [FORCE_ALL] }) }).length
  const perDay = (n: number) => (n * (24 * 60 / POLL_EVERY_MIN)).toLocaleString('en-GB')
  console.log(`\nPOLLER COST, at the ${POLL_EVERY_MIN}-minute cadence:`)
  console.log(`  idle (nobody racing)   ${String(idleCount).padStart(4)} stations = ${perDay(idleCount)} requests/day`)
  console.log(`  every venue dense      ${String(denseCount).padStart(4)} stations = ${perDay(denseCount)} requests/day`)
  console.log('  A venue only reaches the dense figure while an obs_venue_activation window')
  console.log('  covers it, or a poll is called with ?domains=<key>.')
  if (idleCount * 48 > 8000) console.log('  ^ the IDLE figure is the one to worry about; consider a tighter --inner.')

  const byVenue = new Map<string, typeof kept>()
  for (const k of kept) { const a = byVenue.get(k.venue) || []; a.push(k); byVenue.set(k.venue, a) }
  let rows = ''
  for (const [venue, list] of Array.from(byVenue.entries())) {
    rows += `  // ${venue}\n`
    for (const k of list.sort((a, b) => a.nm - b.nm)) {
      const sea = typeof k.seaNm === 'number' ? `, seaNm: ${k.seaNm}` : ''
      rows += `  { id: '${k.id}', name: ${JSON.stringify(k.name)}, lat: ${k.lat}, lon: ${k.lon}${sea} },  // ${k.nm} nm${k.note}\n`
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
      : `// ${kept.length} stations, graded: ALL within ${INNER} nm, thinning to ${MAXSEP} nm spacing`
        + (COAST ? `, coast bias ${COAST_BIAS}` : ''),
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
