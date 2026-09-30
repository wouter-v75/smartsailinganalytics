import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useFavourites, setFavourite, isFavourite, videoFavId, photoFavId, _resetFavourites } from '../favourites'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'

const respond = (body: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response)

beforeEach(() => {
  _resetFavourites()
  vi.restoreAllMocks()
})

describe('favourite ids', () => {
  it('keys a video on its cloud row — a local clip by cloudId, a cloud clip by its own id', () => {
    expect(videoFavId({ id: 'idb-17', cloudId: U1 })).toBe(U1)
    expect(videoFavId({ id: U2 })).toBe(U2)
    expect(videoFavId({ id: 'idb-17' })).toBeNull()   // local only: nothing to key on
  })

  it('keys a photo only on cloudId', () => {
    expect(photoFavId({ cloudId: U1 })).toBe(U1)
    expect(photoFavId({ cloudId: 'photo-local-3' } as any)).toBeNull()
    expect(photoFavId(null)).toBeNull()
  })
})

describe('the favourites store', () => {
  it('loads once and answers for photos and videos separately', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => respond({ available: true, photo: [U1], video: [U2] }))
    const a = renderHook(() => useFavourites())
    const b = renderHook(() => useFavourites())
    await waitFor(() => expect(a.result.current.loaded).toBe(true))
    expect(f).toHaveBeenCalledTimes(1)
    expect(a.result.current.has('photo', U1)).toBe(true)
    expect(a.result.current.has('video', U1)).toBe(false)   // same id, other kind
    expect(b.result.current.has('video', U2)).toBe(true)
  })

  it('says unavailable before the migration, so the hearts stay hidden', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => respond({ available: false, photo: [], video: [] }))
    const { result } = renderHook(() => useFavourites())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.available).toBe(false)
  })

  it('flips at once, and every subscriber sees it', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => respond({ available: true, photo: [], video: [] }))
      .mockImplementationOnce(() => respond({ ok: true }))
    const { result } = renderHook(() => useFavourites())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    let err: string | null = 'unset'
    await act(async () => { err = await setFavourite('photo', U1, true) })
    expect(err).toBeNull()
    expect(result.current.has('photo', U1)).toBe(true)
    expect(isFavourite('photo', U1)).toBe(true)
  })

  it('puts the heart back when the server refuses, and says why', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => respond({ available: true, photo: [U1], video: [] }))
      .mockImplementationOnce(() => respond({ error: 'No such photo' }, false, 404))
    const { result } = renderHook(() => useFavourites())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    let err: string | null = null
    await act(async () => { err = await setFavourite('photo', U1, false) })
    expect(err).toBe('No such photo')
    expect(result.current.has('photo', U1)).toBe(true)
  })
})
