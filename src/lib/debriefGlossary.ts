// Team sailing glossary — the backbone for debrief transcription + summarisation.
// ONE editable source, TWO renderings:
//   whisperPrompt()  → compact term string to bias Whisper (~224-token budget)
//   glossaryBlock()  → full glossary (incl. Dutch→English + known mishearings) for
//                      the Mistral system prompt.
//
// Debriefs are spoken in Dutch but pepper in English sail names, boat parts and
// manoeuvre names. Whisper mis-hears that low-probability jargon and Mistral then
// summarises the noise. Feeding these terms into both stages is the highest-leverage
// accuracy fix. Checked-in defaults for now; every function takes an optional
// Glossary, so a per-team override (extra sails / real crew names) can be merged in
// later without touching this file.
//
// `fixups` are ASR mishearings observed in real debriefs (tagline→tackline,
// clewline→halyard). Add to this list as new ones surface — it's the cheap, growing
// eval-driven part of the loop.

export type Glossary = {
  sails: string[]
  manoeuvres: string[]
  parts: string[]
  crew: string[]
  boats: string[]      // this boat + the ones the team races against, by name
  dutch: [string, string][]  // [dutch, english]
  fixups: [string, string][] // [wrong (heard), right]
}

// Starter set — refine `sails` and `crew` with the team's actual inventory + names.
export const DEFAULT_GLOSSARY: Glossary = {
  sails: ['BRO', 'MH0', 'A-sail', 'A2', 'A3', 'A1.5', 'S2', 'S4', 'Code 0', 'C0', 'No.1', 'No.3', 'jib top', 'masthead zero', 'staysail', 'mainsail', 'main', 'jib', 'genoa', 'spinnaker', 'kite'],
  manoeuvres: ['inline peel', 'peel curve', 'Vanderbilt start', 'double tack', 'windward-leeward', 'tack', 'gybe', 'inside gybe', 'outside gybe', 'bear-away set', 'gybe set', 'hoist', 'set', 'drop', 'leeward drop', 'windward drop', 'Mexican drop', 'letterbox drop', 'peel', 'inside peel', 'outside peel', 'square', 'round-up', 'takedown', 'windward mark', 'leeward mark', 'offset', 'penalty turn', 'yellow flag'],
  // High-value / most-mangled terms first — whisperPrompt() only takes the leading
  // slice, so keep the ones Whisper fumbles (halyard, tackline, constrictor, luff…) up top.
  parts: ['halyard', 'tackline', 'constrictor', 'self-tailer', 'pit winch', 'primary', 'AWA', 'guy', 'sheet', 'lead', 'pole', 'bowsprit', 'luff', 'draft', 'leech', 'dodger', 'pit', 'foredeck', 'main halyard', 'jib halyard', 'spinnaker halyard', 'top halyard', 'second halyard', 'afterguy', 'lazy guy', 'spinnaker sheet', 'lazy sheet', 'genoa lead', 'jib car', 'prod', 'mast', 'rig', 'backstay', 'runners', 'cunningham', 'outhaul', 'vang', 'kicker', 'foot', 'clew'],
  // NO NAMES HERE. Crew and rival boats are TEAM data, and this object is shared by
  // every team in the app: names listed here are fed into every other team's
  // transcription prompt, where Whisper will happily put them into a session those
  // people were never at. See TEAM_VOCAB below.
  crew: [],
  boats: [],
  dutch: [
    ['grootzeil', 'mainsail'], ['fok', 'jib'], ['genua', 'genoa'], ['val', 'halyard'],
    ['schoot', 'sheet'], ['hals', 'tack'], ['halshoek', 'tack'], ['giek', 'boom'],
    ['overstag', 'tack'], ['gijpen', 'gybe'], ['afvallen', 'bear away'], ['oploeven', 'head up'],
    ['hijsen', 'hoist'], ['strijken', 'drop'], ['loef', 'windward'], ['lij', 'leeward'],
    ['boei', 'mark'], ['stuurboord', 'starboard'], ['bakboord', 'port'], ['rif', 'reef'],
    ['kluiver', 'jib'], ['bakstag', 'runner'], ['bolling', 'draft'], ['bol', 'draft'],
  ],
  // Mishearings actually observed in this team's debriefs. These go to the SUMMARISER
  // as context, never as a blind find-and-replace, which is why entries like
  // "weight"→AWA and "load"→leeward are safe to list: the model applies them only
  // where the sailing sense demands it, and "weight" keeps its ordinary meaning
  // everywhere else.
  fixups: [
    ['tagline', 'tackline'], ['clewline', 'halyard'], ['clew line', 'halyard'],
    // 3 Sept debrief
    ['mo', 'MH0'], ['the mode', 'MH0'], ['emmage zero', 'MH0'],
    ['bro', 'BRO (the reacher — a sail name, never the slang)'],
    ['van der ba', 'Vanderbilt start'], ['vanderbilt', 'Vanderbilt start'],
    ['double tap', 'double tack'],
    ['self-tailor', 'self-tailer'], ['self tailor', 'self-tailer'],
    ['windward load', 'windward-leeward'], ['load focus', 'leeward focus'],
    ['the weight', 'the AWA (when the sense is sail trim, not crew weight)'],
    ['coaster timing', 'coastal peel curve timing'],
  ],
}

// ── Team vocabulary ──────────────────────────────────────────────────────────
// Crew names, rival boats and team-specific mishearings, keyed by a prefix of the
// boat's name. This is per-TEAM data living in code, which is the wrong home for it
// — the right one is a column on the boat, edited from the Boat tab the way the sail
// inventory already is, so a debrief correction does not need a deploy. It is here
// as a stopgap because the alternative was worse: a single shared list put one
// team's crew into another team's prompt, and Whisper will place a name it has been
// primed with into a session that person was never at. A wrong name asserted
// confidently is worse than a garbled one.
export const TEAM_VOCAB: Record<string, Partial<Glossary>> = {
  northstar: {
    crew: ['Shane', 'Frank', 'Nick', 'Jarrod', 'Dougie', 'Pete', 'Peter', 'Vasco'],
    boats: ['Django', 'Bella Mente'],
    fixups: [['splice', 'Bella Mente (boat name)']],
  },
  warp: {
    crew: ['Marc', 'Jan'],
    boats: [],
    fixups: [],
  },
}

// Look up a boat's vocabulary by name ("Northstar 76", "Northstar72", "Warp" …).
export function vocabForBoat(boatName?: string | null): Partial<Glossary> | undefined {
  const n = (boatName || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!n) return undefined
  const key = Object.keys(TEAM_VOCAB).find((k) => n.startsWith(k))
  return key ? TEAM_VOCAB[key] : undefined
}

// Merge a partial team override onto the defaults (dedup, order preserved).
export function withOverride(extra?: Partial<Glossary>, base: Glossary = DEFAULT_GLOSSARY): Glossary {
  if (!extra) return base
  const uniq = (a: string[] = [], b: string[] = []) => Array.from(new Set([...a, ...b]))
  // Sails are INTERLEAVED rather than concatenated, because both lists are
  // high-value and the prompt budget cuts off the tail. Concatenating starves
  // whichever list comes second: wardrobe-first dropped BRO and MH0 — the two terms
  // this team's transcripts actually get wrong — while base-first dropped the boat's
  // own sail codes. Alternating means the budget runs out on both at once.
  const weave = (a: string[] = [], b: string[] = []) => {
    const out: string[] = []
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i < a.length) out.push(a[i])
      if (i < b.length) out.push(b[i])
    }
    return Array.from(new Set(out))
  }
  return {
    // The team's OWN items lead: a wardrobe code (A1.5-2022) is unguessable, while
    // "mainsail" and "jib" are words Whisper already knows. Under a tight prompt
    // budget the order decides what survives.
    sails: weave(extra.sails, base.sails),
    manoeuvres: uniq(base.manoeuvres, extra.manoeuvres),
    parts: uniq(extra.parts, base.parts),
    crew: uniq(extra.crew, base.crew),
    boats: uniq(extra.boats, base.boats),
    dutch: [...base.dutch, ...(extra.dutch || [])],
    fixups: [...base.fixups, ...(extra.fixups || [])],
  }
}

// Whisper's decoder context is 448 tokens for the prompt AND the text it generates,
// and the provider REJECTS an over-long prompt (HTTP 400) rather than truncating it.
// So the budget has to be enforced here, not hoped for: a boat's real wardrobe
// (MAIN-2025, A1.5-2022, MH0-2024 …) tokenises at roughly two characters per token,
// so a term list that merely looks short can still blow the limit and fail the whole
// transcription.
//
// Budgets are in CHARACTERS because the Whisper tokeniser is not available here;
// 2 chars/token is the pessimistic ratio measured on this vocabulary.
export const WHISPER_PROMPT_MAX_CHARS = 360   // ~180 tokens of terms
export const WHISPER_TOTAL_MAX_CHARS = 440    // ~220 tokens incl. any prev-chunk tail

// 440 chars is the ceiling because Whisper's convention is a prompt of at most half
// the 448-token context, leaving the rest to decode each 30-second window into.
//
// A full crew, the rival boats and a whole season's wardrobe do NOT all fit inside
// that, and no budget arithmetic changes it — so the ordering below is a real
// editorial choice about what Whisper most needs help with. Names first (it cannot
// guess a proper noun and a wrong one lands in the summary as fact), then the boat's
// own wardrobe codes, then the hardware it habitually mangles. The generic
// vocabulary — "mainsail", "jib", "spinnaker" — is deliberately last, because those
// are words Whisper already knows and they are the right thing to lose.

// Compact, high-value vocabulary for Whisper's `prompt`, filled greedily in priority
// order until the budget runs out: crew and the team's actual sail wardrobe first
// (proper nouns Whisper cannot guess), then the most-mangled hardware, then
// manoeuvres — which are mostly ordinary words it already gets right.
export function whisperPrompt(g: Glossary = DEFAULT_GLOSSARY, maxChars: number = WHISPER_PROMPT_MAX_CHARS): string {
  const head = 'Sailing-team debrief. Terms used: '
  const seen = new Set<string>()
  const out: string[] = []
  let len = head.length + 1                    // + the closing '.'

  // Each category gets a SHARE of the budget rather than the whole thing in
  // priority order. Filling strictly by priority let crew and sails consume
  // everything, so `halyard`, `tackline` and `constrictor` — the terms this
  // glossary exists to fix — never reached Whisper at all. Unused share spills
  // forward, so a two-name crew still leaves room for the rest.
  const take = (terms: string[], ceiling: number) => {
    for (const t of terms) {
      if (!t || seen.has(t)) continue
      const add = (out.length ? 2 : 0) + t.length
      if (len + add > ceiling) continue         // skip it; a shorter term may still fit
      seen.add(t); out.push(t); len += add
    }
  }
  const body = maxChars - head.length - 1
  // Names first and together: a person or a rival boat is a proper noun Whisper has
  // no chance at, and a wrong one lands in the summary as fact.
  take([...g.crew, ...g.boats], head.length + 1 + Math.round(body * 0.30))
  take(g.sails, head.length + 1 + Math.round(body * 0.62))
  take(g.parts, head.length + 1 + Math.round(body * 0.85))
  take(g.manoeuvres, maxChars)
  return `${head}${out.join(', ')}.`
}

// Final backstop on whatever a caller actually sends. Keeps the END of the string:
// callers put the glossary last, after any free-text context from the previous
// chunk, so trimming the front sacrifices the context and keeps the terms.
export function clampWhisperPrompt(s: string, maxChars: number = WHISPER_TOTAL_MAX_CHARS): string {
  const t = (s || '').trim()
  return t.length <= maxChars ? t : t.slice(t.length - maxChars)
}

// Full glossary for the Mistral system prompt — authoritative term list, the
// Dutch→English bridge, and the known-mishearing fixups so the model corrects and
// translates in place.
export function glossaryBlock(g: Glossary = DEFAULT_GLOSSARY): string {
  const dutch = g.dutch.map(([d, e]) => `${d}→${e}`).join(', ')
  const fixups = g.fixups.map(([w, r]) => `${w}→${r}`).join(', ')
  return [
    "GLOSSARY (authoritative for this team — the recording mixes Dutch speech with these English terms):",
    `- Sails: ${g.sails.join(', ')}`,
    `- Manoeuvres: ${g.manoeuvres.join(', ')}`,
    "- Wind-shift terms: VEERING = wind shifting CLOCKWISE / to the RIGHT (e.g. SW->W->NW); BACKING = shifting ANTI-CLOCKWISE / to the LEFT (e.g. SW->S->SE). Never swap these.",
    `- Parts & systems: ${g.parts.join(', ')}`,
    `- Crew: ${g.crew.join(', ')}`,
    `- Boats (this team's and rivals'): ${g.boats.join(', ')}`,
    `- Dutch→English: ${dutch}`,
    `- Common mishearings → correct to: ${fixups}`,
  ].join('\n')
}
