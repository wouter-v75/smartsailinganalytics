import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '@/lib/supabase/server'
import {
  collectObservations, obsRow, SOURCE_NAMES, VENUES, type SourceName,
} from '@/lib/obsSources'
import {
  parseForceParam, unknownForceKeys, type ActivationWindow,
} from '@/lib/obsActivation'
import { campaignWindows } from '@/lib/obsCampaignWindows'

// POST|GET /api/obs/poll   — fetch the public networks and store what they say.
//
// WHY A ROUTE AND NOT A SCRIPT ON THE BOX. The regatta box has cron and curl
// but NO NODE, and its root disk has 2.6 GB free — installing a second Node
// toolchain and an npm tree there to run one fetch every half hour is
// a poor trade. This way the tested parsers stay in one place, the box needs
// nothing new, and the cron line is a curl. Vercel Cron can call it instead,
// and on the same schedule, if you would rather not depend on the box at all.
//
// AUTHENTICATION is a shared secret, not a user session: the caller is a cron,
// not a person. Without OBS_POLL_SECRET set the route refuses outright rather
// than running open — an unprotected writer is how a table gets filled with
// whatever somebody feels like.
//
// `?only=ndbc,metar` splits a run into smaller pieces. Worth knowing if the
// whole sweep ever approaches the function timeout: Pioupiou alone is 660 KB.

export const maxDuration = 60
export const dynamic = 'force-dynamic'

/**
 * How long observations are kept. THREE YEARS, and the number is a training
 * set rather than a housekeeping choice.
 *
 * It was 90 days, which was a sensible default for a map that only ever asks
 * "what is the wind doing now". It is hopeless for the thing these
 * observations are being collected FOR: the verification literature puts a
 * LOCAL wind MOS fit at 365-1816 days, and one study could not estimate a
 * 15-parameter local EMOS at all on 161 days. At 90 days a per-venue fit is
 * permanently out of reach.
 *
 * AND IT IS THE ONLY IRREVERSIBLE DECISION HERE. Everything else in this
 * pipeline can be changed later and recomputed from stored rows. This cannot:
 * the upstream networks keep between 24 hours and 45 days, and the Davis map
 * stations and Pioupiou beacons keep NOTHING — their endpoints serve the
 * current reading and no past. A day not stored is gone for good, so waiting
 * one more season costs one more season, for ever.
 *
 * What it costs: roughly 12-15k rows a day across the whole network (most
 * sources are one row per station per poll; WeatherFile and Hill Head publish
 * five-minute series, so they contribute a few hundred each). Three years is
 * of the order of 15 million rows and a few GB with both indexes — no
 * partitioning, and the two indexes in 0101 already cover all three query
 * shapes, including this sweep. Worth watching the project's disk, which is
 * the one resource this does consume.
 *
 * NOT DONE, deliberately: a tiered scheme keeping native cadence only for the
 * fit-tier stations and an hourly aggregate for the rest. It would save most
 * of the volume, but it throws away the gust and lull structure that exposure
 * inference needs, and the saving is not yet worth the irreversibility.
 */
const RETAIN_DAYS = 1095

function authorised(req: NextRequest): boolean {
  const want = process.env.OBS_POLL_SECRET
  if (!want) return false
  const got = req.headers.get('x-obs-poll-secret')
    || req.nextUrl.searchParams.get('secret')
    // Vercel Cron signs its own calls with this.
    || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!got || got.length !== want.length) return false
  // Constant-time-ish: compare every character regardless of the first mismatch.
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i)
  return diff === 0
}

async function run(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'not authorised' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }

  const onlyRaw = (req.nextUrl.searchParams.get('only') || '').split(',').map((s) => s.trim()).filter(Boolean)
  const only = (onlyRaw.length ? onlyRaw.filter((n): n is SourceName => (SOURCE_NAMES as string[]).includes(n)) : SOURCE_NAMES)
  if (!only.length) return NextResponse.json({ error: 'no known source named' }, { status: 400 })

  // ACTIVATION. A dense network is worth having while a regatta is on and
  // close to worthless the rest of the year, so each venue is polled either to
  // its full graded radius or to its inner circle only. Two things turn a
  // venue dense, and the force list only ever ADDS:
  //
  //   obs_venue_activation   a window, set weeks ahead from the race calendar.
  //   ?domains=st-tropez     "when I say so" — and what the NWP box can emit
  //                          from its own NESTS config, so the observations
  //                          follow the model without being told twice.
  //
  // ?domains=all forces every venue, which is the old behaviour.
  const force = parseForceParam(req.nextUrl.searchParams.get('domains'))
  const sb0 = getServiceSupabase()
  let windows: ActivationWindow[] = []
  let windowError: string | null = null
  {
    const nowIso = new Date().toISOString()
    const { data, error } = await sb0.from('obs_venue_activation')
      .select('venue_key, starts_at, ends_at, reason')
      .lte('starts_at', nowIso).gte('ends_at', nowIso)
    if (error) {
      // A missing or unreadable table must not silently switch dense polling
      // off for a regatta in progress, nor silently switch it on. It is
      // reported, and ?domains= still works.
      windowError = error.message
    } else {
      windows = (data ?? []).map((r) => ({
        venueKey: String(r.venue_key), startsAt: String(r.starts_at),
        endsAt: String(r.ends_at), reason: r.reason as string | null,
      }))
    }
  }
  // THE CAMPAIGN CALENDAR IS THE OTHER SOURCE OF WINDOWS, and the better one:
  // the regatta's dates are already in `sessions` because somebody entered
  // them on the Event/Regatta tab. Asking for them a second time in
  // obs_venue_activation is asking to be told twice, and the second telling is
  // the one that gets forgotten.
  //
  // Read with the service key, so it sees every team's calendar. That is not a
  // privacy step sideways: nothing about a boat leaves here, it only decides
  // WHERE public weather is collected.
  //
  // A week either side is plenty — padDays is 1 and gapDays 2, so if now falls
  // inside a padded run there is a session within three days of it. The extra
  // width is only so the window's reason can name the whole regatta.
  let campaignUnmatched: Array<{ location: string; sessions: number }> = []
  {
    const dayMs = 86400_000
    const from = new Date(Date.now() - 7 * dayMs).toISOString().slice(0, 10)
    const to = new Date(Date.now() + 7 * dayMs).toISOString().slice(0, 10)
    const { data, error } = await sb0.from('sessions')
      .select('date, event, location, tz_offset_minutes')
      .gte('date', from).lte('date', to)
    if (error) {
      windowError = [windowError, `sessions: ${error.message}`].filter(Boolean).join('; ')
    } else {
      const derived = campaignWindows(data ?? [], VENUES)
      windows = [...windows, ...derived.windows]
      campaignUnmatched = derived.unmatched
    }
  }

  const unknown = unknownForceKeys(VENUES, force)

  const { obs, results, venues } = await collectObservations(only, { windows, force })
  const rows = obs.map(obsRow)

  const sb = sb0
  let stored = 0
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    // (station_id, t) is the key, so re-polling the same reading updates in
    // place rather than growing the table.
    const { error } = await sb.from('wind_observations').upsert(chunk, { onConflict: 'station_id,t' })
    if (error) {
      return NextResponse.json({ error: `upsert: ${error.message}`, results, stored }, { status: 500 })
    }
    stored += chunk.length
  }

  // Retention lives with the writer: there is no other scheduled job, and a
  // table nobody prunes is a table that surprises somebody in a year.
  let pruned: number | null = null
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400_000).toISOString()
  const { error: delErr, count } = await sb.from('wind_observations')
    .delete({ count: 'exact' }).lt('t', cutoff)
  if (!delErr) pruned = count ?? 0

  // no-store, explicitly. The default for this route was
  // `public, max-age=0, must-revalidate`, which does execute every time — but
  // `public` on an endpoint that WRITES is looser than it should be, and a
  // cached poll response would mean the cron quietly stops polling while
  // every check still returns a cheerful ok.
  return NextResponse.json({
    ok: true,
    stored,
    pruned,
    retainDays: RETAIN_DAYS,
    results,
    // WHICH VENUES WERE WATCHED, AND WHY. A poll that quietly stopped covering
    // a venue is the sort of thing noticed a season later, so the answer is in
    // every response rather than inferable from the row count.
    dense: venues.filter((v) => v.mode === 'dense').map((v) => ({ key: v.key, why: v.reason })),
    idle: venues.filter((v) => v.mode === 'idle').map((v) => v.key),
    ...(unknown.length ? { unknownDomains: unknown } : {}),
    // A calendar location matching no venue means a regatta with no dense
    // network and nothing to say so. Reported, not swallowed.
    ...(campaignUnmatched.length ? { unmatchedLocations: campaignUnmatched } : {}),
    ...(windowError ? { activationError: windowError } : {}),
    at: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export const GET = run
export const POST = run
