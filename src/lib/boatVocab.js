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
  ]).then(([sj, bj]) => {
    const names = Array.from(new Set((sj.sails || [])
      .filter((s) => !s.retired)
      .map((s) => String(s.name || '').replace(/[_-]\d{2,4}$/, '').replace(/_/g, ' ').trim())
      .filter(Boolean)))
    const boat = (bj.boats || []).find((b) => b.id === boatId)
    const vocab = vocabForBoat(boat?.name) || {}
    const extra = {
      ...vocab,
      ...(names.length ? { sails: [...(vocab.sails || []), ...names] } : {}),
    }
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
