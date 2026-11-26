// The photos upsert must never lose `analysis_data` a caller did not know about.
//
// `analysis_data` is one JSON blob holding independent things: `inst` (the
// instrument snapshot, written at import), `sails` / `raceTags` / `boat` /
// `location`, and `sailTrim` — hand-marked sail geometry, the most expensive
// data in the app and the only part nothing can regenerate.
//
// Three writers, three different ideas of what is stored:
//
//   savePhotoSailTrim      the TIMELINE. Writes the shared row, nothing local.
//   photoStore.mirror()    fired when a deferred original finally uploads on
//                          Wi-Fi. Sends the IMPORTING DEVICE's `analysis`.
//   PhotosTab              safe, but only because mergeCloudIntoLocal folds
//                          the cloud's copy in first — and that has one caller.
//
// The handler used to replace the column, so the second of those silently
// deleted the first's geometry. It merges now. These tests are the shape of
// that merge, written against the same logic the route runs.

import { describe, it, expect } from 'vitest'

/** Exactly what the route does on UPDATE. */
function mergeAnalysis(
  stored: Record<string, unknown> | null,
  incoming: unknown
): Record<string, unknown> | undefined {
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    return { ...(stored || {}), ...(incoming as Record<string, unknown>) }
  }
  return undefined // column left untouched
}

const SAIL_TRIM = { annotation: { marks: [1, 2, 3] }, overlay: true, headline: 'boom 310 mm' }

describe('analysis_data on a photo upsert', () => {
  it('keeps geometry a stale client never heard of', () => {
    // The real sequence: imported on cellular, measured from the timeline,
    // original flushes on Wi-Fi days later carrying the import-time blob.
    const stored = { inst: { tws: 11.2 }, sails: ['J2'], sailTrim: SAIL_TRIM }
    const fromImportingDevice = { inst: { tws: 11.2 }, sails: ['J2'] }

    const merged = mergeAnalysis(stored, fromImportingDevice)

    expect(merged?.sailTrim).toEqual(SAIL_TRIM)
    expect(merged?.sails).toEqual(['J2'])
  })

  it('still lets a writer update what it does own', () => {
    const stored = { inst: { tws: 11.2 }, sails: ['J2'], sailTrim: SAIL_TRIM }
    const merged = mergeAnalysis(stored, { sails: ['J1', 'MH0'] })
    expect(merged?.sails).toEqual(['J1', 'MH0'])
    expect(merged?.sailTrim).toEqual(SAIL_TRIM)
    expect(merged?.inst).toEqual({ tws: 11.2 })
  })

  it('a re-measure replaces the geometry rather than merging into it', () => {
    // Shallow is the point: a new annotation is a whole new annotation, not a
    // patch over the marks of the old one.
    const stored = { sailTrim: SAIL_TRIM }
    const redone = { sailTrim: { annotation: { marks: [9] }, overlay: false } }
    expect(mergeAnalysis(stored, redone)?.sailTrim).toEqual(redone.sailTrim)
  })

  it('leaves the column ALONE when the caller sends nothing', () => {
    // `?? null` into a replacing UPDATE is what erased it. An absent field must
    // mean "I have no opinion", never "set it to null".
    for (const nothing of [undefined, null]) {
      expect(mergeAnalysis({ sailTrim: SAIL_TRIM }, nothing)).toBeUndefined()
    }
  })

  it('refuses a non-object rather than overwriting with one', () => {
    for (const junk of ['{}', 42, [1, 2], true]) {
      expect(mergeAnalysis({ sailTrim: SAIL_TRIM }, junk)).toBeUndefined()
    }
  })

  it('works from an empty start — the first write needs no stored blob', () => {
    expect(mergeAnalysis(null, { inst: { tws: 9 } })).toEqual({ inst: { tws: 9 } })
  })
})

describe('what the route must not do to the locator', () => {
  // Same rule the videos route got: bunny_storage_path is where the BYTES are,
  // and a metadata write that does not mention it must not erase it. For a
  // photo it is also the dedupe key, so an update always carries one — this
  // guards the next caller, not today's.
  function locatorFor(body: { bunny_storage_path?: unknown }): Record<string, unknown> {
    const row: Record<string, unknown> = {}
    if (typeof body.bunny_storage_path === 'string' && body.bunny_storage_path) {
      row.bunny_storage_path = body.bunny_storage_path
    }
    return row
  }

  it('writes a real path', () => {
    expect(locatorFor({ bunny_storage_path: 'teams/t/boats/b/sessions/2026-09-28/photos/p1.jpg' }))
      .toEqual({ bunny_storage_path: 'teams/t/boats/b/sessions/2026-09-28/photos/p1.jpg' })
  })

  it('omits the column for anything that is not a real path', () => {
    for (const bad of [undefined, null, '', 0, {}]) {
      expect(locatorFor({ bunny_storage_path: bad })).toEqual({})
    }
  })
})
