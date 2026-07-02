// src/lib/bunny.js
// ─────────────────────────────────────────────────────────────────────────────
// SmartSailingAnalytics — Bunny.net Storage + Stream integration
//
// All uploads bypass Vercel completely:
//   Log/events JSON  → direct browser PUT → Bunny Storage
//   Videos           → direct browser TUS → Bunny Stream
// Reads go through Vercel proxy (read-only key).
// ─────────────────────────────────────────────────────────────────────────────

import { getVideoBlob, markVideoCloudSynced, markCloudSynced } from "./localStore";
import { hashLogPayload, hashXmlPayload } from "./contentHash";
import { readSyncManifest, updateSyncManifest } from "./syncManifest";

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

// ── Upload video directly from browser to Bunny Stream via tus-js-client ──────
export async function uploadFileToStream(uploadInfo, file, onProgress) {
  const { streamId } = uploadInfo;
  const credRes = await fetch("/api/stream/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ streamId, fileSize: file.size }),
  });
  if (!credRes.ok) {
    console.error("Failed to get stream credentials:", await credRes.json());
    return false;
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
      },
      metadata: { filetype: file.type, title: file.name },
      onProgress(bytesUploaded, bytesTotal) {
        onProgress?.(Math.round((bytesUploaded / bytesTotal) * 100));
      },
      onSuccess() { resolve(true); },
      onError(err) { console.error("tus upload error:", err); resolve(false); },
    });
    upload.findPreviousUploads().then(previous => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    });
  });
}

// ── Poll until Bunny Stream video is ready ────────────────────────────────────
export async function waitForStreamReady(streamId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`/api/stream/status/${streamId}`);
      if (res.ok) { const data = await res.json(); if (data.ready) return data; }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

// ── Full session sync ─────────────────────────────────────────────────────────
// opts.onVideoSynced({ video, streamId }) — fires immediately after each
// individual video finishes uploading to Bunny Stream (before the next one
// starts). Used by the UI to mirror that video into Supabase straight away so
// teammates see clips appear one-by-one instead of waiting for the whole batch.
export async function syncSessionToCloud(date, logData, xmlData, videos, onStatus, opts = {}) {
  const status = msg => onStatus?.(msg);
  const onVideoSynced = opts.onVideoSynced;
  const result = { success: false, streamIds: {} };
  try {
    // Read the session manifest once (a few hundred bytes) so we can skip
    // re-uploading log/xml that is already in the cloud unchanged. This replaces
    // the old "upload whenever rows exist" behaviour that re-sent multi-MB logs
    // every session. See docs/sync-caching-architecture-research.md.
    let manifest = null;
    try { manifest = await readSyncManifest(date); } catch {}
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
        const ok = await uploadJsonToStorage(`sessions/${date}/log.json`, {
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
        const ok = await uploadJsonToStorage(`sessions/${date}/events.json`, {
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

    // 3. Videos → Bunny Stream (direct via tus)
    for (const video of videos) {
      // Skip if already cloud-synced
      if (video.cloudSynced && video.streamId) {
        status(`↩ ${video.name} already in Stream — skipping`);
        result.streamIds[video.id] = video.streamId;
        continue;
      }

      // Get file: prefer video.file (just uploaded), then IDB blob, then objectUrl
      let file = video.file || null;
      if (!file) file = await getVideoBlob(video.id);
      if (!file && video.objectUrl) {
        try { const r = await fetch(video.objectUrl); file = await r.blob(); } catch {}
      }
      if (!file) {
        status(`⚠ No file available for ${video.name} — skipping`);
        continue;
      }

      status(`Creating Bunny Stream video for ${video.name}…`);
      const uploadInfo = await createStreamUpload(video.name, video.size);
      if (!uploadInfo) { status(`⚠ Stream create failed for ${video.name}`); continue; }

      status(`Uploading ${video.name} to Bunny Stream (${(video.size / 1e6).toFixed(0)} MB)…`);
      const uploaded = await uploadFileToStream(
        uploadInfo, file, pct => status(`Uploading ${video.name}… ${pct}%`)
      );
      if (!uploaded) { status(`⚠ Stream upload failed for ${video.name}`); continue; }

      result.streamIds[video.id] = uploadInfo.streamId;
      await markVideoCloudSynced(video.id, uploadInfo.streamId);
      status(`✓ ${video.name} uploaded to Stream (ID: ${uploadInfo.streamId.slice(0, 8)}…)`);

      // Fire per-video hook so the caller can mirror this clip to Supabase
      // (or anywhere else) right now — before the rest of the batch finishes.
      // Best-effort; swallow errors so a flaky DB call can't break the upload
      // loop for the remaining clips.
      if (onVideoSynced) {
        try { await onVideoSynced({ video, streamId: uploadInfo.streamId }); }
        catch (e) { console.warn('onVideoSynced threw:', e); }
      }
    }

    // 4. Session meta → Bunny Storage (direct)
    // Include ALL enriched fields so other devices can display full metadata
    // without needing to re-derive from log/xml.
    const meta = {
      date, boat: xmlData?.meta?.boat || null, location: xmlData?.meta?.location || null,
      hasLog: !!logData, hasXml: !!xmlData, videoCount: videos.length,
      videos: videos.map(v => ({
        id: v.id, name: v.name, size: v.size, duration: v.duration,
        camera: v.camera, title: v.title, tags: v.tags,
        streamId: result.streamIds[v.id] || v.streamId || null,
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
    await uploadJsonToStorage(`sessions/${date}/meta.json`, meta);

    // Record what's now in the cloud: update the session manifest with any
    // newly-uploaded log/xml hashes (optimistic on the copy we read), and
    // persist the same fingerprints locally so a future sync of unchanged data
    // skips the transfer entirely.
    if (Object.keys(manifestPatch).length) {
      try { await updateSyncManifest(date, manifestPatch, manifest); } catch {}
    }
    try { await markCloudSynced(date, { logHash: syncedLogHash, xmlHash: syncedXmlHash }); } catch {}

    result.success = true;
    status(`✓ Session ${date} fully synced to Bunny Storage + Stream`);
    return result;
  } catch (err) {
    status(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
}

// ── Update cloud metadata after re-enrichment ────────────────────────────────
// Called when log/event files are uploaded after videos were already synced.
// Updates meta.json with enriched video data + optionally uploads new log/events.
export async function updateCloudSessionMetadata(date, { videos, logData, xmlData, photos } = {}) {
  try {
    // 1. Read existing meta.json from cloud
    const existing = await fetchFromStorage(`sessions/${date}/meta.json`);
    if (!existing) return false; // session not yet in cloud — nothing to update

    // 2. Upload log/events if provided AND actually changed vs the cloud
    //    manifest (content-hash guard — don't re-send unchanged data).
    let manifest = null;
    try { manifest = await readSyncManifest(date); } catch {}
    const manifestPatch = {};
    let syncedLogHash, syncedXmlHash;
    const uploads = [];
    if (logData?.rows?.length) {
      const logHash = hashLogPayload(logData);
      if (manifest?.log?.hash === logHash) {
        syncedLogHash = logHash;
      } else {
        uploads.push(uploadJsonToStorage(`sessions/${date}/log.json`, {
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
        uploads.push(uploadJsonToStorage(`sessions/${date}/events.json`, {
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
    uploads.push(uploadJsonToStorage(`sessions/${date}/meta.json`, existing));

    // 5. Update per-photo metadata if photos provided
    if (photos?.length) {
      const photoIndex = { updatedAt: Date.now(), photos: [] };
      for (const p of photos) {
        const metaObj = { ...p };
        delete metaObj.objectUrl;  // don't store blob URLs in cloud
        photoIndex.photos.push(metaObj);
        uploads.push(uploadJsonToStorage(
          `sessions/${date}/photos/${p.id}_meta.json`, metaObj
        ));
      }
      uploads.push(uploadJsonToStorage(`sessions/${date}/photos.json`, photoIndex));
    }

    await Promise.all(uploads);

    // Record the newly-uploaded log/xml in the manifest + locally so we don't
    // re-send them next time.
    if (Object.keys(manifestPatch).length) {
      try { await updateSyncManifest(date, manifestPatch, manifest); } catch {}
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
export async function fetchCloudSession(date) {
  const [meta, logData, xmlData] = await Promise.all([
    fetchFromStorage(`sessions/${date}/meta.json`),
    fetchFromStorage(`sessions/${date}/log.json`),
    fetchFromStorage(`sessions/${date}/events.json`),
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

// ── Download original video from Bunny Storage for offline playback ───────────
// Fetches via Vercel proxy (read-only key), stores blob in IndexedDB.
export async function downloadVideoForOffline(video, onProgress) {
  try {
    const { saveVideoBlob } = await import("./localStore");
    const storageKey = `sessions/${video.sessionDate}/videos/${video.id}/original`;
    const res = await fetch(`/api/bunny/storage?key=${encodeURIComponent(storageKey)}`);
    if (!res.ok) return false;

    // Stream with progress
    const contentLength = res.headers.get("Content-Length");
    const total = contentLength ? parseInt(contentLength) : 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total > 0) onProgress?.(Math.round((received / total) * 100));
    }
    const blob = new Blob(chunks, { type: "video/mp4" });
    await saveVideoBlob(video.id, blob);
    return true;
  } catch (e) {
    console.error("downloadVideoForOffline error:", e);
    return false;
  }
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
