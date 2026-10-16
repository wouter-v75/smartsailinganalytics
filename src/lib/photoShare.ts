// src/lib/photoShare.ts
// ─────────────────────────────────────────────────────────────────────────────
// Sharing a photograph out of SSA, with or without the data burned into it.
//
// TWO DIFFERENT THINGS LEAVE THE BUILDING. The picture is a picture: a crew
// member sending a nice shot of the boat to a friend is not giving anything
// away. The same frame with the overlay on it carries the day's TWS, TWA, boat
// speed, heel, the mast settings and whatever sail-geometry millimetres have
// been measured on it — which is the programme's own analysis, and the reason
// anybody pays for this.
//
// So the plain share is for everyone and the overlay share is Sailor Gold and
// up, on the same ladder as putting a clip on the open internet
// (`shareRoles.ts`): team_manager → coach → tl3 (Gold) → tl1 (Silver), plus the
// boat OWNER, whose membership is Silver in every other respect and who exists
// precisely to share material.
//
// The gate is HERE rather than in the component so it can be tested, and so the
// decision is made once: `shareModeFor` takes what was asked for and returns
// what is allowed, which means a stale bit of UI state cannot ask for the
// overlay and get it.
// ─────────────────────────────────────────────────────────────────────────────

import { SHARE_ROLES } from './shareRoles'

export type ShareMode = 'plain' | 'with-data'

/** May this role share a frame with the data overlay burned in? */
export function canShareWithData(role?: string | null): boolean {
  return !!role && (SHARE_ROLES as readonly string[]).includes(role)
}

/**
 * The mode actually permitted, given what was asked for.
 *
 * Downgrades rather than refusing: someone who may not share the data can still
 * share the photograph, and silently getting the picture is better than a
 * button that does nothing. The caller is told which it got so it can say so.
 */
export function shareModeFor(role: string | null | undefined, wanted: ShareMode): ShareMode {
  return wanted === 'with-data' && !canShareWithData(role) ? 'plain' : wanted
}

/** Why the overlay option is not on offer, in the words the rest of the app uses. */
export const SHARE_DATA_DENIED = 'Sharing a photo with the data overlay is for Sailor Gold and up.'

/**
 * What the shared file is called.
 *
 * The mode is in the NAME, because the two files are indistinguishable once
 * they are in somebody's camera roll and only one of them is safe to forward.
 */
export function shareFileName(photoName: string | null | undefined, mode: ShareMode): string {
  const stem = (photoName || '')
    .replace(/\.[^.]+$/, '')              // drop the extension; the file is a JPEG now
    .replace(/[^\w.-]+/g, '_')             // anything a filesystem or a URL would argue with
    .replace(/^[_.-]+|[_.-]+$/g, '')       // no leading or trailing punctuation
  // A name of nothing but punctuation sanitises to separators and no letters,
  // which is still truthy — so the fallback has to test for a usable character
  // rather than for an empty string.
  const safe = /[a-z0-9]/i.test(stem) ? stem : 'photo'
  return `${safe}${mode === 'with-data' ? '_data' : ''}.jpg`
}
