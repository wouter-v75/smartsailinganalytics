// The moat, counted. How many hours of PAIRED data do we hold — measured wind
// (twd/tws from a real masthead unit) on the same boat, same second, as the raw
// GPS track a dinghy would produce?
//
//   npx vite-node scripts/twd-groundtruth.ts            the inventory
//   …  --json                                           for the deck
//   …  --boat "Northstar 76"                            one boat
//
// Why this script exists. The GPS-only path has to manufacture twd/tws/twa from
// a track alone (docs/dinghy-gps-prior-art-and-twd-2026-09.md). Training and
// honestly benchmarking that needs rows where the truth is present ALONGSIDE the
// track — which only an instrumented boat produces, and which SSA gets for free
// from its yacht customers. That is the asset; this counts it.
//
// The public bar to beat is RaceQs: 3–5° from a single boat, ~1° from five.
// Count against that, and count MANOEUVRES as well as hours: every published
// method (SAP's included) estimates wind from tacks and gybes, so a drifting
// hour is worth far less than a beat full of tacks.
//
// Reads only. Needs .env.local; run OUTSIDE Claude Code's Bash sandbox.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { analyseManoeuvres } from '../src/lib/manoeuvres'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const boatArg = args.includes('--boat') ? args[args.indexOf('--boat') + 1] : null

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => /^[A-Z0-9_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Supabase URL / service key missing in .env.local'); process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// A row is ground truth only when BOTH halves are there and the boat is moving.
// Wind numbers from a stationary boat on the dock are not training data.
const MIN_SOG_KN = 1.5
const TWS_BINS = [
  { label: '< 6 kn', lo: 0, hi: 6 },
  { label: '6–10', lo: 6, hi: 10 },
  { label: '10–14', lo: 10, hi: 14 },
  { label: '14–18', lo: 14, hi: 18 },
  { label: '18–25', lo: 18, hi: 25 },
  { label: '> 25', lo: 25, hi: 999 },
]

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
const rpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s)

type Acc = {
  boat: string; team: string
  days: number; pairedDays: number
  rows: number; pairedRows: number
  hours: number; pairedHours: number
  tws: number[]; twaUp: number; twaReach: number; twaDown: number
  tacks: number; gybes: number; pairedManoeuvres: number
  dates: string[]
}

async function main() {
  const { data: teams } = await sb.from('teams').select('id, name')
  const { data: boats } = await sb.from('boats').select('id, team_id, name')
  const { data: sess } = await sb.from('sessions').select('id, team_id, boat_id, date').order('date')
  const tn = new Map((teams ?? []).map(t => [t.id, t.name as string]))
  const bnm = new Map((boats ?? []).map(b => [b.id, b.name as string]))

  const acc = new Map<string, Acc>()
  const key = (s: { team_id: string; boat_id: string }) =>
    `${tn.get(s.team_id) ?? '?'} / ${bnm.get(s.boat_id) ?? '?'}`

  // Every boat gets a row, even with no logs at all — a boat recording nothing
  // is the finding, not an omission.
  for (const b of boats ?? []) {
    const k = `${tn.get(b.team_id) ?? '?'} / ${b.name}`
    if (boatArg && !k.toLowerCase().includes(boatArg.toLowerCase())) continue
    acc.set(k, {
      boat: b.name as string, team: tn.get(b.team_id) ?? '?',
      days: 0, pairedDays: 0, rows: 0, pairedRows: 0, hours: 0, pairedHours: 0,
      tws: [], twaUp: 0, twaReach: 0, twaDown: 0,
      tacks: 0, gybes: 0, pairedManoeuvres: 0, dates: [],
    })
  }

  for (const s of sess ?? []) {
    const k = key(s)
    const e = acc.get(k)
    if (!e) continue
    e.days++
    // One session at a time: a day's log_data is ~2.5 MB of JSONB.
    const { data } = await sb.from('sessions').select('log_data, xml_data').eq('id', s.id).single()
    const ld: any = data?.log_data
    const rows: any[] = Array.isArray(ld) ? ld : (ld?.rows ?? [])
    if (!rows.length) continue

    // Median sample interval → each row's share of the clock.
    const gaps: number[] = []
    for (let i = 1; i < Math.min(rows.length, 400); i++) {
      const g = num(rows[i]?.utc)! - num(rows[i - 1]?.utc)!
      if (g > 0 && g < 60_000) gaps.push(g)
    }
    gaps.sort((a, b) => a - b)
    const dtMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1000

    let paired = 0
    for (const r of rows) {
      const lat = num(r.lat), lon = num(r.lon), sog = num(r.sog)
      const twd = num(r.twd), tws = num(r.tws), twa = num(r.twa)
      if (lat == null || lon == null || sog == null) continue
      if (sog < MIN_SOG_KN) continue
      if (twd == null || tws == null) continue
      paired++
      e.tws.push(tws)
      const a = twa == null ? null : Math.abs(twa)
      if (a != null) {
        if (a < 60) e.twaUp++
        else if (a < 120) e.twaReach++
        else e.twaDown++
      }
    }

    e.rows += rows.length
    e.hours += (rows.length * dtMs) / 36e5
    e.pairedRows += paired
    e.pairedHours += (paired * dtMs) / 36e5
    if (paired > 0) { e.pairedDays++; e.dates.push(s.date) }

    // Manoeuvres — the unit every published wind estimator actually trains on.
    try {
      const mans = analyseManoeuvres(rows as any, data?.xml_data ?? null)
      for (const m of mans) {
        if (m.kind === 'tack') e.tacks++; else if (m.kind === 'gybe') e.gybes++
      }
      if (paired > 0) e.pairedManoeuvres += mans.length
    } catch { /* a day the detector cannot read is not fatal to the count */ }
  }

  const rows = Array.from(acc.values()).sort((a, b) => b.pairedHours - a.pairedHours)
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return }

  const H = (s: string) => `\n\x1b[1m${s}\x1b[0m`
  console.log(H(`TWD ground truth — paired measured-wind + GPS, ${new Date().toISOString().slice(0, 10)}`))
  console.log(pad('team / boat', 26) + rpad('days', 6) + rpad('paired', 8) + rpad('log h', 8) +
    rpad('PAIRED h', 10) + rpad('tacks', 7) + rpad('gybes', 7) + '  verdict')
  for (const r of rows) {
    const verdict = r.pairedHours >= 100 ? 'ground truth'
      : r.pairedHours > 0 ? 'thin — keep logging'
        : r.days > 0 ? '← NO LOGS: days recorded, nothing to learn from'
          : 'no days'
    console.log(pad(`${r.team} / ${r.boat}`, 26) + rpad(String(r.days), 6) + rpad(String(r.pairedDays), 8) +
      rpad(r.hours.toFixed(1), 8) + rpad(r.pairedHours.toFixed(1), 10) +
      rpad(String(r.tacks), 7) + rpad(String(r.gybes), 7) + '  ' + verdict)
  }

  const tot = rows.reduce((a, r) => ({
    h: a.h + r.pairedHours, m: a.m + r.pairedManoeuvres,
    tws: a.tws.concat(r.tws), up: a.up + r.twaUp, reach: a.reach + r.twaReach, down: a.down + r.twaDown,
  }), { h: 0, m: 0, tws: [] as number[], up: 0, reach: 0, down: 0 })

  console.log(H('Coverage of the wind range — where the model will be weak'))
  const n = tot.tws.length || 1
  for (const b of TWS_BINS) {
    const c = tot.tws.filter(v => v >= b.lo && v < b.hi).length
    const pct = (100 * c / n)
    console.log('  ' + pad(b.label, 9) + rpad(pct.toFixed(1) + '%', 7) + '  ' + '█'.repeat(Math.round(pct / 2)) +
      (pct < 5 ? '  ← thin' : ''))
  }
  const ang = tot.up + tot.reach + tot.down || 1
  console.log(`\n  upwind ${(100 * tot.up / ang).toFixed(0)}%  ·  reaching ${(100 * tot.reach / ang).toFixed(0)}%  ·  downwind ${(100 * tot.down / ang).toFixed(0)}%`)

  console.log(H('Against the bar'))
  console.log(`  paired hours            ${tot.h.toFixed(1)}`)
  console.log(`  paired manoeuvres       ${tot.m}   ← the unit a manoeuvre-based estimator trains on`)
  console.log(`  target for a first model  100–300 paired hours, several hundred manoeuvres,`)
  console.log(`                            spread across the wind bins above`)
  console.log(`  benchmark to beat         RaceQs: 3–5° single boat, ~1° with five boats\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
