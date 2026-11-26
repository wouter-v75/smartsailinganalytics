// src/lib/bunny.js
// ─────────────────────────────────────────────────────────────────────────────
// SmartSailingAnalytics — Bunny.net Storage + Stream integration
//
// Every WRITE goes browser → Bunny directly, bypassing Vercel: a day's log is
// multi-MB and a clip is hundreds, both well past Vercel's ~4.5 MB request cap.
// READS come back through a Vercel proxy on the read-only key, so the key the
// browser holds can create but never delete.
//
// What this file is:
//   • the session's JSON — log, events, meta, manifest — PUT to Bunny Storage
//   • the Bunny Stream primitives: create a video object, TUS a file into it,
//     delete one
//   • `alreadyInCloud`, the question every upload path asks first
//
// What this file is NOT: the upload architecture. Which clip goes where, and by
// which of the two flows, lives in src/lib/uploadFlows.ts. `syncSessionDataToCloud`
// below handles DATA only and has not moved a video byte since Nov 2026.
// ─────────────────────────────────────────────────────────────────────────────

import { markCloudSynced } from "./localStore";
import { uploadIsGone } from './tusUploadError';
import { hashLogPayload, hashXmlPayload } from "./contentHash";
import { readSyncManifest, updateSyncManifest } from "./syncManifest";
import { readCandidates, writeKey, SESSION_LEAVES, photoLeaves } from "./storageKeys";

// ── Cached storage write credentials ─────────────────────────────────────────
let _storageCreds = null;
async function getStorageCreds() {
  if (_storageCreds) return _storageCreds;
  const res = await fetch("/api/storage/credentials");
  if (!res.ok) throw new Error("Could not fetch storage credentials");
  _storageCreds = await res.json();
  return _storageCreds;
}

// ── Upload JSON directly from browser to Bunny Storage ───────────────────────
export async function uploadJsonToStorage(key, data) {
  try {
    const { accessKey, zone, host } = await getStorageCreds();
    const safeKey = key.replace(/\.\./g, "").replace(/^\/+/, "");
    const res = await fetch(`${host}/${zone}/${safeKey}`, {
      method:  "PUT",
      headers: { AccessKey: accessKey, "Content-Type": "application/json" },
      body:    JSON.stringify(data),
    });
    return res.ok || res.status === 201;
  } catch (e) {
    console.error("uploadJsonToStorage error:", e);
    return false;
  }
}

// ── Fetch JSON from Bunny Storage (via Vercel proxy) ─────────────────────────
export async function fetchFromStorage(key) {
  try {
    const res = await fetch(`/api/bunny/storage?key=${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ── Scope-aware session files ────────────────────────────────────────────────
// A session's JSON now lives under teams/<team>/boats/<boat>/sessions/<date>/.
// See src/lib/storageKeys.ts for why, and for why nothing in the zone had to move:
// reads fall back to the old flat `sessions/<date>/` key, so every session
// uploaded before this keeps loading exactly where it is.

/** Read a session file, scoped key first and the pre-migration key second. */
export async function fetchSessionFile(scope, date, leaf) {
  for (const key of readCandidates(scope, date, leaf)) {
    const found = await fetchFromStorage(key);
    if (found != null) return found;
  }
  return null;
}

/** Write a session file under the scoped key (legacy only if we have no scope). */
export async function uploadSessionFile(scope, date, leaf, data) {
  const key = writeKey(scope, date, leaf);
  if (!key) return false;
  return uploadJsonToStorage(key, data);
}

// ── Cloud status check ────────────────────────────────────────────────────────
export async function checkCloudStatus() {
  try {
    const res = await fetch("/api/cloud/status", { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { available: false, reason: `HTTP ${res.status}` };
    return res.json();
  } catch (e) { return { available: false, reason: String(e) }; }
}

// ── List all cloud sessions ───────────────────────────────────────────────────
export async function listR2Sessions() {
  try {
    const res = await fetch("/api/bunny/sessions");
    if (!res.ok) return [];
    return res.json();
  } catch { return []; }
}

// ── Create a Bunny Stream video object ────────────────────────────────────────
export async function createStreamUpload(fileName, fileSizeBytes) {
  try {
    const res = await fetch("/api/stream/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, fileSizeBytes }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ── Load tus-js-client from CDN ───────────────────────────────────────────────
function loadTus() {
  return new Promise((resolve, reject) => {
    if (window.tus) { resolve(window.tus); return; }
    const s = document.createElement("script");
    s.src = "https://unpkg.com/tus-js-client@3.1.0/dist/tus.min.js";
    s.onload = () => resolve(window.tus);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// Drop tus-js-client's resume record for an upload Bunny no longer has.
//
// Two ways, because the first uses the documented API and the second does not
// depend on it: tus 3.x keys its localStorage entries `tus::<fingerprint>` and
// stores the uploadUrl inside, so a dead URL can be matched directly. Both are
// best-effort — failing to tidy up must never fail the clip.
async function forgetTusUpload(tus, upload) {
  try {
    const store = tus?.defaultOptions?.urlStorage;
    if (store?.removeUpload) {
      for (const prev of await upload.findPreviousUploads()) {
        try { await store.removeUpload(prev.urlStorageKey); } catch { /* next */ }
      }
    }
  } catch { /* fall through to the sweep */ }
  try {
    const dead = upload?.url;
    if (!dead || typeof window === 'undefined') return;
    for (const k of Object.keys(window.localStorage)) {
      if (!k.startsWith('tus::')) continue;
      try {
        if (JSON.parse(window.localStorage.getItem(k))?.uploadUrl === dead) {
          window.localStorage.removeItem(k);
        }
      } catch { /* not ours to read */ }
    }
  } catch { /* localStorage unavailable — nothing to clear */ }
}

// ── Upload video directly from browser to Bunny Stream via tus-js-client ──────
// The encoding ladder, per upload. Bunny bills Premium encoding per MINUTE PER
// RUNG and `status: 4` — which the player waits for — only arrives when EVERY
// enabled rung has finished. So asking for five rungs makes the team wait for a
// 1080p encode in order to watch 720p.
//
// These are the two documented places to set it per video (checked against
// Bunny's API reference, Nov 2026):
//
//   • the TUS `EnabledResolutions` / `JitEnabled` headers — used here;
//   • the PUT upload's `enabledResolutions` / `jitEnabled` query string.
//
// NOT on video CREATE: `CreateVideoModel` is `additionalProperties: false` and
// documents only title/collectionId/thumbnailTime. /api/stream/create used to
// send `enabledResolutions` in the create body with a comment claiming it set
// the full ladder; the field was dropped on the floor and every ladder this app
// ever got from that path came from the library default. It is gone from the
// route. The header below is the one that is documented to work.
//
// And NOT on `videos/fetch` at all: its body takes url/headers/title and
// nothing else, so a video brought in storage-first inherits the LIBRARY
// default. That is why the fast path's ladder is a library setting and the
// evening full-res upload, which comes through TUS, carries its own.
// The rungs the TEAM watches. Nothing in this codebase can ask for them: the
// proxy reaches Stream through videos/fetch, which takes no encoding options, so
// these are the LIBRARY default and must be set in Stream -> library ->
// Encoding. This constant is the written-down form of that dashboard setting —
// the one place to look when wondering what the library is supposed to be.
export const FAST_LADDER = '360p,720p'
export const FULL_LADDER = '240p,360p,480p,720p,1080p'        // the archive copy

/**
 * @param {{streamId: string}} uploadInfo
 * @param {File|Blob} file
 * @param {(pct: number) => void} [onProgress]
 * @param {{resolutions?: string, jit?: boolean}} [opts]
 *   resolutions — comma-separated rungs; omit to inherit the library default.
 *   jit         — Just-in-Time encoding. Premium only, and Bunny warn it "is
 *                 only supported by the Bunny player", so it is off unless
 *                 asked for explicitly and is worth testing against the app's
 *                 own hls.js player before being relied on.
 */
export async function uploadFileToStream(uploadInfo, file, onProgress, opts = {}) {
  const { streamId } = uploadInfo;
  const credRes = await fetch("/api/stream/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ streamId, fileSize: file.size }),
  });
  if (!credRes.ok) {
    console.error("Failed to get stream credentials:", await credRes.json());
    return { ok: false, gone: false };
  }
  const { signature, expiry, libraryId } = await credRes.json();
  const tus = await loadTus();
  return new Promise((resolve) => {
    const upload = new tus.Upload(file, {
      endpoint: "https://video.bunnycdn.com/tusupload",
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        AuthorizationSignature: signature,
        AuthorizationExpire:    expiry,
        VideoId:                streamId,
        LibraryId:              libraryId,
        // Bunny reads the encoding headers from the request that COMPLETES the
        // upload, so tus-js-client sending them on every PATCH is correct.
        // Unknown resolution values are ignored by Bunny rather than refused.
        ...(opts.resolutions ? { EnabledResolutions: opts.resolutions } : {}),
        ...(opts.jit ? { JitEnabled: 'true' } : {}),
      },
      metadata: { filetype: file.type, title: file.name },
      onProgress(bytesUploaded, bytesTotal) {
        onProgress?.(Math.round((bytesUploaded / bytesTotal) * 100));
      },
      onSuccess() { resolve({ ok: true, gone: false }); },
      async onError(err) {
        // An EXPIRED upload is not a failed one. Bunny holds a TUS upload until
        // its AuthorizationExpire — 24 h, set in /api/stream/upload — and then
        // answers 404 for ever; re-signing does not extend it. (It also expires
        // after ~48 h idle regardless.) Resuming it again is the
        // one thing guaranteed never to work, so say which kind of failure this
        // was and let the caller forget the video guid.
        const gone = uploadIsGone(err);
        console.error(gone ? "tus upload is gone (expired):" : "tus upload error:", err);
        // The resume record is keyed on the FILE, not the video, so clearing
        // our own guid is not enough: findPreviousUploads would hand the next
        // attempt the same dead URL against a brand-new video object.
        if (gone) await forgetTusUpload(tus, upload);
        resolve({ ok: false, gone });
      },
    });
    upload.findPreviousUploads().then(previous => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    });
  });
}

// Does this clip already have bytes in the cloud, by any upload path? Four
// ways it can:
//
//   cloudSynced + streamId          a legacy direct-to-Stream upload, from
//                                   before the two flows (see uploadFlows.ts)
//   originalUploadedAt / hasOriginal  the evening archive copy
//   proxyUploadedAt / hasProxy        the copy the TEAM watches
//
// The proxy pair was missing, and the watch folder walked straight into the gap
// the moment it started sending proxies instead of originals: a day of racing
// is ~150 clips the team can already watch, every one of which the caller would
// have re-sent in full down a third path into `bunny_stream_id` — the column
// resolveLegacy() reaches only when there is no proxy AND no original, i.e.
// never for these. That is exactly the 69.7 GB of unplayed duplicates
// migration 0107 was written to clear.
//
// So the question it answers is "is the clip up", not "is the ORIGINAL up". A
// clip with only a proxy is missing its archive copy, and that is the Upload
// originals button's job — a separate, deliberate action.
export function alreadyInCloud(video) {
  if (!video) return false;
  return Boolean(
    (video.cloudSynced && video.streamId) ||
    video.originalUploadedAt || video.hasOriginal ||
    video.proxyUploadedAt || video.hasProxy
  );
}

// ── Session DATA sync ────────────────────────────────────────────────────────
// Log rows, event XML and the session meta — to Bunny Storage, direct from the
// browser. NO VIDEO BYTES: `videosForMeta` is listed in meta.json and never
// uploaded. Clips go through the two flows in src/lib/uploadFlows.ts.
//
// It used to upload them, as a third flow: create a Stream video, TUS the full
// file with no ladder, record the guid in `bunny_stream_id`. That column is the
// one `resolveLegacy()` reaches last and migration 0107 had to clear 69.7 GB
// out of, so the flow's whole output was a duplicate nobody watched.
export async function syncSessionDataToCloud(date, logData, xmlData, videosForMeta, onStatus, opts = {}) {
  const status = msg => onStatus?.(msg);
  // Whose session this is. Without it the keys fall back to the flat
  // pre-migration layout — which is what a user with no active membership
  // always had. See src/lib/storageKeys.ts.
  const scope = opts.scope || null;
  const result = { success: false };
  try {
    // Read the session manifest once (a few hundred bytes) so we can skip
    // re-uploading log/xml that is already in the cloud unchanged. This replaces
    // the old "upload whenever rows exist" behaviour that re-sent multi-MB logs
    // every session. See docs/sync-caching-architecture-research.md.
    let manifest = null;
    try { manifest = await readSyncManifest(date, scope); } catch {}
    const manifestPatch = {};
    let syncedLogHash, syncedXmlHash;

    // 1. Log rows → Bunny Storage (direct, no Vercel size limit)
    if (logData?.rows?.length) {
      const logHash = hashLogPayload(logData);
      if (manifest?.log?.hash && manifest.log.hash === logHash) {
        status(`↩ Log already in cloud (unchanged) — skipping upload`);
        syncedLogHash = logHash;
      } else {
        const approxMB = (JSON.stringify(logData.rows).length / 1e6).toFixed(1);
        status(`Uploading log data to Bunny Storage (${logData.rows.length.toLocaleString()} rows · ~${approxMB} MB)…`);
        const ok = await uploadSessionFile(scope, date, SESSION_LEAVES.log, {
          rows: logData.rows, startUtc: logData.startUtc,
          endUtc: logData.endUtc, uploadedAt: Date.now(),
        });
        if (!ok) status("⚠ Log upload failed — continuing…");
        else {
          status("✓ Log data uploaded to Bunny Storage");
          syncedLogHash = logHash;
          manifestPatch.log = { hash: logHash, rows: logData.rows.length, uploadedAt: Date.now() };
        }
      }
    }

    // 2. XML events → Bunny Storage (direct)
    if (xmlData) {
      const xmlHash = hashXmlPayload(xmlData);
      if (manifest?.xml?.hash && manifest.xml.hash === xmlHash) {
        status(`↩ Events already in cloud (unchanged) — skipping upload`);
        syncedXmlHash = xmlHash;
      } else {
        status("Uploading event data to Bunny Storage…");
        const ok = await uploadSessionFile(scope, date, SESSION_LEAVES.events, {
          ...xmlData, uploadedAt: Date.now(),
        });
        if (!ok) status("⚠ Events upload failed — continuing…");
        else {
          status("✓ Event data uploaded to Bunny Storage");
          syncedXmlHash = xmlHash;
          manifestPatch.xml = { hash: xmlHash, uploadedAt: Date.now() };
        }
      }
    }

    // 3. Session meta → Bunny Storage (direct)
    // Include ALL enriched fields so other devices can display full metadata
    // without needing to re-derive from log/xml.
    const meta = {
      date, boat: xmlData?.meta?.boat || null, location: xmlData?.meta?.location || null,
      hasLog: !!logData, hasXml: !!xmlData, videoCount: videosForMeta.length,
      videos: videosForMeta.map(v => ({
        id: v.id, name: v.name, size: v.size, duration: v.duration,
        camera: v.camera, title: v.title, tags: v.tags,
        streamId: v.originalStreamId || v.proxyStreamId || v.streamId || null,
        startUtc: v.startUtc || null, tsSource: v.tsSource || null,
        // Enriched instrument averages
        twsAvg: v.twsAvg ?? null, twaAvg: v.twaAvg ?? null,
        vmgAvg: v.vmgAvg ?? null, bspAvg: v.bspAvg ?? null,
        sogAvg: v.sogAvg ?? null, sogMax: v.sogMax ?? null,
        twsMax: v.twsMax ?? null, heelAvg: v.heelAvg ?? null,
        polpercAvg: v.polpercAvg ?? null, vsTargPercAvg: v.vsTargPercAvg ?? null,
        sessionDate: v.sessionDate || date,
      })),
      syncedAt: Date.now(),
    };
    await uploadSessionFile(scope, date, SESSION_LEAVES.meta, meta);

    // Record what's now in the cloud: update the session manifest with any
    // newly-uploaded log/xml hashes (optimistic on the copy we read), and
    // persist the same fingerprints locally so a future sync of unchanged data
    // skips the transfer entirely.
    if (Object.keys(manifestPatch).length) {
      try { await updateSyncManifest(date, manifestPatch, manifest, scope); } catch {}
    }
    try { await markCloudSynced(date, { logHash: syncedLogHash, xmlHash: syncedXmlHash }); } catch {}

    result.success = true;
    status(`✓ Session ${date} data synced to Bunny Storage`);
    return result;
  } catch (err) {
    status(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
}

// ── Update cloud metadata after re-enrichment ────────────────────────────────
// Called when log/event files are uploaded after videos were already synced.
// Updates meta.json with enriched video data + optionally uploads new log/events.
export async function updateCloudSessionMetadata(date, { videos, logData, xmlData, photos, scope = null } = {}) {
  try {
    // 1. Read existing meta.json from cloud
    const existing = await fetchSessionFile(scope, date, SESSION_LEAVES.meta);
    if (!existing) return false; // session not yet in cloud — nothing to update

    // 2. Upload log/events if provided AND actually changed vs the cloud
    //    manifest (content-hash guard — don't re-send unchanged data).
    let manifest = null;
    try { manifest = await readSyncManifest(date, scope); } catch {}
    const manifestPatch = {};
    let syncedLogHash, syncedXmlHash;
    const uploads = [];
    if (logData?.rows?.length) {
      const logHash = hashLogPayload(logData);
      if (manifest?.log?.hash === logHash) {
        syncedLogHash = logHash;
      } else {
        uploads.push(uploadSessionFile(scope, date, SESSION_LEAVES.log, {
          rows: logData.rows, startUtc: logData.startUtc,
          endUtc: logData.endUtc, uploadedAt: Date.now(),
        }));
        syncedLogHash = logHash;
        manifestPatch.log = { hash: logHash, rows: logData.rows.length, uploadedAt: Date.now() };
      }
    }
    if (xmlData && !xmlData.source) {  // skip cloud-sourced xml (already there)
      const xmlHash = hashXmlPayload(xmlData);
      if (manifest?.xml?.hash === xmlHash) {
        syncedXmlHash = xmlHash;
      } else {
        uploads.push(uploadSessionFile(scope, date, SESSION_LEAVES.events, {
          ...xmlData, uploadedAt: Date.now(),
        }));
        syncedXmlHash = xmlHash;
        manifestPatch.xml = { hash: xmlHash, uploadedAt: Date.now() };
      }
    }

    // 3. Merge enriched video data into existing meta
    if (videos?.length) {
      const byId = new Map((existing.videos || []).map(v => [v.id, v]));
      for (const v of videos) {
        const prev = byId.get(v.id) || {};
        byId.set(v.id, {
          ...prev,
          id: v.id, name: v.name || prev.name, size: v.size || prev.size,
          duration: v.duration || prev.duration,
          camera: v.camera || prev.camera, title: v.title || prev.title,
          tags: v.tags || prev.tags,
          streamId: v.streamId || prev.streamId || null,
          startUtc: v.startUtc || prev.startUtc || null,
          tsSource: v.tsSource || prev.tsSource || null,
          twsAvg: v.twsAvg ?? prev.twsAvg ?? null,
          twaAvg: v.twaAvg ?? prev.twaAvg ?? null,
          vmgAvg: v.vmgAvg ?? prev.vmgAvg ?? null,
          bspAvg: v.bspAvg ?? prev.bspAvg ?? null,
          sogAvg: v.sogAvg ?? prev.sogAvg ?? null,
          sogMax: v.sogMax ?? prev.sogMax ?? null,
          twsMax: v.twsMax ?? prev.twsMax ?? null,
          heelAvg: v.heelAvg ?? prev.heelAvg ?? null,
          polpercAvg: v.polpercAvg ?? prev.polpercAvg ?? null,
          vsTargPercAvg: v.vsTargPercAvg ?? prev.vsTargPercAvg ?? null,
          sessionDate: v.sessionDate || prev.sessionDate || date,
        });
      }
      existing.videos = Array.from(byId.values());
      existing.videoCount = existing.videos.length;
    }

    // Update session-level flags
    existing.hasLog = existing.hasLog || !!(logData?.rows?.length);
    existing.hasXml = existing.hasXml || !!xmlData;
    if (xmlData?.meta?.boat)     existing.boat     = xmlData.meta.boat;
    if (xmlData?.meta?.location) existing.location  = xmlData.meta.location;
    existing.enrichedAt = Date.now();

    // 4. Upload updated meta.json + any log/event uploads in parallel
    uploads.push(uploadSessionFile(scope, date, SESSION_LEAVES.meta, existing));

    // 5. Update per-photo metadata if photos provided
    if (photos?.length) {
      const photoIndex = { updatedAt: Date.now(), photos: [] };
      for (const p of photos) {
        const metaObj = { ...p };
        delete metaObj.objectUrl;  // don't store blob URLs in cloud
        photoIndex.photos.push(metaObj);
        uploads.push(uploadSessionFile(
          scope, date, photoLeaves(p.id).meta, metaObj
        ));
      }
      uploads.push(uploadSessionFile(scope, date, SESSION_LEAVES.photoIndex, photoIndex));
    }

    await Promise.all(uploads);

    // Record the newly-uploaded log/xml in the manifest + locally so we don't
    // re-send them next time.
    if (Object.keys(manifestPatch).length) {
      try { await updateSyncManifest(date, manifestPatch, manifest, scope); } catch {}
    }
    if (syncedLogHash || syncedXmlHash) {
      try { await markCloudSynced(date, { logHash: syncedLogHash, xmlHash: syncedXmlHash }); } catch {}
    }
    return true;
  } catch (err) {
    console.error("[SSA:cloud] updateCloudSessionMetadata error:", err);
    return false;
  }
}

// ── Fetch a session from cloud ────────────────────────────────────────────────
export async function fetchCloudSession(date, scope = null) {
  const [meta, logData, xmlData] = await Promise.all([
    fetchSessionFile(scope, date, SESSION_LEAVES.meta),
    fetchSessionFile(scope, date, SESSION_LEAVES.log),
    fetchSessionFile(scope, date, SESSION_LEAVES.events),
  ]);
  if (!meta) return null;
  const videos = await Promise.all((meta.videos || []).map(async v => {
    let playbackUrl = null, thumbnailUrl = null;
    if (v.streamId) {
      try {
        const res = await fetch(`/api/stream/status/${v.streamId}`);
        if (res.ok) {
          const s = await res.json();
          playbackUrl  = s.playbackUrl  || null;
          thumbnailUrl = s.thumbnailUrl || null;
        }
      } catch {}
    }
    return {
      ...v, objectUrl: playbackUrl, thumbnailUrl,
      source: "cloud", sessionDate: date, addedAt: meta.syncedAt || 0,
    };
  }));
  return {
    meta,
    logData: logData ? { ...logData, source: "cloud" } : null,
    xmlData: xmlData ? { ...xmlData, source: "cloud" } : null,
    videos,
  };
}


// ── Delete a video from Bunny Stream ─────────────────────────────────────────
export async function deleteStreamVideo(streamId) {
  if (!streamId) return true;
  try {
    const res = await fetch("/api/stream/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId }),
    });
    return res.ok;
  } catch { return false; }
}
