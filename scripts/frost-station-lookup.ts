// Resolve a MET Norway station — by WMO number, name or SN id — and say what
// wind it actually reports.
//
//   npx vite-node scripts/frost-station-lookup.ts -- --wmo 01482   (or 1482)
//   npx vite-node scripts/frost-station-lookup.ts -- --name Ferder
//   npx vite-node scripts/frost-station-lookup.ts -- --id SN27500
//   npx vite-node scripts/frost-station-lookup.ts -- --near oslofjord --radius 30
//
// Read-only. Nothing to --write: it prints the line to paste into FROST_SITES.
//
// A WMO NUMBER IS UNPADDED IN FROST. Station plates, almanacs and most
// catalogues write Færder fyr as 01482; Frost stores 1482, and `wmoid=01482`
// is not an empty result but a flat 404 — indistinguishable, if you are not
// looking closely, from "there is no such station". So --wmo strips leading
// zeros and retries before believing a miss.
//
// WHY IT EXISTS. FROST_SITES is a hand-written list of SN ids, and an SN id
// that matches nothing fails in the worst way available: the observations
// request still succeeds, the station simply never appears, and no error is
// raised anywhere. That is the same shape as a mistyped log-profile alias —
// "a typo whose only other symptom is a field that stays empty for ever".
// Resolving the id against the real API first is the cure.
//
// IT ALSO CHECKS THE ELEMENTS, which is the part that decides whether a
// station is worth having at all. Several stations already in FROST_SITES
// report speed and gust but NO DIRECTION (Tjølling, Brunlanes, Øsaker), and
// that is only discoverable by asking. A lighthouse with all three is worth
// more than three inland stations with two.
//
// AND --near AUDITS THE LIST. FROST_SITES was hand-built from whatever turned
// up at the time, so the question "what is Frost serving near this venue that
// we are not asking for?" has never been answered. --near answers it, marking
// each station as already present or missing, which is how a venue's Norwegian
// coverage gets denser without guessing at ids.

import { readFileSync, existsSync } from 'node:fs'
import { VENUES, FROST_SITES } from '../src/lib/obsSources'
import { nmBetween } from '../src/lib/obsDensity'

const argv = process.argv.slice(2)
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

const ID = flag('id')
const WMO = flag('wmo')
const NAME = flag('name')
const NEAR = flag('near')
const RADIUS = Number(flag('radius', '30'))
const COUNT = Number(flag('count', '100'))
const CLIENT = env.FROST_CLIENT_ID || process.env.FROST_CLIENT_ID
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'

if (!CLIENT) {
  console.error('No FROST_CLIENT_ID in .env.local. Get one at frost.met.no/auth/requestCredentials.html')
  process.exit(1)
}
if (!ID && !WMO && !NAME && !NEAR) {
  console.error('Give one of --wmo <number>, --name <text>, --id <SNxxxxx> or --near <venue-key>.')
  console.error(`Venue keys: ${VENUES.map((v) => v.key).join(', ')}`)
  process.exit(1)
}

// Basic auth with the client id as the user and NO password — the secret is
// only for the OAuth2 flow, so it never goes over the wire. Same as obsSources.
const auth = `Basic ${Buffer.from(`${CLIENT}:`).toString('base64')}`

async function frost(path: string): Promise<any> {
  const r = await fetch(`https://frost.met.no${path}`, {
    headers: { Authorization: auth, accept: 'application/json', 'User-Agent': UA },
  })
  const body = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`)
  return JSON.parse(body)
}

const WIND_ELEMENTS = ['wind_speed', 'wind_from_direction', 'max(wind_speed_of_gust PT1H)']

/**
 * Which wind elements each station actually serves, in ONE bulk call.
 *
 * Bulk because the alternative is a request per station, and --near can hand
 * this a hundred of them. It is the same shape the poller already uses for the
 * observations themselves: comma-joined sources, one round trip.
 */
async function windElements(ids: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (!ids.length) return out
  // Chunked: a URL with a hundred ids in it is long enough to be refused.
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40)
    let ts: any
    try {
      ts = await frost(`/observations/availableTimeSeries/v0.jsonld?sources=${chunk.join(',')}`
        + `&elements=${encodeURIComponent(WIND_ELEMENTS.join(','))}`)
    } catch {
      continue // a chunk with one dud id in it can 404 the lot; skip, do not fail
    }
    for (const t of ts.data || []) {
      // sourceId comes back as "SN29950:0" — the colon is the sensor number.
      const id = String(t.sourceId || '').split(':')[0]
      if (!id) continue
      const set = out.get(id) || new Set<string>()
      set.add(String(t.elementId))
      out.set(id, set)
    }
  }
  return out
}

function reportElements(have: Set<string> | undefined, indent: string) {
  console.log(`${indent}wind elements:`)
  for (const el of WIND_ELEMENTS) {
    console.log(`${indent}  ${el.padEnd(32)} ${have?.has(el) ? 'yes' : 'ABSENT'}`)
  }
  if (have && !have.has('wind_from_direction')) {
    console.log(`${indent}  ^ no DIRECTION. Still worth having for the strength, like Tjølling`)
    console.log(`${indent}    and Brunlanes already in FROST_SITES — but say so in the comment.`)
  }
}

const present = new Set(FROST_SITES.map((f) => f.id))

/** Frost 404s a query that matches nothing, so a miss is an exception here. */
async function sourcesOrNull(q: string): Promise<any[] | null> {
  try {
    const r = await frost(`/sources/v0.jsonld?${q}`)
    const items: any[] = r.data || []
    return items.length ? items : null
  } catch (e) {
    if (/HTTP 404/.test((e as Error).message)) return null
    throw e
  }
}

async function lookupOne() {
  let items: any[] | null = null
  if (ID) {
    items = await sourcesOrNull(`ids=${encodeURIComponent(ID)}`)
  } else if (WMO) {
    items = await sourcesOrNull(`wmoid=${encodeURIComponent(WMO)}`)
    const bare = WMO.replace(/^0+/, '')
    if (!items && bare && bare !== WMO) {
      // The padded form is how the number is WRITTEN; the bare form is how
      // Frost stores it. Say which one worked, or the next person repeats this.
      items = await sourcesOrNull(`wmoid=${encodeURIComponent(bare)}`)
      if (items) console.log(`\n(--wmo ${WMO} is a 404; Frost stores it unpadded as ${bare})`)
    }
  } else {
    items = await sourcesOrNull(`name=${encodeURIComponent(NAME!)}`)
  }
  if (!items) { console.log('\nNo station matched.'); return }

  const els = await windElements(items.map((s) => String(s.id)).filter(Boolean))

  console.log(`\n${items.length} station(s):`)
  for (const s of items) {
    const [lon, lat] = s.geometry?.coordinates ?? [null, null]
    const nearest = (lat != null && lon != null)
      ? VENUES.map((v) => ({ v: v.key, d: nmBetween(v.lat, v.lon, lat, lon) })).sort((a, b) => a.d - b.d)[0]
      : null
    console.log(`\n  ${s.id}  ${s.name}${present.has(String(s.id)) ? '   [ALREADY IN FROST_SITES]' : ''}`)
    console.log(`    wmoId     ${s.wmoId ?? '-'}`)
    console.log(`    position  ${lat}, ${lon}   masl ${s.masl ?? '?'}`)
    console.log(`    valid     ${s.validFrom ?? '?'} → ${s.validTo ?? 'open'}`)
    if (nearest) console.log(`    nearest venue  ${nearest.v} at ${nearest.d.toFixed(1)} nm`)
    reportElements(els.get(String(s.id)), '    ')
    if (lat != null && lon != null && !present.has(String(s.id))) {
      console.log('\n    paste into FROST_SITES (src/lib/obsSources.ts):')
      console.log(`      { id: '${s.id}', name: ${JSON.stringify(s.name)}, lat: ${lat}, lon: ${lon} },`)
    }
  }
}

/**
 * Everything Frost serves around a venue, marked present or missing.
 *
 * Sorted by distance and filtered to stations that report at least a wind
 * SPEED — a temperature-only station is not an observation this network has
 * any use for, and listing them would bury the ones that are.
 */
async function lookupNear() {
  const v = VENUES.find((x) => x.key === NEAR)
  if (!v) {
    console.error(`No venue "${NEAR}". Keys: ${VENUES.map((x) => x.key).join(', ')}`)
    process.exit(1)
  }
  console.log(`\n${v.name} (${v.lat}, ${v.lon}) — Frost stations within ${RADIUS} nm\n`)

  const src = await frost('/sources/v0.jsonld?types=SensorSystem'
    + `&geometry=${encodeURIComponent(`nearest(POINT(${v.lon} ${v.lat}))`)}`
    + `&nearestmaxcount=${COUNT}`)
  const cand = (src.data || [])
    .map((s: any) => {
      const [lon, lat] = s.geometry?.coordinates ?? [null, null]
      return { s, lat, lon, d: lat == null ? Infinity : nmBetween(v.lat, v.lon, lat, lon) }
    })
    .filter((c: any) => c.d <= RADIUS && !c.s.validTo) // validTo set = closed station
    .sort((a: any, b: any) => a.d - b.d)

  if (!cand.length) { console.log('  nothing within the radius'); return }

  const els = await windElements(cand.map((c: any) => String(c.s.id)))
  const withWind = cand.filter((c: any) => els.get(String(c.s.id))?.has('wind_speed'))

  console.log(`  ${cand.length} open station(s) in range, ${withWind.length} reporting wind speed\n`)
  const missing: any[] = []
  for (const c of withWind) {
    const id = String(c.s.id)
    const e = els.get(id)!
    const flags = [e.has('wind_from_direction') ? 'dir' : '---',
                   e.has('max(wind_speed_of_gust PT1H)') ? 'gust' : '----'].join(' ')
    const mark = present.has(id) ? 'have' : 'MISSING'
    console.log(`  ${mark.padEnd(8)} ${id.padEnd(9)} ${String(c.s.name).padEnd(28)}`
      + ` ${c.d.toFixed(1).padStart(5)} nm  ${flags}  masl ${c.s.masl ?? '?'}`)
    if (!present.has(id)) missing.push(c)
  }

  if (missing.length) {
    console.log(`\n  ${missing.length} to consider adding — paste into FROST_SITES:`)
    for (const c of missing) {
      console.log(`      { id: '${c.s.id}', name: ${JSON.stringify(c.s.name)}, lat: ${c.lat}, lon: ${c.lon} },`)
    }
    console.log('\n  Judge them before pasting: an inland garden station a mile from the water')
    console.log('  is a worse observation than none, because MOS will fit to it.')
  }
}

async function main() {
  if (NEAR) await lookupNear()
  else await lookupOne()
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
