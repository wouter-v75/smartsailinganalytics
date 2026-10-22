// What do Météo-France's BUOY and SHIP endpoints actually answer with?
//
//   npx vite-node scripts/mf-obs-probe.ts                       St Tropez, buoys + ships
//   npx vite-node scripts/mf-obs-probe.ts -- --lat 50.76 --lon -1.29 --nm 60      Solent
//   npx vite-node scripts/mf-obs-probe.ts -- --key abc123       key not in .env.local
//
// Read-only. There is nothing to --write: it fetches and prints.
//
// WHY THIS EXISTS. Météo-France publish the ENDPOINTS for /bouees and /bateaux
// but not their FIELD NAMES. src/lib/windObs.ts therefore accepts several
// spellings per quantity (`dd`/`ff`/`fxi` are the Météo-France and SYNOP
// convention and are what we expect) and the adapter was written against a
// fixture of the EXPECTED shape, not a captured one. That is a guess wearing a
// test's clothes. This prints the real payload so MF_KEYS can be cut down to
// what actually answers — the same way METAR_LIVE in windObs.test.ts was taken
// off the wire and trimmed rather than invented.
//
// THREE THINGS TO READ IN THE OUTPUT, in order of what they cost if wrong:
//
//   1. UNITS. `ff` is documented as m/s elsewhere in MF's output and the adapter
//      multiplies by 1.943844. If it is km/h every speed is 3.6x too big and
//      still looks plausible in light airs. The probe prints the raw number
//      beside the converted one: a sea breeze should read 8-15 kn, not 30-55.
//   2. THE CLOCK. Every other clock in this project is venue-local even when it
//      is called UTC (see CLAUDE.md). The probe prints the age of the newest
//      observation. Hourly data at round hour + 10' should come out 10-70 min
//      old. Exactly +/- an hour or two off that is a timezone, not a delay.
//   3. WHICH KEYS ANSWERED. Anything in MF_KEYS that never appears is dead
//      weight; anything present that we do not read is a field we are throwing
//      away. Both are printed.

import { readFileSync, existsSync } from 'node:fs'
import { parseMfMarine, parseMfStationList, type WindObs } from '../src/lib/windObs'

const argv = process.argv.slice(2)
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const lat = Number(flag('lat', '43.275'))
const lon = Number(flag('lon', '6.678'))
const nm = Number(flag('nm', '40'))
const MAX = Number(flag('max', '4'))

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

It is the API key generated at portail-api.meteofrance.fr -> an API -> Configure
API -> token type "API Key". Remember their rule: a token only covers the APIs
you had SUBSCRIBED to when it was generated.`)
  process.exit(1)
}

const BASE = 'https://public-api.meteofrance.fr/public/DPObs/v1'
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'

function latestHour(now = new Date()): string {
  const d = new Date(now)
  if (d.getUTCMinutes() < 10) d.setUTCHours(d.getUTCHours() - 1)
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function get(path: string): Promise<{ ok: boolean; status: number; text: string }> {
  const r = await fetch(`${BASE}${path}`, { headers: { apikey: KEY!, 'User-Agent': UA } })
  return { ok: r.ok, status: r.status, text: await r.text() }
}

const MS_TO_KN = 1.943844
const seen = new Set<string>()

async function probe(kind: 'buoy' | 'ship') {
  const [listPath, dataPath] = kind === 'buoy' ? ['/liste-bouees', '/bouees'] : ['/liste-bateaux', '/bateaux']
  console.log(`\n${'='.repeat(72)}\n=== ${kind.toUpperCase()}  ${listPath} + ${dataPath}\n${'='.repeat(72)}`)

  const list = await get(listPath)
  if (!list.ok) {
    console.log(`  ${listPath} -> HTTP ${list.status}`)
    if (list.status === 401 || list.status === 403) {
      console.log('  401/403 usually means the token predates this API subscription.')
      console.log('  Subscribe to every API you need FIRST, then generate the token once.')
    }
    console.log(`  body: ${list.text.slice(0, 300)}`)
    return
  }

  console.log('\n--- raw list, first 3 lines (this is CSV, not JSON) ---')
  list.text.split(/\r?\n/).slice(0, 3).forEach((l) => console.log(`  ${l}`))

  const meta = parseMfStationList(list.text)
  const withPos = Array.from(meta.entries()).filter(([, m]) => m.lat != null && m.lon != null)
  console.log(`\n  parsed ${meta.size} station(s), ${withPos.length} with a position`)
  if (!meta.size) { console.log('  !! parseMfStationList read NOTHING -- the header names have changed.'); return }

  const cos = Math.cos((lat * Math.PI) / 180)
  const near = withPos
    .map(([id, m]) => ({ id, m, d: Math.hypot((m.lat! - lat) * 60, (m.lon! - lon) * 60 * cos) }))
    .filter((x) => x.d <= nm)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX)

  console.log(`  ${near.length} within ${nm} nm of ${lat},${lon}:`)
  near.forEach((x) => console.log(`     ${x.id}  ${(x.m.name || '').padEnd(28)} ${x.d.toFixed(1)} nm`))
  if (!near.length) {
    const closest = withPos
      .map(([id, m]) => ({ id, m, d: Math.hypot((m.lat! - lat) * 60, (m.lon! - lon) * 60 * cos) }))
      .sort((a, b) => a.d - b.d)[0]
    if (closest) console.log(`  (nearest anywhere: ${closest.id} ${closest.m.name || ''} at ${closest.d.toFixed(0)} nm)`)
    return
  }

  const date = latestHour()
  console.log(`\n  asking for date=${date}`)

  for (const { id, m } of near) {
    const r = await get(`${dataPath}?id_station=${encodeURIComponent(id)}&date=${encodeURIComponent(date)}&format=json`)
    console.log(`\n--- ${dataPath} id_station=${id} (${m.name || ''}) -> HTTP ${r.status}`)
    if (!r.ok) { console.log(`  ${r.text.slice(0, 300)}`); continue }

    let body: unknown
    try { body = JSON.parse(r.text) } catch { console.log(`  not JSON: ${r.text.slice(0, 200)}`); continue }
    const rows = Array.isArray(body) ? body : [body]
    if (!rows.length || !rows[0] || typeof rows[0] !== 'object') { console.log(`  empty: ${r.text.slice(0, 200)}`); continue }

    // THE POINT OF THE SCRIPT: one row, verbatim.
    console.log('  raw row:')
    console.log(JSON.stringify(rows[0], null, 2).split('\n').map((l) => `    ${l}`).join('\n'))
    Object.keys(rows[0] as object).forEach((k) => seen.add(k))

    const out: WindObs[] = parseMfMarine(rows, kind, meta)
    if (!out.length) {
      console.log('  !! parseMfMarine produced NOTHING from this row.')
      console.log('     Compare the keys above against MF_KEYS in src/lib/windObs.ts.')
      continue
    }
    for (const o of out) {
      const ageMin = (Date.now() - Date.parse(o.t)) / 60000
      const rawFf = (rows[0] as Record<string, unknown>).ff
      console.log(`  parsed: ${o.twsKn.toFixed(1)} kn from ${o.twdDeg ?? '--'}deg` +
        `${o.gustKn != null ? `, gust ${o.gustKn.toFixed(1)} kn` : ''}  @ ${o.t}  (${ageMin.toFixed(0)} min old)`)
      if (typeof rawFf === 'number') {
        console.log(`          units check: raw ${rawFf} -> ${(rawFf * MS_TO_KN).toFixed(1)} kn as m/s` +
          `, or ${(rawFf / 3.6 * MS_TO_KN).toFixed(1)} kn if that number were km/h`)
      }
      if (ageMin < -5) console.log('          !! NEGATIVE AGE -- the stamp is in the future. Timezone, not delay.')
      else if (ageMin > 180) console.log('          !! over 3 h old -- stale, or the stamp is being read an hour out.')
    }
  }
}

async function main() {
  await probe('buoy')
  await probe('ship')

  console.log(`\n${'='.repeat(72)}\n=== every field name seen\n${'='.repeat(72)}`)
  console.log('  ' + (Array.from(seen).sort().join(', ') || '(none -- nothing parsed)'))
  console.log(`
Next: cut MF_KEYS in src/lib/windObs.ts down to the names above, and replace the
MF_BUOY fixture in src/lib/__tests__/windObs.test.ts with a real row from this
output (trimmed to the fields the adapter reads, values untouched).`)
}

main().catch((e) => { console.error(e); process.exit(1) })
