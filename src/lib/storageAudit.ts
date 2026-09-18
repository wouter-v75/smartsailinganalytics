// What is still sitting in the pre-migration part of the Bunny zone, and whose is it?
//
// Storage keys used to be `sessions/<date>/…` with no team or boat, so two boats
// sailing the same day wrote the same log.json and the second one won. Keys are
// tenant-scoped now (src/lib/storageKeys.ts) and reads fall back to the flat layout,
// so everything still loads — but that leaves two questions worth answering:
//
//   1. WHICH DAYS LOST DATA. A flat day claimed by more than one boat is a day where
//      one boat's log.json overwrote another's. No tool can recover that; the point is
//      to know it happened, and on which days, rather than wonder.
//   2. WHAT CAN SAFELY BE CLAIMED. A flat day claimed by exactly one boat is
//      unambiguous — those objects can be copied under that boat's prefix, and the
//      fallback stops being needed for them.
//
// This file is the decision, kept pure and away from the fetching so it can be
// tested. Deliberately conservative: anything short of exactly one claimant is
// reported, never acted on.

/** A `sessions` row: one boat says it sailed this date. */
export interface SessionClaim {
  date: string
  team_id: string | null
  boat_id: string | null
}

export type AuditVerdict =
  /** Exactly one boat has a session for this date — safe to attribute. */
  | { kind: 'unambiguous'; teamId: string; boatId: string }
  /** Several boats do. Whatever is under the flat key belongs to whichever wrote last. */
  | { kind: 'collision'; claimants: { teamId: string; boatId: string }[] }
  /** No session row at all: an orphan, or a day imported outside the app. */
  | { kind: 'unclaimed' }

const key = (c: { teamId: string; boatId: string }) => `${c.teamId}/${c.boatId}`

/**
 * Who does this flat date belong to, according to the database?
 *
 * Claims missing a team or boat are ignored rather than treated as a claimant —
 * a half-tagged row cannot tell us whose the bytes are.
 */
export function classifyDate(date: string, claims: SessionClaim[]): AuditVerdict {
  const seen = new Map<string, { teamId: string; boatId: string }>()
  for (const c of claims) {
    if (c.date !== date) continue
    if (!c.team_id || !c.boat_id) continue
    const cl = { teamId: c.team_id, boatId: c.boat_id }
    seen.set(key(cl), cl)
  }
  // Array.from, not spread: tsconfig targets es5, where a Map iterator cannot spread.
  const claimants = Array.from(seen.values())
  if (claimants.length === 0) return { kind: 'unclaimed' }
  if (claimants.length === 1) return { kind: 'unambiguous', ...claimants[0] }
  return { kind: 'collision', claimants }
}

/**
 * Is this date safe for THIS boat to claim?
 *
 * True only when the boat is the single claimant. A collision is never auto-resolved:
 * picking a winner would be guessing which boat's data survived, and the caller is in
 * a better position to know than a heuristic is.
 */
export function canClaim(
  verdict: AuditVerdict,
  scope: { teamId: string; boatId: string }
): boolean {
  return (
    verdict.kind === 'unambiguous' &&
    verdict.teamId === scope.teamId &&
    verdict.boatId === scope.boatId
  )
}

/** The session files worth copying: small, and the only keys rebuilt from a date. */
export const MIGRATABLE_LEAVES = [
  'log.json',
  'events.json',
  'meta.json',
  'photos.json',
  'sync-manifest.json',
] as const

/**
 * Should this flat object be copied?
 *
 * Only the five session JSON files. Everything else under a day — photos, proxies,
 * clip originals — already has its absolute key stored in the database
 * (bunny_storage_path / bunny_proxy_path / bunny_original_path) and is read back
 * verbatim, so it keeps working exactly where it is and moving it would only risk
 * breaking the rows that point at it. It is also far too large to pull through a
 * serverless function.
 */
export function isMigratable(objectName: string): boolean {
  return (MIGRATABLE_LEAVES as readonly string[]).includes(objectName)
}

export interface DateAudit {
  date: string
  verdict: AuditVerdict
  /** Flat objects directly under `sessions/<date>/`. */
  sessionFiles: string[]
  /** Sub-directories (photos/, proxies/, originals/, videos/) left in place. */
  directories: string[]
}

/** One line per date, for a human reading the report. */
export function summarise(audits: DateAudit[]): {
  dates: number
  collisions: string[]
  unclaimed: string[]
  claimable: number
} {
  return {
    dates: audits.length,
    collisions: audits.filter((a) => a.verdict.kind === 'collision').map((a) => a.date),
    unclaimed: audits.filter((a) => a.verdict.kind === 'unclaimed').map((a) => a.date),
    claimable: audits.filter((a) => a.verdict.kind === 'unambiguous').length,
  }
}
