// scripts/sailmedia-lidar-check.ts
// ─────────────────────────────────────────────────────────────────────────────
// What the sail-media grid's Lidar column will show for a day, and why.
//
//   npx vite-node scripts/sailmedia-lidar-check.ts --date 2026-09-26
//   npx vite-node scripts/sailmedia-lidar-check.ts --date 2026-09-26 --boat "Northstar 76"
//
// READ-ONLY. Reads .env.local; run OUTSIDE Claude Code's Bash sandbox.
//
// The column is the product of three things agreeing — the instrument measured
// a head, the sail was UP, and the phase fell in a band — and when a cell is
// empty only one of them is at fault. Guessing which from the grid means
// opening every sail in turn; this says it in one pass, per mode as the card
// now splits them.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { expandPhases, type StoredPhase } from '../src/lib/seasonCurves'
import { lidarKindsIn, LIDAR_SAILS } from '../src/lib/lidarTables'
import { twsBand } from '../src/lib/sailMedia'
import { lidarSailOf } from '../src/lib/sailMediaLoad'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const DATE = flag('--date')
const BOAT = flag('--boat')
if (!DATE) {
  console.error('usage: --date 2026-09-26 [--boat "Northstar 76"]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const MODES = [['up', 'upwind'], ['reach', 'reaching'], ['down', 'downwind']] as const

async function main() {
  const { data: boats, error: bErr } = await sb.from('boats').select('id, name')
  if (bErr) { console.error(`boats: ${bErr.message}`); process.exit(1) }
  const boat = BOAT
    ? (boats ?? []).find((b) => b.name.toLowerCase() === BOAT.toLowerCase())
    : (boats ?? [])[0]
  if (!boat) { console.error(`no boat called "${BOAT}"`); process.exit(1) }

  const { data: rows, error: pErr } = await sb
    .from('session_phase_stats').select('date, phases').eq('date', DATE).eq('boat_id', boat.id)
  if (pErr) { console.error(`session_phase_stats: ${pErr.message}`); process.exit(1) }

  const phases = expandPhases((rows?.[0]?.phases ?? []) as StoredPhase[])
  console.log(`${boat.name} · ${DATE} · ${phases.length} phases stored\n`)
  if (!phases.length) {
    console.log('No phases for that day, so the Lidar column will be empty for every sail.')
    console.log("Build the day's phases first; lidar reaches them via `npm run lidar:import`.")
    return
  }

  // Which heads ran at all. This is the FIRST of the three things, and the one
  // that is nothing to do with any particular sail.
  const heads = new Map<string, number>()
  for (const p of phases) for (const k of lidarKindsIn(p.mean)) heads.set(k, (heads.get(k) ?? 0) + 1)
  console.log('lidar heads that reported:')
  for (const { sail, label } of LIDAR_SAILS) {
    const n = heads.get(sail) ?? 0
    console.log(`  ${label.padEnd(11)} ${sail.padEnd(4)} ${n ? `${n} phases` : 'nothing — no column for these sails'}`)
  }

  // Then the bands and modes those phases fall in — what the grid rows and the
  // card's sections will be.
  console.log('\nby wind band and point of sail (before the sail-up test):')
  for (const { sail, label } of LIDAR_SAILS) {
    const mine = phases.filter((p) => lidarKindsIn(p.mean).includes(sail))
    if (!mine.length) continue
    console.log(`\n  ${label} (${sail}) — ${mine.length} phases`)
    const bands = new Map<string, Map<string, number>>()
    for (const p of mine) {
      const b = twsBand(p.mean.tws ?? null).label
      if (!bands.has(b)) bands.set(b, new Map())
      const m = bands.get(b)!
      m.set(p.mode, (m.get(p.mode) ?? 0) + 1)
    }
    for (const [band, m] of Array.from(bands).sort()) {
      const split = MODES.map(([k, l]) => (m.get(k) ? `${m.get(k)} ${l}` : null)).filter(Boolean).join(', ')
      console.log(`    ${band.padEnd(14)} ${split}`)
    }
  }

  // And which sails those heads describe, so an empty column can be told from a
  // sail the instrument never measures.
  const { data: sails } = await sb
    .from('sails').select('id, name, kind, retired').eq('boat_id', boat.id)
  console.log('\nsails, and the head that measures each:')
  for (const s of (sails ?? []).filter((x) => !x.retired)) {
    const kind = lidarSailOf(s.kind)
    const n = kind ? (heads.get(kind) ?? 0) : 0
    console.log(`  ${String(s.name).padEnd(18)} ${String(s.kind ?? '—').padEnd(11)} → `
      + (kind ? `${kind}, ${n} phases that day` : 'no lidar head — the column is deliberately absent'))
  }

  console.log('\nThe grid then keeps only the phases each sail was UP for, from the day\'s')
  console.log('sail-change tags when it has them and the event file otherwise — so a number')
  console.log('above is an upper bound, and a smaller one in the grid is that test working.')
}
main()
