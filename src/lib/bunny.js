// src/lib/bunny.js
// ─────────────────────────────────────────────────────────────────────────────
// SmartSailingAnalytics — Bunny.net Storage + Stream integration
//
// Video upload strategy: browser uploads DIRECTLY to Bunny Stream's TUS
// endpoint. Vercel only handles the small JSON API calls (create, auth, status).
// This means no Vercel size limits or timeouts for video uploads.
//
// REQUIRED ENV VARS (Vercel dashboard):
//   BUNNY_STORAGE_API_KEY     — Storage zone password
//   BUNNY_STORAGE_ZONE        — Storage zone name
//   BUNNY_STORAGE_REGION      — de | ny | la | sg | se | br | jh  (default: de)
//   BUNNY_STREAM_API_KEY      — Stream library API key
//   BUNNY_STREAM_LIBRARY_ID   — Stream library ID (numeric)
//   BUNNY_CDN_HOSTNAME        — CDN pull zone hostname e.g. "ssa.b-cdn.net"
// ─────────────────────────────────────────────────────────────────────────────

const BUNNY_TUS = "https://video.bunnycdn.com/tusupload";
const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB chunks — no Vercel limits now

// ── Cloud availability check ──────────────────────────────────────────────────
export async function checkCloudStatus() {
  try {
    const res = await fetch("/api/cloud/status", {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { available: false, reason: `HTTP ${res.status}` };
    return res.json();
  } catch (e) {
    return { available: false, reason: String(e) };
  }
}

// ── Create a Bunny Stream video object ────────────────────────────────────────
// Returns { streamId } or null
export async function createStreamUpload(fileName, fileSizeBytes) {
  try {
    const res = await fetch("/api/stream/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, fileSizeBytes }),
    });
    if (!res.ok) return null;
    return res.json(); // { streamId, libraryId, apiKey }
  } catch { return null; }
}

// ── Get signed upload credentials from server ─────────────────────────────────
// Returns { signature, expiry, libraryId, streamId } or null
async function getUploadAuth(streamId) {
  try {
    const res = await fetch(`/api/stream/auth?streamId=${encodeURIComponent(streamId)}`);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ── Upload file directly from browser to Bunny Stream TUS endpoint ────────────
// No Vercel proxy — video bytes go straight to Bunny.
// Chunked so progress is accurate and large files work reliably.
export async function uploadFileToStream(uploadInfo, file, onProgress) {
  const { streamId } = uploadInfo;

  // 1. Get signed credentials from our server (keeps API key secret)
  const auth = await getUploadAuth(streamId);
  if (!auth) {
    console.error("Failed to get upload auth credentials");
    return false;
  }

  const tusHeaders = {
    AuthorizationSignature: auth.signature,
    AuthorizationExpire:    auth.expiry,
    VideoId:                streamId,
    LibraryId:              auth.libraryId,
    "Tus-Resumable":        "1.0.0",
  };

  // 2. Initialise the TUS session (POST with Upload-Length, no body)
  try {
    const initRes = await fetch(BUNNY_TUS, {
      method: "POST",
      headers: { ...tusHeaders, "Upload-Length": String(file.size) },
    });
    if (!initRes.ok) {
      console.error("TUS init failed:", initRes.status, await initRes.text());
      return false;
    }
  } catch (e) {
    console.error("TUS init error:", e);
    return false;
  }

  // 3. Upload chunks directly to Bunny
  let offset = 0;
  while (offset < file.size) {
    const end   = Math.min(offset + CHUNK_SIZE, file.size);
    const chunk = file.slice(offset, end);

    const ok = await uploadChunk(tusHeaders, chunk, offset);
    if (!ok) {
      // Retry once before giving up
      console.warn(`Chunk at ${offset} failed, retrying…`);
      const retryOk = await uploadChunk(tusHeaders, chunk, offset);
      if (!retryOk) {
        console.error(`Chunk at ${offset} failed after retry`);
        return false;
      }
    }

    offset = end;
    onProgress?.(Math.round((offset / file.size) * 100));
  }

  return true;
}

function uploadChunk(tusHeaders, chunk, offset) {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", BUNNY_TUS);
    Object.entries(tusHeaders).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.setRequestHeader("Content-Type",  "application/offset+octet-stream");
    xhr.setRequestHeader("Upload-Offset", String(offset));
    xhr.onload  = () => resolve(xhr.status === 204 || xhr.status === 200);
    xhr.onerror = () => resolve(false);
    xhr.send(chunk);
  });
}

// ── Poll until Bunny Stream video is ready (status 4) ────────────────────────
export async function waitForStreamReady(streamId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`/api/stream/status/${streamId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ready) return data;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

// ── Upload JSON to Bunny Storage ──────────────────────────────────────────────
export async function uploadJsonToStorage(key, data) {
  try {
    const res = await fetch("/api/bunny/storage", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, data }),
    });
    return res.ok;
  } catch { return false; }
}

// ── Fetch JSON from Bunny Storage ─────────────────────────────────────────────
export async function fetchFromStorage(key) {
  try {
    const res = await fetch(`/api/bunny/storage?key=${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ── List all cloud sessions ───────────────────────────────────────────────────
export async function listR2Sessions() {
  try {
    const res = await fetch("/api/bunny/sessions");
    if (!res.ok) return [];
    return res.json();
  } catch { return []; }
}

// ── Full session sync to Bunny Storage + Stream ───────────────────────────────
export async function syncSessionToCloud(date, logData, xmlData, videos, onStatus) {
  const status = msg => onStatus?.(msg);
  const result = { success: false, streamIds: {} };

  try {
    // 1. Log rows → Storage
    if (logData?.rows?.length) {
      status(`Uploading log data to Bunny Storage (${logData.rows.length.toLocaleString()} rows)…`);
      const ok = await uploadJsonToStorage(`sessions/${date}/log.json`, {
        rows: logData.rows,
        startUtc: logData.startUtc,
        endUtc: logData.endUtc,
        uploadedAt: Date.now(),
      });
      if (!ok) { status("Bunny Storage log upload failed — check API key and zone name."); return result; }
      status("✓ Log data uploaded to Bunny Storage");
    }

    // 2. XML events → Storage
    if (xmlData) {
      status("Uploading event data to Bunny Storage…");
      const ok = await uploadJsonToStorage(`sessions/${date}/events.json`, {
        ...xmlData, uploadedAt: Date.now(),
      });
      if (!ok) { status("Bunny Storage events upload failed."); return result; }
      status("✓ Event data uploaded to Bunny Storage");
    }

    // 3. Videos → Stream (direct browser upload)
    for (const video of videos) {
      if (!video.file && !video.objectUrl) continue;

      status(`Creating Bunny Stream video for ${video.name}…`);
      const uploadInfo = await createStreamUpload(video.name, video.size);
      if (!uploadInfo) { status(`Stream create failed for ${video.name}`); continue; }

      status(`Uploading ${video.name} to Bunny Stream (${(video.size / 1e6).toFixed(0)} MB)…`);

      let file = video.file;
      if (!file && video.objectUrl) {
        try { const r = await fetch(video.objectUrl); file = await r.blob(); } catch { continue; }
      }

      const uploaded = await uploadFileToStream(
        uploadInfo,
        file,
        pct => status(`Uploading ${video.name}… ${pct}%`)
      );

      if (!uploaded) { status(`Stream upload failed for ${video.name}`); continue; }
      result.streamIds[video.id] = uploadInfo.streamId;
      status(`✓ ${video.name} uploaded to Stream (ID: ${uploadInfo.streamId.slice(0, 8)}…)`);
    }

    // 4. Session meta → Storage
    const meta = {
      date,
      boat:       xmlData?.meta?.boat     || null,
      location:   xmlData?.meta?.location || null,
      hasLog:     !!logData,
      hasXml:     !!xmlData,
      videoCount: videos.length,
      videos: videos.map(v => ({
        id:       v.id,
        name:     v.name,
        size:     v.size,
        duration: v.duration,
        camera:   v.camera,
        title:    v.title,
        tags:     v.tags,
        streamId: result.streamIds[v.id] || null,
      })),
      syncedAt: Date.now(),
    };
    await uploadJsonToStorage(`sessions/${date}/meta.json`, meta);

    result.success = true;
    status(`✓ Session ${date} fully synced to Bunny Storage + Stream`);
    return result;

  } catch (err) {
    status(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
    return result;
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
      ...v,
      objectUrl:   playbackUrl,
      thumbnailUrl,
      source:      "cloud",
      sessionDate: date,
      addedAt:     meta.syncedAt || 0,
    };
  }));

  return {
    meta,
    logData:  logData  ? { ...logData,  source: "cloud" } : null,
    xmlData:  xmlData  ? { ...xmlData,  source: "cloud" } : null,
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
