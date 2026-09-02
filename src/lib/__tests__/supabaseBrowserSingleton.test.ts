import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Count how many GoTrueClients the app would create. supabase-js warns that
// multiple instances in one browser context share a storage key and contend for
// the same navigator lock; with 49 call sites that turned a post-idle reload into
// a serialised token-refresh queue with the user pill stuck behind it.
const made: number[] = []
vi.mock('@supabase/ssr', () => ({
  createBrowserClient: (url: string, key: string) => {
    made.push(1)
    return { __id: made.length, url, key, auth: {} }
  },
}))

describe('getBrowserSupabase', () => {
  beforeEach(() => {
    made.length = 0
    vi.resetModules()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('builds the client once and hands the SAME instance back every time', async () => {
    const { getBrowserSupabase } = await import('../supabase/browser')
    const a = getBrowserSupabase()
    const b = getBrowserSupabase()
    const c = getBrowserSupabase()
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(made.length).toBe(1)
  })

  it('stays at one instance across the ~49 call sites the app has', async () => {
    const { getBrowserSupabase } = await import('../supabase/browser')
    const seen = new Set()
    for (let i = 0; i < 49; i++) seen.add(getBrowserSupabase())
    expect(seen.size).toBe(1)
    expect(made.length).toBe(1)   // was 49 before the fix
  })

  it('does NOT cache on the server — a shared client would leak auth across requests', async () => {
    const w = globalThis.window
    // @ts-expect-error - simulate the server bundle
    delete globalThis.window
    try {
      const { getBrowserSupabase } = await import('../supabase/browser')
      const a = getBrowserSupabase()
      const b = getBrowserSupabase()
      expect(a).not.toBe(b)
      expect(made.length).toBe(2)
    } finally {
      globalThis.window = w
    }
  })

  it('passes the configured url and key through', async () => {
    const { getBrowserSupabase } = await import('../supabase/browser')
    const c = getBrowserSupabase() as unknown as { url: string; key: string }
    expect(c.url).toBe('https://example.supabase.co')
    expect(c.key).toBe('anon-key')
  })
})
