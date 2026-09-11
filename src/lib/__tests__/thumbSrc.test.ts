import { describe, it, expect } from 'vitest'
import { thumbSrc } from '../thumbSrc'

describe('thumbSrc', () => {
  it('sends a Bunny thumbnail through the image optimiser at card width', () => {
    const u = 'https://vz-894f7919-3e6.b-cdn.net/bf21a5ef-bf15-4a82-a25a-2c430ea0cf9b/thumbnail.jpg'
    expect(thumbSrc(u, 256)).toBe(`/_next/image?url=${encodeURIComponent(u)}&w=256&q=60`)
  })
  it('leaves local blobs, other hosts and empty values alone', () => {
    expect(thumbSrc('blob:https://app/123')).toBe('blob:https://app/123')
    expect(thumbSrc('https://example.com/x.jpg')).toBe('https://example.com/x.jpg')
    expect(thumbSrc(null)).toBeNull()
  })
})
