// Who may put a clip on the open internet.
//
// TL2 and up — the ladder is team_manager → coach → tl3 → tl2 → tl1 — plus the
// boat OWNER, whose membership is TL1 in every other respect (see migration
// 0058) and who exists precisely to share footage. Enforced in the database by
// the video_shares policies; this list is the UI's copy, so the button is not
// offered to someone the database will refuse.

export const SHARE_ROLES = ['admin', 'team_manager', 'coach', 'tl3', 'tl2', 'owner'] as const

export function canShareVideos(role?: string | null): boolean {
  return !!role && (SHARE_ROLES as readonly string[]).includes(role)
}

/** Display name for a membership role. 'owner' is the only one that needs one. */
export const ROLE_LABELS: Record<string, string> = {
  team_manager: 'Team manager',
  coach: 'Coach',
  tl3: 'TL3',
  tl2: 'TL2',
  tl1: 'TL1',
  owner: 'Owner',
  consultant: 'Consultant',
  guest: 'Guest',
}
