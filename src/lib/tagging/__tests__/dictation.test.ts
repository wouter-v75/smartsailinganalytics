import { describe, it, expect } from 'vitest'
import {
  tidySpoken, appendSpoken, liveText, foldResults, speechLang, MAX_DICTATION_MS,
} from '../dictation'

describe('tidySpoken', () => {
  it('capitalises, because a recogniser never does', () => {
    expect(tidySpoken('kite up early')).toBe('Kite up early')
  })

  it('squashes the whitespace dictation arrives with', () => {
    expect(tidySpoken('  kite   up \n early ')).toBe('Kite up early')
  })

  it('pulls punctuation back onto the word', () => {
    expect(tidySpoken('kite up early . the peel was late')).toBe('Kite up early. The peel was late')
  })

  it('is empty for nothing said', () => {
    expect(tidySpoken('')).toBe('')
    expect(tidySpoken('   ')).toBe('')
    expect(tidySpoken(null as unknown as string)).toBe('')
  })
})

describe('appendSpoken', () => {
  it('fills an empty box', () => {
    expect(appendSpoken('', 'kite up early')).toBe('Kite up early')
  })

  it('keeps what somebody typed — a box that gets wiped is pressed once', () => {
    expect(appendSpoken('Jib lead', 'one hole forward')).toBe('Jib lead one hole forward')
  })

  it('starts a new sentence after a finished one', () => {
    expect(appendSpoken('Kite up early.', 'the peel was late'))
      .toBe('Kite up early. The peel was late')
  })

  it('continues an unfinished one rather than capitalising mid-sentence', () => {
    expect(appendSpoken('Kite up early and', 'the peel was late'))
      .toBe('Kite up early and the peel was late')
  })

  it('does not double the space at the join', () => {
    expect(appendSpoken('Kite up.   ', 'then the drop')).toBe('Kite up. Then the drop')
  })

  it('changes nothing when nothing was said', () => {
    expect(appendSpoken('Jib lead', '')).toBe('Jib lead')
    expect(appendSpoken('Jib lead', '   ')).toBe('Jib lead')
  })
})

describe('liveText', () => {
  it('shows the provisional words, so it can be seen mis-hearing', () => {
    expect(liveText('', { final: 'kite up', interim: 'early' })).toBe('Kite up early')
  })

  it('is just the committed text once the provisional words settle', () => {
    expect(liveText('', { final: 'kite up early', interim: '' })).toBe('Kite up early')
  })

  it('shows provisional words on their own before anything is committed', () => {
    expect(liveText('', { final: '', interim: 'kite' })).toBe('kite')
  })

  it('never loses what was typed first', () => {
    expect(liveText('Jib lead', { final: '', interim: 'one hole' })).toBe('Jib lead one hole')
  })
})

describe('foldResults', () => {
  const r = (isFinal: boolean, transcript: string) => ({ isFinal, 0: { transcript } })

  it('concatenates the settled fragments in order', () => {
    const out = foldResults([r(true, 'kite up '), r(true, 'early')])
    expect(out.final).toBe('kite up early')
    expect(out.interim).toBe('')
  })

  it('keeps the unsettled ones apart — they are not what gets saved', () => {
    const out = foldResults([r(true, 'kite up'), r(false, 'early')])
    expect(out.final).toBe('kite up')
    expect(out.interim).toBe('early')
  })

  it('starts where the event says it starts, not at the beginning', () => {
    // The API re-sends the whole list every time and says which entry is new;
    // folding from zero repeats every sentence already committed.
    const out = foldResults([r(true, 'old'), r(true, 'new')], 1)
    expect(out.final).toBe('new')
  })

  it('survives a list with nothing usable in it', () => {
    expect(foldResults([])).toEqual({ final: '', interim: '' })
    expect(foldResults([{} as never])).toEqual({ final: '', interim: '' })
    expect(foldResults(null as never)).toEqual({ final: '', interim: '' })
  })
})

describe('speechLang', () => {
  it('uses the browser’s language', () => {
    expect(speechLang({ language: 'nl-NL' })).toBe('nl-NL')
    expect(speechLang({ languages: ['fr-FR'] })).toBe('fr-FR')
  })

  it('falls back to a real tag — an unset one stops some engines starting', () => {
    expect(speechLang({})).toBe('en-GB')
    expect(speechLang(undefined)).toBe('en-GB')
    expect(speechLang({ language: 'not a language' })).toBe('en-GB')
  })
})

describe('the mic cannot be left on', () => {
  it('stops itself well before it could record an afternoon', () => {
    expect(MAX_DICTATION_MS).toBeLessThanOrEqual(5 * 60_000)
    expect(MAX_DICTATION_MS).toBeGreaterThanOrEqual(30_000)
  })
})
