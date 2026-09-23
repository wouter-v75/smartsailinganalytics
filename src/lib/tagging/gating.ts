// src/lib/tagging/gating.ts
// ─────────────────────────────────────────────────────────────────────────────
// Who may do what with a tag. This is the UI's copy of the RLS policies in
// migration 0062 — the database is the authority, this exists so the app never
// offers a button the database is going to refuse.
//
// Two things gate a tag, and they are NOT the same thing:
//
//   1. the COARSE tier — may this role touch tags at all, and is this their
//      section? Spelled out as explicit role lists, exactly like RLS, because
//      has_team_role() is deliberately not a general ladder (see 0040 / 0058:
//      tl3 passes tl1/tl2 gates, owner passes tl1 gates, and that is all).
//   2. the tag's own `min_role` — editorial policy the crew sets per tag
//      ("the race-start tag is TL3 and up"). That one IS a ladder, so it needs
//      a rank, which is what ROLE_RANK is for. It narrows; it never widens.
// ─────────────────────────────────────────────────────────────────────────────

import type { TagDef, TagEvent, TagScope, TaggerIdentity } from './types'

/** Ladder used ONLY to compare a tag's min_role against a user's role. */
export const ROLE_RANK: Record<string, number> = {
  admin: 100,
  team_manager: 60,
  coach: 60,
  tl3: 50,
  tl2: 40,
  tl1: 30,
  owner: 30, // owner ≡ tl1 everywhere but video sharing (migration 0058)
  consultant: 25,
  guest: 10,
}

/** Roles a tag's min_role can be set to, most permissive first. */
export const MIN_ROLE_CHOICES = ['tl1', 'tl3', 'coach'] as const

/** May APPLY tags — the crew. Mirrors ARRAY['coach','tl1','tl3','consultant']
 *  (tl3 and owner pass that gate through has_team_role's tl1/tl2 ladder). */
const CREW_ROLES = new Set(['admin', 'coach', 'tl3', 'tl1', 'owner', 'consultant'])

/** May curate the shared vocabulary and tidy anyone's tag — the campaign-edit
 *  tier. Mirrors ARRAY['coach','tl3','team_manager']. */
const CURATOR_ROLES = new Set(['admin', 'coach', 'tl3', 'team_manager'])

/** May curate ANY section's vocabulary and apply any section's tags, not just
 *  their own. Mirrors ARRAY['coach','team_manager']. */
const ALL_SECTION_ROLES = new Set(['admin', 'coach', 'team_manager'])

const rank = (role: string | null | undefined): number => ROLE_RANK[String(role ?? '')] ?? 0

export const isCrew = (role: string | null | undefined): boolean => CREW_ROLES.has(String(role ?? ''))
export const isCurator = (role: string | null | undefined): boolean => CURATOR_ROLES.has(String(role ?? ''))
export const isAllSections = (role: string | null | undefined): boolean =>
  ALL_SECTION_ROLES.has(String(role ?? ''))

/** Does this user sail in `section` (or outrank the question)? */
export function inSection(me: TaggerIdentity, section: string | null | undefined): boolean {
  if (!section) return true
  if (isAllSections(me.role)) return true
  return (me.sections || []).includes(section)
}

/** Can this user SEE the definition at all? Personal tags are private to their
 *  owner; everything else is visible to anyone who can read the boat's data
 *  (which RLS has already decided by the time we hold the row). */
export function canSeeTagDef(def: TagDef, me: TaggerIdentity): boolean {
  if (def.scope === 'personal') return def.ownerUserId === me.userId
  return true
}

/** Can this user APPLY the definition to the timeline? */
export function canApplyTagDef(def: TagDef, me: TaggerIdentity): boolean {
  if (def.archived) return false
  if (def.scope === 'personal') return def.ownerUserId === me.userId
  if (!isCrew(me.role)) return false
  if (rank(me.role) < rank(def.minRole)) return false
  if (def.scope === 'section') return inSection(me, def.section)
  return true
}

/** The picker's list: everything visible, applicable first. */
export function applicableTagDefs(defs: TagDef[], me: TaggerIdentity): TagDef[] {
  return defs.filter((d) => canSeeTagDef(d, me) && canApplyTagDef(d, me))
}

/** May this user create/edit vocabulary of this scope (and section)? */
export function canCurateVocabulary(
  scope: TagScope,
  section: string | null | undefined,
  me: TaggerIdentity
): boolean {
  if (scope === 'personal') return true // your own list, always
  if (scope === 'general') return isCurator(me.role)
  // section: coach/manager curate any section, tl3 only their own
  if (isAllSections(me.role)) return true
  return isCurator(me.role) && inSection(me, section)
}

/** May this user MOVE / EDIT / DELETE an applied tag? Author, section-mate, or
 *  the curator tier. */
export function canEditTagEvent(ev: TagEvent, me: TaggerIdentity): boolean {
  if (ev.scope === 'personal') return ev.ownerUserId === me.userId
  if (me.role === 'admin' || isCurator(me.role)) return true
  if (ev.createdByUserId && ev.createdByUserId === me.userId) return true
  if (ev.scope === 'section') return isCrew(me.role) && inSection(me, ev.section)
  return false
}

export const canDeleteTagEvent = canEditTagEvent

/** May this user cut phases out of the track? Crew work. */
export const canBuildPhases = (me: TaggerIdentity): boolean => isCrew(me.role)

/** Why a tag is greyed out in the picker — shown as the chip's title. */
export function applyBlockedReason(def: TagDef, me: TaggerIdentity): string | null {
  if (canApplyTagDef(def, me)) return null
  if (def.archived) return 'Archived'
  if (def.scope === 'personal') return 'Someone else’s personal tag'
  if (!isCrew(me.role)) return 'Your role cannot apply tags'
  if (rank(me.role) < rank(def.minRole)) return `Needs ${def.minRole.toUpperCase()} or above`
  if (def.scope === 'section') return 'Belongs to another crew section'
  return 'Not available to you'
}
