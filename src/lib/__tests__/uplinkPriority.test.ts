import { describe, it, expect, beforeEach } from 'vitest'
import { claimUplink, withUplink, awaitUplink, uplinkBusy, resetUplink } from '../uplinkPriority'

// 10 October: a day's movies were uploading and the log sat at 3 %. The log is
// 4 MB that every other device needs before it can show anything; the movies
// are gigabytes people watch one at a time, afterwards.

beforeEach(() => resetUplink())

describe('claiming the uplink', () => {
  it('is free until something claims it', async () => {
    expect(uplinkBusy()).toBe(false)
    // The normal case costs a video queue one already-resolved await.
    await expect(awaitUplink()).resolves.toBeUndefined()
  })

  it('holds the queues until the claim is released', async () => {
    const free = claimUplink()
    expect(uplinkBusy()).toBe(true)
    let resumed = false
    awaitUplink().then(() => { resumed = true })
    await Promise.resolve()
    expect(resumed).toBe(false)
    free()
    await Promise.resolve()
    expect(resumed).toBe(true)
  })

  it('wakes every waiter, not just the first', async () => {
    const free = claimUplink()
    const woken: number[] = []
    for (const i of [1, 2, 3]) awaitUplink().then(() => woken.push(i))
    free()
    await Promise.resolve(); await Promise.resolve()
    expect(woken.sort()).toEqual([1, 2, 3])
  })

  it('needs EVERY claim released — a log and its event file both hold it', async () => {
    const freeLog = claimUplink()
    const freeXml = claimUplink()
    let resumed = false
    awaitUplink().then(() => { resumed = true })
    freeLog()
    await Promise.resolve()
    expect(resumed).toBe(false)
    expect(uplinkBusy()).toBe(true)
    freeXml()
    await Promise.resolve()
    expect(resumed).toBe(true)
  })

  it('ignores a release called twice, rather than freeing somebody else’s claim', async () => {
    const freeA = claimUplink()
    claimUplink()
    freeA(); freeA(); freeA()
    // B still holds it: three calls to A's release must not have freed B.
    expect(uplinkBusy()).toBe(true)
  })
})

describe('withUplink', () => {
  it('releases when the upload succeeds', async () => {
    await withUplink(async () => 'done')
    expect(uplinkBusy()).toBe(false)
  })

  it('releases when the upload THROWS — otherwise the queues stop for ever', async () => {
    await expect(withUplink(async () => { throw new Error('413') })).rejects.toThrow('413')
    expect(uplinkBusy()).toBe(false)
  })

  it('lets the log through first, then the video', async () => {
    // The whole point, as an ordering assertion.
    const order: string[] = []
    const video = (async () => {
      await awaitUplink()
      order.push('video')
    })()
    const log = withUplink(async () => { order.push('log') })
    await Promise.all([log, video])
    expect(order).toEqual(['log', 'video'])
  })
})
