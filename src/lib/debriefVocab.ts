// src/lib/debriefVocab.ts
// ─────────────────────────────────────────────────────────────────────────────
// A boat's own debrief vocabulary — the half of the glossary that is TEAM data.
//
// `debriefGlossary.ts` holds what every sailing team shares: the parts, the
// Dutch bridge, the manoeuvre names, the mishearings Whisper makes for anyone.
// It also holds, under TEAM_VOCAB, this squad's crew and rivals — and says so
// itself: "This is per-TEAM data living in code, which is the wrong home for
// it." Every name costs a deploy, and the list is shared by an app that serves
// more than one team.
//
// This is that right home. Six lists on the boat, edited in the Boat tab the way
// the sail wardrobe already is, merged over the code defaults at read time.
//
// WHY THESE SIX. They are what a debrief actually adds: a new crew member, a
// rival that turned up at this regatta, somebody's role, a manoeuvre the team
// names its own way (Sandukan), a piece of slang, and a word the recogniser got
// wrong. Sails are deliberately absent — those already come live from the
// wardrobe, and a second place to type a sail name is a second place for it to
// be wrong.
//
// Pure. No I/O, no React — the route and the panel both call `normalise`, so
// what the browser thinks is a blank entry and what the server stores cannot
// drift apart.
// ─────────────────────────────────────────────────────────────────────────────

/** [what is said / heard, what it means / should be]. */
export type VocabPair = [string, string]

export interface DebriefVocab {
  /** People named in debriefs: crew, shore team, suppliers. */
  crew: string[]
  /** Boats this team races against, by name. */
  boats: string[]
  /** [name, role] — the ONLY roles the summariser may state. */
  roles: VocabPair[]
  /** Manoeuvres this team names its own way. */
  manoeuvres: string[]
  /** [what the crew SAY, what it means] — slang, heard correctly. */
  aliases: VocabPair[]
  /** [what was HEARD, what was meant] — recogniser errors. */
  fixups: VocabPair[]
}

export const VOCAB_LISTS = ['crew', 'boats', 'roles', 'manoeuvres', 'aliases', 'fixups'] as const
export type VocabList = (typeof VOCAB_LISTS)[number]
export const PAIR_LISTS: VocabList[] = ['roles', 'aliases', 'fixups']

export const isPairList = (k: VocabList): boolean => PAIR_LISTS.includes(k)

// Caps. Not arbitrary: the Whisper prompt is 400 characters and the summariser
// prompt shares its window with the transcript, so an unbounded list does not
// fail loudly — it silently pushes the terms that matter out of the prompt. A
// team that needs more than this has outgrown a text box, not the cap.
export const MAX_ENTRIES = 120
export const MAX_ENTRY_CHARS = 120

export const EMPTY_VOCAB: DebriefVocab = {
  crew: [], boats: [], roles: [], manoeuvres: [], aliases: [], fixups: [],
}

const text = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_CHARS) : ''

/** Case-insensitive de-duplication that KEEPS THE FIRST SPELLING. The first one
 *  is the one somebody typed deliberately; a later "jethou" is a repeat, not a
 *  correction, and replacing the entry would quietly restyle a proper noun. */
function uniq(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of list) {
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k); out.push(s)
  }
  return out
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return uniq(v.map(text).filter(Boolean)).slice(0, MAX_ENTRIES)
}

/** A pair needs BOTH halves. A half-typed row — a name with no role, a
 *  mishearing with no correction — would reach the model as an instruction with
 *  no content, and the model would invent the other half. Dropped, silently and
 *  deliberately: the editor keeps the row on screen until it is finished. */
function pairs(v: unknown): VocabPair[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: VocabPair[] = []
  for (const row of v) {
    const a = text(Array.isArray(row) ? row[0] : (row as { from?: unknown })?.from)
    const b = text(Array.isArray(row) ? row[1] : (row as { to?: unknown })?.to)
    if (!a || !b) continue
    const k = a.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k); out.push([a, b])
  }
  return out.slice(0, MAX_ENTRIES)
}

/** Anything at all → a vocabulary. Never throws: this parses a JSONB column
 *  that older rows, a hand-edit in the SQL editor, or a future version may have
 *  left in any shape at all, and a debrief must not fail because of it. */
export function normaliseDebriefVocab(raw: unknown): DebriefVocab {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    crew: strings(v.crew),
    boats: strings(v.boats),
    roles: pairs(v.roles),
    manoeuvres: strings(v.manoeuvres),
    aliases: pairs(v.aliases),
    fixups: pairs(v.fixups),
  }
}

/** Is there anything in it? An empty vocabulary must not override the code
 *  defaults — a boat that has never opened the editor keeps TEAM_VOCAB. */
export function isEmptyVocab(v: DebriefVocab): boolean {
  return VOCAB_LISTS.every((k) => (v[k] as unknown[]).length === 0)
}

export function countVocab(v: DebriefVocab): number {
  return VOCAB_LISTS.reduce((n, k) => n + (v[k] as unknown[]).length, 0)
}

/** What each list is for, in the editor and nowhere else. */
export const VOCAB_LABELS: Record<VocabList, { title: string; hint: string; a?: string; b?: string }> = {
  crew: {
    title: 'People',
    hint: 'Anyone named in a debrief — crew, shore team, suppliers. A name the recogniser has not been primed with comes back wrong, and a wrong name reads as fact.',
  },
  boats: {
    title: 'Boats we race against',
    hint: 'Rivals by name. These are the hardest words in a debrief: "Jolt was called over" became "John was called over", which read as one of our own being OCS.',
  },
  roles: {
    title: 'Roles',
    hint: 'The only roles the summary may state. Anyone not listed gets none — without this the model promoted whoever was mentioned near a steering discussion to helmsman.',
    a: 'Name', b: 'Role',
  },
  manoeuvres: {
    title: 'Manoeuvres',
    hint: 'Ones this team names its own way. Add the word itself here, and what it means under Slang.',
  },
  aliases: {
    title: 'Slang',
    hint: 'What the crew really say, and what it means. These are heard CORRECTLY — they are not errors, they just need explaining, so the summary can say what happened rather than repeat the word.',
    a: 'What is said', b: 'What it means',
  },
  fixups: {
    title: 'Mishearings',
    hint: 'What came out of the transcript wrong, and what was meant. Add one the first time you see it; the summariser repairs it from then on.',
    a: 'Heard as', b: 'Should be',
  },
}
