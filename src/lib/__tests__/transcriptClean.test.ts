import { describe, it, expect } from 'vitest'
import { collapseRepeats } from '../transcriptClean'

describe('collapseRepeats', () => {
  it('collapses the real failure: one phrase repeated hundreds of times', () => {
    // The 3 Sept debrief carried "attacking high and slow" ~250 times, which drowned
    // every other topic and produced a summary that missed most of the session.
    const real = 'We were happy with the boat speed. '
    const loop = 'Attacking high and slow. '.repeat(250)
    const more = 'The MH0 cable arrives tonight. '
    const r = collapseRepeats(real + loop + more)
    expect(r.text).toContain('happy with the boat speed')
    expect(r.text).toContain('MH0 cable arrives tonight')
    expect(r.text).toContain('[repeated 250x — transcription loop]')
    expect((r.text.match(/Attacking high and slow/gi) || []).length).toBe(1)
    expect(r.removed).toBeGreaterThan(5000)
    expect(r.loops[0].count).toBe(250)
  })

  it('shrinks the input enough to matter to a summariser', () => {
    const loop = 'If you go back a tiny bit. '.repeat(100)
    const r = collapseRepeats('Start of the debrief. ' + loop + 'End of the debrief.')
    expect(r.text.length).toBeLessThan(200)
  })

  it('collapses a multi-phrase cycle, not just a single sentence', () => {
    const r = collapseRepeats('Keep this. ' + 'Alpha. Bravo. '.repeat(20) + 'Keep that.')
    expect(r.text).toContain('Keep this')
    expect(r.text).toContain('Keep that')
    expect((r.text.match(/Alpha/g) || []).length).toBe(1)
    expect((r.text.match(/Bravo/g) || []).length).toBe(1)
  })

  it('collapses a loop inside one run-on phrase with no punctuation', () => {
    const r = collapseRepeats('so then ' + 'go a bit higher '.repeat(30) + 'and that was it')
    expect((r.text.match(/go a bit higher/g) || []).length).toBeLessThanOrEqual(2)
    expect(r.text).toContain('and that was it')
  })

  it('LEAVES REAL SPEECH ALONE — the important half', () => {
    // Genuine debrief prose must survive untouched; a de-looper that eats content
    // is worse than the loops.
    const real = [
      'We were consistently late to the line.',
      'The double tack was the mistake.',
      'If we had held the angle and gone straight we would have been on time.',
      'Vasco is racing to the crew at one twenty to one thirty.',
      'Tomorrow we dock off at eleven for a short tune-up.',
    ].join(' ')
    const r = collapseRepeats(real)
    expect(r.text).toBe(real)
    expect(r.removed).toBe(0)
    expect(r.loops).toHaveLength(0)
  })

  it('does not collapse a phrase said twice, which is normal speech', () => {
    const t = 'Yes. Yes. That is what I meant.'
    expect(collapseRepeats(t).text).toBe(t)
  })

  it('keeps emphasis of three repeats visible rather than silently deleting', () => {
    const r = collapseRepeats('No. No. No. Move on.')
    expect(r.text).toContain('No.')
    expect(r.text).toContain('[repeated 3x')
    expect(r.text).toContain('Move on.')
  })

  it('handles empty and whitespace input', () => {
    expect(collapseRepeats('').text).toBe('')
    expect(collapseRepeats('   ').text).toBe('')
  })
})
