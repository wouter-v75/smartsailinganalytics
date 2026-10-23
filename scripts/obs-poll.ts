// Fetch the public wind networks and report what they say — the same gathering
// the poller route does, run by hand.
//
//   npx vite-node scripts/obs-poll.ts                 dry run: fetch, report, store nothing
//   npx vite-node scripts/obs-poll.ts -- --write      store it
//   npx vite-node scripts/obs-poll.ts -- --only ndbc,metar
//
// Needs the network and, to --write, the service key — so it runs on the
// laptop, never inside Claude Code's sandbox.
//
// IN PRODUCTION THIS IS NOT WHAT RUNS. /api/obs/poll does, called every 15
// minutes by cron on the regatta box or by Vercel Cron; the box has no Node and
// 2.6 GB free, so a second toolchain there to run one fetch was a poor trade.
// Both use lib/obsSources.ts, so there is one definition of which networks and
// which venues, and the two cannot drift.
//
// What this is FOR: seeing the sources' own numbers before trusting them —
// how many stations each network gave, how many survived the venue filter, and
// which venue got what. A source that has quietly died shows up here as a row
// of zeros rather than as a thinner map three weeks later.

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { collectObservations, obsRow, VENUES, VENUE_NM, SOURCE_NAMES, type SourceName } from '../src/lib/obsSources'
import { withinNm } from '../src/lib/windObs'

const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
// Three years — see the comment on RETAIN_DAYS in src/app/api/obs/poll/route.ts.
// A local wind MOS fit needs 365-1816 days, and the upstream networks keep
// between nothing and 45 days, so a day not stored is gone for good.
const RETAIN_DAYS = Number(flag('retain', '1095'))

const env: Record<string, string> = (() => {
  const p = new URL('../.env.local', import.meta.url)
  if (!existsSync(p)) return {}
  return Object.fromEntries(
    readFileSync(p, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
  )
})()
// The source runners read FFVL_API_KEY from the environment, as they do on the
// server; .env.local is not loaded for us out here.
for (const k of ['FFVL_API_KEY', 'METEOFRANCE_API_KEY']) if (env[k] && !process.env[k]) process.env[k] = env[k]

async function main() {
  const onlyRaw = (flag('only') || '').split(',').map((s) => s.trim()).filter(Boolean)
  const only = (onlyRaw.length
    ? onlyRaw.filter((n): n is SourceName => (SOURCE_NAMES as string[]).includes(n))
    : SOURCE_NAMES)

  const { obs, results } = await collectObservations(only)
  for (const r of results) {
    console.log(r.error
      ? `  ${r.name.padEnd(9)} FAILED: ${r.error}  (${r.ms} ms)`
      : `  ${r.name.padEnd(9)} ${String(r.total).padStart(5)} station(s) -> ${String(r.kept).padStart(4)} near a venue  (${r.ms} ms)`)
  }

  const fresh = obs.filter((o) => Date.now() - Date.parse(o.t) < 6 * 3600_000).length
  console.log(`\n  ${obs.length} row(s), ${fresh} of them under 6 h old`)
  for (const { name, lat: la, lon: lo } of VENUES) {
    const near = withinNm(obs, la, lo, VENUE_NM)
    const wind = near.filter((o) => o.twsKn > 0).length
    console.log(`    ${name.padEnd(24)} ${String(near.length).padStart(3)} station(s), ${wind} with wind`)
  }

  if (!WRITE) { console.log('\n  DRY RUN — nothing stored. Add --write.'); return }

  const url = env.NEXT_PUBLIC_SUPABASE_URL || ''
  const svc = env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !svc) { console.error('Supabase URL / service key missing in .env.local.'); process.exit(1) }
  const sb = createClient(url, svc, { auth: { persistSession: false } })

  const rows = obs.map(obsRow)
  let stored = 0
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error } = await sb.from('wind_observations').upsert(chunk, { onConflict: 'station_id,t' })
    if (error) { console.error(`  upsert failed: ${error.message}`); process.exit(1) }
    stored += chunk.length
  }
  console.log(`  stored ${stored} row(s)`)

  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400_000).toISOString()
  const { error: delErr, count } = await sb.from('wind_observations')
    .delete({ count: 'exact' }).lt('t', cutoff)
  if (delErr) console.error(`  retention sweep failed: ${delErr.message}`)
  else console.log(`  retention: removed ${count ?? 0} row(s) older than ${RETAIN_DAYS} days`)
}

main().catch((e) => { console.error(e); process.exit(1) })
