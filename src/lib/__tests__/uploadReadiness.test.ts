// What a device needs before a day's footage depends on it.

import { describe, it, expect } from 'vitest'
import { checkDevice, verdict, type Probes } from '../uploadReadiness'

const probes = (over: Partial<Probes> = {}): Probes => ({
  webCodecs: async () => true,
  encoderCdn: async () => true,
  directoryPicker: () => true,
  localStore: async () => true,
  workspace: async () => true,
  ...over,
})
const byId = (cs: Awaited<ReturnType<typeof checkDevice>>, id: string) => cs.find((c) => c.id === id)!

describe('checkDevice', () => {
  it('a Chrome laptop with a boat selected is simply ready', async () => {
    const v = verdict(await checkDevice(probes()))
    expect(v.ready).toBe(true)
    expect(v.warnings).toEqual([])
    expect(v.summary).toBe('Ready to upload')
  })

  it('no hardware encoder is a WARNING while the CDN is reachable', async () => {
    // It works. It is 5-20× slower, which on a phone is a clip against a
    // coffee — worth saying, not worth blocking.
    const checks = await checkDevice(probes({ webCodecs: async () => false }))
    expect(byId(checks, 'encoder').state).toBe('warn')
    expect(verdict(checks).ready).toBe(true)
  })

  it('no encoder AND no CDN is the one that stops everything', async () => {
    const checks = await checkDevice(probes({
      webCodecs: async () => false, encoderCdn: async () => false,
    }))
    expect(byId(checks, 'encoder').state).toBe('fail')
    expect(byId(checks, 'encoder').fix).toMatch(/captive portal|ad blocker|proxy/i)
    expect(verdict(checks).ready).toBe(false)
  })

  it('does not ask the network when the hardware encoder is there', async () => {
    // The probe is a real fetch. A device that needs nothing should pay nothing,
    // and on a captive portal the request can hang rather than fail.
    let asked = 0
    await checkDevice(probes({ encoderCdn: async () => { asked++; return true } }))
    expect(asked).toBe(0)
  })

  it('Safari is a warning, not a failure — Import files does the same job', async () => {
    const checks = await checkDevice(probes({ directoryPicker: () => false }))
    expect(byId(checks, 'watchFolder').state).toBe('warn')
    expect(verdict(checks).ready).toBe(true)
  })

  it('a private window blocks the local store, and that IS fatal', async () => {
    const checks = await checkDevice(probes({ localStore: async () => false }))
    expect(byId(checks, 'localStore').state).toBe('fail')
    expect(verdict(checks).ready).toBe(false)
  })

  it('no boat workspace is fatal, and says who to ask', async () => {
    const checks = await checkDevice(probes({ workspace: async () => false }))
    expect(byId(checks, 'workspace').state).toBe('fail')
    expect(byId(checks, 'workspace').fix).toMatch(/ask whoever set up the team/i)
    expect(verdict(checks).ready).toBe(false)
  })

  it('a probe that THROWS counts as unavailable, never as fine', async () => {
    // An exception from a capability probe is the capability being absent in an
    // unusual way. Treating it as success would pass the device and fail later.
    const checks = await checkDevice(probes({
      webCodecs: async () => { throw new Error('boom') },
      encoderCdn: async () => { throw new Error('boom') },
      localStore: async () => { throw new Error('boom') },
      workspace: async () => { throw new Error('boom') },
    }))
    expect(verdict(checks).blocking.map((c) => c.id).sort())
      .toEqual(['encoder', 'localStore', 'workspace'])
  })

  it('counts the warnings in the summary so none is silently swallowed', async () => {
    const v = verdict(await checkDevice(probes({
      webCodecs: async () => false, directoryPicker: () => false,
    })))
    expect(v.ready).toBe(true)
    expect(v.summary).toBe('Ready to upload — 2 things worth knowing')
  })

  it('every failing check carries a fix — a blocker with no next step is a dead end', async () => {
    const checks = await checkDevice(probes({
      webCodecs: async () => false, encoderCdn: async () => false,
      localStore: async () => false, workspace: async () => false,
      directoryPicker: () => false,
    }))
    for (const c of checks) {
      if (c.state !== 'ok') expect(c.fix, `${c.id} has no fix`).toBeTruthy()
    }
  })
})
