// src/lib/__tests__/uploadFlows.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The two upload flows, asserted against the SOURCE TREE.
//
// WHY THIS EXISTS. Every video-upload bug in this app's history is the same
// bug: a second way to send a clip grew beside the first, wrote different
// columns, and nothing noticed until bytes went missing or went twice.
//
//   • `syncSessionToCloud` uploaded full-resolution clips into
//     `bunny_stream_id`, the column resolveLegacy() tries LAST — 69.7 GB of
//     copies nobody ever played, cleared by migration 0107.
//   • the watch folder called the ORIGINAL uploader, so 154 clips:day rows
//     claimed a full-resolution copy that only ever existed on the SD card,
//     and not one of them carried the proxy the team was waiting for.
//   • `alreadyInCloud` did not count proxies, so the moment the watcher started
//     sending them, Push to Cloud believed a whole racing day was un-uploaded.
//   • four copies of "upload one clip's proxy" drifted apart, and only one of
//     them recorded the upload on this device.
//
// None of that is visible to tsc, eslint or a unit test of any one function: it
// is a property of WHICH FILES CALL WHAT. So the shape gets its own test, in
// the manner of appRoutes.test.ts. A failure here is not necessarily a bug —
// it means a new upload path appeared, and someone has to decide whether it
// belongs. Read src/lib/uploadFlows.ts first; it is the architecture.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(process.cwd(), 'src')
const CODE = /\.(ts|tsx|js|jsx)$/

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      walk(full, acc)
    } else if (CODE.test(name)) acc.push(full)
  }
  return acc
}

const files = walk(SRC).map((f) => ({
  path: relative(SRC, f).split('\\').join('/'),
  text: readFileSync(f, 'utf8'),
}))

/**
 * Files that CALL a symbol. A mention in a comment, an import, or the
 * declaration itself does not count — so the architecture notes that name these
 * flows, and the file that defines one, do not trip the test.
 */
function callersOf(symbol: string): string[] {
  const call = new RegExp(`\\b${symbol}\\s*\\(`)
  const declares = new RegExp(`\\b(function|const|let|var)\\s+${symbol}\\b`)
  return files
    .filter((f) => f.text.split('\n').some((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !declares.test(t) && call.test(t)
    }))
    .map((f) => f.path)
    .sort()
}

describe('the two upload flows', () => {
  it('FLOW A — every proxy upload goes through uploadClipProxy', () => {
    // syncProxyForVideo does the bytes; uploadFlows.ts wraps it with the auth,
    // the cloud row, the blob and the local mark that every caller needs. Call
    // it directly and you get the version of those four that you remembered.
    expect(callersOf('syncProxyForVideo')).toEqual(['lib/uploadFlows.ts'])

    expect(callersOf('uploadClipProxy')).toEqual([
      'components/UploadTab.jsx',              // the watch folder, and Push to Cloud
      'components/ssa/useCloudSync.js',        // the auto-sync / "Sync proxies" queue
      'components/sync/RenditionSyncPanel.jsx',// the per-clip button
    ])
  })

  it('TUS has exactly TWO callers: Flow B, and Flow A\'s resumable fallback', () => {
    // `EnabledResolutions` on the TUS request is the only place Bunny lets an
    // upload choose its own rungs, which is why the archive copy goes this way
    // and the proxy normally arrives by videos/fetch on the library default.
    //
    // The second caller is deliberate and was added after a measurement, not a
    // hunch: Bunny Storage cannot resume a PUT, uploadBlobToStorage restarts
    // from byte zero on each of its three retries, and on field wifi a 23.6 MB
    // proxy therefore failed twice in a row (27 Nov 2026). TUS resumes from the
    // server's offset, so Flow A falls back to it once the PUT has given up.
    //
    // It must stay a FALLBACK. Uploading every proxy both ways would double the
    // uplink on every good connection to help a bad one, and the Storage copy
    // is what makes a clip watchable before any ladder exists. If this list
    // grows a third entry, or the fallback stops being inside a catch, the
    // architecture has changed and uploadFlows.ts needs rewriting with it.
    expect(callersOf('uploadFileToStream')).toEqual([
      'components/ssa/useCloudSync.js',        // Flow B — processOriginalsQueue
      'lib/video-rendition-sync.ts',           // Flow A — resumable fallback only
    ])
    const originals = files.find((f) => f.path === 'components/ssa/useCloudSync.js')!
    expect(originals.text).toContain('resolutions: FULL_LADDER')

    // The proxy fallback asks for the FAST ladder — it is a review copy, and a
    // 1080p rung off a 720p source is wasted encoding.
    const rendition = files.find((f) => f.path === 'lib/video-rendition-sync.ts')!
    expect(rendition.text).toContain('resolutions: FAST_LADDER')
    // …and only after the normal path threw. Positions of the CALLS, not of the
    // identifiers: both names appear in the comment that explains the fallback,
    // so a lastIndexOf search finds the prose and not the code.
    const put = rendition.text.indexOf('uploadBlobToStorage({')
    const call = rendition.text.indexOf('uploadFileToStream(')
    expect(put).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(put)
    expect(rendition.text.slice(put, call)).toContain('} catch')
  })

  it('no TUS upload is left on the tus default chunk size', () => {
    // tus-js-client 3.x defaults `chunkSize` to Infinity — "the entire file
    // will be sent in one request". Flow B never set it, so a day's
    // multi-gigabyte card file went up as ONE PATCH: resumable across
    // attempts, not resumable inside the request that actually matters, and
    // the shape most likely to be killed by a proxy or a sleeping laptop.
    //
    // It is a default, so its absence has no symptom until a big upload on a
    // bad link — which is the one case the whole subsystem exists for. Hence a
    // test: `chunkSize` is passed to tus.Upload, and uploadFileToStream always
    // has a size to pass whether or not the caller named one.
    const bunny = files.find((f) => f.path === 'lib/bunny.js')!
    const tusCall = bunny.text.slice(bunny.text.indexOf('new tus.Upload('))
    expect(tusCall.slice(0, 400)).toMatch(/\bchunkSize\b/)
    expect(bunny.text).toContain('chunkSizeFor(')

    // And both callers hand it the measured link rather than letting the
    // fallback stand in silently.
    for (const path of ['components/ssa/useCloudSync.js', 'lib/video-rendition-sync.ts']) {
      const f = files.find((x) => x.path === path)!
      expect(f.text, `${path} must pass a chunk size or the link it is derived from`)
        .toMatch(/chunkSize:|uplinkBps:/)
    }
  })

  it('both flows take the SAME upload lock, so they cannot halve each other', () => {
    // One uplink, two flows. An archive copy and a proxy running at once on a
    // dock link is the difference between one finishing and neither.
    for (const path of ['components/ssa/useCloudSync.js', 'lib/video-rendition-sync.ts']) {
      const f = files.find((x) => x.path === path)!
      expect(f.text, `${path} must serialise its uploads`).toContain('uploadLock.run(')
    }
  })

  it('nothing in the app writes bunny_stream_id except to FIND an existing row', () => {
    // The legacy column is read-only to the app now. `ensureCloudVideoId` still
    // SENDS it, deliberately — it is how a clip whose local record carries a
    // legacy guid matches its existing cloud row instead of inserting a
    // duplicate — and the admin backfill still writes it, because it is
    // reconstructing rows from historical meta.json. Nowhere else.
    const senders = files
      .filter((f) => /bunny_stream_id\s*:/.test(f.text) || /bunnyStreamId\s*:/.test(f.text))
      .map((f) => f.path)
      .sort()
    expect(senders).toEqual([
      'app/admin/teams/[teamId]/BackfillPanel.tsx',
      'app/api/teams/[teamId]/boats/[boatId]/backfill-from-bunny/route.ts',
      'lib/cloud-videos.ts',                   // ensureCloudVideoId's dedupe key
    ])
  })

  it('the session sync is DATA only — it holds no reference to a Stream upload', () => {
    const bunny = files.find((f) => f.path === 'lib/bunny.js')!
    const body = bunny.text.slice(bunny.text.indexOf('export async function syncSessionDataToCloud'))
    for (const forbidden of ['createStreamUpload', 'uploadFileToStream', 'getVideoBlob', 'onVideoSynced']) {
      expect(body, `syncSessionDataToCloud must not reach for ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('the rendition columns have two writers, and both are deliberate', () => {
    // Both flows record themselves through /api/videos/:id/renditions, which is
    // sparse by construction — it touches only what the caller sent. A third
    // writer is how has_original would come to be true for a file nobody ever
    // uploaded at full resolution.
    //
    // Assigns the column, in either style (`update.x = …` or `{ x: … }`), in a
    // file that also runs an update/insert. Reading one does not count, so the
    // half-dozen routes that SELECT these columns to resolve a URL stay out.
    const assigns = /bunny_(proxy|original)_(path|stream_id)\s*[:=]/
    const writers = files
      .filter((f) => assigns.test(f.text) && /\.update\(|\.insert\(/.test(f.text))
      .map((f) => f.path)
      .sort()
    expect(writers).toEqual([
      // The admin one-off that gave the pre-Stream proxy backlog an adaptive
      // ladder. No caller in the app; curled by hand, idempotent, and only ever
      // fills in a bunny_proxy_stream_id that is null.
      'app/api/teams/[teamId]/boats/[boatId]/backfill-stream/route.ts',
      // Flow A and Flow B both land here.
      'app/api/videos/[videoId]/renditions/route.ts',
    ])
  })
})
