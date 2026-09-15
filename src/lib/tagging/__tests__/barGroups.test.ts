import { describe, it, expect } from 'vitest'
import { BAR_GROUPS, barItems, groupMembers, type BarGroup } from '../barGroups'
import { BASE_TAGS } from '../baseTags'
import type { TagDef } from '../types'

const def = (slug: string, over: Partial<TagDef> = {}): TagDef => ({
  id: `def-${slug}`, teamId: 't', boatId: null,
  scope: 'general', section: null, ownerUserId: null,
  slug, label: slug, color: '#fff', minRole: 'tl1', kind: 'point',
  leadSec: 10, lagSec: 10, labelGroups: [], lane: null,
  onButtonBar: false, privateByDefault: false,
  builtin: true, archived: false, sort: 0,
  ...over,
})

const RACING: BarGroup = BAR_GROUPS.find((g) => g.key === 'racing')!

describe('the racing group', () => {
  it('names the five racing moments, in course order', () => {
    expect(RACING.slugs).toEqual(['race-start', 'topmark', 'gate', 'mark', 'race-finish'])
  })

  it('every slug it names exists in the base vocabulary', () => {
    const base = new Set(BASE_TAGS.map((t) => t.slug))
    for (const slug of RACING.slugs) expect(base.has(slug)).toBe(true)
  })
})

describe('groupMembers', () => {
  const defs = RACING.slugs.map((s) => def(s))

  it('returns them in the GROUP’s order, not the definitions’ order', () => {
    const shuffled = [...defs].reverse()
    expect(groupMembers(RACING, shuffled).map((d) => d.slug)).toEqual(RACING.slugs)
  })

  it('skips a tag this user may not apply', () => {
    const gated = defs.map((d) => (d.slug === 'gate' ? { ...d, canApply: false } : d))
    expect(groupMembers(RACING, gated).map((d) => d.slug)).not.toContain('gate')
  })

  it('skips an archived tag', () => {
    const gone = defs.map((d) => (d.slug === 'mark' ? { ...d, archived: true } : d))
    expect(groupMembers(RACING, gone).map((d) => d.slug)).not.toContain('mark')
  })

  it('a team with none of them gets an empty group, not a crash', () => {
    expect(groupMembers(RACING, [])).toEqual([])
  })
})

describe('barItems', () => {
  const onBar = [def('note'), def('review')]
  const all = [...onBar, ...RACING.slugs.map((s) => def(s))]

  it('draws the bar tags first and the group last', () => {
    const items = barItems(onBar, all)
    expect(items.map((i) => (i.kind === 'tag' ? i.def.slug : `group:${i.group.key}`)))
      .toEqual(['note', 'review', 'group:racing'])
  })

  it('carries the group’s members with it', () => {
    const group = barItems(onBar, all).find((i) => i.kind === 'group')
    expect(group?.kind === 'group' && group.members.map((d) => d.slug)).toEqual(RACING.slugs)
  })

  it('does not repeat a slug that is already its own button', () => {
    const withStart = [...onBar, def('race-start', { onButtonBar: true })]
    const items = barItems(withStart, all)
    const group = items.find((i) => i.kind === 'group')
    expect(group?.kind === 'group' && group.members.map((d) => d.slug)).not.toContain('race-start')
  })

  it('a group down to one member is drawn as that tag, not as a sheet of one', () => {
    const one = [def('topmark')]
    const items = barItems([], one)
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('tag')
    expect(items[0].kind === 'tag' && items[0].def.slug).toBe('topmark')
  })

  it('a group with no members at all is omitted', () => {
    expect(barItems(onBar, onBar)).toHaveLength(2)
  })

  it('drops bar tags the user may not apply', () => {
    const items = barItems([def('note'), def('team-note', { canApply: false })], all)
    expect(items.some((i) => i.kind === 'tag' && i.def.slug === 'team-note')).toBe(false)
  })
})
