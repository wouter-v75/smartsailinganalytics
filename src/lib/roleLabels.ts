// What a role is CALLED, in one place.
//
// The database stores `tl1` and `tl3`. People see Sailor Silver and Sailor Gold.
// Those are not the same vocabulary and they do not have to be: the stored value
// is an identifier that 84 RLS policies depend on, and the label is a word on a
// screen that can change whenever the naming does.
//
// Everything human-facing reads from here — role pickers, invitations, the
// manual, the permission matrix. Nothing should spell a role name inline, which
// is how "TL3" ended up in front of customers in the first place.
//
// `tl2` is deliberately absent: removed in migration 0083, its holders promoted
// to tl3. It is listed in LEGACY_ROLE_LABELS only so an old record still renders
// as something rather than blank.

export type Role =
  | 'admin'
  | 'team_manager'
  | 'coach'
  | 'tl3'
  | 'tl1'
  | 'owner'
  | 'consultant'
  | 'guest'

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  team_manager: 'Team manager',
  coach: 'Coach',
  tl3: 'Sailor Gold',
  tl1: 'Sailor Silver',
  owner: 'Owner',
  consultant: 'Consultant',
  guest: 'Guest',
}

// One line each, for the role picker — so whoever assigns a role can tell the
// two sailor tiers apart without opening the permission matrix.
export const ROLE_HINTS: Partial<Record<Role, string>> = {
  team_manager: 'Runs the team: boats, people, invitations',
  coach: 'Everything for the boats they coach',
  tl3: 'Senior sailor — uploads days, sees the analysis, edits boat setup',
  tl1: 'Sailor — sees the day, the map and the media',
  owner: 'Sees the team’s days; no data tools',
  consultant: 'External, and only inside the dates you set',
  guest: 'The most recent day only',
}

/** Roles that may be assigned today, most senior first. */
export const ASSIGNABLE_ROLES: Role[] = [
  'team_manager', 'coach', 'tl3', 'tl1', 'owner', 'consultant', 'guest',
]

// Anything that no longer exists but may still appear in an old audit row.
const LEGACY_ROLE_LABELS: Record<string, string> = {
  tl2: 'Sailor Gold (was TL2)',
}

export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—'
  return ROLE_LABELS[role as Role] ?? LEGACY_ROLE_LABELS[role] ?? role
}
