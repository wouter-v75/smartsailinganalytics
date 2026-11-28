// How big a TUS chunk is, from the measured link.
//
// The numbers here are the real links this has run on: Kent field wifi at
// ~1.5 Mbit, the London flat at 39.5 Mbit measured on 28 Nov, and a card file
// of a few gigabytes.

import { describe, it, expect } from 'vitest'
import {
  chunkSizeFor, describeChunking,
  MIN_CHUNK_BYTES, MAX_CHUNK_BYTES, CHUNK_ALIGN, TARGET_CHUNK_SECONDS,
} from '../uploadChunk'

const MiB = 1024 * 1024
const GB = 1000 * 1000 * 1000
const mbit = (m: number) => (m * 1e6) / 8

describe('chunkSizeFor', () => {
  it('aims for a few seconds of data on a measured link', () => {
    // 39.5 Mbit/s — the London flat, as Check this device reported it.
    const c = chunkSizeFor({ fileBytes: 2 * GB, uplinkBps: mbit(39.5) })
    expect(c / mbit(39.5)).toBeGreaterThan(TARGET_CHUNK_SECONDS - 1)
    expect(c / mbit(39.5)).toBeLessThan(TARGET_CHUNK_SECONDS + 1)
    // Lands near Mux's 30 MB default, which is the reassuring part — the rule
    // was derived from "a few seconds", not reverse-engineered from the number.
    expect(c).toBeGreaterThan(20 * MiB)
    expect(c).toBeLessThan(30 * MiB)
  })

  it('takes the FLOOR when nothing has been measured, not an optimistic guess', () => {
    // An unmeasured link is more likely to be bad than good: the laptop on a
    // boat is the case this subsystem exists for. A big first chunk on dock
    // wifi is the one mistake that cannot be recovered from cheaply.
    expect(chunkSizeFor({ fileBytes: 2 * GB })).toBe(MIN_CHUNK_BYTES)
    expect(chunkSizeFor({ fileBytes: 2 * GB, uplinkBps: null })).toBe(MIN_CHUNK_BYTES)
    expect(chunkSizeFor({ fileBytes: 2 * GB, uplinkBps: 0 })).toBe(MIN_CHUNK_BYTES)
  })

  it('does not go below the floor on a terrible link', () => {
    // Kent field wifi, where a 23.6 MB PUT died twice. Five seconds of it is
    // under a megabyte, and a sub-megabyte chunk makes the upload
    // latency-bound — a round trip per chunk, on the link least able to afford
    // round trips.
    const c = chunkSizeFor({ fileBytes: 2 * GB, uplinkBps: mbit(1.5) })
    expect(c).toBe(MIN_CHUNK_BYTES)
  })

  it('does not go above the ceiling on a datacentre link', () => {
    // At a gigabit the target is 625 MB, which is past Cloudflare's own refusal
    // point and buys nothing: the only thing a bigger chunk changes is how much
    // a drop costs.
    expect(chunkSizeFor({ fileBytes: 20 * GB, uplinkBps: mbit(1000) })).toBe(MAX_CHUNK_BYTES)
  })

  it('aligns to 256 KiB', () => {
    for (const m of [3, 8, 17, 39.5, 120, 400]) {
      const c = chunkSizeFor({ fileBytes: 10 * GB, uplinkBps: mbit(m) })
      expect(c % CHUNK_ALIGN, `${m} Mbit/s gave ${c}`).toBe(0)
    }
  })

  it('never asks for a chunk bigger than the file', () => {
    // Otherwise the progress bar is one step, and the whole point of chunking
    // — a drop costing one chunk — is lost on exactly the small clips that go
    // up most often.
    const c = chunkSizeFor({ fileBytes: 3 * MiB, uplinkBps: mbit(100) })
    expect(c).toBe(3 * MiB)
  })

  it('never returns zero, whatever it is handed', () => {
    // A chunkSize of 0 would be an infinite loop in the TUS client.
    for (const fileBytes of [0, 1, 1024]) {
      expect(chunkSizeFor({ fileBytes, uplinkBps: mbit(39.5) })).toBeGreaterThan(0)
    }
  })

  it('rises with the link, monotonically', () => {
    let last = 0
    for (const m of [1, 5, 20, 50, 100, 300]) {
      const c = chunkSizeFor({ fileBytes: 20 * GB, uplinkBps: mbit(m) })
      expect(c).toBeGreaterThanOrEqual(last)
      last = c
    }
  })
})

describe('describeChunking', () => {
  it('says how long a chunk takes when that is known', () => {
    const c = chunkSizeFor({ fileBytes: 2 * GB, uplinkBps: mbit(39.5) })
    expect(describeChunking(c, mbit(39.5))).toMatch(/MiB chunks, ~\ds each/)
  })

  it('says the link is unmeasured rather than implying a time', () => {
    expect(describeChunking(MIN_CHUNK_BYTES, null)).toContain('not measured yet')
  })
})
