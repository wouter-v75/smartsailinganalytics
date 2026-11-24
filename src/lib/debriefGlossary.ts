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
  // [name, role] — the ONLY roles the summariser may state. A transcript has no
  // speaker labels, and without this the model promoted whoever was mentioned near a
  // steering discussion to "helmsman" (Frank, 8 Sept 2026 debrief).
  roles: [string, string][]
  dutch: [string, string][]  // [dutch, english]
  aliases: [string, string][] // [what the crew SAY, canonical term] — real speech
  fixups: [string, string][] // [wrong (heard), right] — recogniser errors
}

// Starter set — refine `sails` and `crew` with the team's actual inventory + names.
export const DEFAULT_GLOSSARY: Glossary = {
  sails: ['BRO', 'MH0', 'mo', 'J0', 'A-sail', 'A2', 'A3', 'A1.5', 'S2', 'S4', 'Code 0', 'C0', 'No.1', 'No.3', 'jib top', 'masthead zero', 'staysail', 'mainsail', 'main', 'jib', 'genoa', 'spinnaker', 'kite'],
  // Sandukan leads for the same reason the parts list is ordered: manoeuvres get
  // whatever budget is left over, so only the head of this list reaches Whisper —
  // and "Sandukan" is the one term here it has no chance of guessing. The rest are
  // ordinary words it already gets right.
  manoeuvres: ['Sandukan', 'straight set', 'inline peel', 'peel curve', 'Vanderbilt start', 'double tack', 'windward-leeward', 'layline', 'tack', 'gybe', 'inside gybe', 'outside gybe', 'bear-away set', 'gybe set', 'hoist', 'set', 'drop', 'leeward drop', 'windward drop', 'Mexican drop', 'letterbox drop', 'peel', 'inside peel', 'outside peel', 'square', 'round-up', 'takedown', 'gorilla hoist', 'hatch set', 'windward mark', 'leeward mark', 'offset', 'penalty turn', 'yellow flag'],
  // High-value / most-mangled terms first — whisperPrompt() only takes the leading
  // slice, so keep the ones Whisper fumbles (halyard, tackline, constrictor, luff…) up top.
  parts: ['halyard', 'tackline', 'constrictor', 'self-tailer', 'winch', 'pit winch', 'primary', 'AWA', 'guy', 'sheet', 'lead', 'pole', 'bowsprit', 'luff', 'draft', 'leech', 'dodger', 'pit', 'foredeck', 'main halyard', 'jib halyard', 'spinnaker halyard', 'top halyard', 'second halyard', 'afterguy', 'lazy guy', 'spinnaker sheet', 'lazy sheet', 'genoa lead', 'jib car', 'prod', 'mast', 'rig', 'backstay', 'runners', 'cunningham', 'outhaul', 'vang', 'kicker', 'foot', 'clew', 'batten', 'forestay', 'cap shrouds', 'shim', 'wheel', 'mast butt'],
  // NO NAMES HERE. Crew and rival boats are TEAM data, and this object is shared by
  // every team in the app: names listed here are fed into every other team's
  // transcription prompt, where Whisper will happily put them into a session those
  // people were never at. See TEAM_VOCAB below.
  crew: [],
  boats: [],
  roles: [],
  dutch: [
    ['grootzeil', 'mainsail'], ['fok', 'jib'], ['genua', 'genoa'], ['val', 'halyard'],
    ['schoot', 'sheet'], ['hals', 'tack'], ['halshoek', 'tack'], ['giek', 'boom'],
    ['overstag', 'tack'], ['gijpen', 'gybe'], ['afvallen', 'bear away'], ['oploeven', 'head up'],
    ['hijsen', 'hoist'], ['strijken', 'drop'], ['loef', 'windward'], ['lij', 'leeward'],
    ['boei', 'mark'], ['stuurboord', 'starboard'], ['bakboord', 'port'], ['rif', 'reef'],
    ['kluiver', 'jib'], ['bakstag', 'runner'], ['bolling', 'draft'], ['bol', 'draft'],
  ],
  // SLANG the crew actually use. Not errors — the recogniser hears these correctly
  // and they will keep appearing, so the summariser needs to know what they mean
  // and normalise them in the output. Filing slang under `fixups` told the model
  // the speaker had been misheard, which is a different and wrong instruction.
  aliases: [
    ['mo', 'MH0'], ['the mo', 'MH0'], ['MHO', 'MH0'],
    ['bro', 'BRO'],
    ['kite', 'spinnaker'],
    // The two spinnaker sets by the names the crew use for them. Both are heard
    // correctly — they are not errors — but neither says what it means, and a
    // summary that repeats "Sandukan" without knowing it is a gybe at the mark
    // cannot tell whether the rounding went well.
    ['straight set', 'bear-away set (hoist the spinnaker and carry on — no gybe at the mark)'],
    ['bare-away set', 'bear-away set (hoist the spinnaker and carry on — no gybe at the mark)'],
    ['Sandukan', 'gybe set (gybe immediately at the top mark and set the spinnaker in the gybe)'],
    // Ryujin, 7 Nov 2026 — confirmed by Wouter as correct terms, NOT mishearings.
    // "Wind weight" is the strength or pressure of the breeze. It had to be
    // named here because the `the weight` → AWA fixup below was pointed straight
    // at it, and a note that reported wind weight as AWA would be reporting a
    // different quantity.
    ['wind weight', 'wind weight (the strength or pressure of the breeze — a real term; keep it, do NOT read it as AWA or as crew weight)'],
    ['cals', 'cals (the instrument wind calibrations — "wind cals")'],
    ['wind cals', 'wind calibrations'],
  ],
  // Recogniser MISHEARINGS observed in this team's debriefs. These go to the
  // SUMMARISER as context, never as a blind find-and-replace, which is why
  // context-dependent entries are safe to list: the model applies them only where
  // the sailing sense demands it, and "weight" keeps its ordinary meaning elsewhere.
  fixups: [
    ['tagline', 'tackline'], ['clewline', 'halyard'], ['clew line', 'halyard'],
    // 3 Sept debrief
    ['the mode', 'MH0'], ['emmage zero', 'MH0'],
    ['van der ba', 'Vanderbilt start'], ['vanderbilt', 'Vanderbilt start'],
    ['double tag', 'double tack'],
    ['lay line', 'layline'], ['lay lines', 'laylines'],
    // "winch" is heard as "window" every time it is said — 3 for 3 in the 3 Sept
    // transcript, with "winch" never once appearing.
    ['window', 'winch (when the sense is a deck fitting, not a computer window)'],
    ['self-tailor', 'self-tailer'], ['self tailor', 'self-tailer'],
    ['windward load', 'windward-leeward'], ['load focus', 'leeward focus'],
    ['the weight', 'the AWA (when the sense is sail trim, not crew weight — and NEVER in "wind weight", which is a real term for the strength of the breeze)'],
    ['coaster timing', 'coastal peel curve timing'],
    // Maxi Worlds 2026 meetings, checked against the notes typed up in the room
    ['softer tube', 'softer batten'], ['tube', 'batten (when the sense is sail shape)'],
    ['station', 'staysail (when the sense is a sail being set or trimmed)'],
    ['sack', 'sag (forestay / rig sag)'],
    ['tuck', 'tack (the manoeuvre)'], ['tucks', 'tacks'],
    ['mode zero', 'MH0'], ['mower', 'MH0'],
    ['Brault', 'BRO'], ['raw', 'BRO (when the sense is a sail being peeled to)'],
    // Baraka GP, 9 Oct 2026 speed-team meeting: "capture flower TWS shape data".
    // It survived the AI note AND the hand correction, which is the argument for
    // putting it here rather than relying on either pass to catch it. Scoped to
    // wind strength so an actual flower, however unlikely afloat, is left alone.
    ['flower', 'lower (when the sense is wind strength — "flower TWS" is "lower TWS")'],
    ['flower TWS', 'lower TWS'],
    // Spelling, not mishearing: "bare" and "bear" are homophones, and Sandokan is
    // the usual spelling of the name, so the recogniser will favour both forms.
    ['bare away', 'bear away'], ['bare-away set', 'bear-away set'],
    ['Sandokan', 'Sandukan (the gybe-set manoeuvre)'],
    // Ryujin, 7 Nov 2026. Spelling, not mishearing: the sail is said "jay zero"
    // and written J0. The note came back calling it "J-Zero (jib top / masthead
    // zero)" — a gloss nobody in the room gave it.
    ['J-Zero', 'J0'], ['J zero', 'J0'], ['jay zero', 'J0'], ['J-zero', 'J0'],
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
  // Northstar 72 and 76 are one squad, so the prefix match covers both.
  northstar: {
    crew: [
      'Pedro', 'Mika', 'Max', 'Charlie', 'Shane', 'Frank', 'Gabri', 'Christian',
      'Pom', 'Nick', 'Jarrad', 'Miles', 'Wouter', 'Pete', 'Peter',
      // Harry and Christian's nickname Campo reach the summariser through `roles`.
      'Vasco',            // Django's tactician, but referred to by name like crew
      'Dougie',           // supplier — not crew, but the name is spoken and must land
    ],
    // The boats this squad actually races against. Every one of these is a proper
    // noun Whisper cannot guess, and a rival's name landing wrong turns into a fact
    // in the summary — "Jolt was called over" became "John was called over", which
    // reads as a crew member being OCS.
    boats: ['Django', 'Bella Mente', 'Jolt', 'Jethou', 'Proteus', 'Balthasar', 'Tilakkhana II'],
    // Sail codes the crew say out loud, marks and places of the Sardinia racing area,
    // and the sailmaker — all proper nouns the recogniser cannot spell.
    sails: ['MN_B', 'MH0', 'BRO', 'SSS', 'SS', 'J1', 'J1.5', 'J2', 'A1', 'A1.5', 'A2'],
    // Confirmed by the team, 14 Sept 2026. An unlisted person gets no role.
    roles: [
      ['Peter', 'owner & driver'], ['Nick', 'tactician'], ['Miles', 'navigator'], ['Wouter', 'strategist'],
      ['Pedro', 'bow'], ['Max', 'mid-bow'], ['Mika', 'mid-bow'], ['Charlie', 'mid-bow'],
      ['Frank', 'pitman'], ['Shane', 'pit assist'],
      ['Gabri', 'upwind trim'], ['Christian (Campo)', 'downwind trim'], ['Pom', 'mainsail trim'],
      ['Harry', 'keel & toe-in trim, project manager'],
      ['Pete', 'runner'], ['Jarrad', 'runner & mast engineer'],
      // Rival afterguard — named in debriefs, never on this boat.
      ['Vasco', 'tactician of Django (rival boat)'], ['Pepsi', 'tactician of Proteus (rival boat)'],
      ['Brad', 'tactician of Jethou (rival boat)'], ['Cameron', 'tactician of Balthasar (rival boat)'],
    ],
    aliases: [
      ['triple S', 'SSS'], ['Campo', 'Christian (Campo)'],
      // What the crew call the 100 ft yachts the squad races against. Heard
      // correctly, so it belongs here rather than in fixups — the summariser
      // just has to know it names a class of boat and not a number.
      ['the hundreds', 'the 100-footers (the 100 ft yachts raced against)'],
    ],
    fixups: [
      ['tiller', 'wheel (Northstar steers with a wheel)'],
      ['Dole', 'Doyle (sailmaker)'],
      ['Magdalena', 'Maddalena'], ['Carpi', 'Caprera'], ['Capri', 'Caprera (when the sense is a mark or island on the course)'],
      ['Oscar', 'Oscar (course mark)'], ['Hotel', 'Hotel (course mark)'],
      ['George', 'Jolt or Balthasar (boat name) — unclear, keep it vague rather than guess'],
      ['splice', 'Bella Mente (boat name)'],
      ['John', 'Jolt (boat name) — when the context is a boat being called over, protesting or racing'],
      ['Jango', 'Django (boat name)'],
      ['jungle', 'Django (boat name)'],
      ['Beramente', 'Bella Mente (boat name)'],
      ['Belamente', 'Bella Mente (boat name)'],
      // Observed in the 28 Sept debrief. "Jesu" put a rival boat in the summary
      // under a name that is not a boat; "the 10s" turned the 100-footers into
      // a number, and the same sentence then read as a wind speed.
      ['Jesu', 'Jethou (boat name)'],
      ['the 10s', 'the hundreds (the 100-footers) — not a wind speed or a count'],
    ],
  },
  // Baraka GP. Taken from Wouter's CORRECTION of the 10 October 2026 summary,
  // line by line against what the model produced — so every role here is one a
  // human fixed, not one inferred from the transcript.
  //
  // Why it matters more than the fixups below: with no `roles` list the
  // summariser has nothing to anchor to, and RULES says state a role "only from
  // the glossary's Roles list". Left empty, it invented a whole afterguard —
  // "helm (Merle)", "Wallie (Pit)", "Olivier (Tactician)" — and put the day's
  // conclusions under the wrong people's names. All three are real crew; none
  // was in the seat the summary gave them, which is the subtler half of this
  // failure: the names were not invented, the STATIONS were.
  baraka: {
    crew: [
      'Olivier', 'Oliver', 'Merle', 'Wouter', 'Svea', 'Becca', 'Floris', 'Dirk',
      'Thomas', 'Jurn', 'Wallie', 'Wijbren',
    ],
    // The sail codes this boat argues about. The J3.5 is the gap in the range
    // the team is asking whether to fill, so it gets said out loud a lot while
    // not existing yet.
    sails: ['J1.5', 'J2.5', 'J3', 'J3.5', 'J4', 'A2', 'MH0'],
    boats: [],
    roles: [
      ['Olivier', 'helm'],
      // Merle steers too, which is why the 10 October summary put the day's
      // driving under his name: not an invented person — a real one, given the
      // wrong seat for that day. A roster with both in it is what tells the
      // summariser that "the helm" on any given day is a fact from the
      // transcript rather than a lookup.
      ['Merle', 'second helm'],
      ['Wouter', 'navigator'],
      ['Svea', 'tactician'],
      ['Dirk', 'mainsail trim'],
      ['Oliver', 'jib trim'],
      // BOTH are pit, as Olivier and Merle are both helms: a station on this
      // boat is a job two people hold, and who sails a given weekend rotates.
      // Becca was aboard on 10 October (Wouter, 11 Oct), which is why the
      // summary naming Wallie in the pit that day was wrong about the DAY and
      // not about the crew.
      //
      // So neither can be looked up: who was in the pit comes from the
      // transcript. It matters more here than elsewhere because the pit is the
      // crew's agreed comms relay to the bow, so the name attaches to every
      // comms conclusion in the note.
      ['Becca', 'pit'],
      ['Wallie', 'pit'],
      ['Floris', 'bow'],
      ['Wijbren', 'spinnaker trim'],
      ['Thomas', 'grinder'],
      ['Jurn', 'grinder'],
    ],
    aliases: [],
    fixups: [
      // OLIVIER AND OLIVER ARE TWO PEOPLE, one on the wheel and one on the jib.
      // One letter apart, and the recogniser cannot hear the difference — so the
      // helm's calls arrive attributed to the jib trimmer and the other way
      // round. Nothing else in this list can cost a reader more.
      ['Oliver', 'Oliver (jib trim) or Olivier (helm) — TWO different people, one letter apart; '
        + 'use the one the sailing sense demands and leave it unnamed if the transcript cannot settle it'],
      // Jargon the recogniser mangled on 10 October, with what it should be.
      ['Cows Week', 'Cowes Week'], ['Cows week', 'Cowes Week'],
      ['sea clips', 'C-clips (plastic clips on the spinnaker luff that pull the kite forward of the jib)'],
      ['sea clip', 'C-clip (plastic clip on the spinnaker luff)'],
      ['Mongol drop', 'Mongrol drop'], ['Mongolian drop', 'Mongrol drop'],
      // "JIP" is not a thing; the pre-start call being timed is the JIB call.
      ['JIP', 'JIB'], ['JIP call', 'JIB call'], ['jip call', 'JIB call'],
      ['no mages', 'no major incidents'],
      // The clutch the spinnaker sheet slipped in, which came out as a bare
      // "slip" and read as crew error rather than hardware.
      ['spinnaker clutch', 'spinnaker clutch'],
    ],
  },
  warp: {
    crew: ['Marc', 'Jan'],
    boats: [],
    fixups: [],
  },
}

// Alternate two lists so a shared budget runs out on both at once. Concatenating
// starves whichever list comes second — see the sail and name uses below.
function weave(a: string[] = [], b: string[] = []): string[] {
  const out: string[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i])
    if (i < b.length) out.push(b[i])
  }
  return Array.from(new Set(out))
}

// Look up a boat's vocabulary by name ("Northstar 76", "Northstar72", "Warp" …).
export function vocabForBoat(boatName?: string | null): Partial<Glossary> | undefined {
  const n = (boatName || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!n) return undefined
  const key = Object.keys(TEAM_VOCAB).find((k) => n.startsWith(k))
  return key ? TEAM_VOCAB[key] : undefined
}

// Sail words that belong to no boat in particular. Every other entry in
// `DEFAULT_GLOSSARY.sails` names ONE boat's sail, and is only safe to offer to a
// boat that has it — see foreignCodes() below. None of these appears in any
// wardrobe (checked across all four boats with sails, 8 Nov 2026), so they have
// to be named here or scoping would strip the ordinary words for "mainsail".
export const GENERIC_SAILS = [
  'A-sail', 'staysail', 'mainsail', 'main', 'jib', 'genoa', 'spinnaker', 'kite', 'jib top',
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does `text` name this sail code? Bounded so A2 does not match A2.5, and `mo`
 *  does not match "more". */
function mentions(text: string, code: string): boolean {
  return new RegExp(`(?<![\\w.])${escapeRe(code)}(?![\\w.])`, 'i').test(text)
}

/**
 * The shared sail codes this boat does NOT have.
 *
 * WHY THIS EXISTS. `DEFAULT_GLOSSARY` is shared by every team, and its sail list
 * is one squad's: BRO, MH0, mo, masthead zero. Ryujin's 7 Nov debrief came back
 * naming a sail she does not own — "MH0 (referred to as 'the zero')" and
 * "J-Zero (jib top / masthead zero)" — when the sail discussed all day was her
 * J0. Her wardrobe WAS loaded and J0 WAS in the prompt; the shared list and its
 * mishearing map (`mode zero` → MH0, `mower` → MH0, `raw` → BRO) simply won the
 * argument. The same mistake as `northstarConditions()` falling back to
 * Northstar's sailmaker sheet for any boat: one boat's reference leaking into
 * another's, asserted as fact.
 *
 * The direction of the two failures is not equal, which is what settles it. A
 * MISSING correction leaves a garbled word in the note — visibly odd, and a
 * reader fixes it. A WRONG correction invents a sail the boat has never owned,
 * which reads as a finding. So a code the boat cannot be shown to have is
 * dropped.
 *
 * A code also survives if it is only ever a ROUTE to a code the boat has:
 * Northstar's crew say "mo" for her MH0, and "mo" is in no wardrobe because a
 * wardrobe lists sails, not slang.
 */
export function foreignCodes(base: Glossary, have: string[]): string[] {
  const generic = new Set(GENERIC_SAILS.map((s) => s.toLowerCase()))
  const owned = have.map((s) => s.toLowerCase())
  const codes = base.sails.filter((s) => !generic.has(s.toLowerCase()))
  const hasCode = (c: string) => owned.some((o) => o === c.toLowerCase() || mentions(o, c))
  // Round 1: codes the boat plainly has.
  const kept = new Set(codes.filter(hasCode).map((c) => c.toLowerCase()))
  // Round 2, BOTH directions along the known nicknames:
  //   say → kept code : keep `say` too. Northstar's crew call her MH0 "mo", and
  //     no wardrobe lists slang, so scoping on the wardrobe alone would take the
  //     nickname off the one boat that uses it.
  //   wardrobe says `say`, mean is a code : keep the CODE. Northstar's own sail
  //     list spells the same sail both `MH0 A` and `MHO B` — letter O against
  //     zero — and a boat that only ever spelled it `MHO` would otherwise lose
  //     MH0, the canonical form the note should use.
  for (const [say, mean] of [...base.aliases, ...base.fixups]) {
    if (!kept.has(say.toLowerCase()) && codes.some((c) => mentions(say, c))
        && codes.some((c) => kept.has(c.toLowerCase()) && mentions(mean, c))) {
      kept.add(say.toLowerCase())
    }
    if (owned.some((o) => mentions(o, say))) {
      for (const c of codes) if (mentions(mean, c)) kept.add(c.toLowerCase())
    }
  }
  return codes.filter((c) => !kept.has(c.toLowerCase()))
}

/** Drop the [say, mean] pairs that would steer the model to a sail this boat has
 *  not got. Judged on the MEAN side: that is what the model is told to write. */
function dropForeign(pairs: [string, string][], foreign: string[]): [string, string][] {
  if (!foreign.length) return pairs
  return pairs.filter(([, mean]) => !foreign.some((c) => mentions(mean, c)))
}

// Merge a partial team override onto the defaults (dedup, order preserved).
export function withOverride(extra?: Partial<Glossary>, base: Glossary = DEFAULT_GLOSSARY): Glossary {
  if (!extra) return base
  const uniq = (a: string[] = [], b: string[] = []) => Array.from(new Set([...a, ...b]))
  // A non-empty `extra.sails` means the boat's own wardrobe reached us, so the
  // shared codes can be judged against it. Empty means we simply do not know
  // what this boat owns, and then nothing is dropped — a rival boat, a bench run
  // and every existing test land here, unchanged.
  const have = extra.sails || []
  const foreign = have.length ? foreignCodes(base, have) : []
  const baseSails = foreign.length
    ? base.sails.filter((s) => !foreign.some((c) => c.toLowerCase() === s.toLowerCase()))
    : base.sails
  // Generics go LAST rather than into the weave. weave() exists so a tight
  // budget runs out on both HIGH-VALUE lists at once instead of starving
  // whichever came second — and before scoping, `base.sails` was full of
  // unguessable codes worth that treatment. Scoping leaves it mostly generics,
  // and giving "spinnaker" every other slot spends the budget on the one word
  // Whisper never gets wrong. Measured on a 40-sail wardrobe: the generics took
  // nine of the first twenty slots and pushed real codes out of the prompt.
  // Only when the wardrobe is KNOWN, for the same reason nothing is dropped
  // without it: with no wardrobe there is no weave to protect and no judgement
  // to make, so that case keeps the order it has always had.
  const generic = new Set(GENERIC_SAILS.map((g) => g.toLowerCase()))
  const baseCodes = have.length ? baseSails.filter((x) => !generic.has(x.toLowerCase())) : baseSails
  const baseGenerics = have.length ? baseSails.filter((x) => generic.has(x.toLowerCase())) : []
  // Sails are INTERLEAVED rather than concatenated, because both lists are
  // high-value and the prompt budget cuts off the tail. Concatenating starves
  // whichever list comes second: wardrobe-first dropped BRO and MH0 — the two terms
  // this team's transcripts actually get wrong — while base-first dropped the boat's
  // own sail codes. Alternating means the budget runs out on both at once.
  return {
    // The team's OWN items lead: a wardrobe code (A1.5-2022) is unguessable, while
    // "mainsail" and "jib" are words Whisper already knows. Under a tight prompt
    // budget the order decides what survives.
    sails: Array.from(new Set([...weave(extra.sails, baseCodes), ...baseGenerics])),
    manoeuvres: uniq(base.manoeuvres, extra.manoeuvres),
    parts: uniq(extra.parts, base.parts),
    crew: uniq(extra.crew, base.crew),
    boats: uniq(extra.boats, base.boats),
    roles: [...base.roles, ...(extra.roles || [])],
    dutch: [...base.dutch, ...(extra.dutch || [])],
    // The boat's OWN pairs are never filtered: if a team types a mapping into
    // Boat → Debrief words, that is the boat's word on the matter.
    aliases: [...dropForeign(base.aliases, foreign), ...(extra.aliases || [])],
    fixups: [...dropForeign(base.fixups, foreign), ...(extra.fixups || [])],
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
export const WHISPER_PROMPT_MAX_CHARS = 400   // ~200 tokens of terms
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
  // Names first: a person or a rival boat is a proper noun Whisper has no chance at,
  // and a wrong one lands in the summary as fact. Crew and boats are WOVEN, not
  // concatenated — appending boats after a 17-name crew meant Jethou, Proteus and
  // Balthasar never reached Whisper at all. Boats lead the weave because they are
  // the less guessable half: "Peter" and "Max" it already spells right, "Jethou"
  // and "Balthasar" it has no chance at.
  // 0.54, not 0.50: the names share was tuned against six rival boats, and a
  // seventh (Tilakkhana II) pushed Dougie off the end — a name dropped here is a
  // name transcribed wrong, which is the whole reason the share exists. The room
  // comes out of the sails' ceiling, where the tail is generic codes Whisper
  // already spells (S2, S4, C0) rather than proper nouns it cannot guess.
  take(weave(g.boats, g.crew), head.length + 1 + Math.round(body * 0.54))
  take(g.sails, head.length + 1 + Math.round(body * 0.72))
  take(g.parts, head.length + 1 + Math.round(body * 0.90))
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
    `- People (crew, coaches, shore team and suppliers — do not assume everyone listed sails): ${g.crew.join(', ')}`,
    `- Boats (this team's and rivals'): ${g.boats.join(', ')}`,
    `- Roles — this boat's crew, and rivals' afterguard where marked "rival boat" (the ONLY roles you may state — anyone not listed here gets no role, never "helmsman", "tactician", "navigator", "coach" or "guest" by guesswork; a rival's tactician is never one of this team's crew): ${g.roles.length ? g.roles.map(([n, r]) => `${n} = ${r}`).join(', ') : 'none known'}`,
    `- Team slang → canonical term (the crew really say these; normalise them in the summary): ${g.aliases.map(([a, b]) => `${a}→${b}`).join(', ')}`,
    `- Dutch→English: ${dutch}`,
    `- Common mishearings → correct to: ${fixups}`,
  ].join('\n')
}
