// The role vocabulary must agree with itself.
//
// Every bug this file guards against has already happened here:
//
//   - `tl3` shipped in migration 0025 and was left out of the upload policies,
//     so the SENIOR sailing role could not add a photo while tl1 could. It sat
//     like that for 55 migrations because nothing compared the lists.
//   - `src/lib/supabase/types.ts` declared a MembershipRole union that never
//     contained 'tl3' at all, so TypeScript could not have caught the above.
//   - `shareRoles.ts` kept its own ROLE_LABELS map, which is how one role ends
//     up with two different names on two screens.
//   - `tl2` was removed in 0083 and lingered in a dozen places.
//
// None of these fail loudly at runtime. A role missing from a list does not
// throw; it silently denies someone, or silently permits them.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { ROLE_LABELS, ASSIGNABLE_ROLES, roleLabel } from '../roleLabels'
import { ROLE_RANK } from '../memberships'
import type { MembershipRole } from '../active-membership'

const MIGRATIONS = join(process.cwd(), 'supabase/migrations')
const SRC = join(process.cwd(), 'src')

/** The role CHECK constraint the database actually has, from the last migration to set it. */
function liveRolesFromCheck(): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  let last: string[] | null = null
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8')
    const m = [...sql.matchAll(/memberships_role_check[\s\S]*?CHECK \(role IN \(([^)]*)\)\)/g)].pop()
    if (m) last = m[1].split(',').map((r) => r.trim().replace(/'/g, ''))
  }
  if (!last) throw new Error('no memberships_role_check found in migrations')
  return last
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(full)
  }
  return out
}

describe('role vocabulary', () => {
  const dbRoles = liveRolesFromCheck()

  it('the database CHECK no longer allows tl2', () => {
    expect(dbRoles).not.toContain('tl2')
  })

  it('every membership role the database allows has a display name', () => {
    for (const r of dbRoles) {
      expect(ROLE_LABELS[r as MembershipRole], `no label for '${r}'`).toBeTruthy()
    }
  })

  it('every role we can assign is one the database accepts', () => {
    for (const r of ASSIGNABLE_ROLES) expect(dbRoles).toContain(r)
  })

  it('the rank list covers exactly the assignable roles', () => {
    expect([...ROLE_RANK].sort()).toEqual([...ASSIGNABLE_ROLES].sort())
  })

  it('a removed role still renders as something, not blank', () => {
    // An old audit row may still say tl2; it must not show an empty cell.
    expect(roleLabel('tl2')).toMatch(/Gold/)
    expect(roleLabel(null)).toBe('—')
  })

  it("no source file still names 'tl2'", () => {
    // roleLabels.ts and active-membership.ts mention it in prose/legacy mapping.
    const ALLOWED = ['roleLabels.ts', 'active-membership.ts', 'types.ts']
    const offenders: string[] = []
    for (const f of sourceFiles(SRC)) {
      if (ALLOWED.some((a) => f.endsWith(a))) continue
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      if (/'tl2'|"tl2"/.test(code)) offenders.push(f.slice(SRC.length + 1))
    }
    expect(offenders, `these still name tl2: ${offenders.join(', ')}`).toEqual([])
  })
})
