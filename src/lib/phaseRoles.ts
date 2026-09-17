// Who may do what with phases.
//
// The ladder is team_manager → coach → tl3 → tl2 → tl1 (migration 0058; the boat OWNER
// sits at TL1 for everything except the things they exist to do).
//
//   BUILD  — TL2 and up: cutting a stretch of the day into phases is analysis, it stays
//            on the device, and nothing a TL2 does here can reach anybody else.
//   UPLOAD — Coach and up: putting phases in the cloud changes what the rest of the team
//            sees and what later work is measured against. The database says the same
//            (the RLS policy is the authority; this list is the UI's copy, so a button
//            is not offered to someone the server will refuse).

export const BUILD_PHASE_ROLES = ['admin', 'team_manager', 'coach', 'tl3', 'tl2'] as const
export const UPLOAD_PHASE_ROLES = ['admin', 'team_manager', 'coach'] as const

export function canBuildPhases(role?: string | null): boolean {
  return !!role && (BUILD_PHASE_ROLES as readonly string[]).includes(role)
}

export function canUploadPhases(role?: string | null): boolean {
  return !!role && (UPLOAD_PHASE_ROLES as readonly string[]).includes(role)
}

// What to tell someone who cannot do it, rather than hiding the control with no reason.
export function phaseRoleNote(role?: string | null): string | null {
  if (canUploadPhases(role)) return null
  if (canBuildPhases(role)) return 'Phases you build stay on this device — a coach uploads them to the team.'
  return 'Building phases is for TL2 and up.'
}
