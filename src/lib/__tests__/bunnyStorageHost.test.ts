import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { storageHost, storageObjectUrl } from '../bunnyStorageHost'

describe('storageHost', () => {
  it('gives Frankfurt the bare host — it carries no region prefix', () => {
    expect(storageHost('de')).toBe('https://storage.bunnycdn.com')
  })

  it('prefixes every other region', () => {
    expect(storageHost('uk')).toBe('https://uk.storage.bunnycdn.com')
    expect(storageHost('ny')).toBe('https://ny.storage.bunnycdn.com')
    expect(storageHost('syd')).toBe('https://syd.storage.bunnycdn.com')
  })

  it('is case- and whitespace-insensitive, and defaults to Frankfurt', () => {
    expect(storageHost(' DE ')).toBe('https://storage.bunnycdn.com')
    expect(storageHost('UK')).toBe('https://uk.storage.bunnycdn.com')
    expect(storageHost('')).toBe('https://storage.bunnycdn.com')
    expect(storageHost(undefined)).toBe(storageHost(process.env.BUNNY_STORAGE_REGION))
  })
})

describe('storageObjectUrl', () => {
  it('addresses an object on the Storage API, not the pull zone', () => {
    expect(storageObjectUrl('ssa', 'sessions/2026-09-08/proxies/v1.mp4', 'de'))
      .toBe('https://storage.bunnycdn.com/ssa/sessions/2026-09-08/proxies/v1.mp4')
  })

  it('treats a leading slash as the same object', () => {
    const a = storageObjectUrl('ssa', '/sessions/a.mp4', 'de')
    const b = storageObjectUrl('ssa', 'sessions/a.mp4', 'de')
    expect(a).toBe(b)
    expect(a).toBe('https://storage.bunnycdn.com/ssa/sessions/a.mp4')
  })
})

describe('one implementation of the rule', () => {
  // It had THIRTEEN, each `REGION === 'de' ? bare : prefixed`, inlined into
  // every route that talks to Storage. The rule is not hard; the failure mode
  // is, because a PUT to the wrong regional host answers 401, which reads as a
  // bad key. Thirteen copies is thirteen places to get a zone's region wrong in
  // a way that looks like a credentials problem.
  //
  // scripts/ is deliberately out of scope here: those run outside the app, off
  // .env.local, and do not share its module graph.
  it('nothing under src/ builds a Storage host by hand', () => {
    const SRC = join(process.cwd(), 'src')
    const CODE = /\.(ts|tsx|js|jsx)$/
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full, acc) }
        else if (CODE.test(name)) acc.push(full)
      }
      return acc
    }
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith('bunnyStorageHost.ts'))
      .filter((f) => !f.endsWith('bunnyStorageHost.test.ts'))
      .filter((f) => /\$\{[A-Za-z_]+\}\.storage\.bunnycdn\.com/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })
})
