// src/lib/localStore.js
// ─────────────────────────────────────────────────────────────────────────────
// SmartSailingAnalytics — local data layer
//
//
// Storage layout:
//   IndexedDB  "ssa-db"
//     store "videos"   — { id, name, size, duration, blob, objectUrl,
//                          addedAt, tags, syncedToDb, sessionDate }
//   localStorage
//     ssa:log:{date}   — { rows[], startUtc, endUtc, fileName, addedAt, synced }
//     ssa:xml:{date}   — { meta, tackJibes[], markRoundings[], sailsUp[],
//                          raceGuns[], fileName, addedAt, synced }
//     ssa:sessions     — [{ date, videoCount, hasLog, hasXml }]  index
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = "ssa-db";
const DB_VER  = 1;
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
export function getSessions() { return lsGet("ssa:sessions") || []; }

function upsertSession(date, patch) {
  const sessions = getSessions();
  const idx = sessions.findIndex(s => s.date === date);
  if (idx >= 0) sessions[idx] = { ...sessions[idx], ...patch };
  else sessions.push({ date, videoCount: 0, hasLog: false, hasXml: false, ...patch });
  sessions.sort((a, b) => b.date.localeCompare(a.date));
  lsSet("ssa:sessions", sessions);
}

// ── Video store ───────────────────────────────────────────────────────────────
export async function saveVideo(file, parsedMeta) {
  const db   = await openDb();
  // Use caller-supplied sessionDate (from CSV/XML) or fall back to today
  const date = parsedMeta.sessionDate || TODAY();
  const id   = `v_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Revoke any previous objectURL for same file if re-importing
  const entry = {
    id,
    name:        file.name,
    size:        file.size,
    duration:    parsedMeta.duration || null,
    startUtc:    parsedMeta.startUtc || null,   // UTC ms when recording started
    blob:        file,
    addedAt:     Date.now(),
    sessionDate: date,
    tags:        parsedMeta.tags || [],
    title:       parsedMeta.title || file.name.replace(/\.[^.]+$/, ""),
    camera:      parsedMeta.camera || detectCamera(file.name),
    syncedToDb:  false,
  };
  await idbPut(db, "videos", entry);
  upsertSession(date, { videoCount: (getSessions().find(s => s.date === date)?.videoCount || 0) + 1 });
  // Return without the blob for React state (blob stays in IDB)
  return { ...entry, blob: undefined, objectUrl: URL.createObjectURL(file) };
}

export async function getVideosForDate(date) {
  const db      = await openDb();
  const entries = await idbGetByIndex(db, "videos", "sessionDate", date);
  return entries.map(e => ({
    ...e,
    blob: undefined,
    objectUrl: e.blob ? URL.createObjectURL(e.blob) : null,
  }));
}

export async function getAllVideos() {
  const db      = await openDb();
  const entries = await idbGetAll(db, "videos");
  return entries.map(e => ({
    ...e,
    blob: undefined,
    objectUrl: e.blob ? URL.createObjectURL(e.blob) : null,
  })).sort((a, b) => b.addedAt - a.addedAt);
}

export async function updateVideoTags(id, tags) {
  const db    = await openDb();
  const entry = await idbGet(db, "videos", id);
  if (entry) { entry.tags = tags; entry.syncedToDb = false; await idbPut(db, "videos", entry); }
}

export async function updateVideoStartUtc(id, startUtc) {
  const db    = await openDb();
  const entry = await idbGet(db, "videos", id);
  if (entry) { entry.startUtc = startUtc; entry.syncedToDb = false; await idbPut(db, "videos", entry); }
}

export async function deleteVideo(id) {
  const db = await openDb();
  await idbDelete(db, "videos", id);
}

// ── Log (CSV) store ───────────────────────────────────────────────────────────
export function saveLogData(date, rows, fileName, startUtc, endUtc) {
  const key = `ssa:log:${date}`;
  lsSet(key, { rows, fileName, startUtc, endUtc, addedAt: Date.now(), synced: false });
  upsertSession(date, { hasLog: true, logFile: fileName });
}

export function getLogData(date) { return lsGet(`ssa:log:${date}`); }

// ── XML (event) store ─────────────────────────────────────────────────────────
export function saveXmlData(date, parsed, fileName) {
  const key = `ssa:xml:${date}`;
  lsSet(key, { ...parsed, fileName, addedAt: Date.now(), synced: false });
  upsertSession(date, { hasXml: true, xmlFile: fileName });
}

export function getXmlData(date) { return lsGet(`ssa:xml:${date}`); }

// ── Auto-tag from log + XML ───────────────────────────────────────────────────
export function computeAutoTags(videoStartUtc, durationSec, logData, xmlData, offsetSec = 0) {
  const tags = [];
  if (!videoStartUtc) return tags;
  const syncMs  = offsetSec * 1000;
  const winStart = videoStartUtc + syncMs;
  const winEnd   = winStart + durationSec * 1000;

  if (logData?.rows?.length) {
    const window = logData.rows.filter(r => r.utc >= winStart && r.utc <= winEnd);
    if (window.length > 0) {
      const avg = f => window.reduce((s, r) => s + (r[f] || 0), 0) / window.length;
      const twsAvg = avg("tws");
      tags.push(`tws-${twsAvg < 8 ? "0-8" : twsAvg < 12 ? "8-12" : twsAvg < 16 ? "12-16" : twsAvg < 20 ? "16-20" : twsAvg < 25 ? "20-25" : "25+"}kn`);
      const twaAvg = Math.abs(avg("twa"));
      tags.push(twaAvg < 60 ? "upwind" : twaAvg < 100 ? "reaching" : "downwind");
    }
  }

  if (xmlData) {
    const tacks  = (xmlData.tackJibes || []).filter(t => t.isTack  && t.utc >= winStart && t.utc <= winEnd);
    const gybes  = (xmlData.tackJibes || []).filter(t => !t.isTack && t.utc >= winStart && t.utc <= winEnd);
    const marks  = (xmlData.markRoundings || []).filter(m => m.utc >= winStart && m.utc <= winEnd);
    if (tacks.length)  tags.push("tack");
    if (gybes.length)  tags.push("gybe");
    if (marks.some(m => m.isTop))  tags.push("top-mark");
    if (marks.some(m => !m.isTop)) tags.push("leeward-gate");

    // Active sails — find most recent SailsUp before window end
    const sailEv = [...(xmlData.sailsUpEvents || [])]
      .filter(s => s.utc <= winEnd)
      .sort((a, b) => b.utc - a.utc)[0];
    if (sailEv) sailEv.sails.forEach(s => tags.push(s));

    // Race vs training
    const sessionType = xmlData.meta?.date === TODAY() ? "today" : "training";
    tags.push(sessionType);
    if (xmlData.meta?.location) tags.push(xmlData.meta.location);
  }

  return [...new Set(tags)];
}

// ── Camera detection ──────────────────────────────────────────────────────────
function detectCamera(filename) {
  const f = filename.toLowerCase();
  if (f.includes("gopro") || f.startsWith("gh") || f.startsWith("gx")) return "GoPro";
  if (f.includes("iphone") || f.includes("img_") || f.endsWith(".mov")) return "iPhone";
  return "Camera";
}

// ── Sync status helpers ───────────────────────────────────────────────────────
export function getUnsyncedCount() {
  const sessions = getSessions();
  let count = 0;
  for (const s of sessions) {
    const log = s.hasLog ? lsGet(`ssa:log:${s.date}`) : null;
    const xml = s.hasXml ? lsGet(`ssa:xml:${s.date}`) : null;
    if (log && !log.synced)  count++;
    if (xml && !xml.synced)  count++;
  }
  return count;
}

export function markSynced(date, type) {
  const key  = `ssa:${type}:${date}`;
  const data = lsGet(key);
  if (data) { data.synced = true; lsSet(key, data); }
}

// Alias used by UI after cloud sync completes
export function markCloudSynced(date) {
  markSynced(date, "log");
  markSynced(date, "xml");
  // Mark session as cloud-synced in the index
  const sessions = getSessions();
  const idx = sessions.findIndex(s => s.date === date);
  if (idx >= 0) { sessions[idx].cloudSynced = true; lsSet("ssa:sessions", sessions); }
}

// ── Sync offsets — persist per video across reloads ───────────────────────────
const OFFSET_KEY = "ssa:syncOffsets";

export function getSyncOffsets() {
  return lsGet(OFFSET_KEY) || {};
}

export function saveSyncOffset(videoId, offsetSeconds) {
  const offsets = getSyncOffsets();
  if (offsetSeconds === 0) {
    delete offsets[videoId];
  } else {
    offsets[videoId] = offsetSeconds;
  }
  lsSet(OFFSET_KEY, offsets);
}
