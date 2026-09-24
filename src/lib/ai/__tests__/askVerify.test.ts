import { describe, it, expect } from 'vitest'
import { verifyAnswer, allowedNumbers } from '../askVerify'
import type { ToolResult } from '../askTypes'

const result: ToolResult = {
  summary: '34 phases of 58, in 2 groups.',
  tables: [{
    title: 'VMG% by tack',
    columns: [
      { key: 'tack', label: 'Tack', group: true },
      { key: 'n', label: 'n' },
      { key: 'vmgPct', label: 'VMG%', unit: '%', decimals: 1 },
    ],
    rows: [['Port', 18, 96.4], ['Stbd', 16, 99.1]],
  }],
  media: [],
}

describe('the number check', () => {
  it('keeps a sentence whose numbers all came from a tool', () => {
    const v = verifyAnswer({ answer: ['VMG% was 99.1 on starboard against 96.4 on port.'] }, [result])
    expect(v.lines).toHaveLength(1)
    expect(v.dropped).toHaveLength(0)
  })

  // The failure this exists for: the model subtracting 96.4 from 99.1 and
  // presenting 2.7 as a measurement. No tool produced 2.7.
  it('drops a difference the model worked out itself', () => {
    const v = verifyAnswer({ answer: ['Starboard was 2.7 points better than port.'] }, [result])
    expect(v.lines).toHaveLength(0)
    expect(v.dropped).toHaveLength(1)
  })

  it('drops a number that is simply invented', () => {
    const v = verifyAnswer({ answer: ['VMG% reached 104.8 on the last beat.'] }, [result])
    expect(v.lines).toHaveLength(0)
  })

  it('keeps the phase counts, which are numbers a tool did return', () => {
    const v = verifyAnswer({ answer: ['Port rests on 18 phases and starboard on 16.'] }, [result])
    expect(v.lines).toHaveLength(1)
  })

  // A useful answer is often "there is nothing there", and that sentence has no
  // number to check. Headlines requires one; an answer must not.
  it('keeps a sentence with no numbers at all', () => {
    const v = verifyAnswer({ answer: ['There are no sail scans in that wind band.'] }, [result])
    expect(v.lines).toHaveLength(1)
  })

  it('checks the bottom line by the same rule', () => {
    const v = verifyAnswer({
      answer: ['VMG% was 99.1 on starboard.'],
      bottomLine: ['Work on the port-tack groove — it is 3.4 points down.'],
    }, [result])
    expect(v.lines).toHaveLength(1)
    expect(v.bottomLine).toHaveLength(0)
  })

  it('accepts the dates in scope, which no tool returns as a number', () => {
    const v = verifyAnswer(
      { answer: ['On 2026-09-11, VMG% was 99.1 on starboard.'] },
      [result],
      ['2026-09-11'],
    )
    expect(v.lines).toHaveLength(1)
  })

  it('survives the model returning nothing parseable', () => {
    expect(verifyAnswer(null, [result]).lines).toEqual([])
    expect(verifyAnswer({ answer: 'not an array' } as never, [result]).lines).toHaveLength(1)
  })

  it('takes numbers from media captions too, so a photo can be described', () => {
    const withPhoto: ToolResult = {
      summary: '1 item.',
      tables: [],
      media: [{
        kind: 'photo', id: 'p1', title: 'J4 2026', atLocal: '14:32', utc: 1, date: '2026-09-11',
        thumbUrl: null, fullUrl: null, conditions: 'TWS 21.4 kn · TWA 42 °', note: null,
      }],
    }
    const v = verifyAnswer({ answer: ['The photo at 14:32 shows TWS 21.4 kn.'] }, [withPhoto])
    expect(v.lines).toHaveLength(1)
  })
})

describe('allowedNumbers', () => {
  it('collects table cells, headers and the summary', () => {
    const set = allowedNumbers([result])
    expect(set.has('96.4')).toBe(true)
    expect(set.has('18')).toBe(true)
    expect(set.has('2.7')).toBe(false)
  })
})

// Found by the eval on 24 Sep: "show the main sail cambers for best upwind VMG%"
// produced a true sentence that was then deleted. The stripe heights live glued
// to letters inside the column label, where numbersIn cannot see them — correctly,
// since it must not read the 4 in "J4" as a value.
describe('numbers that live inside a column label', () => {
  const lidar: ToolResult = {
    summary: '',
    tables: [{
      title: 'MN CA25, MN CA50, MN CA75 by TWS band',
      columns: [
        { key: 'twsBand', label: 'TWS band (kn)', group: true },
        { key: 'n', label: 'n' },
        { key: 'mnCa25', label: 'MN CA25', unit: '%', decimals: 1 },
        { key: 'mnCa50', label: 'MN CA50', unit: '%', decimals: 1 },
        { key: 'mnCa75', label: 'MN CA75', unit: '%', decimals: 1 },
      ],
      rows: [['11-13', 20, 7.3, 6.6, 3.9]],
    }],
    media: [],
  }

  it('keeps a sentence citing the stripe heights it is reporting on', () => {
    const v = verifyAnswer(
      { answer: ['Mainsail cambers: 7.3 % at 25 %, 6.6 % at 50 %, 3.9 % at 75 %.'] },
      [lidar],
    )
    expect(v.lines).toHaveLength(1)
    expect(v.dropped).toHaveLength(0)
  })

  // The label is a licence to echo it, not to invent alongside it.
  it('still drops a value that is in no cell and no label', () => {
    const v = verifyAnswer({ answer: ['Mainsail camber was 9.9 % at 25 %.'] }, [lidar])
    expect(v.lines).toHaveLength(0)
  })
})
