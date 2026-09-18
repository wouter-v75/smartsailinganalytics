// A session row is a claim that the boat did something that day, and the app's session
// list is read that way. Writes that the APP makes on its own account must never bring
// one into being — only a person asking for that day.
//
// What this pins down: the forecast deck saves its AI summary into
// conditions.details_today for "today", and that single line created a session every
// morning somebody generated a deck. Ten empty days between 2026-08-27 and 2026-09-17,
// each holding nothing but a weather note for a day the boat never sailed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const route = readFileSync(
  'src/app/api/teams/[teamId]/boats/[boatId]/campaign/conditions/route.ts', 'utf8')
const deck = readFileSync('src/components/weather/ForecastDeck.jsx', 'utf8')
const campaign = readFileSync('src/components/CampaignTab.jsx', 'utf8')

/** The PATCH bodies each file sends to …/campaign/conditions. */
const conditionPatchBodies = (src: string) =>
  src.split('\n').filter(l => l.includes('JSON.stringify({ date') && l.includes('createIfMissing'))

describe('the conditions PATCH', () => {
  it('does not insert a session unless asked to', () => {
    // The insert must sit behind the flag, not run unconditionally.
    const guard = route.indexOf('if (!body.createIfMissing)')
    const insert = route.indexOf(".from('sessions')\n      .insert(")
    expect(guard).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(guard)
  })

  it('answers 200 with ok:false when it skips, so a best-effort caller is not an error', () => {
    expect(route).toContain("skipped: 'no session for that date; nothing was created'")
    expect(route).toMatch(/ok: false[\s\S]{0,120}status: 200/)
  })
})

describe('who may create a day', () => {
  it('the forecast deck may NOT — it writes on its own account', () => {
    const line = deck.split('\n').find(l => l.includes('/conditions`') && l.includes('PATCH'))
    expect(line).toBeTruthy()
    expect(line).not.toContain('createIfMissing')
  })

  it('a person typing a plan, timings or a sail list MAY', () => {
    // Three human-edit call sites in CampaignTab, each passing the flag.
    expect(conditionPatchBodies(campaign).length).toBe(3)
  })

  it('the deck reports the skip rather than claiming it saved', () => {
    expect(deck).toContain('no session for ${noteDate} yet — summary not saved')
  })
})
