// src/lib/bunny.js
// ─────────────────────────────────────────────────────────────────────────────
// SmartSailingAnalytics — Bunny.net Storage + Stream integration
// ─────────────────────────────────────────────────────────────────────────────

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

// ── Create a Bunny Stream video and get upload credentials ────────────────────
// Returns { streamId, uploadUrl, libraryId, apiKey } or null
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

// ── Upload file to Bunny Stream via TUS protocol ──────────────────────────────
// uploadInfo = { streamId, uploadUrl, libraryId, apiKey }
export async function uploadFileToStream(uploadInfo, file, onProgress) {
  const { streamId, uploadUrl, libraryId, apiKey } = uploadInfo;
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl);

    // Bunny Stream TUS extension headers (required for auth)
    xhr.setRequestHeader("AuthorizationSignature", apiKey);
    xhr.setRequestHeader("AuthorizationExpire", "0");          // 0 = never expires
    xhr.setRequestHeader("VideoId", streamId);
    xhr.setRequestHeader("LibraryId", String(libraryId));

    // Standard TUS headers
    xhr.setRequestHeader("Content-Type", "application/offset+octet-stream");
    xhr.setRequestHeader("Upload-Offset", "0");
    xhr.setRequestHeader("Tus-Resumable", "1.0.0");

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

    // 3. Videos → Stream
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
