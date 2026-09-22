// src/lib/squadComments.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reading and writing the squad's conversation about one tagged moment.
//
// Kept out of the component so the rules are testable without a DOM: who may
// delete what, how an author is named, and — the one that matters — the
// difference between "nobody has said anything" and "we could not ask".
//
// THAT DISTINCTION IS NOT PEDANTRY HERE. A failed fetch rendered as an empty
// thread is exactly how the squad feature hid a recursive RLS policy for a
// day: the UI showed nothing, nothing looked broken, and nobody reported it.
// So loadComments returns a state, not an array.
// ─────────────────────────────────────────────────────────────────────────────

export interface SquadComment {
  id: string
  tag_event_id: string
  owner_team_id: string
  author_user_id: string
  author_team_id: string
  body: string
  created_at: string
  updated_at?: string
  author?: { name?: string | null; email?: string | null } | null
  team?: { name?: string | null } | null
}

export type CommentsState =
  | { kind: 'ok'; comments: SquadComment[]; viewerId: string | null }
  /** The table is not there yet — 0074 unapplied. Not an error to shout about. */
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

export async function loadComments(
  tagId: string,
  fetchImpl: typeof fetch = fetch
): Promise<CommentsState> {
  try {
    const res = await fetchImpl(`/api/tags/${encodeURIComponent(tagId)}/comments`)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      return { kind: 'error', message: j?.error || `the server answered ${res.status}` }
    }
    const j = await res.json()
    if (j?.needsMigration) return { kind: 'unavailable' }
    return { kind: 'ok', comments: j?.comments || [], viewerId: j?.viewerId ?? null }
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : 'could not reach the server' }
  }
}

export async function addComment(
  tagId: string,
  authorTeamId: string,
  body: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; comment: SquadComment } | { ok: false; error: string }> {
  const text = body.trim()
  if (!text) return { ok: false, error: 'a comment needs some words' }
  try {
    const res = await fetchImpl(`/api/tags/${encodeURIComponent(tagId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text, author_team_id: authorTeamId }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: j?.error || `the server answered ${res.status}` }
    return { ok: true, comment: j.comment }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not reach the server' }
  }
}

export async function deleteComment(
  tagId: string,
  commentId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchImpl(
      `/api/tags/${encodeURIComponent(tagId)}/comments?id=${encodeURIComponent(commentId)}`,
      { method: 'DELETE' }
    )
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      return { ok: false, error: j?.error || `the server answered ${res.status}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not reach the server' }
  }
}

/**
 * Only your own words, ever — not the owning team's, not an admin's here.
 *
 * Deleting somebody else's sentence out of your debrief is not a power the
 * schema hands out (0074): a team that dislikes a comment un-shares the
 * category, which hides the thread without rewriting what was said. This
 * mirrors squad_comments_delete so the button matches what the server will do.
 */
export function canDelete(c: SquadComment, viewerId: string | null): boolean {
  return Boolean(viewerId) && c.author_user_id === viewerId
}

/** "Jonathan Gagachian · Team Torvar", falling back through what we have. */
export function authorLine(c: SquadComment): string {
  const who = c.author?.name?.trim() || c.author?.email?.trim() || 'Someone'
  const team = c.team?.name?.trim()
  return team ? `${who} · ${team}` : who
}

/**
 * Is this comment from OUTSIDE the team that owns the tag?
 *
 * Worth marking in the UI. The whole point of the feature is a rival's coach
 * looking at your tack, and a thread that renders their words identically to
 * your own crew's loses the one piece of context that makes it useful.
 */
export function isFromPartner(c: SquadComment): boolean {
  return c.author_team_id !== c.owner_team_id
}
