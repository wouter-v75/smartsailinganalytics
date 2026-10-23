// Import ISPRA's Rete Mareografica Nazionale wind archive into wind_observations.
//
//   npx vite-node scripts/ispra-rmn-import.ts                      what it would do
//   npx vite-node scripts/ispra-rmn-import.ts -- --write           do it
//   npx vite-node scripts/ispra-rmn-import.ts -- --venue st-tropez --write
//   npx vite-node scripts/ispra-rmn-import.ts -- --from 201401 --to 202310 --write
//   npx vite-node scripts/ispra-rmn-import.ts -- --station napoli --write
//
// Dry run by default, like every script here. Runs on the laptop: it needs the
// network and the service key.
//
// WHY THIS EXISTS. The verification literature puts a local wind MOS fit at
// 365-1816 days of record (see docs/wind-model-verification-and-mos.md), and
// SSA's own observations start the day the poller did. This is thirteen years
// of 10-minute coastal wind that already exists, CC-BY-4.0, with a DECLARED
// anemometer height and a DECLARED 10-minute averaging period — the two things
// every other station in the network is missing.
//
// HOW IT FINDS THE DATA. The SPARQL endpoint is a catalogue, not a data store:
// each monthly series carries hasMedia -> a Media resource -> hasDownloadURL,
// a CSV at rep.isprambiente.it. The URLs are predictable
// (<station>_wind_<YYYYMM>.csv) and they are NOT guessed anyway — the
// catalogue is asked, because a URL that is predictable today is a 404 waiting
// to happen, and one of them already is: the catalogue lists
// napoli_wind_202310.csv and the repository does not serve it.
//
// ARCHIVE ROWS ARE EXEMPT FROM RETENTION. They are written with archive=TRUE
// (migration 0103) and the poller's sweep skips those. Without that the next
// poll deletes a 2014 import inside half an hour, and it would look like the
// import had worked.
//
// VALIDATION LEVEL IS RECORDED, NOT ASSUMED. Everything here is ISPRA's L0
// real-time series: hasValidationLevel = l0, explicitly unvalidated, with
// their own notice that it may contain errors not attributable to them. Stored
// as validated=FALSE so it can never be silently averaged with a validated
// series when something is fitted.
//
// WHAT TO HOLD AGAINST THE DATA. The stations are inside port structures —
// sheltered, WMO class 4/5, good for climatology and timing and a poor target
// for an absolute bias fit. And the position is the PLATFORM's (the tide
// gauge); the met pole can stand elsewhere, as Ancona's does.

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { VENUES, VENUE_NM } from '../src/lib/obsSources'
import { nmBetween } from '../src/lib/obsDensity'
import { parseIspraWindCsv, ispraHeightFromDeployment, type IspraStation } from '../src/lib/ispraRmn'
import { obsRow } from '../src/lib/obsSources'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const ONLY_VENUE = flag('venue', '')!
const ONLY_STATION = flag('station', '')!
const FROM = flag('from', '201401')!
const TO = flag('to', '209912')!
const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const SPARQL = 'https://dati.isprambiente.it/sparql'

const env: Record<string, string> = (() => {
  const p = new URL('../.env.local', import.meta.url)
  if (!existsSync(p)) return {}
  return Object.fromEntries(
    readFileSync(p, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
  )
})()

async function sparql(query: string): Promise<Array<Record<string, string>>> {
  const r = await fetch(`${SPARQL}?query=${encodeURIComponent(query)}`, {
    headers: { accept: 'application/sparql-results+json', 'User-Agent': UA },
  })
  if (!r.ok) throw new Error(`sparql ${r.status}`)
  const j = await r.json() as { results: { bindings: Array<Record<string, { value: string }>> } }
  return j.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])))
}

const P = 'https://w3id.org/italia/env/onto'
const WIND_PARAM = 'https://w3id.org/italia/env/ld/common/observationparameter/wind'

async function main() {
  // ── 1. the stations, with their platform position and declared height ──────
  process.stdout.write('asking the catalogue for wind stations… ')
  const rows = await sparql(`
    SELECT DISTINCT ?slugUrl ?name ?lat ?lon ?deployment WHERE {
      ?series <${P}/inspire-mf/hasObservationParameter> <${WIND_PARAM}> ;
              <${P}/inspire-mf/isObservationMadeBySensor> ?sensor ;
              <${P}/top/hasMedia> ?media .
      ?media  <${P}/top/hasDownloadURL> ?slugUrl .
      ?sensor <${P}/inspire-mf/isHostedBy> ?platform ;
              <${P}/inspire-mf/hasSystemDeployment> ?deployment .
      ?platform <${P}/top/name> ?name ;
                <http://www.w3.org/2003/01/geo/wgs84_pos#lat> ?lat ;
                <http://www.w3.org/2003/01/geo/wgs84_pos#long> ?lon .
      FILTER(CONTAINS(STR(?deployment), "measurement_height"))
    } LIMIT 4000`)

  const stations = new Map<string, IspraStation>()
  for (const r of rows) {
    const file = r.slugUrl.split('/').pop() || ''
    const slug = file.split('_wind_')[0]
    if (!slug || stations.has(slug)) continue
    const lat = Number(r.lat); const lon = Number(r.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    stations.set(slug, {
      slug, name: r.name, lat, lon, heightM: ispraHeightFromDeployment(r.deployment),
    })
  }
  console.log(`${stations.size} station(s) with wind`)

  // ── 2. keep the ones near somewhere we sail ───────────────────────────────
  const venues = ONLY_VENUE
    ? VENUES.filter((v) => v.key === ONLY_VENUE.toLowerCase())
    : VENUES
  if (ONLY_VENUE && !venues.length) {
    console.error(`\nNo venue keyed ${JSON.stringify(ONLY_VENUE)}. They are:`)
    for (const v of VENUES) console.error(`  ${v.key.padEnd(14)} ${v.name}`)
    process.exit(1)
  }

  const near: Array<IspraStation & { venue: string; nm: number }> = []
  for (const st of Array.from(stations.values())) {
    if (ONLY_STATION && st.slug !== ONLY_STATION.toLowerCase()) continue
    let best = ''; let bd = Infinity
    for (const v of venues) {
      const d = nmBetween(v.lat, v.lon, st.lat, st.lon)
      if (d < bd) { bd = d; best = v.key }
    }
    if (bd <= VENUE_NM) near.push({ ...st, venue: best, nm: +bd.toFixed(1) })
  }
  near.sort((a, b) => a.nm - b.nm)

  console.log(`\n${near.length} within ${VENUE_NM} nm of a venue:`)
  for (const s of near) {
    console.log(`  ${s.nm.toFixed(1).padStart(5)} nm  ${s.venue.padEnd(13)} ${s.slug.padEnd(18)}`
      + ` ${s.name.padEnd(20)} height ${s.heightM == null ? '  ?' : `${s.heightM} m`}`)
  }
  if (!near.length) {
    console.log('\nNothing near a venue. ISPRA has no station in NE Sardinia, so Porto Cervo')
    console.log('gets nothing from this source however wide the radius.')
    return
  }

  // ── 3. the monthly files for those stations ───────────────────────────────
  const slugs = near.map((s) => s.slug)
  const files = await sparql(`
    SELECT ?u WHERE {
      ?media <${P}/top/hasDownloadURL> ?u .
      FILTER(CONTAINS(STR(?u), "_wind_") && CONTAINS(STR(?u), "/rmn/"))
    } LIMIT 20000`)
  const wanted = files
    .map((r) => r.u)
    .filter((u) => {
      const f = u.split('/').pop() || ''
      const [slug, rest] = f.split('_wind_')
      const month = (rest || '').replace('.csv', '')
      return slugs.includes(slug) && month >= FROM && month <= TO
    })
    .sort()
  console.log(`\n${wanted.length} monthly file(s) in ${FROM}..${TO}`)
  if (!WRITE) {
    console.log('\n(dry run — add --write to fetch and store)')
    console.log(`first: ${wanted[0] ?? '-'}`)
    console.log(`last:  ${wanted[wanted.length - 1] ?? '-'}`)
    return
  }

  const url = env.NEXT_PUBLIC_SUPABASE_URL || ''
  const svc = env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !svc) { console.error('\nNEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env.local'); process.exit(1) }
  const sb = createClient(url, svc, { auth: { persistSession: false } })

  let stored = 0; let missing = 0; let empty = 0
  for (const [i, u] of Array.from(wanted.entries())) {
    const f = u.split('/').pop() || ''
    const slug = f.split('_wind_')[0]
    const st = near.find((s) => s.slug === slug)!
    let obs
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA } })
      if (!r.ok) {
        // The catalogue lists files the repository does not serve; napoli
        // 202310 is one. Counted, not fatal.
        missing++
        console.log(`  [${i + 1}/${wanted.length}] ${f}  HTTP ${r.status}`)
        continue
      }
      obs = parseIspraWindCsv(await r.text(), st)
    } catch (e) {
      missing++
      console.log(`  [${i + 1}/${wanted.length}] ${f}  ${(e as Error).message}`)
      continue
    }
    if (!obs.length) { empty++; console.log(`  [${i + 1}/${wanted.length}] ${f}  no usable rows`); continue }

    const batch = obs.map((o) => ({ ...obsRow(o), archive: true, validated: false }))
    for (let k = 0; k < batch.length; k += 1000) {
      const chunk = batch.slice(k, k + 1000)
      const { error } = await sb.from('wind_observations').upsert(chunk, { onConflict: 'station_id,t' })
      if (error) {
        console.error(`\nupsert failed on ${f}: ${error.message}`)
        if (/archive|validated/.test(error.message)) {
          console.error('Paste supabase/migrations/0103_wind_observations_archive.sql first.')
        }
        process.exit(1)
      }
      stored += chunk.length
    }
    process.stdout.write(`\r  [${i + 1}/${wanted.length}] ${f}  ${obs.length} rows — ${stored.toLocaleString('en-GB')} stored  `)
  }
  console.log(`\n\n${stored.toLocaleString('en-GB')} row(s) stored, ${missing} file(s) unavailable, ${empty} empty.`)
  console.log('All marked archive=true, so the poller\'s retention sweep will not prune them,')
  console.log('and validated=false, because ISPRA publish these as level L0.')
}

main().catch((e) => { console.error(e); process.exit(1) })
