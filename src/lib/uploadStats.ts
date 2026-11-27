// src/lib/uploadStats.ts
// ─────────────────────────────────────────────────────────────────────────────
// What this device has learned about its own uplink and its own encoder.
//
// uploadStrategy.ts does the arithmetic; this remembers the inputs between
// clips, between pushes and between sessions, so the second clip of a day is
// decided on evidence rather than on a default.
//
// IT LIVES IN `ssa-prefs`, NOT `ssa-db`. localStore.js owns the ssa-db schema
// and is the only file allowed to name a version — and a DB_VER bump is paid
// for by every versionless reader in the app, none of which listens for
// `versionchange`, so an upgrade can hang behind them for ever. That cost is
// worth it for a day's data and absurd for a throughput average. See the note
// in CLAUDE.md.
//
// PER ENGINE, because hardware and software encoding differ by 5-20× and an
// average mixing them describes neither. A laptop that normally uses WebCodecs
// and falls back once to ffmpeg.wasm would otherwise carry that one slow sample
// into every later decision.
//
// Every failure here is swallowed. This is an optimisation: with no stats the
// strategy falls back to "transcode", which is what the app did before any of
// this existed, so a broken prefs store costs speed and never correctness.
// ─────────────────────────────────────────────────────────────────────────────

import { getPref, setPref } from './prefsStore'
import { addSample, estimate, usableSample, type Ewma } from './uploadStrategy'

export type Engine = 'webcodecs' | 'ffmpeg'

const UPLINK_KEY = 'uplinkThroughput'
const ENCODE_KEY = (e: Engine) => `encodeThroughput:${e}`
const LAST_ENGINE_KEY = 'lastTranscodeEngine'

// Read-through cache. The decision is made per clip and IndexedDB is async;
// nothing here is worth an await in the middle of a queue.
const cache = new Map<string, Ewma | null>()

async function read(key: string): Promise<Ewma | null> {
  if (cache.has(key)) return cache.get(key) || null
  let v: Ewma | null = null
  try {
    const raw = await getPref(key)
    if (raw && typeof raw === 'object' && Number.isFinite((raw as Ewma).fast)) v = raw as Ewma
  } catch { v = null }
  cache.set(key, v)
  return v
}

async function write(key: string, next: Ewma): Promise<void> {
  cache.set(key, next)
  try { await setPref(key, next) } catch { /* an optimisation, never a failure */ }
}

/**
 * Record a completed transfer.
 *
 * Small or short transfers are dropped (see usableSample): the first thing every
 * push uploads is a few MB of log, which measures handshake rather than
 * bandwidth and would drag the estimate around hard.
 */
export async function recordUpload(bytes: number, seconds: number): Promise<void> {
  if (!usableSample(bytes, seconds)) return
  await write(UPLINK_KEY, addSample(await read(UPLINK_KEY), bytes / seconds))
}

/**
 * Record a completed transcode, in bytes of SOURCE per second — which is the
 * unit the decision needs, since what it predicts is how long THIS source will
 * take to encode.
 */
export async function recordEncode(sourceBytes: number, seconds: number, engine?: Engine | null): Promise<void> {
  if (!engine) return                      // unknown engine teaches nothing useful
  // Remember WHICH engine ran even when the sample itself is too small to
  // learn a rate from — the fallback having happened at all is the fact that
  // matters most for the next prediction.
  try { await setPref(LAST_ENGINE_KEY, engine) } catch { /* optimisation only */ }
  if (!usableSample(sourceBytes, seconds)) return
  await write(ENCODE_KEY(engine), addSample(await read(ENCODE_KEY(engine)), sourceBytes / seconds))
}

export async function uplinkBps(): Promise<number | null> {
  return estimate(await read(UPLINK_KEY))
}

export async function encodeBps(engine: Engine): Promise<number | null> {
  return estimate(await read(ENCODE_KEY(engine)))
}

/**
 * Which engine will actually run — remembered, not merely probed.
 *
 * `generateProxy` tries WebCodecs and falls back to ffmpeg.wasm on ANY throw,
 * so a device whose capability probe says "hardware" can still be encoding in
 * software every time. Predicting with the hardware figure there would be
 * optimistic by 5-20× in the one direction that matters: it would skip the
 * proxy on a link that cannot carry the original.
 *
 * So the engine that ran LAST wins over the probe. The probe only answers for a
 * device that has never transcoded anything.
 */
export async function likelyEngine(probeSaysHardware: boolean): Promise<Engine> {
  try {
    const last = await getPref(LAST_ENGINE_KEY)
    if (last === 'ffmpeg' || last === 'webcodecs') return last
  } catch { /* fall through to the probe */ }
  return probeSaysHardware ? 'webcodecs' : 'ffmpeg'
}

/** Everything the strategy needs, for the engine that WILL run on this device. */
export async function measuredThroughput(engine: Engine): Promise<{
  uplinkBps: number | null
  encodeBps: number | null
}> {
  const [u, e] = await Promise.all([uplinkBps(), encodeBps(engine)])
  return { uplinkBps: u, encodeBps: e }
}

/** What this device has learned, for the readiness check to show. */
export async function measurementSummary(): Promise<{
  uplinkBps: number | null
  hardwareBps: number | null
  softwareBps: number | null
  lastEngine: Engine | null
}> {
  const [u, hw, sw] = await Promise.all([uplinkBps(), encodeBps('webcodecs'), encodeBps('ffmpeg')])
  let lastEngine: Engine | null = null
  try {
    const v = await getPref(LAST_ENGINE_KEY)
    if (v === 'ffmpeg' || v === 'webcodecs') lastEngine = v
  } catch { /* nothing learned */ }
  return { uplinkBps: u, hardwareBps: hw, softwareBps: sw, lastEngine }
}

/** For tests and for a device whose measurements have gone obviously wrong. */
export function forgetCachedStats(): void { cache.clear() }
