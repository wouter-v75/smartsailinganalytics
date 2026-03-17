// src/lib/cloudflare.js
// ─────────────────────────────────────────────────────────────────────────────
// SmartSailingAnalytics — Cloudflare R2 + Stream integration
//
//
// All functions are safe to call when cloud is not configured — they return
// null / false silently so Phase 1 (local-only) keeps working unchanged.
//
// REQUIRED ENV VARS (set in Vercel dashboard):
//   CLOUDFLARE_ACCOUNT_ID       — from Cloudflare dashboard
//   CLOUDFLARE_API_TOKEN        — API token with R2:Edit + Stream:Edit
//   R2_BUCKET_NAME              — e.g. "smartsailinganalytics"
//   NEXT_PUBLIC_R2_PUBLIC_URL   — public bucket URL if bucket is public
//                                 (optional — presigned URLs work without it)
//
// Data layout in R2:
//   sessions/{date}/log.json        — parsed log rows array
//   sessions/{date}/events.json     — parsed XML events object
//   sessions/{date}/meta.json       — session metadata + video list
//   sessions/{date}/{videoId}/raw   — original video file (optional backup)
//
// Stream stores the transcoded HLS and thumbnails separately — we only store
// the Stream asset ID in R2 meta.json.
// ─────────────────────────────────────────────────────────────────────────────

export const CLOUD_AVAILABLE = !!(
  typeof window !== "undefined"
    ? null // client — check via API
    : process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN
);

// ── Check if cloud is configured (client-side safe) ──────────────────────────
export async function checkCloudStatus() {
  try {
    const res = await fetch("/api/cloud/status", { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { available: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return data;
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ── Upload video to Cloudflare Stream ────────────────────────────────────────
// Returns { streamId, uploadUrl } or null
export async function createStreamUpload(fileName, fileSizeBytes) {
  try {
    const res = await fetch("/api/stream/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, fileSizeBytes }),
    });
    if (!res.ok) return null;
    return res.json(); // { streamId, uploadUrl }
  } catch { return null; }
}

// Upload file directly to Stream's TUS endpoint
// Returns true on success
export async function uploadFileToStream(uploadUrl, file, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl);
    xhr.setRequestHeader("Upload-Length", String(file.size));
    xhr.setRequestHeader("Upload-Offset", "0");
    xhr.setRequestHeader("Tus-Resumable", "1.0.0");
    xhr.setRequestHeader("Content-Type", "application/offset+octet-stream");

    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }

    xhr.onload  = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.send(file);
  });
}

// ── Poll Stream until video is ready ─────────────────────────────────────────
export async function waitForStreamReady(streamId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`/api/stream/status/${streamId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ready) return data; // { ready, playbackUrl, thumbnailUrl, duration }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

// ── Get presigned R2 PUT URL for a data file ──────────────────────────────────
export async function getR2PresignedPut(key, contentType = "application/json") {
  try {
    const res = await fetch("/api/r2/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, contentType, operation: "put" }),
    });
    if (!res.ok) return null;
    const { url } = await res.json();
    return url;
  } catch { return null; }
}

// ── Upload JSON data to R2 ────────────────────────────────────────────────────
export async function uploadJsonToR2(key, data) {
  const url = await getR2PresignedPut(key, "application/json");
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch { return false; }
}

// ── Fetch JSON from R2 (for older sessions) ───────────────────────────────────
export async function fetchFromR2(key) {
  try {
    const res = await fetch(`/api/r2/fetch?key=${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ── List all sessions stored in R2 ───────────────────────────────────────────
export async function listR2Sessions() {
  try {
    const res = await fetch("/api/r2/sessions");
    if (!res.ok) return [];
    return res.json(); // [{ date, hasLog, hasXml, videoCount, ... }]
  } catch { return []; }
}

// ── Full sync: push one session's local data to R2 + Stream ──────────────────
// Returns { success, streamIds: {} }
export async function syncSessionToCloud(date, logData, xmlData, videos, onStatus) {
  const status = msg => onStatus && onStatus(msg);
  const result = { success: false, streamIds: {} };

  try {
    // 1. Push log rows to R2
    if (logData?.rows?.length) {
      status(`Uploading log data to R2 (${logData.rows.length.toLocaleString()} rows)…`);
      const ok = await uploadJsonToR2(`sessions/${date}/log.json`, {
        rows: logData.rows,
        startUtc: logData.startUtc,
        endUtc: logData.endUtc,
        uploadedAt: Date.now(),
      });
      if (!ok) { status("R2 log upload failed — check API token permissions."); return result; }
    }

    // 2. Push XML events to R2
    if (xmlData) {
      status("Uploading event data to R2…");
      const ok = await uploadJsonToR2(`sessions/${date}/events.json`, {
        ...xmlData,
        uploadedAt: Date.now(),
      });
      if (!ok) { status("R2 events upload failed."); return result; }
    }

    // 3. Upload each video to Stream
    for (const video of videos) {
      if (!video.file && !video.objectUrl) continue; // remote video, already synced
      status(`Creating Stream upload for ${video.name}…`);

      const upload = await createStreamUpload(video.name, video.size);
      if (!upload) { status(`Stream upload creation failed for ${video.name}.`); continue; }

      status(`Uploading ${video.name} to Cloudflare Stream (${(video.size / 1e6).toFixed(0)} MB)…`);

      let file = video.file;
      if (!file && video.objectUrl) {
        // Reconstruct blob from objectURL if needed
        try { const r = await fetch(video.objectUrl); file = await r.blob(); } catch { continue; }
      }

      const uploaded = await uploadFileToStream(upload.uploadUrl, file,
        pct => status(`Uploading ${video.name}… ${pct}%`)
      );
      if (!uploaded) { status(`Stream upload failed for ${video.name}.`); continue; }

      result.streamIds[video.id] = upload.streamId;
      status(`${video.name} uploaded to Stream (${upload.streamId}). Processing…`);
    }

    // 4. Save session meta to R2 (includes stream IDs for playback lookup)
    const meta = {
      date,
      boat: xmlData?.meta?.boat || null,
      location: xmlData?.meta?.location || null,
      hasLog: !!logData,
      hasXml: !!xmlData,
      videoCount: videos.length,
      videos: videos.map(v => ({
        id: v.id,
        name: v.name,
        size: v.size,
        duration: v.duration,
        camera: v.camera,
        title: v.title,
        tags: v.tags,
        streamId: result.streamIds[v.id] || null,
      })),
      syncedAt: Date.now(),
    };
    await uploadJsonToR2(`sessions/${date}/meta.json`, meta);

    result.success = true;
    status(`Session ${date} synced to Cloudflare R2 + Stream.`);
    return result;

  } catch (err) {
    status(`Sync error: ${err.message}`);
    return result;
  }
}

// ── Fetch older session data from R2 + Stream ─────────────────────────────────
export async function fetchCloudSession(date) {
  const [meta, logData, xmlData] = await Promise.all([
    fetchFromR2(`sessions/${date}/meta.json`),
    fetchFromR2(`sessions/${date}/log.json`),
    fetchFromR2(`sessions/${date}/events.json`),
  ]);
  if (!meta) return null;

  // Build video list with Stream playback URLs
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
      objectUrl:    playbackUrl,   // use Stream HLS URL as the playback source
      thumbnailUrl,
      streamId:     v.streamId,
      source:       "cloud",
      sessionDate:  date,
      addedAt:      meta.syncedAt || 0,
    };
  }));

  return {
    meta,
    logData:  logData  ? { ...logData,  source: "cloud" } : null,
    xmlData:  xmlData  ? { ...xmlData,  source: "cloud" } : null,
    videos,
  };
}
