import { describe, it, expect, vi, afterEach } from 'vitest'
// @ts-expect-error — plain JS module, no types
import { MODELS, COMPARE_ORDER, MODEL_ORDER, isSelfHostedModel, fetchSurfaceModel } from '../openMeteo'

// Every model is fetched one of exactly two ways: from Open-Meteo at its own
// `endpoint`, or from our storage via fetchBunnyModel. A model that is neither
// has no address at all, and the ONLY symptom is a request to the literal
// string "undefined" — resolved relative to the current page, so a 404 in a
// console nobody reads. That is how the two SSA-Race models were silently
// absent from the comparison table while the wind field showed them fine.
//
// The old routing asked `cfg.bunnyBase`, which is an OPTIONAL pull-zone whose
// default is null. These tests pin the discriminator to something that does not
// depend on deployment configuration.

const ALL_LISTED: string[] = Array.from(new Set([...(COMPARE_ORDER || []), ...(MODEL_ORDER || [])]))

describe('model routing', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('gives every listed model exactly one way to be fetched', () => {
    const broken = ALL_LISTED.filter((k) => {
      const cfg = MODELS[k]
      return !cfg || (!cfg.endpoint && !isSelfHostedModel(cfg))
    })
    expect(broken).toEqual([])
    const both = ALL_LISTED.filter((k) => MODELS[k]?.endpoint && isSelfHostedModel(MODELS[k]))
    expect(both).toEqual([])
  })

  it('still routes the SSA-Race models to our storage with NO pull zone set', () => {
    // The default deployment: NEXT_PUBLIC_ICONRACE_BASE unset, so bunnyBase is
    // null. Routing must not depend on it — this is the actual regression.
    for (const k of ['ICONRACE', 'ICONRACE_1KM']) {
      expect(MODELS[k].bunnyBase ?? null).toBeNull()
      expect(isSelfHostedModel(MODELS[k])).toBe(true)
    }
  })

  it('never builds an Open-Meteo URL for a self-hosted model', async () => {
    // The real failure, asserted on the WIRE rather than on a flag: fetch must
    // be called with our proxy path, and nothing may contain "undefined?".
    const calls: string[] = []
    // The stub answers BOTH json() and text(): getIconRaceGrid uses json(), the
    // Open-Meteo branch uses text(). A stub that only has one silently sends
    // the code down an error path and the assertion then proves nothing.
    const body = { cells: [], time: [], heights: [] }
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls.push(String(url))
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
    }))
    // Point 1 of the Solent box, which ICONRACE covers.
    await fetchSurfaceModel({ modelKey: 'ICONRACE', latitude: 50.76, longitude: -1.3, timezone: 'Europe/London' })
    expect(calls.length).toBeGreaterThan(0)
    for (const u of calls) {
      expect(u).not.toContain('undefined')
      expect(u).not.toContain('api.open-meteo.com')
    }
    expect(calls.some((u) => u.includes('/api/bunny/storage'))).toBe(true)
  })

  it('refuses a model with no address instead of fetching the string "undefined"', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls.push(String(url))
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // HPBL is selfHosted but has no venues, so fetchBunnyModel declines it; a
    // model that is neither is the case this guards.
    MODELS.__TEST_NO_ADDRESS__ = { key: '__TEST_NO_ADDRESS__', label: 'test', heights: [] }
    try {
      const out = await fetchSurfaceModel({ modelKey: '__TEST_NO_ADDRESS__', latitude: 50.76, longitude: -1.3, timezone: 'UTC' })
      expect(out).toBeNull()
      expect(calls).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      delete MODELS.__TEST_NO_ADDRESS__
    }
  })

  it('splits the fetch batch by how a model is served, not by pull-zone config', () => {
    // fetchAllForPoint loads self-hosted models FIRST and in parallel, and the
    // Open-Meteo ones sequentially with a 300 ms gap for the rate limit. With
    // the old test the SSA-Race models landed in the throttled loop, which both
    // delayed them and sent them to a URL they do not have.
    const selfHosted = COMPARE_ORDER.filter((k: string) => isSelfHostedModel(MODELS[k]))
    const openMeteo = COMPARE_ORDER.filter((k: string) => !isSelfHostedModel(MODELS[k]))
    expect(selfHosted).toEqual(['ICONRACE', 'ICONRACE_1KM'])
    expect(openMeteo).not.toContain('ICONRACE')
    expect(openMeteo.every((k: string) => !!MODELS[k].endpoint)).toBe(true)
  })
})
