// src/lib/__tests__/debriefContinue.test.ts
import { describe, it, expect } from 'vitest'
import {
  cutKeyOf, trimOverlap, mergeContinuation, canContinue,
  MAX_CONTINUATIONS, MIN_MS_FOR_ANOTHER,
} from '../debriefContinue'

describe('cutKeyOf — which key was being written when it stopped', () => {
  it('takes the LAST key, because JSON.parse keeps insertion order', () => {
    // Everything before it closed; the last one is where the output ran out.
    expect(cutKeyOf({ plan: 'done', timings: 'half wri' })).toBe('timings')
  })

  it('ignores keys with nothing in them', () => {
    // A repaired object can end with an empty value, which is not where the
    // writing stopped — the one before it is.
    expect(cutKeyOf({ plan: 'done', timings: '' })).toBe('plan')
  })

  it('has nothing to say about an empty or missing object', () => {
    expect(cutKeyOf({})).toBeNull()
    expect(cutKeyOf(null)).toBeNull()
  })
})

describe('trimOverlap — a model asked to continue often restates first', () => {
  it('drops a repeated tail', () => {
    const partial = '- Travel: Book tickets early and confirm stops.\n- Sleep: Address bunk'
    const cont = '- Sleep: Address bunk bed issues (noise, heat).\n- Apparel: assign an owner.'
    expect(trimOverlap(partial, cont)).toBe(' bed issues (noise, heat).\n- Apparel: assign an owner.')
  })

  it('prefers the LONGEST repeat, not the first short coincidence', () => {
    // "- " alone matches constantly; a real restatement is much longer and must
    // win, or the note says the same thing twice in the middle.
    const partial = 'alpha bravo charlie delta echo foxtrot'
    const cont = 'charlie delta echo foxtrot golf hotel'
    expect(trimOverlap(partial, cont)).toBe(' golf hotel')
  })

  it('leaves a genuine continuation untouched', () => {
    expect(trimOverlap('…clothing/gear (e.g., with', ' a supplier chosen by March.'))
      .toBe(' a supplier chosen by March.')
  })

  it('ignores an overlap too short to be a real restatement', () => {
    // Under 12 characters is coincidence, not a repeat.
    expect(trimOverlap('ends with a', 'a new thought entirely')).toBe('a new thought entirely')
  })

  it('copes with either side being empty', () => {
    expect(trimOverlap('', 'rest')).toBe('rest')
    expect(trimOverlap('head', '')).toBe('')
  })
})

describe('mergeContinuation', () => {
  it('joins a MID-SENTENCE cut without breaking the sentence', () => {
    // The real failure: "…clothing/gear (e.g., with" + " a supplier chosen by
    // March." A newline inserted here is a sentence broken in half, which is
    // the thing this whole mechanism exists to stop.
    const out = mergeContinuation(
      { learnings: '- Apparel: Assign someone to handle team clothing/gear (e.g., with' },
      { learnings: ' a supplier chosen by March.' },
      'learnings',
    )
    expect(out.learnings).toBe('- Apparel: Assign someone to handle team clothing/gear (e.g., with a supplier chosen by March.')
  })

  it('appends to the key that was cut', () => {
    const out = mergeContinuation({ learnings: 'first half' }, { learnings: 'second half' }, 'learnings')
    // A single space, never a newline: the cut is usually mid-sentence.
    expect(out.learnings).toBe('first half second half')
  })

  it('takes a key the model never REACHED, wholesale', () => {
    // planning has two keys; running out inside `plan` means `timings` was
    // never started, and the continuation is the only place it exists.
    const out = mergeContinuation({ plan: 'the plan so far' }, { plan: ' and the rest', timings: '0900 dock out' }, 'plan')
    expect(out.plan).toBe('the plan so far and the rest')
    expect(out.timings).toBe('0900 dock out')
  })

  it('does NOT overwrite a key that was already finished', () => {
    // The continuation may restate an earlier section more hastily. A complete
    // version must not be replaced by a second, worse one.
    const out = mergeContinuation(
      { plan: 'full and careful', timings: 'cut off here' },
      { plan: 'brief restatement', timings: ' — the rest' },
      'timings',
    )
    expect(out.plan).toBe('full and careful')
    expect(out.timings).toBe('cut off here — the rest')
  })

  it('adds nothing when the continuation was entirely a repeat', () => {
    const out = mergeContinuation({ learnings: 'all of it already' }, { learnings: 'all of it already' }, 'learnings')
    expect(out.learnings).toBe('all of it already')
  })

  it('ignores empty values rather than blanking what is there', () => {
    const out = mergeContinuation({ learnings: 'kept' }, { learnings: '   ' }, 'learnings')
    expect(out.learnings).toBe('kept')
  })
})

describe('canContinue — never start a call that cannot finish', () => {
  it('allows another round early on', () => {
    expect(canContinue(30_000, 280_000, 0)).toBe(true)
  })

  it('stops when the budget is nearly gone', () => {
    // The whole reason max_tokens is 8000 and not 16000: a call that overruns
    // turns a short summary into a 504 and no summary at all.
    expect(canContinue(240_000, 280_000, 1)).toBe(false)
    expect(canContinue(280_000 - MIN_MS_FOR_ANOTHER + 1, 280_000, 0)).toBe(false)
  })

  it('stops after the cap however much time is left', () => {
    // A model that keeps running out is not going to finish on the fourth go;
    // past this it is better to hand back what there is and say it is short.
    expect(canContinue(1_000, 280_000, MAX_CONTINUATIONS)).toBe(false)
  })
})
