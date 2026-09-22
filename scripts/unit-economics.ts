// What a team actually costs to serve. The worksheet behind §5 of
// docs/commercialisation-plan-2026-27.md, as a script you can re-run each quarter.
//
//   npx vite-node scripts/unit-economics.ts              all teams, all time
//   …  --days 90                                         only the last 90 days of activity
//   …  --json                                            machine-readable, for the deck
//
// Reads only. Needs .env.local (Supabase service key + Bunny Stream library key) and
// must run OUTSIDE Claude Code's Bash sandbox — Node's fetch ignores the sandbox proxy
// and every call fails with an opaque network error inside it.
//
// Three sources, each degrading on its own:
//   Supabase        what each team stored and watched (videos.bytes, photos.bytes, sessions)
//   Bunny Stream    library truth for stream storage and delivered traffic
//   RATES below     list prices — CHECK THESE against an actual invoice before quoting anyone

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// ── Rates (USD). List prices, not your invoice. Edit to match reality. ──────
const RATES = {
  edgeStorageGbMonth: 0.01,   // Bunny Edge Storage, SSD, per replicated region
  streamStorageGbMonth: 0.005,
  trafficGb: 0.01,            // Europe/N.America standard tier
  supabaseMonth: 25,          // Pro
  vercelMonth: 20,
  scalewayMonth: 0,           // fill from the Scaleway console
}
const PLANS = [
  { name: 'Programme', yearEur: 9600 },
  { name: 'Squad', yearEur: 3600 },
  { name: 'Coach', yearEur: 1200 },
]
const USD_EUR = 0.92

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dayWindow = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : null

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

const GB = 1024 ** 3
const gb = (bytes: number) => bytes / GB
const usd = (n: number) => `$${n.toFixed(2)}`
const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
const rpad = (s: string, n: number) => s.length >= n ? s : ' '.repeat(n - s.length) + s

const since = dayWindow ? new Date(Date.now() - dayWindow * 864e5).toISOString().slice(0, 10) : null

type Row = Record<string, any>
async function all(table: string, cols: string): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999)
    if (error) { console.error(`  ! ${table}: ${error.message}`); return out }
    out.push(...(data as unknown as Row[]))
    if (!data || data.length < 1000) return out
  }
}

async function streamLibrary() {
  const key = env.BUNNY_STREAM_API_KEY, lib = env.BUNNY_STREAM_LIBRARY_ID
  if (!key || !lib) return null
  const head = { AccessKey: key, accept: 'application/json' }
  try {
    let page = 1, storage = 0, count = 0, seconds = 0, resolutions = new Map<string, number>()
    for (;;) {
      const r = await fetch(`https://video.bunnycdn.com/library/${lib}/videos?page=${page}&itemsPerPage=100`, { headers: head })
      if (!r.ok) throw new Error(`videos ${r.status}`)
      const j: any = await r.json()
      for (const v of j.items ?? []) {
        storage += v.storageSize ?? 0; count++; seconds += v.length ?? 0
        for (const res of String(v.availableResolutions ?? '').split(',').filter(Boolean)) {
          resolutions.set(res, (resolutions.get(res) ?? 0) + 1)
        }
      }
      if (!j.items?.length || page * 100 >= (j.totalItems ?? 0)) break
      page++
    }
    const from = new Date(Date.now() - (dayWindow ?? 365) * 864e5).toISOString().slice(0, 10)
    const to = new Date().toISOString().slice(0, 10)
    let traffic = 0, views = 0
    const s = await fetch(`https://video.bunnycdn.com/library/${lib}/statistics?dateFrom=${from}&dateTo=${to}`, { headers: head })
    if (s.ok) {
      const j: any = await s.json()
      // NB: Bunny Stream's statistics payload carries viewsChart / watchTimeChart /
      // countryViewCounts / engagementScore and NO traffic field, and the counters read
      // zero because playback is served through signed CDN URLs, not Stream's player.
      // Treat this as a ceiling check, never as the delivery number. See playback_events.
      traffic = Object.values<number>(j.trafficUsageChart ?? {}).reduce((a, b) => a + Number(b || 0), 0)
      views = Object.values<number>(j.viewsChart ?? {}).reduce((a, b) => a + Number(b || 0), 0)
    }
    return { storage, count, seconds, traffic, views, resolutions, windowDays: dayWindow ?? 365 }
  } catch (e: any) {
    console.error(`  ! Bunny Stream: ${e.message}`)
    return null
  }
}

async function main() {
  console.error('reading Supabase …')
  const [teams, boats, sessions, videos, photos, memberships, plays, tags, debriefs] = await Promise.all([
    all('teams', 'id, name, created_at'),
    all('boats', 'id, team_id, name'),
    all('sessions', 'id, team_id, boat_id, date, created_at'),
    all('videos', 'id, team_id, session_id, bytes, duration_ms, bunny_stream_id, created_at'),
    all('photos', 'id, team_id, session_id, bytes, analysis_data, created_at'),
    all('memberships', 'user_id, team_id, role'),
    all('playback_events', 'video_id, watch_ms, outcome, created_at'),
    // ssa_tag_events.session_id is NULLABLE and is null in practice — a tag keys on
    // (team_id, session_date). Joining on session_id silently reports zero tags.
    all('ssa_tag_events', 'team_id, session_date, slug').catch(() => []),
    all('debriefs', 'session_id, team_id, learnings, next_focus, documents').catch(() => []),
  ])

  console.error('reading Bunny Stream …')
  const stream = await streamLibrary()

  const inWindow = (d: string | null) => !since || !d || d.slice(0, 10) >= since
  const videoById = new Map(videos.map(v => [v.id, v]))
  const sessionTeam = new Map(sessions.map(s => [s.id, s.team_id]))

  // watch bytes ≈ watch_ms × the clip's own average bitrate (bytes / duration)
  let watchBytesByTeam = new Map<string, number>(), watchHoursByTeam = new Map<string, number>()
  let watchBytesTotal = 0, watchHoursTotal = 0
  for (const p of plays) {
    if (!inWindow(p.created_at) || p.outcome !== 'played') continue
    const v = videoById.get(p.video_id)
    const hours = (p.watch_ms ?? 0) / 36e5
    watchHoursTotal += hours
    if (!v || !v.bytes || !v.duration_ms) continue
    const bytes = (p.watch_ms ?? 0) / v.duration_ms * v.bytes
    watchBytesTotal += bytes
    watchBytesByTeam.set(v.team_id, (watchBytesByTeam.get(v.team_id) ?? 0) + bytes)
    watchHoursByTeam.set(v.team_id, (watchHoursByTeam.get(v.team_id) ?? 0) + hours)
  }

  const rows = teams.map(t => {
    const ts = sessions.filter(s => s.team_id === t.id && inWindow(s.date))
    const tv = videos.filter(v => v.team_id === t.id && inWindow(v.created_at))
    const tp = photos.filter(p => p.team_id === t.id && inWindow(p.created_at))
    const vBytes = tv.reduce((a, v) => a + Number(v.bytes ?? 0), 0)
    const pBytes = tp.reduce((a, p) => a + Number(p.bytes ?? 0), 0)
    const dates = ts.map(s => s.date).sort()
    const spanDays = dates.length > 1
      ? Math.max(1, Math.round((+new Date(dates[dates.length - 1]) - +new Date(dates[0])) / 864e5))
      : 1
    const sessIds = new Set(ts.map(s => s.id))
    return {
      id: t.id,
      name: t.name ?? '(unnamed)',
      boats: boats.filter(b => b.team_id === t.id).length,
      members: memberships.filter(m => m.team_id === t.id).length,
      teamDays: ts.length,
      firstDay: dates[0] ?? '—',
      lastDay: dates[dates.length - 1] ?? '—',
      spanDays,
      videos: tv.length,
      videoHours: tv.reduce((a, v) => a + Number(v.duration_ms ?? 0), 0) / 36e5,
      photos: tp.length,
      photosScanned: tp.filter(p => p.analysis_data && Object.keys(p.analysis_data).length).length,
      storedBytes: vBytes + pBytes,
      vBytes, pBytes,
      watchBytes: watchBytesByTeam.get(t.id) ?? 0,
      watchHours: watchHoursByTeam.get(t.id) ?? 0,
      tags: tags.filter((x: Row) => x.team_id === t.id).length,
      taggedDays: new Set(tags.filter((x: Row) => x.team_id === t.id).map((x: Row) => x.session_date)).size,
      debriefs: debriefs.filter((x: Row) => sessIds.has(x.session_id)).length,
      loggedDays: ts.filter(s => sessIds.has(s.id)).length, // refined below from logged set
    }
  }).filter(r => r.teamDays || r.videos || r.photos)
    .sort((a, b) => b.storedBytes - a.storedBytes)

  if (asJson) { console.log(JSON.stringify({ rows, stream, RATES }, null, 2)); return }

  const H = (s: string) => `\n\x1b[1m${s}\x1b[0m`
  console.log(H(`SSA unit economics — ${new Date().toISOString().slice(0, 10)}${since ? `, activity since ${since}` : ', all time'}`))

  console.log(H('Per team'))
  console.log(pad('team', 22) + rpad('boats', 6) + rpad('crew', 6) + rpad('days', 6) + rpad('vids', 6) +
    rpad('vid h', 7) + rpad('photos', 8) + rpad('stored GB', 11) + rpad('watch GB', 10) + rpad('watch h', 9) + '  first → last')
  for (const r of rows) {
    console.log(pad(r.name, 22) + rpad(String(r.boats), 6) + rpad(String(r.members), 6) + rpad(String(r.teamDays), 6) +
      rpad(String(r.videos), 6) + rpad(r.videoHours.toFixed(1), 7) + rpad(String(r.photos), 8) +
      rpad(gb(r.storedBytes).toFixed(1), 11) + rpad(gb(r.watchBytes).toFixed(1), 10) +
      rpad(r.watchHours.toFixed(1), 9) + `  ${r.firstDay} → ${r.lastDay}`)
  }

  const tot = rows.reduce((a, r) => ({
    teamDays: a.teamDays + r.teamDays, stored: a.stored + r.storedBytes, watch: a.watch + r.watchBytes,
    videos: a.videos + r.videos, photos: a.photos + r.photos, videoHours: a.videoHours + r.videoHours,
    tags: a.tags + r.tags, debriefs: a.debriefs + r.debriefs, scanned: a.scanned + r.photosScanned,
  }), { teamDays: 0, stored: 0, watch: 0, videos: 0, photos: 0, videoHours: 0, tags: 0, debriefs: 0, scanned: 0 })

  console.log(H('The numbers that set the price'))
  const perDay = (n: number) => tot.teamDays ? n / tot.teamDays : 0
  console.log(`  team-days recorded              ${tot.teamDays}`)
  console.log(`  GB stored per team-day          ${gb(perDay(tot.stored)).toFixed(2)}`)
  console.log(`    of which video                ${gb(perDay(rows.reduce((a, r) => a + r.vBytes, 0))).toFixed(2)}`)
  console.log(`    of which photos               ${gb(perDay(rows.reduce((a, r) => a + r.pBytes, 0))).toFixed(2)}`)
  console.log(`  video hours per team-day        ${perDay(tot.videoHours).toFixed(2)}`)
  console.log(`  photos per team-day             ${perDay(tot.photos).toFixed(0)}  (${tot.scanned} SailScanned overall)`)
  console.log(`  delivered GB per team-day       ${gb(perDay(tot.watch)).toFixed(2)}   [watch_ms × clip bitrate]`)
  console.log(`  watch hours logged              ${watchHoursTotal.toFixed(1)}`)
  console.log(`  human tags / debriefs           ${tot.tags} / ${tot.debriefs}`)

  // ── Completeness: the number that gates the AI (§6 of the plan) ───────────
  // A day is only worth training or evaluating on when the human layer is there
  // too. Volume of days is not the constraint; this ratio is.
  const taggedDays = new Set(tags.map((x: Row) => x.session_date)).size
  const debriefDays = new Set(debriefs.map((x: Row) => x.session_id)).size
  const mediaDays = new Set([...videos, ...photos].map((m: Row) => m.session_id)).size
  const debriefChars = debriefs.reduce((a: number, d: Row) =>
    a + (d.learnings?.length ?? 0) + (d.next_focus?.length ?? 0), 0)
  const bar = (n: number) => '█'.repeat(Math.round(20 * n / Math.max(1, tot.teamDays)))
  console.log(H('Corpus completeness — the number that gates the AI'))
  console.log(`  days recorded                   ${rpad(String(tot.teamDays), 4)}  ${bar(tot.teamDays)}`)
  console.log(`  …with media                     ${rpad(String(mediaDays), 4)}  ${bar(mediaDays)}`)
  console.log(`  …with a debrief                 ${rpad(String(debriefDays), 4)}  ${bar(debriefDays)}`)
  console.log(`  …with human tags                ${rpad(String(taggedDays), 4)}  ${bar(taggedDays)}`)
  console.log(`  human debrief text              ${debriefChars.toLocaleString()} chars ≈ ${Math.round(debriefChars / 4).toLocaleString()} tokens`)
  console.log(`  eval-set target                 30–50 days carrying BOTH tags and a debrief`)

  if (stream) {
    console.log(H('Bunny Stream library (storage is truth; its traffic counters are not)'))
    console.log(`  videos in library               ${stream.count}`)
    console.log(`  stream storage                  ${gb(stream.storage).toFixed(1)} GB  (all renditions)`)
    console.log(`  encoded hours                   ${(stream.seconds / 3600).toFixed(1)}`)
    console.log(`  traffic, last ${String(stream.windowDays).padStart(3)} days         ${gb(stream.traffic).toFixed(1)} GB over ${stream.views} views`)
    const expansion = tot.videos && stream.storage ? stream.storage / rows.reduce((a, r) => a + r.vBytes, 0) : 0
    if (expansion) console.log(`  rendition expansion             ${expansion.toFixed(2)}×  (library ÷ source bytes)`)
    if (stream.resolutions.size) console.log(`  renditions                      ${Array.from(stream.resolutions).map(([k, v]) => `${k}:${v}`).join(' ')}`)
  } else {
    console.log(H('Bunny Stream: not read (missing key, or run inside the sandbox)'))
  }

  console.log(H('Monthly cost of one team, at list rates'))
  const streamGbPerDay = stream && tot.stored
    ? gb(stream.storage) / tot.teamDays
    : gb(perDay(rows.reduce((a, r) => a + r.vBytes, 0)))
  const photoGbPerDay = gb(perDay(rows.reduce((a, r) => a + r.pBytes, 0)))
  const deliveredGbPerDay = gb(perDay(tot.watch))
  console.log(`  assumes ${streamGbPerDay.toFixed(2)} GB stream + ${photoGbPerDay.toFixed(2)} GB photo storage added per team-day,`)
  console.log(`  ${deliveredGbPerDay.toFixed(2)} GB delivered per team-day, and storage kept for the whole season.\n`)
  console.log(pad('days/yr', 10) + rpad('yr-end GB', 12) + rpad('storage $/mo*', 15) + rpad('traffic $/mo', 14) + rpad('$/yr infra', 12))
  for (const days of [20, 40, 60, 90, 120]) {
    const endGb = days * (streamGbPerDay + photoGbPerDay)
    const avgGb = endGb / 2 // linear accrual over the year
    // split: stream bytes at stream rate, photo bytes at edge rate
    const storageMoSplit = (avgGb * streamGbPerDay / (streamGbPerDay + photoGbPerDay)) * RATES.streamStorageGbMonth
      + (avgGb * photoGbPerDay / (streamGbPerDay + photoGbPerDay)) * RATES.edgeStorageGbMonth
    const trafficMo = deliveredGbPerDay * days / 12 * RATES.trafficGb
    const yr = (storageMoSplit + trafficMo) * 12
    console.log(pad(String(days), 10) + rpad(endGb.toFixed(0), 12) + rpad(usd(storageMoSplit), 15) + rpad(usd(trafficMo), 14) + rpad(usd(yr), 12))
  }
  console.log(`  * average over the year; a season's storage accrues, so December costs ~2× the average.`)

  console.log(H('Gross margin per plan'))
  console.log(pad('plan', 12) + rpad('€/yr', 8) + rpad('days/yr', 9) + rpad('infra $/yr', 12) + rpad('margin', 9) + '  verdict')
  for (const p of PLANS) {
    for (const days of [40, 90]) {
      const endGb = days * (streamGbPerDay + photoGbPerDay)
      const avgGb = endGb / 2
      const storageMo = (avgGb * streamGbPerDay / (streamGbPerDay + photoGbPerDay)) * RATES.streamStorageGbMonth
        + (avgGb * photoGbPerDay / (streamGbPerDay + photoGbPerDay)) * RATES.edgeStorageGbMonth
      const trafficMo = deliveredGbPerDay * days / 12 * RATES.trafficGb
      const infraYr = (storageMo + trafficMo) * 12
      const marginPct = 100 * (1 - (infraYr * USD_EUR) / p.yearEur)
      console.log(pad(p.name, 12) + rpad(String(p.yearEur), 8) + rpad(String(days), 9) + rpad(usd(infraYr), 12) +
        rpad(marginPct.toFixed(1) + '%', 9) + (marginPct >= 80 ? '  ok' : '  ← under 80%, cut the allowance'))
    }
  }
  console.log(`\n  Fixed floor, all teams: ${usd((RATES.supabaseMonth + RATES.vercelMonth + RATES.scalewayMonth) * 12)}/yr` +
    ` — ${rows.length} team(s) today, so ${usd((RATES.supabaseMonth + RATES.vercelMonth + RATES.scalewayMonth) * 12 / Math.max(1, rows.length))}/team/yr.`)
  console.log(`  Rates are list prices from the block at the top of this file. Check them against an invoice.\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
