import { describe, it, expect } from 'vitest'
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
