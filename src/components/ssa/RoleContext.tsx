'use client'
import React from 'react'

// ── The viewer's effective role ──────────────────────────────────────────────
// Published on a context for the same reason the venue clock is (TzContext):
// the alternative is threading it through components that have no other use for
// it. A photo lightbox opened from the timeline needs it only to decide whether
// to offer sharing WITH the data overlay, and the path to it runs through
// DayTimeline, DayMedia and SailMediaPanel, none of which knows about roles.
//
// EFFECTIVE, not the membership role: that is what every other gate in the app
// is computed from (`rolePermissions(effectiveRole)`), so a context carrying the
// other one would quietly disagree with all of them.
//
// Null means unknown, which is the safe reading — every gate here is an allow
// list, so an unknown role is offered nothing it has not earned.
const RoleCtx = React.createContext<string | null>(null)

const useRole = (): string | null => React.useContext(RoleCtx)

export { RoleCtx, useRole }
