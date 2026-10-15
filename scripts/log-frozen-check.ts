// scripts/log-frozen-check.ts
// ─────────────────────────────────────────────────────────────────────────────
// Which of a day's log channels STOPPED UPDATING but kept being logged — and
// which photographs and stored tags were caught inside the freeze.
//
//   npx vite-node scripts/log-frozen-check.ts --date 2026-10-11
//   npx vite-node scripts/log-frozen-check.ts --date 2026-10-11 --min 15
//
// Read-only. No --write: nothing here can be fixed by a script, because the
// missing readings were never recorded. What it can do is stop a stale number
// being mistaken for a measurement.
//
// WHY. Baraka, 11 Oct 2026: `twa` held at exactly −53.6 from 08:22:20 to
// 08:26:24, with tws/awa/bsp/vmg frozen with it, then jumped 100° in a single
// step. She TACKED inside that span. Heel, which comes off the IMU rather than
// the masthead, tracked it the whole way (11.8 → −8.2 → −10.2 → −13.5), and is
// the only reason anyone noticed.
//
// A frozen channel is worse than a missing one, because everything downstream
// treats it as a reading:
//
//   · a photograph in the span takes those values as its instrument data, and
//     SailTrim takes the TACK from the sign of that stale twa. That put a
//     starboard frame on port, which flipped the sign of every millimetre on
//     it, and then — because the triangulation drops the minority tack — cut
//     that set from four frames spanning 8.7° to three spanning 4.2°, tripling
//     the depth leverage. Three separate consequences, none of them announced;
//   · manoeuvre detection runs on twa sign changes, so the tack is reported
//     where the FEED RESUMED rather than where the boat turned;
//   · a phase mean across the span averages one value repeated.
//
// It took most of a session to find, through three wrong explanations — a
// mid-tack TWA sample, then instrument lag, then a mis-matched enrichment row.
// The log was simply repeating itself, and only a side-by-side of two sensors
// that fail independently shows it.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { frozenReport, frozenAt, WIND_CHANNELS, type LogRowLike } from '../src/lib/logFrozen'

const args = process.argv.slice(2)
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const DATE = flag('--date')
const MIN = Number(flag('--min') ?? 30)
if (!DATE) {
  console.error('usage: log-frozen-check.ts --date 2026-10-11 [--min 30]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19)

async function main() {
  const { data: sessions, error } = await sb.from('sessions')
    .select('id, date, boat_id, log_data').eq('date', DATE)
  if (error) { console.error(`sessions: ${error.message}`); process.exit(1) }
  if (!sessions?.length) { console.log(`no session on ${DATE}`); return }

  for (const s of sessions) {
    const ld = s.log_data as { rows?: LogRowLike[] } | null
    const rows = ld?.rows ?? []
    if (!rows.length) { console.log(`${DATE}: no log rows stored`); continue }
    console.log(`${DATE}: ${rows.length} log row(s) · freezes of ${MIN}s or more\n`)

    const spans = frozenReport(rows, { minSeconds: MIN })
    if (!spans.length) {
      console.log('  no channel held a value that long — nothing frozen.\n')
    }
    for (const f of spans) {
      // The witness is what separates a dead feed from a boat sitting still.
      // Both hold the channel; only one of them also holds the heel.
      const verdict = f.witnessRange == null ? 'no heel to check against'
        : f.witnessRange > 5 ? `DEAD FEED — heel moved ${f.witnessRange.toFixed(1)}° across it`
          : `may just be steady — heel only moved ${f.witnessRange.toFixed(1)}°`
      console.log(`  ${f.channel.padEnd(5)} held ${String(f.value).padStart(8)} for ${Math.round(f.seconds)}s`
        + `  ${hms(f.fromUtc)} → ${hms(f.toUtc)}, feed back ${hms(f.staleUntilUtc)}`)
      console.log(`${' '.repeat(8)}${f.rows} rows · ${verdict}`)
    }

    // The payoff: which photographs were measured on stale numbers.
    const { data: photos } = await sb.from('photos')
      .select('taken_utc, analysis_data')
      .gte('taken_utc', `${DATE}T00:00:00Z`).lt('taken_utc', `${DATE}T23:59:59Z`)
    const caught = (photos ?? []).map((p) => {
      const ms = Date.parse(String(p.taken_utc))
      return { p, ms, hit: frozenAt(spans, ms) }
    }).filter((x) => x.hit.length)
    if (caught.length) {
      console.log(`\n  ${caught.length} photograph(s) inside a freeze — their instrument data is STALE:`)
      for (const c of caught) {
        const a = (c.p.analysis_data || {}) as { inst?: { twa?: number }; sailTrim?: { annotation?: { tack?: string; heelDeg?: number } } }
        const ann = a.sailTrim?.annotation
        console.log(`    ${hms(c.ms)}  frozen: ${c.hit.map((h) => h.channel).join(',')}`
          + `  inst twa ${a.inst?.twa?.toFixed(1) ?? '—'}`
          + (ann ? `  → MEASURED as tack ${ann.tack}, image heel ${ann.heelDeg?.toFixed(1)}°` : '  (no geometry)'))
        if (ann?.tack && ann.heelDeg != null && c.hit.some((h) => h.channel === 'twa')) {
          const fromHeel = Math.abs(ann.heelDeg) < 3 ? null : (ann.heelDeg > 0 ? 'port' : 'stbd')
          if (fromHeel && fromHeel !== ann.tack) {
            console.log(`${' '.repeat(6)}↳ the heel says ${fromHeel}. The tack sets which side is leeward, so this`)
            console.log(`${' '.repeat(6)}  frame's millimetres are SIGN-FLIPPED. Set the tack by hand and re-save.`)
          }
        }
      }
    } else if (spans.length) {
      console.log('\n  no photographs fall inside a freeze.')
    }

    console.log(`\n  Nothing can repair this: the readings were never recorded. What it changes is`)
    console.log(`  whether a stale number is mistaken for a measurement. Channels checked:`)
    console.log(`  ${WIND_CHANNELS.join(', ')} — heel is the witness, and is never reported as frozen`)
    console.log('  because it is the thing being compared against.')
  }
}
main()
