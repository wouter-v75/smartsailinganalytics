import { describe, it, expect } from 'vitest'
import { createPhaseLock } from '../phaseLocks'

const defer = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('createPhaseLock', () => {
  it('runs one at a time — two transcodes must never share the ffmpeg instance', () => {
    const lock = createPhaseLock()
    const a = defer()
    let bStarted = false
    void lock.run(async () => { await a.promise })
    void lock.run(async () => { bStarted = true })
    expect(bStarted).toBe(false)
  })

  it('lets the next one in when the first finishes', async () => {
    const lock = createPhaseLock()
    const order: string[] = []
    const a = defer()
    const p1 = lock.run(async () => { order.push('a-start'); await a.promise; order.push('a-end') })
    const p2 = lock.run(async () => { order.push('b') })
    a.resolve()
    await Promise.all([p1, p2])
    expect(order).toEqual(['a-start', 'a-end', 'b'])
  })

  it('releases even when the body THROWS — one failed clip cannot wedge the queue', async () => {
    const lock = createPhaseLock()
    await expect(lock.run(async () => { throw new Error('encode failed') })).rejects.toThrow('encode failed')
    expect(lock.busy()).toBe(false)
    await expect(lock.run(async () => 'next clip')).resolves.toBe('next clip')
  })

  it('keeps FIFO order, because the caller already chose it', async () => {
    // uploadOrder.ts puts starts first, then roundings, then manoeuvres. A lock
    // that reordered them would quietly undo the thing that decides what the
    // team can watch first.
    const lock = createPhaseLock()
    const seen: number[] = []
    const gate = defer()
    const first = lock.run(async () => { await gate.promise })
    const rest = [1, 2, 3, 4].map((n) => lock.run(async () => { seen.push(n) }))
    gate.resolve()
    await Promise.all([first, ...rest])
    expect(seen).toEqual([1, 2, 3, 4])
  })

  it('says it is QUEUED rather than leaving a bar at zero with no reason', async () => {
    const lock = createPhaseLock()
    const gate = defer()
    let waited = 0
    const first = lock.run(async () => { await gate.promise })
    const second = lock.run(async () => {}, () => { waited++ })
    expect(waited).toBe(1)
    expect(lock.waiting()).toBe(1)
    gate.resolve()
    await Promise.all([first, second])
  })

  it('does NOT call onWait when the lock is free', async () => {
    const lock = createPhaseLock()
    let waited = 0
    await lock.run(async () => {}, () => { waited++ })
    expect(waited).toBe(0)
  })

  it('two locks are independent — an upload may run while a transcode does', async () => {
    const transcode = createPhaseLock()
    const upload = createPhaseLock()
    const gate = defer()
    let uploaded = false
    const t = transcode.run(async () => { await gate.promise })
    await upload.run(async () => { uploaded = true })
    expect(uploaded).toBe(true)   // the point of the whole file
    gate.resolve()
    await t
  })
})
