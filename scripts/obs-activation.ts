// Which venues are watched densely, and when.
//
//   npx vite-node scripts/obs-activation.ts
//        read-only: the stored windows, what each venue is doing RIGHT NOW,
//        and what it costs. Run this to see the state of things.
//
//   npx vite-node scripts/obs-activation.ts -- --venue st-tropez \
//     --from 2027-09-25 --to 2027-10-04 --reason "Les Voiles de Saint-Tropez"
//        dry run of adding a window. Add --write to store it.
//
//   npx vite-node scripts/obs-activation.ts -- --delete <id> --write
//
// WHY THIS EXISTS rather than an INSERT. A regatta's dates are the one thing
// about this feature a person touches, and hand-written SQL gets two things
// wrong that cost a whole regatta's observations with nothing to show for it:
//
//   THE VENUE KEY. It is deliberately not a foreign key — the venue list lives
//   in code, with the positions and the graded options — so 'st-tropeze' or
//   'St Tropez' inserts happily and simply never matches. This refuses a key
//   that is not in VENUES and prints the ones that are.
//
//   THE TIMEZONE. '2027-09-25' with no offset is midnight UTC, which is 02:00
//   local at a Mediterranean venue, so the first morning of the regatta is
//   outside the window. Dates here are read as venue-LOCAL from the venue's
//   own position and the offset used is printed. Every other clock in this
//   project is local even when it is called UTC; this one says which it is.
//
// It also prints the station counts, so "is this worth it" and "what does it
// cost" are answered in the same place as "when is it".

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import {
  VENUES, stationsForPoll, POLL_EVERY_MIN, type PollContext,
} from '../src/lib/obsSources'
import {
  decideVenues, windowCovers, FORCE_ALL, type ActivationWindow,
} from '../src/lib/obsActivation'
import { DAVIS_MAP_STATIONS } from '../src/lib/windObsDavisMap'
import { WEATHERFILE_STATIONS } from '../src/lib/windObsWeatherfile'
import { CLUB_FEEDS } from '../src/lib/windObsClubs'
import { offsetFromCoords } from '../src/lib/tzFromCoords'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
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

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL || '',
  env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { persistSession: false } },
)

const REGISTRIES: Array<[string, Array<{ lat: number; lon: number }>]> = [
  ['davis', DAVIS_MAP_STATIONS as Array<{ lat: number; lon: number }>],
  ['weatherfile', WEATHERFILE_STATIONS as Array<{ lat: number; lon: number }>],
  ['clubs', CLUB_FEEDS as Array<{ lat: number; lon: number }>],
]

const countFor = (ctx: PollContext) =>
  REGISTRIES.reduce((n, [, list]) => n + stationsForPoll(list, ctx).length, 0)

const perDay = (n: number) => (n * ((24 * 60) / POLL_EVERY_MIN)).toLocaleString('en-GB')

/** A plain date, read as wall time at the venue, as an ISO instant. */
function venueDayToIso(day: string, endOfDay: boolean, lat: number, lon: number): { iso: string; tz: string; offsetH: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
  if (!m) throw new Error(`--${endOfDay ? 'to' : 'from'} must be YYYY-MM-DD, got ${JSON.stringify(day)}`)
  const h = endOfDay ? 23 : 0
  const mi = endOfDay ? 59 : 0
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], h, mi, 0)
  // The zone comes from the venue's own position, so a Mediterranean regatta
  // is not stored two hours out because somebody typed a bare date.
  const z = offsetFromCoords(lat, lon, guess)
  const tz = z?.zone ?? 'UTC'
  const offMs = (z?.offsetMin ?? 0) * 60_000
  return { iso: new Date(guess - offMs).toISOString(), tz, offsetH: offMs / 3600_000 }
}

async function main() {
  const { data, error } = await sb.from('obs_venue_activation')
    .select('id, venue_key, starts_at, ends_at, reason')
    .order('starts_at', { ascending: true })
  if (error) {
    console.error(`\nCould not read obs_venue_activation: ${error.message}`)
    console.error('If the table is missing, paste supabase/migrations/0102_obs_venue_activation.sql first.')
    process.exit(1)
  }
  const rows = data ?? []
  const windows: ActivationWindow[] = rows.map((r) => ({
    venueKey: String(r.venue_key), startsAt: String(r.starts_at),
    endsAt: String(r.ends_at), reason: r.reason as string | null,
  }))

  const del = flag('delete')
  const venueKey = flag('venue')
  const from = flag('from')
  const to = flag('to')

  if (del) {
    const row = rows.find((r) => String(r.id) === del)
    if (!row) { console.error(`No window with id ${del}.`); process.exit(1) }
    console.log(`\n${WRITE ? 'DELETING' : 'would delete'}: ${row.venue_key}  ${row.starts_at} → ${row.ends_at}  ${row.reason ?? ''}`)
    if (WRITE) {
      const { error: e } = await sb.from('obs_venue_activation').delete().eq('id', del)
      if (e) { console.error(e.message); process.exit(1) }
      console.log('deleted.')
    } else {
      console.log('(dry run — add --write)')
    }
    return
  }

  if (venueKey || from || to) {
    if (!venueKey || !from || !to) {
      console.error('\nAdding a window needs all three: --venue <key> --from YYYY-MM-DD --to YYYY-MM-DD')
      process.exit(1)
    }
    const v = VENUES.find((x) => x.key === venueKey.trim().toLowerCase())
    if (!v) {
      // The whole reason this script exists. A key that matches nothing
      // inserts happily and never fires.
      console.error(`\n${JSON.stringify(venueKey)} is not a venue key. They are:\n`)
      for (const x of VENUES) console.error(`  ${x.key.padEnd(14)} ${x.name}`)
      process.exit(1)
    }
    const a = venueDayToIso(from, false, v.lat, v.lon)
    const b = venueDayToIso(to, true, v.lat, v.lon)
    if (Date.parse(b.iso) <= Date.parse(a.iso)) {
      console.error(`\n--to must be after --from.`); process.exit(1)
    }
    const reason = flag('reason') || null
    console.log(`\n${v.name} (${v.key})`)
    console.log(`  ${from} 00:00 → ${to} 23:59 local in ${a.tz} (UTC${a.offsetH >= 0 ? '+' : ''}${a.offsetH})`)
    console.log(`  stored as ${a.iso} → ${b.iso}`)
    if (reason) console.log(`  reason: ${reason}`)
    const dense = countFor({ venues: decideVenues(VENUES, { force: [v.key] }) })
    const idle = countFor({ venues: decideVenues(VENUES, {}) })
    console.log(`  while it runs: ${dense} stations against ${idle} idle — ${perDay(dense)} requests/day against ${perDay(idle)}`)
    if (!WRITE) { console.log('\n(dry run — add --write to store it)'); return }
    const { error: e } = await sb.from('obs_venue_activation')
      .insert({ venue_key: v.key, starts_at: a.iso, ends_at: b.iso, reason })
    if (e) { console.error(`\ninsert: ${e.message}`); process.exit(1) }
    console.log('\nstored.')
    return
  }

  // Read-only: the state of things.
  const now = Date.now()
  console.log(`\nSTORED WINDOWS (${rows.length})`)
  if (!rows.length) {
    console.log('  none — every venue is idle unless a poll is called with ?domains=<key>')
  }
  for (const r of rows) {
    const w: ActivationWindow = {
      venueKey: String(r.venue_key), startsAt: String(r.starts_at),
      endsAt: String(r.ends_at), reason: r.reason as string | null,
    }
    const live = windowCovers(w, now)
    const known = VENUES.some((v) => v.key === w.venueKey)
    console.log(`  ${live ? '▶ NOW ' : '      '}${w.venueKey.padEnd(14)} ${w.startsAt} → ${w.endsAt}`
      + `  ${w.reason ?? ''}${known ? '' : '   ⚠ NOT A VENUE KEY — this window can never fire'}`)
    if (!live) console.log(`         id ${r.id}`)
  }

  const decided = decideVenues(VENUES, { windows })
  console.log(`\nRIGHT NOW`)
  for (const d of decided) {
    const one = countFor({ venues: decideVenues(VENUES, { force: [d.key] }) })
    console.log(`  ${d.mode === 'dense' ? 'DENSE' : 'idle '}  ${d.key.padEnd(14)}`
      + ` ${String(d.radiusNm).padStart(3)} nm   ${String(one).padStart(3)} stations if dense`
      + `   ${d.reason ?? ''}`)
  }
  const nowCount = countFor({ venues: decided })
  const allDense = countFor({ venues: decideVenues(VENUES, { force: [FORCE_ALL] }) })
  console.log(`\nPOLLING NOW: ${nowCount} stations = ${perDay(nowCount)} requests/day`)
  console.log(`  all dense would be ${allDense} = ${perDay(allDense)} requests/day`)
  console.log(`\nAdd a window:   npx vite-node scripts/obs-activation.ts -- --venue <key> --from YYYY-MM-DD --to YYYY-MM-DD --reason "..." --write`)
  console.log(`Force one poll: /api/obs/poll?domains=<key>`)
}

main().catch((e) => { console.error(e); process.exit(1) })
