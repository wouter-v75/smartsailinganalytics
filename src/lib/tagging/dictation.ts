// src/lib/tagging/dictation.ts
// ─────────────────────────────────────────────────────────────────────────────
// Talking instead of typing.
//
// A comment typed on a phone, on a boat, wearing gloves, is a comment that does
// not get typed. Speaking one takes three seconds and both hands stay on the
// rail — which is the whole reason the tagger exists, applied to the one field
// that still demanded a keyboard.
//
// TWO PATHS, because there is no single one that works everywhere:
//
//   LIVE     the phone's own recogniser (the Web Speech API). Free, instant,
//            no upload, and the words appear as they are said — so somebody can
//            see it mis-hear "J2" and fix it before saving. Chrome and Safari.
//   RECORD   record, then send the audio to the transcriber SSA already runs
//            (/api/ai/transcribe, Whisper inside the EU account). Slower and it
//            needs a connection, but it works where the first does not, and it
//            is markedly better at sailing words.
//
// This file holds the part that is neither React nor a browser API: what
// happens to the TEXT. That turns out to be where the bugs are — dictation
// arrives in fragments, some of them provisional, and it has to land in a box
// somebody may already have typed in.
//
// Pure — no React, no DOM, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether dictation is even on offer, and by which path. */
export type DictationMode = 'live' | 'record' | 'unavailable'

/** What a recogniser hands back: words it has committed to, and words it is
 *  still revising. Only the committed half is ever saved. */
export interface Heard {
  final: string
  interim: string
}

const squash = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * Tidy one utterance.
 *
 * Recognisers hand back lower-case, unpunctuated runs, and they put a space
 * before punctuation about as often as not. None of that is worth making
 * somebody fix by hand before they can save.
 */
export function tidySpoken(text: string): string {
  const s = squash(text)
    .replace(/\s+([,.;:!?])/g, '$1')   // "kite up ." → "kite up."
    .replace(/([,.;:!?])(?=\S)/g, '$1 ')
    // A dictated full stop starts a sentence, so the next word gets a capital.
    // Without this a spoken paragraph comes out as one long lower-case run with
    // stops in it, which reads worse than no punctuation at all.
    .replace(/([.!?]\s+)([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase())
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Add what was said to what is already in the box.
 *
 * Appends rather than replaces: somebody may have typed half a sentence and
 * then decided to say the rest, and a recogniser that wipes the box is one
 * nobody presses twice. Sentence-aware about the join, so dictating twice does
 * not produce "Kite up early.the peel was late".
 */
export function appendSpoken(existing: string, spoken: string): string {
  const said = tidySpoken(spoken)
  if (!said) return existing
  const base = String(existing ?? '').replace(/\s+$/, '')
  if (!base) return said
  // A new utterance after a finished sentence starts a new sentence; otherwise
  // it continues the one in progress, so it does not get a capital.
  const ended = /[.!?]$/.test(base)
  const joined = ended ? said : said.charAt(0).toLowerCase() + said.slice(1)
  return `${base} ${joined}`
}

/**
 * What to SHOW while somebody is still talking.
 *
 * The provisional words have to be visible — that is the point of live
 * dictation, and a box that stays empty until you stop speaking feels broken —
 * but they must never be what gets saved, because the recogniser revises them.
 */
export function liveText(committed: string, heard: Heard): string {
  const withFinal = appendSpoken(committed, heard.final)
  const interim = squash(heard.interim)
  if (!interim) return withFinal
  return withFinal ? `${withFinal.replace(/\s+$/, '')} ${interim}` : interim
}

/**
 * Fold a recogniser's result list into one pair.
 *
 * The API hands back an array in which each entry is either settled or still
 * being revised, and the settled ones have to be concatenated in order. Written
 * against the shape rather than the type, because the interface is prefixed on
 * some browsers and absent on others, and a test should not need a browser.
 */
export function foldResults(
  results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }>,
  from = 0
): Heard {
  let final = '', interim = ''
  for (let i = Math.max(0, from); i < (results?.length ?? 0); i++) {
    const r = results[i] as { isFinal?: boolean; 0?: { transcript?: string } }
    const text = String(r?.[0]?.transcript ?? '')
    if (r?.isFinal) final += text
    else interim += text
  }
  return { final: squash(final), interim: squash(interim) }
}

/** The longest a single dictation may run. Long enough for anything anybody
 *  says about one moment; short enough that a mic left on by accident does not
 *  record the rest of the afternoon, or fill an upload with it. */
export const MAX_DICTATION_MS = 120_000

/** A spoken language tag for the recogniser, from the browser. Falls back to
 *  British English rather than to nothing — an unset lang makes some engines
 *  refuse to start at all. */
export function speechLang(nav?: { language?: string; languages?: readonly string[] }): string {
  const l = nav?.language || nav?.languages?.[0] || ''
  return /^[a-z]{2}(-[A-Za-z0-9]+)*$/i.test(l) ? l : 'en-GB'
}
