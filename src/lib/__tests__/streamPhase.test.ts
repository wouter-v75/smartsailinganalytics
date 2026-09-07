import { describe, it, expect } from 'vitest'

// Mirror of the encode-status rules. On 7 Sept five clips sat at Bunny status 2 for
// an hour showing "Processing… 1–3 min typically", indistinguishable from a clip
// that was genuinely encoding — so nobody could tell whether to wait or re-upload.
const PHASE: Record<number, string> = {
  0: 'created', 1: 'uploaded', 2: 'queued', 3: 'encoding', 4: 'ready', 5: 'failed', 6: 'upload failed',
}
const phaseOf = (s: number) => PHASE[s] ?? `unknown (${s})`
const message = (v: { streamFailed?: boolean; streamPct?: number | null; streamPhase?: string | null; streamStalled?: boolean }) =>
  v.streamFailed ? 'Encoding failed'
  : (v.streamPct ?? 0) > 0 ? `Encoding — ${Math.round(v.streamPct!)}%`
  : v.streamPhase === 'queued' ? "Waiting in Bunny's queue"
  : v.streamStalled ? 'Still waiting' : 'Encoding in Stream…'

describe('the crew can tell a queue from a stall', () => {
  it('names the phase instead of leaving it a number', () => {
    expect(phaseOf(2)).toBe('queued')     // what the five stuck clips reported
    expect(phaseOf(3)).toBe('encoding')
    expect(phaseOf(4)).toBe('ready')
    expect(phaseOf(5)).toBe('failed')
  })

  it('distinguishes work in progress from nothing happening', () => {
    // These two looked identical all afternoon and need opposite responses.
    expect(message({ streamPct: 40 })).toBe('Encoding — 40%')
    expect(message({ streamPct: 0, streamPhase: 'queued' })).toBe("Waiting in Bunny's queue")
  })

  it('does not call a clip stalled while it is visibly progressing', () => {
    // A long 4K encode passing the patience budget is slow, not stuck.
    expect(message({ streamPct: 72, streamStalled: true })).toBe('Encoding — 72%')
  })

  it('reports an outright failure as its own thing, not as waiting', () => {
    expect(message({ streamFailed: true, streamPhase: 'failed' })).toBe('Encoding failed')
  })

  it('an unknown status is surfaced, not swallowed', () => {
    expect(phaseOf(9)).toBe('unknown (9)')
  })

  it('zero bytes received is the signature of an upload that never landed', () => {
    // Indistinguishable from "queued" without storageSize, which is why it went
    // undiagnosed for an hour.
    const received = (b: number | null) => b === 0 ? 'upload did not complete' : b == null ? 'unknown' : 'bytes arrived'
    expect(received(0)).toBe('upload did not complete')
    expect(received(321_000_000)).toBe('bytes arrived')
    expect(received(null)).toBe('unknown')
  })
})
