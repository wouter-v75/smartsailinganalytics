// Who may put a clip on the open internet.
//
// Sailor Gold and up — the ladder is team_manager → coach → tl3 (Gold) → tl1
// (Silver) — plus the boat OWNER, whose membership is Silver in every other
// respect (see migration
// 0058) and who exists precisely to share footage. Enforced in the database by
// the video_shares policies; this list is the UI's copy, so the button is not
// offered to someone the database will refuse.

export const SHARE_ROLES = ['admin', 'team_manager', 'coach', 'tl3', 'owner'] as const

export function canShareVideos(role?: string | null): boolean {
  return !!role && (SHARE_ROLES as readonly string[]).includes(role)
}

// Re-exported, not redefined. This file used to keep its own copy of the names,
// which is how a role can end up called two different things in two places.
export { ROLE_LABELS } from './roleLabels'
