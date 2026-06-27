// src/lib/photoStore.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared photo import + tiered (network-aware) cloud sync. Used by the Upload
// tab's PhotoUploadZone (import) and PhotosTab (view + deferred-original flush).
//
// Tiering — mirrors the video proxy/original model:
//   • THUMBNAIL (~480px) uploads IMMEDIATELY on any connection so mobile gets a
//     fast preview and teammates see it (Supabase mirror via `ssa:photo-saved`).
//   • The full ORIGINAL uploads only when the connection is `good` (WiFi /
//     ethernet / 4g, not Save-Data) — the same gate the video sync uses.
//
// Storage: blob → IndexedDB (`ssa-db`/`photos`); per-date metadata →
// localStorage (`ssa:photos-meta:<date>`); thumb+original → Bunny Storage
// (`sessions/<date>/photos/<id>[_thumb].jpg`); cross-device → Supabase via the
// parent's `ssa:photo-saved` → upsertPhotoCloud mirror. Photos bucket by their
// EXIF capture date (fallback: today).
// ─────────────────────────────────────────────────────────────────────────────

import { uploadJsonToStorage } from './bunny'
import { getLogData, getXmlData } from './localStore'

const DB_NAME = 'ssa-db'
const LS_PREFIX = 'ssa:photos-meta:'

// ── Cloud key layout (must match PhotosTab.cloudKeys) ─────────────────────────
export const cloudKeys = (date, id) => ({
  original: `sessions/${date}/photos/${id}.jpg`,
  thumb: `sessions/${date}/photos/${id}_thumb.jpg`,
  meta: `sessions/${date}/photos/${id}_meta.json`,
  index: `sessions/${date}/photos.json`,
})
export const cloudImageUrl = (key) => `/api/bunny/image?key=${encodeURIComponent(key)}`

// ── Connection gate — `good` ⇒ ok to push heavy originals ─────────────────────
export function connectionIsGood() {
  if (typeof navigator === 'undefined') return false
  const online = navigator.onLine !== false
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null
  if (!c) return online // no Network Information API (e.g. Safari) → trust onLine
  const type = c.type
  const eff = c.effectiveType
  const saveData = !!c.saveData
  return online && !saveData && (type === 'wifi' || type === 'ethernet' || (!type && eff === '4g') || eff === '4g')
}

// ── IndexedDB blob store (shared schema with PhotosTab) ───────────────────────
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('videos')) {
        const s = db.createObjectStore('videos', { keyPath: 'id' })
        s.createIndex('sessionDate', 'sessionDate', { unique: false })
        s.createIndex('addedAt', 'addedAt', { unique: false })
        s.createIndex('synced', 'syncedToDb', { unique: false })
      }
      if (!db.objectStoreNames.contains('log_data')) db.createObjectStore('log_data', { keyPath: 'date' })
      if (!db.objectStoreNames.contains('xml_data')) db.createObjectStore('xml_data', { keyPath: 'date' })
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' })
    }
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = (e) => reject(e.target.error)
  })
}
async function idbPutPhoto(id, blob) {
  const db = await openDb()
  return new Promise((res, rej) => {
    const tx = db.transaction('photos', 'readwrite')
    const r = tx.objectStore('photos').put({ id, blob })
    r.onsuccess = () => res()
    r.onerror = () => rej(r.error)
  })
}
export async function idbGetPhoto(id) {
  const db = await openDb()
  return new Promise((res, rej) => {
    const tx = db.transaction('photos', 'readonly')
    const r = tx.objectStore('photos').get(id)
    r.onsuccess = () => res(r.result?.blob || null)
    r.onerror = () => rej(r.error)
  })
}

// ── Image helpers (thumbnail, EXIF, HEIC→JPEG) ────────────────────────────────
function generateThumbnail(blob, maxSize = 480, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight
      const scale = Math.min(1, maxSize / Math.max(w, h))
      const tw = Math.max(1, Math.round(w * scale))
      const th = Math.max(1, Math.round(h * scale))
      const c = document.createElement('canvas')
      c.width = tw; c.height = th
      c.getContext('2d').drawImage(img, 0, 0, tw, th)
      c.toBlob((b) => { URL.revokeObjectURL(url); b ? resolve(b) : reject(new Error('thumb encode failed')) }, 'image/jpeg', quality)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('thumb load failed')) }
    img.src = url
  })
}

function loadExifr() {
  return new Promise((resolve, reject) => {
    if (window.exifr) return resolve(window.exifr)
    const s = document.createElement('script')
    s.src = 'https://unpkg.com/exifr@7.1.3/dist/full.umd.js'
    s.onload = () => resolve(window.exifr)
    s.onerror = reject
    document.head.appendChild(s)
  })
}
function loadHeic2any() {
  return new Promise((resolve, reject) => {
    if (window.heic2any) return resolve(window.heic2any)
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/heic2any/0.0.4/heic2any.min.js'
    s.onload = () => resolve(window.heic2any)
    s.onerror = reject
    document.head.appendChild(s)
  })
}
async function readExif(file) {
  try {
    const exifr = await loadExifr()
    const data = await exifr.parse(file, { tiff: true, exif: true, gps: true, ifd0: true })
    const dt = data?.DateTimeOriginal || data?.DateTime
    const utc = dt instanceof Date ? dt.getTime() : null
    return { utc, lat: data?.latitude || null, lon: data?.longitude || null, camera: data?.Model || null }
  } catch { return { utc: null, lat: null, lon: null, camera: null } }
}
async function convertToJpeg(file) {
  if (file.type === 'image/jpeg') return file
  const isHeic = file.type === 'image/heic' || file.type === 'image/heif' || /\.(heic|heif)$/i.test(file.name)
  if (isHeic) {
    const heic2any = await loadHeic2any()
    const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 })
    return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      c.getContext('2d').drawImage(img, 0, 0)
      c.toBlob((b) => { URL.revokeObjectURL(url); b ? resolve(new File([b], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })) : reject(new Error('jpeg encode failed')) }, 'image/jpeg', 0.92)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}

// ── Per-date metadata persistence ─────────────────────────────────────────────
const lsKey = (date) => `${LS_PREFIX}${date}`
const stripLocal = (p) => { const { objectUrl, hasLocalOriginal, ...meta } = p; return meta }
export function loadDay(date) {
  try { return JSON.parse(localStorage.getItem(lsKey(date)) || '[]') } catch { return [] }
}
function saveDay(date, list) {
  try { localStorage.setItem(lsKey(date), JSON.stringify(list.map(stripLocal))) } catch (e) { console.error('photoStore.saveDay', e) }
}
function patchDay(date, photo) {
  const list = loadDay(date)
  const i = list.findIndex((p) => p.id === photo.id)
  if (i >= 0) list[i] = { ...list[i], ...stripLocal(photo) }
  else list.push(stripLocal(photo))
  saveDay(date, list)
}
function listPhotoDates() {
  const out = []
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(LS_PREFIX)) out.push(k.slice(LS_PREFIX.length)) } } catch {}
  return out
}

// Local calendar date (YYYY-MM-DD) of a capture instant; fallback = today.
function dateOf(utc) {
  const d = utc ? new Date(utc) : new Date()
  const z = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`
}

const isImage = (f) => f.type?.startsWith('image/') || /\.(jpg|jpeg|png|heic|heif|webp)$/i.test(f.name)

// ── Tagging at import (parity with video auto-tags) ───────────────────────────
function nearestLogRow(rows, utc, maxMs = 300000) {
  if (!rows?.length || !utc) return null
  let lo = 0, hi = rows.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].utc < utc) lo = mid + 1; else hi = mid }
  if (lo > 0 && Math.abs(rows[lo - 1].utc - utc) < Math.abs(rows[lo].utc - utc)) lo--
  return Math.abs(rows[lo].utc - utc) < maxMs ? rows[lo] : null
}
function activeSailsAt(evts, utc) {
  if (!evts?.length || !utc) return []
  return evts.filter((s) => s.utc <= utc).sort((a, b) => b.utc - a.utc)[0]?.sails || []
}
function raceTagsAt(xml, utc) {
  if (!xml || !utc) return []
  const B = 120000, tags = []
  for (const m of (xml.markRoundings || [])) if (Math.abs(m.utc - utc) <= B) tags.push(m.isTop ? 'topmark' : 'mark')
  for (const g of (xml.raceGuns || [])) if (Math.abs(g.utc - utc) <= B) tags.push('race-start')
  for (const tj of (xml.tackJibes || [])) { if (tj.isValid === false) continue; if (Math.abs(tj.utc - utc) <= B) tags.push(tj.isTack ? 'tack' : 'gybe') }
  return [...new Set(tags)]
}
// Mutates `photo` in place: instrument snapshot + sails/race/location tags, and
// bundles them into `analysis` so the Supabase mirror (upsertPhotoCloud) carries
// the tags cross-device. Mirrors PhotosTab.enrichPhoto.
function enrichInto(photo, log, xml) {
  if (log?.rows?.length && photo.utc) {
    const row = nearestLogRow(log.rows, photo.utc)
    if (row) { photo.tws = row.tws; photo.twa = row.twa; photo.awa = row.awa; photo.bsp = row.bsp; photo.heel = row.heel; photo.vmg = row.vmg }
  }
  if (xml) {
    photo.sails = activeSailsAt(xml.sailsUpEvents, photo.utc)
    photo.raceTags = raceTagsAt(xml, photo.utc)
    photo.boat = xml.meta?.boat || null
    photo.location = xml.meta?.location || null
  }
  photo.analysis = {
    sails: photo.sails || [], raceTags: photo.raceTags || [], boat: photo.boat || null, location: photo.location || null,
    inst: { tws: photo.tws ?? null, twa: photo.twa ?? null, awa: photo.awa ?? null, bsp: photo.bsp ?? null, heel: photo.heel ?? null, vmg: photo.vmg ?? null },
  }
  return photo
}

function dispatchSaved(id, date) {
  try { window.dispatchEvent(new CustomEvent('ssa:photo-saved', { detail: { id, date, source: 'upload' } })) } catch {}
}

// ── Public: import dropped/selected files ─────────────────────────────────────
// Stores each blob + per-date meta (cloudSynced/thumbSynced/originalSynced all
// false). Returns the new photo metas (with a local objectUrl for preview).
export async function importFiles(files, { onLog } = {}) {
  const imgs = Array.from(files).filter(isImage)
  if (!imgs.length) { onLog?.('No image files found'); return [] }
  const out = []
  for (const file of imgs) {
    try {
      const exif = await readExif(file)
      let jpeg
      try { jpeg = await convertToJpeg(file) } catch { jpeg = file }
      const id = `p_${Date.now()}_${Math.random().toString(36).slice(2)}`
      await idbPutPhoto(id, jpeg)
      const sessionDate = dateOf(exif.utc)
      const photo = {
        id, name: file.name, size: jpeg.size, utc: exif.utc || null,
        lat: exif.lat || null, lon: exif.lon || null, exif,
        sessionDate, objectUrl: URL.createObjectURL(jpeg),
        thumbnailUrl: null, bunnyPath: null,
        cloudSynced: false, thumbSynced: false, originalSynced: false, addedAt: Date.now(),
      }
      // Tag from the day's log/event file if it's already local (e.g. imported in
      // the same Upload session) — so the thumbnail uploads WITH tags.
      try {
        const [log, xml] = await Promise.all([getLogData(sessionDate).catch(() => null), getXmlData(sessionDate).catch(() => null)])
        if (log || xml) enrichInto(photo, log, xml)
      } catch { /* tags fill in later in the Photos tab */ }
      patchDay(sessionDate, photo)
      out.push(photo)
      onLog?.(`✓ ${file.name.slice(0, 28)} → ${sessionDate}`)
    } catch (e) { onLog?.(`✕ ${file.name.slice(0, 20)}: ${e.message}`) }
  }
  return out
}

async function getCreds() {
  return fetch('/api/storage/credentials').then((r) => r.json())
}
async function writeMeta(photo) {
  const keys = cloudKeys(photo.sessionDate, photo.id)
  await uploadJsonToStorage(keys.meta, stripLocal(photo))
}

// Upload the small thumbnail (immediate, any connection). Marks thumb/cloud
// synced, sets thumbnailUrl, and fires the Supabase mirror event.
export async function uploadThumb(photo) {
  const blob = await idbGetPhoto(photo.id)
  if (!blob) throw new Error('no local blob')
  const keys = cloudKeys(photo.sessionDate, photo.id)
  const { accessKey, zone, host } = await getCreds()
  const thumb = await generateThumbnail(blob, 480, 0.78)
  const res = await fetch(`${host}/${zone}/${keys.thumb}`, { method: 'PUT', headers: { AccessKey: accessKey, 'Content-Type': 'image/jpeg' }, body: thumb })
  if (!res.ok && res.status !== 201) throw new Error(`thumb HTTP ${res.status}`)
  const updated = { ...photo, thumbnailUrl: cloudImageUrl(keys.thumb), thumbSize: thumb.size, thumbSynced: true, cloudSynced: true }
  patchDay(updated.sessionDate, updated)
  try { await writeMeta(updated) } catch {}
  dispatchSaved(updated.id, updated.sessionDate)
  return updated
}

// Upload the full-resolution original (deferred — caller gates on connection).
export async function uploadOriginal(photo) {
  const blob = await idbGetPhoto(photo.id)
  if (!blob) throw new Error('no local blob')
  const keys = cloudKeys(photo.sessionDate, photo.id)
  const { accessKey, zone, host } = await getCreds()
  const res = await fetch(`${host}/${zone}/${keys.original}`, { method: 'PUT', headers: { AccessKey: accessKey, 'Content-Type': 'image/jpeg' }, body: blob })
  if (!res.ok && res.status !== 201) throw new Error(`img HTTP ${res.status}`)
  const updated = { ...photo, bunnyPath: keys.original, originalSize: blob.size, originalSynced: true }
  patchDay(updated.sessionDate, updated)
  try { await writeMeta(updated) } catch {}
  dispatchSaved(updated.id, updated.sessionDate)
  return updated
}

// Sync one photo: thumb if missing (always), original if missing (gated unless
// force). Returns the updated photo.
export async function syncPhoto(photo, { force = false } = {}) {
  let p = photo
  if (!p.thumbSynced) p = await uploadThumb(p)
  if (!p.originalSynced && (force || connectionIsGood())) p = await uploadOriginal(p)
  return p
}

// Flush every not-fully-synced photo across all date buckets. Thumbnails always
// go; originals only when `force` or the connection is good. Returns counts.
export async function syncPending({ force = false, onLog } = {}) {
  let thumbs = 0, originals = 0, failed = 0, deferred = 0
  for (const date of listPhotoDates()) {
    for (const p of loadDay(date)) {
      if (p.thumbSynced && p.originalSynced) continue
      try {
        const before = { thumb: p.thumbSynced, orig: p.originalSynced }
        const after = await syncPhoto(p, { force })
        if (!before.thumb && after.thumbSynced) thumbs++
        if (!before.orig && after.originalSynced) originals++
        if (!after.originalSynced) deferred++
      } catch (e) { failed++; onLog?.(`✕ ${p.name?.slice(0, 18) || p.id}: ${e.message}`) }
    }
  }
  return { thumbs, originals, deferred, failed }
}
