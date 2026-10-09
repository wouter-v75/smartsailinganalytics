import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { BOAT_LOG_PROFILES } from '../boatLogProfiles'
import {
  DEFAULT_ALIASES, effectiveAliases, resolveHeaderIndices, type LogField,
} from '../logProfile'

// ─────────────────────────────────────────────────────────────────────────────
// Baraka GP's own header, verbatim, is the only honest test of its profile: an
// alias is a claim that a column exists under that name, and the file either
// has it or it does not.
// ─────────────────────────────────────────────────────────────────────────────

const LABELS = readFileSync(resolve(__dirname, 'fixtures/baraka-gp-header.csv'), 'utf8')
  .split('\n')[0].replace(/^!/, '').split(',').slice(1).map((s) => s.trim())

const BARAKA = BOAT_LOG_PROFILES['Baraka GP']

describe('Baraka GP log profile', () => {
  const base = resolveHeaderIndices(LABELS, effectiveAliases(null))
  const withProfile = resolveHeaderIndices(LABELS, effectiveAliases(BARAKA))

  it('reads 352 columns from the real header', () => {
    expect(LABELS.length).toBe(352)
    expect(LABELS[0]).toBe('Utc')
  })

  it('needs no profile for the core instruments — that is why most boats need nothing', () => {
    for (const f of ['bsp', 'awa', 'aws', 'twa', 'tws', 'twd', 'heel', 'trim',
                     'lat', 'lon', 'cog', 'sog', 'rudder', 'forestay', 'vang',
                     'airTemp', 'seaTemp', 'rh', 'baro'] as LogField[]) {
      expect(base[f], `${f} should match on the defaults alone`).not.toBeUndefined()
    }
    expect(Object.keys(base).length).toBeGreaterThanOrEqual(44)
  })

  it('adds exactly the three its labels would otherwise lose', () => {
    const gained = (Object.keys(withProfile) as LogField[]).filter((f) => base[f] == null)
    expect(gained.sort()).toEqual(['fstyJibTk', 'toeIn', 'vsTargPct'])
    expect(LABELS[withProfile.toeIn as number]).toBe('RudderToe')
    expect(LABELS[withProfile.fstyJibTk as number]).toBe('FStay+Tack')
    expect(LABELS[withProfile.vsTargPct as number]).toBe('TargBsp%')
  })

  it('every alias it claims is really in that header', () => {
    // An alias matching nothing is a typo, and the only sign would be a field
    // that stays empty after every upload.
    for (const [field, labels] of Object.entries(BARAKA.aliases || {})) {
      expect(withProfile[field as LogField], `${field} matched nothing`).not.toBeUndefined()
      expect(labels!.length).toBeGreaterThan(0)
    }
  })

  it('takes nothing away — a profile only ever adds', () => {
    for (const f of Object.keys(base) as LogField[]) {
      expect(withProfile[f], `${f} was lost`).not.toBeUndefined()
    }
  })

  it('does not restate a label the defaults already know', () => {
    // Harmless, but it reads as though the boat needed it, and the next person
    // cannot tell which lines are load-bearing.
    for (const [field, labels] of Object.entries(BARAKA.aliases || {})) {
      const known = DEFAULT_ALIASES[field as LogField] || []
      for (const l of labels!) {
        const norm = l.toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]/g, '')
        expect(known, `${field}: "${l}" is already a default`).not.toContain(norm)
      }
    }
  })

  it('claims the TargBsp% column, not the Targ Bsp one', () => {
    // 'Targ Bsp' is the target itself (vsTarget) and the defaults already take
    // it; 'TargBsp%' is BSP as a percentage of it. Normalisation makes these
    // two one character apart, so this pins which went where.
    expect(LABELS[base.vsTarget as number]).toBe('Targ Bsp')
    expect(withProfile.vsTarget).toBe(base.vsTarget)
  })
})
