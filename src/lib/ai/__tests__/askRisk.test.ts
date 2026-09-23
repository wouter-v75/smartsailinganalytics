import { describe, it, expect } from 'vitest'
import { assessQuestion, assessAnswer, riskNote, THIN_GROUP, type AskContext } from '../askRisk'
import type { AskStep } from '../askRun'

const ctx = (over: Partial<AskContext> = {}): AskContext => ({
  date: '2026-09-11',
  dates: ['2026-09-08', '2026-09-09', '2026-09-11'],
  sailCombos: ['J4_A 2026', 'J2_B 2026'],
  races: [1, 2, 3],
  channels: ['tws', 'bsp', 'vmgPct', 'heel'],
  phaseCount: 139,
  manoeuvreCount: 22,
  media: { photos: 40, videos: 6, scans: 3, tags: 12 },
  twsRange: [11, 24],
  ...over,
})

describe('assessQuestion — before a single token is spent', () => {
  it('passes a question the data can answer', () => {
    const v = assessQuestion('Were we quicker on port or starboard upwind in the breeze?', ctx())
    expect(v.level).toBe('ok')
    expect(v.narrower).toEqual([])
  })

  // A warning that cries wolf is not a warning. These are the questions this
  // tool exists for and not one of them may raise a flag — the first draft of
  // the vocabulary flagged the very first of them, because "upwind" does not
  // contain the word "wind".
  it.each([
    'Were we quicker on port or starboard upwind in the breeze?',
    'Which jib was better above 18 knots?',
    'How was our heel through race 2?',
    'Show me the kite at the top mark',
    'Which tacks cost the most distance?',
    'Did we point higher on starboard?',
    'How did today compare with the season downwind?',
    'What did the sail scans say about jib camber?',
    'When did the breeze go left?',
    'How much forestay load were we carrying upwind?',
  ])('does not flag %s', question => {
    expect(assessQuestion(question, ctx()).level).toBe('ok')
  })

  // The four that have no answer in a log of this boat's own instruments. These
  // are where a fluent model is at its most convincing and most wrong.
  it.each([
    ['who was trimming when we were slow?', 'people'],
    ['how did we do against the other boats?', 'opposition'],
    ['what should we change for tomorrow?', 'future'],
    ['did the crew feel comfortable in the puffs?', 'feel'],
  ])('refuses %s', (question, code) => {
    const v = assessQuestion(question, ctx())
    expect(v.level).toBe('high')
    expect(v.findings.map(f => f.code)).toContain(code)
  })

  it('lets an opposition question through when the boat has squad tracks', () => {
    const v = assessQuestion('how did we do against the other boats?', ctx({ hasSquadTracks: true }))
    expect(v.findings.map(f => f.code)).not.toContain('opposition')
  })

  it('warns about a causal question without refusing it', () => {
    const v = assessQuestion('why was our upwind speed down in the second race?', ctx())
    expect(v.level).toBe('caution')
    expect(v.findings.map(f => f.code)).toContain('causal')
  })

  it('warns about a question too broad to ground', () => {
    expect(assessQuestion('tell me about the day', ctx()).level).toBe('caution')
  })

  it('refuses everything when the day has no stored numbers', () => {
    const v = assessQuestion('were we quicker on port upwind?', ctx({ phaseCount: 0, dates: [] }))
    expect(v.level).toBe('high')
    expect(v.findings.map(f => f.code)).toContain('noStats')
  })

  it('flags a day too thin to compare anything on', () => {
    const v = assessQuestion('were we quicker on port upwind?', ctx({ phaseCount: 4 }))
    expect(v.findings.map(f => f.code)).toContain('thinDay')
  })
})

describe('the narrower questions it offers instead', () => {
  it('offers questions built from this boat, not from a template of sailing', () => {
    const v = assessQuestion('who was on the helm when we were slow?', ctx())
    expect(v.narrower.length).toBeGreaterThan(0)
    expect(v.narrower.join(' ')).toContain('2026-09-11')
    expect(v.narrower.some(q => q.includes('J4_A 2026'))).toBe(true)
  })

  it('names the wind range the day actually had', () => {
    const v = assessQuestion('tell me about the day', ctx())
    expect(v.narrower.some(q => q.includes('11') && q.includes('24'))).toBe(true)
  })

  it('does not offer a media question to a boat with no media', () => {
    const v = assessQuestion('who was trimming?', ctx({ media: { photos: 0, videos: 0, scans: 0, tags: 0 } }))
    expect(v.narrower.some(q => q.toLowerCase().includes('photo'))).toBe(false)
  })

  it('offers nothing to build on when there is nothing stored', () => {
    const v = assessQuestion('who was trimming?', ctx({ phaseCount: 0, dates: [], manoeuvreCount: 0, media: { photos: 0, videos: 0, scans: 0, tags: 0 } }))
    expect(v.narrower).toEqual([])
  })

  it('falls back to boat speed when the boat has no polar', () => {
    const v = assessQuestion('why were we slow?', ctx({ channels: ['tws', 'bsp'] }))
    expect(v.narrower.join(' ')).toContain('boat speed')
  })
})

describe('riskNote — what the model is told about its own footing', () => {
  it('is silent on a clean question', () => {
    expect(riskNote(assessQuestion('were we quicker on port upwind?', ctx()))).toBe('')
  })
  it('tells the model to say what it cannot show', () => {
    const note = riskNote(assessQuestion('why were we slow?', ctx()))
    expect(note).toContain('suggestions')
  })
})

describe('assessAnswer — after the tools have run', () => {
  const step = (rows: (string | number | null)[][]): AskStep => ({
    tool: 'compare_phases',
    args: { by: ['tack'], metrics: ['vmgPct'], minPhases: 3 },
    chips: [],
    result: {
      summary: '', media: [],
      tables: [{
        title: 't',
        columns: [{ key: 'tack', label: 'Tack', group: true }, { key: 'n', label: 'n' }, { key: 'vmgPct', label: 'VMG%' }],
        rows,
      }],
    },
  })
  const clean = { lines: ['x'], bottomLine: [], dropped: [] }

  it('says so when nothing was read at all', () => {
    expect(assessAnswer([], clean).map(f => f.code)).toContain('noTools')
  })

  it('counts the groups too thin to lean on', () => {
    const f = assessAnswer([step([['Port', 3, 96.4], ['Stbd', 18, 99.1]])], clean)
    expect(f.map(x => x.code)).toContain('thinGroups')
    expect(f.find(x => x.code === 'thinGroups')!.text).toContain(`${THIN_GROUP}`)
  })

  it('notices a comparison with nothing to compare against', () => {
    expect(assessAnswer([step([['Port', 18, 96.4]])], clean).map(f => f.code)).toContain('noComparison')
  })

  it('reports the sentences the number check removed', () => {
    const f = assessAnswer([step([['Port', 18, 96.4], ['Stbd', 16, 99.1]])], { ...clean, dropped: ['2.7 points better'] })
    expect(f.map(x => x.code)).toContain('dropped')
  })

  it('finds nothing wrong with a healthy answer', () => {
    expect(assessAnswer([step([['Port', 18, 96.4], ['Stbd', 16, 99.1]])], clean)).toEqual([])
  })
})
