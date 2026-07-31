// Team sailing glossary — the backbone for debrief transcription + summarisation.
// ONE editable source, TWO renderings:
//   whisperPrompt()  → compact term string to bias Whisper (~224-token budget)
//   glossaryBlock()  → full glossary (incl. Dutch→English) for the Mistral prompt
//
// Debriefs are spoken in Dutch but pepper in English sail names, boat parts and
// manoeuvre names. Whisper mis-hears that low-probability jargon and Mistral then
// summarises the noise. Feeding these terms into both stages is the highest-leverage
// accuracy fix. Checked-in defaults for now; every function takes an optional
// Glossary, so a per-team override (extra sails / real crew names) can be merged in
// later without touching this file.

export type Glossary = {
  sails: string[]
  manoeuvres: string[]
  parts: string[]
  crew: string[]
  dutch: [string, string][] // [dutch, english]
}

// Starter set — refine `sails` and `crew` with the team's actual inventory + names.
export const DEFAULT_GLOSSARY: Glossary = {
  sails: ['mainsail', 'main', 'jib', 'genoa', 'No.1', 'No.3', 'staysail', 'spinnaker', 'kite', 'A2', 'A3', 'A1.5', 'S2', 'S4', 'Code 0', 'C0', 'jib top', 'masthead zero', 'MH0'],
  manoeuvres: ['tack', 'gybe', 'inside gybe', 'outside gybe', 'bear-away set', 'gybe set', 'hoist', 'set', 'drop', 'leeward drop', 'windward drop', 'Mexican drop', 'letterbox drop', 'peel', 'inside peel', 'outside peel', 'round-up', 'takedown', 'windward mark', 'leeward mark', 'offset', 'penalty turn', 'yellow flag'],
  parts: ['halyard', 'main halyard', 'jib halyard', 'spinnaker halyard', 'top halyard', 'second halyard', 'tackline', 'guy', 'afterguy', 'lazy guy', 'sheet', 'spinnaker sheet', 'lazy sheet', 'lead', 'genoa lead', 'jib car', 'pole', 'bowsprit', 'prod', 'dodger', 'pit', 'foredeck', 'mast', 'rig', 'backstay', 'runners', 'cunningham', 'outhaul', 'vang', 'kicker'],
  crew: ['Marc', 'Jan'],
  dutch: [
    ['grootzeil', 'mainsail'], ['fok', 'jib'], ['genua', 'genoa'], ['val', 'halyard'],
    ['schoot', 'sheet'], ['hals', 'tack'], ['halshoek', 'tack'], ['giek', 'boom'],
    ['overstag', 'tack'], ['gijpen', 'gybe'], ['afvallen', 'bear away'], ['oploeven', 'head up'],
    ['hijsen', 'hoist'], ['strijken', 'drop'], ['loef', 'windward'], ['lij', 'leeward'],
    ['boei', 'mark'], ['stuurboord', 'starboard'], ['bakboord', 'port'], ['rif', 'reef'],
    ['kluiver', 'jib'], ['bakstag', 'runner'],
  ],
}

// Merge a partial team override onto the defaults (dedup, order preserved).
export function withOverride(extra?: Partial<Glossary>, base: Glossary = DEFAULT_GLOSSARY): Glossary {
  if (!extra) return base
  const uniq = (a: string[] = [], b: string[] = []) => Array.from(new Set([...a, ...b]))
  return {
    sails: uniq(base.sails, extra.sails),
    manoeuvres: uniq(base.manoeuvres, extra.manoeuvres),
    parts: uniq(base.parts, extra.parts),
    crew: uniq(base.crew, extra.crew),
    dutch: [...base.dutch, ...(extra.dutch || [])],
  }
}

// Compact, high-value vocabulary for Whisper's ~224-token `prompt`. Proper nouns +
// the most-mangled jargon first; keep this string SHORT so Whisper doesn't truncate
// it. Callers place it LAST in the prompt (after any prev-chunk tail) so that if the
// budget is hit, the terms survive over the free-text context.
export function whisperPrompt(g: Glossary = DEFAULT_GLOSSARY): string {
  const terms = [...g.crew, ...g.sails, ...g.manoeuvres, ...g.parts.slice(0, 16)]
  return `Sailing-team debrief. Terms used: ${terms.join(', ')}.`
}

// Full glossary for the Mistral system prompt — authoritative term list + the
// Dutch→English bridge so the model corrects mishearings and translates in place.
export function glossaryBlock(g: Glossary = DEFAULT_GLOSSARY): string {
  const dutch = g.dutch.map(([d, e]) => `${d}→${e}`).join(', ')
  return [
    "GLOSSARY (authoritative for this team — the recording mixes Dutch speech with these English terms):",
    `- Sails: ${g.sails.join(', ')}`,
    `- Manoeuvres: ${g.manoeuvres.join(', ')}`,
    `- Parts & systems: ${g.parts.join(', ')}`,
    `- Crew: ${g.crew.join(', ')}`,
    `- Dutch→English: ${dutch}`,
  ].join('\n')
}
