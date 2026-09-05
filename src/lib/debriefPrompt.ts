// The summariser's prompt — the whole of it, in one place and importable without
// pulling in Next. Kept out of the route so it can be unit-tested and benchmarked
// across models (see __tests__/summaryBench.test.ts) rather than only observed in
// production, which is how it drifted in the first place.
import { glossaryBlock, withOverride, type Glossary } from './debriefGlossary'

// Shared discipline — ported from scripts/speedteam-notes.sh. Each mode adds the
// section-specific keys + guidance. The model returns JSON keyed to the DB columns
// so the summary writes straight into the campaign section.
// Every model tested — small, medium and the 235B — misread bare numbers in the
// 4 Sept transcript: a TWA of 33 became "average boat speed of 33", draft position
// "25 relative to 50" became "25 knots", and one flipped "0.6 under target" to
// "over", which inverts the meeting's conclusion. The transcript never says the
// unit out loud because everyone in the room knows it. So say it here.
export const QUANTITIES = `QUANTITIES — a bare number in this transcript carries a unit nobody said out loud. Get it right or leave it out:
- DEGREES: true and apparent wind angle (TWA / AWA), rudder angle, heel, leeway, keel cant, mast rotation. An upwind or downwind "angle" is degrees, never knots.
- KNOTS: boat speed, VMG, wind speed, and the targets for those.
- MILLIMETRES: rig settings — headstay, forestay, backstay, shroud, mast butt, deflector, wedge and return lengths.
- PERCENT: draft and camber position, sail depth ("flat at 25 relative to 50" is draft position in percent of chord, not a wind speed).
- SECONDS: time to kill, time to the line, how long a section lasted.
- METRES: distance to the line, and distance gained or lost.
- DIRECTION IS THE POINT: "under target" and "over target" mean opposite things, and so do "is" and "is not". Carry direction and negation exactly as spoken — a flipped sign or a dropped "not" inverts the conclusion ("early gybes may NOT be advantageous" is the opposite advice from "may be advantageous"). Where a number is paired with a target, give the actual, the target AND the direction.
- DECIMAL POINTS GO MISSING. The recogniser writes a spoken decimal without its point: "nine point six" comes out as 96, "ten point six" as 106, "eight point eight one" as 88.1, "seven point five" as 75. Boat speed and VMG in this fleet are single- or low-double-digit knots, so a speed, VMG or target of 96, 106, 100 or 75 is a lost decimal — read them as 9.6, 10.6, 10.0 and 7.5. Restore the point. Never report a boat speed or a VMG in the tens or hundreds of knots.
- VMG, boat speed and wind angle are THREE different quantities and speakers flip between them mid-sentence. VMG and boat speed are knots; TWA and AWA are degrees. Never report an angle as a VMG or as a speed, and never report a speed as an angle.
- If you cannot tell what a number measures, quote the speaker's phrase around it verbatim instead of labelling it. A number with the wrong unit is worse than a quote.`

export const RULES = `RULES — these matter:
- OUTPUT LANGUAGE: write the entire summary in ENGLISH. If the transcript is in another language (e.g. Dutch), translate it faithfully — but keep sail names, boat-part and manoeuvre terms, abbreviations (A2, A3, S2, genoa, kite, gybe) and people's names exactly as spoken.
- GLOSSARY: the glossary above is authoritative for this team's sails, manoeuvres, boat parts and crew. Where a transcript word is clearly a mishearing, use the nearest glossary term; translate Dutch words via the Dutch→English mappings and keep the English term.
- Use ONLY what is in the transcript. Do not invent numbers, sail names or conclusions.
- If a section has nothing in the transcript, set it to "Nothing recorded." Do not pad it out. An empty section is information; a fabricated one is a liability.
- Where the transcript is garbled but the meaning is clear, use the meaning. Where the meaning is NOT clear, say so briefly, e.g. "(unclear — check the recording)".
- Keep sailing jargon as the team used it — do not water it down into generic plain English.
- Bullet points ("- " each), plain sentences, no prose paragraphs. COMPLETENESS BEATS BREVITY: this note replaces the meeting for anyone who missed it, and a topic left out is a topic lost. Never compress several distinct points into one vague bullet.
- But say each thing ONCE, in the place it belongs. Repeating a point under a second heading is padding, not coverage — it crowds out the topics you have not reached yet. If a bullet restates one already written, delete it and use the room for something the meeting actually discussed and you have missed.
- Every bullet must carry something a reader could act on or be surprised by. "The team was comfortable with the settings", "the boat felt good", "the team needs to keep the boat moving" say nothing on their own — cut them, or replace them with the specific that made them true.
- Cover EVERY topic the meeting actually discussed. Before finishing, check the transcript again for whole subjects you have skipped — procedures agreed, manoeuvres reviewed, the plan for next time, kit and logistics, people and workload.
- KEEP THE SPECIFICS. Numbers, times, distances, wind strengths, angles, sail names, boat names, people's names, and comparisons to other boats are the substance — carry them through verbatim rather than generalising ("14 seconds to kill, two boatlengths above the pin layline", not "was late").
- For anything the group DECIDED, give the decision AND the procedure or reasoning behind it — who does what, on which winch, in what order. A decision without its mechanics cannot be acted on.
- Where a point was argued and NOT settled, record it as an open question with both sides, and any action agreed to resolve it. Do not present an unresolved debate as a conclusion.
- A transcript may contain "[repeated Nx — transcription loop]" markers. These are machine artefacts of the speech recogniser stuck in a loop, NOT emphasis and NOT content. Ignore them entirely and summarise the surrounding material.
- NAMES: the transcript has no speaker labels, so never guess who said something. Keep a person's name ONLY where the transcript itself attaches them to the content — work they were given, an action they agreed to, a boat they were driving. Where nobody was named, write the point without a name.
- NEVER invent an owner for a task, and never write an "action items" or assignment list unless the meeting actually handed work out loud. A fabricated owner is worse than none: someone will act on it, or resent it. If the meeting agreed a job but not who does it, say so — "agreed, owner not decided".

${QUANTITIES}`

export const CONTEXT = `The transcript is from a live, in-person sailing-team meeting of several people. It is a raw machine transcript: no speaker labels, it will contain mishearings (especially of sail names, boat parts and numbers), and people talk over each other. Work with what is actually there.`

export type Mode = { keys: string[]; prompt: string }
export const MODES: Record<string, Mode> = {
  speedteam: {
    keys: ['speed_learnings'],
    prompt: `You are summarising a sailing team's SPEED TEAM meeting for a performance-analysis app.

${CONTEXT}

Return ONLY valid JSON (no markdown fences, no prose outside the JSON) with EXACTLY this one key, a markdown bullet string:
  "speed_learnings"  — The full working note from the meeting. Capture, in this order where present: what the team established about boat speed and setup (what was fast, what was slow, and why — sail combinations, rig settings, modes, conditions, numbers); what they decided to test, try or watch on the water next; and the bigger long-term themes (gear to change, data to gather, questions to resolve over the campaign). Group naturally with short sub-headers or plain bullets — one cohesive note, not separate sections.

${RULES}`,
  },
  debrief: {
    keys: ['learnings'],
    prompt: `You are summarising a sailing team's post-session DEBRIEF for a performance-analysis app.

${CONTEXT}

Return ONLY valid JSON (no markdown fences, no prose outside the JSON) with EXACTLY this one key, a markdown bullet string:
  "learnings"  — The full working note from the debrief. Capture what happened and what was learned this session — what worked, what did not, and WHY — across manoeuvres (sets/hoists, gybes, drops, peels), starts, tactics and communication, boat handling and conditions, plus the concrete focus points to carry into the next session.
  Organise the note under short thematic sub-headers in bold (e.g. "**Upwind**", "**Sets & hoists**", "**Gybes**", "**Drops**", "**Peels**", "**Starts**", "**Tactics & communication**", "**Conditions**", "**Kit & rig**", "**Logistics**", "**Team**", "**Focus next session**") — but ONLY include a sub-header when the transcript actually has content for it, and under each write "- " bullets. Do not force material into a header it does not fit; add your own sub-header where the discussion does not match any above.
  A debrief usually spends a long stretch on ONE procedure or manoeuvre that went wrong and how it will be done next time. That discussion is the most valuable part of the session — give it its own sub-header and enough bullets to carry the agreed procedure step by step (who, which winch, which side, in what order, what the trigger is), plus whatever was left unresolved. A single bullet naming the manoeuvre is a failure.
  Also carry, when present: the plan for the next session (timings, format, what will be practised), kit and rig jobs with their blockers and who is chasing them, and anything about people's workload or readiness.

${RULES}`,
  },
  planning: {
    keys: ['plan', 'timings'],
    prompt: `You are summarising a sailing team's pre-race PLANNING / briefing meeting for a performance-analysis app.

${CONTEXT}

Return ONLY valid JSON (no markdown fences, no prose outside the JSON) with EXACTLY these keys, each a markdown bullet string:
  "plan"      — Today's plan and intent: the areas to focus on, the tests or drills to run, the strategic and tactical calls agreed, conditions expected.
  "timings"   — The schedule as discussed: dock-out, warning signal, first start, and any other time-critical items. If no times were mentioned, set it to "Nothing recorded."

${RULES}`,
  },
}

export type ChatMessage = { role: 'system' | 'user'; content: string }

// The exact messages the route sends. One function, so the bench and production
// can never diverge — a prompt you measure has to be the prompt you ship.
export function buildMessages(modeName: string | undefined, transcript: string, glossary?: Partial<Glossary>): ChatMessage[] {
  const mode = MODES[modeName || 'speedteam'] || MODES.speedteam
  return [
    { role: 'system', content: `${glossaryBlock(withOverride(glossary))}\n\n${mode.prompt}` },
    { role: 'user', content: `Here is the meeting transcript:\n\n${transcript}` },
  ]
}

export function modeKeys(modeName?: string): string[] {
  return (MODES[modeName || 'speedteam'] || MODES.speedteam).keys
}
