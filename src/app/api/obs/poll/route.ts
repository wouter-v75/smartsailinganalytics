import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '@/lib/supabase/server'
import {
  collectObservations, obsRow, SOURCE_NAMES, VENUES, type SourceName,
} from '@/lib/obsSources'
import {
  parseForceParam, unknownForceKeys, type ActivationWindow,
} from '@/lib/obsActivation'

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

const RETAIN_DAYS = 90

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
    ...(windowError ? { activationError: windowError } : {}),
    at: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export const GET = run
export const POST = run
