// src/lib/localStore.js
// ─────────────────────────────────────────────────────────────────────────────
// SmartSailingAnalytics — local data layer
//
// (import kept at top; used to fingerprint log/xml content so sync can skip
//  re-uploading unchanged data — see docs/sync-caching-architecture-research.md)
import { hashLogPayload, hashXmlPayload } from "./contentHash";
//
// Storage layout (v3):
//   IndexedDB  "ssa-db"
//     store "videos"    — blobs + metadata
//     store "log_data"  — CSV rows (keyed by date)
//     store "xml_data"  — event file data (keyed by date)
//   localStorage
//     ssa:sessions      — session index
//     ssa:taglist:{date}
//     ssa:syncOffsets
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = "ssa-db";
const DB_VER  = 4;
const TODAY   = () => new Date().toISOString().slice(0, 10);

// ── IndexedDB bootstrap ──────────────────────────────────────────────────────
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("videos")) {
        const store = db.createObjectStore("videos", { keyPath: "id" });
        store.createIndex("sessionDate", "sessionDate", { unique: false });
        store.createIndex("addedAt",     "addedAt",     { unique: false });
        store.createIndex("synced",      "syncedToDb",  { unique: false });
      }
      if (!db.objectStoreNames.contains("log_data")) {
        db.createObjectStore("log_data", { keyPath: "date" });
      }
      if (!db.objectStoreNames.contains("xml_data")) {
        db.createObjectStore("xml_data", { keyPath: "date" });
      }
      if (!db.objectStoreNames.contains("photos")) {
        db.createObjectStore("photos", { keyPath: "id" });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function idbGet(db, store, key) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => rej(req.error);
  });
}

function idbPut(db, store, value) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function idbDelete(db, store, key) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

function idbGetAll(db, store) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result ?? []);
    req.onerror   = () => rej(req.error);
  });
}

function idbGetByIndex(db, store, index, value) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, "readonly");
    const req = tx.objectStore(store).index(index).getAll(value);
    req.onsuccess = () => res(req.result ?? []);
    req.onerror   = () => rej(req.error);
  });
}

// ── localStorage helpers ─────────────────────────────────────────────────────
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function lsGet(key) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

function lsDel(key) {
  try { localStorage.removeItem(key); } catch {}
}

// ── Session index ─────────────────────────────────────────────────────────────
// Local sessions can be tagged with the (team_id, boat_id) workspace they were
// created in. When a user switches workspaces we filter by tag so a Northstar
// clip doesn't bleed into a Warp sidebar. Legacy (untagged) entries only
// appear when there is no active membership — the SPA tags new entries via
// the membership object passed to saveVideo / saveLogData / saveXmlData.
export function getSessions() { return lsGet("ssa:sessions") || []; }

// Filtered variant. Pass {teamId, boatId} from the active membership. Returns
// only sessions whose tags match, OR untagged sessions when the caller has no
// active membership (legacy single-tenant mode).
export function getSessionsForMembership(membership) {
  const all = getSessions();
  if (!membership || !membership.team_id || !membership.boat_id) {
    return all.filter((s) => !s.team_id && !s.boat_id);
  }
  return all.filter(
    (s) =>
      s.team_id === membership.team_id && s.boat_id === membership.boat_id
  );
}

// Public: record/update the photo count for a date's session (workspace-tagged)
// so the Photos sidebar surfaces the day immediately after an Upload-tab import,
// without needing a page refresh.
export function setPhotoSession(date, photoCount, membership) {
  if (!date) return
  upsertSession(date, {
    photoCount: photoCount || 0,
    team_id: membership?.team_id || null,
    boat_id: membership?.boat_id || null,
  })
}

function upsertSession(date, patch) {
  const sessions = getSessions();
  const idx = sessions.findIndex(
    (s) =>
      s.date === date &&
      (s.team_id || null) === (patch.team_id || null) &&
      (s.boat_id || null) === (patch.boat_id || null)
  );
  if (idx >= 0) sessions[idx] = { ...sessions[idx], ...patch };
  else sessions.push({ date, videoCount: 0, hasLog: false, hasXml: false, ...patch });
  sessions.sort((a, b) => b.date.localeCompare(a.date));
  lsSet("ssa:sessions", sessions);
}

// Merge a patch into a session index row (matched by date only). Used by the
// sync reconciler to backfill content hashes / synced-hash state on load.
export function updateSessionSync(date, patch) {
  const sessions = getSessions();
  const idx = sessions.findIndex(s => s.date === date);
  if (idx >= 0) { sessions[idx] = { ...sessions[idx], ...patch }; lsSet("ssa:sessions", sessions); }
}

// ── Video store ───────────────────────────────────────────────────────────────

// Detect if we're on a mobile device — affects whether blob is stored locally.
// On iPhone/iPad, Safari has tight storage limits so we skip blob storage.
function isMobileDevice() {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|Android/i.test(navigator.userAgent);
}

// `membership`: optional active-membership object {team_id, boat_id}. When
// provided, the saved video and its session-index row are tagged with the
// workspace so getSessionsForMembership / getAllVideosForMembership can
// later filter by workspace and keep tenants isolated.
export async function saveVideo(file, parsedMeta, membership = null) {
  const db   = await openDb();
  const date = parsedMeta.sessionDate || TODAY();
  const id   = `v_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // On mobile: skip storing the blob (storage limits, upload goes direct to cloud)
  // On desktop: store the blob for local playback and background cloud sync
  const storeBlob = !isMobileDevice();

  const teamId = membership?.team_id || null;
  const boatId = membership?.boat_id || null;
  const entry = {
    id,
    name:        file.name,
    size:        file.size,
    duration:    parsedMeta.duration || null,
    startUtc:    parsedMeta.startUtc  || null,
    tsSource:    parsedMeta.tsSource  || null,
    blob:        storeBlob ? file : null,
    addedAt:     Date.now(),
    sessionDate: date,
    tags:        parsedMeta.tags || [],
    title:       parsedMeta.title || file.name.replace(/\.[^.]+$/, ""),
    camera:      parsedMeta.camera || detectCamera(file.name),
    team_id:     teamId,
    boat_id:     boatId,
    syncedToDb:  false,
    cloudSynced: false,   // tracks whether this video has been uploaded to Stream
  };
  await idbPut(db, "videos", entry);
  const existing = getSessions().find(
    (s) => s.date === date && (s.team_id || null) === teamId && (s.boat_id || null) === boatId
  );
  upsertSession(date, {
    team_id: teamId,
    boat_id: boatId,
    videoCount: (existing?.videoCount || 0) + 1,
  });
  return {
    ...entry,
    blob:      undefined,
    objectUrl: storeBlob ? URL.createObjectURL(file) : null,
  };
}

// ── Get the raw blob for a video (used by cloud sync) ────────────────────────
export async function getVideoBlob(id) {
  try {
    const db    = await openDb();
    const entry = await idbGet(db, "videos", id);
    return entry?.blob ?? null;
  } catch { return null; }
}

// ── Store a blob for an existing video (used by "Download for offline") ───────
export async function saveVideoBlob(id, blob) {
  try {
    const db    = await openDb();
    const entry = await idbGet(db, "videos", id);
    if (!entry) return false;
    entry.blob = blob;
    await idbPut(db, "videos", entry);
    return true;
  } catch { return false; }
}

// ── Replace blob + duration + startUtc (used by the in-browser crop UI) ─────
// After cropping, three things change atomically:
//   1. The new blob holds only the kept range (smaller, different bytes).
//   2. The duration shrinks to (endSec - startSec).
//   3. The video's UTC anchor shifts forward by trimStart seconds — the
//      new frame 0 corresponds to (oldStartUtc + trimStart * 1000). If we
//      forget this, every instrument/log overlay reads the wrong moment.
//
// Pass `newStartUtc` only when you've adjusted it; pass null/undefined to
// leave the existing value alone (i.e. crop without start-time change).
//
// Cloud-sync state is invalidated so a subsequent sync re-uploads the
// trimmed bytes (the old proxy/original in Bunny is now stale).
export async function updateVideoBlobAndDuration(id, blob, durationSec, newStartUtc) {
  try {
    const db    = await openDb();
    const entry = await idbGet(db, "videos", id);
    if (!entry) return false;
    entry.blob        = blob;
    entry.size        = blob?.size ?? entry.size;
    if (typeof durationSec === "number" && isFinite(durationSec)) {
      entry.duration  = durationSec;
    }
    if (typeof newStartUtc === "number" && isFinite(newStartUtc)) {
      entry.startUtc  = newStartUtc;
    }
    entry.syncedToDb  = false;
    entry.cloudSynced = false;
    // Stamp the moment we wrote new bytes. The library merge compares this
    // against the cloud row's proxy_uploaded_at to decide whether the cloud
    // rendition is still fresh — if local is newer, the cloud's hasProxy /
    // hasOriginal claims are about stale bytes and must be ignored, so the
    // freshly-cropped local blob stays as the playback source.
    entry.localBlobModifiedAt = Date.now();
    // Drop any prior streamId — the cloud copy is now stale.
    if (entry.streamId) entry.streamId = null;
    await idbPut(db, "videos", entry);
    return true;
  } catch { return false; }
}

// ── Mark a video as cloud-synced (has a streamId) ─────────────────────────────
export async function markVideoCloudSynced(id, streamId) {
  try {
    const db    = await openDb();
    const entry = await idbGet(db, "videos", id);
    if (!entry) return;
    entry.cloudSynced = true;
    entry.streamId    = streamId;
    await idbPut(db, "videos", entry);
  } catch {}
}

export async function getVideosForDate(date) {
  const db      = await openDb();
  const entries = await idbGetByIndex(db, "videos", "sessionDate", date);
  return entries.map(e => ({
    ...e,
    blob:        undefined,
    objectUrl:   e.blob ? URL.createObjectURL(e.blob) : null,
    hasLocalBlob: !!e.blob,   // flag so UI/sync knows blob is available
  }));
}

export async function getAllVideos() {
  const db      = await openDb();
  const entries = await idbGetAll(db, "videos");
  return entries.map(e => ({
    ...e,
    blob:        undefined,
    objectUrl:   e.blob ? URL.createObjectURL(e.blob) : null,
    hasLocalBlob: !!e.blob,
  })).sort((a, b) => b.addedAt - a.addedAt);
}

// Same as getAllVideos but filtered by the active workspace. Legacy/untagged
// videos are visible only when no membership is active. Used everywhere the
// SPA reads local videos in a workspace-aware context.
export async function getAllVideosForMembership(membership) {
  const all = await getAllVideos();
  if (!membership || !membership.team_id || !membership.boat_id) {
    return all.filter((v) => !v.team_id && !v.boat_id);
  }
  return all.filter(
    (v) => v.team_id === membership.team_id && v.boat_id === membership.boat_id
  );
}

export async function updateVideoTags(id, tags) {
  const db    = await openDb();
  const entry = await idbGet(db, "videos", id);
  if (entry) {
    entry.tags        = tags;
    entry.syncedToDb  = false;
    await idbPut(db, "videos", entry);
  }
}

export async function updateVideoStartUtc(id, startUtc, sessionDate = null) {
  const db    = await openDb();
  const entry = await idbGet(db, "videos", id);
  if (entry) {
    entry.startUtc   = startUtc;
    // Editing the start time can move the clip to a different day — update its
    // sessionDate too, otherwise it stays filed under the old date's folder.
    if (sessionDate) entry.sessionDate = sessionDate;
    entry.syncedToDb = false;
    await idbPut(db, "videos", entry);
  }
}

export async function deleteVideo(id) {
  const db = await openDb();
  await idbDelete(db, "videos", id);
}

// ── Log (CSV) store — IndexedDB ───────────────────────────────────────────────
export async function saveLogData(date, rows, fileName, startUtc, endUtc, tzOffset = 0, membership = null) {
  const db = await openDb();
  // Content fingerprint of the payload we'd upload. Sync compares this against
  // the cloud manifest / last-synced hash and skips the upload when unchanged.
  const contentHash = hashLogPayload({ rows, startUtc, endUtc });
  await idbPut(db, "log_data", {
    date, rows, fileName, startUtc, endUtc,
    tzOffset,
    team_id: membership?.team_id || null,
    boat_id: membership?.boat_id || null,
    addedAt: Date.now(), synced: false,
    contentHash, syncedHash: null,
  });
  upsertSession(date, {
    hasLog: true, logFile: fileName, tzOffset,
    logHash: contentHash, logSyncedHash: null,
    team_id: membership?.team_id || null,
    boat_id: membership?.boat_id || null,
  });
  lsDel(`ssa:log:${date}`);
}

export async function getLogData(date) {
  try {
    const db    = await openDb();
    const entry = await idbGet(db, "log_data", date);
    if (entry) return entry;
  } catch {}
  return lsGet(`ssa:log:${date}`);
}

// ── XML (event) store — IndexedDB ────────────────────────────────────────────
export async function saveXmlData(date, parsed, fileName, membership = null) {
  const db = await openDb();
  const contentHash = hashXmlPayload(parsed);
  await idbPut(db, "xml_data", {
    date,
    ...parsed,
    fileName,
    team_id: membership?.team_id || null,
    boat_id: membership?.boat_id || null,
    addedAt: Date.now(),
    synced:  false,
    contentHash, syncedHash: null,
  });
  upsertSession(date, {
    hasXml: true, xmlFile: fileName,
    xmlHash: contentHash, xmlSyncedHash: null,
    team_id: membership?.team_id || null,
    boat_id: membership?.boat_id || null,
  });
  lsDel(`ssa:xml:${date}`);
}

export async function getXmlData(date) {
  try {
    const db    = await openDb();
    const entry = await idbGet(db, "xml_data", date);
    if (entry) return entry;
  } catch {}
  return lsGet(`ssa:xml:${date}`);
}

// ── Auto-tag from log + XML ───────────────────────────────────────────────────
export function computeAutoTags(videoStartUtc, durationSec, logData, xmlData, offsetSec = 0) {
  const tags = [];
  if (!videoStartUtc) return tags;

  const syncMs   = offsetSec * 1000;
  const winStart = videoStartUtc + syncMs;
  const winEnd   = winStart + (durationSec || 0) * 1000;
  const midpoint = (winStart + winEnd) / 2;

  if (xmlData?.meta) {
    const { boat, location, dayType } = xmlData.meta;
    if (boat)     tags.push(boat.toLowerCase().replace(/\s+/g, "-"));
    if (location) tags.push(location.toLowerCase().replace(/\s+/g, "-"));
    if (dayType)  tags.push(dayType.toLowerCase().replace(/\s+/g, "-"));
  }

  const posOfSail = twa => {
    const a = Math.abs(twa);
    return a < 60 ? "upwind" : a < 110 ? "reach" : "downwind";
  };

  if (logData?.rows?.length) {
    const win = logData.rows.filter(r => r.utc >= winStart && r.utc <= winEnd);
    if (win.length > 0) {
      const avg = f => win.reduce((s, r) => s + (r[f] || 0), 0) / win.length;
      const tws = avg("tws");
      const twa = avg("twa");
      tags.push(`tws-${
        tws <  8 ? "0-8"   :
        tws < 12 ? "8-12"  :
        tws < 16 ? "12-16" :
        tws < 20 ? "16-20" :
        tws < 25 ? "20-25" : "25+"
      }kn`);
      tags.push(posOfSail(twa));
    }
  }

  if (!xmlData) return [...new Set(tags)];

  const BUFFER_MS = 60_000;

  {
    const allSailEvents = xmlData.sailsUpEvents || xmlData.sailsUp || [];
    const activeSails   = new Set();
    const beforeClip    = allSailEvents
      .filter(s => s.utc <= winStart)
      .sort((a, b) => b.utc - a.utc)[0];
    if (beforeClip) beforeClip.sails.forEach(s => activeSails.add(s.trim().toLowerCase()));
    allSailEvents
      .filter(s => s.utc > winStart && s.utc <= winEnd)
      .forEach(ev => ev.sails.forEach(s => activeSails.add(s.trim().toLowerCase())));
    if (activeSails.size === 0) {
      const firstEver = allSailEvents.sort((a, b) => a.utc - b.utc)[0];
      if (firstEver) firstEver.sails.forEach(s => activeSails.add(s.trim().toLowerCase()));
    }
    activeSails.forEach(s => { if (s) tags.push(s); });
  }

  const marks = (xmlData.markRoundings || []).filter(
    m => m.utc >= winStart - BUFFER_MS && m.utc <= winEnd + BUFFER_MS
  );
  for (const m of marks) {
    tags.push(m.isTop ? "topmark" : "mark");
    if (logData?.rows?.length) {
      const nearest = logData.rows.reduce((best, r) =>
        Math.abs(r.utc - m.utc) < Math.abs(best.utc - m.utc) ? r : best,
        logData.rows[0]
      );
      if (Math.abs(nearest.utc - m.utc) < 300_000) tags.push(posOfSail(nearest.twa));
    }
  }

  const searchStart = winStart - BUFFER_MS;
  const searchEnd   = winEnd   + BUFFER_MS;
  const allEvents   = [];

  for (const g of (xmlData.raceGuns || [])) {
    if (g.utc < searchStart || g.utc > searchEnd) continue;
    allEvents.push({ utc: g.utc, tag: "race-start", priority: 8, valid: true });
  }
  for (const tj of (xmlData.tackJibes || []).filter(t => !t.isTack)) {
    if (tj.utc < searchStart || tj.utc > searchEnd) continue;
    allEvents.push({ utc: tj.utc, tag: "gybe", priority: 5, valid: tj.isValid !== false });
  }
  for (const tj of (xmlData.tackJibes || []).filter(t => t.isTack)) {
    if (tj.utc < searchStart || tj.utc > searchEnd) continue;
    allEvents.push({ utc: tj.utc, tag: "tack", priority: 3, valid: tj.isValid !== false });
  }

  if (allEvents.length > 0) {
    const best = allEvents
      .filter(e => e.valid)
      .sort((a, b) =>
        b.priority !== a.priority
          ? b.priority - a.priority
          : Math.abs(a.utc - midpoint) - Math.abs(b.utc - midpoint)
      )[0];
    if (best) tags.push(best.tag);
    const inWin  = allEvents.filter(e => e.utc >= winStart && e.utc <= winEnd);
    const seen   = new Set([best?.tag]);
    const counts = {};
    for (const e of inWin) {
      if (!seen.has(e.tag)) { tags.push(e.tag); seen.add(e.tag); }
      counts[e.tag] = (counts[e.tag] || 0) + 1;
    }
    for (const [tag, n] of Object.entries(counts)) {
      if (n > 1) tags.push(`${n}x-${tag}`);
    }
  }

  tags.push((xmlData.raceGuns || []).length > 0 ? "race" : "training");
  return [...new Set(tags)];
}

// ── Camera detection ──────────────────────────────────────────────────────────
function detectCamera(filename) {
  const f = filename.toLowerCase();
  if (f.includes("gopro") || f.startsWith("gh") || f.startsWith("gx")) return "GoPro";
  if (f.includes("iphone") || f.includes("img_") || f.endsWith(".mov")) return "iPhone";
  return "Camera";
}

// ── Sync status ───────────────────────────────────────────────────────────────
// A log/xml is "unsynced" only when its current content hash differs from the
// hash we last confirmed uploaded (logSyncedHash / xmlSyncedHash). This is
// content-based, not a bare boolean, so it self-corrects: re-importing new data
// bumps logHash and flags it dirty; an unchanged file already in the cloud reads
// as synced and is never re-uploaded. See docs/sync-caching-architecture-research.md.
export function getUnsyncedCount() {
  const sessions = getSessions();
  let count = 0;
  for (const s of sessions) {
    if (s.hasLog && s.logHash && s.logHash !== s.logSyncedHash) count++;
    if (s.hasXml && s.xmlHash && s.xmlHash !== s.xmlSyncedHash) count++;
  }
  return count;
}

// Persist "this exact content is now in the cloud" for a session's log and/or
// xml. Writes both the IndexedDB row (authoritative store that getLogData reads)
// AND the localStorage session index (which getUnsyncedCount reads) so the flag
// no longer evaporates on reload — the original bug.
export async function markCloudSynced(date, { logHash = undefined, xmlHash = undefined } = {}) {
  try {
    const db = await openDb();
    if (logHash !== undefined && logHash !== null) {
      const row = await idbGet(db, "log_data", date);
      if (row) { await idbPut(db, "log_data", { ...row, synced: true, syncedHash: logHash }); }
    }
    if (xmlHash !== undefined && xmlHash !== null) {
      const row = await idbGet(db, "xml_data", date);
      if (row) { await idbPut(db, "xml_data", { ...row, synced: true, syncedHash: xmlHash }); }
    }
  } catch {}
  const sessions = getSessions();
  const idx = sessions.findIndex(s => s.date === date);
  if (idx >= 0) {
    sessions[idx].cloudSynced = true;
    if (logHash !== undefined && logHash !== null) sessions[idx].logSyncedHash = logHash;
    if (xmlHash !== undefined && xmlHash !== null) sessions[idx].xmlSyncedHash = xmlHash;
    lsSet("ssa:sessions", sessions);
  }
}

// ── Session tag list ──────────────────────────────────────────────────────────
export function getTagList(date)        { return lsGet(`ssa:taglist:${date}`) || []; }
export function saveTagList(date, list) {
  lsSet(`ssa:taglist:${date}`, [...new Set(list.filter(Boolean))].sort());
}
export function mergeTagList(date, newTags) {
  saveTagList(date, [...getTagList(date), ...newTags]);
  return getTagList(date);
}

// ── Sync offsets ──────────────────────────────────────────────────────────────
const OFFSET_KEY = "ssa:syncOffsets";
export function getSyncOffsets() { return lsGet(OFFSET_KEY) || {}; }
export function saveSyncOffset(videoId, secs) {
  const o = getSyncOffsets();
  if (secs === 0) delete o[videoId]; else o[videoId] = secs;
  lsSet(OFFSET_KEY, o);
}
