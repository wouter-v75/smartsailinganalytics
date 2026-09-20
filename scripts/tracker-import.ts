// scripts/tracker-import.ts
// ─────────────────────────────────────────────────────────────────────────────
// Import a squad's tracker files as one training day.
//
//   npx vite-node scripts/tracker-import.ts -- \
//     --team Dragon --venue "Bay of Palma" \
//     "~/Downloads/Miss Behavior 2 2-8-2026.csv" \
//     "~/Downloads/Torvar's second  08-02-2026.csv"
//
// DRY RUN BY DEFAULT. Pass --write to create anything. Reads .env.local and must
// run OUTSIDE Claude Code's Bash sandbox, like every other script here.
//
// What it does, and why it is a script rather than a click:
//
//   • The whole squad is imported TOGETHER, because the wind estimate is pooled
//     across boats. A boat that spent the day on one-tack speed tests derives
//     nothing on its own and recovers the wind from its squad-mates — that is
//     the entire point of the training-day scope.
//   • The session date, the venue clock and the sample rate come out of the
//     files. Nothing is asked for that the data already knows.
//   • The boat comes from --boat, or from the filename, and the filename is a
//     LABEL not a fact: the two real files wrote the same day as "2-8-2026" and
//     "08-02-2026", and one named a boat while the other named a session. So a
//     derived boat name is always printed for confirmation before --write.
//
// The cloud copy goes through reduceLogForCloud, the same function the Upload
// tab uses, so a session imported here is byte-identical in shape to one
// imported in the browser. Do not reimplement it: CLAUDE.md records that a
// second implementation drifted silently once already.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import { parseLog } from '../src/lib/logParse'
import { planTrackerIngest } from '../src/lib/trackerIngest'
import { findSegments } from '../src/lib/wind/segment'
import { synthesise } from '../src/lib/wind/synthesise'
import { eventsFromSegments, countManoeuvres } from '../src/lib/wind/trackEvents'
import { estimateTwd } from '../src/lib/wind/estimate'
import { solveCompassOffset } from '../src/lib/wind/compassCalibration'
import {
  fetchOceanCurrent, medianPosition, currentAt, crossWindKn, describeCurrentBias,
} from '../src/lib/oceanCurrent'
// @ts-ignore — JS module
import { reduceLogForCloud } from '../src/lib/cloudLogReduce'

// ── env ─────────────────────────────────────────────────────────────────────
const envPath = path.join(process.cwd(), '.env.local')
if (!fs.existsSync(envPath)) { console.error('no .env.local'); process.exit(1) }
const ENV = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
const SB = ENV.NEXT_PUBLIC_SUPABASE_URL
const KEY = ENV.SUPABASE_SERVICE_ROLE_KEY
if (!SB || !KEY) { console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1) }

const rest = async (p: string, init: RequestInit = {}) => {
  const r = await fetch(`${SB}/rest/v1/${p}`, {
    ...init,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation', ...(init.headers || {}),
    },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${r.status} ${p} — ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] ?? null : null
}
const WRITE = argv.includes('--write')
const TEAM = flag('team')
const VENUE = flag('venue')
const OWNER_EMAIL = flag('as') || 'wouterv@runbox.com'
const boatNames = argv.reduce<string[]>((a, v, i) => (v === '--boat' ? [...a, argv[i + 1]] : a), [])
const files = argv.filter((a, i) =>
  !a.startsWith('--') && argv[i - 1] !== '--team' && argv[i - 1] !== '--venue' &&
  argv[i - 1] !== '--boat' && argv[i - 1] !== '--as')

if (!TEAM || !files.length) {
  console.error('usage: tracker-import.ts -- --team <name> [--venue <name>] [--boat <name>]… [--write] <file>…')
  process.exit(1)
}

const expand = (p: string) => p.replace(/^~/, process.env.HOME || '~')
const kn = (v: number | null | undefined) => (v == null ? '–' : v.toFixed(1))

async function main() {
  console.log(WRITE ? '── WRITING ──' : '── DRY RUN (add --write to apply) ──')

  const [team] = await rest(`teams?select=id,name&name=eq.${encodeURIComponent(TEAM!)}`)
  if (!team) throw new Error(`no team named "${TEAM}"`)
  const [owner] = await rest(`users?select=id,email&email=eq.${encodeURIComponent(OWNER_EMAIL)}`)
  if (!owner) throw new Error(`no user ${OWNER_EMAIL}`)
  console.log(`team ${team.name} (${team.id}) · created_by ${owner.email}`)

  // ── 1. parse every file ───────────────────────────────────────────────────
  const loaded = files.map((f, i) => {
    const p = expand(f)
    const text = fs.readFileSync(p, 'utf8')
    const parsed: any = parseLog(text)
    const plan = planTrackerIngest(text, { filename: path.basename(p) })
    return {
      file: path.basename(p),
      boatName: boatNames[i] || plan.title || path.basename(p, path.extname(p)),
      rows: parsed.rows, plan, parsed,
    }
  })

  const dates = Array.from(new Set(loaded.map((l) => l.plan.sessionDate).filter(Boolean)))
  if (dates.length !== 1) throw new Error(`files span ${dates.length} dates (${dates.join(', ')}) — import one day at a time`)
  const date = dates[0]!
  const tz = loaded[0].plan.tzOffsetMin ?? 0
  console.log(`date ${date} · venue clock UTC${tz >= 0 ? '+' : ''}${tz / 60}`)

  // ── 2. the model wind, and the current, for this venue and day ────────────
  const pos = medianPosition(loaded[0].rows)!
  const wx: any = await (await fetch(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${pos.lat.toFixed(2)}&longitude=${pos.lon.toFixed(2)}` +
    `&start_date=${date}&end_date=${date}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timezone=UTC`)).json()
  const model = wx?.hourly ? {
    times: wx.hourly.time.map((t: string) => Date.parse(`${t}Z`)),
    twd: wx.hourly.wind_direction_10m,
    tws: wx.hourly.wind_speed_10m,
  } : null
  const current = await fetchOceanCurrent({ lat: pos.lat, lon: pos.lon, startDate: date })
  console.log(`model wind: ${model ? `${model.twd.length} hours` : 'unavailable'} · current: ${current ? `cell ${current.cellOffsetKm.toFixed(1)} km away` : 'unavailable'}`)

  // ── 3. pool the squad, then synthesise per boat ───────────────────────────
  const pooled = loaded.flatMap((l) => findSegments(l.rows))
  const session = estimateTwd(pooled, { priorTwd: model ? model.twd[Math.floor(model.twd.length / 2)] : null })
  console.log(`pooled wind: ${session ? `TWD ${session.twd.toFixed(0)}° (${session.reference} wind, score ${session.score.toFixed(2)}, ${session.segments} segments)` : 'not derivable'}`)

  if (session && current) {
    const c = currentAt(current, Date.parse(`${date}T12:00:00Z`))
    if (c) {
      const msg = describeCurrentBias({
        speedKn: c.speedKn, setDeg: c.setDeg, twdDeg: session.twd, boatSpeedKn: 6, twaDeg: 42,
      })
      console.log(`current: ${c.speedKn.toFixed(2)} kn setting ${c.setDeg.toFixed(0)}° — ${msg || 'negligible for TWD'}`)
    }
  }

  // ── 4. training day ───────────────────────────────────────────────────────
  const venue = VENUE || null
  let day = (await rest(`training_days?select=id&team_id=eq.${team.id}&date=eq.${date}` +
    (venue ? `&venue=eq.${encodeURIComponent(venue)}` : '&venue=is.null')))[0]
  console.log(`\ntraining day ${date}${venue ? ` · ${venue}` : ''}: ${day ? `exists (${day.id})` : 'CREATE'}`)
  if (!day && WRITE) {
    [day] = await rest('training_days', {
      method: 'POST',
      body: JSON.stringify({
        team_id: team.id, date, venue, lat: pos.lat, lon: pos.lon,
        tz_offset_minutes: tz, created_by_user_id: owner.id,
        title: `${venue || 'Training'} — ${loaded.length} boats`,
      }),
    })
    console.log(`  created ${day.id}`)
  }

  // ── 5. per boat: boat row, session row, reduced cloud log ─────────────────
  for (const l of loaded) {
    console.log(`\n── ${l.file}`)
    console.log(`   boat name:  "${l.boatName}"   ← from ${boatNames.length ? '--boat' : 'the filename (a LABEL, check it)'}`)

    let boat = (await rest(`boats?select=id,name&team_id=eq.${team.id}&name=eq.${encodeURIComponent(l.boatName)}`))[0]
    console.log(`   boat row:   ${boat ? `exists (${boat.id})` : 'CREATE'}`)
    if (!boat && WRITE) {
      [boat] = await rest('boats', { method: 'POST', body: JSON.stringify({ team_id: team.id, name: l.boatName }) })
      console.log(`     created ${boat.id}`)
    }

    const s = synthesise({ rows: l.rows, format: 'vakaros-csv', model, pooledSegments: pooled })
    const mid = s.rows[Math.floor(s.rows.length / 2)]
    const ev = eventsFromSegments(s.segments, mid?.twd ?? null)
    const m = countManoeuvres(ev)

    // Per-device compass calibration, only where the current is small enough
    // for it to be separable at all.
    const cross = session && current
      ? (() => { const c = currentAt(current, l.plan.startUtc + (l.plan.endUtc - l.plan.startUtc) / 2)
        return c ? crossWindKn(c.speedKn, c.setDeg, session.twd) : null })()
      : null
    const cal = session
      ? solveCompassOffset({ segments: s.segments, twdDeg: session.twd, crossCurrentKn: cross })
      : { ok: false as const, reason: 'no session wind' }

    console.log(`   rows ${l.rows.length.toLocaleString()} @ ${l.plan.rateHz} Hz · ${s.segments.length} segments · ${m.tacks} tacks, ${m.gybes} gybes, ${m.other} other`)
    console.log(`   twd ${(s.twdCoverage * 100).toFixed(0)}% derived · mid-session twd ${mid?.twd?.toFixed(0) ?? '–'}° twa ${mid?.twa?.toFixed(0) ?? '–'}° bsp ${kn(mid?.bsp)} kn`)
    console.log(`   compass:    ${cal.ok ? `${cal.calibration.offsetDeg.toFixed(1)}° ±${cal.calibration.uncertaintyDeg.toFixed(1)} · leeway ${cal.calibration.leewayDeg.toFixed(1)}°` : cal.reason}`)

    const logData = { rows: s.rows, format: 'vakaros-csv' }
    const reduced = reduceLogForCloud(logData, ev)
    const bytes = JSON.stringify(reduced).length
    console.log(`   cloud log:  ${reduced.rows.length.toLocaleString()} rows (${(bytes / 1024).toFixed(0)} kB) after reduceLogForCloud`)

    if (!WRITE) continue

    const existing = (await rest(`sessions?select=id&boat_id=eq.${boat.id}&date=eq.${date}`))[0]
    const body = {
      team_id: team.id, boat_id: boat.id, date,
      title: l.plan.title, location: venue,
      tz_offset_minutes: tz, training_day_id: day?.id ?? null,
      log_data: reduced, xml_data: ev,
      created_by_user_id: owner.id, updated_at: new Date().toISOString(),
    }
    if (existing) {
      await rest(`sessions?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      console.log(`   session:    updated ${existing.id}`)
    } else {
      const [row] = await rest('sessions', { method: 'POST', body: JSON.stringify(body) })
      console.log(`   session:    created ${row.id}`)
    }

    if (cal.ok) {
      const label = `${l.boatName} tracker`
      let tr = (await rest(`trackers?select=id&team_id=eq.${team.id}&label=eq.${encodeURIComponent(label)}`))[0]
      if (!tr) [tr] = await rest('trackers', {
        method: 'POST',
        body: JSON.stringify({ team_id: team.id, kind: 'vakaros', label }),
      })
      await rest(`trackers?id=eq.${tr.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          hdg_offset_deg: Number(cal.calibration.offsetDeg.toFixed(2)),
          hdg_offset_source: 'squad-solve', hdg_offset_at: date,
          updated_at: new Date().toISOString(),
        }),
      })
      const has = (await rest(`tracker_assignments?select=id&tracker_id=eq.${tr.id}&boat_id=eq.${boat.id}`))[0]
      if (!has) await rest('tracker_assignments', {
        method: 'POST',
        body: JSON.stringify({ tracker_id: tr.id, boat_id: boat.id, valid_from: date }),
      })
      console.log(`   tracker:    ${tr.id} · offset stored`)
    }
  }

  console.log(WRITE ? '\ndone.' : '\nnothing written — re-run with --write')
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1) })
