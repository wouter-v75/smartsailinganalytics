import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { planTrackerIngest, titleFromFilename, venueDate } from '../trackerIngest'

const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures/vakaros-atlas-sample.csv'), 'utf8')

const SAILOR = { team_id: 'team-1', boat_id: 'boat-49er-1' }
const COACH = { team_id: 'team-1', boat_id: null }

describe('venueDate', () => {
  it('files a session by the date at the VENUE, not in UTC', () => {
    // 22:30 local on 8 Feb at UTC+2 is 20:30Z the same day…
    expect(venueDate(Date.UTC(2026, 1, 8, 20, 30), 120)).toBe('2026-02-08')
    // …but 23:30 local is 21:30Z, and an hour later local midnight has passed.
    expect(venueDate(Date.UTC(2026, 1, 8, 23, 30), 120)).toBe('2026-02-09')
    // Westward: 19:00 local at UTC−5 is 00:00Z the NEXT day in UTC terms.
    expect(venueDate(Date.UTC(2026, 1, 9, 0, 0), -300)).toBe('2026-02-08')
  })
})

describe('titleFromFilename', () => {
  it('keeps the human label and drops the unreliable date', () => {
    // The two real exports from ONE session, written two different ways.
    expect(titleFromFilename('Miss Behavior 2 2-8-2026.csv')).toBe('Miss Behavior 2')
    expect(titleFromFilename('Torvar’s second  08-02-2026.csv')).toBe('Torvar’s second')
  })

  it('handles no date, no extension, and nothing at all', () => {
    expect(titleFromFilename('training.csv')).toBe('training')
    expect(titleFromFilename('Race 3')).toBe('Race 3')
    expect(titleFromFilename(null)).toBeNull()
    expect(titleFromFilename('2026-02-08.csv')).toBeNull()
  })
})

describe('planTrackerIngest — a Vakaros file needs no questions', () => {
  const plan = planTrackerIngest(FIXTURE, {
    filename: 'Miss Behavior 2 2-8-2026.csv',
    membership: SAILOR,
  })

  it('asks nothing at all', () => {
    // The whole point. Format, date, timezone and boat are all known.
    expect(plan.needs).toEqual([])
    expect(plan.ok).toBe(true)
  })

  it('takes the venue clock from the file, not from a dropdown', () => {
    expect(plan.tzFromFile).toBe(true)
    expect(plan.tzOffsetMin).toBe(60)
  })

  it('derives the session date from the first timestamp, venue-local', () => {
    // 11:56 local (+0100) on 8 Feb = 10:56Z — same day, but derived the right way.
    expect(plan.sessionDate).toBe('2026-02-08')
  })

  it('resolves the boat from the uploader, not from the file', () => {
    expect(plan.teamId).toBe('team-1')
    expect(plan.boatId).toBe('boat-49er-1')
  })

  it('carries the parsed track and its measured cadence', () => {
    expect(plan.format).toBe('vakaros-csv')
    expect(plan.rows).toHaveLength(40)
    expect(plan.rateHz).toBeCloseTo(2, 1)
  })

  it('keeps the human label from the filename', () => {
    expect(plan.title).toBe('Miss Behavior 2')
  })

  it('tells the uploader what it inferred without asking anything', () => {
    expect(plan.notes.join(' ')).toContain('UTC+1')
    expect(plan.notes.join(' ')).toContain('2 Hz')
  })
})

describe('planTrackerIngest — the one question worth asking', () => {
  it('asks for the boat only when the membership spans boats', () => {
    const plan = planTrackerIngest(FIXTURE, { membership: COACH })
    expect(plan.needs).toEqual(['boat'])
    expect(plan.ok).toBe(false)
    expect(plan.teamId).toBe('team-1')
    // Everything else is still resolved — only the boat is open.
    expect(plan.sessionDate).toBe('2026-02-08')
    expect(plan.tzOffsetMin).toBe(60)
  })

  it('asks for a timezone only when the format has no clock of its own', () => {
    const flat = 'Utc,Lat,Lon,Bsp,Tws\n45000.5,39.5,2.5,6.1,11\n'
    const plan = planTrackerIngest(flat, { membership: SAILOR })
    expect(plan.format).not.toBe('vakaros-csv')
    expect(plan.needs).toContain('timezone')
    expect(plan.tzFromFile).toBe(false)
  })

  it('accepts a fallback offset for formats without one', () => {
    const flat = 'Utc,Lat,Lon,Bsp,Tws\n45000.5,39.5,2.5,6.1,11\n'
    const plan = planTrackerIngest(flat, { membership: SAILOR, tzFallbackMin: 120 })
    expect(plan.needs).not.toContain('timezone')
    expect(plan.tzOffsetMin).toBe(120)
    expect(plan.tzFromFile).toBe(false)
  })
})

describe('planTrackerIngest — failure is reported, never guessed', () => {
  it('reports an empty file rather than inventing a session', () => {
    const plan = planTrackerIngest('', { membership: SAILOR })
    expect(plan.ok).toBe(false)
    expect(plan.error).toBeTruthy()
    expect(plan.sessionDate).toBeNull()
  })

  it('reports a header with no data rows', () => {
    const plan = planTrackerIngest('timestamp,latitude,longitude,sog_kts,cog,hdg_true,heel,trim\r\n', {
      membership: SAILOR,
    })
    expect(plan.ok).toBe(false)
    expect(plan.error).toContain('no rows')
    expect(plan.format).toBe('vakaros-csv')   // format still identified
  })

  it('never derives the date from the filename', () => {
    // Filename says 2-8-2026 (M-D); the file says 8 Feb. The file wins.
    const plan = planTrackerIngest(FIXTURE, {
      filename: 'Miss Behavior 2 2-8-2026.csv', membership: SAILOR,
    })
    expect(plan.sessionDate).toBe('2026-02-08')
  })
})
