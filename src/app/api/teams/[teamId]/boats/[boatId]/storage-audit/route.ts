// What is left in the pre-migration part of the Bunny zone, and whose is it?
//
//   GET  …/storage-audit            report only, changes nothing
//   POST …/storage-audit            copy the claimable session JSON under this
//                                   boat's prefix (dryRun defaults to TRUE)
//
// Storage keys used to be `sessions/<date>/…` with no team or boat, so two boats
// sailing the same day wrote the same log.json and the second one won. Keys are
// tenant-scoped now (src/lib/storageKeys.ts) and reads fall back to the flat layout,
// so nothing is broken and NOTHING HAS TO BE MIGRATED for the app to work. This route
// exists for the two things the fallback cannot tell you:
//
//   • which days two boats collided on, i.e. where one boat's log actually
//     overwrote another's. That data is gone; the value is in knowing where.
//   • which days are unambiguous, and can therefore be filed under their owner so
//     the fallback stops being load-bearing for them.
//
// WHAT IT WILL NOT DO. It never resolves a collision by picking a winner — that is
// guessing which boat's data survived. It never deletes the flat object, so a copy is
// always additive and safe to re-run. And it only copies the five session JSON files:
// photos, proxies and clip originals have their absolute key stored in the database
// and read back verbatim, so they work where they are, moving them would risk the rows
// that point at them, and they are far too large to pull through a serverless function.
//
// Caller must be admin or team_manager of the target team.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '@/lib/supabase/server'
import { requireTeamManager } from '@/lib/supabase/admin-guard'
import { legacySessionPrefix, writeKey, type StorageScope } from '@/lib/storageKeys'
import {
  classifyDate, canClaim, isMigratable, summarise,
  type DateAudit, type SessionClaim,
} from '@/lib/storageAudit'

export const maxDuration = 60

const API_KEY = process.env.BUNNY_STORAGE_API_KEY
const WRITE_KEY = process.env.BUNNY_STORAGE_WRITE_KEY
const ZONE = process.env.BUNNY_STORAGE_ZONE
const REGION = process.env.BUNNY_STORAGE_REGION || 'de'
const base = () =>
  REGION === 'de' ? 'https://storage.bunnycdn.com' : `https://${REGION}.storage.bunnycdn.com`

interface BunnyEntry { ObjectName: string; IsDirectory: boolean; Length?: number }

async function list(prefix: string): Promise<BunnyEntry[]> {
  const res = await fetch(`${base()}/${ZONE}/${prefix}`, { headers: { AccessKey: API_KEY! } })
  if (!res.ok) return []
  const j = await res.json()
  return Array.isArray(j) ? (j as BunnyEntry[]) : []
}

/** The dates present in the OLD flat layout. */
async function legacyDates(): Promise<string[]> {
  return (await list('sessions/'))
    .filter((e) => e.IsDirectory && /^\d{4}-\d{2}-\d{2}$/.test(e.ObjectName))
    .map((e) => e.ObjectName)
    .sort()
    .reverse()
}

async function auditDate(date: string, claims: SessionClaim[]): Promise<DateAudit> {
  const prefix = legacySessionPrefix(date)!
  const entries = await list(prefix)
  return {
    date,
    verdict: classifyDate(date, claims),
    sessionFiles: entries.filter((e) => !e.IsDirectory).map((e) => e.ObjectName),
    directories: entries.filter((e) => e.IsDirectory).map((e) => e.ObjectName),
  }
}

/** Copy one flat object under the scoped prefix. Additive: the original stays. */
async function copyToScoped(
  date: string, leaf: string, scope: StorageScope
): Promise<{ ok: boolean; reason?: string }> {
  if (!WRITE_KEY) return { ok: false, reason: 'BUNNY_STORAGE_WRITE_KEY not configured' }
  const from = legacySessionPrefix(date)! + leaf
  const to = writeKey(scope, date, leaf)
  if (!to) return { ok: false, reason: 'could not build a scoped key' }

  const got = await fetch(`${base()}/${ZONE}/${from}`, { headers: { AccessKey: API_KEY! } })
  if (!got.ok) return { ok: false, reason: `read ${from}: HTTP ${got.status}` }
  const body = await got.arrayBuffer()

  const put = await fetch(`${base()}/${ZONE}/${to}`, {
    method: 'PUT',
    headers: { AccessKey: WRITE_KEY, 'Content-Type': 'application/json' },
    body,
  })
  if (!put.ok && put.status !== 201) return { ok: false, reason: `write ${to}: HTTP ${put.status}` }
  return { ok: true }
}

/** Every session row, so a date can be checked for more than one claimant. */
async function allClaims(): Promise<SessionClaim[]> {
  const { data } = await getServiceSupabase()
    .from('sessions')
    .select('date, team_id, boat_id')
  return (data || []) as SessionClaim[]
}

function notConfigured() {
  return NextResponse.json({ error: 'Bunny Storage not configured' }, { status: 503 })
}

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const gate = await requireTeamManager(params.teamId)
  if (!gate.ok) return gate.response
  if (!API_KEY || !ZONE) return notConfigured()

  const only = req.nextUrl.searchParams.get('date')
  const claims = await allClaims()
  const dates = only ? [only] : await legacyDates()
  const audits: DateAudit[] = []
  for (const d of dates) audits.push(await auditDate(d, claims))

  const scope = { teamId: params.teamId, boatId: params.boatId }
  return NextResponse.json({
    summary: summarise(audits),
    // The days where one boat's session files overwrote another's. Not recoverable —
    // listed so it is known rather than guessed at.
    collisions: audits
      .filter((a) => a.verdict.kind === 'collision')
      .map((a) => ({ date: a.date, claimants: a.verdict.kind === 'collision' ? a.verdict.claimants : [] })),
    claimableByThisBoat: audits
      .filter((a) => canClaim(a.verdict, scope))
      .map((a) => ({ date: a.date, files: a.sessionFiles.filter(isMigratable) })),
    audits,
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const gate = await requireTeamManager(params.teamId)
  if (!gate.ok) return gate.response
  if (!API_KEY || !ZONE) return notConfigured()

  const body = (await req.json().catch(() => ({}))) as { date?: string; dryRun?: boolean }
  // Defaults to a dry run. Copying is opt-in, so an accidental POST reports rather
  // than writes.
  const dryRun = body.dryRun !== false
  const scope = { teamId: params.teamId, boatId: params.boatId }

  const claims = await allClaims()
  const dates = body.date ? [body.date] : await legacyDates()

  const copied: string[] = []
  const skipped: { date: string; why: string }[] = []
  const errors: string[] = []

  for (const date of dates) {
    const audit = await auditDate(date, claims)
    if (!canClaim(audit.verdict, scope)) {
      skipped.push({
        date,
        why: audit.verdict.kind === 'collision'
          ? `claimed by ${audit.verdict.claimants.length} boats — resolve by hand, this route will not pick a winner`
          : audit.verdict.kind === 'unclaimed'
            ? 'no session row for this date'
            : 'belongs to another boat',
      })
      continue
    }
    for (const leaf of audit.sessionFiles.filter(isMigratable)) {
      if (dryRun) { copied.push(`${date}/${leaf}`); continue }
      const r = await copyToScoped(date, leaf, scope)
      if (r.ok) copied.push(`${date}/${leaf}`)
      else errors.push(`${date}/${leaf}: ${r.reason}`)
    }
  }

  return NextResponse.json({
    dryRun,
    // The flat objects are NOT deleted, so this is safe to run again.
    copied,
    skipped,
    errors: errors.length ? errors : undefined,
    note: dryRun
      ? 'Dry run — nothing was written. POST { "dryRun": false } to copy.'
      : 'Copies made under the scoped prefix. The original flat objects were left in place.',
  }, { status: errors.length ? 207 : 200 })
}
