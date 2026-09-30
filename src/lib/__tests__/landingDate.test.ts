// src/lib/__tests__/landingDate.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The day the app opens on. One rule, four call sites, and it was the one that
// nobody had written down that got it wrong — the boat-switch path bounded its
// local sessions to today and left the cloud ones unbounded, so the app opened
// on 3 October, the last day of a regatta that had not happened yet, and the
// crew tagged onto it.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { landingDate, pastDates } from '../landingDate'

const TODAY = '2026-09-30'

describe('landingDate', () => {
  it('opens on the newest day that has something', () => {
    expect(landingDate(['2026-09-27', '2026-09-29', '2026-09-28'], [], TODAY)).toBe('2026-09-29')
  })

  it('opens on today when today has something', () => {
    expect(landingDate(['2026-09-29', TODAY], [], TODAY)).toBe(TODAY)
  })

  it('NEVER opens on a day that has not happened', () => {
    // The regatta runs to 3 October and its sessions exist already.
    const regatta = ['2026-10-01', '2026-10-02', '2026-10-03']
    expect(landingDate([...regatta, '2026-09-29'], [], TODAY)).toBe('2026-09-29')
    expect(landingDate(regatta, [], TODAY)).toBe(TODAY)
  })

  it('does not let a future day in through the second list either', () => {
    // The bug exactly: one list bounded, the other not.
    expect(landingDate([], ['2026-10-03'], TODAY)).toBe(TODAY)
    expect(landingDate(['2026-09-28'], ['2026-10-03'], TODAY)).toBe('2026-09-28')
  })

  it('falls back to a known day with no data before falling back to today', () => {
    expect(landingDate([], ['2026-09-28', '2026-09-26'], TODAY)).toBe('2026-09-28')
  })

  it('is today when there is nothing at all', () => {
    expect(landingDate([], [], TODAY)).toBe(TODAY)
  })

  it('ignores nulls, undefined and blanks rather than sorting them to the top', () => {
    expect(landingDate([null, undefined, '', '2026-09-29'], [], TODAY)).toBe('2026-09-29')
    expect(landingDate([null, undefined], [null], TODAY)).toBe(TODAY)
  })

  it('treats a day that has data as better than a newer day that does not', () => {
    // A library that opens on an empty folder is a blank screen; the second list
    // is the fallback, never the preference.
    expect(landingDate(['2026-09-28'], ['2026-09-29'], TODAY)).toBe('2026-09-28')
  })
})

describe('pastDates', () => {
  it('returns what has happened, newest first', () => {
    expect(pastDates(['2026-09-28', '2026-10-03', TODAY, '2026-09-29'], TODAY))
      .toEqual([TODAY, '2026-09-29', '2026-09-28'])
  })

  it('counts today as having happened', () => {
    expect(pastDates([TODAY], TODAY)).toEqual([TODAY])
  })

  it('is empty when everything is still to come', () => {
    expect(pastDates(['2026-10-01', '2026-10-03'], TODAY)).toEqual([])
  })
})
