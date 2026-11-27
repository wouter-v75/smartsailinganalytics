// src/lib/uploadReadiness.ts
// ─────────────────────────────────────────────────────────────────────────────
// CAN THIS DEVICE UPLOAD A DAY'S CLIPS? Asked on the dock, not on the water.
//
// Nothing is installed for any of this, which is the point and the problem.
// The transcode runs in the browser — WebCodecs first (the device's own
// hardware H.264 encoder, nothing to fetch), ffmpeg.wasm second (downloaded at
// RUNTIME from unpkg.com). So "is the encoder set up" is really "does this
// browser have WebCodecs, and if not, can it reach a CDN", and both answers can
// be no on exactly the wifi where someone first tries: a captive portal, an ad
// blocker, a corporate proxy.
//
// Nor is there a folder structure to create. `~/clips` is the CUTTING outbox on
// the machine that runs clips:day; everyone else picks a folder once and the
// app remembers it. A new user who imports files needs no folder at all.
//
// WHAT MAKES THIS WORTH HAVING: every one of these failures is already reported
// clearly — by the step that hits it, minutes in, with a day's footage queued.
// The cost is not the error, it is finding out then. The checks are cheap and
// read-only, so they can be run before anything is at stake.
//
// Pure: every probe is injected, so the decisions are testable without a
// browser, a network or an account.
// ─────────────────────────────────────────────────────────────────────────────

export type CheckState = 'ok' | 'warn' | 'fail'

export interface Check {
  id: 'encoder' | 'watchFolder' | 'localStore' | 'workspace'
  label: string
  state: CheckState
  detail: string
  /** What the person should do. Absent when there is nothing to do. */
  fix?: string
}

export interface Probes {
  /** Does this browser have a working hardware H.264 encoder? */
  webCodecs: () => Promise<boolean>
  /** Can the ffmpeg.wasm core be fetched? Only asked when WebCodecs is absent. */
  encoderCdn: () => Promise<boolean>
  /** showDirectoryPicker — Chromium only. */
  directoryPicker: () => boolean
  /** Can IndexedDB be opened? False in a locked-down private window. */
  localStore: () => Promise<boolean>
  /** Is there an active boat workspace to file clips under? */
  workspace: () => Promise<boolean>
}

export async function checkDevice(p: Probes): Promise<Check[]> {
  const out: Check[] = []

  // ── the encoder ───────────────────────────────────────────────────────────
  // Two engines, and only the ABSENCE OF BOTH is fatal. WebCodecs alone is the
  // happy case and needs no network at all; the CDN alone works but is 5-20×
  // slower, which on a phone is the difference between a clip and a coffee.
  const hw = await p.webCodecs().catch(() => false)
  if (hw) {
    out.push({
      id: 'encoder', label: 'Video encoder', state: 'ok',
      detail: 'hardware encoder in this browser — nothing to download',
    })
  } else {
    const cdn = await p.encoderCdn().catch(() => false)
    out.push(cdn
      ? {
          id: 'encoder', label: 'Video encoder', state: 'warn',
          detail: 'no hardware encoder; the software one can be downloaded',
          fix: 'It will work, but encoding is 5-20× slower here. Chrome or Edge on this device would use the hardware encoder.',
        }
      : {
          id: 'encoder', label: 'Video encoder', state: 'fail',
          detail: 'no hardware encoder, and the software one cannot be downloaded',
          fix: 'The encoder is fetched from unpkg.com the first time it is needed. A captive portal, an ad blocker or a company proxy will stop it. Open a page in this browser to confirm the wifi is really connected, then try again — or do this upload on a different network once, after which it is cached.',
        })
  }

  // ── the watch folder ──────────────────────────────────────────────────────
  // A convenience, never a requirement: Import files does the same job.
  out.push(p.directoryPicker()
    ? { id: 'watchFolder', label: 'Watch a folder', state: 'ok', detail: 'this browser can watch a folder for new clips' }
    : {
        id: 'watchFolder', label: 'Watch a folder', state: 'warn',
        detail: 'this browser has no folder picker',
        fix: 'Safari cannot watch a folder. Import files works exactly the same way, one step more. Chrome, Edge or Vivaldi can watch.',
      })

  // ── local storage ─────────────────────────────────────────────────────────
  const idb = await p.localStore().catch(() => false)
  out.push(idb
    ? { id: 'localStore', label: 'Local store', state: 'ok', detail: 'clips can be held on this device while they upload' }
    : {
        id: 'localStore', label: 'Local store', state: 'fail',
        detail: 'IndexedDB is not available',
        fix: 'A private/incognito window blocks it, and so does blocking site data. Use an ordinary window.',
      })

  // ── somewhere to file them ────────────────────────────────────────────────
  const ws = await p.workspace().catch(() => false)
  out.push(ws
    ? { id: 'workspace', label: 'Boat workspace', state: 'ok', detail: 'clips have a boat and a team to belong to' }
    : {
        id: 'workspace', label: 'Boat workspace', state: 'fail',
        detail: 'no active boat workspace',
        fix: 'Pick a boat at the top of the page. If none is offered, your account has not been added to one yet — ask whoever set up the team.',
      })

  return out
}

export interface Verdict {
  /** Nothing blocking: this device can take a day's clips to the cloud. */
  ready: boolean
  blocking: Check[]
  warnings: Check[]
  /** One line, for a log or a toast. */
  summary: string
}

export function verdict(checks: readonly Check[]): Verdict {
  const blocking = checks.filter((c) => c.state === 'fail')
  const warnings = checks.filter((c) => c.state === 'warn')
  const ready = blocking.length === 0
  const summary = ready
    ? warnings.length
      ? `Ready to upload — ${warnings.length} thing${warnings.length === 1 ? '' : 's'} worth knowing`
      : 'Ready to upload'
    : `NOT ready — ${blocking.length} problem${blocking.length === 1 ? '' : 's'} to fix first`
  return { ready, blocking, warnings, summary }
}

// ── the real probes ─────────────────────────────────────────────────────────
// Kept apart from the decisions above so the decisions stay testable. Each one
// answers false rather than throwing: an exception from a capability probe is
// the capability being absent in an unusual way, and checkDevice treats it as
// absent either way.

/** Is the ffmpeg.wasm core fetchable? Only worth asking with no hardware encoder. */
export async function probeEncoderCdn(
  url = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
  timeoutMs = 6000
): Promise<boolean> {
  // A captive portal does not refuse the request, it HANGS or answers with a
  // login page — so a timeout is part of the test, not a safety net. `no-cors`
  // because unpkg sends no CORS headers for a plain GET from another origin:
  // the response is opaque, and all we can learn is whether it arrived at all,
  // which is exactly the question.
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      return true
    } finally { clearTimeout(t) }
  } catch { return false }
}

/** Can IndexedDB be opened at all? False in a locked-down private window. */
export function probeLocalStore(dbName = 'ssa-db'): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(false); return }
      // Versionless, like every reader outside localStore.js — naming a version
      // here would fight the schema owner and could block an upgrade.
      const req = indexedDB.open(dbName)
      req.onsuccess = () => { try { req.result.close() } catch { /* already gone */ } resolve(true) }
      req.onerror = () => resolve(false)
      req.onblocked = () => resolve(false)
      // A private window can leave the request pending for ever rather than
      // erroring, so do not wait on it indefinitely.
      setTimeout(() => resolve(false), 3000)
    } catch { resolve(false) }
  })
}
