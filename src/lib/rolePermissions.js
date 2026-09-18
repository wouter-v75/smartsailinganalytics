
// Role-gated convenience flags for the app shell.
//
// These were nine `const`s in SSAApp, split across two places with unrelated
// effects wedged between them, so the role matrix could only be read by
// grepping. Gathered here so the whole matrix is visible at once and can be
// tested — the expressions themselves are unchanged.
//
// These flags decide what the UI OFFERS. They are not the security boundary:
// the database's RLS policies are, and every API route checks the caller
// independently. A flag that reads too permissively shows a control that then
// fails server-side; it does not grant access.
//
//   tl1        no SailScan, no analytics data (the map is fine), no
//              SailScan-tagged photos.
//   owner      same restrictions as tl1.
//   guest      the above, plus no SquashShots, and only the latest session day.
//   consultant full access — already bounded by valid_from/valid_to in RLS —
//              except AI, which is metered per team.
//
// effectiveRole === null means "still resolving". Every flag defaults
// PERMISSIVE there, so an admin does not watch the UI hide things from them
// for a moment on every load.
export function rolePermissions(effectiveRole) {
  return {
    canSeeSailScanTab:    !['tl1','owner','guest'].includes(effectiveRole),
    canSeeSquashShotsTab: effectiveRole !== 'guest',
    // Tools tab (Squash + SailScan combined): TL2 and above, plus consultant.
    // Named roles rather than an exclusion list, so a role added later is
    // hidden until someone decides it belongs.
    canSeeToolsTab:       ['admin','team_manager','coach','tl3','tl2','consultant'].includes(effectiveRole),
    // Boat Config tab: TL3 and above (the senior team-leadership ladder), not
    // TL2 or lower. EDITS are TL3+ via EDIT_ROLES in BoatConfigTab and the DB
    // RLS. A consultant (a sailmaker, say) gets the tab but sees only the Sail
    // inventory + Sail data sub-tabs — Rig / Targets / Log profile are hidden
    // inside BoatConfigTab via canSeeTuning.
    canSeeBoatConfig:     ['admin','team_manager','coach','tl3','consultant'].includes(effectiveRole),
    canSeeAnalyticsData:  !['tl1','owner','guest'].includes(effectiveRole),
    canSeeSailScanPhotos: !['tl1','owner','guest'].includes(effectiveRole),
    canUseAI:             effectiveRole === null || !['tl1','owner','consultant','guest'].includes(effectiveRole),
    showOnlyLatestDay:    effectiveRole === 'guest',
    // Kept for backwards-compat with the mobile shell prop; the Analytics tab
    // is visible to every role now and the content inside is what is gated.
    canSeeAnalytics:      true,
  };
}
