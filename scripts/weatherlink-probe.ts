// What does a Davis WeatherLink account actually answer with?
//
//   npx vite-node scripts/weatherlink-probe.ts
//   npx vite-node scripts/weatherlink-probe.ts -- --key K --secret S
//
// Read-only. Nothing to --write.
//
// WHY IT EXISTS. The adapter in src/lib/windObs.ts was written against the v2
// docs, not against a payload, because this needs an account key and there was
// none. Two things are therefore GUESSES, and both fail quietly:
//
//   UNITS. Davis hardware is natively mph and the v2 API serves US units, so
//   the adapter multiplies by 0.868976. No page in their docs says so. mph read
//   as knots is only 1.15x — small enough to look plausible all season, which
//   is exactly how a unit error survives. The probe prints the raw number
//   against all three readings; a sea breeze should be 10-18 kn, not 9 or 20.
//
//   FIELD NAMES. A Vantage console and a WeatherLink Live use different names
//   for the same quantity. A station answering with the generation we do not
//   list simply VANISHES from the map with nothing to say why, so every wind-
//   looking field in the payload is printed, read or not.
//
// AUTH, which is itself a trap: the key is a QUERY PARAMETER and the secret an
// X-Api-Secret HEADER. Send the secret any other way and it drops onto a legacy
// signed path that 401s about a timestamp being outside 300 seconds — which
// reads like a clock problem and is not one.

import { readFileSync, existsSync } from 'node:fs'
import { parseWeatherLinkStations, parseWeatherLinkCurrent } from '../src/lib/windObs'

const argv = process.argv.slice(2)
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const envPath = new URL('../.env.local', import.meta.url)
const env: Record<string, string> = existsSync(envPath)
  ? Object.fromEntries(
      readFileSync(envPath, 'utf8')
        .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
    )
  : {}

const KEY = flag('key') || env.WEATHERLINK_API_KEY
const SECRET = flag('secret') || env.WEATHERLINK_API_SECRET
if (!KEY || !SECRET) {
  console.error(`Need both WEATHERLINK_API_KEY and WEATHERLINK_API_SECRET in .env.local,
or --key K --secret S.

Get them from weatherlink.com -> Account -> API keys (v2). The account only
sees stations it OWNS, ones SHARED with it, or public ones it has paid to
upgrade — so a club must share its station with this account before it appears.`)
  process.exit(1)
}

const BASE = 'https://api.weatherlink.com/v2'
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const MPH_TO_KN = 0.868976

async function get(path: string): Promise<unknown | null> {
  const sep = path.includes('?') ? '&' : '?'
  const r = await fetch(`${BASE}${path}${sep}api-key=${encodeURIComponent(KEY!)}`, {
    headers: { 'X-Api-Secret': SECRET!, 'User-Agent': UA },
  })
  const text = await r.text()
  if (!r.ok) {
    console.log(`  ${path} -> HTTP ${r.status}  ${text.slice(0, 200)}`)
    if (/timestamp/i.test(text)) {
      console.log('     "timestamp" here is NOT a clock problem: it means the secret')
      console.log('     did not arrive as the X-Api-Secret header, so a legacy signed')
      console.log('     path was used instead.')
    }
    return null
  }
  try { return JSON.parse(text) } catch { console.log(`  not JSON: ${text.slice(0, 200)}`); return null }
}

const WINDISH = /wind|gust/i

async function main() {
  console.log(`${'='.repeat(72)}\n=== STATIONS this key can see\n${'='.repeat(72)}`)
  const sPayload = await get('/stations')
  if (!sPayload) return
  const stations = parseWeatherLinkStations(sPayload)
  console.log(`  ${stations.size} station(s)`)
  for (const st of Array.from(stations.values())) {
    console.log(`    ${st.id.padEnd(10)} ${(st.name || '').slice(0, 34).padEnd(34)} ` +
      `${st.lat != null ? st.lat.toFixed(4) : '   --  '},${st.lon != null ? st.lon.toFixed(4) : '  --  '}`)
    if (st.lat == null || st.lon == null) {
      console.log('        !! no position in /stations — the adapter cannot place this one.')
    }
  }
  if (!stations.size) {
    console.log('  Nothing. A club must SHARE its station with this account first.')
    return
  }

  console.log(`\n${'='.repeat(72)}\n=== CURRENT readings\n${'='.repeat(72)}`)
  for (const st of Array.from(stations.values())) {
    const cur = await get(`/current/${encodeURIComponent(st.id)}`)
    if (!cur) continue
    console.log(`\n--- ${st.id} ${st.name || ''}`)

    // Every wind-looking field, read or not: a name we do not list is the
    // difference between a barb and a silent absence.
    const sensors = Array.isArray((cur as { sensors?: unknown }).sensors) ? (cur as { sensors: unknown[] }).sensors : []
    let anyWind = false
    for (const sRaw of sensors) {
      const data = Array.isArray((sRaw as { data?: unknown })?.data) ? (sRaw as { data: unknown[] }).data : []
      for (const dRaw of data) {
        if (!dRaw || typeof dRaw !== 'object') continue
        const d = dRaw as Record<string, unknown>
        const windFields = Object.keys(d).filter((k) => WINDISH.test(k))
        if (!windFields.length) continue
        anyWind = true
        const dst = (sRaw as Record<string, unknown>).data_structure_type
        console.log(`  sensor data_structure_type=${dst ?? '?'}  ts=${d.ts}`)
        for (const k of windFields.sort()) console.log(`     ${k.padEnd(36)} ${String(d[k])}`)
      }
    }
    if (!anyWind) { console.log('  no wind fields at all — temperature/rain station.'); continue }

    const o = parseWeatherLinkCurrent(cur, stations)
    if (!o) {
      console.log('  !! parseWeatherLinkCurrent produced NOTHING despite wind fields above.')
      console.log('     Compare those names against WL_KEYS in src/lib/windObs.ts — this is')
      console.log('     exactly how a station goes silently missing.')
      continue
    }
    const age = (Date.now() - Date.parse(o.t)) / 60000
    console.log(`  parsed: ${o.twsKn.toFixed(1)} kn from ${o.twdDeg ?? '--'}deg` +
      `${o.gustKn != null ? `, gust ${o.gustKn.toFixed(1)}` : ''}  (${age.toFixed(0)} min old)`)
    if (age < -5) console.log('     !! NEGATIVE AGE — ts is not epoch seconds, or it is not UTC.')

    const raw = o.twsKn / MPH_TO_KN
    console.log(`  UNITS CHECK: raw ${raw.toFixed(1)} -> ${(raw * MPH_TO_KN).toFixed(1)} kn as mph` +
      `, ${raw.toFixed(1)} kn if already knots, ${(raw * 1.943844).toFixed(1)} kn if m/s`)
    console.log('     Pick the one that matches what it is actually doing outside.')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
