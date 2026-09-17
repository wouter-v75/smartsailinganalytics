// Where a session's files live in the Bunny Storage zone.
//
// ── THE PROBLEM ──────────────────────────────────────────────────────────────
// Every key was `sessions/<date>/…` — the date and nothing else. No team, no
// boat. The zone is shared by every tenant, so two boats sailing the same day
// wrote the same `sessions/2026-09-11/log.json`, and the second one silently won.
// Same for events.json, meta.json, photos.json and the sync manifest. The photo
// wipe was worse: it deleted `sessions/<date>/photos/` wholesale, so a coach
// clearing THEIR day removed every other team's photos for that date too — the
// route around it checks Coach+ on the team, which is exactly the check the key
// then ignored.
//
// ── THE LAYOUT ───────────────────────────────────────────────────────────────
//   scoped:  teams/<teamId>/boats/<boatId>/sessions/<date>/…
//   legacy:  sessions/<date>/…
//
// ── HOW THE MIGRATION WORKS: NOTHING MOVES ───────────────────────────────────
// Rewriting a live zone is the risky way to do this, and it is not needed:
//
//   • WRITES go to the scoped key.
//   • READS try the scoped key, then fall back to the legacy one. Everything
//     already in the zone keeps loading, in place, forever if need be.
//   • DELETES only ever touch the scoped prefix, so one team can no longer reach
//     another's objects. Note what that means for old data: a day-wipe on a
//     PRE-MIGRATION day now leaves the legacy objects where they are, because
//     deleting them would be the very cross-tenant reach this is removing. They
//     have to be cleared deliberately, by a backfill that knows whose they are.
//   • Paths already STORED in the database (photos.bunny_storage_path,
//     videos.bunny_proxy_path / bunny_original_path / bunny_storage_path) are
//     absolute and read back verbatim to sign a URL. They are not rebuilt from a
//     date, so they are unaffected either way.
//
// No scope (a signed-in user with no active membership) falls back to the legacy
// key, which is precisely what shipped before — such a user is no worse off.

/** The team + boat a session belongs to. */
export interface StorageScope {
  teamId: string | null | undefined
  boatId: string | null | undefined
}

/**
 * Keep an id to one harmless path segment. These are UUIDs in practice, but a key
 * is a path: one `..` or `/` in the wrong place walks out of the prefix that is
 * the whole point of this file.
 */
function seg(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const clean = v.trim().replace(/[^A-Za-z0-9._-]/g, '')
  // Anything made only of dots is refused, not just '.' and '..'. Stripping the
  // separators out of '../../..' leaves '......', which passes a two-case check
  // and yields a nonsense segment — harmless as a path, but it is not an id, and
  // a rule that says "one harmless segment" should say no to it.
  if (!clean || /^\.+$/.test(clean)) return null
  return clean
}

/** YYYY-MM-DD, or null. A date is a path segment too. */
function dateSeg(date: string | null | undefined): string | null {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

/**
 * `teams/<team>/boats/<boat>/sessions/<date>/`, or null when the scope or date is
 * incomplete — in which case the caller uses the legacy prefix.
 */
export function scopedSessionPrefix(
  scope: StorageScope | null | undefined,
  date: string | null | undefined
): string | null {
  const team = seg(scope?.teamId)
  const boat = seg(scope?.boatId)
  const day = dateSeg(date)
  if (!team || !boat || !day) return null
  return `teams/${team}/boats/${boat}/sessions/${day}/`
}

/** `sessions/<date>/` — what every key looked like before this file existed. */
export function legacySessionPrefix(date: string | null | undefined): string | null {
  const day = dateSeg(date)
  return day ? `sessions/${day}/` : null
}

/**
 * The prefix to WRITE under: scoped when we know whose it is, legacy otherwise.
 * Never null for a valid date, so no caller has to handle "nowhere to put it".
 */
export function writePrefix(
  scope: StorageScope | null | undefined,
  date: string | null | undefined
): string | null {
  return scopedSessionPrefix(scope, date) ?? legacySessionPrefix(date)
}

/**
 * Every place a leaf might be, best first. Read through these in order and take
 * the first hit; that is the whole migration.
 *
 * `leaf` is the part after the session prefix, e.g. `log.json` or
 * `photos/p_123_thumb.jpg`.
 */
export function readCandidates(
  scope: StorageScope | null | undefined,
  date: string | null | undefined,
  leaf: string
): string[] {
  const tail = leaf.replace(/^\/+/, '')
  const out: string[] = []
  const scoped = scopedSessionPrefix(scope, date)
  if (scoped) out.push(scoped + tail)
  const legacy = legacySessionPrefix(date)
  // A scopeless caller must not be handed the legacy key twice.
  if (legacy && legacy + tail !== out[0]) out.push(legacy + tail)
  return out
}

/** The single key to write `leaf` to. Null only when the date is unusable. */
export function writeKey(
  scope: StorageScope | null | undefined,
  date: string | null | undefined,
  leaf: string
): string | null {
  const prefix = writePrefix(scope, date)
  return prefix ? prefix + leaf.replace(/^\/+/, '') : null
}

// ── The session's own files ──────────────────────────────────────────────────

export const SESSION_LEAVES = {
  log: 'log.json',
  events: 'events.json',
  meta: 'meta.json',
  photoIndex: 'photos.json',
  syncManifest: 'sync-manifest.json',
} as const

/** Leaves for one photo's three objects. */
export const photoLeaves = (id: string) => ({
  original: `photos/${id}.jpg`,
  thumb: `photos/${id}_thumb.jpg`,
  meta: `photos/${id}_meta.json`,
})

/** Leaf for a clip's transcoded proxy / its original. */
export const proxyLeaf = (videoId: string) => `proxies/${videoId}.mp4`
export const originalLeaf = (videoId: string) => `originals/${videoId}.mp4`
/** The older per-clip original layout, still referenced by rows in the database. */
export const videoOriginalLeaf = (videoId: string) => `videos/${videoId}/original`

/**
 * The prefix a day's photos live under, for the day-wipe. SCOPED ONLY — returning
 * the legacy prefix here is the cross-tenant delete this file exists to stop, so
 * an unscoped caller gets null and must delete nothing.
 */
export function scopedPhotoPrefix(
  scope: StorageScope | null | undefined,
  date: string | null | undefined
): string | null {
  const prefix = scopedSessionPrefix(scope, date)
  return prefix ? `${prefix}photos/` : null
}
