// src/lib/tagging/requests.ts
// ─────────────────────────────────────────────────────────────────────────────
// Asking for things, and building the shortlist.
//
// Two request kinds with genuinely different shapes:
//
//   VIDEO     "pull me the clip of that peel". A day makes far more footage than
//             anyone will upload, so this needs someone to say yes. Coach,
//             manager, admin — and anyone in the MEDIA section, because the
//             drone operator is holding the footage and should not need a
//             coach's sign-off to hand over what they already have.
//
//   DEBRIEF   "let's talk about that tonight". No approver. Anyone who sails can
//             nominate; the nominations ARE the shortlist; the coach picking one
//             onto the reel is the approval.
//
// The vote count matters. Five people asking about the same gybe is the
// strongest signal a shortlist has, and it comes for free from letting everyone
// nominate — which is most of the argument for the crew tagging at all rather
// than one analyst deciding what mattered.
//
// The UI's copy of the RLS in migration 0063. Pure.
// ─────────────────────────────────────────────────────────────────────────────

import { isCrew } from './gating'
import type {
  TagEvent, TagRequest, TaggerIdentity, TagWithRequests,
} from './types'

/** Coach tier, admin, or the media section — the people who can say yes to
 *  footage. Mirrors public.can_approve_media(). */
export function canApproveMedia(me: TaggerIdentity): boolean {
  if (me.role === 'admin' || me.role === 'coach' || me.role === 'team_manager') return true
  return (me.sections || []).includes('media')
}

/** Who decides what actually gets debriefed. The campaign-edit tier, same as
 *  every other editorial call in SSA. */
export const canCurateReel = (me: TaggerIdentity): boolean =>
  me.role === 'admin' || me.role === 'coach' || me.role === 'tl3' || me.role === 'team_manager'

/** Who may ask for anything at all: everyone who sails. */
export const canRequest = (me: TaggerIdentity): boolean => isCrew(me.role)

/** Roll the day's requests up onto their tags. */
export function withRequests(tags: TagEvent[], requests: TagRequest[]): TagWithRequests[] {
  const byTag = new Map<string, TagRequest[]>()
  for (const r of requests) {
    const list = byTag.get(r.tagEventId)
    if (list) list.push(r)
    else byTag.set(r.tagEventId, [r])
  }
  return tags.map((tag) => {
    const rs = byTag.get(tag.id) || []
    return {
      tag,
      requests: rs,
      // A declined nomination stops counting; an open or approved one counts.
      debriefVotes: rs.filter((r) => r.kind === 'debrief' && r.status !== 'declined').length,
      videoPending: rs.filter((r) => r.kind === 'video' && (r.status === 'open' || r.status === 'approved')).length,
    }
  })
}

export interface ShortlistOptions {
  /** Tags already on the reel always appear, in reel order, at the top. */
  includeSelected?: boolean
  /** Drop candidates nobody nominated and nothing marked for review. */
  nominatedOnly?: boolean
}

/**
 * The debrief shortlist: what the coach chooses from.
 *
 * Ordered so the strongest candidates are at the top —
 *
 *   1. already on the reel (in the coach's own order),
 *   2. then by how many people nominated it,
 *   3. then the ones somebody flagged for review,
 *   4. then by time.
 *
 * This is the thing a debrief actually works through. A day has a hundred and
 * forty tags; an evening has room for five.
 */
export function buildShortlist(
  items: TagWithRequests[],
  options: ShortlistOptions = {}
): TagWithRequests[] {
  const o = { includeSelected: true, nominatedOnly: false, ...options }

  const candidates = items.filter((i) => {
    if (i.tag.rejected) return false
    if (i.tag.scope === 'personal') return false   // never someone else's business
    if (i.tag.reelOrder != null) return o.includeSelected
    if (o.nominatedOnly) return i.debriefVotes > 0
    return i.debriefVotes > 0 || i.tag.slug === 'review' || i.tag.slug === 'incident'
  })

  return candidates.sort((a, b) => {
    const aSel = a.tag.reelOrder != null
    const bSel = b.tag.reelOrder != null
    if (aSel !== bSel) return aSel ? -1 : 1
    if (aSel && bSel) return (a.tag.reelOrder as number) - (b.tag.reelOrder as number)
    if (a.debriefVotes !== b.debriefVotes) return b.debriefVotes - a.debriefVotes
    return a.tag.t0 - b.tag.t0
  })
}

/** The reel itself — what the coach selected, in their order. */
export const reelOf = (items: TagWithRequests[]): TagWithRequests[] =>
  items
    .filter((i) => i.tag.reelOrder != null && !i.tag.rejected)
    .sort((a, b) => (a.tag.reelOrder as number) - (b.tag.reelOrder as number))

/** Video requests still waiting on someone — the media team's queue, oldest
 *  first, because a clip nobody pulls is a promise quietly broken. */
export const videoQueue = (requests: TagRequest[]): TagRequest[] =>
  requests
    .filter((r) => r.kind === 'video' && r.status === 'open')
    .sort((a, b) => a.requestedAt - b.requestedAt)

/** Next free position on the reel. */
export function nextReelOrder(items: TagWithRequests[]): number {
  const used = items.map((i) => i.tag.reelOrder).filter((n): n is number => n != null)
  return used.length ? Math.max(...used) + 1 : 1
}

/** Renumber a reel 1..n after a drag or a removal, so the order never develops
 *  gaps that make "position 7 of 4" possible. */
export function renumberReel(items: TagWithRequests[]): { id: string; reelOrder: number }[] {
  return reelOf(items).map((i, idx) => ({ id: i.tag.id, reelOrder: idx + 1 }))
}
