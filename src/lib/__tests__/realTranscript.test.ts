import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { collapseRepeats } from '../transcriptClean'

// Opt-in check against a REAL debrief transcript. The file is a recording of the
// crew talking, so it is deliberately not committed; point SSA_TRANSCRIPT_FIXTURE
// at one to run this. Measured on the 3 Sept 2026 debrief:
//   34,649 chars raw → 20,102 cleaned; 42% of what the summariser read was a
//   recogniser loop, the worst repeating 252 times.
const FIXTURE = process.env.SSA_TRANSCRIPT_FIXTURE || ''
const run = FIXTURE && existsSync(FIXTURE) ? describe : describe.skip

run('real transcript', () => {
  // Read lazily: vitest still evaluates a skipped describe body at collection
  // time, so reading here at module level fails the whole file when no fixture
  // is configured.
  const load = () => readFileSync(FIXTURE, 'utf8')

  it('removes a large fraction of recogniser loops', () => {
    const raw = load()
    const r = collapseRepeats(raw)
    expect(r.removed / raw.length).toBeGreaterThan(0.2)
    expect(r.loops.length).toBeGreaterThan(0)
    expect(r.loops[0].count).toBeGreaterThan(50)
  })

  it('keeps the specifics the summary kept dropping', () => {
    // These ARE in the audio, and the summary omitted them anyway — which is what
    // the completeness rules in the summariser prompt target. If de-looping ever
    // starts eating them, that is a regression in the cleaner, not the model.
    const t = collapseRepeats(load()).text.toLowerCase()
    for (const fact of ['14', '80', '45 min', 'dock', 'vasco', 'shane']) expect(t).toContain(fact)
  })

  it('keeps the substance — the topics the summary must not miss', () => {
    const t = collapseRepeats(load()).text.toLowerCase()
    for (const key of ['bro', 'primary', 'lay line', 'start']) expect(t).toContain(key)
    // The 252-times loop collapses to a handful of mentions, not zero: the phrase
    // occurs in more than one place in the recording, and each run is collapsed
    // separately. Going to zero would mean the cleaner had eaten real speech.
    const loops = (t.match(/attacking high and slow/g) || []).length
    expect(loops).toBeGreaterThan(0)
    expect(loops).toBeLessThan(10)
  })
})
