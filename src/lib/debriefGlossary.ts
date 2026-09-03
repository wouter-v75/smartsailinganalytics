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
  dutch: [string, string][]  // [dutch, english]
  fixups: [string, string][] // [wrong (heard), right]
}

// Starter set — refine `sails` and `crew` with the team's actual inventory + names.
export const DEFAULT_GLOSSARY: Glossary = {
  sails: ['mainsail', 'main', 'jib', 'genoa', 'No.1', 'No.3', 'staysail', 'spinnaker', 'kite', 'A-sail', 'A2', 'A3', 'A1.5', 'S2', 'S4', 'Code 0', 'C0', 'jib top', 'masthead zero', 'MH0'],
  manoeuvres: ['tack', 'gybe', 'inside gybe', 'outside gybe', 'bear-away set', 'gybe set', 'hoist', 'set', 'drop', 'leeward drop', 'windward drop', 'Mexican drop', 'letterbox drop', 'peel', 'inside peel', 'outside peel', 'square', 'round-up', 'takedown', 'windward mark', 'leeward mark', 'offset', 'penalty turn', 'yellow flag'],
  // High-value / most-mangled terms first — whisperPrompt() only takes the leading
  // slice, so keep the ones Whisper fumbles (halyard, tackline, constrictor, luff…) up top.
  parts: ['halyard', 'tackline', 'constrictor', 'guy', 'sheet', 'lead', 'pole', 'bowsprit', 'luff', 'draft', 'leech', 'dodger', 'pit', 'foredeck', 'main halyard', 'jib halyard', 'spinnaker halyard', 'top halyard', 'second halyard', 'afterguy', 'lazy guy', 'spinnaker sheet', 'lazy sheet', 'genoa lead', 'jib car', 'prod', 'mast', 'rig', 'backstay', 'runners', 'cunningham', 'outhaul', 'vang', 'kicker', 'foot', 'clew'],
  crew: ['Marc', 'Jan'],
  dutch: [
    ['grootzeil', 'mainsail'], ['fok', 'jib'], ['genua', 'genoa'], ['val', 'halyard'],
    ['schoot', 'sheet'], ['hals', 'tack'], ['halshoek', 'tack'], ['giek', 'boom'],
    ['overstag', 'tack'], ['gijpen', 'gybe'], ['afvallen', 'bear away'], ['oploeven', 'head up'],
    ['hijsen', 'hoist'], ['strijken', 'drop'], ['loef', 'windward'], ['lij', 'leeward'],
    ['boei', 'mark'], ['stuurboord', 'starboard'], ['bakboord', 'port'], ['rif', 'reef'],
    ['kluiver', 'jib'], ['bakstag', 'runner'], ['bolling', 'draft'], ['bol', 'draft'],
  ],
  fixups: [
    ['tagline', 'tackline'], ['clewline', 'halyard'], ['clew line', 'halyard'],
  ],
}

// Merge a partial team override onto the defaults (dedup, order preserved).
export function withOverride(extra?: Partial<Glossary>, base: Glossary = DEFAULT_GLOSSARY): Glossary {
  if (!extra) return base
  const uniq = (a: string[] = [], b: string[] = []) => Array.from(new Set([...a, ...b]))
  return {
    // The team's OWN items lead: a wardrobe code (A1.5-2022) is unguessable, while
    // "mainsail" and "jib" are words Whisper already knows. Under a tight prompt
    // budget the order decides what survives.
    sails: uniq(extra.sails, base.sails),
    manoeuvres: uniq(base.manoeuvres, extra.manoeuvres),
    parts: uniq(extra.parts, base.parts),
    crew: uniq(extra.crew, base.crew),
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
export const WHISPER_PROMPT_MAX_CHARS = 320   // ~160 tokens of terms
export const WHISPER_TOTAL_MAX_CHARS = 440    // ~220 tokens incl. any prev-chunk tail

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
  take(g.crew, head.length + 1 + Math.round(body * 0.20))
  take(g.sails, head.length + 1 + Math.round(body * 0.60))
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
    `- Dutch→English: ${dutch}`,
    `- Common mishearings → correct to: ${fixups}`,
  ].join('\n')
}
