import { describe, it, expect } from 'vitest'
import { videoBadgeSrc } from '../videoBadge'

describe('videoBadgeSrc', () => {
  it('says local for a clip that exists only on this device', () => {
    expect(videoBadgeSrc({ source: 'local' })).toBe('local')
    expect(videoBadgeSrc(null)).toBe('local')
  })

  it('says cloud for a clip the storage-first upload has sent', () => {
    // The watch folder marks the LOCAL record; the older flags arrive later,
    // from the cloud row, and offline they never do.
    expect(videoBadgeSrc({ source: 'local', originalUploadedAt: 1789142332000 })).toBe('cloud')
    expect(videoBadgeSrc({ source: 'local', originalStreamId: 'bf21a5ef' })).toBe('cloud')
  })

  it('says cloud for every older route too', () => {
    expect(videoBadgeSrc({ source: 'local', hasOriginal: true })).toBe('cloud')
    expect(videoBadgeSrc({ source: 'local', hasProxy: true })).toBe('cloud')
    expect(videoBadgeSrc({ source: 'local', cloudSynced: true, streamId: 's1' })).toBe('cloud')
    expect(videoBadgeSrc({ source: 'supabase' })).toBe('cloud')
  })

  it('says processing while Bunny is still encoding', () => {
    expect(videoBadgeSrc({ source: 'local', hasOriginal: true, streamProcessing: true })).toBe('processing')
    expect(videoBadgeSrc({ source: 'processing' })).toBe('processing')
  })

})
