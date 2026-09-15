// src/lib/tagging/sections.ts
// ─────────────────────────────────────────────────────────────────────────────
// Crew sections — the departments a boat is organised into. A membership sits in
// one (memberships.section); a SECTION tag belongs to one, and is offered only to
// the crew who sail in it.
//
// This list is the app's copy of the CHECK constraint in migration 0062. Extend
// them together or the database will refuse the write.
// ─────────────────────────────────────────────────────────────────────────────

export interface CrewSection {
  key: string
  label: string
  /** Short form for chips and the section filter row. */
  short: string
  color: string
}

export const CREW_SECTIONS: CrewSection[] = [
  { key: 'afterguard', label: 'Afterguard', short: 'AG', color: '#EF4444' },
  { key: 'navigation', label: 'Navigation', short: 'NAV', color: '#06B6D4' },
  { key: 'helm', label: 'Helm', short: 'HLM', color: '#D85A30' },
  { key: 'trim', label: 'Trim', short: 'TRM', color: '#1D9E75' },
  { key: 'pit', label: 'Pit', short: 'PIT', color: '#F59E0B' },
  { key: 'mast', label: 'Mast', short: 'MST', color: '#8B5CF6' },
  { key: 'bow', label: 'Bow', short: 'BOW', color: '#7F77DD' },
  { key: 'grinders', label: 'Grinders', short: 'GRD', color: '#94A3B8' },
  { key: 'coaching', label: 'Coaching', short: 'CCH', color: '#2DD4BF' },
  { key: 'shore', label: 'Shore team', short: 'SHR', color: '#64748B' },
  { key: 'media', label: 'Media', short: 'MED', color: '#EC4899' },
]

const BY_KEY: Record<string, CrewSection> = Object.fromEntries(
  CREW_SECTIONS.map((s) => [s.key, s])
)

export const SECTION_KEYS: string[] = CREW_SECTIONS.map((s) => s.key)

export const isCrewSection = (v: unknown): v is string =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(BY_KEY, v)

export const sectionOf = (key: unknown): CrewSection | null =>
  isCrewSection(key) ? BY_KEY[key] : null

export const sectionLabel = (key: unknown): string => sectionOf(key)?.label || String(key ?? '')

export const sectionColor = (key: unknown): string => sectionOf(key)?.color || '#64748B'
