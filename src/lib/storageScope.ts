// Which team+boat prefix this device is reading and writing in Bunny Storage.
//
// Everything in the zone is keyed by it now (src/lib/storageKeys.ts). Null — a
// signed-in user with no active membership — falls back to the flat
// pre-migration layout, which is exactly what such a user always had.

import { getUidFast } from './supabase/browser'
import { getActiveMembership } from './active-membership'
import type { StorageScope } from './storageKeys'

export async function currentStorageScope(): Promise<StorageScope | null> {
  try {
    const uid = await getUidFast()
    const m = uid ? getActiveMembership(uid) : null
    return m?.team_id && m?.boat_id ? { teamId: m.team_id, boatId: m.boat_id } : null
  } catch {
    return null
  }
}

/** Same thing from a membership already in hand — no round trip. */
export function scopeOfMembership(
  m: { team_id?: string | null; boat_id?: string | null } | null | undefined
): StorageScope | null {
  return m?.team_id && m?.boat_id ? { teamId: m.team_id, boatId: m.boat_id } : null
}
