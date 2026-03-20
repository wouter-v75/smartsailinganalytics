// src/lib/localStore.js
// ─────────────────────────────────────────────────────────────────────────────
// SmartSailingAnalytics — local data layer
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
const DB_VER  = 2;          // bumped: adds log_data store
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
      // log_data: keyed by session date — no row limit, no 5 MB cap
      if (!db.objectStoreNames.contains("log_data")) {
        db.createObjectStore("log_data", { keyPath: "date" });
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
    startUtc:    parsedMeta.startUtc  || null,   // UTC ms when recording started
    tsSource:    parsedMeta.tsSource  || null,   // "mp4-meta" | "lastmodified" | null
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
// ── Log (CSV) store — IndexedDB to avoid 5 MB localStorage limit ─────────────
export async function saveLogData(date, rows, fileName, startUtc, endUtc, tzOffset=0) {
  const db = await openDb();
  await idbPut(db, "log_data", {
    date, rows, fileName, startUtc, endUtc,
    tzOffset,
    addedAt: Date.now(), synced: false,
  });
  upsertSession(date, { hasLog: true, logFile: fileName, tzOffset });
  // Remove old localStorage entry if it exists (free up space)
  lsDel(`ssa:log:${date}`);
}

export async function getLogData(date) {
  try {
    const db    = await openDb();
    const entry = await idbGet(db, "log_data", date);
    if (entry) return entry;
  } catch {}
  // Fallback: old localStorage format for sessions imported before this change
  return lsGet(`ssa:log:${date}`);
}

// ── XML (event) store ─────────────────────────────────────────────────────────
export function saveXmlData(date, parsed, fileName) {
  const key = `ssa:xml:${date}`;
  lsSet(key, { ...parsed, fileName, addedAt: Date.now(), synced: false });
  upsertSession(date, { hasXml: true, xmlFile: fileName });
}

export function getXmlData(date) { return lsGet(`ssa:xml:${date}`); }

// ── Auto-tag from log + XML ────────────────────────────────────────────────────
//
// Tag groups:
//   1. Session context  — boat, location, dayType (XML meta)
//   2. Instrument       — TWS band + point-of-sail from TWA
//   3. Sails            — individual sail names from most recent SailsUp event
//   4. Mark roundings   — "mark"/"topmark" + pos-of-sail at rounding time
//   5. Primary manoeuvre — best event near clip midpoint (race-start > gybe > tack)
//   6. Secondary events — all other event types + count tags
//
export function computeAutoTags(videoStartUtc, durationSec, logData, xmlData, offsetSec = 0) {
  const tags = [];
  if (!videoStartUtc) return tags;

  const syncMs   = offsetSec * 1000;
  const winStart = videoStartUtc + syncMs;
  const winEnd   = winStart + (durationSec || 0) * 1000;
  const midpoint = (winStart + winEnd) / 2;

  // ── 1. Session context from XML meta ────────────────────────────────────────
  if (xmlData?.meta) {
    const { boat, location, dayType } = xmlData.meta;
    if (boat)     tags.push(boat.toLowerCase().replace(/\s+/g, "-"));
    if (location) tags.push(location.toLowerCase().replace(/\s+/g, "-"));
    if (dayType)  tags.push(dayType.toLowerCase().replace(/\s+/g, "-"));
  }

  // ── 2. Instrument tags ──────────────────────────────────────────────────────
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

  // ── 3. Sails — each individual sail from most recent SailsUp ≤ clip end ──────
  const sailEv = [...(xmlData.sailsUpEvents || [])]
    .filter(s => s.utc <= winEnd)
    .sort((a, b) => b.utc - a.utc)[0];
  if (sailEv) {
    sailEv.sails.forEach(s => tags.push(s.trim().toLowerCase()));
  }

  // ── 4. Mark roundings in clip window ─────────────────────────────────────────
  const marks = (xmlData.markRoundings || []).filter(
    m => m.utc >= winStart - BUFFER_MS && m.utc <= winEnd + BUFFER_MS
  );
  for (const m of marks) {
    tags.push(m.isTop ? "topmark" : "mark");
    // Point of sail at the rounding using nearest log row
    if (logData?.rows?.length) {
      const nearest = logData.rows.reduce((best, r) =>
        Math.abs(r.utc - m.utc) < Math.abs(best.utc - m.utc) ? r : best,
        logData.rows[0]
      );
      if (Math.abs(nearest.utc - m.utc) < 300_000) {
        tags.push(posOfSail(nearest.twa));
      }
    }
  }

  // ── 5 & 6. Manoeuvre events ───────────────────────────────────────────────────
  const searchStart = winStart - BUFFER_MS;
  const searchEnd   = winEnd   + BUFFER_MS;
  const allEvents   = [];

  for (const g of (xmlData.raceGuns || [])) {
    if (g.utc < searchStart || g.utc > searchEnd) continue;
    allEvents.push({ utc:g.utc, tag:"race-start", priority:8, valid:true });
  }
  for (const tj of (xmlData.tackJibes || []).filter(t => !t.isTack)) {
    if (tj.utc < searchStart || tj.utc > searchEnd) continue;
    allEvents.push({ utc:tj.utc, tag:"gybe", priority:5, valid:tj.isValid !== false });
  }
  for (const tj of (xmlData.tackJibes || []).filter(t => t.isTack)) {
    if (tj.utc < searchStart || tj.utc > searchEnd) continue;
    allEvents.push({ utc:tj.utc, tag:"tack", priority:3, valid:tj.isValid !== false });
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

  // ── Race vs training ──────────────────────────────────────────────────────────
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

// ── Sync status helpers ───────────────────────────────────────────────────────
export function getUnsyncedCount() {
  const sessions = getSessions();
  let count = 0;
  for (const s of sessions) {
    // XML stays in localStorage
    const xml = s.hasXml ? lsGet(`ssa:xml:${s.date}`) : null;
    if (xml && !xml.synced) count++;
    // Log synced flag is tracked in session index
    if (s.hasLog && !s.logSynced) count++;
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
