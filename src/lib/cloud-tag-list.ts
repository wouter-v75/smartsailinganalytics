// Cloud-backed tag list. Reads / writes the per-(team, boat) vocabulary
// stored in public.tag_lists. Falls back to localStorage when there's no
// active membership (e.g. a user pre-L3.A who hasn't been assigned to any
// team yet — the existing app keeps working unchanged).

import { getActiveMembership } from './active-membership'

const LEGACY_PREFIX = 'ssa:taglist:'

function legacyGet(date: string): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_PREFIX + date)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function legacySet(date: string, list: string[]): void {
  try {
    localStorage.setItem(LEGACY_PREFIX + date, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

interface CloudArgs {
  userId: string
  date: string // legacy fallback key when not signed-in / no membership
}

export async function fetchTagList({
  userId,
  date,
}: CloudArgs): Promise<string[]> {
  const m = getActiveMembership(userId)
  if (!m) return legacyGet(date)

  const url = `/api/teams/${m.team_id}/tag-list${
    m.boat_id ? `?boat_id=${m.boat_id}` : ''
  }`
  try {
    const res = await fetch(url)
    if (!res.ok) return legacyGet(date)
    const j = (await res.json()) as { tags?: string[] }
    return j.tags || []
  } catch {
    return legacyGet(date)
  }
}

export async function saveTagListCloud({
  userId,
  date,
  tags,
}: CloudArgs & { tags: string[] }): Promise<string[]> {
  const m = getActiveMembership(userId)
  // Always also save to legacy localStorage as a cache + fallback.
  legacySet(date, tags)
  if (!m) return tags

  try {
    const res = await fetch(`/api/teams/${m.team_id}/tag-list`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags, boat_id: m.boat_id }),
    })
    if (!res.ok) return tags
    const j = (await res.json()) as { tags?: string[] }
    return j.tags || tags
  } catch {
    return tags
  }
}

export async function mergeTagListCloud(
  args: CloudArgs & { newTags: string[] }
): Promise<string[]> {
  const existing = await fetchTagList(args)
  const merged = Array.from(new Set([...existing, ...args.newTags]))
  return saveTagListCloud({ ...args, tags: merged })
}
