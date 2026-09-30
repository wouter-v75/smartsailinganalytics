// The boat's live vocabulary for the summariser: the sail wardrobe off the Boat
// tab plus the class glossary, so sail names self-maintain instead of being
// hand-listed in a prompt.
//
// Cached per (team, boat) at module scope because a day's page can mount a
// dozen note recorders and every one of them wants the same two rows. Without
// the cache each note button fires its own pair of fetches on mount.
//
// Crew and rival-boat names are per-team on purpose: priming the summariser
// with another team's people places those people in a session they never sailed.
import { vocabForBoat } from './debriefGlossary'
import { isEmptyVocab, normaliseDebriefVocab } from './debriefVocab'

const cache = new Map() // `${teamId}:${boatId}` → Promise<vocab|null>

export function loadBoatVocab(teamId, boatId) {
  if (!teamId || !boatId) return Promise.resolve(null)
  const key = `${teamId}:${boatId}`
  if (cache.has(key)) return cache.get(key)

  const p = Promise.all([
    fetch(`/api/teams/${teamId}/sails?boat_id=${boatId}`)
      .then((r) => (r.ok ? r.json() : { sails: [] })).catch(() => ({ sails: [] })),
    fetch(`/api/teams/${teamId}/boats`)
      .then((r) => (r.ok ? r.json() : { boats: [] })).catch(() => ({ boats: [] })),
    // The boat's OWN words, edited in Boat → Debrief words. Failing to fetch
    // them must not lose the code defaults: a debrief with the old glossary is
    // worth far more than a debrief with none.
    fetch(`/api/teams/${teamId}/boats/${boatId}/debrief-vocab`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]).then(([sj, bj, vj]) => {
    const names = Array.from(new Set((sj.sails || [])
      .filter((s) => !s.retired)
      .map((s) => String(s.name || '').replace(/[_-]\d{2,4}$/, '').replace(/_/g, ' ').trim())
      .filter(Boolean)))
    const boat = (bj.boats || []).find((b) => b.id === boatId)
    const vocab = vocabForBoat(boat?.name) || {}
    // The stored vocabulary is ADDED to the code defaults, never a replacement.
    // An empty list has to mean "I did not type anything here", not "this boat
    // has no crew": a first save of one mishearing would otherwise wipe the
    // fifteen names and nine rival boats that TEAM_VOCAB already carries, and
    // nothing would say so until a name came back wrong. withOverride() dedups,
    // so an entry typed in that is already in code costs nothing.
    const own = normaliseDebriefVocab(vj?.vocab)
    const add = isEmptyVocab(own) ? {} : own
    const merge = (k, base) => {
      const mine = add[k] || []
      return mine.length ? [...(base || []), ...mine] : base
    }
    const extra = {
      ...vocab,
      ...(names.length ? { sails: [...(vocab.sails || []), ...names] } : {}),
      crew: merge('crew', vocab.crew),
      boats: merge('boats', vocab.boats),
      roles: merge('roles', vocab.roles),
      manoeuvres: merge('manoeuvres', vocab.manoeuvres),
      aliases: merge('aliases', vocab.aliases),
      fixups: merge('fixups', vocab.fixups),
    }
    // Drop the keys that ended up undefined, so an untouched list does not
    // arrive at withOverride() as an explicit empty one.
    for (const k of Object.keys(extra)) if (extra[k] === undefined) delete extra[k]
    return Object.keys(extra).length ? extra : null
  }).catch(() => null)

  cache.set(key, p)
  return p
}

// Sails change during a campaign; let a caller drop the entry after an edit.
export function clearBoatVocab(teamId, boatId) {
  if (teamId && boatId) cache.delete(`${teamId}:${boatId}`)
  else cache.clear()
}
