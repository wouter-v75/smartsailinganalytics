import { describe, it, expect } from 'vitest'
import { importKey, inventoryIndex, planSailImport, type ExistingSail } from '../sailImport'

const ef = (id: string, name: string, over: Partial<ExistingSail> = {}): ExistingSail => ({
  id, name, retired: false, specs: { source: 'event-file' }, ...over,
})
const manual = (id: string, name: string): ExistingSail => ({ id, name, retired: false, specs: {} })
const row = (name: string, over: Record<string, unknown> = {}) => ({ name, ...over })

const INV: ExistingSail[] = [
  ef('i1', 'MAIN_B_2026'),
  ef('i2', 'J4_A_2026', { specs: { source: 'event-file', aliases: ['J4_A 2026'] } }),
  ef('i3', 'A2_2026'),
  manual('i9', 'Delivery main'),
]

describe('importKey', () => {
  it('ignores the case and the space a file is not obliged to get right', () => {
    expect(importKey(' J2 ')).toBe('j2')
    expect(importKey('MAIN')).toBe('main')
  })
})

describe('inventoryIndex', () => {
  it('finds a sail by a name a crew linked to it', () => {
    expect(inventoryIndex(INV).get('j4_a 2026')?.id).toBe('i2')
  })

  it('never lets an alias beat a sail’s own name', () => {
    const both = [ef('i2', 'J4_A_2026', { specs: { aliases: ['J4'] } }), ef('i8', 'J4')]
    expect(inventoryIndex(both).get('j4')?.id).toBe('i8')
  })
})

describe('planSailImport', () => {
  it('matches a file’s spelling to the sail it was linked to', () => {
    // The whole point: the second upload of the same file must not create the
    // sail the crew already said was J4_A_2026.
    const plan = planSailImport(INV, [row('MAIN_B_2026'), row('J4_A 2026')])
    expect(plan.insert).toEqual([])
    expect(plan.update.map((u) => u.sail.id)).toEqual(['i1', 'i2'])
  })

  it('does not retire a sail it matched through an alias', () => {
    // By name, "J4_A_2026" is absent from this file and would be retired —
    // which is the sail locker emptying itself one upload at a time.
    const plan = planSailImport(INV, [row('MAIN_B_2026'), row('J4_A 2026'), row('A2_2026')])
    expect(plan.retire).toEqual([])
  })

  it('still retires an event-file sail the list has dropped', () => {
    const plan = planSailImport(INV, [row('MAIN_B_2026')])
    expect(plan.retire.map((s) => s.id)).toEqual(['i2', 'i3'])
  })

  it('leaves a hand-entered sail alone', () => {
    // An inventory file must not wipe what somebody typed in.
    expect(planSailImport(INV, [row('MAIN_B_2026')]).retire.map((s) => s.id)).not.toContain('i9')
  })

  it('retires nothing when the caller says this is an addition', () => {
    // The tagger's "Add as new" sends one sail; treating it as the whole
    // inventory would retire the boat's locker on the way to adding a storm jib.
    expect(planSailImport(INV, [row('Storm jib')], { reconcile: false }).retire).toEqual([])
  })

  it('reads a stray space as the sail it is', () => {
    const plan = planSailImport(INV, [row(' main_b_2026 ')])
    expect(plan.insert).toEqual([])
    expect(plan.update[0].sail.id).toBe('i1')
  })

  it('makes one sail of a name listed twice', () => {
    expect(planSailImport([], [row('J2'), row('j2 ')]).insert.map((i) => i.name)).toEqual(['J2'])
    expect(planSailImport(INV, [row('J4_A_2026'), row('J4_A 2026')]).update).toHaveLength(1)
  })

  it('inserts what is genuinely new, keeping the file’s spelling', () => {
    const plan = planSailImport(INV, [row('A4_2026', { weightKg: 41 })])
    expect(plan.insert).toEqual([{ name: 'A4_2026', incoming: { name: 'A4_2026', weightKg: 41 } }])
  })

  it('skips a nameless row rather than inserting a blank sail', () => {
    expect(planSailImport(INV, [row('   '), row('')]).insert).toEqual([])
  })
})
