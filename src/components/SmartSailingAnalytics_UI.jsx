'use client'
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { saveVideo, pruneInertVideos, dedupeVideos, updateVideoRotation, getAllVideos, getAllVideosForMembership, getVideosForDate, updateVideoTags, updateVideoStartUtc, deleteVideo, saveLogData, getLogData, saveXmlData, getXmlData, computeAutoTags, getSessions, getSessionsForMembership, getUnsyncedCount, markCloudSynced, getTagList, saveTagList, mergeTagList } from "../lib/localStore";
import { deleteStreamVideo, updateCloudSessionMetadata, checkCloudStatus, syncSessionToCloud, fetchCloudSession, listR2Sessions, waitForStreamReady, createStreamUpload, uploadFileToStream } from "../lib/bunny";
import dynamic from 'next/dynamic';
import { POLAR_KEY, savePolarToLS, loadPolarFromLS, parsePolarFile,
  buildSpline, evalSpline, goldenMax, preparePolar,
  polarInterp, polarVMGTarget, polarPerf, perfColor } from '../lib/polarCalc';
import { getBrowserSupabase } from '../lib/supabase/browser';
import { parseLog } from '../lib/logParse';
import { offsetFromCoords } from '../lib/tzFromCoords';
import { prefetchBoatConfig } from '../lib/boatConfigPrefetch';
import { reconcileSessionSyncState } from '../lib/syncReconcile';
import { requestPersistentStorage } from '../lib/storagePersist';
import { startAutoFlush as startPhotoAutoFlush } from '../lib/photoStore';
import { parseXmlEvents } from '../lib/xmlEventParse';
import { fetchTagList as cloudFetchTagList, saveTagListCloud, mergeTagListCloud } from '../lib/cloud-tag-list';
import { listSessionsCloud, getSessionCloud, saveLogDataCloud, saveXmlDataCloud } from '../lib/cloud-sessions';
import { listVideosCloud, upsertVideoCloud, deleteVideosCloud, makeVideoMirrorCallback, toLegacyVideoShape, ensureCloudVideoId, isCloudVideoId } from '../lib/cloud-videos';
import { syncProxyForVideo } from '../lib/video-rendition-sync';
import { getVideoBlob, updateVideoBlobAndDuration } from '../lib/localStore';
import { cropVideo } from '../lib/video-crop';
import { listPhotosCloud, upsertPhotoCloud, toLegacyPhotoShape } from '../lib/cloud-photos';
import { importFiles as importPhotoFiles, syncPhoto as syncOnePhoto, syncPending as syncPendingPhotos, connectionIsGood as photoConnGood } from '../lib/photoStore';
import { getActiveMembership } from '../lib/active-membership';
import { unmatchedSails } from '../lib/sailResolve';
import SailListDiffModal from './SailListDiffModal';
import { ErrorBoundary } from './ui';
import { buildDayTimeline } from '../lib/timeline/buildNodes';

// ── Lazy-loaded tab components ──────────────────────────────────────────────
// Each ships as its own JS chunk the browser downloads only when the user
// first opens that tab — keeps the initial app bundle small (matters on
// phones / slow wifi). A user whose role hides a tab can never open it, so
// its chunk is simply never downloaded for them.
const TabLoading = () => (
  <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",minHeight:240,color:"#475569",fontSize:13}}>Loading…</div>
);
const PhotosTab      = dynamic(() => import("./PhotosTab"),      { ssr:false, loading:TabLoading });
const SquashShotsApp = dynamic(() => import("./SquashShotsApp"), { ssr:false, loading:TabLoading });
const SailScanTab    = dynamic(() => import("./SailScanTab"),    { ssr:false, loading:TabLoading });
const AdminTab       = dynamic(() => import("./AdminTab"),       { ssr:false, loading:TabLoading });
const CampaignTab    = dynamic(() => import("./CampaignTab"),    { ssr:false, loading:TabLoading });
const BoatConfigTab  = dynamic(() => import("./BoatConfigTab"),  { ssr:false, loading:TabLoading });
const WeatherTab     = dynamic(() => import("./WeatherTab"),     { ssr:false, loading:TabLoading });
const TimelineTab    = dynamic(() => import("./timeline/TimelineTab"), { ssr:false, loading:TabLoading });

// Connection quality, for network-aware auto-sync. `good` (wifi/ethernet/4g,
// not Save-Data) gates the HEAVY push (videos); `online` gates the light pull.
// Falls back to "usable" when the Network Information API is unavailable (iOS).
function connInfo() {
  const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  const c = typeof navigator !== "undefined" ? (navigator.connection || navigator.mozConnection || navigator.webkitConnection) : null;
  if (!c) return { online, good: online, metered: false };
  const type = c.type; const eff = c.effectiveType; const saveData = !!c.saveData;
  const good = online && !saveData && (type === "wifi" || type === "ethernet" || (!type && eff === "4g") || eff === "4g");
  const metered = type === "cellular" || saveData;
  return { online, good, metered, type, eff };
}

// Is this link actually Wi-Fi (or ethernet)?
//
// Deliberately stricter than connInfo().good, which counts "4g" as good — that's a
// cellular data plan, and video is the one payload big enough to burn it. Phone clips
// are smaller than a GoPro's, but a session is still hundreds of MB.
//
// When the Network Information API isn't available (iOS Safari, Firefox) we CANNOT
// prove the link is unmetered, so we return false and leave it to the manual Upload
// button. Failing closed costs a tap; failing open costs the user's data.
function onWifi() {
  if (typeof navigator === "undefined") return false;
  if (navigator.onLine === false) return false;
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c || c.saveData) return false;
  return c.type === "wifi" || c.type === "ethernet";
}

// Sync offset persistence — inline to avoid module resolution issues
const OFFSET_KEY = "ssa:syncOffsets";
function getSyncOffsets() { try { const v=localStorage.getItem(OFFSET_KEY); return v?JSON.parse(v):{};} catch{return{};} }
function saveSyncOffset(videoId, secs) { try { const o=getSyncOffsets(); if(secs===0){delete o[videoId];}else{o[videoId]=secs;} localStorage.setItem(OFFSET_KEY,JSON.stringify(o));} catch{} }

// Phase 2 — pending originals upload state. When the originals queue creates
// a Bunny Stream video object but the (resumable) TUS upload doesn't finish,
// we keep its GUID keyed by local video id. A later run reuses the same
// Stream video so tus-js-client resumes the upload instead of restarting it.
// Cleared once the upload completes.
const PENDING_ORIG_KEY = "ssa:pendingOrigStream";
function getPendingOrigStreams() { try { const v=localStorage.getItem(PENDING_ORIG_KEY); return v?JSON.parse(v):{};} catch{return{};} }
function getPendingOrigStream(videoId) { return getPendingOrigStreams()[videoId] || null; }
function setPendingOrigStream(videoId, streamId) { try { const o=getPendingOrigStreams(); o[videoId]=streamId; localStorage.setItem(PENDING_ORIG_KEY,JSON.stringify(o));} catch{} }
function clearPendingOrigStream(videoId) { try { const o=getPendingOrigStreams(); delete o[videoId]; localStorage.setItem(PENDING_ORIG_KEY,JSON.stringify(o));} catch{} }

// ─── VIDEO CREATION TIME ─────────────────────────────────────────────────────
// Scan a buffer for the `mvhd` atom and return its creation_time in ms (UTC).
// MP4 stores creation_time as seconds since 1904-01-01 UTC.
// Returns null if not found.
function _scanMvhd(buf) {
  const view = new DataView(buf);
  const u8   = new Uint8Array(buf);
  for (let i = 0; i < u8.length - 12; i++) {
    if (u8[i]===0x6d&&u8[i+1]===0x76&&u8[i+2]===0x68&&u8[i+3]===0x64) {
      const version = view.getUint8(i+4);
      let secs;
      if (version===1) {
        const hi = view.getUint32(i+8);
        const lo = view.getUint32(i+12);
        secs = hi * 4294967296 + lo;
      } else {
        secs = view.getUint32(i+8);
      }
      const unix = secs - 2082844800;
      if (unix > 0 && unix < 4102444800) return unix * 1000;
    }
  }
  return null;
}

// Rotation is applied at DISPLAY, never baked into the file. 90/270 swap the aspect,
// so the element is rotated about its centre and scaled to fit the box.
const rotStyle = (deg, boxW, boxH) => {
  const d = ((Number(deg) || 0) % 360 + 360) % 360;
  if (!d) return {};
  const quarter = d === 90 || d === 270;
  const scale = quarter && boxW && boxH ? Math.min(boxW / boxH, boxH / boxW) : 1;
  return { transform: `rotate(${d}deg)${quarter ? ` scale(${scale.toFixed(3)})` : ''}` };
};

// ─── Camera identity from the container's own metadata ───────────────────────
// Filename sniffing (detectCamera) is a guess: it breaks the moment a file is renamed
// or exported. The container states who made it — Apple writes
// com.apple.quicktime.make/model ("Apple" / "iPhone 15 Pro"), DJI and GoPro write their
// own make/model or handler strings. Knowing the SOURCE is what lets us treat the
// timestamp correctly (an iPhone's capture date is authoritative; a GoPro's mvhd is
// local), so read it rather than infer it.
function _scanCameraMeta(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  const CHUNK = 65536;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
  }
  const after = (key) => {
    const i = s.indexOf(key);
    if (i < 0) return null;
    // The value follows within the next ilst 'data' box; grab the nearest run of
    // printable ASCII after the key and strip the box header bytes.
    const seg = s.slice(i + key.length, i + key.length + 96);
    const m = seg.match(/[\x20-\x7e]{3,}/g);
    if (!m) return null;
    const val = m.map((x) => x.replace(/^[^\w]*data/i, '').trim()).find((x) => x.length >= 3);
    return val ? val.replace(/[^\x20-\x7e]/g, '').trim() : null;
  };
  const make = after('com.apple.quicktime.make') || after('©mak') || null;
  const model = after('com.apple.quicktime.model') || after('©mod') || null;
  const sw = after('com.apple.quicktime.software') || null;

  let vendor = null;
  const hay = `${make || ''} ${model || ''} ${sw || ''}`.toLowerCase();
  if (/apple|iphone|ipad/.test(hay)) vendor = 'iPhone';
  else if (/dji|osmo|mavic|air ?\d|mini ?\d/.test(hay)) vendor = 'DJI';
  else if (/gopro|hero/.test(hay)) vendor = 'GoPro';
  else if (/insta360/.test(hay)) vendor = 'Insta360';
  return { vendor, make, model, software: sw };
}

// ─── Apple `com.apple.quicktime.creationdate` (Keys:CreationDate) ─────────────
// THE authoritative capture time on an iPhone, and the one we were ignoring.
//
//   • mvhd / QuickTime:CreateDate — UTC, but carries NO timezone, and on a
//     re-encoded file it's whatever the encoder wrote.
//   • Keys:CreationDate — the recording's LOCAL wall-clock WITH an explicit UTC
//     offset, e.g. "2026-07-12T14:32:07+0200". Apple authors it on capture, it has
//     seconds, and per ExifTool it OVERRIDES the other time tags.
//
// So we don't have to infer local-vs-UTC for Apple footage at all: the offset is in
// the file. It's stored as an ISO-8601 string inside moov→meta→ilst, so rather than
// walk the atom tree we scan for the string itself — cheap, and robust to the exact
// ilst layout (which differs between iOS versions and Photos exports).
function _scanAppleCreationDate(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const fourcc = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

  // Walk the boxes at one level, calling fn(type, payloadStart, payloadEnd).
  const walk = (from, to, fn) => {
    let o = from;
    while (o + 8 <= to) {
      let size = dv.getUint32(o);
      const type = fourcc(o + 4);
      let hdr = 8;
      if (size === 1) { // 64-bit size
        if (o + 16 > to) break;
        size = Number(dv.getBigUint64(o + 8));
        hdr = 16;
      } else if (size === 0) {
        size = to - o; // extends to end
      }
      if (size < hdr || o + size > to) break;
      if (fn(type, o + hdr, o + size) === false) return;
      o += size;
    }
  };

  // Find moov → meta → { keys, ilst }. `meta` is a FullBox in MP4 (4 bytes of
  // version/flags) but a plain box in some QuickTime files — detect which by peeking
  // at whether a sane child box follows immediately.
  let keysBox = null, ilstBox = null;
  const findMeta = (from, to) => {
    walk(from, to, (type, ps, pe) => {
      if (type === 'moov' || type === 'udta') { findMeta(ps, pe); return; }
      if (type !== 'meta') return;
      let inner = ps;
      const looksLikeBox = (o) => {
        if (o + 8 > pe) return false;
        const sz = dv.getUint32(o);
        return sz >= 8 && o + sz <= pe && /^[a-zA-Z0-9 ©-]{4}$/.test(fourcc(o + 4));
      };
      if (!looksLikeBox(inner) && looksLikeBox(inner + 4)) inner += 4; // skip version/flags
      walk(inner, pe, (t2, s2, e2) => {
        if (t2 === 'keys') keysBox = [s2, e2];
        if (t2 === 'ilst') ilstBox = [s2, e2];
      });
    });
  };
  findMeta(0, u8.length);
  if (!keysBox || !ilstBox) return null;

  // keys: version/flags(4) + entry_count(4), then entries of size(4) + namespace(4) + name
  const keyNames = [];
  {
    let o = keysBox[0] + 8;
    while (o + 8 <= keysBox[1]) {
      const sz = dv.getUint32(o);
      if (sz < 8 || o + sz > keysBox[1]) break;
      let name = '';
      for (let i = o + 8; i < o + sz; i++) name += String.fromCharCode(u8[i]);
      keyNames.push(name); // 1-based index in ilst
      o += sz;
    }
  }
  const wanted = keyNames.findIndex((n) => n === 'com.apple.quicktime.creationdate');
  if (wanted < 0) return null;
  const wantedIndex = wanted + 1; // ilst items are 1-based

  // ilst: items are size(4) + index(4), each containing a 'data' box:
  //       size(4) + 'data' + type(4) + locale(4) + payload
  let iso = null;
  walk(ilstBox[0], ilstBox[1], (type, ps, pe) => {
    // `type` here is the 4-byte INDEX, not a fourcc — read it as a number.
    const idx = dv.getUint32(ps - 4);
    if (idx !== wantedIndex) return;
    walk(ps, pe, (t2, s2, e2) => {
      if (t2 !== 'data') return;
      let str = '';
      for (let i = s2 + 8; i < e2; i++) str += String.fromCharCode(u8[i]); // skip type+locale
      iso = str.trim();
      return false;
    });
    return false;
  });
  if (!iso) return null;

  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, zone] = m;
  let offMin = 0;
  if (zone !== 'Z') {
    const zm = zone.replace(':', '');
    const sign = zm[0] === '-' ? -1 : 1;
    offMin = sign * (Number(zm.slice(1, 3)) * 60 + Number(zm.slice(3, 5)));
  }
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
  const utc = wall - offMin * 60000; // local wall-clock − its own offset ⇒ true UTC
  if (!Number.isFinite(utc) || utc < 946684800000 || utc > 4102444800000) return null;
  return { utc, local: `${y}-${mo}-${d}T${h}:${mi}:${sec}`, offsetMin: offMin, raw: iso };
}


// Parse a timestamp out of common camera filename conventions.
// Handles:
//   DJI_20250903122919_0041_A2_drop.mp4          → DJI drones / Osmo (local time)
//   GX010041.MP4, GH010041.mp4                   → GoPro (no timestamp in name)
//   IMG_20250903_122919.mp4, VID_20250903_122919 → Android / generic
//   20250903_122919.mp4                          → raw datetime
// Returns ms in UTC *before* any vidTz adjustment by the caller (camera local time
// is interpreted as the selected video timezone just like the mvhd path).
function extractTimestampFromFilename(name) {
  if (!name) return null;
  // YYYYMMDDHHMMSS (14 digits in a row) — DJI
  let m = name.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) {
    // YYYYMMDD[_-]HHMMSS — Android / generic
    m = name.match(/(\d{4})(\d{2})(\d{2})[_\-T ]?(\d{2})(\d{2})(\d{2})/);
  }
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

// ─── CAN THE BROWSER ACTUALLY DECODE THIS CLIP? ──────────────────────────────
// Everything downstream assumes it can: the card thumbnail is a <video> showing the
// first frame, playback is a <video>, and the proxy transcode has to DECODE the source
// before it can encode. A file the browser can't decode therefore shows up as a black
// card, black playback, and a transcode that dies — with nothing saying why.
//
// Phones commonly record H.265/HEVC (and HDR), which many browsers won't decode. So
// probe once, at import, and report it in plain words instead of leaving three
// downstream features to fail mysteriously.
function probeVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      try { URL.revokeObjectURL(url); } catch {}
      resolve(res);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timed out reading the video (10 s)' }), 15000);
    v.onloadedmetadata = () => {
      const w = v.videoWidth, h = v.videoHeight;
      // Metadata parsed but no picture ⇒ the container is readable, the VIDEO CODEC is
      // not. That is the H.265/HEVC case: black frames, and an undecodable transcode.
      if (!w || !h) {
        clearTimeout(timer);
        finish({ ok: false, duration: v.duration, reason: 'this device’s browser cannot decode the video track (often H.265/HEVC) — record in H.264, or the clip will be black' });
        return;
      }
      // DURATION. On many MP4/MOV files (notably re-encoded ones, where `moov` moved)
      // `duration` is still Infinity/NaN at loadedmetadata — which is why the import
      // reported `duration=0s`, and why the one number that distinguishes a
      // start-of-recording stamp from an end-of-recording one was missing. Seeking far
      // past the end forces the browser to resolve it, then `durationchange` fires with
      // the real value. This is the standard workaround.
      const done = () => {
        clearTimeout(timer);
        const d = Number.isFinite(v.duration) ? v.duration : 0;
        finish({ ok: true, width: w, height: h, duration: d });
      };
      if (Number.isFinite(v.duration) && v.duration > 0) { done(); return; }
      v.ondurationchange = () => { if (Number.isFinite(v.duration)) { v.ondurationchange = null; try { v.currentTime = 0; } catch {} done(); } };
      try { v.currentTime = 1e101; } catch { done(); }
    };
    v.onerror = () => {
      clearTimeout(timer);
      const code = v.error?.code;
      finish({
        ok: false,
        reason: code === 4
          ? 'unsupported video format or codec (often H.265/HEVC) — record in H.264'
          : `could not read the video (media error ${code ?? '?'})`,
      });
    };
    v.preload = 'metadata';
    v.muted = true;
    v.src = url;
  });
}

// Returns { utc, source, mvhdUtc, nameUtc } | null.
//   source  — "mp4-meta" | "filename"
//   mvhdUtc — raw mvhd clock (may be true UTC or camera-local; see resolveStartUtc)
//   nameUtc — raw filename clock, ALWAYS camera-local. Returned even when mvhd
//             won, because the gap between the two is what lets us tell whether
//             this camera's mvhd is spec-correct UTC or local wall-clock.
async function extractVideoCreationTime(file) {
  const nameUtc = extractTimestampFromFilename(file.name || "");
  try {
    // moov can sit at either end: iPhone recordings put it at the END; Photos exports
    // and re-muxes often move it to the front. Read both and search each.
    const head = await file.slice(0, 1048576).arrayBuffer();
    const tail = file.size > 1048576
      ? await file.slice(Math.max(0, file.size - 2097152), file.size).arrayBuffer()
      : null;

    // 1) APPLE first. Keys:CreationDate is the recording's local time WITH its offset —
    //    unambiguous, to the second, and authoritative. Reading it means we never have
    //    to guess local-vs-UTC for iPhone footage.
    // Who shot it? Read it from the container rather than guessing at the filename.
    const camHead = _scanCameraMeta(head);
    const camTail = tail ? _scanCameraMeta(tail) : { vendor: null };
    const cam = camHead.vendor ? camHead : (camTail.vendor ? camTail : camHead);

    const apple = _scanAppleCreationDate(head) || (tail ? _scanAppleCreationDate(tail) : null);
    if (apple) {
      return {
        utc: apple.utc,                 // already TRUE UTC — the file told us the offset
        source: "apple-meta",
        appleLocal: apple.local,
        appleOffsetMin: apple.offsetMin,
        mvhdUtc: _scanMvhd(head) || (tail ? _scanMvhd(tail) : null),
        nameUtc,
        camera: cam,
      };
    }

    // 2) mvhd — UTC per spec, but GoPro/DJI write local. Ambiguous; resolveStartUtc
    //    works it out from the filename / log window.
    //    `appleLikely`: an Apple-authored container that has NO Keys:CreationDate has
    //    been re-encoded — most often by QuickTime Player's rotate — so its mvhd is the
    //    edit time. Flagged, not trusted.
    // An APPLE-shot file with no Keys:CreationDate has been re-encoded (QuickTime
    // rotate), so its mvhd is the edit time. Use the container's own vendor when we have
    // it, and fall back to the extension only when the metadata is silent.
    const appleLikely = cam.vendor === 'iPhone'
      || (!cam.vendor && (/\.(mov|m4v)$/i.test(file.name || '') || /quicktime/i.test(file.type || '')));
    const mvhd = _scanMvhd(head) || (tail ? _scanMvhd(tail) : null);
    if (mvhd) return { utc: mvhd, source: "mp4-meta", mvhdUtc: mvhd, nameUtc, appleLikely, camera: cam };

    // 3) Filename fallback — DJI / Android embed the capture time in the name.
    if (nameUtc) return { utc: nameUtc, source: "filename", mvhdUtc: null, nameUtc, camera: cam };
  } catch {}
  if (nameUtc) return { utc: nameUtc, source: "filename", mvhdUtc: null, nameUtc };
  return null;
}

// ─── mvhd: UTC or local? ─────────────────────────────────────────────────────
// The MP4 spec says mvhd.creation_time is UTC — and spec-compliant cameras write
// it that way. Action cams (GoPro, DJI) commonly write LOCAL wall-clock instead.
// Assuming either one blindly puts every clip a full timezone out (the 2026-07-11
// bug: a 14:32 clip landed at 12:32 because a true-UTC mvhd had vidTz subtracted
// from it a second time). So decide per FILE, from evidence:
//
//   1. Filename stamp — always local. If mvhd ≈ filename, mvhd is LOCAL; if mvhd
//      ≈ filename − vidTz, mvhd is UTC. Definitive whenever the name carries digits.
//   2. No filename stamp (e.g. GoPro GX010041.MP4) — try both candidates against
//      the loaded log's true-UTC window; take whichever lands inside it.
//   3. No evidence at all — trust the spec (UTC) and say so in the log, so a wrong
//      guess is visible and fixable in the Videos tab's start-time editor.
//
// `raw` is the clock digits read as if they were UTC. Returns the true-UTC start
// plus how we got there. localClock=true ⇒ vidTz was applied (and a later venue-tz
// change must re-base it); localClock=false ⇒ the clock was already UTC.
const TS_TOL_MS = 150000; // 2.5 min — camera clocks drift vs. the filename stamp
function resolveStartUtc(result, vidTz, logWindow, durationSec = 0) {
  const raw = result.utc;
  const asUtc = raw;                       // clock was already true UTC
  const asLocal = raw - vidTz * 60000;     // clock was camera-local
  const durMs = Math.max(0, Math.round((durationSec || 0) * 1000));

  // Apple told us the offset — nothing to infer. `utc` is already true UTC, so it must
  // NOT be re-based by the venue-tz selector (localClock:false).
  if (result.source === "apple-meta") {
    const off = result.appleOffsetMin;
    const sign = off >= 0 ? '+' : '-';
    const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
    const mm = String(Math.abs(off) % 60).padStart(2, '0');
    return {
      utc: raw,
      localClock: false,
      how: `iPhone capture time ${result.appleLocal} (UTC${sign}${hh}:${mm}) — from the file, no guessing`,
    };
  }

  // Filename + lastModified are unambiguously local wall-clock.
  if (result.source !== "mp4-meta") return { utc: asLocal, localClock: true, how: "local clock" };
  if (vidTz === 0) return { utc: raw, localClock: true, how: "UTC venue" }; // both agree; keep re-basable

  // 1) Calibrate against the filename, which is local BY DEFINITION and stamps the
  //    START of the recording. Both clocks are "digits read as if UTC", so:
  //      mvhd local ⇒ raw ≈ nameUtc            (same wall-clock digits)
  //      mvhd UTC   ⇒ raw ≈ nameUtc − vidTz    (mvhd runs vidTz behind the local name)
  //
  //    …UNLESS the camera stamps mvhd when the file is CLOSED rather than opened, in
  //    which case it sits one whole DURATION later. We placed such clips a duration too
  //    late: the overlay ran ~3 min ahead and the boat marker sat past the end of the
  //    clip. The filename (start) plus the probed duration prove it, so test for it —
  //    and only correct when the arithmetic actually matches.
  if (result.nameUtc != null) {
    // The FILENAME stamps the START of the recording (the camera names the file when it
    // opens it) and is local by definition. mvhd may be the start OR the moment the file
    // was finalised — one whole duration later.
    //
    // A ±2.5 min tolerance used to be enough to call an end-stamp "a match" for the
    // filename, and we then took mvhd — which is precisely how clips landed ~50 s late
    // on a 56 s recording. So work out mvhd's OFFSET FROM THE FILENAME START and act on
    // the size of it, rather than waving it through.
    const nameStart = result.nameUtc - vidTz * 60000; // filename is local ⇒ true UTC start
    const CLOCK_TOL = 5000;                            // genuine same-instant jitter

    const dLocal = raw - result.nameUtc;               // if mvhd is local wall-clock
    const dUtc = raw - nameStart;                      // if mvhd is already true UTC

    if (Math.abs(dLocal) <= CLOCK_TOL)
      return { utc: asLocal, localClock: true, how: "mvhd is local, same instant as the filename" };
    if (Math.abs(dUtc) <= CLOCK_TOL)
      return { utc: asUtc, localClock: false, how: "mvhd is UTC, same instant as the filename" };

    // mvhd sits LATER than the filename start. That is the finalisation time — the
    // recording's end (± encoder flush). The filename is the start, so use it, and say
    // by how much they differed so a wrong assumption is visible rather than silent.
    const lateBy = Math.min(Math.abs(dLocal), Math.abs(dUtc));
    if (lateBy > CLOCK_TOL) {
      const dur = durMs ? `${Math.round(durMs / 1000)}s clip` : 'duration unknown';
      return {
        utc: nameStart,
        localClock: true,
        how: `filename start used — mvhd is ${Math.round(lateBy / 1000)}s later (end-of-recording / finalisation; ${dur})`,
      };
    }
  }
  // 2) Fall back to whichever candidate lands inside the log's true-UTC window.
  //    The pad must stay TIGHTER than the offset we're trying to detect, or both
  //    candidates fit and the test tells us nothing.
  if (logWindow?.startUtc && logWindow?.endUtc) {
    const pad = 30 * 60000;
    const fits = (t) => t >= logWindow.startUtc - pad && t <= logWindow.endUtc + pad;
    const okUtc = fits(asUtc), okLocal = fits(asLocal);
    if (okUtc && !okLocal) return { utc: asUtc, localClock: false, how: "mvhd is UTC (fits log window)" };
    if (okLocal && !okUtc) return { utc: asLocal, localClock: true, how: "mvhd is local (fits log window)" };
  }
  // 3) No evidence. For an Apple-family file this is a RED FLAG rather than a default:
  //    an untouched iPhone clip always carries Keys:CreationDate. If it's gone, the file
  //    has been re-encoded — and QuickTime Player's rotate-and-save does exactly that,
  //    dropping the capture metadata and leaving mvhd holding the EDIT time. Trusting it
  //    silently plants a wrong start time that only shows up later as a drifting overlay.
  if (result.appleLikely) {
    return {
      utc: asUtc,
      localClock: false,
      suspect: true,
      how: "no iPhone capture date in this file — it was re-encoded (QuickTime rotate?), so this is the EDIT time, not the recording time. Set the start manually in Videos.",
    };
  }
  return { utc: asUtc, localClock: false, how: "mvhd assumed UTC (per spec — verify in Videos)" };
}

const ROLES = {
  admin:      { label:"Admin",      canImport:true,  canSync:true,  seeLocal:true, canDelete:true  },
  coach:      { label:"Coach",      canImport:true,  canSync:true,  seeLocal:true, canDelete:true  },
  crew:       { label:"Crew",       canImport:true,  canSync:false, seeLocal:true, canDelete:false },
  viewer:     { label:"Viewer",     canImport:false, canSync:false, seeLocal:false,canDelete:false },
  consultant: { label:"Consultant", canImport:false, canSync:false, seeLocal:false,canDelete:false },
};

// parseNmea / expToUtc / parseCsvLog moved to src/lib/csvLogParse.js (shared
// with the N72 backfill CLI).

const TZ_OPTIONS = [
  { label:"UTC+0  (UTC / UK winter / Portugal summer)", offsetMin: 0   },
  { label:"UTC+1  (CET / BST / UK summer / W.Europe winter)", offsetMin: 60  },
  { label:"UTC+2  (CEST / Central Europe summer — default)", offsetMin: 120 },
  { label:"UTC+3  (EEST / Eastern Europe summer)", offsetMin: 180 },
  { label:"UTC-1  (Azores summer)", offsetMin: -60  },
  { label:"UTC-3  (Brazil / Argentina)", offsetMin: -180 },
  { label:"UTC-4  (US Eastern summer / AST)", offsetMin: -240 },
  { label:"UTC-5  (US Eastern winter / EST)", offsetMin: -300 },
];
const DEFAULT_TZ = 120;

// ─── MOBILE DETECTION ─────────────────────────────────────────────────────────
// True when the device is a phone/tablet — drives a completely different UI shell.
// We use both UA sniffing (reliable for iOS/Android) and screen width as fallback.
function useIsMobile(){
  const [mobile, setMobile] = React.useState(()=>{
    if(typeof window==="undefined") return false;
    const ua = navigator.userAgent||"";
    const isPhone = /iPhone|Android.*Mobile|IEMobile|BlackBerry/i.test(ua);
    const isTablet = /iPad|Android(?!.*Mobile)/i.test(ua);
    return isPhone || isTablet || window.innerWidth < 768;
  });
  React.useEffect(()=>{
    const ua = navigator.userAgent||"";
    const isPhone = /iPhone|Android.*Mobile|IEMobile|BlackBerry/i.test(ua);
    const isTablet = /iPad|Android(?!.*Mobile)/i.test(ua);
    // A phone/tablet is ALWAYS the mobile layout — never width-track it.
    // Previously the resize handler set mobile = matchMedia('max-width:767px'),
    // so rotating a phone to landscape (width > 767) flipped the whole app to
    // the desktop layout, unmounting the mobile player mid-playback. Only a
    // non-touch device (desktop in a narrow window) should follow the width.
    if(isPhone || isTablet){ setMobile(true); return; }
    const mq = window.matchMedia("(max-width:767px)");
    const handler = e => setMobile(e.matches);
    setMobile(mq.matches);
    mq.addEventListener("change", handler);
    return ()=>mq.removeEventListener("change", handler);
  },[]);
  return mobile;
}

// Inject mobile-specific CSS once (touch targets, overscroll, safe areas)
let _mobileStyleInjected = false;
function injectMobileCSS(){
  if(_mobileStyleInjected||typeof document==="undefined") return;
  _mobileStyleInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .ssa-mobile { -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
    .ssa-mobile * { -webkit-overflow-scrolling:touch; }
    .ssa-mobile input, .ssa-mobile button, .ssa-mobile select { font-size:16px !important; }
    .ssa-mobile video { object-fit:contain; }
    .ssa-mob-card { min-height:44px; }
    @supports(padding:env(safe-area-inset-bottom)){
      .ssa-mob-bottom-nav { padding-bottom:env(safe-area-inset-bottom); }
    }
    @keyframes ssa-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(s);
}

// expToUtc + parseCsvLog moved to src/lib/csvLogParse.js.

// Build a compact cloud copy of a parsed log. A full session log is tens of
// MB (~65k rows) — over the Supabase upload route's request-size limit, and
// slow to load on phones. The cloud copy is trimmed to the on-water window
// (from the event file's timestamps, or — when there's no event file — from
// when the boat actually starts and stops moving) and downsampled so it
// never exceeds ~7000 rows, keeping at least 1s between rows (1 Hz — the
// standard sailing-instrument rate, ample for the video overlay and the
// averages/polar analytics). The full-resolution log is left untouched on
// the importing device.
function reduceLogForCloud(logData,xmlData){
  const TARGET_MAX_ROWS=7000;
  const MARGIN_MS=30*60*1000;
  if(!logData?.rows?.length) return logData;
  let rows=logData.rows;

  // 1. Trim away dock time so only the on-water window is kept.
  let trimmed=null;

  // 1a. Preferred — bound the window by the event file's timestamps.
  if(xmlData){
    const utcs=[];
    for(const k of ['tackJibes','markRoundings','sailsUpEvents','raceGuns']){
      for(const e of (xmlData[k]||[])){
        if(typeof e?.utc==='number'&&isFinite(e.utc)) utcs.push(e.utc);
      }
    }
    if(utcs.length>=2){
      const lo=Math.min(...utcs)-MARGIN_MS, hi=Math.max(...utcs)+MARGIN_MS;
      const t=rows.filter(r=>r.utc>=lo&&r.utc<=hi);
      if(t.length) trimmed=t;
    }
  }

  // 1b. Fallback (no event file — not every team runs an onboard assistant):
  //     derive the window from boat movement. A boat on the dock with the
  //     logger still running reads BSP≈0 and SOG≈0; find the first and last
  //     rows where it is actually moving and keep a 30-min margin on each
  //     side, dropping the long dock stretches before and after sailing.
  if(!trimmed){
    const moving=r=>(r.bsp||0)>0.5||(r.sog||0)>1.0;
    let first=-1,last=-1;
    for(let i=0;i<rows.length;i++){ if(moving(rows[i])){ first=i; break; } }
    for(let i=rows.length-1;i>=0;i--){ if(moving(rows[i])){ last=i; break; } }
    if(first>=0&&last>=first){
      const lo=rows[first].utc-MARGIN_MS, hi=rows[last].utc+MARGIN_MS;
      const t=rows.filter(r=>r.utc>=lo&&r.utc<=hi);
      if(t.length) trimmed=t;
    }
  }

  if(trimmed) rows=trimmed;

  // 2. Downsample — ≥1s between rows, and never more than TARGET_MAX_ROWS
  //    (the interval widens for very long sessions so the cap always holds).
  const span=rows.length>1?rows[rows.length-1].utc-rows[0].utc:0;
  const interval=Math.max(1000,Math.ceil(span/TARGET_MAX_ROWS));
  let out=[];
  let lastUtc=-Infinity;
  for(const r of rows){
    if(r.utc-lastUtc>=interval){ out.push(r); lastUtc=r.utc; }
  }

  // 3. Shrink the ROW SCHEMA. Capping the row COUNT alone was never enough: the
  //    payload size is rows × columns, and the column set grows every time a boat's
  //    export gains channels. At 71 fields, 7000 rows serialises to ~7 MB — over the
  //    4.5 MB request-body limit — so the session PUT 413s and the log silently ends
  //    up "saved on this device only". That is the bug this fixes; it had already
  //    been failing at ~5.7 MB before the 2026-07 export added 16 more columns.
  //
  //    3a. Drop columns that are null in EVERY row. A given boat only populates a
  //        subset of the union schema (no MastAng/Rake/Vang in the N76 export, etc.),
  //        so this is free — it removes keys that carry no information at all.
  const keep=new Set(['utc']);
  for(const r of out){
    for(const k in r){ if(r[k]!=null && !keep.has(k)) keep.add(k); }
  }
  //    3b. Round floats. Instrument data is meaningless past 2 dp, and a raw
  //        parseFloat can serialise as 9.100000000000001 — 18 chars for one number.
  const round=v=>(typeof v==='number'&&Number.isFinite(v)&&!Number.isInteger(v))?Math.round(v*100)/100:v;
  const slim=r=>{ const o={}; for(const k of keep){ const v=r[k]; if(v!=null) o[k]=round(v); } return o; };
  out=out.map(slim);

  //    3c. Hard byte budget. Whatever the schema, the payload must fit — so if it
  //        still doesn't, halve the row count until it does rather than let the PUT
  //        fail. Time resolution degrades gracefully; the full log stays on-device.
  //        4 MB (inside the 4.5 MB limit) rather than something more timid: the cloud
  //        log is what drives the video overlay on OTHER devices, so row spacing is
  //        worth paying for — 4 MB holds a 4 h session at 3 s, 3.5 MB would halve it
  //        again to 6 s and make the overlay visibly steppy.
  const BUDGET=4_000_000;
  const bytes=rs=>JSON.stringify(rs).length;
  while(out.length>500 && bytes(out)>BUDGET){
    out=out.filter((_,i)=>i%2===0);
  }

  return{
    ...logData,
    rows:out,
    startUtc:out[0]?.utc??logData.startUtc,
    endUtc:out[out.length-1]?.utc??logData.endUtc,
  };
}

// isoUtc + parseXmlEvents moved to src/lib/xmlEventParse.js (shared with the N72
// backfill CLI).

// ─── POLAR (see src/lib/polarCalc.js) ──────────────────────────────────────
// (imports moved to top of file)


const R=(n,d=1)=>(n==null||isNaN(n))?"--":Number(n).toFixed(d);
const TACK_COLORS=['#1D9E75','#06B6D4','#8B5CF6','#F59E0B','#EF4444','#EC4899','#34D399','#60A5FA','#A78BFA','#FCD34D'];
const fmtT=s=>{const x=Math.max(0,Math.floor(s));return`${String(Math.floor(x/60)).padStart(2,"0")}:${String(x%60).padStart(2,"0")}`;};
const fmtUtc=u=>u?new Date(u).toISOString().slice(11,19):"--:--:--";
// ── Venue-local clock ────────────────────────────────────────────────────────
// Everything is STORED in true UTC and rendered at venue-local (+ sessionTzOffset).
// Analytics used to render raw UTC, so its clocks read 2 h behind the timeline and
// the video player in CEST. Rather than thread the offset through LineChart /
// PerfChart / GPSTrackMap / AnalyticsTab by prop, publish it once on a context.
const TzCtx = React.createContext(0);
const useTz = () => React.useContext(TzCtx);
const hmLocal  = (u,tz=0)=>u?new Date(u+tz*60000).toISOString().slice(11,16):"--:--";
const hmsLocal = (u,tz=0)=>u?new Date(u+tz*60000).toISOString().slice(11,19):"--:--:--";
const TODAY=()=>new Date().toISOString().slice(0,10);
const fmtDate=d=>{if(!d)return"";const p=d.split("-");return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:d;};
const fmtDateTime=u=>{if(!u)return"";const dt=new Date(u);const dd=String(dt.getUTCDate()).padStart(2,"0");const mm=String(dt.getUTCMonth()+1).padStart(2,"0");const yyyy=dt.getUTCFullYear();const hh=String(dt.getUTCHours()).padStart(2,"0");const mi=String(dt.getUTCMinutes()).padStart(2,"0");return`${dd}/${mm}/${yyyy} ${hh}:${mi}`;};
const fmtSize=b=>b>1e9?`${(b/1e9).toFixed(1)} GB`:`${(b/1e6).toFixed(0)} MB`;
function nearestRow(rows,utc){if(!rows?.length)return null;let lo=0,hi=rows.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].utc<utc)lo=mid+1;else hi=mid;}if(lo>0&&Math.abs(rows[lo-1].utc-utc)<Math.abs(rows[lo].utc-utc))lo--;return Math.abs(rows[lo].utc-utc)<300000?rows[lo]:null;}

// Like nearestRow, but linearly interpolates between the two bracketing log
// samples instead of snapping to the nearest. The session log is sampled
// every ~1-2s; snapping makes the video overlay hang on one value until the
// next sample. Interpolation gives a smooth, continuously-moving readout.
function interpRow(rows,utc){
  if(!rows?.length)return null;
  const last=rows.length-1;
  if(utc<=rows[0].utc)   return Math.abs(rows[0].utc-utc)<300000?rows[0]:null;
  if(utc>=rows[last].utc)return Math.abs(rows[last].utc-utc)<300000?rows[last]:null;
  // Largest index with rows[lo].utc <= utc (utc is strictly interior here).
  let lo=0,hi=last;
  while(lo<hi){const mid=(lo+hi+1)>>1;if(rows[mid].utc<=utc)lo=mid;else hi=mid-1;}
  const a=rows[lo],b=rows[lo+1];
  if(!b)return a;
  const span=b.utc-a.utc;
  if(span<=0)return a;
  const f=(utc-a.utc)/span;
  // Interpolate every numeric field; snap non-numeric / null fields to the
  // nearer sample.
  const out={};
  for(const k in a){
    const av=a[k],bv=b[k];
    if(typeof av==='number'&&typeof bv==='number'&&isFinite(av)&&isFinite(bv)) out[k]=av+(bv-av)*f;
    else out[k]=f<0.5?av:bv;
  }
  return out;
}
// Strings that computeAutoTags writes verbatim (excluding the dynamic ones
// — sail names, boat/location/dayType — which are handled separately).
const AUTO_TAG_EXACT = new Set([
  'upwind', 'reach', 'downwind',
  'topmark', 'mark',
  'race-start', 'tack', 'gybe',
  'race', 'training',
]);
// Bucketed auto-tag patterns: TWS bands like "tws-12-16kn" / "tws-25+kn",
// and manoeuvre count multipliers like "3x-tack" / "5x-gybe".
const AUTO_TAG_REGEX = /^(tws-\d+(-\d+)?\+?kn|\d+x-(tack|gybe))$/;
// Precise auto-tag detector. The previous prefix-match version stripped
// manual tags like "race1", "tack9", "markings", "training-day" because
// they happened to start with an auto-tag word; every enrichVideo pass
// quietly wiped them, so tag edits never persisted across refreshes.
function isAutoTag(t){
  return AUTO_TAG_EXACT.has(t) || AUTO_TAG_REGEX.test(t);
}

function enrichVideo(v,log,xml,syncOffsets){
  const out = {...v};

  // ── Instrument averages from log ──────────────────────────────────────────
  if(log?.rows?.length&&v.startUtc){
    const offset = (syncOffsets && syncOffsets[v.id]) || 0;
    const start  = v.startUtc + offset * 1000;
    const w=log.rows.filter(r=>r.utc>=start&&r.utc<=start+(v.duration||0)*1000);
    if(w.length){
      const avg=f=>w.reduce((s,r)=>s+(r[f]||0),0)/w.length;
      const avgFiltered=(f,lo,hi)=>{const valid=w.filter(r=>r[f]>lo&&r[f]<hi);return valid.length?valid.reduce((s,r)=>s+r[f],0)/valid.length:null;};
      const max=f=>w.reduce((mx,r)=>Math.max(mx,r[f]||0),0);
      out.twsAvg   = avg("tws");
      out.twaAvg   = avg("twa");
      out.vmgAvg   = avg("vmg");
      out.polpercAvg = avgFiltered("vsPerfPct",5,200);
      out.vsTargPercAvg = avgFiltered("vsTargPct",5,200);
      out.sogAvg   = avg("sog");
      out.sogMax   = max("sog");
      out.twsMax   = max("tws");
      out.heelAvg  = avg("heel");
      out.bspAvg   = avg("bsp");
      out.logRows  = w;
    }
  }

  // ── Auto-tags from log + xml (race events, sails, position) ───────────────
  // Re-derive on every enrich so tags update when xml/log loads after the
  // video was first imported. Preserves manually-added tags.
  if(v.startUtc && (log || xml)){
    const offset = (syncOffsets && syncOffsets[v.id]) || 0;
    const autoTags = computeAutoTags(v.startUtc, v.duration, log, xml, offset);
    const manualTags = (v.tags||[]).filter(t => {
      if(isAutoTag(t)) return false;
      const meta = xml?.meta;
      if(meta?.location && t === meta.location.toLowerCase().replace(/\s+/g,"-")) return false;
      if(meta?.boat && t === meta.boat.toLowerCase().replace(/\s+/g,"-")) return false;
      if(meta?.dayType && t === meta.dayType.toLowerCase().replace(/\s+/g,"-")) return false;
      return true;
    });
    out.tags = [...new Set([...autoTags, ...manualTags])];
  }

  return out;
}

function SrcBadge({source}){const m={local:{l:"LOCAL",bg:"#06B6D415",bd:"#06B6D430",c:"#06B6D4"},cloud:{l:"CLOUD",bg:"#8B5CF615",bd:"#8B5CF630",c:"#8B5CF6"},processing:{l:"PROC",bg:"#F59E0B15",bd:"#F59E0B30",c:"#F59E0B"}};const s=m[source==="supabase"?"cloud":source]||m.local;return<span style={{fontSize:9,padding:"1px 5px",borderRadius:3,letterSpacing:1,fontWeight:600,background:s.bg,border:`1px solid ${s.bd}`,color:s.c}}>{s.l}</span>;}
// A video is "in the cloud" once it has a Stream ID or a cloud rendition —
// even if its local `source` field still reads "local" (the sync sets
// cloudSynced/streamId/hasProxy, not source). Returns a SrcBadge source string.
function videoBadgeSrc(v){
  if(!v) return "local";
  if(v.source==="processing"||v.streamProcessing) return "processing";
  if(v.streamId||v.hasProxy||v.hasOriginal||v.cloudSynced||v.source==="cloud"||v.source==="supabase") return "cloud";
  return "local";
}
const videoInCloud = v => videoBadgeSrc(v)==="cloud";
function Gauge({label,value,/* unit kept for call-site back-compat — not rendered */ unit:_unit,color="#06B6D4",size="md",highlight=false}){
  // Gauge is only used for the on-video instrument overlay. On phones the
  // desktop sizing covers half the frame, so shrink everything ~40 %. Units
  // (kn / true / vs polar / etc.) are intentionally not rendered — the
  // label already conveys the dimension and the cluster reads cleaner
  // without the secondary line.
  const isMobile = useIsMobile();
  const baseFs = size==="lg"?28:size==="sm"?16:22;
  const fs     = isMobile ? Math.round(baseFs*0.6) : baseFs;
  const labelFs= isMobile ? 7 : 9;
  const minW   = isMobile
    ? (size==="lg"?54:size==="sm"?38:46)
    : (size==="lg"?90:size==="sm"?58:76);
  const pad    = isMobile
    ? (size==="sm"?"2px 5px":"3px 6px")
    : (size==="sm"?"5px 9px":"7px 11px");
  return(
    <div style={{background:highlight?"rgba(239,68,68,0.18)":"rgba(0,0,0,0.75)",border:`1px solid ${highlight?"#EF4444":color}40`,borderRadius:isMobile?5:7,padding:pad,minWidth:minW}}>
      <div style={{fontSize:labelFs,color:"#64748B",letterSpacing:isMobile?1:2,textTransform:"uppercase",marginBottom:isMobile?0:2}}>{label}</div>
      <div style={{fontSize:fs,fontWeight:700,color:highlight?"#EF4444":color,fontFamily:"'Courier New',monospace",lineHeight:1}}>{value}</div>
    </div>
  );
}

// Compute mode from video tags — determines which instrument overlay to show
function getVideoMode(tags){
  if(!tags?.length) return "upwind";
  if(tags.includes("race-start")) return "start";
  if(tags.includes("reach"))      return "reach";
  if(tags.includes("upwind")||tags.includes("downwind")) return "upwind";
  return "upwind";
}

// Apparent wind angle from true wind angle, true wind speed, boat speed
function calcAWA(twa,tws,bsp){
  if(twa==null||!tws||!bsp) return null;
  const absA=Math.abs(twa)*Math.PI/180;
  const fwd=bsp+tws*Math.cos(absA);
  const lat=tws*Math.sin(absA);
  const deg=Math.atan2(lat,fwd)*180/Math.PI;
  return twa<0?-deg:deg;
}

// Compass bearing in degrees from one lat/lon point to another (0–360, true).
// Uses a local-flat approximation, which is accurate to well under a degree
// over typical start-line distances (~hundreds of metres).
function bearingDeg(from,to){
  if(!from||!to) return null;
  const dy=to.lat-from.lat;
  const dx=(to.lon-from.lon)*Math.cos(from.lat*Math.PI/180);
  if(dx===0&&dy===0) return null;
  return ((Math.atan2(dx,dy)*180/Math.PI)+360)%360;
}

// Extract boat length in metres from name — e.g. "NORTHSTAR72" → 72 ft → 21.9 m
function extractBoatLengthM(boatName){
  const m=(boatName||"").match(/(\d+)/);
  if(m){const n=parseInt(m[1]);if(n>=20&&n<=150)return n*0.3048;}
  return 12; // fallback ~40 ft
}

// Log variables the user can ADD to the video overlay from the dropdown (on top
// of each mode's fixed default gauges). key = the canonical row field.
const OVERLAY_VARS = [
  {key:'tws',label:'TWS',unit:'kn',dec:1},{key:'twa',label:'TWA',unit:'°',dec:0},
  {key:'aws',label:'AWS',unit:'kn',dec:1},{key:'awa',label:'AWA',unit:'°',dec:0},
  {key:'twd',label:'TWD',unit:'°',dec:0},{key:'bsp',label:'BSP',unit:'kn',dec:1},
  {key:'sog',label:'SOG',unit:'kn',dec:1},{key:'vmg',label:'VMG',unit:'kn',dec:2},
  {key:'heel',label:'Heel',unit:'°',dec:0},{key:'trim',label:'Trim',unit:'°',dec:1},
  {key:'forestay',label:'Forestay',unit:'',dec:1},{key:'keelAng',label:'Keel',unit:'°',dec:1},
  {key:'rudder',label:'Rudder',unit:'',dec:1},{key:'mastAng',label:'Mast ang',unit:'',dec:0},
  {key:'vsPerfPct',label:'Polar %',unit:'%',dec:0},{key:'vsTarget',label:'Tgt BSP',unit:'kn',dec:1},
  {key:'twaTarg',label:'Tgt TWA',unit:'°',dec:0},{key:'leeway',label:'Leeway',unit:'°',dec:1},
  {key:'vang',label:'Vang',unit:'',dec:1},{key:'outhaul',label:'Outhaul',unit:'',dec:1},
  {key:'cunninghamLoad',label:'Cunno',unit:'',dec:1},{key:'jibTackLoad',label:'Jib tack',unit:'',dec:1},
  {key:'gsTackLoad',label:'GS tack',unit:'',dec:1},{key:'upDflctPct',label:'Up defl',unit:'%',dec:0},
  {key:'lwDflctPct',label:'Low defl',unit:'%',dec:0},{key:'travPct',label:'Traveller',unit:'%',dec:0},
];

function VideoPlayer({video,logData,xmlData,syncOffset,sessionTzOffset=0,onPlayUtc,autoPlay=false,onRotate=null,
                      // Phase B crop UX — three callbacks + the current
                      // cut points + busy flag. All optional; toolbar
                      // crop UI only renders when the setters are provided.
                      pendingCrop,onDeleteUpTo,onDeleteFromHere,onSaveCrop,cropBusy=false,cropProgress=null,
                      // When true (coach/admin), the player offers a toggle
                      // to switch to the local IndexedDB blob for HD debrief
                      // playback — overriding the default cloud-HLS path.
                      canPlayLocalHD=false,
                      // Native-pipeline helpers (desktop only): download the
                      // local clip blob to disk for external compression,
                      // and push the compressed file straight to Bunny as
                      // the cloud "original". The IDB blob is deliberately
                      // NOT replaced — the HD-local debrief toggle still
                      // plays the full-fidelity local file. Both optional;
                      // the toolbar buttons only appear when wired.
                      onExportToDisk,onUploadCompressed}){
  const vidRef=useRef(null),hlsRef=useRef(null);
  const[curTime,setCurTime]=useState(0);
  const[playing,setPlaying]=useState(false);
  const[dur,setDur]=useState(video.duration||0);
  const[vidQuality,setVidQuality]=useState(null); // live rendition label
  const[useLocalHD,setUseLocalHD]=useState(false);
  const seekOnLoadRef=useRef(null); // preserve playback position across source swaps
  const lastUtcEmit=useRef(0);
  const isMobile=useIsMobile();
  const stageRef=useRef(null);
  // Pseudo-fullscreen (mobile). Native <video> fullscreen on iOS hands off
  // to the OS player, which can't show our HTML instrument overlay, so on
  // mobile we cover the viewport with a position:fixed stage instead. That
  // keeps the overlay on top. Desktop uses the real Fullscreen API on the
  // stage container (handled in the button below).
  const[mobileFs,setMobileFs]=useState(false);
  // True when the active source is HLS (cloud adaptive). Flips to false when
  // a coach/admin has toggled HD-local, because the IndexedDB blob is always
  // a progressive MP4/MOV. Consumed by the toolbar indicator below.
  const isHls=!useLocalHD && (video.source==="cloud" || video.objectUrl?.includes(".m3u8"));

  // Always start a fresh clip on the default (cloud) source.
  useEffect(()=>{ setUseLocalHD(false); },[video.id]);

  // Mobile: rotate to landscape → enter pseudo-fullscreen (video + overlay);
  // rotate back to portrait → exit. Lets the coach just turn the phone to get
  // a full-frame replay with the instruments on top, and put it upright to
  // return to the library.
  useEffect(()=>{
    if(!isMobile) return;
    const mq = window.matchMedia('(orientation: landscape)');
    const onChange = e => {
      if(e.matches){ if(video.objectUrl) setMobileFs(true); }
      else setMobileFs(false);
    };
    // Sync once on mount in case we're already landscape.
    if(mq.matches && video.objectUrl) setMobileFs(true);
    mq.addEventListener?.('change', onChange);
    return ()=>mq.removeEventListener?.('change', onChange);
  },[isMobile, video.objectUrl]);

  // Lock body scroll, autoplay, and (where supported) request real
  // element-fullscreen so the browser hides its address/menu bars and the
  // video gets the whole screen. We fullscreen the STAGE container, not the
  // bare <video>, so the instrument overlay stays on top. Android Chrome
  // and iPad honour this; iPhone Safari ignores element-fullscreen, so the
  // position:fixed + 100dvh stage is the fallback (covers the layout
  // viewport; Safari's bars auto-collapse on most devices).
  useEffect(()=>{
    if(!mobileFs) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    vidRef.current?.play?.().catch(()=>{});
    const el = stageRef.current;
    if(el && !document.fullscreenElement){
      try { (el.requestFullscreen?.() || el.webkitRequestFullscreen?.())?.catch?.(()=>{}); } catch {}
    }
    return ()=>{
      document.body.style.overflow = prev;
      try { if(document.fullscreenElement) (document.exitFullscreen?.() || document.webkitExitFullscreen?.())?.catch?.(()=>{}); } catch {}
    };
  },[mobileFs]);

  // Keep mobileFs in sync if the user leaves native fullscreen via the
  // browser's own gesture (Esc / swipe / back). Only fires where native FS
  // exists; on iPhone there's no fullscreenElement so this is a no-op.
  useEffect(()=>{
    if(!isMobile) return;
    const onFsChange = ()=>{ if(!document.fullscreenElement) setMobileFs(false); };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return ()=>{
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  },[isMobile]);

  // Coach/admin one-click toggle: cache the current scrub position so the
  // swapped source picks up exactly where we left off, then flip the mode.
  const toggleLocalHD=()=>{
    seekOnLoadRef.current=vidRef.current?.currentTime??0;
    setUseLocalHD(v=>!v);
  };

  // Polar file — fallback only. Target BSP, Polar % and VMG % now come
  // straight from the Expedition log columns (see the derived values below).
  const polar=useMemo(()=>loadPolarFromLS(),[]);

  useEffect(()=>{
    if(!vidRef.current||!video.objectUrl)return;
    setVidQuality(null);
    // videoHeight reflects the rendition currently being decoded — works for
    // native HLS (iOS) and progressive MP4 alike. The element fires `resize`
    // on every rendition switch. Falls through to the hls.js LEVEL_SWITCHED
    // handler below which adds the bitrate.
    const vEl=vidRef.current;
    const onResize=()=>{ if(vEl.videoHeight) setVidQuality(q=>(q&&q.includes('Mbps'))?q:`${vEl.videoHeight}p`); };
    vEl.addEventListener('resize',onResize);

    let cancelled=false;
    let createdBlobUrl=null;
    (async()=>{
      let srcUrl=video.objectUrl;
      // Coach/admin opt-in: pull the original from IndexedDB and feed the
      // <video> a Blob URL. This is the highest-fidelity playback path
      // (uncompressed source, no streaming) — used for debriefs.
      if(useLocalHD && video.hasLocalBlob){
        try{
          const blob=await getVideoBlob(video.id);
          if(cancelled||!blob) return;
          createdBlobUrl=URL.createObjectURL(blob);
          srcUrl=createdBlobUrl;
        }catch{ /* fall through to cloud */ }
      }
      if(cancelled||!vidRef.current) return;
      // HLS only when we're NOT on the local blob: local is always a
      // progressive MP4/MOV that the <video> element decodes natively.
      const useHls = !useLocalHD && (video.source==="cloud" || srcUrl?.includes(".m3u8"));
      if(useHls){
        const init=()=>{
          if(hlsRef.current){hlsRef.current.destroy();hlsRef.current=null;}
          if(window.Hls?.isSupported()){
            // Tuned for weak field wifi: start on the lowest rendition so
            // playback begins immediately (then adapt up only if bandwidth
            // allows), cap quality to the on-screen video size, and buffer
            // far ahead (up to ~10 min / the whole clip) so wifi dropouts —
            // even long ones — don't stall the video.
            const hls=new window.Hls({startLevel:0,capLevelToPlayerSize:true,maxBufferLength:180,maxMaxBufferLength:600,maxBufferSize:200*1000*1000});
            // Surface the actually-playing rendition (resolution + bitrate)
            // so the bottom-left badge can prove what ABR settled on.
            hls.on(window.Hls.Events.LEVEL_SWITCHED,(_e,d)=>{
              const lvl=hls.levels?.[d.level];
              if(lvl) setVidQuality(`${lvl.height}p · ${(lvl.bitrate/1e6).toFixed(2)} Mbps`);
            });
            hls.loadSource(srcUrl);hls.attachMedia(vidRef.current);hlsRef.current=hls;
          }
          else if(vidRef.current.canPlayType("application/vnd.apple.mpegurl"))vidRef.current.src=srcUrl;
        };
        if(!window.Hls){const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.14/hls.min.js";s.onload=init;document.head.appendChild(s);}
        else init();
      }else{
        if(hlsRef.current){hlsRef.current.destroy();hlsRef.current=null;}
        vidRef.current.src=srcUrl;
      }
    })();

    return()=>{
      cancelled=true;
      vEl.removeEventListener('resize',onResize);
      if(hlsRef.current){hlsRef.current.destroy();hlsRef.current=null;}
      if(createdBlobUrl){ try{URL.revokeObjectURL(createdBlobUrl);}catch{} }
    };
  },[video.id,video.objectUrl,video.source,video.hasLocalBlob,useLocalHD]);

  // Reset playback state only on clip change; toggling source within a
  // clip should NOT zero the scrub position (the seek ref handles that).
  useEffect(()=>{
    setCurTime(0); setPlaying(false);
  },[video.id]);

  const emitUtc=useCallback((t)=>{
    if(!onPlayUtc||!video.startUtc)return;
    const now=performance.now();
    if(now-lastUtcEmit.current<80)return;
    lastUtcEmit.current=now;
    onPlayUtc(video.startUtc+(t+(syncOffset||0))*1000);
  },[onPlayUtc,video.startUtc,syncOffset]);

  // Drive the instrument overlay at a steady 5 Hz while playing. The HTML
  // <video> `timeupdate` event fires irregularly, so a fixed 200 ms tick
  // keeps the gauges refreshing smoothly (paired with interpRow above).
  useEffect(()=>{
    if(!playing)return;
    const id=setInterval(()=>{
      const v=vidRef.current;
      if(v&&!v.paused){ setCurTime(v.currentTime); emitUtc(v.currentTime); }
    },200);
    return ()=>clearInterval(id);
  },[playing,emitUtc]);

  const logUtc=video.startUtc?video.startUtc+(curTime+(syncOffset||0))*1000:0;
  const row=logData&&logUtc?interpRow(logData.rows,logUtc):null;
  const markers=xmlData&&video.startUtc?[...(xmlData.tackJibes||[]),...(xmlData.markRoundings||[]),...(xmlData.sailsUpEvents||[]).map(s=>({...s,color:"#F59E0B"}))].map(m=>({...m,vidSec:(m.utc-video.startUtc)/1000-(syncOffset||0)})).filter(m=>m.vidSec>=0&&m.vidSec<=dur):[];
  const upcoming=markers.filter(m=>m.vidSec>curTime&&m.vidSec<curTime+30).slice(0,2);
  const pct=dur>0?(curTime/dur)*100:0;
  const onUpdate=()=>{
    if(vidRef.current){
      const t=vidRef.current.currentTime;
      setCurTime(t);setPlaying(!vidRef.current.paused);emitUtc(t);
    }
  };
  const seek=e=>{
    const r=e.currentTarget.getBoundingClientRect();
    if(vidRef.current){
      const t=((e.clientX-r.left)/r.width)*dur;
      vidRef.current.currentTime=t;
      if(onPlayUtc&&video.startUtc)onPlayUtc(video.startUtc+(t+(syncOffset||0))*1000);
    }
  };

  // ── Mode-specific overlay ───────────────────────────────────────────────────
  const mode=getVideoMode(video.tags);

  // Pre-compute derived values. Target BSP and Polar % come straight from
  // the Expedition log columns (Vs_targ, Vs_perf%); the uploaded polar
  // file is only a fallback for older logs that lack those columns.
  //
  // logTargBsp — target boat speed from the log alone. Prefer the absolute
  // Vs_targ column; when an export keeps only Vs_targ% (boat speed as a %
  // of target speed) recover it as  Vs_targ = BSP ÷ (Vs_targ% / 100).
  const logTargBsp = (row?.vsTarget != null && row.vsTarget > 0)
    ? row.vsTarget
    : (row && row.vsTargPct > 0 && row.bsp > 0)
      ? row.bsp * 100 / row.vsTargPct
      : null;
  const targBsp  = logTargBsp
    ?? ((polar && row) ? polarInterp(polar, row.tws, Math.abs(row.twa||0)) : null);
  const polPct   = (row?.vsPerfPct != null && row.vsPerfPct > 0)
    ? row.vsPerfPct
    : ((polar && row) ? polarPerf(polar, row.bsp, row.twa, row.tws)?.pct : null);

  // AWA: use log col 5 (AW_angle) directly; fall back to computed if 0/missing
  const awaRaw = row?.awa;
  const awa = (awaRaw && Math.abs(awaRaw) > 0.5)
    ? awaRaw
    : calcAWA(row?.twa, row?.tws, row?.bsp);

  // VMG% — optimal VMG is the log's target boat speed projected onto the
  // wind axis at the target TWA (Vs_targ × cos(TWA_targ)). logTargBsp also
  // covers the Vs_targ%-recovered case above; fall back to the polar curve
  // when the log carries no target data at all.
  const absA = Math.abs(row?.twa||0);
  const isUpwindAngle = absA < 90;
  const logOptVMG = (logTargBsp != null && row?.twaTarg != null)
    ? logTargBsp * Math.abs(Math.cos(row.twaTarg * Math.PI / 180))
    : null;
  const vmgTarget = (polar && row) ? polarVMGTarget(polar, row.tws) : null;
  const optVMG = (logOptVMG && logOptVMG > 0.01)
    ? logOptVMG
    : (vmgTarget ? (isUpwindAngle ? vmgTarget.upVMG : vmgTarget.downVMG) : null);
  const vmgPct = (optVMG && optVMG > 0.01 && row?.vmg != null)
    ? Math.max(0, Math.min(200, (Math.abs(row.vmg) / optVMG) * 100))
    : null;

  // ── Starting instruments ────────────────────────────────────────────────────
  const guns       = xmlData?.raceGuns||[];
  const startLines = xmlData?.startLines||[];

  // GUN — prefer Timer-1 (col 55), fall back to event UTC diff
  const timerFromLog = row?.timer1;
  const nearestGun = guns.length&&logUtc
    ? guns.filter(g=>Math.abs(g.utc-logUtc)<600000)
          .sort((a,b)=>Math.abs(a.utc-logUtc)-Math.abs(b.utc-logUtc))[0]||null
    : null;
  const secToGunFallback = nearestGun ? Math.round((nearestGun.utc-logUtc)/1000) : null;
  const secToGun = timerFromLog ?? secToGunFallback;
  const gunActive = secToGun!=null;
  const afterGun  = secToGun!=null && secToGun <= 0;  // gun has fired

  // DISTANCE TO LINE — read straight from the Expedition log's DST_LINE
  // column, which the user's instrument config writes in boat lengths (the
  // "m" suffix in the CSV is Expedition's display formatting, not a unit).
  // The previous build had a GPS-geometry fallback off the event-file
  // start-line marks, but that was fragile: the sign depended on pin/
  // committee ordering and the magnitude could go off the rails when the
  // marks weren't pinged accurately. If DST_LINE is empty we now show "--"
  // rather than guessing.
  const distBL = (row?.dstLine!=null && isFinite(row.dstLine)) ? row.dstLine : null;

  // TIME TO BURN — how much excess time before the gun fires.
  //   positive = early, you need to burn some time before crossing
  //   negative = late, you'll cross after the gun
  //
  // TTB·LINE — the TM_LINE log column is misleadingly named ("TM_"
  //   suggests time-to-reach), but the value is already the burn at the
  //   line on the current heading. Display directly, no subtraction.
  // TTB·P / TTB·S — TTB_Port / TTB_Stbd are the seconds it takes to
  //   reach the port / starboard end of the line (not a pre-computed
  //   burn), so we subtract from the gun timer.
  const ttbLine = (row?.tmLine!=null && isFinite(row.tmLine)) ? row.tmLine : null;
  const ttbPort = (row?.ttbPort!=null && secToGun!=null) ? secToGun-row.ttbPort : null;
  const ttbStbd = (row?.ttbStbd!=null && secToGun!=null) ? secToGun-row.ttbStbd : null;

  // LINE SQUARE — the wind direction at which the start line is perpendicular
  // to the wind, in MAGNETIC degrees. There are two perpendiculars to any
  // line; pick the one closer to the current TWD so pin/committee ordering
  // doesn't flip the value. Convert true → magnetic via the log's MagVar
  // column (signed: positive east → magnetic = true − magvar).
  const activeLine = nearestGun
    ? startLines.find(sl=>sl.raceNum===nearestGun.raceNum)||startLines[0]||null
    : startLines[0]||null;
  let lineSqrMag = null;
  if(activeLine?.pin&&activeLine?.boat){
    const lineBearing = bearingDeg(activeLine.pin, activeLine.boat);
    if(lineBearing!=null){
      const a = (lineBearing + 90) % 360;
      const b = (lineBearing + 270) % 360;
      const ref = (row?.twd!=null && isFinite(row.twd) && row.twd!==0) ? row.twd : a;
      const angDist = (x,y)=>{const d=Math.abs(x-y)%360;return d>180?360-d:d;};
      const lineSqrTrue = angDist(a,ref) <= angDist(b,ref) ? a : b;
      const magvar = (row?.magvar!=null && isFinite(row.magvar)) ? row.magvar : 0;
      lineSqrMag = (lineSqrTrue - magvar + 360) % 360;
    }
  }

  // Formatters
  const fmtGun = s=>{
    if(s==null) return "--:--";
    const abs=Math.abs(s);
    return`${s>0?"-":"+"}${String(Math.floor(abs/60)).padStart(2,"0")}:${String(Math.floor(abs)%60).padStart(2,"0")}`;
  };
  const fmtBurn = s=>{
    if(s==null) return "--:--";
    const abs=Math.abs(s);
    return`${s>0?"+":"-"}${String(Math.floor(abs/60)).padStart(2,"0")}:${String(Math.floor(abs)%60).padStart(2,"0")}`;
  };
  const fmtDist = d=>{
    if(d==null) return "--";
    return`${d<0?"OCS ":""}${Math.abs(d).toFixed(1)}`;
  };

  // User-added overlay variables — SESSION ONLY (resets on reload; defaults for
  // every mode stay exactly as-is). Appended below the fixed gauges.
  const [extraGauges,setExtraGauges]=useState([]);
  const extraOverlay = row && extraGauges.length>0 && (
    <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:5}}>
      {extraGauges.map(k=>{
        const o=OVERLAY_VARS.find(x=>x.key===k); if(!o) return null;
        const v=row[k];
        const val=v!=null?(o.unit==='°'?`${R(v,o.dec)}°`:R(v,o.dec)):"--";
        return <Gauge key={k} label={o.label} value={val} unit={o.unit==='°'?'':o.unit} color="#A78BFA" size="sm"/>;
      })}
    </div>
  );

  const overlay=row&&(()=>{
    if(mode==="start") return(
      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
        {/* GUN: red counting down, green after gun fires */}
        <Gauge label="GUN"
               value={gunActive?fmtGun(secToGun):"--:--"}
               unit={secToGun==null?"":secToGun>0?"to start":"after gun"}
               color={afterGun?"#10B981":"#EF4444"} size="lg"
               highlight={gunActive&&!afterGun&&secToGun<=60}/>
        {/* DIST TO LINE — straight from the log's DST_LINE column */}
        <Gauge label="LINE"
               value={fmtDist(distBL)}
               unit="BL"
               color={distBL==null?"#F59E0B":distBL<0?"#EF4444":"#10B981"} size="lg"
               highlight={distBL!=null&&distBL<0}/>
        {/* TTB·LINE — direct from the TM_LINE column (already a burn) */}
        <Gauge label="TTB·LINE"
               value={ttbLine!=null?fmtBurn(ttbLine):"--:--"}
               unit={ttbLine==null?"":ttbLine>0?"early":"late"}
               color={ttbLine!=null&&ttbLine<0?"#EF4444":"#10B981"} size="lg"
               highlight={ttbLine!=null&&ttbLine<-10}/>
        {/* TTB at PORT end of line */}
        <Gauge label="TTB·P"
               value={ttbPort!=null?fmtBurn(ttbPort):"--:--"}
               unit={ttbPort==null?"":ttbPort>0?"early":"late"}
               color={ttbPort!=null&&ttbPort<0?"#EF4444":"#10B981"} size="lg"
               highlight={ttbPort!=null&&ttbPort<-10}/>
        {/* TTB at STBD end of line */}
        <Gauge label="TTB·S"
               value={ttbStbd!=null?fmtBurn(ttbStbd):"--:--"}
               unit={ttbStbd==null?"":ttbStbd>0?"early":"late"}
               color={ttbStbd!=null&&ttbStbd<0?"#EF4444":"#10B981"} size="lg"
               highlight={ttbStbd!=null&&ttbStbd<-10}/>
        <Gauge label="BSP"  value={R(row.bsp)}         unit="kn"   color="#10B981" size="sm"/>
        <Gauge label="Tgt %" value={row?.vsTargPct>0?`${R(row.vsTargPct,0)}%`:"--"} unit="vs target"
               color={!row?.vsTargPct||row.vsTargPct<=0?"#22C55E":row.vsTargPct>=110?"#166534":row.vsTargPct>=90?"#22C55E":"#EF4444"} size="sm"/>
        <Gauge label="TWS"  value={R(row.tws)}         unit="kn"   color="#7DD3FC" size="sm"/>
        <Gauge label="TWA"  value={`${R(row.twa,0)}°`} unit="true" color="#7DD3FC" size="sm"/>
        <Gauge label="TWD"  value={row?.twd!=null?`${R(row.twd,0)}°`:"--"}  unit="°"   color="#7DD3FC" size="sm"/>
        <Gauge label="Line Sqr" value={lineSqrMag!=null?`${R(lineSqrMag,0)}°`:"--"} unit="mag" color="#A78BFA" size="sm"/>
        <Gauge label="Keel" value={row?.keelAng!=null?`${R(row.keelAng,1)}°`:"--"} unit="°" color="#F59E0B" size="sm"/>
      </div>
    );
    if(mode==="reach") return(
      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
        <Gauge label="BSP"     value={R(row.bsp)}                          unit="kn"       color="#10B981"/>
        <Gauge label="Polar %" value={polPct!=null?R(polPct,0)+"%":"--"}   unit="vs polar" color={polPct==null?"#22C55E":polPct>=110?"#166534":polPct>=90?"#22C55E":"#EF4444"}/>
        <Gauge label="Tgt BSP" value={targBsp!=null?R(targBsp):"--"}       unit="kn"       color="#10B981" size="sm"/>
        <Gauge label="TWA"     value={`${R(row.twa,0)}°`}                  unit="true"     color="#7DD3FC" size="sm"/>
        <Gauge label="TWS"     value={R(row.tws)}                          unit="kn"       color="#7DD3FC" size="sm"/>
        <Gauge label="AWA"     value={awa!=null?`${R(awa,0)}°`:"--"}       unit="app"      color="#7DD3FC" size="sm"/>
        <Gauge label="Heel"    value={`${R(row.heel,0)}°`}                 unit="°"        color="#F97316" size="sm"/>
        <Gauge label="Keel"    value={row?.keelAng!=null?`${R(row.keelAng,1)}°`:"--"} unit="°" color="#F59E0B" size="sm"/>
      </div>
    );
    // upwind / downwind — VMG as % of polar optimal
    const vmgColor = vmgPct==null?"#22C55E":vmgPct>=110?"#166534":vmgPct>=90?"#22C55E":"#EF4444";
    return(
      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
        <Gauge label="BSP"     value={R(row.bsp)}                          unit="kn"   color="#10B981"/>
        <Gauge label="VMG %"   value={vmgPct!=null?R(vmgPct,0)+"%":"--"}   unit={isUpwindAngle?"↑ opt":"↓ opt"} color={vmgColor}/>
        <Gauge label="Tgt BSP" value={targBsp!=null?R(targBsp):"--"}       unit="kn"   color="#10B981" size="sm"/>
        <Gauge label="TWA"     value={`${R(row.twa,0)}°`}                  unit="true" color="#7DD3FC" size="sm"/>
        <Gauge label="TWS"     value={R(row.tws)}                          unit="kn"   color="#7DD3FC" size="sm"/>
        <Gauge label="AWA"     value={awa!=null?`${R(awa,0)}°`:"--"}       unit="app"  color="#7DD3FC" size="sm"/>
        <Gauge label="Heel"    value={`${R(row.heel,0)}°`}                 unit="°"    color="#F97316" size="sm"/>
        <Gauge label="Keel"    value={row?.keelAng!=null?`${R(row.keelAng,1)}°`:"--"} unit="°" color="#F59E0B" size="sm"/>
      </div>
    );
  })();

  // Mode label badge
  const modeBadge=row&&(
    <div style={{position:"absolute",top:10,right:upcoming.length>0?10:10,display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
      <div style={{background:"rgba(0,0,0,0.7)",border:`1px solid ${mode==="start"?"#EF4444":mode==="reach"?"#8B5CF6":"#06B6D4"}40`,borderRadius:4,padding:"2px 7px",fontSize:8,color:mode==="start"?"#EF4444":mode==="reach"?"#A78BFA":"#06B6D4",fontWeight:700,letterSpacing:1}}>
        {mode==="start"?"⚑ START":mode==="reach"?"↗ REACH":"⬆ UPWIND/DWN"}
      </div>
      {upcoming.map((m,i)=><div key={i} style={{background:"rgba(0,0,0,0.8)",borderRadius:5,padding:"3px 7px",fontSize:10,color:m.color,border:`1px solid ${m.color}40`}}>{m.label} in {Math.round(m.vidSec-curTime)}s</div>)}
    </div>
  );

  return(
    <div style={{background:"#030F1A",borderRadius:12,overflow:"hidden",border:"1px solid #1E3A5A"}}>
      <div ref={stageRef} style={mobileFs
          ? {position:"fixed",top:0,left:0,width:"100vw",height:"100dvh",zIndex:9999,background:"#000",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}
          : {position:"relative",background:"#000",aspectRatio:"16/9",width:"100%",overflow:"hidden",borderRadius:"12px 12px 0 0"}}>
        {/* Exit button — only while in mobile pseudo-fullscreen. */}
        {mobileFs&&(
          <button onClick={(e)=>{e.stopPropagation();setMobileFs(false);}}
            style={{position:"absolute",top:10,right:10,zIndex:4,background:"rgba(0,0,0,0.6)",border:"1px solid #ffffff30",borderRadius:8,width:36,height:36,color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        )}
        {video.objectUrl?<video ref={vidRef} poster={video.thumbnailUrl||undefined} playsInline autoPlay={autoPlay} {...{'webkit-playsinline':'true','x5-playsinline':'true'}} style={{width:"100%",height:"100%",objectFit:"contain",cursor:"pointer",transition:"transform .18s ease",...rotStyle(video.rotation,16,9)}} onClick={()=>{const v=vidRef.current; if(!v)return; if(v.paused) v.play().catch(()=>{}); else v.pause();}} onTimeUpdate={onUpdate} onPlay={onUpdate} onPause={onUpdate} onLoadedMetadata={e=>{setDur(e.target.duration); if(seekOnLoadRef.current!=null){try{e.target.currentTime=seekOnLoadRef.current;}catch{} seekOnLoadRef.current=null;} if(autoPlay){e.target.play().catch(()=>{});}}}/>:
         (video.source==="processing"||video.streamProcessing)?<div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"#F59E0B"}}><div style={{fontSize:28,marginBottom:8}}>⏳</div><div style={{fontSize:12}}>Processing in Stream…</div><div style={{fontSize:10,color:"#475569",marginTop:4}}>1–3 min typically</div></div>:
         <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"#334155"}}><div style={{fontSize:28,marginBottom:8,opacity:0.3}}>📹</div><div style={{fontSize:11}}>No playback available</div></div>}
        {!playing&&video.objectUrl&&<div onClick={()=>vidRef.current?.play()} style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:64,height:64,background:"rgba(6,182,212,0.9)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:22}}>▶</div>}
        {/* On mobile, pin to all-but-bottom so tiles wrap within the
            frame width instead of overflowing off the right edge. */}
        {overlay&&<div style={{position:"absolute",top:isMobile?6:10,left:isMobile?6:10,right:mobileFs?52:(isMobile?6:undefined)}}>{overlay}{extraOverlay}</div>}
        {modeBadge}
        {/* Rotate — TL3+ only (the parent supplies onRotate). Stores an ANGLE; the file
            is never re-encoded, so its capture metadata (Apple Keys:CreationDate) is
            preserved. Rotating in QuickTime Player transcodes and destroys it, which is
            what left clips carrying the edit time instead of the recording time. */}
        {onRotate&&(
          <button
            onClick={(e)=>{e.stopPropagation(); onRotate((((video.rotation||0)+90)%360));}}
            title={`Rotate 90° (now ${video.rotation||0}°) — display only, the file is not re-encoded`}
            style={{position:"absolute",top:8,right:8,zIndex:4,width:32,height:32,borderRadius:8,
              border:"1px solid #1E3A5A",background:"rgba(3,15,26,0.72)",color:"#7DD3FC",
              cursor:"pointer",fontSize:15,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>
            ⟳
          </button>
        )}
        <div style={{position:"absolute",bottom:8,left:8,display:"flex",alignItems:"center",gap:6}}>
          {vidQuality&&<div style={{background:"rgba(0,0,0,0.7)",borderRadius:4,padding:"2px 6px",fontSize:9,color:"#7DD3FC",fontFamily:"monospace",letterSpacing:0.3}}>▾ {vidQuality}</div>}
          {/* Coach/admin only: opt into local HD playback from the IndexedDB
              blob. Useful for debriefs where bandwidth-independent, max-
              fidelity playback matters more than smooth ABR. */}
          {canPlayLocalHD && video.hasLocalBlob && (
            <button onClick={toggleLocalHD}
              title={useLocalHD?"Switch back to the adaptive cloud stream":"Play the original from local storage (HD, no streaming)"}
              style={{background:useLocalHD?"rgba(245,158,11,0.9)":"rgba(0,0,0,0.7)",border:"none",borderRadius:4,padding:"2px 6px",fontSize:9,color:useLocalHD?"#000":"#F59E0B",fontFamily:"monospace",letterSpacing:0.3,cursor:"pointer",fontWeight:useLocalHD?700:500}}>
              {useLocalHD?"◆ HD local":"◇ HD local"}
            </button>
          )}
        </div>
        <div style={{position:"absolute",bottom:8,right:8,background:"rgba(0,0,0,0.7)",borderRadius:4,padding:"2px 7px",fontSize:10,color:"#64748B",fontFamily:"monospace"}}>{fmtT(curTime)} / {fmtT(dur)}{logUtc&&row?`  ${(()=>{const d=new Date(logUtc+sessionTzOffset*60000);return String(d.getUTCHours()).padStart(2,"0")+":"+String(d.getUTCMinutes()).padStart(2,"0")+":"+String(d.getUTCSeconds()).padStart(2,"0");})()} local`:""}</div>
      </div>
      <div style={{padding:"8px 12px 0"}}>
        {/* Overlay variables — add extra gauges for this session only. */}
        {logData?.rows?.length>0 && (
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:8}}>
            <span style={{fontSize:9,color:"#475569",letterSpacing:1,textTransform:"uppercase"}}>Overlay +</span>
            {extraGauges.map(k=>{const o=OVERLAY_VARS.find(x=>x.key===k);return(
              <span key={k} style={{display:"inline-flex",alignItems:"center",gap:4,background:"#8B5CF615",border:"1px solid #8B5CF640",borderRadius:4,padding:"1px 4px 1px 7px",fontSize:9,color:"#A78BFA"}}>
                {o?.label||k}
                <button onClick={()=>setExtraGauges(p=>p.filter(x=>x!==k))} style={{background:"none",border:"none",color:"#A78BFA",cursor:"pointer",fontSize:11,lineHeight:1,padding:0}}>×</button>
              </span>);})}
            <select value="" onChange={e=>{const v=e.target.value; if(v) setExtraGauges(p=>p.includes(v)?p:[...p,v]);}}
              style={{background:"#071624",border:"1px solid #1E3A5A",borderRadius:4,padding:"3px 6px",color:"#7DD3FC",fontSize:10,cursor:"pointer"}}>
              <option value="">+ add variable…</option>
              {OVERLAY_VARS.filter(o=>!extraGauges.includes(o.key)).map(o=><option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        )}
        <div style={{position:"relative",height:26,background:"#071624",borderRadius:4,cursor:"pointer",overflow:"hidden"}} onClick={seek}>
          <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pct}%`,background:"#06B6D430",transition:"width 0.5s linear"}}/>
          <div style={{position:"absolute",left:`${pct}%`,top:0,bottom:0,width:2,background:"#06B6D4",transform:"translateX(-50%)"}}/>
          {/* Phase B — shaded "will be deleted" zones + red cut lines
              at the user's chosen trim points. The shading visualises
              what disappears on Save without scaring the user with a
              modal. */}
          {pendingCrop?.deleteUpTo != null && dur > 0 && (
            <>
              <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${Math.min(100,(pendingCrop.deleteUpTo/dur)*100)}%`,background:"rgba(239,68,68,0.20)",pointerEvents:"none"}}/>
              <div style={{position:"absolute",left:`${Math.min(100,(pendingCrop.deleteUpTo/dur)*100)}%`,top:0,bottom:0,width:2,background:"#EF4444",transform:"translateX(-50%)",pointerEvents:"none"}}/>
            </>
          )}
          {pendingCrop?.deleteFrom != null && dur > 0 && (
            <>
              <div style={{position:"absolute",left:`${Math.min(100,(pendingCrop.deleteFrom/dur)*100)}%`,top:0,right:0,bottom:0,background:"rgba(239,68,68,0.20)",pointerEvents:"none"}}/>
              <div style={{position:"absolute",left:`${Math.min(100,(pendingCrop.deleteFrom/dur)*100)}%`,top:0,bottom:0,width:2,background:"#EF4444",transform:"translateX(-50%)",pointerEvents:"none"}}/>
            </>
          )}
          {markers.map((m,i)=><div key={i} onClick={e=>{e.stopPropagation();if(vidRef.current)vidRef.current.currentTime=m.vidSec;}} title={`${m.label} +${fmtT(m.vidSec)}`} style={{position:"absolute",left:`${(m.vidSec/Math.max(dur,1))*100}%`,top:0,bottom:0,width:2,background:m.color,opacity:m.isValid===false?0.3:1,cursor:"pointer"}}/>)}
          <span style={{position:"absolute",left:6,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#334155",pointerEvents:"none",fontFamily:"monospace"}}>{markers.length>0?`${markers.length} events`:row?"● live data":"click to seek"}</span>
        </div>
      </div>
      <div style={{padding:"7px 12px 11px",display:"flex",gap:7,alignItems:"center"}}>
        <button onClick={()=>playing?vidRef.current?.pause():vidRef.current?.play()} style={{background:"#06B6D4",border:"none",borderRadius:6,padding:"6px 14px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>{playing?"⏸ Pause":"▶ Play"}</button>
        <button onClick={()=>{if(vidRef.current)vidRef.current.currentTime=0;}} style={{background:"#1E3A5A",border:"none",borderRadius:6,padding:"6px 9px",color:"#94A3B8",cursor:"pointer"}}>⏹</button>
        <button
          title="Fullscreen (with data overlay)"
          onClick={()=>{
            if(isMobile){
              // CSS pseudo-fullscreen keeps the instrument overlay on top —
              // native iOS video fullscreen would hide it.
              setMobileFs(f=>!f);
              return;
            }
            // Desktop: fullscreen the STAGE container (video + overlay), not
            // the bare <video>, so the gauges render over the picture.
            const el=stageRef.current;
            if(!el)return;
            if(document.fullscreenElement) document.exitFullscreen?.();
            else if(el.requestFullscreen) el.requestFullscreen();
            else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
          }}
          style={{background:"#1E3A5A",border:"none",borderRadius:6,padding:"6px 9px",color:"#94A3B8",cursor:"pointer"}}
        >⛶</button>
        <button
          title="Picture-in-Picture (drag + resize a floating window)"
          onClick={async ()=>{
            const el=vidRef.current;
            if(!el)return;
            try {
              if(document.pictureInPictureElement) await document.exitPictureInPicture?.();
              else if(el.requestPictureInPicture) await el.requestPictureInPicture();
            } catch (err) {
              console.warn('Picture-in-picture unavailable:', err);
            }
          }}
          style={{background:"#1E3A5A",border:"none",borderRadius:6,padding:"6px 9px",color:"#94A3B8",cursor:"pointer"}}
        >⧉</button>
        {/* Phase B — three-button crop UX:
            1. "Delete UPTO here"  — marks the head cut (keeps [t, end])
            2. "Delete FROM here"  — marks the tail cut (keeps [0, t])
            3. "Save cropped video" — appears once any cut is marked;
               runs ffmpeg to commit. Both 1 and 2 can be re-clicked at
               any time to move their marker; the timeline shows the
               shaded delete zones live. */}
        {onDeleteUpTo && (
          <button
            title="Delete everything from start UP TO the current playback position"
            onClick={()=>onDeleteUpTo(curTime)}
            disabled={cropBusy}
            style={{background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"6px 9px",color:"#EF4444",cursor:cropBusy?"not-allowed":"pointer",fontSize:11,fontWeight:600,opacity:cropBusy?0.5:1}}
          >⏴⌫ Delete UPTO here</button>
        )}
        {onDeleteFromHere && (
          <button
            title="Delete everything FROM the current playback position to the end"
            onClick={()=>onDeleteFromHere(curTime)}
            disabled={cropBusy}
            style={{background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"6px 9px",color:"#EF4444",cursor:cropBusy?"not-allowed":"pointer",fontSize:11,fontWeight:600,opacity:cropBusy?0.5:1}}
          >⌫⏵ Delete FROM here</button>
        )}
        {onSaveCrop && (pendingCrop?.deleteUpTo != null || pendingCrop?.deleteFrom != null) && (
          <button
            title="Apply the marked cuts — ffmpeg trims, the result replaces the local original"
            onClick={onSaveCrop}
            disabled={cropBusy}
            style={{background:cropBusy?"#1E3A5A":"#1D9E75",border:"none",borderRadius:6,padding:"6px 12px",color:cropBusy?"#94A3B8":"#fff",cursor:cropBusy?"not-allowed":"pointer",fontSize:11,fontWeight:700}}
          >
            {cropBusy
              ? `Saving ${Math.round((cropProgress?.pct||0)*100)}%`
              : "💾 Save cropped video"}
          </button>
        )}
        {/* Native-pipeline shortcuts — for the "crop in-app → ffmpeg compress
            on disk → re-import" workflow on slow-upload connections. */}
        {onExportToDisk && (
          <button
            title="Save the local clip to disk as MP4 — for external compression with ffmpeg, then bring it back via Replace"
            onClick={onExportToDisk}
            disabled={cropBusy}
            style={{background:"#06B6D420",border:"1px solid #06B6D450",borderRadius:6,padding:"6px 9px",color:"#06B6D4",cursor:cropBusy?"not-allowed":"pointer",fontSize:11,fontWeight:600,opacity:cropBusy?0.5:1}}
          >↓ Save to disk</button>
        )}
        {onUploadCompressed && (
          <button
            title="Upload a compressed copy (from disk) to Bunny — local HD stays untouched for debriefs"
            onClick={onUploadCompressed}
            disabled={cropBusy}
            style={{background:"#06B6D420",border:"1px solid #06B6D450",borderRadius:6,padding:"6px 9px",color:"#06B6D4",cursor:cropBusy?"not-allowed":"pointer",fontSize:11,fontWeight:600,opacity:cropBusy?0.5:1}}
          >↑ Upload compressed</button>
        )}
        <div style={{flex:1}}/>
        {row&&<span style={{fontSize:10,color:"#1D9E75"}}>● live instruments</span>}
        {!polar&&row&&row.vsTarget==null&&<span style={{fontSize:9,color:"#475569"}}>· upload polar for target BSP</span>}
        {isHls&&<span style={{fontSize:9,color:"#8B5CF6"}}>HLS · Stream</span>}
      </div>
    </div>
  );
}

function VideoCard({video,selected,onClick,onThumbLoad,batchMode,batchSelected,onBatchToggle,sessionTzOffset=0}){
  const handleLoaded = () => onThumbLoad?.(video.id);
  const tags = video.tags||[];
  // Clip's start time in session-local clock — replaces the filename label.
  const localStart = (()=>{
    if(video.startUtc==null) return "—";
    const d=new Date(video.startUtc + sessionTzOffset*60000);
    return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
  })();
  const EVENT_TAGS   = ["race-start","topmark","mark"];
  const SAIL_SKIP    = /^(main|msail|mainsail|main-)/;
  const POS_TAGS     = ["upwind","reach","downwind"];
  const MANO_TAGS    = ["tack","gybe"];
  const SKIP_ALWAYS  = new Set(["local","cloud","training","race","today","topmark","mark","race-start","upwind","reach","downwind","tack","gybe"]);
  const isLocationTag = t => !SKIP_ALWAYS.has(t)&&!t.startsWith("tws-")&&!SAIL_SKIP.test(t)&&!t.includes("-20")&&!t.includes("x-")&&t.includes("-")&&!EVENT_TAGS.includes(t)&&!POS_TAGS.includes(t)&&!MANO_TAGS.includes(t);
  const eventTags  = tags.filter(t=>EVENT_TAGS.includes(t));
  const posTags    = tags.filter(t=>POS_TAGS.includes(t)).slice(0,1);
  const manoTags   = tags.filter(t=>MANO_TAGS.includes(t));
  const realSailTags = tags.filter(t=>!SKIP_ALWAYS.has(t)&&!SAIL_SKIP.test(t)&&!t.startsWith("tws-")&&!/^\d+x-/.test(t)&&!isLocationTag(t));
  const topRowTags  = [...new Set([...eventTags, ...posTags, ...manoTags])].filter(Boolean);
  const tagColor = t => {
    if(EVENT_TAGS.includes(t))  return{bg:"#EF444420",bd:"#EF444440",c:"#EF4444"};
    if(POS_TAGS.includes(t))    return{bg:"#06B6D420",bd:"#06B6D440",c:"#06B6D4"};
    if(MANO_TAGS.includes(t))   return{bg:"#1D9E7520",bd:"#1D9E7540",c:"#1D9E75"};
    if(realSailTags.includes(t))return{bg:"#8B5CF620",bd:"#8B5CF640",c:"#A78BFA"};
    return                            {bg:"#1E3A5A",  bd:"#2D4A6A",  c:"#7DD3FC"};
  };
  const isBatchSelected = batchMode && batchSelected?.has(video.id);
  const handleClick = () => batchMode ? onBatchToggle?.(video.id) : onClick?.();
  return(
    <div onClick={handleClick} style={{background:isBatchSelected?"#EF444420":selected&&!batchMode?"#0F2A45":"#0A1929",border:`2px solid ${isBatchSelected?"#EF4444":selected&&!batchMode?"#06B6D4":"#1E3A5A"}`,borderRadius:10,overflow:"hidden",cursor:"pointer",transition:"border-color 0.12s"}}>
      <div style={{aspectRatio:"16/9",width:"100%",background:"#071624",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",overflow:"hidden"}}>
        {video.thumbnailUrl?<img src={video.thumbnailUrl} alt="" loading="eager" fetchpriority="high" decoding="async" onLoad={handleLoaded} onError={handleLoaded} style={{width:"100%",height:"100%",objectFit:"cover",pointerEvents:"none"}}/>:
         video.objectUrl&&video.source!=="cloud"&&!String(video.objectUrl).includes(".m3u8")?<video src={video.objectUrl} onLoadedData={handleLoaded} onError={handleLoaded} style={{width:"100%",height:"100%",objectFit:"cover",pointerEvents:"none",...rotStyle(video.rotation,16,9)}} muted preload="metadata"/>:
         (video.source==="processing"||video.streamProcessing)?<div style={{color:"#F59E0B",fontSize:9}}>⏳</div>:
         <div style={{color:"#1E3A5A",fontSize:9}}>📹</div>}
        <div style={{position:"absolute",bottom:3,right:4,background:"rgba(0,0,0,0.8)",borderRadius:2,padding:"0 3px",fontSize:8,color:"#64748B",fontFamily:"monospace"}}>{video.duration?fmtT(video.duration):"--:--"}</div>
        <div style={{position:"absolute",top:3,right:4}}><SrcBadge source={videoBadgeSrc(video)}/></div>
        {/* Batch checkbox */}
        {batchMode&&(
          <div style={{position:"absolute",top:4,left:4,width:22,height:22,borderRadius:4,
            background:isBatchSelected?"#EF4444":"rgba(0,0,0,0.6)",
            border:`2px solid ${isBatchSelected?"#EF4444":"#64748B"}`,
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:14,color:"#fff",fontWeight:700}}>
            {isBatchSelected?"✓":""}
          </div>
        )}
      </div>
      <div style={{padding:"6px 9px"}}>
        {/* 1) Race tags (start, top mark, gate, tack, gybe, upwind, reach, downwind) */}
        {topRowTags.length>0&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:3}}>
            {topRowTags.map(t=>{const{bg,bd,c}=tagColor(t);return(<span key={t} style={{background:bg,border:`1px solid ${bd}`,color:c,fontSize:8,borderRadius:3,padding:"0 4px",fontFamily:"monospace"}}>{t}</span>);})}
          </div>
        )}
        {/* 2) Sail tags */}
        {realSailTags.length>0&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:3}}>
            {realSailTags.map(t=>{const{bg,bd,c}=tagColor(t);return(<span key={t} style={{background:bg,border:`1px solid ${bd}`,color:c,fontSize:8,borderRadius:3,padding:"0 4px",fontFamily:"monospace"}}>{t}</span>);})}
          </div>
        )}
        {/* 3) TWS & TWA */}
        <div style={{fontSize:9,color:"#7DD3FC",marginBottom:2,fontFamily:"monospace"}}>
          {video.twsAvg!=null?`TWS ${R(video.twsAvg)}kt`:""}{video.twsAvg!=null&&video.twaAvg!=null?" · ":""}{video.twaAvg!=null?`TWA ${R(video.twaAvg,0)}°`:""}
          {video.twsAvg==null&&video.twaAvg==null&&<span style={{color:"#334155"}}>—</span>}
        </div>
        {/* 4) Clip start time (session-local) at bottom — replaces filename */}
        <div title={video.title||""} style={{fontSize:11,fontWeight:600,color:"#E2E8F0",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{localStart}</div>
      </div>
    </div>
  );
}

function TagEditor({video, onSave, tagList=[], suggestionList, sessionDate, onTagListChange}){
  const[tags,    setTags]    = useState(video.tags||[]);
  const[input,   setInput]   = useState("");
  const[dirty,   setDirty]   = useState(false);
  const[listMode,setListMode]= useState(false);
  useEffect(()=>{setTags(video.tags||[]);setDirty(false);},[video.id]);
  const addTag = tag => {
    const t = tag.trim().toLowerCase();
    if(!t || tags.includes(t)) return;
    const next = [...tags, t];
    setTags(next); setDirty(true);
    if(!tagList.includes(t)) onTagListChange?.([...tagList, t].sort());
  };
  const remTag = t => { setTags(p=>p.filter(x=>x!==t)); setDirty(true); };
  const save = async () => {
    await updateVideoTags(video.id, tags);
    // AWAIT the parent's onSave — that's the path that pushes the new tags
    // to the cloud row. Previously the call was fire-and-forget, so if the
    // user clicked Save then refreshed within a second or two the in-flight
    // POST got cancelled by the navigation and the cloud row never updated.
    try { await Promise.resolve(onSave(video.id, tags)); } catch {}
    setDirty(false);
  };
  const deleteFromList = tag => { onTagListChange?.(tagList.filter(t => t !== tag)); };
  // "TAP TO ADD" pulls from the broader suggestion list when one is provided —
  // sessionTagList only contains tags that were added through this UI (or via
  // the <sailsused> import), so it misses tags applied directly to clips.
  // Fall back to tagList so the editor still works in older call sites.
  const suggestionSource = suggestionList && suggestionList.length ? suggestionList : tagList;
  const suggestions = suggestionSource.filter(t => !tags.includes(t));
  return(
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:"1px solid #1E3A5A"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
        <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase"}}>Tags</div>
        <div style={{display:"flex",gap:5}}>
          {dirty&&<button onClick={save} style={{background:"#1D9E75",border:"none",borderRadius:4,padding:"2px 9px",color:"#fff",fontSize:10,cursor:"pointer",fontWeight:700}}>Save</button>}
          <button onClick={()=>setListMode(p=>!p)} style={{background:listMode?"#1E3A5A":"none",border:"1px solid #1E3A5A",borderRadius:4,padding:"2px 8px",color:"#64748B",fontSize:9,cursor:"pointer"}}>{listMode?"✕ Close":"☰ Tag list"}</button>
        </div>
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8,minHeight:24}}>
        {tags.map(t=>(<span key={t} onClick={()=>remTag(t)} style={{background:"#1E3A5A",color:"#7DD3FC",fontSize:10,borderRadius:4,padding:"2px 7px",cursor:"pointer",display:"flex",gap:3,alignItems:"center"}}>#{t}<span style={{color:"#EF4444",fontSize:9}}>×</span></span>))}
        {!tags.length&&<span style={{fontSize:10,color:"#334155"}}>No tags — click a suggestion or type below</span>}
      </div>
      {suggestions.length>0&&(
        <div style={{marginBottom:8}}>
          <div style={{fontSize:9,color:"#334155",letterSpacing:1,marginBottom:4}}>TAP TO ADD</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {suggestions.map(t=>(<button key={t} onClick={()=>addTag(t)} style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:4,padding:"2px 7px",color:"#475569",fontSize:10,cursor:"pointer",fontFamily:"monospace"}}>+{t}</button>))}
          </div>
        </div>
      )}
      <div style={{display:"flex",gap:5}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter"){addTag(input);setInput("");} }} placeholder="Type a tag + Enter…" style={{flex:1,background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 8px",color:"#E2E8F0",fontSize:11,fontFamily:"monospace",outline:"none"}}/>
        <button onClick={()=>{addTag(input);setInput("");}} style={{background:"#06B6D4",border:"none",borderRadius:5,padding:"5px 11px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>+</button>
      </div>
      {listMode&&(
        <div style={{marginTop:10,borderTop:"1px solid #1E3A5A",paddingTop:10}}>
          <div style={{fontSize:9,color:"#475569",letterSpacing:1,marginBottom:6}}>SESSION TAG LIST — click × to remove from list</div>
          {tagList.length===0&&<div style={{fontSize:10,color:"#334155"}}>Empty — import an event file with &lt;sailsused&gt; to auto-populate, or add tags above.</div>}
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {tagList.map(t=>(<span key={t} style={{display:"flex",alignItems:"center",gap:3,background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:4,padding:"2px 7px",fontSize:10,color:"#94A3B8"}}>{t}<span onClick={()=>deleteFromList(t)} style={{color:"#EF4444",fontSize:9,cursor:"pointer",marginLeft:2}}>×</span></span>))}
          </div>
        </div>
      )}
    </div>
  );
}

// Phase B — Crop status banner.
// The UI lives in the video player toolbar now (mark with red lines on
// the timeline via Delete-UPTO/FROM buttons, commit via Save). All this
// component does is surface errors and the "no local blob" warning in
// the sidebar; it renders nothing when the crop is healthy / idle.
function fmtMmSsLong(secs){
  if (secs == null || !isFinite(secs)) return "—";
  const m = Math.floor(secs/60);
  const s = secs - m*60;
  return `${m}:${s.toFixed(s%1?1:0).padStart(s%1?4:2,"0")}`;
}

function VideoCropStatusBanner({video, pendingCrop, cropError, onDismissError}){
  const isLocal = !!video.hasLocalBlob;
  // Only render when there's something to say.
  const hasCutMarked = !!(pendingCrop && (pendingCrop.deleteUpTo != null || pendingCrop.deleteFrom != null));
  if (!cropError && !(hasCutMarked && !isLocal)) return null;

  const fullDur = video.duration || 0;
  const startSec = pendingCrop?.deleteUpTo ?? 0;
  const endSec   = pendingCrop?.deleteFrom ?? fullDur;
  const removeSec = Math.max(0, fullDur - Math.max(0, endSec - startSec));

  return (
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:`1px solid ${cropError?"#EF4444":"#F59E0B"}40`,marginBottom:8}}>
      {cropError ? (
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
          <div style={{fontSize:10,color:"#EF4444",flex:1}}>
            <span style={{fontWeight:700}}>Crop failed.</span> {cropError}
          </div>
          {onDismissError && (
            <button onClick={onDismissError} style={{background:"none",border:"1px solid #EF444440",borderRadius:4,padding:"2px 8px",color:"#EF4444",cursor:"pointer",fontSize:10}}>Dismiss</button>
          )}
        </div>
      ) : (
        <div style={{fontSize:10,color:"#F59E0B"}}>
          Cut marks set (will delete {fmtMmSsLong(removeSec)}), but the original isn't on this device. Open this clip on the device that imported it to apply the crop.
        </div>
      )}
    </div>
  );
}

// Phase B — per-video proxy upload control. Manual trigger by design:
// crew often want to crop a clip first (future feature) before paying
// the transcode cost. Shown only when the row doesn't yet have a proxy.
function RenditionSyncPanel({video, activeDate, onSynced}){
  const [progress, setProgress] = useState(null); // {phase, pct, message}
  const [error, setError]       = useState(null);
  const isBusy = progress && progress.phase !== 'done' && progress.phase !== 'error';

  if (video.hasProxy) {
    const when = video.proxyUploadedAt
      ? new Date(video.proxyUploadedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})
      : null;
    return (
      <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:"1px solid #1D9E7540",marginBottom:8,display:"flex",alignItems:"center",gap:8}}>
        <span style={{color:"#1D9E75",fontSize:13}}>✓</span>
        <div style={{flex:1}}>
          <div style={{fontSize:11,color:"#1D9E75",fontWeight:600}}>Proxy ready{when?` · ${when}`:""}</div>
          <div style={{fontSize:9,color:"#475569"}}>Teammates can stream the 720p preview now.</div>
        </div>
      </div>
    );
  }

  const handleSync = async () => {
    setError(null);
    setProgress({phase:'transcoding', pct:0, message:'Loading source…'});
    try {
      const blob = await getVideoBlob(video.id);
      if (!blob) {
        setError("Original file not on this device. Open this video on the device that imported it.");
        setProgress(null);
        return;
      }
      const sessionDate = video.sessionDate || activeDate;

      // The PATCH endpoint targets the Supabase row by its UUID. For
      // locally-imported videos, `video.id` is still the IDB key (e.g.
      // `v_1779...`), so first ensure a cloud row exists and grab its
      // UUID. Idempotent — repeated clicks dedupe by external_id.
      let cloudId = video.id;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cloudId)) {
        setProgress({phase:'transcoding', pct:0, message:'Registering cloud row…'});
        try {
          const supabase = getBrowserSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) {
            setError("You're signed out. Sign in and try again.");
            setProgress(null);
            return;
          }
          const resolved = await ensureCloudVideoId({
            userId: user.id,
            video,
            sessionDate,
          });
          if (!resolved) {
            setError("Couldn't create the cloud row for this video. Check your team membership in Admin.");
            setProgress(null);
            return;
          }
          cloudId = resolved;
        } catch (e) {
          setError("Failed to register video in cloud: " + (e?.message || String(e)));
          setProgress(null);
          return;
        }
      }

      const result = await syncProxyForVideo({
        videoId: cloudId,
        sessionDate,
        source: blob,
        onProgress: setProgress,
      });
      if (!result.ok) {
        setError(result.error || "Sync failed");
      } else {
        // Tell the parent so it can refresh the row's hasProxy state.
        // Pass BOTH the local and cloud ids so the UI can update either
        // way it might be looking up.
        onSynced?.(video.id, {
          proxyStreamId: result.proxyStreamId,
          proxyBytes: result.proxyBytes,
          cloudId,
        });
      }
    } catch (e) {
      setError(e?.message || String(e));
    }
  };

  return (
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:"1px solid #1E3A5A",marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <div style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase"}}>Proxy preview</div>
        <div style={{fontSize:9,color:"#334155"}}>720p · ~30 MB</div>
      </div>
      {!isBusy && (
        <>
          <div style={{fontSize:10,color:"#94A3B8",marginBottom:6}}>
            Generate a low-bandwidth preview and upload it for the team to watch on phones.
          </div>
          <button
            onClick={handleSync}
            style={{width:"100%",background:"#06B6D4",border:"none",borderRadius:5,padding:"7px 0",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}
          >
            ☁ Sync proxy
          </button>
        </>
      )}
      {isBusy && (
        <div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:10}}>
            <span style={{color:"#7DD3FC",textTransform:"capitalize"}}>{progress.phase}…</span>
            <span style={{color:"#94A3B8",fontFamily:"monospace"}}>{Math.round((progress.pct||0)*100)}%</span>
          </div>
          <div style={{height:6,background:"#1E3A5A",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${Math.round((progress.pct||0)*100)}%`,background:progress.phase==='transcoding'?"#F59E0B":"#06B6D4",transition:"width 0.2s"}}/>
          </div>
          {progress.message && (
            <div style={{fontSize:9,color:"#475569",marginTop:4,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{progress.message}</div>
          )}
        </div>
      )}
      {error && (
        <div style={{marginTop:6,fontSize:10,color:"#EF4444",background:"#EF444410",border:"1px solid #EF444430",borderRadius:4,padding:"5px 7px"}}>
          {error}
        </div>
      )}
    </div>
  );
}

// Phase B.3 — session-level batch sync. Coach/admin tool shown in the
// library's left column. One press transcodes + uploads proxies for every
// un-proxied clip in the session; a second button uploads full-resolution
// originals. Progress rides the shared `syncState` channel (mobileSyncState)
// that the auto-sync queue also drives.
function BatchSyncPanel({videos, syncState, onSyncProxies, onUploadOriginals, syncErrors=[]}){
  // Only clips whose source file is on this device can be synced from here,
  // so the panel counts (and the buttons) consider just those.
  const syncable  = videos.filter(v=>v.hasLocalBlob);
  const total     = syncable.length;
  const haveProxy = syncable.filter(v=>v.hasProxy).length;
  const haveOrig  = syncable.filter(v=>v.hasOriginal).length;
  const needProxy = total - haveProxy;
  const needOrig  = total - haveOrig;
  const busy      = syncState?.phase==="pushing" || syncState?.phase==="pulling";
  // On desktop we now skip the client-side proxy transcode entirely —
  // Bunny Stream encodes the full adaptive ladder (incl. 720p for mobile
  // viewers) from the uploaded original, so the proxy is wasted CPU on
  // multi-GB sources. The proxy button + progress row are hidden here;
  // mobile keeps both because field wifi makes the small proxy useful
  // as a first-pass preview before originals upload from a fast link.
  const isMobile  = useIsMobile();
  const showProxy = isMobile;

  const row = (label, have, color) => (
    <div style={{marginBottom:6}}>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,marginBottom:3}}>
        <span style={{color:"#475569",letterSpacing:1,textTransform:"uppercase"}}>{label}</span>
        <span style={{color:total>0&&have===total?color:"#64748B",fontFamily:"monospace"}}>{have}/{total}</span>
      </div>
      <div style={{height:4,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
        <div style={{height:"100%",width:`${total?Math.round((have/total)*100):0}%`,background:color,transition:"width .3s"}}/>
      </div>
    </div>
  );

  return (
    <div style={{background:"#071624",borderRadius:8,padding:"10px 11px",border:"1px solid #1E3A5A",marginBottom:12}}>
      <div style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Cloud sync · session</div>
      {total === 0 ? (
        <div style={{fontSize:9,color:"#64748B",lineHeight:1.5}}>
          No clips in this session have their source file on this device, so
          there is nothing to sync from here. Open the session on the device
          that imported the clips to sync their proxies and originals.
        </div>
      ) : (
        <>
          {showProxy && row("Proxies · 720p", haveProxy, "#06B6D4")}
          {row("Originals · HD", haveOrig, "#8B5CF6")}
          {busy && syncState?.message && (
            <div style={{margin:"7px 0"}}>
              <div style={{fontSize:9,color:"#7DD3FC",fontFamily:"monospace",lineHeight:1.4,wordBreak:"break-word",marginBottom:3}}>{syncState.message}</div>
              <div style={{height:4,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${syncState.progress||0}%`,background:"#06B6D4",transition:"width .3s"}}/>
              </div>
            </div>
          )}
          {/* WHY an upload failed — shown here because addLog() only renders in the
              Upload tab, which mobile users never see. Without this a rejected
              upload finished instantly and looked like it simply did nothing. */}
          {syncErrors.length>0 && (
            <div style={{marginTop:8,background:"#EF444412",border:"1px solid #EF444440",
              borderRadius:6,padding:"7px 8px"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <div style={{fontSize:10,fontWeight:700,color:"#EF4444",flex:1}}>
                  {syncErrors.length} upload{syncErrors.length===1?"":"s"} failed
                </div>
                {/* No devtools on a phone — let the reason be copied out. */}
                <button
                  onClick={()=>{
                    const txt=syncErrors.map(e=>`${e.label}: ${e.message}`).join('\n');
                    try{navigator.clipboard?.writeText(txt);}catch{}
                  }}
                  style={{background:"none",border:"1px solid #EF444440",borderRadius:4,
                    color:"#FCA5A5",fontSize:9,padding:"2px 6px",cursor:"pointer",flexShrink:0}}>
                  Copy
                </button>
              </div>
              {syncErrors.slice(0,4).map((e,i)=>(
                <div key={i} style={{fontSize:9,color:"#FCA5A5",lineHeight:1.4,marginBottom:2,wordBreak:"break-word"}}>
                  <span style={{color:"#F87171",fontWeight:600}}>{e.label}</span>: {e.message}
                </div>
              ))}
            </div>
          )}
          {/* Auto-upload is Wi-Fi-only. Say so, otherwise a crew member on 4G just
              sees clips sitting there and assumes the app is broken. The buttons
              below still work on any link — this is an explanation, not a block. */}
          {showProxy && needProxy>0 && !busy && !onWifi() && (
            <div style={{marginTop:8,fontSize:10,color:"#F59E0B",background:"#F59E0B12",
              border:"1px solid #F59E0B30",borderRadius:5,padding:"5px 7px",lineHeight:1.35}}>
              📶 Not on Wi-Fi — {needProxy} clip{needProxy===1?"":"s"} held. They upload automatically
              when you're on Wi-Fi, or tap below to upload now on mobile data.
            </div>
          )}
          {showProxy && (
            <button onClick={onSyncProxies} disabled={busy||needProxy===0}
              style={{width:"100%",marginTop:8,background:needProxy===0?"#0A1929":"#06B6D4",border:"none",borderRadius:6,
                padding:"7px 0",color:needProxy===0?"#475569":"#000",fontWeight:700,fontSize:11,
                cursor:(busy||needProxy===0)?"not-allowed":"pointer",opacity:busy?0.6:1}}>
              {needProxy===0?"✓ All proxies synced":`☁ Upload ${needProxy} clip${needProxy===1?"":"s"} now`}
            </button>
          )}
          {/* Originals are the primary sync action on desktop (we skip the
              proxy entirely there) — promote to filled style + larger pad
              when the proxy button is hidden. */}
          <button onClick={onUploadOriginals} disabled={busy||needOrig===0}
            style={{width:"100%",marginTop:showProxy?6:8,
              background: showProxy
                ? "none"
                : (needOrig===0?"#0A1929":"#8B5CF6"),
              border: showProxy
                ? `1px solid ${needOrig===0?"#1E3A5A":"#8B5CF6"}`
                : "none",
              borderRadius:6,
              padding: showProxy ? "6px 0" : "7px 0",
              color: showProxy
                ? (needOrig===0?"#475569":"#A78BFA")
                : (needOrig===0?"#475569":"#fff"),
              fontWeight:700,fontSize:11,
              cursor:(busy||needOrig===0)?"not-allowed":"pointer",opacity:busy?0.6:1}}>
            {needOrig===0?"✓ All originals uploaded":`⇪ Upload ${needOrig} original${needOrig===1?"":"s"}`}
          </button>
          <div style={{fontSize:8,color:"#334155",marginTop:6,lineHeight:1.4}}>
            Proxies stream instantly on phones. Originals are full quality — upload them with the button when on fast wifi.
          </div>
        </>
      )}
    </div>
  );
}

function SyncControl({offset,onChange,onSave,saving=false,saveLabel="💾 Save"}){
  return(
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:"1px solid #1E3A5A"}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
        <span style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase"}}>Sync offset</span>
        <span style={{fontSize:11,fontFamily:"monospace",color:offset!==0?"#F59E0B":"#334155"}}>{offset>0?"+":""}{offset}s</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:3,marginBottom:offset!==0?5:0}}>
        {[[-3600,"-1h"],[-60,"-1m"],[-10,"-10s"],[-1,"-1s"],[1,"+1s"],[10,"+10s"],[60,"+1m"],[3600,"+1h"]].map(([v,l])=><button key={l} disabled={saving} onClick={()=>onChange(offset+v)} style={{background:"#1E3A5A",border:"none",borderRadius:3,padding:"4px 0",color:"#7DD3FC",cursor:saving?"not-allowed":"pointer",fontSize:10,fontFamily:"monospace",opacity:saving?0.5:1}}>{l}</button>)}
      </div>
      {offset!==0&&(
        <div style={{display:"flex",gap:5}}>
          {onSave && (
            <button onClick={()=>onSave(offset)} disabled={saving}
              style={{flex:2,background:saving?"#1E3A5A":"#1D9E75",border:"none",borderRadius:4,padding:"5px",color:saving?"#94A3B8":"#fff",cursor:saving?"not-allowed":"pointer",fontSize:11,fontWeight:700}}>
              {saving?"Saving…":saveLabel}
            </button>
          )}
          <button onClick={()=>onChange(0)} disabled={saving}
            style={{flex:1,background:"none",border:"1px solid #EF444440",borderRadius:4,padding:"3px",color:"#EF4444",cursor:saving?"not-allowed":"pointer",fontSize:10,opacity:saving?0.5:1}}>
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

function StartTimeEditor({video, logData, onSave, sessionTzOffset=0}){
  const [editing, setEditing] = useState(false);
  const [val, setVal]         = useState("");
  const tzShort = sessionTzOffset===120?"CEST":sessionTzOffset===60?"CET":sessionTzOffset===0?"UTC":sessionTzOffset>0?`UTC+${sessionTzOffset/60}`:`UTC${sessionTzOffset/60}`;
  const toInputLocal = utc => { if(!utc) return ""; return new Date(utc + sessionTzOffset*60000).toISOString().slice(0,19); };
  const fromInputLocal = s => s ? new Date(s+"Z").getTime() - sessionTzOffset*60000 : null;
  const fmtLocal = utc => {
    if(!utc) return "";
    const d = new Date(utc + sessionTzOffset*60000);
    return `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}/${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
  };
  const suggested = video.startUtc ? toInputLocal(video.startUtc) : logData?.startUtc ? toInputLocal(logData.startUtc) : "";
  const open = () => { setVal(suggested); setEditing(true); };
  const save = () => { const utc=fromInputLocal(val); if(utc&&!isNaN(utc)) onSave(video.id,utc); setEditing(false); };
  const hasStart = !!video.startUtc;
  const BUFFER_MS = 300_000;
  const inLog = hasStart && logData?.rows?.length && video.startUtc >= (logData.startUtc - BUFFER_MS) && video.startUtc <= (logData.endUtc + BUFFER_MS);
  return (
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:`1px solid ${!hasStart?"#EF444440":inLog?"#1D9E7540":"#F59E0B40"}`,marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:3}}>Video start time ({tzShort})</div>
          {hasStart
            ? <div style={{fontSize:11,fontFamily:"monospace",color:inLog?"#1D9E75":"#F59E0B"}}>{fmtLocal(video.startUtc)} <span style={{opacity:0.5,fontSize:9}}>{tzShort}</span><span style={{fontSize:9,marginLeft:6}}>{inLog?"✓ within log":logData?"⚠ outside log — adjust":"(no log loaded)"}</span></div>
            : <div style={{fontSize:10,color:"#EF4444"}}>Not set — instruments and events won't show</div>
          }
          {hasStart&&logData&&!inLog&&(<div style={{fontSize:9,color:"#475569",marginTop:3}}>Log: {fmtLocal(logData.startUtc).slice(11,16)}–{fmtLocal(logData.endUtc).slice(11,16)} {tzShort}{" · "}wrong timezone? Change in Upload tab.</div>)}
        </div>
        <button onClick={editing?save:open} style={{background:editing?"#1D9E75":"#1E3A5A",border:"none",borderRadius:4,padding:"3px 9px",color:editing?"#fff":"#94A3B8",cursor:"pointer",fontSize:10,fontWeight:editing?700:400,marginLeft:8,flexShrink:0}}>{editing?"Save":"Edit"}</button>
      </div>
      {editing && (
        <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:6}}>
          <input type="datetime-local" step="1" value={val} onChange={e=>setVal(e.target.value)} style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 8px",color:"#E2E8F0",fontSize:11,fontFamily:"monospace",outline:"none",width:"100%",boxSizing:"border-box"}}/>
          {logData?.startUtc && (
            <div style={{display:"flex",gap:5}}>
              <button onClick={()=>setVal(toInputLocal(logData.startUtc))} style={{flex:1,background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:4,padding:"4px 0",color:"#7DD3FC",cursor:"pointer",fontSize:10}}>Log start {fmtLocal(logData.startUtc).slice(11,16)} {tzShort}</button>
              {logData.endUtc&&<button onClick={()=>setVal(toInputLocal(Math.round((logData.startUtc+logData.endUtc)/2)))} style={{flex:1,background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:4,padding:"4px 0",color:"#7DD3FC",cursor:"pointer",fontSize:10}}>Midpoint</button>}
            </div>
          )}
          <div style={{fontSize:9,color:"#334155"}}>Enter in <strong style={{color:"#475569"}}>{tzShort}</strong> local time (same as log & events). Stored as UTC internally.</div>
        </div>
      )}
    </div>
  );
}

// ─── UPLOAD TAB ───────────────────────────────────────────────────────────────
// ─── SYNC PROGRESS PANEL ─────────────────────────────────────────────────────
// Shows an overall progress bar + per-item status rows.
// Used both inside UploadTab (inline) and as a modal overlay from Library header.
function SyncProgressPanel({progress, phase, onCancel, compact=false}){
  if(!progress) return null;
  const {items=[], overall=0, elapsed=0, error=null} = progress;
  const done = phase==="done";

  const stateIcon = s => s==="done"?"✓":s==="active"?"⟳":s==="processing"?"⌛":s==="error"?"✕":"·";
  const stateColor = s => s==="done"?"#1D9E75":s==="active"?"#06B6D4":s==="processing"?"#F59E0B":s==="error"?"#EF4444":"#334155";
  const fmtElapsed = s => s<60?`${s}s`:`${Math.floor(s/60)}m ${s%60}s`;

  return(
    <div style={{background:"#0A1929",border:`1px solid ${done?"#1D9E75":"#8B5CF6"}40`,borderRadius:10,padding:compact?"10px 12px":"14px 16px"}}>
      {/* Header row */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
        <span style={{fontSize:compact?11:13,fontWeight:700,color:done?"#1D9E75":"#8B5CF6"}}>
          {done?"✓ Sync complete":"⟳ Syncing to cloud…"}
        </span>
        <span style={{fontSize:10,color:"#475569",marginLeft:2}}>{fmtElapsed(elapsed)}</span>
        <div style={{flex:1}}/>
        <span style={{fontSize:11,fontWeight:700,color:done?"#1D9E75":"#06B6D4",fontFamily:"monospace"}}>
          {overall}%
        </span>
        {!done&&onCancel&&(
          <button onClick={onCancel}
            style={{background:"none",border:"1px solid #EF444440",borderRadius:5,
              padding:"2px 8px",color:"#EF4444",fontSize:10,cursor:"pointer"}}>
            Cancel
          </button>
        )}
      </div>

      {/* Overall progress bar */}
      <div style={{height:6,background:"#071624",borderRadius:3,overflow:"hidden",marginBottom:10}}>
        <div style={{
          height:"100%",borderRadius:3,
          background:done?"#1D9E75":"linear-gradient(90deg,#8B5CF6,#06B6D4)",
          width:`${overall}%`,
          transition:"width 0.4s ease",
        }}/>
      </div>

      {/* Per-item rows */}
              {!compact&&(
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          {items.map(it=>{
            const badgeSrc=it.state==="done"?"cloud":it.state==="processing"?"processing":"local";
            return(
            <div key={it.id} style={{display:"flex",alignItems:"center",gap:8,
              background:"#071624",borderRadius:6,padding:"5px 10px"}}>
              <span style={{fontSize:12,color:stateColor(it.state),width:14,textAlign:"center",flexShrink:0}}>
                {stateIcon(it.state)}
              </span>
              <span style={{flex:1,fontSize:10,color:"#94A3B8",overflow:"hidden",
                textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.label}</span>
              {(it.state==="active")&&(
                <div style={{width:80,height:3,background:"#1E3A5A",borderRadius:2,overflow:"hidden",flexShrink:0}}>
                  <div style={{height:"100%",background:"#06B6D4",
                    width:`${it.pct||0}%`,borderRadius:2,transition:"width 0.4s ease"}}/>
                </div>
              )}
              {(it.state==="processing")&&(
                <span style={{fontSize:9,color:"#F59E0B",fontFamily:"monospace",flexShrink:0}}>encoding…</span>
              )}
              <span style={{fontSize:9,color:stateColor(it.state),fontFamily:"monospace",
                width:32,textAlign:"right",flexShrink:0}}>
                {it.state==="done"?"100%":it.pct>0?`${it.pct}%`:""}
              </span>
              <SrcBadge source={badgeSrc}/>
            </div>
          );})}
        </div>
      )}

      {error&&(
        <div style={{marginTop:8,fontSize:10,color:"#EF4444",background:"#EF444410",
          borderRadius:5,padding:"6px 10px"}}>{error}</div>
      )}
    </div>
  );
}

// NOTE: sailInventory / campaignCfg / setSailDiff / syncOffsets are USED in this
// component's save path but were never declared as props — they're SSAApp state. Every
// reference threw `ReferenceError`, and each one sits inside a `try {} catch {}`, so the
// throw was swallowed and the feature silently did nothing: the event-file sail
// reconcile never ran, the day's timeline nodes were never persisted, and the session
// never pushed to the cloud. Declaring them here is the whole fix.
function UploadTab({role,cloudStatus,onImported,sailInventory=[],campaignCfg=null,setSailDiff=()=>{},syncOffsets={}}){
  const perms=ROLES[role];
  // ── Refs ──────────────────────────────────────────────────────────────────
  const vidRef=useRef(null),csvRef=useRef(null),xmlRef=useRef(null),polarRef=useRef(null);
  const[pendingVids,setPendingVids]=useState([]);
  const[pendingPhotos,setPendingPhotos]=useState([]);
  // Photo failures, kept ON SCREEN. Previously every reason went only to addLog (the
  // little console) or a chip truncated to 16 chars — and when the import dropped ALL
  // the files there were no rows at all, so the status just flashed and vanished with
  // no explanation. These persist until dismissed.
  const[photoErrors,setPhotoErrors]=useState([]);
  const[photosDone,setPhotosDone]=useState(0);
  const[photoBusy,setPhotoBusy]=useState(false);
  const[csvParsed,setCsvParsed]=useState(null);
  // Ref mirror — handleVids (deps [vidTz]) needs the log's true-UTC window to
  // decide whether a clip's mvhd clock is UTC or local, without a stale closure.
  const csvParsedRef=useRef(csvParsed); useEffect(()=>{csvParsedRef.current=csvParsed;},[csvParsed]);
  const[xmlParsed,setXmlParsed]=useState(null);
  const[csvFile,setCsvFile]=useState(null);
  const[xmlFile,setXmlFile]=useState(null);
  // ── Polar state ──────────────────────────────────────────────────────────
  const[polarFile,setPolarFile]=useState(null);
  const[polarParsed,setPolarParsed]=useState(null);
  // Load saved polar name from localStorage on mount
  const[savedPolarName,setSavedPolarName]=useState(()=>{
    try{return JSON.parse(localStorage.getItem(POLAR_KEY)||"{}").filename||null;}catch{return null;}
  });
  const[dragOver,setDragOver]=useState(false);
  const[phase,setPhase]=useState("idle");
  const[log,setLog]=useState([]);
  const[savedDate,setSavedDate]=useState(null);
  const[savedVids,setSavedVids]=useState([]);
  const[streamStatus,setStreamStatus]=useState({});
  const[syncProgress,setSyncProgress]=useState(null);
  const syncTimerRef=useRef(null);
  const syncAbortRef=useRef(false);
  const[csvTz, setCsvTz] =useState(DEFAULT_TZ);
  const[xmlTz, setXmlTz] =useState(DEFAULT_TZ);
  const[vidTz, setVidTz] =useState(DEFAULT_TZ);
  // Ref mirror of vidTz so the log-driven auto-tz can re-base already-queued
  // videos without a stale closure (parseCsvWithTz is a deps-[] callback).
  const vidTzRef=useRef(vidTz); useEffect(()=>{vidTzRef.current=vidTz;},[vidTz]);
  // No log = no GPS to detect the venue zone. Default the upload zones to THIS
  // machine's current zone (a sensible "where I am" guess) until a log auto-detects
  // the real venue zone from its lat/lon. Done on mount to avoid SSR hydration drift.
  useEffect(()=>{ const m=-new Date().getTimezoneOffset(); setCsvTz(m); setXmlTz(m); setVidTz(m); vidTzRef.current=m; },[]);

  const addLog=msg=>setLog(p=>[...p.slice(-30),msg]);

  const TzSelect=({value,onChange,label})=>{
    // Always include the current value (e.g. a viewer in NZ on UTC+12/+13, or a
    // log-derived offset) even if it isn't one of the preset options.
    const opts = TZ_OPTIONS.some(o=>o.offsetMin===value)
      ? TZ_OPTIONS
      : [{offsetMin:value,label:`UTC${value>=0?'+':''}${value/60}  (selected)`},...TZ_OPTIONS];
    return (
      <div style={{marginTop:8}}>
        <div style={{fontSize:9,color:"#475569",letterSpacing:1,marginBottom:3}}>{label}</div>
        <select value={value} onChange={e=>onChange(Number(e.target.value))} style={{width:"100%",background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 7px",color:"#94A3B8",fontSize:10,cursor:"pointer"}}>
          {opts.map(o=>(<option key={o.offsetMin} value={o.offsetMin}>{o.label}</option>))}
        </select>
      </div>
    );
  };

  const handleVids=useCallback(files=>{
    const valid=Array.from(files).filter(f=>f.type.startsWith("video/")||/\.(mp4|mov|mts|avi|mkv|m4v)$/i.test(f.name));
    if(!valid.length){addLog("✕ No video files found. MP4/MOV/MTS/AVI accepted.");return;}
    setPendingVids(p=>[...p,...valid.map(f=>({id:Math.random().toString(36).slice(2),file:f,name:f.name,size:f.size,url:URL.createObjectURL(f),duration:null,startUtc:null,tsSource:null}))]);
    addLog(`✓ ${valid.length} video${valid.length>1?"s":""} queued — reading timestamps…`);
    // ONE pass per file: probe first (decodability + duration), then resolve the
    // timestamp — the duration is needed to tell a start-of-recording stamp from an
    // end-of-recording one, so the probe must come first.
    valid.forEach(async f=>{
      const probe=await probeVideo(f);
      if(!probe.ok){
        // A clip the browser can't decode is black in the card, black on playback, and
        // cannot be transcoded — say so here rather than letting three things fail.
        addLog(`✕ ${f.name}: ${probe.reason}`);
        setPendingVids(p=>p.map(v=>v.file===f?{...v,error:probe.reason,undecodable:true}:v));
      } else {
        addLog(`✓ ${f.name}: ${probe.width}×${probe.height}, ${Math.round(probe.duration||0)}s — decodes OK`);
        setPendingVids(p=>p.map(v=>v.file===f?{...v,duration:probe.duration||v.duration||null}:v));
      }
      const durSec = probe.ok ? (probe.duration||0) : 0;

      const result=await extractVideoCreationTime(f);
      setPendingVids(p=>p.map(v=>{
        if(v.file!==f)return v;
        if(result){
          // mvhd may be true UTC (spec) or camera-local (GoPro/DJI) — decide from
          // evidence rather than subtracting vidTz blindly. `rawUtc`/`localClock`
          // are kept so a later venue-tz change re-bases only the local-clock clips.
          const r=resolveStartUtc(result,vidTz,csvParsedRef.current,durSec);
          const label=result.source==="apple-meta"?"iPhone capture date"
                     :result.source==="filename"?"filename timestamp":"camera timestamp";
          const cam=result.camera||{};
          const camName=cam.vendor?`${cam.vendor}${cam.model&&cam.model!==cam.vendor?` (${cam.model})`:''}`:null;
          addLog(`${r.suspect?'⚠':'✓'} ${f.name}${camName?` [${camName}]`:''}: ${label} ${fmtDateTime(r.utc)} UTC — ${r.how}`);

          // ── TIMESTAMP FORENSICS ────────────────────────────────────────────
          // The file carries TWO independent times. On an untouched clip they mark the
          // SAME instant. If one marks the start and the other the moment the file was
          // finalised, they differ by exactly the DURATION — which is measurable, unlike
          // an eyeballed sync offset. Print both, their gap, and the duration, so the
          // relationship is read off the file instead of inferred.
          const keysUtc = result.source==='apple-meta' ? result.utc : null;
          const mvhdUtc = result.mvhdUtc ?? null;
          let diag = null;
          if (keysUtc!=null && mvhdUtc!=null) {
            const gap = Math.round((keysUtc - mvhdUtc)/1000);
            const dur = Math.round(durSec||0);
            const verdict = !dur ? 'no duration to compare'
              : Math.abs(Math.abs(gap) - dur) <= 3 ? 'GAP == DURATION → one of them is the END of recording'
              : Math.abs(gap) <= 3 ? 'same instant → both mark the same point'
              : 'gap does not match the duration → something else is going on';
            diag = `Keys=${new Date(keysUtc).toISOString().slice(11,19)}Z · mvhd=${new Date(mvhdUtc).toISOString().slice(11,19)}Z · gap=${gap}s · duration=${dur}s → ${verdict}`;
          } else if (mvhdUtc!=null) {
            const dur = Math.round(durSec||0);
            const nameStart = result.nameUtc!=null ? result.nameUtc - vidTz*60000 : null;
            if (nameStart!=null) {
              const gap = Math.round((mvhdUtc - nameStart)/1000);
              const verdict = !dur ? 'no duration to compare'
                : Math.abs(gap - dur) <= 5 ? 'mvhd − filename == DURATION → mvhd is the END of recording; filename is the start'
                : Math.abs(gap) <= 5 ? 'same instant → mvhd and the filename agree'
                : 'gap does not match the duration → neither start nor clean end';
              diag = `filename start=${new Date(nameStart).toISOString().slice(11,19)}Z · mvhd=${new Date(mvhdUtc).toISOString().slice(11,19)}Z · gap=${gap}s · duration=${dur}s → ${verdict}`;
            } else {
              diag = `mvhd=${new Date(mvhdUtc).toISOString().slice(11,19)}Z · duration=${dur}s · no Apple capture date and no filename timestamp`;
            }
          }
          if (diag) addLog(`   ⓘ ${f.name}: ${diag}`);
          return{...v,startUtc:r.utc,tsSource:result.source,rawUtc:result.utc,localClock:r.localClock,
                 tsSuspect:!!r.suspect,tsHow:r.how,tsDiag:diag||null,
                 cameraVendor:cam.vendor||null,cameraModel:cam.model||null,
                 duration:v.duration||durSec||null};
        }
        if(f.lastModified&&durSec){const raw=f.lastModified-durSec*1000;addLog(`✓ ${f.name}: using file modified time (no MP4 metadata)`);return{...v,startUtc:raw-vidTz*60000,tsSource:"lastmodified",rawUtc:raw,localClock:true};}
        addLog(`⚠ ${f.name}: no timestamp — set manually in Videos`);
        return v;
      }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[vidTz]);

  // Photos: import (EXIF-date bucketed + tagged from the day's log/event file if
  // local), upload thumbnail immediately, defer the original to a good (WiFi)
  // connection. Mirrors the video proxy/original tiering.
  const handlePhotos=useCallback(async files=>{
    setPhotoBusy(true);
    setPhotoErrors([]);
    const fails=[];
    const photos=await importPhotoFiles(files,{
      onLog: addLog,
      onError: (name,message)=>fails.push({name,message}),
    });
    if(fails.length) setPhotoErrors(p=>[...p,...fails]);
    if(!photos.length){
      // Used to return silently — the status vanished and the user was told nothing.
      if(!fails.length) setPhotoErrors([{name:'import',message:'no photos were imported (no reason reported)'}]);
      setPhotoBusy(false);
      return;
    }
    setPendingPhotos(p=>[...p,...photos.map(x=>({id:x.id,name:x.name,size:x.size,sessionDate:x.sessionDate,thumbSynced:false,originalSynced:false,error:null}))]);
    if(!cloudStatus?.available){
      const msg="Cloud unavailable — photos saved on this device only. They'll sync when the cloud is reachable.";
      addLog("⚠ "+msg);
      setPhotoErrors(p=>[...p,{name:'cloud',message:msg}]);
      setPhotoBusy(false);
      return;
    }
    let ok=0;
    for(const ph of photos){
      try{
        const u=await syncOnePhoto(ph);
        if(u.thumbSynced) ok++;
        setPendingPhotos(p=>p.map(it=>it.id===ph.id?{...it,thumbSynced:u.thumbSynced,originalSynced:u.originalSynced}:it));
      }catch(e){
        const msg=e?.message||'upload failed';
        addLog(`✕ ${ph.name}: ${msg}`);
        setPendingPhotos(p=>p.map(it=>it.id===ph.id?{...it,error:msg}:it));
        setPhotoErrors(p=>[...p,{name:ph.name,message:msg}]);
      }
    }
    // Done: clear the in-progress list (keep only any that errored) + tally.
    setPendingPhotos(p=>p.filter(it=>it.error));
    setPhotosDone(d=>d+ok);
    setPhotoBusy(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cloudStatus]);

  // One dropzone for both: route each file to the right handler.
  const handleMixedDrop=useCallback(fileList=>{
    const files=Array.from(fileList);
    const vids=files.filter(f=>f.type.startsWith("video/")||/\.(mp4|mov|mts|avi|mkv|m4v)$/i.test(f.name));
    const imgs=files.filter(f=>f.type.startsWith("image/")||/\.(jpg|jpeg|png|heic|heif|webp)$/i.test(f.name));
    if(vids.length)handleVids(vids);
    if(imgs.length)handlePhotos(imgs);
    if(!vids.length&&!imgs.length)addLog("✕ No video or photo files found.");
  },[handleVids,handlePhotos]);

  const parseCsvWithTz=useCallback((file,tz,auto=false)=>{
    if(!file)return;setCsvFile(file);
    const r=new FileReader();
    r.onload=e=>{
      try{
        const text=e.target.result;
        // Format is auto-detected from the file (raw / flat-OLE / flat-NMEA);
        // the active boat's stored log profile (channel-label aliases) is applied
        // on top. raw + flat-OLE are already UTC → the tz offset only affects the
        // legacy flat-NMEA CSV.
        let boatProfile=null;
        try{ boatProfile=JSON.parse(localStorage.getItem('ssa:log-profile:active')||'null'); }catch{}
        let effTz=tz;
        let p=parseLog(text,{boatProfile,tzOffsetMin:effTz});
        // Auto-derive the LOCAL/venue timezone (display) from the log's GPS
        // position, DST-aware — so the user never has to pick it. Manual changes
        // via the dropdown call this with auto=false and are respected.
        if(auto){
          const gp=p.rows.find(rr=>Number.isFinite(rr.lat)&&Number.isFinite(rr.lon));
          const at=p.startUtc||gp?.utc;
          const z=gp&&at?offsetFromCoords(gp.lat,gp.lon,at):null;
          if(z){
            effTz=z.offsetMin;
            setCsvTz(effTz);
            // flat-NMEA timestamps were converted with the old offset → re-parse.
            if(p.format==='flat-nmea') p=parseLog(text,{boatProfile,tzOffsetMin:effTz});
            // The venue zone (from the LOG's lat/lon) is authoritative for the
            // whole session — drive the VIDEO offset from it too, and re-base any
            // already-queued clips so their camera wall-clock → true-UTC uses the
            // venue offset, never the viewer's machine zone.
            if(vidTzRef.current!==effTz){
              const old=vidTzRef.current;
              setPendingVids(pv=>pv.map(v=>{
                if(v.startUtc==null||!v.tsSource)return v;
                // Clips whose clock was already true UTC (spec-compliant mvhd) never
                // had an offset applied — re-basing them would BREAK them. Only the
                // local-clock clips need the venue offset swapped.
                if(v.localClock===false)return v;
                const raw=v.rawUtc??(v.startUtc+old*60000); // camera wall-clock-as-UTC
                return {...v,startUtc:raw-effTz*60000,rawUtc:raw};
              }));
              setVidTz(effTz); vidTzRef.current=effTz;
            }
            const lbl=TZ_OPTIONS.find(o=>o.offsetMin===effTz)?.label||`UTC${effTz>=0?'+':''}${effTz/60}`;
            addLog(`🌍 Timezone from log position (${z.zone}) → ${lbl} · applied to log, video & photos`);
          }
        }
        setCsvParsed(p);
        const fmtLabel=p.format==='raw'?`raw ${p.version||''}`:p.format==='flat-ole'?'flat UTC':'flat CSV';
        const tzNote=p.format==='flat-nmea'?(TZ_OPTIONS.find(o=>o.offsetMin===effTz)?.label||`UTC+${effTz/60}`):'UTC';
        addLog(`✓ Log (${fmtLabel.trim()}): ${p.rows.length.toLocaleString()} rows · ${file.name} · ${tzNote}`);
      }
      catch(err){addLog(`✕ CSV: ${err instanceof Error?err.message:String(err)}`);}
    };
    r.readAsText(file);
  },[]);

  const parseXmlWithTz=useCallback((file,tz)=>{
    if(!file)return;setXmlFile(file);
    const r=new FileReader();
    r.onload=e=>{
      try{const p=parseXmlEvents(e.target.result,tz);setXmlParsed(p);const tzLabel=TZ_OPTIONS.find(o=>o.offsetMin===tz)?.label||`UTC+${tz/60}`;addLog(`✓ Events: ${p.tackJibes.length} T/G · ${p.markRoundings.length} marks · ${file.name} · ${tzLabel}`);}
      catch(err){addLog(`✕ XML: ${err instanceof Error?err.message:String(err)}`);}
    };
    r.readAsText(file);
  },[]);

  const handleCsv=useCallback(file=>{parseCsvWithTz(file,csvTz,true);},[csvTz,parseCsvWithTz]);
  const handleXml=useCallback(file=>{parseXmlWithTz(file,xmlTz);},[xmlTz,parseXmlWithTz]);

  // ── Polar upload handler — parses and persists to localStorage ────────────
  const handlePolar=useCallback(file=>{
    if(!file)return;
    const r=new FileReader();
    r.onload=e=>{
      try{
        const p=parsePolarFile(e.target.result);
        setPolarParsed(p);setPolarFile(file);
        savePolarToLS(file.name,p);setSavedPolarName(file.name);
        addLog(`✓ Polar: ${p.entries.length} TWS rows · ${p.entries[0].points.length} TWA pts · TWS ${p.tws[0]}–${p.tws[p.tws.length-1]} kn · ${file.name}`);
      }catch(err){addLog(`✕ Polar: ${err instanceof Error?err.message:String(err)}`);}
    };
    r.readAsText(file);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const onCsvTzChange=tz=>{setCsvTz(tz);if(csvFile)parseCsvWithTz(csvFile,tz);};
  const onXmlTzChange=tz=>{setXmlTz(tz);if(xmlFile)parseXmlWithTz(xmlFile,tz);};
  const onVidTzChange=tz=>{
    setVidTz(tz);
    setPendingVids(p=>p.map(v=>{
      if(!v.startUtc||!v.tsSource)return v;
      // A clip whose camera clock was already true UTC carries no offset to swap.
      if(v.localClock===false)return v;
      const rawUtc=v.rawUtc??(v.startUtc+vidTz*60000);
      return{...v,startUtc:rawUtc-tz*60000,rawUtc};
    }));
  };

  const saveLocal=async()=>{
    if(!pendingVids.length&&!csvParsed&&!xmlParsed)return;
    setPhase("saving");setLog([]);

    // ── Derive per-file session dates from each file's own timestamp ────────
    // Helper: convert a UTC ms value to YYYY-MM-DD using the video tz offset
    const utcToDate = (ms, tzMin) => new Date(ms + tzMin * 60000).toISOString().slice(0, 10);
    const fallbackDate = TODAY();

    // CSV log → its own date
    const csvDate = csvParsed?.startUtc
      ? new Date(csvParsed.startUtc).toISOString().slice(0, 10)
      : null;

    // XML events → its own date
    const xmlDate = xmlParsed?.meta?.date || null;

    if (csvParsed) {
      const d = csvDate || fallbackDate;
      addLog(`Saving log → session ${fmtDate(d)}…`);
      // Tag the log entry with the active workspace so cross-tenant local
      // data doesn't bleed when an admin switches teams.
      const supaForLog = getBrowserSupabase();
      const { data: { user: logUser } } = await supaForLog.auth.getUser();
      const logMembership = logUser ? getActiveMembership(logUser.id) : null;
      await saveLogData(d, csvParsed.rows, csvFile.name, csvParsed.startUtc, csvParsed.endUtc, csvTz, logMembership);
      // Mirror to Supabase if there's an active membership.
      try {
        const supabase = getBrowserSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          // The cloud copy is trimmed + downsampled (see reduceLogForCloud):
          // a full session log is tens of MB, over the upload route's size
          // limit. The full-resolution log stays on this device.
          const cloudLog = reduceLogForCloud(
            { rows: csvParsed.rows, fileName: csvFile.name, startUtc: csvParsed.startUtc, endUtc: csvParsed.endUtc, tzOffset: csvTz },
            xmlParsed
          );
          const ok = await saveLogDataCloud({
            userId: user.id,
            date: d,
            logData: cloudLog,
            tzOffsetMinutes: csvTz,
          });
          const mb = (JSON.stringify(cloudLog).length / 1048576).toFixed(2);
          if (ok) addLog(`☁ Log synced to cloud → ${d} · ${cloudLog.rows.length.toLocaleString()} of ${csvParsed.rows.length.toLocaleString()} rows · ${mb} MB`);
          else addLog(`⚠ Log NOT synced (${mb} MB payload) — saved on this device only. Check the console for the HTTP status; an active boat workspace must be selected.`);
        }
      } catch (e) { addLog(`⚠ Log cloud sync failed — saved on this device only`); }
      addLog(`✓ Log saved (${csvParsed.rows.length.toLocaleString()} rows) → ${d}`);
    }
    if (xmlParsed) {
      const d = xmlDate || csvDate || fallbackDate;
      addLog(`Saving events → session ${fmtDate(d)}…`);
      const supaForXml = getBrowserSupabase();
      const { data: { user: xmlUser } } = await supaForXml.auth.getUser();
      const xmlMembership = xmlUser ? getActiveMembership(xmlUser.id) : null;
      await saveXmlData(d, xmlParsed, xmlFile.name, xmlMembership);
      // Mirror to Supabase.
      try {
        const supabase = getBrowserSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const ok = await saveXmlDataCloud({
            userId: user.id,
            date: d,
            xmlData: { ...xmlParsed, fileName: xmlFile.name },
          });
          if (ok) addLog(`☁ Events synced to cloud → ${d}`);
          else addLog(`⚠ Events saved on this device only — could not reach the cloud (is an active boat workspace selected?)`);
        }
      } catch (e) { addLog(`⚠ Events cloud sync failed — saved on this device only`); }
      if (xmlParsed.meta?.sailsUsed?.length) {
        const newTags = xmlParsed.meta.sailsUsed.map(s => s.toLowerCase());
        try {
          const supabase = getBrowserSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (user) await mergeTagListCloud({ userId: user.id, date: d, newTags });
          else mergeTagList(d, newTags);
        } catch { mergeTagList(d, newTags); }
        addLog(`✓ Events saved · ${xmlParsed.meta.sailsUsed.length} sails → ${d}`);
      } else { addLog(`✓ Events saved → ${d}`); }
      // Reconcile the event file's sail names against the SSA inventory.
      try {
        const rawSails=[...(xmlParsed.meta?.sailsUsed||[]),...((xmlParsed.sailsUpEvents||[]).flatMap(e=>e.sails||[]))];
        const missing=unmatchedSails(rawSails, sailInventory);
        if(missing.length && campaignCfg?.teamId && campaignCfg?.boatId){
          setSailDiff({names:missing});
          addLog(`⚠ ${missing.length} sail name${missing.length>1?'s':''} not in inventory — reconcile prompted`);
        }
      } catch {}
      // Build the day's Timeline Tree (day → races → events) and persist it.
      try {
        if(campaignCfg?.teamId && campaignCfg?.boatId){
          const nodes=buildDayTimeline({ xml: xmlParsed, boatId: campaignCfg.boatId, date: d });
          if(nodes.length){
            fetch(`/api/teams/${campaignCfg.teamId}/timeline`,{
              method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({ boat_id: campaignCfg.boatId, session_date: d, nodes }),
            }).then(r=>{ if(r.ok) addLog(`✓ Timeline built · ${nodes.length} nodes → ${d}`); }).catch(()=>{});
          }
        }
      } catch {}
    }

    // ── Save each video to the date from its own timestamp ──────────────────
    const saved = [];
    const touchedDates = new Set();
    if (csvDate) touchedDates.add(csvDate);
    if (xmlDate) touchedDates.add(xmlDate);

    for (const pv of pendingVids) {
      // Per-video date: own timestamp → CSV date → XML date → today
      let vidDate;
      if (pv.startUtc && (pv.tsSource === "mp4-meta" || pv.tsSource === "filename"))
        vidDate = utcToDate(pv.startUtc, vidTz);
      else if (pv.startUtc && pv.tsSource === "lastmodified")
        vidDate = utcToDate(pv.startUtc, vidTz);
      else
        vidDate = csvDate || xmlDate || fallbackDate;

      touchedDates.add(vidDate);
      const tags = computeAutoTags(pv.startUtc, pv.duration, csvParsed, xmlParsed);
      const tsLabel = pv.tsSource === "mp4-meta" ? "📷 camera meta"
        : pv.tsSource === "filename" ? "📝 filename"
        : pv.tsSource === "lastmodified" ? "⚠ file mtime" : "❌ no timestamp";
      try {
        // Tag the saved video + session with the current workspace so
        // membership-scoped readers can isolate per-tenant.
        const supaForSave = getBrowserSupabase();
        const { data: { user: saveUser } } = await supaForSave.auth.getUser();
        const saveMembership = saveUser ? getActiveMembership(saveUser.id) : null;
        const s = await saveVideo(pv.file, {
          duration: pv.duration, startUtc: pv.startUtc, tsSource: pv.tsSource,
          tsDiag: pv.tsDiag || null, tsHow: pv.tsHow || null,
          cameraVendor: pv.cameraVendor || null, cameraModel: pv.cameraModel || null,
          tags, title: pv.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
          sessionDate: vidDate,
        }, saveMembership);
        saved.push({ ...s, file: pv.file });
        addLog(`✓ ${pv.name} · ${tsLabel}${pv.startUtc ? ` · ${new Date(pv.startUtc).toISOString().slice(11, 19)} UTC` : ""} → ${vidDate}`);
      } catch (e) { addLog(`✕ ${pv.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // Summary
    const dateList = [...touchedDates].sort();
    if (dateList.length > 1) addLog(`Files filed across ${dateList.length} sessions: ${dateList.join(", ")}`);

    // Navigate to the most relevant date: CSV > XML > earliest video > today
    const primaryDate = csvDate || xmlDate || (dateList.length ? dateList[0] : fallbackDate);
    setSavedDate(primaryDate); setSavedVids(saved);
    addLog(cloudStatus?.available && perms.canSync ? "Saved. Click Push to Cloud to upload." : "Saved to local storage. Ready in Videos.");
    setPhase("saved");
    onImported({ date: primaryDate, videos: saved, logData: csvParsed, xmlData: xmlParsed });
  };

  // Auto-SAVE videos LOCALLY as soon as the queued clips finish processing
  // (duration read) — no "Save locally" click. The cloud upload is NOT automatic:
  // the user pushes originals later from the Videos tab ("Upload originals").
  // Fires once per batch; the "New import" reset re-arms it for the next batch.
  const autoVidDoneRef = useRef(false);
  useEffect(() => {
    if (!pendingVids.length) { autoVidDoneRef.current = false; return; }
    if (phase !== 'idle' || autoVidDoneRef.current) return;
    if (!pendingVids.every(v => v.duration != null)) return; // wait until processed
    autoVidDoneRef.current = true;
    saveLocal();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVids, phase]);

  const pushCloud=async()=>{
    if(!cloudStatus?.available||!perms.canSync||!savedDate)return;
    setPhase("syncing");
    syncAbortRef.current=false;

    // Build one item per upload action with exact labels for matching
    const items=[
      {id:"log",   label:"Log & Events",  state:"pending", pct:0},
      ...savedVids.map(v=>({id:v.id, label:v.name||v.title, state:"pending", pct:0}))
    ];
    // Helpers — use a local ref so setItem can be called from the sync callback
    // without stale-closure issues
    const progressRef={items:[...items], overall:0, elapsed:0, error:null};
    const pushProgress=()=>setSyncProgress({...progressRef});
    const setItem=(id,patch)=>{
      const idx=progressRef.items.findIndex(it=>it.id===id);
      if(idx===-1)return;
      progressRef.items[idx]={...progressRef.items[idx],...patch};
      const total=progressRef.items.length;
      progressRef.overall=Math.round(progressRef.items.reduce((s,it)=>s+(it.pct||0),0)/total);
      pushProgress();
    };

    const startMs=Date.now();
    syncTimerRef.current=setInterval(()=>{
      progressRef.elapsed=Math.round((Date.now()-startMs)/1000);
      pushProgress();
    },1000);
    setSyncProgress({...progressRef});

    setItem("log",{state:"active",pct:5});
    addLog("Starting Bunny Storage + Stream upload…");

    try{
      let currentVidId=null;

      // Enrich videos with latest log/xml before uploading so cloud gets full metadata
      const _syncLog = await getLogData(savedDate);
      const _syncXml = await getXmlData(savedDate);
      const _syncVids = savedVids.map(v => enrichVideo(v, _syncLog, _syncXml, syncOffsets));

      // Resolve the authed user up-front so the per-video Supabase mirror
      // callback (below) doesn't have to re-auth on every clip.
      let _syncUser = null;
      try {
        const sb = getBrowserSupabase();
        const { data:{ user } } = await sb.auth.getUser();
        _syncUser = user || null;
      } catch {}
      const _syncVidsById = new Map(_syncVids.map(v => [v.id, v]));

      const result=await syncSessionToCloud(
        savedDate,
        _syncLog,
        _syncXml,
        _syncVids,
        msg=>{
          if(syncAbortRef.current)return;
          addLog(msg);

          // ── Log & Events item ──────────────────────────────────────────────
          // "Uploading log data to Bunny Storage…"
          if(msg.includes("Uploading log data")) setItem("log",{state:"active",pct:20});
          // "✓ Log data uploaded to Bunny Storage"
          if(msg.includes("✓ Log data uploaded")) setItem("log",{state:"active",pct:50});
          // "Uploading event data to Bunny Storage…"
          if(msg.includes("Uploading event data")) setItem("log",{state:"active",pct:70});
          // "✓ Event data uploaded to Bunny Storage"
          if(msg.includes("✓ Event data uploaded")) setItem("log",{state:"done",pct:100});
          // also mark done if log upload fails but we continue (no XML)
          if(msg.includes("✓ Log data uploaded")&&!savedVids.length) setItem("log",{state:"done",pct:100});

          // ── Per-video items ────────────────────────────────────────────────
          // "Creating Bunny Stream video for {name}…"
          if(msg.includes("Creating Bunny Stream video for ")){
            const name=msg.replace("Creating Bunny Stream video for ","").replace("…","").trim();
            const vid=savedVids.find(v=>(v.name||v.title)===name);
            if(vid){currentVidId=vid.id;setItem(currentVidId,{state:"active",pct:5});}
          }
          // "Uploading {name} to Bunny Stream (X MB)…"
          if(msg.includes("to Bunny Stream")&&!msg.startsWith("✓")){
            if(currentVidId) setItem(currentVidId,{state:"active",pct:10});
          }
          // "Uploading {name}… {pct}%"  — live TUS progress
          const progMatch=msg.match(/Uploading (.+?)… (\d+)%$/);
          if(progMatch){
            const name=progMatch[1].trim();
            const pct=parseInt(progMatch[2]);
            const vid=savedVids.find(v=>(v.name||v.title)===name);
            const id=vid?.id||currentVidId;
            if(id) setItem(id,{state:"active",pct:Math.max(10,Math.min(95,pct))});
          }
          // "✓ {name} uploaded to Stream (ID: {id}…)"
          if(msg.startsWith("✓")&&msg.includes("uploaded to Stream")){
            const name=msg.replace("✓ ","").split(" uploaded to Stream")[0].trim();
            const vid=savedVids.find(v=>(v.name||v.title)===name);
            const id=vid?.id||currentVidId;
            if(id){
              const sidMatch=msg.match(/ID: ([a-f0-9-]+)/i);
              setItem(id,{state:"processing",pct:98,streamId:sidMatch?.[1]});
              setStreamStatus(p=>({...p,[id]:{state:"processing",streamId:sidMatch?.[1]}}));
            }
            currentVidId=null;
          }
          // Upload failure
          if(msg.includes("upload failed")||msg.includes("failed for")){
            if(currentVidId) setItem(currentVidId,{state:"error",pct:0});
          }
        },
        {
          // Mirror each clip into Supabase the moment its Bunny upload
          // finishes, so teammates see videos appear one-by-one during a
          // long session sync — they no longer wait for the entire batch.
          onVideoSynced: makeVideoMirrorCallback({
            userId: _syncUser?.id || null,
            sessionDate: savedDate,
            syncOffsets,
            onMirrored: (label) => addLog(`☁ ${label} mirrored to Supabase`),
          }),
        }
      );

      // Mark all successful videos as done using returned streamIds
      Object.entries(result.streamIds||{}).forEach(([vidId,streamId])=>{
        setItem(vidId,{state:"done",pct:100,streamId});
        setStreamStatus(p=>({...p,[vidId]:{state:"processing",streamId}}));
      });
      // Mark log done if not already (handles the case with no XML)
      setItem("log",{state:"done",pct:100});

      setPhase("done");
      addLog("Bunny sync complete. Stream videos processing in background…");
      progressRef.overall=100;pushProgress();

      // Poll for HLS readiness
      Object.entries(result.streamIds||{}).forEach(async([vidId,streamId])=>{
        const ready=await waitForStreamReady(streamId,300000);
        setStreamStatus(p=>({...p,[vidId]:{state:ready?"ready":"timeout",streamId,playbackUrl:ready?.playbackUrl}}));
        const vid=savedVids.find(v=>v.id===vidId);
        setItem(vidId,{state:ready?"done":"error",pct:100});
        addLog(ready?`✓ ${vid?.name} ready — HLS available`:`⚠ ${vid?.name} stream timeout`);
      });

    }catch(e){
      setSyncProgress(p=>p?{...p,error:e instanceof Error?e.message:String(e)}:p);
      addLog(`✕ Sync error: ${e instanceof Error?e.message:String(e)}`);
      setPhase("saved");
    }finally{
      clearInterval(syncTimerRef.current);
    }
  };

  const reset=()=>{
    setPendingVids([]);setCsvParsed(null);setXmlParsed(null);setCsvFile(null);setXmlFile(null);
    setPolarParsed(null);setPolarFile(null);
    setPhase("idle");setLog([]);setSavedDate(null);setSavedVids([]);setStreamStatus({});
    setCsvTz(DEFAULT_TZ);setXmlTz(DEFAULT_TZ);setVidTz(DEFAULT_TZ);
  };

  if(!perms.canImport)return(
    <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",padding:40}}>
      <div style={{textAlign:"center",color:"#334155"}}><div style={{fontSize:32,marginBottom:12,opacity:0.3}}>🔒</div><div style={{fontSize:13,color:"#475569",marginBottom:4}}>Import requires Coach or Admin role</div><div style={{fontSize:11}}>Switch role in the header to test</div></div>
    </div>
  );

  return(
    <div style={{flex:1,overflowY:"auto",padding:24}}>
      <div style={{maxWidth:660,margin:"0 auto",display:"flex",flexDirection:"column",gap:14}}>
        {/* Tier explanation */}
        <div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:"12px 14px",display:"flex",gap:16}}>
          <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}><SrcBadge source="local"/><span style={{fontSize:11,fontWeight:600,color:"#06B6D4"}}>① Local — instant</span></div><div style={{fontSize:10,color:"#475569"}}>Saved to browser IndexedDB + localStorage. Available in Videos immediately. Coach/Admin only.</div></div>
          <div style={{width:1,background:"#1E3A5A"}}/>
          <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}><SrcBadge source="cloud"/><span style={{fontSize:11,fontWeight:600,color:"#8B5CF6"}}>② Cloud — background</span></div><div style={{fontSize:10,color:"#475569"}}>Log + events → Bunny Storage. Videos → Bunny Stream (HLS). Accessible to all team roles.</div></div>
        </div>

        {phase==="idle"||phase==="saving"?(
          <>
            {/* Combined video + photo drop zone */}
            <div style={{background:"#0A1929",border:`1px solid ${(pendingVids.length||pendingPhotos.length)?"#06B6D4":"#1E3A5A"}`,borderRadius:12,padding:16}}>
              <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:11}}>Video &amp; photo files</div>
              <input ref={vidRef} type="file" accept="video/*,image/*,.mov,.mp4,.mts,.avi,.mkv,.m4v,.heic,.heif" multiple style={{display:"none"}} onChange={e=>handleMixedDrop(e.target.files)}/>
              <div onClick={()=>vidRef.current?.click()} onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);handleMixedDrop(e.dataTransfer.files);}} style={{border:`2px dashed ${dragOver?"#06B6D4":"#1E3A5A"}`,borderRadius:8,padding:"24px 16px",textAlign:"center",cursor:"pointer",background:dragOver?"#071E30":"transparent",marginBottom:(pendingVids.length||pendingPhotos.length)?11:0,transition:"all 0.12s"}}>
                <div style={{fontSize:20,marginBottom:7}}>📹 📷</div>
                <div style={{fontSize:12,color:"#64748B"}}>Drop videos &amp; photos, or click to browse</div>
                <div style={{fontSize:10,color:"#334155",marginTop:3}}>MP4 · MOV · MTS · JPEG · HEIC — mix freely, multiple files</div>
                <div style={{fontSize:10,color:photoConnGood()?"#10B981":"#F59E0B",marginTop:4}}>{photoConnGood()?"WiFi — photo originals upload now":"Cellular — photo thumbnails now, originals on WiFi"}</div>
              </div>
              {/* Photo status: in-progress count while uploading, then a done summary */}
              {(photoBusy||photosDone>0)&&(
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",fontSize:11,color:photoBusy?"#06B6D4":"#10B981",borderBottom:"1px solid #0F2030"}}>
                  <span style={{fontSize:14}}>📷</span>
                  <span style={{fontWeight:700}}>{photoBusy?`Uploading photos… (${pendingPhotos.filter(p=>!p.thumbSynced&&!p.error).length} left)`:`✓ ${photosDone} photo${photosDone===1?"":"s"} uploaded`}</span>
                  {!photoBusy&&photosDone>0&&<span style={{fontSize:10,color:"#475569"}}>· thumbnails + tags now, originals on WiFi</span>}
                  {!photoBusy&&photosDone>0&&<button onClick={()=>setPhotosDone(0)} style={{marginLeft:"auto",background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:14}}>×</button>}
                </div>
              )}
              {/* WHY a photo import failed. Stays until dismissed — the status line
                  above auto-clears, and when the import drops every file there are no
                  rows at all, so this was previously invisible on a phone. */}
              {photoErrors.length>0&&(
                <div style={{background:"#EF444412",border:"1px solid #EF444440",borderRadius:8,padding:"8px 10px",margin:"8px 0"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                    <span style={{fontSize:11,fontWeight:700,color:"#EF4444",flex:1}}>
                      {photoErrors.length} photo problem{photoErrors.length===1?"":"s"}
                    </span>
                    <button onClick={()=>{
                      const txt=photoErrors.map(e=>`${e.name}: ${e.message}`).join('\n');
                      try{navigator.clipboard?.writeText(txt);}catch{}
                    }} style={{background:"none",border:"1px solid #EF444440",borderRadius:4,color:"#FCA5A5",fontSize:10,padding:"2px 7px",cursor:"pointer"}}>Copy</button>
                    <button onClick={()=>setPhotoErrors([])} style={{background:"none",border:"1px solid #EF444440",borderRadius:4,color:"#FCA5A5",fontSize:10,padding:"2px 7px",cursor:"pointer"}}>✕</button>
                  </div>
                  {photoErrors.slice(0,6).map((e,i)=>(
                    <div key={i} style={{fontSize:10,color:"#FCA5A5",lineHeight:1.45,marginBottom:2,wordBreak:"break-word"}}>
                      <span style={{color:"#F87171",fontWeight:600}}>{e.name}</span>: {e.message}
                    </div>
                  ))}
                </div>
              )}
              {/* Only show individual rows while uploading or for any that errored */}
              {pendingPhotos.map(ph=>(
                <div key={ph.id} style={{display:"flex",alignItems:"center",gap:9,padding:"4px 0",borderBottom:"1px solid #0F2030",fontSize:11}}>
                  <span style={{fontSize:14,flexShrink:0}}>📷</span>
                  <div style={{flex:1,minWidth:0}}><div style={{color:"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ph.name}</div><div style={{fontSize:10,color:"#475569"}}>{fmtSize(ph.size)} · {ph.sessionDate}</div></div>
                  {ph.error?<span style={{color:"#EF4444",fontSize:10,maxWidth:180,wordBreak:"break-word"}}>✕ {ph.error}</span>
                    :<span style={{fontSize:10,color:ph.originalSynced?"#10B981":ph.thumbSynced?"#F59E0B":"#475569"}}>{ph.originalSynced?"✓ original":ph.thumbSynced?"thumb ✓ · original ⏳":"…"}</span>}
                </div>
              ))}
              {pendingVids.map(v=>(
                <div key={v.id} style={{display:"flex",alignItems:"center",gap:9,padding:"5px 0",borderBottom:"1px solid #0F2030"}}>
                  <video src={v.url} style={{width:52,height:33,borderRadius:3,objectFit:"cover",background:"#071624",flexShrink:0}} muted preload="metadata" onLoadedMetadata={e=>{
                    const dur=Math.round(e.target.duration);
                    setPendingVids(p=>p.map(x=>{
                      if(x.id!==v.id)return x;
                      if(x.tsSource==="mp4-meta")return{...x,duration:dur};
                      const ts=x.file?.lastModified?x.file.lastModified-dur*1000:null;
                      return{...x,duration:dur,startUtc:x.startUtc||ts,tsSource:x.tsSource||(ts?"lastmodified":null)};
                    }));
                  }}/>
                  <div style={{flex:1,minWidth:0}}><div style={{fontSize:11,fontWeight:500,color:"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.name}</div><div style={{fontSize:10,color:"#475569"}}>{fmtSize(v.size)}{v.duration?` · ${fmtT(v.duration)}`:""}</div></div>
                  <button onClick={()=>setPendingVids(p=>p.filter(x=>x.id!==v.id))} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:15}}>×</button>
                </div>
              ))}
            </div>

            {/* CSV + XML with per-source timezone selectors */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              {/* Log file */}
              <div style={{background:"#0A1929",border:`1px solid ${csvParsed?"#1D9E75":"#1E3A5A"}`,borderRadius:10,padding:14}}>
                <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Expedition log (CSV)</div>
                <input ref={csvRef} type="file" accept=".csv,text/csv" style={{display:"none"}} onChange={e=>handleCsv(e.target.files[0])}/>
                <button onClick={()=>csvRef.current?.click()} style={{width:"100%",background:csvParsed?"#1D9E7512":"#071624",border:`1px solid ${csvParsed?"#1D9E75":"#1E3A5A"}`,borderRadius:6,padding:"9px 0",color:csvParsed?"#1D9E75":"#7DD3FC",cursor:"pointer",fontSize:11}}>
                  {csvParsed?`✓ ${csvFile.name}`:"Choose file"}
                </button>
                {csvParsed&&<div style={{marginTop:6,fontSize:10,color:"#475569"}}>{csvParsed.rows.length.toLocaleString()} rows</div>}
                <TzSelect value={csvTz} onChange={onCsvTzChange} label="Local / venue timezone (display)"/>
                <div style={{fontSize:9,color:"#334155",marginTop:5}}>
                  <strong style={{color:"#475569"}}>Auto-detected from the log's GPS position</strong> (DST-aware) when you choose a file — change it only to override.
                  It sets the timezone everything is <strong style={{color:"#475569"}}>displayed</strong> in; for local-clock logs it also converts to UTC, while true-UTC logs (e.g. N76 <code>Utc</code>) keep their timestamps either way.
                </div>
              </div>
              {/* Event file */}
              <div style={{background:"#0A1929",border:`1px solid ${xmlParsed?"#8B5CF6":"#1E3A5A"}`,borderRadius:10,padding:14}}>
                <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Event file (XML)</div>
                <input ref={xmlRef} type="file" accept=".xml,text/xml" style={{display:"none"}} onChange={e=>handleXml(e.target.files[0])}/>
                <button onClick={()=>xmlRef.current?.click()} style={{width:"100%",background:xmlParsed?"#8B5CF612":"#071624",border:`1px solid ${xmlParsed?"#8B5CF6":"#1E3A5A"}`,borderRadius:6,padding:"9px 0",color:xmlParsed?"#8B5CF6":"#7DD3FC",cursor:"pointer",fontSize:11}}>
                  {xmlParsed?`✓ ${xmlFile.name}`:"Choose file"}
                </button>
                {xmlParsed&&<div style={{marginTop:6,fontSize:10,color:"#475569"}}>{xmlParsed.tackJibes.length} T/G · {xmlParsed.markRoundings.length} marks</div>}
                <TzSelect value={xmlTz} onChange={onXmlTzChange} label="Event file timezone (times are local)"/>
              </div>
            </div>

            {/* Polar file — persists across sessions via localStorage */}
            <div style={{background:"#0A1929",border:`1px solid ${polarParsed?"#F59E0B":savedPolarName?"#F59E0B40":"#1E3A5A"}`,borderRadius:10,padding:14}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase"}}>Polar file (CSV / TXT)</div>
                {savedPolarName&&!polarParsed&&(
                  <span style={{fontSize:9,color:"#F59E0B",background:"#F59E0B12",border:"1px solid #F59E0B30",borderRadius:3,padding:"1px 6px",marginLeft:"auto"}}>
                    ⬡ Active: {savedPolarName}
                  </span>
                )}
              </div>
              <input ref={polarRef} type="file" accept=".csv,.txt,.pol,text/plain,text/csv" style={{display:"none"}} onChange={e=>handlePolar(e.target.files[0])}/>
              <button onClick={()=>polarRef.current?.click()} style={{width:"100%",background:polarParsed?"#F59E0B12":"#071624",border:`1px solid ${polarParsed?"#F59E0B":savedPolarName?"#F59E0B40":"#1E3A5A"}`,borderRadius:6,padding:"9px 0",color:polarParsed?"#F59E0B":savedPolarName?"#F59E0B80":"#7DD3FC",cursor:"pointer",fontSize:11}}>
                {polarParsed?`✓ ${polarFile.name}`:savedPolarName?`Replace — currently ${savedPolarName}`:"Choose polar file"}
              </button>
              {polarParsed&&<div style={{marginTop:6,fontSize:10,color:"#475569"}}>{polarParsed.entries.length} TWS rows · {polarParsed.entries[0].points.length} TWA pts · TWS {polarParsed.tws[0]}–{polarParsed.tws[polarParsed.tws.length-1]} kn · saved to browser storage</div>}
              {!polarParsed&&savedPolarName&&<div style={{marginTop:6,fontSize:10,color:"#F59E0B80"}}>Loaded from last session — used for GPS track colour coding</div>}
              <div style={{marginTop:6,fontSize:9,color:"#334155"}}>
                Tab/comma CSV: row 1 = TWS values, col 1 = TWA (0–180°). Persists between sessions. Used to colour the GPS track by VMG% (within 20° of target TWA) or BSP% (reaching).
              </div>
            </div>

            {/* No-log timezone confirmation — when there's no log to pin the venue
                zone from GPS, footage times can't be auto-placed. Ask the user to
                confirm the zone (default = this machine's), adjustable. */}
            {!csvParsed && pendingVids.length>0 && (
              <div style={{background:"#3A2A0A",border:"1px solid #F59E0B55",borderRadius:10,padding:"12px 14px"}}>
                <div style={{fontSize:11,color:"#F59E0B",fontWeight:700,marginBottom:4}}>⚠ No log uploaded — confirm the footage timezone</div>
                <div style={{fontSize:9,color:"#B8A06A",marginBottom:2}}>
                  Without a log there's no GPS to detect the venue zone. Footage times are assumed to be in
                  <strong style={{color:"#F59E0B"}}> this computer's timezone ({TZ_OPTIONS.find(o=>o.offsetMin===vidTz)?.label||`UTC${vidTz>=0?'+':''}${vidTz/60}`})</strong>.
                  Change it below if the footage was recorded in another zone. (Uploading a log auto-detects the venue zone and overrides this.)
                </div>
                <TzSelect value={vidTz} onChange={onVidTzChange} label="Footage timezone (where it was recorded)"/>
              </div>
            )}

            {/* Video timezone */}
            {pendingVids.length>0&&csvParsed&&(
              <div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:"12px 14px"}}>
                <TzSelect value={vidTz} onChange={onVidTzChange} label="Video timestamp timezone"/>
                <div style={{fontSize:9,color:"#334155",marginTop:5}}>
                  Most cameras (GoPro, Garmin, older iPhones) write <strong style={{color:"#475569"}}>local time</strong> in the video file.
                  <strong style={{color:"#475569"}}> Auto-set from the log's GPS position</strong> (the footage was shot at the same place) — change only to override.
                </div>
              </div>
            )}
            {(pendingVids.length>0||csvParsed||xmlParsed)&&(
              <button onClick={saveLocal} disabled={phase==="saving"} style={{background:phase==="saving"?"#1E3A5A":"#06B6D4",border:"none",borderRadius:10,padding:"13px",color:phase==="saving"?"#64748B":"#000",fontWeight:700,fontSize:14,cursor:phase==="saving"?"default":"pointer",width:"100%"}}>
                {phase==="saving"?"Saving to local storage…":`① Save locally — ${pendingVids.length>0?`${pendingVids.length} video${pendingVids.length>1?"s":""}`:""} ${csvParsed?"+ log":""} ${xmlParsed?"+ events":""}`}
              </button>
            )}
          </>
        ):(
          <div style={{background:"#0A1929",border:"1px solid #1D9E7540",borderRadius:12,padding:18}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <SrcBadge source="local"/><span style={{fontSize:12,fontWeight:600,color:"#1D9E75"}}>Session {fmtDate(savedDate)} saved locally</span>
              <span style={{flex:1}}/><button onClick={reset} style={{background:"none",border:"1px solid #1E3A5A",borderRadius:5,padding:"2px 8px",color:"#475569",cursor:"pointer",fontSize:10}}>New import</button>
            </div>
            <div style={{borderTop:"1px solid #1E3A5A",paddingTop:14}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                <SrcBadge source={phase==="done"?"cloud":"processing"}/>
                <span style={{fontSize:11,fontWeight:600,color:phase==="done"?"#8B5CF6":"#F59E0B"}}>Bunny Storage + Stream</span>
                {!cloudStatus?.available&&<span style={{fontSize:9,color:"#EF4444",background:"#EF444415",border:"1px solid #EF444430",borderRadius:3,padding:"1px 5px"}}>Not configured</span>}
                {!perms.canSync&&<span style={{fontSize:9,color:"#F59E0B",background:"#F59E0B15",border:"1px solid #F59E0B30",borderRadius:3,padding:"1px 5px"}}>Coach required</span>}
              </div>
              {phase==="saved"&&cloudStatus?.available&&perms.canSync&&(
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:10,color:"#475569",marginBottom:10}}>Uploads log + events to R2 and transcodes videos in Stream. All team roles can view once processing completes (~1–3 min per video).</div>
                  <button onClick={pushCloud} style={{background:"#8B5CF6",border:"none",borderRadius:8,padding:"11px 0",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",width:"100%"}}>② Push to Cloud — {savedVids.length} video{savedVids.length!==1?"s":""} + log + events</button>
                </div>
              )}
              {phase==="saved"&&!cloudStatus?.available&&<div style={{fontSize:10,color:"#334155",background:"#071624",borderRadius:6,padding:"8px 10px"}}>Cloud not configured. Set Bunny env vars in Vercel to enable sync. Session is fully usable from local storage.</div>}
              {(phase==="syncing"||phase==="done")&&syncProgress&&(
                <SyncProgressPanel progress={syncProgress} phase={phase}
                  onCancel={()=>{syncAbortRef.current=true;clearInterval(syncTimerRef.current);setPhase("saved");setSyncProgress(null);}}/>
              )}
            </div>
          </div>
        )}
        {log.length>0&&<div style={{background:"#050E1C",border:"1px solid #1E3A5A",borderRadius:7,padding:"8px 11px",maxHeight:150,overflowY:"auto"}}>
          {log.map((line,i)=><div key={i} style={{fontSize:10,color:line.startsWith("✕")?"#EF4444":line.startsWith("✓")?"#1D9E75":line.startsWith("⚠")?"#F59E0B":"#475569",marginBottom:2,fontFamily:"monospace"}}>{line}</div>)}
        </div>}
      </div>
    </div>
  );
}

// ─── CHART PRIMITIVES ─────────────────────────────────────────────────────────
function linReg(pts){
  const n=pts.length; if(n<2)return null;
  const mx=pts.reduce((s,p)=>s+p.x,0)/n;
  const my=pts.reduce((s,p)=>s+p.y,0)/n;
  const num=pts.reduce((s,p)=>s+(p.x-mx)*(p.y-my),0);
  const den=pts.reduce((s,p)=>s+(p.x-mx)**2,0);
  if(!den)return null;
  const slope=num/den, intercept=my-slope*mx;
  const ssTot=pts.reduce((s,p)=>s+(p.y-my)**2,0);
  const ssRes=pts.reduce((s,p)=>s+(p.y-(slope*p.x+intercept))**2,0);
  return{slope,intercept,r2:ssTot?1-ssRes/ssTot:0};
}

// ─── INTERACTIVE LINE CHART ───────────────────────────────────────────────────
// viewRange = [utcMs, utcMs] | null (null = show all data)
// onViewRange(newRange | null) — lifted state for cross-chart sync
function LineChart({points,color="#06B6D4",height=120,yLabel="",yMin,yMax,
                   yLines=[],showTrend=false,events=[],playUtc=null,
                   viewRange=null,onViewRange=null}){
  const tz=useTz();
  const svgRef  = useRef(null);
  const dragRef = useRef(null);   // {startSvgX, startVR:[x0,x1]} while dragging
  const touchRef= useRef(null);   // touch state
  // Stable unique id for clip path — avoids conflicts when multiple instances render
  const clipId  = useRef('lc'+Math.random().toString(36).slice(2,8)).current;

  if(!points?.length) return <div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No data</div>;

  const VB_W=400;  // logical viewBox width
  const pad={t:14,r:8,b:28,l:36};
  const W=VB_W-pad.l-pad.r, H=height-pad.t-pad.b;

  // Full data range
  const allX0=points[0].x, allX1=points[points.length-1].x;
  const fullSpan=allX1-allX0||1;

  // Visible range
  const [vx0,vx1] = viewRange ?? [allX0,allX1];
  const span = vx1-vx0 || 1;

  // Filter to visible + 5% buffer (keeps lines continuous at edges)
  const buf=span*0.05;
  const visPts = points.filter(p=>p.x>=vx0-buf&&p.x<=vx1+buf);

  // y scale from visible data
  const visY=visPts.map(p=>p.y);
  const y0=yMin??(visY.length?Math.min(...visY):0);
  const y1=yMax??(visY.length?Math.max(...visY)||1:1);

  const px=x=>pad.l+((x-vx0)/span)*W;
  const py=y=>pad.t+H-((y-y0)/((y1-y0)||1))*H;
  const d=visPts.map((p,i)=>`${i===0?"M":"L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");

  const xTicks=Array.from({length:5},(_,i)=>vx0+span*i/4);
  const yTicks=Array.from({length:4},(_,i)=>y0+(y1-y0)*i/3);

  // Trend line from visible points only
  const reg=showTrend&&visPts.length>1?linReg(visPts.map(p=>({x:(p.x-vx0)/span,y:p.y}))):null;
  const ty=t=>reg?reg.slope*t+reg.intercept:0;

  const visEvents=events.filter(e=>e.utc>=vx0&&e.utc<=vx1);
  const isZoomed=viewRange&&(vx0>allX0||vx1<allX1);

  // ── Coordinate helpers ────────────────────────────────────────────────────
  const getSvgX=e=>{
    const rect=svgRef.current?.getBoundingClientRect();
    if(!rect)return 0;
    return ((e.clientX-rect.left)/rect.width)*VB_W;
  };
  const svgXtoUtc=svgX=>vx0+((svgX-pad.l)/W)*span;

  // ── Mouse event handlers ──────────────────────────────────────────────────
  const onWheel=e=>{
    if(!onViewRange)return;
    e.preventDefault();
    const factor=e.deltaY>0?1.3:1/1.3;
    const svgX=getSvgX(e);
    const frac=Math.max(0,Math.min(1,(svgX-pad.l)/W));
    const pivot=vx0+frac*span;
    const newSpan=Math.max(60000,Math.min(fullSpan,span*factor));
    let nx0=pivot-frac*newSpan;
    let nx1=nx0+newSpan;
    if(nx0<allX0){nx0=allX0;nx1=allX0+newSpan;}
    if(nx1>allX1){nx1=allX1;nx0=allX1-newSpan;}
    onViewRange(newSpan>=fullSpan*0.999?null:[nx0,nx1]);
  };
  const onMouseDown=e=>{
    if(!onViewRange||e.button!==0)return;
    dragRef.current={startSvgX:getSvgX(e),startVR:[vx0,vx1]};
    e.currentTarget.style.cursor="grabbing";
  };
  const onMouseMove=e=>{
    if(!dragRef.current||!onViewRange)return;
    const {startSvgX,startVR}=dragRef.current;
    const shift=-((getSvgX(e)-startSvgX)/W)*span;
    const s=startVR[1]-startVR[0];
    let nx0=startVR[0]+shift, nx1=startVR[1]+shift;
    if(nx0<allX0){nx0=allX0;nx1=allX0+s;}
    if(nx1>allX1){nx1=allX1;nx0=allX1-s;}
    onViewRange([nx0,nx1]);
  };
  const onMouseUp=e=>{
    dragRef.current=null;
    if(e.currentTarget)e.currentTarget.style.cursor="grab";
  };

  // ── Touch handlers ────────────────────────────────────────────────────────
  const onTouchStart=e=>{
    if(!onViewRange)return;
    if(e.touches.length===1){
      touchRef.current={type:"pan",startX:e.touches[0].clientX,startVR:[vx0,vx1]};
    } else if(e.touches.length===2){
      const dist=Math.abs(e.touches[0].clientX-e.touches[1].clientX);
      const midX=(e.touches[0].clientX+e.touches[1].clientX)/2;
      const rect=svgRef.current?.getBoundingClientRect();
      const svgMid=rect?((midX-rect.left)/rect.width)*VB_W:VB_W/2;
      touchRef.current={type:"pinch",dist,startVR:[vx0,vx1],svgMid};
    }
  };
  const onTouchMove=e=>{
    if(!touchRef.current||!onViewRange)return;
    e.preventDefault();
    const rect=svgRef.current?.getBoundingClientRect();
    if(!rect)return;
    const ratio=VB_W/rect.width;
    const {type,startVR}=touchRef.current;
    const s=startVR[1]-startVR[0];
    if(type==="pan"&&e.touches.length===1){
      const dx=(e.touches[0].clientX-touchRef.current.startX)*ratio;
      const shift=-(dx/W)*s;
      let nx0=startVR[0]+shift, nx1=startVR[1]+shift;
      if(nx0<allX0){nx0=allX0;nx1=allX0+s;}
      if(nx1>allX1){nx1=allX1;nx0=allX1-s;}
      onViewRange([nx0,nx1]);
    } else if(type==="pinch"&&e.touches.length===2){
      const dist=Math.abs(e.touches[0].clientX-e.touches[1].clientX);
      const factor=touchRef.current.dist/(dist||1);
      const newSpan=Math.max(60000,Math.min(fullSpan,s*factor));
      const frac=(touchRef.current.svgMid-pad.l)/W;
      const pivot=startVR[0]+frac*s;
      let nx0=Math.max(allX0,pivot-frac*newSpan);
      let nx1=Math.min(allX1,nx0+newSpan);
      onViewRange(newSpan>=fullSpan*0.999?null:[nx0,nx1]);
    }
  };
  const onTouchEnd=()=>{touchRef.current=null;};

  return(
    <div style={{position:"relative",userSelect:"none"}}>
      {isZoomed&&onViewRange&&(
        <button onClick={()=>onViewRange(null)} style={{
          position:"absolute",top:2,right:2,zIndex:2,
          background:"#1E3A5A",border:"1px solid #2D4A6A",borderRadius:4,
          padding:"2px 7px",color:"#94A3B8",fontSize:9,cursor:"pointer",fontFamily:"monospace"
        }}>↩ all</button>
      )}
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${VB_W} ${height}`}
        style={{overflow:"visible",cursor:onViewRange?"grab":"default",display:"block"}}
        onWheel={onViewRange?onWheel:undefined}
        onMouseDown={onViewRange?onMouseDown:undefined}
        onMouseMove={onViewRange?onMouseMove:undefined}
        onMouseUp={onViewRange?onMouseUp:undefined}
        onMouseLeave={onViewRange?onMouseUp:undefined}
        onTouchStart={onViewRange?onTouchStart:undefined}
        onTouchMove={onViewRange?onTouchMove:undefined}
        onTouchEnd={onViewRange?onTouchEnd:undefined}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={pad.l} y={pad.t-2} width={W} height={H+4}/>
          </clipPath>
        </defs>
        {/* Grid lines */}
        {yTicks.map((y,i)=><line key={i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke="#0F2030" strokeWidth="1"/>)}
        {yLines.map((y,i)=><line key={"r"+i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke={color} strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5"/>)}
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
        <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
        {/* Data — clipped so it never bleeds outside the plot area */}
        <g clipPath={`url(#${clipId})`}>
          <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" opacity="0.9"/>
          {reg&&<line x1={px(vx0)} y1={py(ty(0))} x2={px(vx1)} y2={py(ty(1))} stroke="#fff" strokeWidth="1" strokeDasharray="4,3" opacity="0.5"/>}
          {/* Playback cursor */}
          {playUtc&&playUtc>=vx0&&playUtc<=vx1&&(()=>{
            const cx=px(playUtc);
            return(<g key="cursor">
              <line x1={cx} x2={cx} y1={pad.t} y2={pad.t+H} stroke="#F59E0B" strokeWidth="1.5" opacity="0.9"/>
              <polygon points={`${cx-4},${pad.t} ${cx+4},${pad.t} ${cx},${pad.t+7}`} fill="#F59E0B" opacity="0.9"/>
            </g>);
          })()}
          {/* Event markers */}
          {visEvents.map((e,i)=>{
            const ex=px(e.utc);
            const anchor=ex>pad.l+W*0.7?"end":"start";
            const lw=(e.label||"").length*4.5+4;
            return(<g key={"ev"+i}>
              <line x1={ex} x2={ex} y1={pad.t} y2={pad.t+H} stroke={e.color||"#64748B"} strokeWidth="1" strokeDasharray="3,2" opacity="0.8"/>
              <rect x={anchor==="start"?ex+2:ex-2-lw} y={pad.t+1} width={lw} height="10" rx="2" fill="rgba(3,15,26,0.9)"/>
              <text x={anchor==="start"?ex+4:ex-4} y={pad.t+9} textAnchor={anchor} fontSize="7" fill={e.color||"#94A3B8"} fontFamily="monospace">{e.label}</text>
            </g>);
          })}
        </g>
        {/* Axis labels (outside clip) */}
        {reg&&<text x={pad.l+W-2} y={pad.t+6} textAnchor="end" fontSize="8" fill="#64748B">R²={reg.r2.toFixed(2)}</text>}
        {yTicks.map((y,i)=><text key={i} x={pad.l-4} y={py(y)+3} textAnchor="end" fontSize="8" fill="#475569">{y.toFixed(y<10?1:0)}</text>)}
        {xTicks.map((x,i)=><text key={i} x={Math.max(pad.l+2,Math.min(pad.l+W-2,px(x)))} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill="#475569">{hmLocal(x,tz)}</text>)}
        {yLabel&&<text x={8} y={pad.t+H/2} textAnchor="middle" fontSize="8" fill="#475569" transform={`rotate(-90,8,${pad.t+H/2})`}>{yLabel}</text>}
        {/* Zoom-progress minimap bar at bottom */}
        {isZoomed&&(()=>{
          const bx=pad.l, bw=W, by=pad.t+H+22, bh=3;
          const hx=bx+((vx0-allX0)/fullSpan)*bw;
          const hw=((vx1-vx0)/fullSpan)*bw;
          return(<g>
            <rect x={bx} y={by} width={bw} height={bh} fill="#0F2030" rx="1"/>
            <rect x={hx} y={by} width={Math.max(4,hw)} height={bh} fill={color} rx="1" opacity="0.7"/>
          </g>);
        })()}
      </svg>
    </div>
  );
}

function XYPlot({points,xLabel="",yLabel="",color="#06B6D4",width=400,height=200,showTrend=true,title="",yLines=[]}){
  const [hoveredTack, setHoveredTack] = React.useState(null); // null | "port" | "stbd"

  if(!points?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No data</div>;
  const hasTwa = points.some(p=>p.twa!=null);
  const pad={t:title?20:10,r:8,b:28,l:36};
  const W=width-pad.l-pad.r, H=height-pad.t-pad.b;
  const xs=points.map(p=>p.x), ys=points.map(p=>p.y);
  const x0=Math.min(...xs),x1=Math.max(...xs);
  const rawY0=Math.min(...ys), rawY1=Math.max(...ys);
  const y0=Math.min(rawY0,...yLines), y1=Math.max(rawY1,...yLines);
  const px=x=>pad.l+((x-x0)/(x1-x0||1))*W;
  const py=y=>pad.t+H-((y-y0)/(y1-y0||1))*H;
  const step=Math.max(1,Math.floor(points.length/800));
  const dots=points.filter((_,i)=>i%step===0);
  const xTicks=Array.from({length:5},(_,i)=>x0+(x1-x0)*i/4);
  const yTicks=Array.from({length:4},(_,i)=>y0+(y1-y0)*i/3);
  const reg=showTrend?linReg(points):null;
  const ty=x=>reg?reg.slope*x+reg.intercept:0;

  // Port = twa < 0 (wind from port = starboard tack in sailing terms... 
  // but Expedition: positive twa = starboard tack, negative = port tack)
  const isPort = p => p.twa != null && p.twa < 0;
  const isStbd = p => p.twa != null && p.twa >= 0;

  // Triangle pointing up (▲) for port, circle for stbd
  const portColor  = "#7DD3FC";   // light blue — port tack
  const stbdColor  = color;        // chart color — stbd tack

  const renderDot = (p, i) => {
    const port = isPort(p);
    const tack = hasTwa ? (port ? "port" : "stbd") : null;
    const cx = px(p.x), cy = py(p.y);
    const r = 2.0;

    if(hasTwa && port){
      const h = r * 2.4;
      const pts = `${cx},${cy-h*0.65} ${cx-h*0.6},${cy+h*0.35} ${cx+h*0.6},${cy+h*0.35}`;
      return(
        <polygon key={i} points={pts} fill={portColor} opacity="0.75"
          style={{cursor:"pointer"}}
          onMouseEnter={()=>setHoveredTack("port")}
          onMouseLeave={()=>setHoveredTack(null)}/>
      );
    }
    return(
      <circle key={i} cx={cx} cy={cy} r={r} fill={hasTwa?stbdColor:color} opacity="0.65"
        style={{cursor:hasTwa?"pointer":"default"}}
        onMouseEnter={hasTwa?()=>setHoveredTack("stbd"):undefined}
        onMouseLeave={hasTwa?()=>setHoveredTack(null):undefined}/>
    );
  };

  // Highlighted group — same shapes but larger, rendered above the veil
  const renderDotHL = (p, i) => {
    const port = isPort(p);
    const cx = px(p.x), cy = py(p.y);
    const r = 3.5;
    if(port){
      const h = r * 2.4;
      const pts = `${cx},${cy-h*0.65} ${cx-h*0.6},${cy+h*0.35} ${cx+h*0.6},${cy+h*0.35}`;
      return <polygon key={"hl"+i} points={pts} fill={portColor}
               stroke="#fff" strokeWidth="0.6" opacity="1"
               onMouseEnter={()=>setHoveredTack("port")}
               onMouseLeave={()=>setHoveredTack(null)} style={{cursor:"pointer"}}/>;
    }
    return <circle key={"hl"+i} cx={cx} cy={cy} r={r} fill={stbdColor}
             stroke="#fff" strokeWidth="0.6" opacity="1"
             onMouseEnter={()=>setHoveredTack("stbd")}
             onMouseLeave={()=>setHoveredTack(null)} style={{cursor:"pointer"}}/>;
  };

  return(
    <div style={{position:"relative"}}>
      {hasTwa&&(
        <div style={{display:"flex",gap:10,marginBottom:3,fontSize:9,color:"#475569"}}>
          <span>
            <svg width="9" height="9" style={{verticalAlign:"middle",marginRight:3}}>
              <polygon points="4.5,0.5 0.5,8.5 8.5,8.5" fill={portColor} opacity="0.8"/>
            </svg>
            Port tack
          </span>
          <span>
            <svg width="9" height="9" style={{verticalAlign:"middle",marginRight:3}}>
              <circle cx="4.5" cy="4.5" r="3.5" fill={color} opacity="0.8"/>
            </svg>
            Stbd tack
          </span>
          <span style={{color:"#334155"}}>· hover to highlight</span>
        </div>
      )}
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{overflow:"visible"}}>
        {title&&<text x={pad.l+W/2} y={10} textAnchor="middle" fontSize="9" fill="#64748B" fontWeight="600">{title}</text>}
        {yTicks.map((y,i)=><line key={i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke="#0F2030" strokeWidth="1"/>)}
        {yLines.map((y,i)=>{
          const cy=py(y);
          if(cy<pad.t||cy>pad.t+H) return null;
          return(<g key={"yl"+i}>
            <line x1={pad.l} x2={pad.l+W} y1={cy} y2={cy} stroke={color} strokeWidth="1" strokeDasharray="4,3" opacity="0.6"/>
            <text x={pad.l+W-2} y={cy-3} textAnchor="end" fontSize="7" fill={color} opacity="0.8">{y}</text>
          </g>);
        })}
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
        <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
        {/* All dots at base opacity — colors preserved */}
        {hasTwa&&dots.filter(p=>!isPort(p)).map((p,i)=>renderDot(p,"s"+i))}
        {hasTwa&&dots.filter(isPort).map((p,i)=>renderDot(p,"p"+i))}
        {!hasTwa&&dots.map((p,i)=>renderDot(p,i))}
        {/* Grey veil over non-hovered tack — color-preserving: sits above dots, hovered group rendered on top */}
        {hoveredTack&&<rect x={pad.l} y={pad.t} width={W} height={H}
          fill="#0A1929" opacity="0.62" style={{pointerEvents:"none"}}/>}
        {/* Highlighted tack dots rendered above the veil — full color, larger, white outline */}
        {hoveredTack==="stbd"&&dots.filter(p=>!isPort(p)).map((p,i)=>renderDotHL(p,i))}
        {hoveredTack==="port"&&dots.filter(isPort).map((p,i)=>renderDotHL(p,i))}
        {reg&&<line x1={px(x0)} y1={py(ty(x0))} x2={px(x1)} y2={py(ty(x1))} stroke="#fff" strokeWidth="1.5" strokeDasharray="5,3" opacity="0.7"/>}
        {reg&&<text x={pad.l+W-2} y={pad.t+10} textAnchor="end" fontSize="8" fill="#64748B">R²={reg.r2.toFixed(2)}</text>}
        {yTicks.map((y,i)=><text key={i} x={pad.l-4} y={py(y)+3} textAnchor="end" fontSize="8" fill="#475569">{y.toFixed(1)}</text>)}
        {xTicks.map((x,i)=><text key={i} x={px(x)} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill="#475569">{x.toFixed(1)}</text>)}
        {xLabel&&<text x={pad.l+W/2} y={height-1} textAnchor="middle" fontSize="8" fill="#475569">{xLabel}</text>}
        {yLabel&&<text x={8} y={pad.t+H/2} textAnchor="middle" fontSize="8" fill="#475569" transform={`rotate(-90,8,${pad.t+H/2})`}>{yLabel}</text>}
      </svg>
    </div>
  );
}

function AIChart({spec,rows,allVideos}){
  if(!spec)return null;
  const c=spec.color||"#8B5CF6";
  if(spec.type==="xy"&&rows?.length){
    const xf=spec.xField, yf=spec.yField;
    const pts=rows.filter(r=>r[xf]!=null&&r[yf]!=null&&(spec.filter?eval(`(r)=>${spec.filter}`)(r):true)).map(r=>({x:r[xf],y:r[yf]}));
    return(<div style={{background:"#0A1929",border:`1px solid ${c}30`,borderRadius:10,padding:14,marginBottom:10}}><XYPlot points={pts} xLabel={spec.xLabel||xf} yLabel={spec.yLabel||yf} color={c} width={520} height={200} title={spec.title} showTrend/></div>);
  }
  if(spec.type==="line"&&rows?.length){
    const yf=spec.yField;
    const step=Math.max(1,Math.floor(rows.length/400));
    const pts=rows.filter((_,i)=>i%step===0).filter(r=>r[yf]!=null).map(r=>({x:r.utc,y:r[yf]}));
    return(<div style={{background:"#0A1929",border:`1px solid ${c}30`,borderRadius:10,padding:14,marginBottom:10}}><div style={{fontSize:10,color:c,fontWeight:600,marginBottom:6}}>{spec.title}</div><LineChart points={pts} color={c} height={130} yLabel={spec.yLabel||yf} showTrend/></div>);
  }
  if(spec.type==="bar"&&allVideos?.length){
    const field=spec.xField||"twsAvg";
    const clips=allVideos.filter(v=>v[field]!=null).slice(0,12);
    if(!clips.length)return<div style={{fontSize:10,color:"#334155"}}>No clip data for this field</div>;
    const maxV=Math.max(...clips.map(v=>v[field]));
    const W=520,H=160,pad={t:16,r:8,b:40,l:40};
    const bw=(W-pad.l-pad.r)/clips.length-3;
    return(<div style={{background:"#0A1929",border:`1px solid ${c}30`,borderRadius:10,padding:14,marginBottom:10}}><div style={{fontSize:10,color:c,fontWeight:600,marginBottom:6}}>{spec.title}</div><svg width="100%" viewBox={`0 0 ${W} ${H}`}>{clips.map((v,i)=>{const bh=((v[field]||0)/maxV)*(H-pad.t-pad.b);const x=pad.l+i*(bw+3);return(<g key={v.id}><rect x={x} y={H-pad.b-bh} width={bw} height={bh} fill={c} rx="2" opacity="0.8"/><text x={x+bw/2} y={H-pad.b+12} textAnchor="middle" fontSize="7" fill="#475569" transform={`rotate(-35,${x+bw/2},${H-pad.b+12})`}>{v.title?.slice(0,10)}</text><text x={x+bw/2} y={H-pad.b-bh-3} textAnchor="middle" fontSize="8" fill={c}>{R(v[field])}</text></g>);})}<line x1={pad.l} x2={W-pad.r} y1={H-pad.b} y2={H-pad.b} stroke="#1E3A5A" strokeWidth="1"/><text x={pad.l+((W-pad.l-pad.r)/2)} y={H-2} textAnchor="middle" fontSize="8" fill="#475569">{spec.xLabel}</text><text x={8} y={(H-pad.t-pad.b)/2+pad.t} textAnchor="middle" fontSize="8" fill="#475569" transform={`rotate(-90,8,${(H-pad.t-pad.b)/2+pad.t})`}>{spec.yLabel}</text></svg></div>);
  }
  return<div style={{fontSize:10,color:"#EF4444"}}>Chart type "{spec.type}" not recognised</div>;
}

function SpeedPolar({rows,width=320,height=320}){
  if(!rows?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No log data</div>;
  const cx=width/2, cy=height/2, maxR=cx-24;
  const maxBsp=Math.max(...rows.map(r=>r.bsp||0),12);
  const colors={"0-8":"#7DD3FC","8-12":"#06B6D4","12-16":"#8B5CF6","16-20":"#F59E0B","20+":"#EF4444"};
  const twsBin=tws=>tws<8?"0-8":tws<12?"8-12":tws<16?"12-16":tws<20?"16-20":"20+";
  const dots=rows.filter(r=>r.bsp>0.5&&r.twa!=null).map(r=>{
    const twa=Math.abs(r.twa)*Math.PI/180;
    const r2=(r.bsp/maxBsp)*maxR;
    const side=r.twa>=0?1:-1;
    return{x:cx+side*Math.sin(twa)*r2, y:cy-Math.cos(twa)*r2, bin:twsBin(r.tws)};
  });
  const rings=[0.25,0.5,0.75,1].map(f=>f*maxBsp);
  return(
    <svg width="100%" viewBox={`0 0 ${width} ${height}`}>
      {rings.map((b,i)=><circle key={i} cx={cx} cy={cy} r={(b/maxBsp)*maxR} fill="none" stroke="#0F2030" strokeWidth="1"/>)}
      {rings.map((b,i)=><text key={i} x={cx+4} y={cy-(b/maxBsp)*maxR-2} fontSize="7" fill="#334155">{b.toFixed(0)}kt</text>)}
      <line x1={cx} x2={cx} y1={8} y2={height-8} stroke="#1E3A5A" strokeWidth="0.5"/>
      <line x1={8} x2={width-8} y1={cy} y2={cy} stroke="#1E3A5A" strokeWidth="0.5"/>
      {[45,90,135].map(a=>{const r=a*Math.PI/180;return(<g key={a}><line x1={cx} y1={cy} x2={cx+Math.sin(r)*maxR} y2={cy-Math.cos(r)*maxR} stroke="#0F2030" strokeWidth="0.5"/><line x1={cx} y1={cy} x2={cx-Math.sin(r)*maxR} y2={cy-Math.cos(r)*maxR} stroke="#0F2030" strokeWidth="0.5"/><text x={cx+Math.sin(r)*(maxR+12)} y={cy-Math.cos(r)*(maxR+12)} textAnchor="middle" fontSize="8" fill="#334155">{a}°</text></g>);})}
      {dots.map((d,i)=><circle key={i} cx={d.x} cy={d.y} r="1.2" fill={colors[d.bin]} opacity="0.6"/>)}
      <text x={cx} y={12} textAnchor="middle" fontSize="8" fill="#475569">0° (head)</text>
      <text x={cx} y={height-4} textAnchor="middle" fontSize="8" fill="#475569">180° (run)</text>
      {Object.entries(colors).map(([k,c],i)=><g key={k}><rect x={8} y={height-60+i*10} width="8" height="6" fill={c} rx="1"/><text x={19} y={height-55+i*10} fontSize="7" fill="#475569">{k} kn</text></g>)}
    </svg>
  );
}

function ManoeuvreChart({tackJibes,logRows,width=400,height=140}){
  if(!tackJibes?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No manoeuvre data</div>;
  const valid=tackJibes.filter(t=>t.isValid!==false);
  const tacks=valid.filter(t=>t.isTack).length;
  const gybes=valid.filter(t=>!t.isTack).length;
  const invalid=tackJibes.length-valid.length;
  const pad={t:14,r:12,b:30,l:40};
  const W=width-pad.l-pad.r, H=height-pad.t-pad.b;
  const twsBins={"<8":0,"8-12":0,"12-16":0,"16-20":0,"20+":0};
  if(logRows?.length){valid.forEach(tj=>{const nearest=logRows.reduce((a,b)=>Math.abs(b.utc-tj.utc)<Math.abs(a.utc-tj.utc)?b:a,logRows[0]);const tws=nearest?.tws||0;if(tws<8)twsBins["<8"]++;else if(tws<12)twsBins["8-12"]++;else if(tws<16)twsBins["12-16"]++;else if(tws<20)twsBins["16-20"]++;else twsBins["20+"]++;});}
  const bins=Object.entries(twsBins);
  const maxVal=Math.max(...bins.map(([,v])=>v),1);
  const bw=W/bins.length-4;
  return(
    <svg width="100%" viewBox={`0 0 ${width} ${height}`}>
      <text x={pad.l} y={10} fontSize="9" fill="#06B6D4">{tacks} tacks</text>
      <text x={pad.l+60} y={10} fontSize="9" fill="#8B5CF6">{gybes} gybes</text>
      {invalid>0&&<text x={pad.l+120} y={10} fontSize="9" fill="#EF4444">{invalid} invalid</text>}
      {bins.map(([label,val],i)=>{const x=pad.l+i*(bw+4);const barH=(val/maxVal)*H;return(<g key={label}><rect x={x} y={pad.t+H-barH} width={bw} height={barH} fill="#06B6D4" rx="2" opacity="0.8"/><text x={x+bw/2} y={pad.t+H+10} textAnchor="middle" fontSize="8" fill="#475569">{label}</text>{val>0&&<text x={x+bw/2} y={pad.t+H-barH-3} textAnchor="middle" fontSize="8" fill="#06B6D4">{val}</text>}</g>);})}
      <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
      <text x={pad.l+W/2} y={height-2} textAnchor="middle" fontSize="8" fill="#475569">TWS at manoeuvre (kn)</text>
    </svg>
  );
}

function PerfChart({rows,width=400,height=110,viewRange=null,onViewRange=null,playUtc=null}){
  const tz=useTz();
  const svgRef=useRef(null);
  const dragRef=useRef(null);
  const clipId=useRef('pc'+Math.random().toString(36).slice(2,8)).current;
  if(!rows?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No data</div>;
  const validPol=rows.filter(r=>r.vsPerfPct>5&&r.vsPerfPct<200);
  const validTgt=rows.filter(r=>r.vsTargPct>5&&r.vsTargPct<200);
  if(!validPol.length&&!validTgt.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No performance data in log</div>;
  const step=Math.max(1,Math.floor(rows.length/300));
  const polPts=validPol.filter((_,i)=>i%step===0).map(r=>({x:r.utc,y:r.vsPerfPct}));
  const tgtPts=validTgt.filter((_,i)=>i%step===0).map(r=>({x:r.utc,y:r.vsTargPct}));
  const pad={t:14,r:8,b:28,l:36};
  const W=width-pad.l-pad.r, H=height-pad.t-pad.b;
  const allPts=[...polPts,...tgtPts];
  if(!allPts.length)return null;
  const allX0=Math.min(...allPts.map(p=>p.x)),allX1=Math.max(...allPts.map(p=>p.x));
  const fullSpan=allX1-allX0||1;
  const [vx0,vx1]=viewRange??[allX0,allX1];
  const span=vx1-vx0||1;
  const buf=span*0.05;
  const visPol=polPts.filter(p=>p.x>=vx0-buf&&p.x<=vx1+buf);
  const visTgt=tgtPts.filter(p=>p.x>=vx0-buf&&p.x<=vx1+buf);
  const y0=50,y1=150;
  const px=x=>pad.l+((x-vx0)/span)*W;
  const py=y=>pad.t+H-((y-y0)/(y1-y0))*H;
  const mkLine=pts=>pts.length<2?"":pts.map((p,i)=>`${i===0?"M":"L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const xTicks=Array.from({length:5},(_,i)=>vx0+span*i/4);
  const yTicks=[60,80,100,120,140];
  const isZoomed=viewRange&&(vx0>allX0||vx1<allX1);
  // Reuse same pan/zoom logic as LineChart
  const VB_W=width;
  const getSvgX=e=>{const rect=svgRef.current?.getBoundingClientRect();if(!rect)return 0;return((e.clientX-rect.left)/rect.width)*VB_W;};
  const onWheel=e=>{if(!onViewRange)return;e.preventDefault();const factor=e.deltaY>0?1.3:1/1.3;const svgX=getSvgX(e);const frac=Math.max(0,Math.min(1,(svgX-pad.l)/W));const pivot=vx0+frac*span;const newSpan=Math.max(60000,Math.min(fullSpan,span*factor));let nx0=pivot-frac*newSpan,nx1=nx0+newSpan;if(nx0<allX0){nx0=allX0;nx1=allX0+newSpan;}if(nx1>allX1){nx1=allX1;nx0=allX1-newSpan;}onViewRange(newSpan>=fullSpan*0.999?null:[nx0,nx1]);};
  const onMouseDown=e=>{if(!onViewRange||e.button!==0)return;dragRef.current={startSvgX:getSvgX(e),startVR:[vx0,vx1]};e.currentTarget.style.cursor="grabbing";};
  const onMouseMove=e=>{if(!dragRef.current||!onViewRange)return;const{startSvgX,startVR}=dragRef.current;const shift=-((getSvgX(e)-startSvgX)/W)*span;const s=startVR[1]-startVR[0];let nx0=startVR[0]+shift,nx1=startVR[1]+shift;if(nx0<allX0){nx0=allX0;nx1=allX0+s;}if(nx1>allX1){nx1=allX1;nx0=allX1-s;}onViewRange([nx0,nx1]);};
  const onMouseUp=e=>{dragRef.current=null;if(e.currentTarget)e.currentTarget.style.cursor="grab";};
  return(
    <div style={{position:"relative",userSelect:"none"}}>
      {isZoomed&&onViewRange&&(<button onClick={()=>onViewRange(null)} style={{position:"absolute",top:2,right:2,zIndex:2,background:"#1E3A5A",border:"1px solid #2D4A6A",borderRadius:4,padding:"2px 7px",color:"#94A3B8",fontSize:9,cursor:"pointer",fontFamily:"monospace"}}>↩ all</button>)}
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${width} ${height}`} style={{overflow:"visible",cursor:onViewRange?"grab":"default",display:"block"}}
        onWheel={onViewRange?onWheel:undefined} onMouseDown={onViewRange?onMouseDown:undefined} onMouseMove={onViewRange?onMouseMove:undefined} onMouseUp={onViewRange?onMouseUp:undefined} onMouseLeave={onViewRange?onMouseUp:undefined}>
        <defs><clipPath id={clipId}><rect x={pad.l} y={pad.t-2} width={W} height={H+4}/></clipPath></defs>
        {yTicks.map(y=><line key={y} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke={y===100?"#475569":"#0F2030"} strokeWidth={y===100?"1":"0.5"} strokeDasharray={y===100?"4,2":"none"}/>)}
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
        <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
        <g clipPath={`url(#${clipId})`}>
          {visPol.length>1&&<path d={mkLine(visPol)} fill="none" stroke="#22C55E" strokeWidth="1.5" strokeLinejoin="round" opacity="0.9"/>}
          {visTgt.length>1&&<path d={mkLine(visTgt)} fill="none" stroke="#22C55E" strokeWidth="1.5" strokeLinejoin="round" opacity="0.7"/>}
          {playUtc&&playUtc>=vx0&&playUtc<=vx1&&(()=>{const cx=px(playUtc);return(<g><line x1={cx} x2={cx} y1={pad.t} y2={pad.t+H} stroke="#F59E0B" strokeWidth="1.5" opacity="0.9"/><polygon points={`${cx-4},${pad.t} ${cx+4},${pad.t} ${cx},${pad.t+7}`} fill="#F59E0B" opacity="0.9"/></g>);})()}
          {isZoomed&&(()=>{const bx=pad.l,bw=W,by=pad.t+H+22,bh=3;const hx=bx+((vx0-allX0)/fullSpan)*bw;const hw=((vx1-vx0)/fullSpan)*bw;return(<g><rect x={bx} y={by} width={bw} height={bh} fill="#0F2030" rx="1"/><rect x={hx} y={by} width={Math.max(4,hw)} height={bh} fill="#F59E0B" rx="1" opacity="0.7"/></g>);})()}
        </g>
        {yTicks.map(y=><text key={y} x={pad.l-4} y={py(y)+3} textAnchor="end" fontSize="8" fill="#475569">{y}</text>)}
        {xTicks.map((x,i)=><text key={i} x={Math.max(pad.l+2,Math.min(pad.l+W-2,px(x)))} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill="#475569">{hmLocal(x,tz)}</text>)}
        {polPts.length>0&&<><rect x={pad.l+4} y={4} width="8" height="5" fill="#22C55E" rx="1"/><text x={pad.l+15} y={9} fontSize="8" fill="#22C55E">Polar %</text></>}
        {tgtPts.length>0&&<><rect x={pad.l+60} y={4} width="8" height="5" fill="#22C55E" rx="1"/><text x={pad.l+71} y={9} fontSize="8" fill="#22C55E">Target %</text></>}
      </svg>
    </div>
  );
}

// ─── AI CHART CHAT ────────────────────────────────────────────────────────────
const LOG_FIELDS = "tws (true wind speed kn), twa (true wind angle °), bsp (boat speed kn), sog (speed over ground kn), vmg (velocity made good kn), heel (heel angle °), vsTarget (target boat speed kn), vsTargPct (% of target speed), twaTarg (target TWA °), vsPerf (polar boat speed kn), vsPerfPct (% of polar speed), rudder (rudder angle °)";
const CLIP_FIELDS = "twsAvg, twaAvg, vmgAvg, polpercAvg, vsTargPercAvg, sogAvg, heelAvg";

const CHART_SYSTEM = `You are a sailing data analyst AI for Shared Sailing Analytics.
The user has log data (1 Hz rows with fields: ${LOG_FIELDS}) and clip summaries (fields: ${CLIP_FIELDS}).
When the user asks a question, respond with JSON ONLY — no markdown, no explanation outside JSON.
Return: {
  "answer": "brief natural language answer (1-3 sentences)",
  "chart": { "type": "xy" | "line" | "bar", "title": "chart title", "xField": "field name", "yField": "field name", "xLabel": "axis label", "yLabel": "axis label", "color": "#hexcolor" },
  "insight": "one actionable coaching insight"
}
Only produce a chart if it genuinely answers the question.`;

function AIChatPanel({rows, allVideos}){
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);
  const bottomRef = useRef(null);
  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:"smooth"}); },[messages]);
  const ask = async () => {
    const q = input.trim(); if(!q) return;
    setMessages(p=>[...p,{role:"user",text:q}]);
    setInput(""); setLoading(true);
    const history = messages.map(m=>({role: m.role==="user"?"user":"assistant",content: m.rawJson ? JSON.stringify(m.rawJson) : m.text}));
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,system: CHART_SYSTEM,messages:[...history,{role:"user",content:q}]})});
      const data = await res.json();
      const text = data.content?.find(b=>b.type==="text")?.text||"{}";
      const parsed = JSON.parse(text.replace(/```json|```/g,"").trim());
      setMessages(p=>[...p,{role:"assistant",text:parsed.answer||"",chart:parsed.chart,insight:parsed.insight,rawJson:parsed}]);
    } catch(e) { setMessages(p=>[...p,{role:"assistant",text:`Error: ${e.message}`}]); }
    setLoading(false);
  };
  const hasData = rows?.length > 0 || allVideos?.some(v=>v.twsAvg!=null);
  return(
    <div style={{background:"#0A1929",border:"1px solid #8B5CF640",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        <span style={{fontSize:14,color:"#8B5CF6"}}>✦</span>
        <div style={{fontSize:11,fontWeight:600,color:"#94A3B8",letterSpacing:1,textTransform:"uppercase"}}>Ask AI — get an answer + chart</div>
        {!hasData&&<span style={{fontSize:9,color:"#EF4444",marginLeft:"auto"}}>Load a session first</span>}
      </div>
      {messages.length===0&&(
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:12}}>
          {["Plot TWS vs SOG","How does heel change with wind?","Show polar % over time","Compare VMG across clips","Which TWA gives best VMG?","Show rudder vs heel scatter"].map(s=>(<button key={s} onClick={()=>{setInput(s);}} style={{background:"#071624",border:"1px solid #8B5CF640",borderRadius:5,padding:"4px 10px",color:"#8B5CF6",cursor:"pointer",fontSize:10}}>{s}</button>))}
        </div>
      )}
      {messages.length>0&&(
        <div style={{maxHeight:480,overflowY:"auto",marginBottom:10,display:"flex",flexDirection:"column",gap:10}}>
          {messages.map((m,i)=>(
            <div key={i}>
              {m.role==="user"&&(<div style={{display:"flex",justifyContent:"flex-end"}}><div style={{background:"#1E3A5A",borderRadius:"8px 8px 2px 8px",padding:"6px 10px",fontSize:11,color:"#E2E8F0",maxWidth:"70%"}}>{m.text}</div></div>)}
              {m.role==="assistant"&&(
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {m.text&&<div style={{background:"#071624",borderRadius:"8px 8px 8px 2px",padding:"8px 12px",fontSize:11,color:"#E2E8F0",lineHeight:1.5,maxWidth:"85%"}}>{m.text}</div>}
                  {m.chart&&<AIChart spec={m.chart} rows={rows} allVideos={allVideos}/>}
                  {m.insight&&<div style={{fontSize:10,color:"#475569",padding:"4px 8px",borderLeft:"2px solid #8B5CF640"}}>💡 {m.insight}</div>}
                </div>
              )}
            </div>
          ))}
          {loading&&<div style={{fontSize:10,color:"#8B5CF6",padding:"4px 8px"}}>Thinking…</div>}
          <div ref={bottomRef}/>
        </div>
      )}
      <div style={{display:"flex",gap:6}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!loading&&ask()} placeholder={hasData?"Ask about your sailing data…":"Load a session in Videos first"} disabled={!hasData||loading} style={{flex:1,background:"#071624",border:"1px solid #8B5CF640",borderRadius:6,padding:"7px 11px",color:"#E2E8F0",fontSize:11,outline:"none",opacity:hasData?1:0.4}}/>
        <button onClick={ask} disabled={!hasData||loading||!input.trim()} style={{background:loading||!input.trim()?"#1E3A5A":"#8B5CF6",border:"none",borderRadius:6,padding:"7px 14px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:11}}>{loading?"…":"Ask"}</button>
        {messages.length>0&&<button onClick={()=>setMessages([])} style={{background:"none",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 10px",color:"#475569",cursor:"pointer",fontSize:10}}>Clear</button>}
      </div>
    </div>
  );
}

// ─── GPS TRACK MAP ────────────────────────────────────────────────────────────
// playUtc   — current video UTC for boat marker (null = no video playing)
// visible   — whether the Analytics tab is currently shown (for Leaflet resize)

function GPSTrackMap({rows, videoStartUtc, videoDurationSec, xmlData, syncOffset=0, playUtc=null, visible=true, allVideos=[], onSelectVideo=null, onSwitchTab=null, photos=[]}){
  const tz=useTz();
  const containerRef = React.useRef(null);
  const mapRef       = React.useRef(null);
  const boatMarkerRef= React.useRef(null); // Leaflet marker for live boat position

  const dayStart = xmlData?.dayStartUtc || null;
  const dayStop  = xmlData?.dayStopUtc  || null;

  const filteredRows = React.useMemo(()=>{
    if(!rows?.length) return [];
    let r = rows.filter(row=>
      row.lat && row.lon &&
      Math.abs(row.lat)>0.01 && Math.abs(row.lat)<90 &&
      Math.abs(row.lon)>0.01 && Math.abs(row.lon)<180
    );
    if(dayStart) r = r.filter(row=>row.utc>=dayStart);
    if(dayStop)  r = r.filter(row=>row.utc<=dayStop);
    return r;
  },[rows, dayStart, dayStop]);

  const winStart = videoStartUtc ? videoStartUtc+(syncOffset||0)*1000 : null;
  const winEnd   = winStart ? winStart+(videoDurationSec||0)*1000 : null;
  const hlRows   = React.useMemo(()=>
    winStart ? filteredRows.filter(r=>r.utc>=winStart&&r.utc<=winEnd) : []
  ,[filteredRows, winStart, winEnd]);

  const polar = React.useMemo(()=>loadPolarFromLS(),[]);

  // Keep callbacks in refs so Leaflet click closures always have the latest values
  const onSelectVideoRef = React.useRef(onSelectVideo);
  const onSwitchTabRef   = React.useRef(onSwitchTab);
  React.useEffect(()=>{ onSelectVideoRef.current=onSelectVideo; },[onSelectVideo]);
  React.useEffect(()=>{ onSwitchTabRef.current=onSwitchTab; },  [onSwitchTab]);
  const playUtcRef = React.useRef(playUtc);
  React.useEffect(()=>{ playUtcRef.current = playUtc; },[playUtc]);

  // Only the video MARKERS matter to the map — id + position in time. `allVideos`
  // itself churns constantly (thumbnail loads, proxy/original flags, sync state), and
  // it used to be a dep of the map effect, so the whole Leaflet map was destroyed and
  // rebuilt on every one of those updates. Tearing a map down mid fitBounds/zoom
  // animation is what threw `Cannot read properties of undefined (reading '_leaflet_pos')`
  // — the animation frame lands on a pane that no longer exists.
  const videoMarkerSig = React.useMemo(
    // duration is included: it loads asynchronously after import, and the markers
    // filter on it — leave it out and a clip never gets its marker.
    () => (allVideos||[]).map(v=>`${v.id}:${v.startUtc||0}:${v.duration||0}`).join('|'),
    [allVideos]
  );
  const allVideosMapRef = React.useRef(allVideos);
  allVideosMapRef.current = allVideos;

  // ── Map init ─────────────────────────────────────────────────────────────────
  React.useEffect(()=>{
    if(!containerRef.current || filteredRows.length < 2) return;
    let cancelled = false;   // the Leaflet <script> can finish loading AFTER unmount

    const initMap = () => {
      const L = window.L;
      if(!L) return;
      // Don't build a map into a container React has already thrown away.
      if(cancelled || !containerRef.current) return;
      if(mapRef.current){ mapRef.current.remove(); mapRef.current=null; boatMarkerRef.current=null; }

      const centre = [
        filteredRows.reduce((s,r)=>s+r.lat,0)/filteredRows.length,
        filteredRows.reduce((s,r)=>s+r.lon,0)/filteredRows.length,
      ];
      const map = L.map(containerRef.current, {center:centre, zoom:12, zoomControl:true, attributionControl:true});
      mapRef.current = map;

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        attribution:'© OpenStreetMap contributors', maxZoom:18,
      }).addTo(map);

      // ── Coloured performance track ──────────────────────────────────────────
      const step = Math.max(1, Math.floor(filteredRows.length/1200));
      const sampled = filteredRows.filter((_,i)=>i%step===0);
      const segments = [];
      let seg = {color:null, pts:[]};
      for(let i=0;i<sampled.length;i++){
        const row = sampled[i];
        const perf = polarPerf(polar, row.bsp, row.twa, row.tws);
        const color = perf ? perfColor(perf.pct) : '#1E4080';
        const pt = [row.lat, row.lon];
        if(!seg.color){ seg={color,pts:[pt]}; }
        else if(color!==seg.color){ seg.pts.push(pt); if(seg.pts.length>1) segments.push({...seg,pts:[...seg.pts]}); seg={color,pts:[pt]}; }
        else { seg.pts.push(pt); }
      }
      if(seg.pts.length>1) segments.push(seg);
      let allLatLngs = [];
      for(const s of segments){
        L.polyline(s.pts,{color:s.color,weight:3,opacity:0.92,smoothFactor:1}).addTo(map);
        allLatLngs=allLatLngs.concat(s.pts);
      }

      // ── Clip highlight (selected video) ────────────────────────────────────
      if(hlRows.length>1){
        const hlStep=Math.max(1,Math.floor(hlRows.length/500));
        const hlPts=hlRows.filter((_,i)=>i%hlStep===0).map(r=>[r.lat,r.lon]);
        L.polyline(hlPts,{color:'#06B6D4',weight:6,opacity:0.85}).addTo(map);
        const cOpts={radius:8,fillOpacity:1,weight:2,color:'#030F1A'};
        L.circleMarker([hlRows[0].lat,hlRows[0].lon],{...cOpts,fillColor:'#06B6D4'}).bindTooltip('Clip start').addTo(map);
        L.circleMarker([hlRows[hlRows.length-1].lat,hlRows[hlRows.length-1].lon],{...cOpts,fillColor:'#1D9E75'}).bindTooltip('Clip end').addTo(map);
      }

      // ── Video coverage — all clips with a startUtc ──────────────────────────
      // Draw a bright magenta polyline over the GPS track for every clip's window,
      // so coaches can see at a glance which manoeuvres were recorded.
      const covVideos=(allVideosMapRef.current||[]).filter(v=>v.startUtc&&v.duration);
      for(const vid of covVideos){
        const vStart=vid.startUtc;
        const vEnd=vStart+vid.duration*1000;
        // Skip if this is the already-highlighted selected clip (avoid double render)
        if(winStart&&Math.abs(vStart-winStart)<2000) continue;
        const covRows=filteredRows.filter(r=>r.utc>=vStart&&r.utc<=vEnd);
        if(covRows.length<2) continue;
        const covStep=Math.max(1,Math.floor(covRows.length/300));
        const covPts=covRows.filter((_,i)=>i%covStep===0).map(r=>[r.lat,r.lon]);
        const polyline = L.polyline(covPts,{
          color:'#ffffff',
          weight:8,
          opacity:0.28,
          smoothFactor:1,
        })
          .bindTooltip(`📹 ${vid.title||'Video'} · ${Math.round(vid.duration/60)}min<br><span style="font-size:10px;color:#94A3B8">Click to open in Videos</span>`,{allowHTML:true})
          .addTo(map);
        polyline.on('click',()=>{
          if(onSelectVideoRef.current) onSelectVideoRef.current(vid);
          if(onSwitchTabRef.current)   onSwitchTabRef.current('library');
        });
        polyline.getElement && (polyline.getElement().style.cursor='pointer');
        // Small dot at coverage start
        L.circleMarker(covPts[0],{radius:5,fillColor:'#ffffff',color:'rgba(0,0,0,0.3)',weight:1,fillOpacity:0.5})
          .addTo(map);
      }

      // ── Day start / end markers ─────────────────────────────────────────────
      const fmtU=utc=>{try{return isNaN(new Date(utc))?'--:--':hmLocal(utc,tz);}catch{return'--:--';}};
      const first=filteredRows[0],last=filteredRows[filteredRows.length-1];
      L.circleMarker([first.lat,first.lon],{radius:9,fillColor:'#22C55E',color:'#fff',weight:2,fillOpacity:1}).bindTooltip(`Day start ${fmtU(first.utc)} UTC`).addTo(map);
      L.circleMarker([last.lat,last.lon],{radius:9,fillColor:'#94A3B8',color:'#fff',weight:2,fillOpacity:1}).bindTooltip(`Day end ${fmtU(last.utc)} UTC`).addTo(map);

      // ── Event markers ───────────────────────────────────────────────────────
      if(xmlData){
        const nearest=utc=>filteredRows.reduce((a,b)=>Math.abs(b.utc-utc)<Math.abs(a.utc-utc)?b:a,filteredRows[0]);
        for(const m of (xmlData.markRoundings||[])){
          try{const nr=nearest(m.utc);if(Math.abs(nr.utc-m.utc)>120000)continue;
            L.circleMarker([nr.lat,nr.lon],{radius:10,fillColor:m.isTop?"#EF4444":"#8B5CF6",color:'#030F1A',weight:2,fillOpacity:m.isValid===false?0.3:1}).bindTooltip(`${m.label||'Mark'} · ${fmtU(m.utc)}`).addTo(map);
            L.marker([nr.lat,nr.lon],{icon:L.divIcon({className:'',iconSize:[0,0],iconAnchor:[-5,-12],html:`<span style="font-size:9px;font-weight:700;color:#fff;text-shadow:0 0 3px #000">${m.isTop?'▲':'▽'}</span>`})}).addTo(map);
          }catch(e){console.warn('mark err',e);}
        }
        for(const g of (xmlData.raceGuns||[])){
          try{const nr=nearest(g.utc);if(Math.abs(nr.utc-g.utc)>120000)continue;
            L.circleMarker([nr.lat,nr.lon],{radius:10,fillColor:'#EF4444',color:'#fff',weight:2,fillOpacity:1}).bindTooltip(`${g.label||'Gun'} · ${fmtU(g.utc)}`).addTo(map);
          }catch(e){}
        }
        for(const tj of (xmlData.tackJibes||[])){
          try{const nr=nearest(tj.utc);if(Math.abs(nr.utc-tj.utc)>60000)continue;
            L.circleMarker([nr.lat,nr.lon],{radius:tj.isValid===false?3:5,fillColor:tj.isTack?'#1D9E75':'#7F77DD',color:'transparent',fillOpacity:tj.isValid===false?0.25:0.85}).bindTooltip(`${tj.label||'T/G'} · ${fmtU(tj.utc)}`).addTo(map);
          }catch(e){}
        }
        for(const se of (xmlData.sailsUpEvents||[])){
          try{const nr=nearest(se.utc);if(Math.abs(nr.utc-se.utc)>120000)continue;
            L.marker([nr.lat,nr.lon],{icon:L.divIcon({className:'',iconSize:[0,0],iconAnchor:[0,0],html:`<div style="background:#F59E0B;border:1.5px solid #030F1A;border-radius:3px;padding:1px 4px;font-size:8px;font-weight:700;color:#000;white-space:nowrap;max-width:100px;overflow:hidden;text-overflow:ellipsis">${(se.sails||[]).slice(0,2).join('·')||'Sail'}</div>`})}).bindTooltip(`${se.label||'Sail'} · ${fmtU(se.utc)}`).addTo(map);
          }catch(e){}
        }
      }

      // ── Boat position marker (for video sync) ───────────────────────────────
      const boatMarker = L.marker(centre, {
        icon: L.divIcon({
          className: 'ssa-boat',
          iconSize: [20, 26],
          iconAnchor: [10, 13],
          html: `<div class="boat-inner" style="opacity:0;transition:opacity 0.15s;width:20px;height:26px">
            <svg width="20" height="26" viewBox="0 0 20 26" fill="none">
              <path d="M10 2 L18 22 L10 17 L2 22 Z" fill="#F59E0B" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
              <circle cx="10" cy="13" r="3" fill="#fff" fill-opacity="0.9"/>
            </svg>
          </div>`,
        }),
        zIndexOffset: 2000,
        interactive: false,
      }).addTo(map);
      boatMarkerRef.current = boatMarker;

      // Immediately position boat from current playUtc — avoids waiting for
      // next [playUtc] effect which won't fire again just because the ref changed.
      // Use requestAnimationFrame so Leaflet has had a tick to add the element to DOM.
      requestAnimationFrame(()=>{
        const inner = boatMarker.getElement()?.querySelector('.boat-inner');
        const curUtc = playUtcRef.current;
        if(!inner || !curUtc) return;
        let lo=0, hi=filteredRows.length-1;
        while(lo<hi){const mid=(lo+hi+1)>>1; if(filteredRows[mid].utc<=curUtc)lo=mid; else hi=mid-1;}
        const row=filteredRows[lo];
        if(!row||Math.abs(row.utc-curUtc)>60000)return;
        boatMarker.setLatLng([row.lat,row.lon]);
        const nxt=filteredRows[Math.min(lo+3,filteredRows.length-1)];
        let hdg=0;
        if(nxt&&nxt!==row){const dLon=(nxt.lon-row.lon)*Math.PI/180;const y=Math.sin(dLon)*Math.cos(nxt.lat*Math.PI/180);const x=Math.cos(row.lat*Math.PI/180)*Math.sin(nxt.lat*Math.PI/180)-Math.sin(row.lat*Math.PI/180)*Math.cos(nxt.lat*Math.PI/180)*Math.cos(dLon);hdg=(Math.atan2(y,x)*180/Math.PI+360)%360;}
        inner.style.opacity='1';
        inner.style.transform=`rotate(${hdg}deg)`;
      });

      // ── Legends ─────────────────────────────────────────────────────────────
      if(polar){
        const leg=L.control({position:'bottomright'});
        leg.onAdd=()=>{const d=L.DomUtil.create('div','');d.style.cssText='background:rgba(3,15,26,0.92);border:1px solid #1E3A5A;border-radius:7px;padding:8px 11px;font-size:9px;color:#94A3B8;line-height:1.9';d.innerHTML=`<div style="font-weight:700;color:#E2E8F0;margin-bottom:4px;font-size:10px">⬡ ${polar.filename||'Polar'} · ${polar.tws?.[0]}–${polar.tws?.[polar.tws.length-1]} kn</div><div><span style="display:inline-block;width:10px;height:5px;background:#EF4444;border-radius:1px;margin-right:5px;vertical-align:middle"></span>≤ 90%</div><div><span style="display:inline-block;width:10px;height:5px;background:#86EFAC;border-radius:1px;margin-right:5px;vertical-align:middle"></span>100%</div><div><span style="display:inline-block;width:10px;height:5px;background:#15803D;border-radius:1px;margin-right:5px;vertical-align:middle"></span>≥ 110%</div><div style="margin-top:3px;color:#475569;font-size:8px">VMG ±20° target · BSP reaching</div>`;return d;};
        leg.addTo(map);
      }
      const evLeg=L.control({position:'bottomleft'});
      evLeg.onAdd=()=>{const d=L.DomUtil.create('div','');d.style.cssText='background:rgba(3,15,26,0.92);border:1px solid #1E3A5A;border-radius:7px;padding:8px 11px;font-size:9px;color:#94A3B8;line-height:1.9';d.innerHTML=`<div><span style="display:inline-block;width:8px;height:8px;background:#22C55E;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Day start</div><div><span style="display:inline-block;width:8px;height:8px;background:#94A3B8;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Day end</div><div><span style="display:inline-block;width:8px;height:8px;background:#EF4444;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Top mark / gun</div><div><span style="display:inline-block;width:8px;height:8px;background:#8B5CF6;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Gate</div><div><span style="display:inline-block;width:8px;height:8px;background:#1D9E75;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Tack</div><div><span style="display:inline-block;width:8px;height:8px;background:#7F77DD;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Gybe</div><div><span style="display:inline-block;width:8px;height:8px;background:#F59E0B;border-radius:2px;margin-right:5px;vertical-align:middle"></span>Sail change</div><div><span style="display:inline-block;width:14px;height:4px;background:#F59E0B;border-radius:2px;margin-right:5px;vertical-align:middle"></span>Boat position</div><div><span style="display:inline-block;width:14px;height:6px;background:rgba(255,255,255,0.3);border-radius:2px;margin-right:5px;vertical-align:middle;border:1px solid rgba(255,255,255,0.4)"></span>📹 Video coverage</div>`;return d;};
      evLeg.addTo(map);

      // ── Photo markers ──────────────────────────────────────────────────────
      for(const photo of (photos||[])){
        if(!photo.lat||!photo.lon)continue;
        try{
          const marker=L.marker([photo.lat,photo.lon],{
            icon:L.divIcon({className:"",iconSize:[24,24],iconAnchor:[12,12],
              html:`<div style="background:#8B5CF6;border:2px solid #fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.5)">📷</div>`})
          });
          const dt=photo.utc?new Date(photo.utc).toISOString().slice(0,16).replace("T"," ")+" UTC":"";
          marker.bindTooltip(`📷 ${photo.name||"Photo"}<br><span style="font-size:10px;color:#94A3B8">${dt}</span>`,{allowHTML:true});
          if(photo.objectUrl){
            marker.on("click",()=>{
              const img=document.createElement("img");
              img.src=photo.objectUrl;
              img.style.cssText="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);max-width:80vw;max-height:80vh;z-index:9999;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.8);cursor:pointer";
              img.onclick=()=>document.body.removeChild(img);
              document.body.appendChild(img);
            });
          }
          marker.addTo(map);
        }catch(e){console.warn("photo marker err",e);}
      }

      // animate:false — an animated fitBounds schedules a zoom via requestAnimationFrame;
      // if the map is torn down before that fires (re-render churn on data load) the
      // callback throws `Cannot read properties of undefined (reading '_leaflet_pos')`,
      // which the sync try/catch can't catch. Jumping avoids the deferred animation.
      if(allLatLngs.length>0){try{map.fitBounds(L.latLngBounds(allLatLngs),{padding:[24,24],animate:false});}catch{}}
    };

    if(!window.L){
      if(!document.getElementById('leaflet-css')){const css=document.createElement('link');css.id='leaflet-css';css.rel='stylesheet';css.href='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';document.head.appendChild(css);}
      const js=document.createElement('script');js.src='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';js.onload=initMap;document.head.appendChild(js);
    } else { initMap(); }
    return()=>{
      cancelled = true;
      if(mapRef.current){ mapRef.current.remove(); mapRef.current=null; boatMarkerRef.current=null; }
    };
  },[filteredRows, hlRows, xmlData, polar, videoMarkerSig]);

  // ── Resize when tab becomes visible ──────────────────────────────────────────
  React.useEffect(()=>{
    if(visible && mapRef.current){
      setTimeout(()=>{try{mapRef.current?.invalidateSize();}catch{}}, 60);
    }
  },[visible]);

  // ── Live boat position from video playback ────────────────────────────────────
  // Direct Leaflet API — no React re-render for position updates
  React.useEffect(()=>{
    const marker = boatMarkerRef.current;
    if(!marker || !filteredRows?.length) return;
    const inner = marker.getElement()?.querySelector('.boat-inner');
    if(!playUtc){ if(inner) inner.style.opacity='0'; return; }

    // Binary search for nearest row
    let lo=0, hi=filteredRows.length-1;
    while(lo<hi){const mid=(lo+hi+1)>>1; if(filteredRows[mid].utc<=playUtc)lo=mid; else hi=mid-1;}
    const row=filteredRows[lo];
    if(!row||Math.abs(row.utc-playUtc)>60000){ if(inner) inner.style.opacity='0'; return; }

    // Update position
    marker.setLatLng([row.lat,row.lon]);

    // Compute bearing from next few rows
    const nextRow=filteredRows[Math.min(lo+3,filteredRows.length-1)];
    let hdg=0;
    if(nextRow&&nextRow!==row){
      const dLon=(nextRow.lon-row.lon)*Math.PI/180;
      const y=Math.sin(dLon)*Math.cos(nextRow.lat*Math.PI/180);
      const x=Math.cos(row.lat*Math.PI/180)*Math.sin(nextRow.lat*Math.PI/180)-Math.sin(row.lat*Math.PI/180)*Math.cos(nextRow.lat*Math.PI/180)*Math.cos(dLon);
      hdg=(Math.atan2(y,x)*180/Math.PI+360)%360;
    }
    if(inner){
      inner.style.opacity='1';
      inner.style.transform=`rotate(${hdg}deg)`;
    }
  },[playUtc, filteredRows]);

  if(!rows?.length) return(<div style={{padding:12,background:"#071624",borderRadius:8,color:"#EF4444",fontSize:10}}>No log data</div>);
  if(filteredRows.length<2) return(<div style={{padding:12,background:"#071624",borderRadius:8,color:"#F59E0B",fontSize:10}}>No valid GPS rows. DayStart={dayStart?new Date(dayStart).toISOString().slice(11,19):"none"}. First row: lat={rows[0]?.lat?.toFixed?.(4)} lon={rows[0]?.lon?.toFixed?.(4)}</div>);

  const haversine=(a,b)=>{const R=6371,dl=(b.lat-a.lat)*Math.PI/180,dn=(b.lon-a.lon)*Math.PI/180,x=Math.sin(dl/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dn/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
  let distKm=0; for(let i=1;i<filteredRows.length;i++) distKm+=haversine(filteredRows[i-1],filteredRows[i]);
  const distNm=(distKm/1.852).toFixed(1);

  return(
    <div>
      {polar ? (
        <div style={{marginBottom:6,display:"flex",alignItems:"center",gap:8,fontSize:9,color:"#F59E0B",flexWrap:"wrap"}}>
          <span style={{background:"#F59E0B12",border:"1px solid #F59E0B30",borderRadius:3,padding:"2px 7px",fontWeight:600}}>⬡ {polar.filename} · TWS {polar.tws?.[0]}–{polar.tws?.[polar.tws.length-1]} kn</span>
          <span style={{color:"#475569"}}>coloured by VMG% (±20° of target TWA) · BSP% (reaching)</span>
        </div>
      ) : (
        <div style={{marginBottom:6,fontSize:9,color:"#475569"}}>No polar loaded — track in uniform blue. Upload a polar in Uploads tab.</div>
      )}
      <div ref={containerRef} style={{width:"100%",height:460,borderRadius:10,overflow:"hidden",border:"1px solid #1E3A5A",background:"#071624"}}/>
      <div style={{display:"flex",gap:16,marginTop:6,flexWrap:"wrap",fontSize:10,color:"#475569",alignItems:"center"}}>
        <span>{filteredRows.length.toLocaleString()} GPS pts{dayStart?" · DayStart–DayStop window":""}</span>
        <span>Distance: <strong style={{color:"#06B6D4"}}>{distNm} nm</strong></span>
        {dayStart&&<span>Start: <strong style={{color:"#22C55E"}}>{hmLocal(dayStart,tz)}</strong></span>}
        {dayStop&&<span>End: <strong style={{color:"#F59E0B"}}>{hmLocal(dayStop,tz)}</strong></span>}
        {hlRows.length>0&&<span style={{color:"#06B6D4",marginLeft:"auto"}}>● Clip: {hlRows.length} pts</span>}
        {playUtc&&<span style={{color:"#F59E0B",marginLeft:"auto"}}>▲ Live: {hmLocal(playUtc,tz)}</span>}
      </div>
    </div>
  );
}

// ─── ANALYTICS TAB ────────────────────────────────────────────────────────────
function AnalyticsTab({logData,xmlData,allVideos,sessions,selectedVideo,onSelectVideo,setActiveTab,activeDate,onSelectDate,playUtc=null,visible=true,photos=[],canUseAI=true,canSeeAnalyticsData=true}){
  const tz=useTz();
  const rows=logData?.rows||[];
  const noData=!rows.length;
  const step=Math.max(1,Math.floor(rows.length/400));
  const twsPts=rows.filter((_,i)=>i%step===0).map(r=>({x:r.utc,y:r.tws}));
  const sogPts=rows.filter((_,i)=>i%step===0).map(r=>({x:r.utc,y:r.sog}));
  const heelPts=rows.filter((_,i)=>i%step===0).map(r=>({x:r.utc,y:Math.abs(r.heel)}));

  // Shared pan/zoom state for all timeseries — null = show full session
  const [viewRange, setViewRange] = useState(null);
  // Tacking analysis — highlighted tack index (null = none selected)
  const [selectedTackIdx, setSelectedTackIdx] = useState(null);
  // Reset view when the session changes
  useEffect(()=>{ setViewRange(null); }, [activeDate]);
  // Auto-zoom to video clip range when video is selected and has a start time.
  // Depends on both selectedVideo?.id AND activeDate so it re-fires when a new
  // session is loaded (rows might have been empty on the previous render).
  useEffect(()=>{
    if(selectedVideo?.startUtc && selectedVideo?.duration && rows.length){
      const padMs = selectedVideo.duration * 1000 * 0.15; // 15% padding either side
      const nx0 = selectedVideo.startUtc - padMs;
      const nx1 = selectedVideo.startUtc + selectedVideo.duration * 1000 + padMs;
      const allX0 = rows[0].utc, allX1 = rows[rows.length-1].utc;
      // Only zoom if the clip is narrower than the full session
      if(nx0 > allX0 || nx1 < allX1){
        setViewRange([Math.max(allX0, nx0), Math.min(allX1, nx1)]);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVideo?.id, activeDate]);
  const chartEvents = xmlData ? [
    ...(xmlData.markRoundings||[]).filter(m=>m.isValid!==false).map(m=>({utc:m.utc,label:m.isTop?"⬆ top":"⬇ gate",color:m.isTop?"#EF4444":"#8B5CF6"})),
    ...(xmlData.raceGuns||[]).map(g=>({utc:g.utc,label:"🚩 start",color:"#EF4444"})),
    ...(xmlData.tackJibes||[]).filter(t=>t.isValid!==false).map(t=>({utc:t.utc,label:t.isTack?"T":"G",color:t.isTack?"#1D9E75":"#7F77DD"})),
  ] : [];
  const twsAvg=rows.length?rows.reduce((s,r)=>s+r.tws,0)/rows.length:0;
  const sogAvg=rows.length?rows.reduce((s,r)=>s+r.sog,0)/rows.length:0;
  const sogMax=rows.length?Math.max(...rows.map(r=>r.sog)):0;
  const twsMax=rows.length?Math.max(...rows.map(r=>r.tws)):0;
  const vsTargRows=rows.filter(r=>r.vsTargPct>5&&r.vsTargPct<200);
  const vsTargAvg=vsTargRows.length?vsTargRows.reduce((s,r)=>s+r.vsTargPct,0)/vsTargRows.length:null;
  const vsPerfRows=rows.filter(r=>r.vsPerfPct>5&&r.vsPerfPct<200);
  const vsPerfAvg=vsPerfRows.length?vsPerfRows.reduce((s,r)=>s+r.vsPerfPct,0)/vsPerfRows.length:null;
  const tacks=(xmlData?.tackJibes||[]).filter(t=>t.isTack&&t.isValid!==false).length;
  const gybes=(xmlData?.tackJibes||[]).filter(t=>!t.isTack&&t.isValid!==false).length;
  const marks=(xmlData?.markRoundings||[]).filter(m=>m.isValid!==false).length;
  const topMarks=(xmlData?.markRoundings||[]).filter(m=>m.isTop&&m.isValid!==false).length;
  const durationH=rows.length?(rows[rows.length-1].utc-rows[0].utc)/3600000:0;

  // Live row at current playback position
  const liveRow = playUtc && rows.length ? nearestRow(rows, playUtc) : null;
  const liveActive = liveRow && Math.abs(liveRow.utc - (playUtc||0)) < 60000;

  const card=(label,val,unit,color)=>(<div style={{background:"#0A1929",border:`1px solid ${color}25`,borderRadius:8,padding:"12px 14px"}}><div style={{fontSize:9,color:"#334155",letterSpacing:1,textTransform:"uppercase",marginBottom:3}}>{label}</div><div style={{fontSize:22,fontWeight:700,color,fontFamily:"monospace"}}>{val}<span style={{fontSize:11,color:"#475569",marginLeft:3}}>{unit}</span></div></div>);
  const section=(title,children)=>(<div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:"14px 16px",marginBottom:14}}><div style={{fontSize:11,fontWeight:600,color:"#64748B",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>{title}</div>{children}</div>);
  // ── Prominent session date header ────────────────────────────────────────────
  // Analytics previously buried the session date inside a dense status pill,
  // which on mobile wrapped awkwardly and left users unsure which day they
  // were looking at. We surface the date, day-of-week and location/boat (from
  // event XML meta) in a clear banner at the top of the tab.
  const sessionDateLabel=(()=>{
    if(!activeDate) return "No session loaded";
    const [y,m,d]=activeDate.split("-").map(Number);
    if(!y||!m||!d) return activeDate;
    const dt=new Date(Date.UTC(y,m-1,d));
    const today=TODAY();
    const yesterday=(()=>{const t=new Date();t.setDate(t.getDate()-1);return t.toISOString().slice(0,10);})();
    const dayNames=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const monthNames=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const rel=activeDate===today?"Today":activeDate===yesterday?"Yesterday":null;
    const long=`${dayNames[dt.getUTCDay()]} ${d} ${monthNames[m-1]} ${y}`;
    return rel?`${rel} · ${long}`:long;
  })();
  const sessionMeta=xmlData?.meta||{};

  return(
    <div style={{flex:1,overflowY:"auto",padding:16}}>
      <div style={{maxWidth:900,margin:"0 auto"}}>
        {/* ── Session banner: clear, always-visible date indicator ─────── */}
        <div style={{background:"linear-gradient(90deg,#0A1929 0%,#0F2A45 100%)",
          border:"1px solid #06B6D440",borderRadius:10,padding:"10px 14px",marginBottom:12,
          display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div style={{fontSize:18,lineHeight:1}}>📅</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:10,color:"#64748B",letterSpacing:1.5,textTransform:"uppercase",fontWeight:600}}>Session</div>
            <div style={{fontSize:15,fontWeight:700,color:"#E2E8F0",marginTop:1,
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {sessionDateLabel}
            </div>
            {(sessionMeta.location||sessionMeta.boat||sessionMeta.dayType)&&(
              <div style={{fontSize:11,color:"#7DD3FC",marginTop:2,
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {[sessionMeta.location,sessionMeta.boat,sessionMeta.dayType].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
          <button onClick={()=>setActiveTab("library")}
            style={{background:"#06B6D420",border:"1px solid #06B6D460",borderRadius:6,
              padding:"6px 12px",color:"#06B6D4",cursor:"pointer",fontSize:11,fontWeight:600,
              flexShrink:0,minHeight:32}}>
            Change
          </button>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
          <div style={{fontSize:15,fontWeight:600,color:"#E2E8F0"}}>Analytics</div>
          {sessions && sessions.length > 0 && onSelectDate && (
            <select
              value={activeDate || ''}
              onChange={(e)=>onSelectDate(e.target.value)}
              style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,padding:"4px 8px",color:"#E2E8F0",fontSize:11,cursor:"pointer",fontFamily:"monospace"}}
              title="Switch session date"
            >
              {sessions.filter(s => (s.videoCount||0) > 0 && s.date <= TODAY()).map(s => (
                <option key={s.date} value={s.date}>
                  {s.date === TODAY() ? `Today (${s.date})` : s.date}
                  {s.videoCount ? ` · ${s.videoCount}v` : ''}
                  {s.hasLog ? ' · log' : ''}
                  {s.hasXml ? ' · ev' : ''}
                </option>
              ))}
            </select>
          )}
          {logData&&<span style={{fontSize:10,color:logData.source==="local"?"#1D9E75":"#8B5CF6",background:logData.source==="local"?"#1D9E7510":"#8B5CF610",border:`1px solid ${logData.source==="local"?"#1D9E7530":"#8B5CF630"}`,borderRadius:3,padding:"2px 7px"}}>{logData.source==="local"?"● Local":"● Cloud"} · {rows.length.toLocaleString()} rows · {durationH.toFixed(1)}h</span>}
          {xmlData ? (
            <span style={{fontSize:10,color:"#8B5CF6",background:"#8B5CF610",border:"1px solid #8B5CF630",borderRadius:3,padding:"2px 7px"}}>
              ● Events · {(xmlData.tackJibes||[]).length} T/G · {(xmlData.markRoundings||[]).length} marks · {(xmlData.raceGuns||[]).length} guns · {(xmlData.sailsUpEvents||[]).length} sail chg
            </span>
          ) : (
            <span style={{fontSize:10,color:"#F59E0B",background:"#F59E0B10",border:"1px solid #F59E0B30",borderRadius:3,padding:"2px 7px"}}>
              ⚠ No event file — select session in Videos or re-import XML
            </span>
          )}
          {!logData&&<span style={{fontSize:10,color:"#EF4444"}}>No log data loaded — select a session in Videos</span>}
        </div>

        {/* ── Now Playing bar — live instrument data from video ── */}
        {liveActive&&(
          <div style={{background:"#0A1929",border:"1px solid #F59E0B40",borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <span style={{fontSize:9,color:"#F59E0B",fontWeight:700,letterSpacing:1,textTransform:"uppercase",flexShrink:0}}>▶ Now playing</span>
            <span style={{fontSize:11,fontFamily:"monospace",color:"#94A3B8"}}>{hmsLocal(playUtc,tz)}</span>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {[["TWS",liveRow.tws,"kn","#7DD3FC"],["TWA",liveRow.twa,"°","#7DD3FC"],["BSP",liveRow.bsp,"kn","#10B981"],["SOG",liveRow.sog,"kn","#FBBF24"],["VMG",liveRow.vmg,"kn","#22C55E"],["Heel",liveRow.heel,"°","#F97316"]].map(([l,v,u,c])=>(
                <div key={l} style={{display:"flex",alignItems:"baseline",gap:3}}>
                  <span style={{fontSize:9,color:"#334155"}}>{l}</span>
                  <span style={{fontSize:13,fontWeight:700,fontFamily:"monospace",color:c}}>{R(v,l==="TWA"||l==="Heel"?0:1)}</span>
                  <span style={{fontSize:9,color:"#475569"}}>{u}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {noData ? (
          <div style={{textAlign:"center",padding:"50px 20px",color:"#334155"}}>
            <div style={{fontSize:32,marginBottom:12,opacity:0.3}}>📊</div>
            <div style={{fontSize:13,color:"#475569",marginBottom:6}}>No log data loaded</div>
            <div style={{fontSize:11,color:"#334155",marginBottom:16}}>Select a session in the Library sidebar — click any date to load its log and event data.</div>
            <div style={{display:"flex",gap:8,justifyContent:"center"}}>
              <button onClick={()=>setActiveTab("library")} style={{background:"#06B6D4",border:"none",borderRadius:8,padding:"8px 20px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>Go to Videos</button>
              <button onClick={()=>setActiveTab("upload")} style={{background:"#1E3A5A",border:"none",borderRadius:8,padding:"8px 20px",color:"#94A3B8",fontWeight:700,cursor:"pointer",fontSize:12}}>Re-import CSV</button>
            </div>
          </div>
        ) : (
          <>
            {canSeeAnalyticsData && (
              <>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
                  {card("Avg TWS",R(twsAvg),"kn","#7DD3FC")}
                  {card("Max TWS",R(twsMax),"kn","#7DD3FC")}
                  {card("Avg SOG",R(sogAvg),"kn","#FBBF24")}
                  {card("Max SOG",R(sogMax),"kn","#FBBF24")}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
                  {card("Tacks",tacks,"","#1D9E75")}
                  {card("Gybes",gybes,"","#7F77DD")}
                  {card("Polar %",vsPerfAvg?R(vsPerfAvg)+"%":"--","","#F59E0B")}
                  {card("Target %",vsTargAvg?R(vsTargAvg)+"%":"--","","#EF4444")}
                </div>
              </>
            )}
            {section("GPS track",(
              rows.length > 0 ? (
                <GPSTrackMap rows={rows} videoStartUtc={selectedVideo?.startUtc||null} videoDurationSec={selectedVideo?.duration||0} xmlData={xmlData} syncOffset={0} playUtc={playUtc} visible={visible} allVideos={allVideos} onSelectVideo={onSelectVideo} onSwitchTab={setActiveTab} photos={photos}/>
              ) : (
                <div style={{padding:12,background:"#071624",borderRadius:8,color:"#F59E0B",fontSize:10}}>Load a session with GPS data — select a date in the Library first.</div>
              )
            ))}
            {canSeeAnalyticsData && section("Wind & boat speed · heel · performance",(
              <>
                {/* ── Zoom / pan control bar ─────────────────────────────── */}
                {rows.length>0&&(()=>{
                  const allX0=rows[0].utc, allX1=rows[rows.length-1].utc;
                  const fullSpan=allX1-allX0||1;
                  const [vx0,vx1]=viewRange??[allX0,allX1];
                  const span=vx1-vx0;
                  const fmtUTC=u=>hmLocal(u,tz);
                  const fmtSpan=ms=>{const m=Math.round(ms/60000);return m>=60?`${Math.floor(m/60)}h ${m%60}m`:`${m}m`;};
                  const zoom=(factor,center)=>{
                    const [cvx0,cvx1]=viewRange??[allX0,allX1];
                    const s=cvx1-cvx0;
                    const pivot=center??((cvx0+cvx1)/2);
                    const frac=(pivot-cvx0)/s;
                    const newSpan=Math.max(60000,Math.min(fullSpan,s*factor));
                    let nx0=pivot-frac*newSpan, nx1=nx0+newSpan;
                    if(nx0<allX0){nx0=allX0;nx1=allX0+newSpan;}
                    if(nx1>allX1){nx1=allX1;nx0=allX1-newSpan;}
                    setViewRange(newSpan>=fullSpan*0.999?null:[nx0,nx1]);
                  };
                  const pan=dir=>{
                    const [cvx0,cvx1]=viewRange??[allX0,allX1];
                    const s=cvx1-cvx0;
                    const shift=s*0.25*dir;
                    let nx0=cvx0+shift, nx1=cvx1+shift;
                    if(nx0<allX0){nx0=allX0;nx1=allX0+s;}
                    if(nx1>allX1){nx1=allX1;nx0=allX1-s;}
                    setViewRange([nx0,nx1]);
                  };
                  const btnStyle={background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:5,padding:"3px 9px",color:"#94A3B8",cursor:"pointer",fontSize:11,fontFamily:"monospace",lineHeight:1.4};
                  const clipStart=selectedVideo?.startUtc;
                  const clipEnd=clipStart?(clipStart+(selectedVideo?.duration||0)*1000):null;
                  return(
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12,flexWrap:"wrap"}}>
                      <button style={btnStyle} onClick={()=>pan(-1)} title="Pan left 25%">◀</button>
                      <button style={btnStyle} onClick={()=>zoom(1/2)} title="Zoom in 2×">＋</button>
                      <button style={btnStyle} onClick={()=>zoom(2)} title="Zoom out 2×">－</button>
                      <button style={btnStyle} onClick={()=>pan(1)} title="Pan right 25%">▶</button>
                      {viewRange&&<button onClick={()=>setViewRange(null)} style={{...btnStyle,color:"#06B6D4",borderColor:"#06B6D440"}}>↩ Full session</button>}
                      {clipStart&&clipEnd&&<button onClick={()=>{ const pad=(clipEnd-clipStart)*0.15; setViewRange([Math.max(allX0,clipStart-pad),Math.min(allX1,clipEnd+pad)]); }} style={{...btnStyle,color:"#F59E0B",borderColor:"#F59E0B40"}}>▶ Clip window</button>}
                      <div style={{flex:1}}/>
                      <span style={{fontSize:9,color:"#475569",fontFamily:"monospace"}}>
                        {viewRange?`${fmtUTC(vx0)} – ${fmtUTC(vx1)} UTC · ${fmtSpan(span)}`:`Full session · ${fmtSpan(fullSpan)}`}
                      </span>
                      <span style={{fontSize:9,color:"#334155"}}>scroll to zoom · drag to pan</span>
                    </div>
                  );
                })()}
                {/* ── Charts row 1: TWS + SOG ─────────────────────────────── */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                  <div>
                    <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>TRUE WIND SPEED (kn)</div>
                    <LineChart points={twsPts} color="#7DD3FC" height={110} yLabel="TWS kn" showTrend events={chartEvents} playUtc={playUtc} viewRange={viewRange} onViewRange={setViewRange}/>
                  </div>
                  <div>
                    <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>SPEED OVER GROUND (kn)</div>
                    <LineChart points={sogPts} color="#FBBF24" height={110} yLabel="SOG kn" showTrend events={chartEvents} playUtc={playUtc} viewRange={viewRange} onViewRange={setViewRange}/>
                  </div>
                </div>
                {/* ── Charts row 2: Heel + Polar % ─────────────────────────── */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <div>
                    <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>HEEL ANGLE (°)</div>
                    <LineChart points={heelPts} color="#F97316" height={110} yLabel="Heel °" showTrend events={chartEvents} playUtc={playUtc} viewRange={viewRange} onViewRange={setViewRange}/>
                  </div>
                  <div>
                    <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>POLAR % &amp; TARGET %</div>
                    <PerfChart rows={rows} height={110} viewRange={viewRange} onViewRange={setViewRange} playUtc={playUtc}/>
                  </div>
                </div>
              </>
            ))}
            {canSeeAnalyticsData && rows.length>50&&section("Upwind analysis — data filtered to upwind phases",(()=>{
              // SailingPerformance sailingmode encoding observed from real data:
              //   1 = Upwind starboard tack   2 = Upwind port tack
              //   4 = Downwind/reach stbd     8 = Downwind/reach port
              const allPhases = xmlData?.phases||[];
              const upPhases  = allPhases.filter(p=>p.mode===1||p.mode===2);
              const dnPhases  = allPhases.filter(p=>p.mode===4||p.mode===8);
              const rcPhases  = allPhases.filter(p=>p.mode===16||p.mode===32);
              const hasPhases = allPhases.length > 0;

              // Binary-search membership: much faster than .some() for large row sets
              const makeInFn = phases => {
                if(!phases.length) return ()=>false;
                const sorted = [...phases].sort((a,b)=>a.utc-b.utc);
                return utc => {
                  let lo=0, hi=sorted.length-1;
                  while(lo<=hi){
                    const mid=(lo+hi)>>1;
                    if(utc>=sorted[mid].utc&&utc<sorted[mid].endUtc) return true;
                    if(utc<sorted[mid].utc) hi=mid-1; else lo=mid+1;
                  }
                  return false;
                };
              };
              const inUpwind  = hasPhases ? makeInFn(upPhases)  : ()=>true;

              const upMin  = Math.round(upPhases.reduce((s,p)=>s+(p.endUtc-p.utc),0)/60000);
              const dnMin  = Math.round(dnPhases.reduce((s,p)=>s+(p.endUtc-p.utc),0)/60000);
              const rcMin  = Math.round(rcPhases.reduce((s,p)=>s+(p.endUtc-p.utc),0)/60000);

              // Polar file — fallback only; the log's own Vs_target / TWA_targ
              // columns are preferred for the VMG% curve below.
              const upPolar = loadPolarFromLS();
              const logHasTarget = rows.some(r=>r.vsTarget!=null&&r.twaTarg!=null);

              // Sample rows inside upwind phases (max ~1200 pts for perf)
              const step=Math.max(1,Math.floor(rows.length/1200));
              const upRows=rows.filter((_,i)=>i%step===0)
                .filter(r=>r.tws>0&&r.tws<50&&inUpwind(r.utc));

              // a) VMG % of optimal upwind VMG. Target VMG comes from the log
              //    (Vs_target × cos(TWA_targ)); the polar curve is the fallback.
              const vmgPts=upRows.filter(r=>r.vmg>0).map(r=>{
                let optVMG=null;
                if(r.vsTarget!=null&&r.twaTarg!=null)
                  optVMG=r.vsTarget*Math.abs(Math.cos(r.twaTarg*Math.PI/180));
                else if(upPolar)
                  optVMG=polarVMGTarget(upPolar,r.tws)?.upVMG;
                const pct=(optVMG&&optVMG>0.01)?(Math.abs(r.vmg)/optVMG)*100:null;
                return (pct!=null&&pct>20&&pct<150)?{x:r.tws,y:pct,twa:r.twa}:null;
              }).filter(Boolean);

              // b) Target BSP % (Vs_targ% from log col 23)
              const tgtPts=upRows.filter(r=>r.vsTargPct>20&&r.vsTargPct<150)
                .map(r=>({x:r.tws,y:r.vsTargPct,twa:r.twa}));

              // c) Rudder angle (absolute) vs TWS
              const rudPts=upRows.filter(r=>r.rudder!=null&&Math.abs(r.rudder)<30&&Math.abs(r.rudder)>0.1)
                .map(r=>({x:r.tws,y:Math.abs(r.rudder),twa:r.twa}));

              // d) Heel angle (absolute) vs TWS
              const heelPts2=upRows.filter(r=>Math.abs(r.heel)>0.5&&Math.abs(r.heel)<60)
                .map(r=>({x:r.tws,y:Math.abs(r.heel),twa:r.twa}));

              const noData=<div style={{height:170,display:"flex",alignItems:"center",justifyContent:"center",color:"#334155",fontSize:10}}>No upwind data{!hasPhases?" — re-import event file":""}</div>;
              return(
                <>
                  <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
                    {hasPhases ? <>
                      <span style={{fontSize:9,color:"#8B5CF6",background:"#8B5CF610",border:"1px solid #8B5CF630",borderRadius:3,padding:"2px 7px"}}>
                        ▲ {upPhases.length} upwind phases · {upMin} min
                      </span>
                      <span style={{fontSize:9,color:"#7F77DD",background:"#7F77DD10",border:"1px solid #7F77DD30",borderRadius:3,padding:"2px 7px"}}>
                        ▽ {dnPhases.length} downwind · {dnMin} min
                      </span>
                      {rcPhases.length>0&&<span style={{fontSize:9,color:"#06B6D4",background:"#06B6D410",border:"1px solid #06B6D430",borderRadius:3,padding:"2px 7px"}}>
                        ↗ {rcPhases.length} reaching · {rcMin} min
                      </span>}
                      <span style={{fontSize:9,color:"#475569"}}>{upRows.length.toLocaleString()} upwind pts</span>
                    </> : (
                      <span style={{fontSize:9,color:"#F59E0B",background:"#F59E0B10",border:"1px solid #F59E0B30",borderRadius:3,padding:"2px 7px"}}>
                        ⚠ No event file — showing all rows unfiltered
                      </span>
                    )}
                    {!upPolar&&!logHasTarget&&<span style={{fontSize:9,color:"#F59E0B",marginLeft:4}}>⚠ Upload polar for VMG% — this log lacks target columns</span>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>a) VMG % OF POLAR OPTIMAL — vs TWS</div>
                      {vmgPts.length>5?<XYPlot points={vmgPts} xLabel="TWS (kn)" yLabel="VMG %" color="#22C55E" height={170} showTrend yLines={[100]}/>:noData}
                    </div>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>b) TARGET BSP % (Vs_targ%) — vs TWS</div>
                      {tgtPts.length>5?<XYPlot points={tgtPts} xLabel="TWS (kn)" yLabel="Target BSP %" color="#10B981" height={170} showTrend yLines={[100]}/>:noData}
                    </div>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>c) RUDDER ANGLE (|°|) — vs TWS</div>
                      {rudPts.length>5?<XYPlot points={rudPts} xLabel="TWS (kn)" yLabel="Rudder |°|" color="#FBBF24" height={170} showTrend/>:noData}
                    </div>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>d) HEEL ANGLE (|°|) — vs TWS</div>
                      {heelPts2.length>5?<XYPlot points={heelPts2} xLabel="TWS (kn)" yLabel="Heel |°|" color="#F97316" height={170} showTrend/>:noData}
                    </div>
                  </div>
                </>
              );
            })())}
            {canSeeAnalyticsData && section("Speed polar — TWA vs BSP by wind range",(
              <div style={{display:"flex",gap:16,alignItems:"flex-start"}}>
                <SpeedPolar rows={rows} width={280} height={280}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:"#475569",marginBottom:10}}>Each dot is one second of sailing. Radial distance = BSP, angle = TWA. Colour = wind band.</div>
                  {[["Upwind (30-60°)",30,60],["Beam (60-120°)",60,120],["Downwind (120-180°)",120,180]].map(([label,lo,hi])=>{
                    const zone=rows.filter(r=>Math.abs(r.twa)>=lo&&Math.abs(r.twa)<hi);
                    const avgBsp=zone.length?zone.reduce((s,r)=>s+r.bsp,0)/zone.length:0;
                    const avgTws=zone.length?zone.reduce((s,r)=>s+r.tws,0)/zone.length:0;
                    const pct=rows.length?(zone.length/rows.length*100):0;
                    return(<div key={label} style={{background:"#071624",borderRadius:6,padding:"8px 10px",marginBottom:6}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}><span style={{fontSize:10,color:"#94A3B8"}}>{label}</span><span style={{fontSize:9,color:"#475569"}}>{pct.toFixed(0)}% of session</span></div><div style={{display:"flex",gap:16}}><span style={{fontSize:11,fontFamily:"monospace",color:"#10B981"}}>BSP {R(avgBsp)} kn</span><span style={{fontSize:11,fontFamily:"monospace",color:"#7DD3FC"}}>TWS {R(avgTws)} kn</span><span style={{fontSize:11,fontFamily:"monospace",color:"#475569"}}>{zone.length.toLocaleString()} pts</span></div></div>);
                  })}
                </div>
              </div>
            ))}
            {canSeeAnalyticsData && xmlData?.tackJibes?.length>0&&section(`Manoeuvre analysis — ${xmlData.tackJibes.length} total`,(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div><div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>MANOEUVRES BY WIND STRENGTH</div><ManoeuvreChart tackJibes={xmlData.tackJibes} logRows={rows} width={360} height={130}/></div>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:10,letterSpacing:1}}>MANOEUVRE BREAKDOWN</div>
                  {[["Valid tacks",tacks,"#1D9E75"],["Valid gybes",gybes,"#7F77DD"],["Top mark roundings",topMarks,"#EF4444"],["Leeward gates",marks-topMarks,"#8B5CF6"],["Invalid / flagged",(xmlData.tackJibes.length-tacks-gybes),"#475569"]].map(([label,val,color])=>(<div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid #0F2030"}}><span style={{fontSize:11,color:"#94A3B8"}}>{label}</span><span style={{fontSize:13,fontWeight:700,fontFamily:"monospace",color}}>{val}</span></div>))}
                </div>
              </div>
            ))}

            {/* ── Tacking analysis ──────────────────────────────────────────────── */}
            {(()=>{
              const validTacks=(xmlData?.tackJibes||[]).filter(t=>t.isTack&&t.isValid!==false);
              if(!validTacks.length||!rows.length) return null;
              const PRE=30, POST=60; // seconds before/after tack

              // Build tack-aligned series: for each valid tack, extract a window of log rows
              // Returns [{relSec, value}] arrays — one per tack
              const buildSeries=(field,transform=(v)=>v)=>{
                return validTacks.map(tk=>{
                  // Binary-search nearest log row to tack UTC
                  let lo=0,hi=rows.length-1;
                  while(lo<hi){const mid=(lo+hi+1)>>1;if(rows[mid].utc<=tk.utc)lo=mid;else hi=mid-1;}
                  const centre=lo;
                  const window=[];
                  // Walk backwards PRE seconds
                  let i=centre;
                  while(i>=0&&(rows[centre].utc-rows[i].utc)<PRE*1000) i--;
                  i++;
                  // Walk forwards POST seconds
                  let j=centre;
                  while(j<rows.length&&(rows[j].utc-rows[centre].utc)<POST*1000) j++;
                  for(let k=i;k<j;k++){
                    const relSec=(rows[k].utc-tk.utc)/1000;
                    const v=transform(rows[k][field]);
                    if(v!=null&&!isNaN(v)) window.push({x:relSec,y:v});
                  }
                  return window;
                });
              };

              const tackPolar = loadPolarFromLS();
              const tackSeries={
                bsp:   buildSeries('bsp'),
                rudder:buildSeries('rudder',v=>v!=null?Math.abs(v):null),
                yawR:  buildSeries('yawR'),
                twa:   buildSeries('twa',v=>v!=null?Math.abs(v):null),
                vmgPct:buildSeries('vmg',v=>{
                  // placeholder — overwritten per-row below with polar context
                  return v;
                }),
              };
              // Rebuild vmgPct with polar context (needs tws per row, can't use buildSeries directly)
              tackSeries.vmgPct = validTacks.map(tk=>{
                let lo=0,hi=rows.length-1;
                while(lo<hi){const mid=(lo+hi+1)>>1;if(rows[mid].utc<=tk.utc)lo=mid;else hi=mid-1;}
                const centre=lo;
                const window=[];
                let i=centre; while(i>=0&&(rows[centre].utc-rows[i].utc)<PRE*1000) i--; i++;
                let j=centre; while(j<rows.length&&(rows[j].utc-rows[centre].utc)<POST*1000) j++;
                for(let k=i;k<j;k++){
                  const r=rows[k];
                  if(!tackPolar||!r.vmg||!r.tws) continue;
                  const tgt=polarVMGTarget(tackPolar,r.tws);
                  const optVMG=Math.abs(r.twa||0)<90?tgt.upVMG:tgt.downVMG;
                  if(!optVMG||optVMG<0.01) continue;
                  const pct=(r.vmg/optVMG)*100;
                  if(pct>10&&pct<200) window.push({x:(r.utc-tk.utc)/1000, y:pct});
                }
                return window;
              });

              // ── Cumulative VMG loss series ─────────────────────────────────────
              // Baseline VMG = mean of log rows from -60s to -20s before each tack.
              // Accumulated loss from t=-20s:
              //   cumLoss(t) = Σ (baseline_vmg − actual_vmg) × Δt  [knot·s]
              // Convert to boat lengths: cumLoss_m / boatLenM
              // Negative = boat briefly exceeded baseline (e.g. pumping into tack).
              // Positive = boat lost distance vs steady-state upwind sailing.
              const boatLenM = extractBoatLengthM(xmlData?.meta?.boat);
              const BASELINE_START=-60, BASELINE_END=-20;
              const LOSS_START=-20;

              const vmgLossSeries = validTacks.map(tk=>{
                // Binary-search tack centre
                let lo=0,hi=rows.length-1;
                while(lo<hi){const mid=(lo+hi+1)>>1;if(rows[mid].utc<=tk.utc)lo=mid;else hi=mid-1;}
                const centre=lo;

                // Walk back to BASELINE_START
                let bStart=centre;
                while(bStart>0&&(rows[centre].utc-rows[bStart].utc)<Math.abs(BASELINE_START)*1000) bStart--;
                // Walk back to BASELINE_END
                let bEnd=centre;
                while(bEnd>0&&(rows[centre].utc-rows[bEnd].utc)<Math.abs(BASELINE_END)*1000) bEnd--;

                // Baseline: mean VMG in [BASELINE_START, BASELINE_END]
                let bSum=0, bCount=0;
                for(let k=bStart;k<=bEnd;k++){
                  const v=rows[k].vmg;
                  if(v!=null&&!isNaN(v)&&v>0){bSum+=v;bCount++;}
                }
                if(!bCount) return []; // no baseline data → skip tack
                const baseVMG=bSum/bCount;

                // Walk to LOSS_START index
                let lStart=centre;
                while(lStart>0&&(rows[centre].utc-rows[lStart].utc)<Math.abs(LOSS_START)*1000) lStart--;

                // Walk to +POST seconds
                let lEnd=centre;
                while(lEnd<rows.length-1&&(rows[lEnd].utc-rows[centre].utc)<POST*1000) lEnd++;

                // Integrate (baseVMG - vmg) × dt from LOSS_START → POST
                let cumLossKnotSec=0;
                const pts=[{x:LOSS_START, y:0, baseVMG}];
                for(let k=lStart+1;k<=lEnd;k++){
                  const dt=(rows[k].utc-rows[k-1].utc)/1000; // seconds
                  if(dt<=0||dt>10) continue; // skip gaps > 10s
                  const vmg=rows[k].vmg??0;
                  cumLossKnotSec+=(baseVMG-vmg)*dt;
                  const cumLossBL=-(cumLossKnotSec*0.5144)/boatLenM; // negative = loss
                  const relSec=(rows[k].utc-tk.utc)/1000;
                  pts.push({x:relSec, y:cumLossBL, baseVMG});
                }
                // Final loss at +POST
                const finalBL=pts[pts.length-1]?.y??0;
                return Object.assign(pts, {baseVMG, finalBL});
              }).filter(s=>s.length>1);

              // TackChart — interactive linked chart
              // selectedTack: index of highlighted tack (null = all equal)
              // onTackClick(i): called when a tack line is clicked; null = deselect
              function TackChart({series,yLabel,color='#1D9E75',height=130,yLines=[],
                                  yMax:forcedYMax,yMin:forcedYMin,xMin:xMinProp,xMax:xMaxProp,
                                  selectedTack=null,onTackClick=null}){
                if(!series?.length||series.every(s=>!s.length)) return(
                  <div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#334155",fontSize:10}}>No data</div>
                );
                const VB_W=400;
                const pad={t:10,r:8,b:28,l:42};
                const W=VB_W-pad.l-pad.r, H=height-pad.t-pad.b;
                const xMin=xMinProp??-PRE, xMax=xMaxProp??POST;
                const allPts=series.flat();
                const rawYMin=Math.min(...allPts.map(p=>p.y));
                const rawYMax=Math.max(...allPts.map(p=>p.y))||1;
                const yMin=forcedYMin!==undefined?forcedYMin:Math.min(0,rawYMin);
                const yMax=forcedYMax!==undefined?forcedYMax:Math.max(0,rawYMax)||1;
                const ySpan=yMax-yMin||1;
                const px=x=>pad.l+((x-xMin)/(xMax-xMin))*W;
                const py=y=>pad.t+H-((y-yMin)/ySpan)*H;
                const xTicks=[-60,-50,-40,-30,-20,-10,0,10,20,30,40,50,60].filter(x=>x>=xMin&&x<=xMax);
                const yRange=yMax-yMin;
                const yStep=yRange>20?5:yRange>8?2:yRange>4?1:yRange>1?0.5:0.2;
                const yTickMin=Math.ceil(yMin/yStep)*yStep;
                const yTicks=Array.from({length:Math.ceil((yMax-yTickMin)/yStep)+1},(_,i)=>yTickMin+i*yStep).filter(y=>y>=yMin&&y<=yMax);
                const hasSelection=selectedTack!=null;

                // Render order: unselected first, selected on top
                const renderOrder=[...series.keys()].filter(i=>i!==selectedTack);
                if(selectedTack!=null&&selectedTack<series.length) renderOrder.push(selectedTack);

                return(
                  <svg width="100%" viewBox={`0 0 ${VB_W} ${height}`} style={{overflow:"visible",display:"block",cursor:onTackClick?"pointer":"default"}}>
                    {/* Grid */}
                    {yTicks.map((y,i)=><line key={i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke={y===0?"#1E3A5A":"#0F2030"} strokeWidth={y===0?1.5:1}/>)}
                    {yLines.map((y,i)=><line key={'yl'+i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke={color} strokeWidth="0.5" strokeDasharray="4,3" opacity="0.6"/>)}
                    <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
                    <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
                    {/* Tack moment line */}
                    <line x1={px(0)} x2={px(0)} y1={pad.t} y2={pad.t+H} stroke="#EF4444" strokeWidth="1.5" strokeDasharray="4,2" opacity="0.8"/>
                    <text x={px(0)+3} y={pad.t+9} fontSize="8" fill="#EF4444">tack</text>
                    {xMin<=-20&&<line x1={px(-20)} x2={px(-20)} y1={pad.t} y2={pad.t+H} stroke="#475569" strokeWidth="0.8" strokeDasharray="3,3" opacity="0.5"/>}

                    {/* Lines rendered in order (selected last = on top) */}
                    {renderOrder.map(ti=>{
                      const pts=series[ti];
                      if(!pts||pts.length<2) return null;
                      const isSel=ti===selectedTack;
                      const c=TACK_COLORS[ti%TACK_COLORS.length];
                      const opacity=hasSelection?(isSel?1:0.15):0.75;
                      const sw=isSel?2.5:1.2;
                      const d=pts.map((p,i)=>`${i===0?'M':'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
                      return(
                        <g key={ti}>
                          {/* Visible line */}
                          <path d={d} fill="none" stroke={c} strokeWidth={sw} strokeLinejoin="round" opacity={opacity}/>
                          {/* Dot at endpoint for the loss chart (xMin=LOSS_START) */}
                          {xMin===LOSS_START&&pts.length>0&&(()=>{
                            const last=pts[pts.length-1];
                            return<circle cx={px(last.x)} cy={py(last.y)} r={isSel?5:3} fill={c} opacity={hasSelection?(isSel?1:0.2):0.8}/>;
                          })()}
                          {/* Invisible wide hit-zone for easy clicking */}
                          {onTackClick&&<path d={d} fill="none" stroke="transparent" strokeWidth="14"
                            style={{cursor:"pointer"}}
                            onClick={()=>onTackClick(isSel?null:ti)}/>}
                        </g>
                      );
                    })}

                    {/* Axes */}
                    {yTicks.map((y,i)=><text key={i} x={pad.l-4} y={py(y)+3} textAnchor="end" fontSize="8" fill={y===0?"#94A3B8":"#475569"}>{Number.isInteger(y)?y:y.toFixed(1)}</text>)}
                    {xTicks.map((x,i)=><text key={i} x={px(x)} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill={x===0?"#EF4444":"#475569"}>{x}s</text>)}
                    {yLabel&&<text x={8} y={pad.t+H/2} textAnchor="middle" fontSize="8" fill="#475569" transform={`rotate(-90,8,${pad.t+H/2})`}>{yLabel}</text>}
                  </svg>
                );
              }

              return canSeeAnalyticsData && section(`Tacking analysis — ${validTacks.length} valid tacks  (−${PRE}s → +${POST}s)`,(
                <>
                  <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap",alignItems:"center"}}>
                    {validTacks.map((tk,i)=>(
                      <span key={i}
                        onClick={()=>setSelectedTackIdx(selectedTackIdx===i?null:i)}
                        style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:9,fontFamily:"monospace",
                          color:TACK_COLORS[i%TACK_COLORS.length],cursor:"pointer",
                          padding:"2px 6px",borderRadius:4,
                          background:selectedTackIdx===i?`${TACK_COLORS[i%TACK_COLORS.length]}25`:"transparent",
                          border:`1px solid ${selectedTackIdx===i?TACK_COLORS[i%TACK_COLORS.length]:"transparent"}`}}>
                        <span style={{display:"inline-block",width:10,height:3,background:TACK_COLORS[i%TACK_COLORS.length],borderRadius:1}}/>
                        T{i+1} {hmLocal(tk.utc,tz)}
                      </span>
                    ))}
                    {selectedTackIdx!=null&&(
                      <button onClick={()=>setSelectedTackIdx(null)}
                        style={{background:"none",border:"1px solid #1E3A5A",borderRadius:4,padding:"2px 8px",color:"#475569",cursor:"pointer",fontSize:9}}>
                        ✕ clear
                      </button>
                    )}
                    <span style={{fontSize:9,color:"#334155",marginLeft:4}}>Click line or legend to highlight · Red = tack moment</span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>a) BOAT SPEED (BSP kn)</div>
                      <TackChart series={tackSeries.bsp} yLabel="BSP kn" color="#10B981" height={130}
                        selectedTack={selectedTackIdx} onTackClick={setSelectedTackIdx}/>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>b) RUDDER ANGLE (|°|)</div>
                      <TackChart series={tackSeries.rudder} yLabel="Rudder |°|" color="#FBBF24" height={130}
                        selectedTack={selectedTackIdx} onTackClick={setSelectedTackIdx}/>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>c) RATE OF TURN (°/s  YawR)</div>
                      <TackChart series={tackSeries.yawR} yLabel="YawR °/s" color="#8B5CF6" height={130}
                        selectedTack={selectedTackIdx} onTackClick={setSelectedTackIdx}/>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>d) TRUE WIND ANGLE (|°|)</div>
                      <TackChart series={tackSeries.twa} yLabel="TWA |°|" color="#7DD3FC" height={130}
                        selectedTack={selectedTackIdx} onTackClick={setSelectedTackIdx}/>
                    </div>
                    {tackPolar&&tackSeries.vmgPct.some(s=>s.length>1)&&(
                      <div style={{gridColumn:"1/-1"}}>
                        <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>e) POLAR VMG % — relative to tack moment</div>
                        <TackChart series={tackSeries.vmgPct} yLabel="VMG %" color="#22C55E" height={130}
                          yLines={[100]} yMin={0}
                          selectedTack={selectedTackIdx} onTackClick={setSelectedTackIdx}/>
                      </div>
                    )}
                    {!tackPolar&&<div style={{gridColumn:"1/-1",fontSize:9,color:"#475569",padding:"8px 0"}}>
                      ⚠ Upload polar file to enable VMG % chart
                    </div>}
                  </div>

                  {/* ── Cumulative VMG loss ──────────────────────────────────────── */}
                  {vmgLossSeries.length>0&&<>
                    <div style={{height:1,background:"#0F2030",margin:"16px 0 12px"}}/>
                    <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>
                      e) ACCUMULATED VMG LOSS (boat lengths) — baseline: avg VMG {BASELINE_START}s → {BASELINE_END}s before tack
                    </div>
                    <div style={{fontSize:9,color:"#334155",marginBottom:8}}>
                      Negative = lost distance vs baseline upwind VMG · Positive = briefly faster than baseline ·
                      Final value at +{POST}s = total tack cost (boat lengths below zero)
                    </div>
                    <TackChart
                      series={vmgLossSeries}
                      yLabel="BL loss"
                      color="#EF4444"
                      height={160}
                      xMin={LOSS_START}
                      xMax={POST}
                      yLines={[0]}
                      selectedTack={selectedTackIdx}
                      onTackClick={setSelectedTackIdx}
                    />
                    {/* Summary table */}
                    <div style={{marginTop:12,overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                        <thead>
                          <tr style={{color:"#475569",letterSpacing:1}}>
                            <th style={{textAlign:"left",padding:"4px 8px",borderBottom:"1px solid #1E3A5A",fontWeight:600,fontSize:9}}>TACK</th>
                            <th style={{textAlign:"right",padding:"4px 8px",borderBottom:"1px solid #1E3A5A",fontWeight:600,fontSize:9}}>TIME (UTC)</th>
                            <th style={{textAlign:"right",padding:"4px 8px",borderBottom:"1px solid #1E3A5A",fontWeight:600,fontSize:9}}>BASELINE VMG</th>
                            <th style={{textAlign:"right",padding:"4px 8px",borderBottom:"1px solid #1E3A5A",fontWeight:600,fontSize:9}}>LOSS (BL)</th>
                            <th style={{textAlign:"right",padding:"4px 8px",borderBottom:"1px solid #1E3A5A",fontWeight:600,fontSize:9}}>RATING</th>
                          </tr>
                        </thead>
                        <tbody>
                          {vmgLossSeries.map((pts,i)=>{
                            const finalBL=pts[pts.length-1]?.y??0;
                            const lossBL=Math.abs(finalBL);
                            const baseVMG=pts[0]?.baseVMG??0;
                            const color=TACK_COLORS[i%TACK_COLORS.length];
                            const rating=lossBL<3?"★★★ excellent":lossBL<5?"★★ good":lossBL<8?"★ average":"slow";
                            const rColor=lossBL<3?"#10B981":lossBL<5?"#22C55E":lossBL<8?"#F59E0B":"#EF4444";
                            const tk=validTacks[i];
                            const isSel=selectedTackIdx===i;
                            return(
                              <tr key={i}
                                onClick={()=>setSelectedTackIdx(isSel?null:i)}
                                style={{borderBottom:"1px solid #0F2030",cursor:"pointer",
                                  background:isSel?`${color}15`:"transparent",
                                  outline:isSel?`1px solid ${color}40`:"none"}}>
                                <td style={{padding:"5px 8px",color}}>
                                  <span style={{display:"inline-block",width:10,height:3,background:color,borderRadius:1,marginRight:6,verticalAlign:"middle"}}/>
                                  T{i+1}
                                </td>
                                <td style={{padding:"5px 8px",textAlign:"right",color:"#94A3B8",fontFamily:"monospace"}}>
                                  {tk?hmLocal(tk.utc,tz):"--"}
                                </td>
                                <td style={{padding:"5px 8px",textAlign:"right",color:"#06B6D4",fontFamily:"monospace"}}>
                                  {R(baseVMG)} kn
                                </td>
                                <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontWeight:700,color:rColor}}>
                                  {lossBL.toFixed(1)} BL
                                </td>
                                <td style={{padding:"5px 8px",textAlign:"right",color:rColor,fontSize:9}}>
                                  {rating}
                                </td>
                              </tr>
                            );
                          })}
                          {vmgLossSeries.length>1&&(()=>{
                            const avg=vmgLossSeries.reduce((s,pts)=>s+Math.abs(pts[pts.length-1]?.y??0),0)/vmgLossSeries.length;
                            const rColor=avg<3?"#10B981":avg<5?"#22C55E":avg<8?"#F59E0B":"#EF4444";
                            return(
                              <tr style={{borderTop:"2px solid #1E3A5A",background:"#071624"}}>
                                <td colSpan={3} style={{padding:"5px 8px",color:"#64748B",fontSize:9,letterSpacing:1}}>SESSION AVERAGE</td>
                                <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontWeight:700,color:rColor,fontSize:12}}>{avg.toFixed(1)} BL</td>
                                <td style={{padding:"5px 8px",textAlign:"right",color:rColor,fontSize:9}}>{avg<3?"★★★":avg<5?"★★":avg<8?"★":""}</td>
                              </tr>
                            );
                          })()}
                        </tbody>
                      </table>
                    </div>
                  </>}
                </>
              ));
            })()}
            {canSeeAnalyticsData && allVideos.filter(v=>v.twsAvg!=null).length>0&&section("Clips with instrument data",(
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {allVideos.filter(v=>v.twsAvg!=null).map(v=>(
                  <div key={v.id} onClick={()=>{onSelectVideo(v);setActiveTab("library");}} style={{display:"flex",alignItems:"center",gap:10,background:"#071624",borderRadius:6,padding:"7px 10px",cursor:"pointer",border:"1px solid #1E3A5A"}}>
                    <div style={{fontSize:10,color:"#E2E8F0",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.title}</div>
                    {[["TWS",v.twsAvg,"kt","#7DD3FC"],["TWA",v.twaAvg,"°","#7DD3FC"],["VMG",v.vmgAvg,"kt","#22C55E"],["Pol",v.polpercAvg,"%",v.polpercAvg==null?"#22C55E":v.polpercAvg>=110?"#166534":v.polpercAvg>=90?"#22C55E":"#EF4444"],["Tgt",v.vsTargPercAvg,"%",v.vsTargPercAvg==null?"#22C55E":v.vsTargPercAvg>=110?"#166534":v.vsTargPercAvg>=90?"#22C55E":"#EF4444"]].map(([l,val,u,c])=>(<div key={l} style={{textAlign:"center",minWidth:42}}><div style={{fontSize:8,color:"#334155"}}>{l}</div><div style={{fontSize:11,fontWeight:700,color:c,fontFamily:"monospace"}}>{val!=null?R(val):"--"}{u}</div></div>))}
                    <div style={{fontSize:9,color:"#334155"}}>→</div>
                  </div>
                ))}
              </div>
            ))}
            {canUseAI && <AIChatPanel rows={rows} allVideos={allVideos}/>}
          </>
        )}
      </div>
    </div>
  );
}

// ─── SHARE BUTTON ─────────────────────────────────────────────────────────────
// Mints a PUBLIC link to this one clip + its overlay. No login for the viewer, so the
// token is the whole authorisation: it expires, and it can be revoked. TL3+ only —
// sharing puts footage and instrument data on the open internet, so it sits with the
// same senior roles that can rotate clips and edit Boat Config.
function ShareButton({ video, canShare }){
  const [open,setOpen]     = useState(false);
  const [busy,setBusy]     = useState(false);
  const [shares,setShares] = useState(null);
  const [err,setErr]       = useState(null);
  const [days,setDays]     = useState(14);
  const [withData,setWithData] = useState(true);

  // The share is against the CLOUD row — a clip that hasn't synced can't be shared,
  // because the viewer streams it from Bunny.
  const cloudId = video.cloudId || (isCloudVideoId(video.id) ? video.id : null);
  const shareable = !!cloudId && (video.hasProxy || video.hasOriginal);

  const load = useCallback(async ()=>{
    if(!cloudId) return;
    try{
      const r = await fetch(`/api/videos/${encodeURIComponent(cloudId)}/share`).then(x=>x.json());
      setShares(r.shares||[]);
    }catch{ setShares([]); }
  },[cloudId]);
  useEffect(()=>{ if(open) load(); },[open,load]);

  const mint = async ()=>{
    setBusy(true); setErr(null);
    try{
      const res = await fetch(`/api/videos/${encodeURIComponent(cloudId)}/share`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ days, includeOverlay: withData }),
      });
      const j = await res.json().catch(()=>({}));
      if(!res.ok){ setErr(j.error || `failed (HTTP ${res.status})`); return; }
      const url = `${window.location.origin}/share/${j.share.token}`;
      try{ await navigator.clipboard?.writeText(url); }catch{}
      await load();
    } finally { setBusy(false); }
  };

  const revoke = async (id)=>{
    if(!confirm('Revoke this link? Anyone holding it loses access immediately.')) return;
    await fetch(`/api/videos/${encodeURIComponent(cloudId)}/share?id=${id}`,{method:'DELETE'}).catch(()=>{});
    load();
  };

  if(!canShare) return null;

  if(!shareable) return (
    <div style={{background:"#071624",border:"1px solid #1E3A5A",borderRadius:7,padding:"8px 10px",marginTop:14,fontSize:10,color:"#475569"}}>
      Upload this clip to the cloud before sharing — the viewer streams it from there.
    </div>
  );

  const live = (shares||[]).filter(sh=>!sh.revoked_at && new Date(sh.expires_at) > new Date());

  return (
    <div style={{marginTop:14}}>
      {!open ? (
        <button onClick={()=>setOpen(true)}
          style={{width:"100%",background:"none",border:"1px solid #06B6D440",borderRadius:7,padding:"8px 0",color:"#06B6D4",cursor:"pointer",fontSize:11,fontWeight:600}}>
          🔗 Share a link{live.length?` (${live.length} active)`:""}
        </button>
      ) : (
        <div style={{background:"#0A1929",border:"1px solid #06B6D440",borderRadius:7,padding:"11px 12px"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#06B6D4",marginBottom:7}}>Share this clip</div>
          <div style={{fontSize:10,color:"#64748B",lineHeight:1.5,marginBottom:9}}>
            Anyone with the link can watch this one clip — no login. Nothing else about the
            session, boat or team is reachable from it.
          </div>
          <label style={{display:"flex",alignItems:"center",gap:7,fontSize:11,color:"#94A3B8",marginBottom:7,cursor:"pointer"}}>
            <input type="checkbox" checked={withData} onChange={e=>setWithData(e.target.checked)}/>
            include the instrument overlay
          </label>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:9}}>
            <span style={{fontSize:11,color:"#94A3B8"}}>expires in</span>
            <select value={days} onChange={e=>setDays(Number(e.target.value))}
              style={{background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,color:"#E2E8F0",fontSize:11,padding:"3px 6px"}}>
              <option value={1}>1 day</option><option value={7}>7 days</option>
              <option value={14}>14 days</option><option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
          {err && <div style={{fontSize:10,color:"#EF4444",marginBottom:7}}>{err}</div>}
          <div style={{display:"flex",gap:6}}>
            <button onClick={mint} disabled={busy}
              style={{flex:1,background:"#06B6D4",border:"none",borderRadius:6,padding:"7px 0",color:"#000",fontWeight:700,fontSize:11,cursor:busy?"default":"pointer"}}>
              {busy?"Creating…":"Create link + copy"}
            </button>
            <button onClick={()=>setOpen(false)}
              style={{background:"none",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 12px",color:"#64748B",fontSize:11,cursor:"pointer"}}>Close</button>
          </div>

          {live.length>0 && (
            <div style={{marginTop:10,borderTop:"1px solid #1E3A5A",paddingTop:8}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:1,marginBottom:5}}>ACTIVE LINKS</div>
              {live.map(sh=>(
                <div key={sh.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                  <button onClick={()=>{try{navigator.clipboard?.writeText(`${window.location.origin}/share/${sh.token}`);}catch{}}}
                    style={{flex:1,textAlign:"left",background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"4px 7px",color:"#7DD3FC",fontSize:9,fontFamily:"monospace",cursor:"pointer",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    /share/{String(sh.token).slice(0,12)}… · {sh.view_count} view{sh.view_count===1?"":"s"} · to {new Date(sh.expires_at).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}
                  </button>
                  <button onClick={()=>revoke(sh.id)} title="Revoke"
                    style={{background:"none",border:"1px solid #EF444440",borderRadius:5,color:"#EF4444",fontSize:9,padding:"4px 7px",cursor:"pointer"}}>Revoke</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DELETE BUTTON ────────────────────────────────────────────────────────────
function DeleteButton({video, cloudStatus, onDeleted}){
  const[armed,  setArmed]   = useState(false);
  const[deleting,setDeleting]= useState(false);
  const[status, setStatus]  = useState(null);
  const hasStream = !!video.streamId;
  const isLocal   = !video.source || video.source === "local";
  const execute = async (deleteCloud) => {
    setDeleting(true); setStatus("Deleting…");
    try {
      if (deleteCloud && hasStream) { setStatus("Removing from Bunny Stream…"); const ok = await deleteStreamVideo(video.streamId); if (!ok) { setStatus("⚠ Stream delete failed — removing locally only"); await new Promise(r => setTimeout(r, 1500)); } }
      // The Supabase row MUST go too. Without this the clip is gone from IDB and
      // from Bunny, but the orphan row merges back in on the next load as a
      // phantom cloud-only entry — the clip "comes back from the dead".
      if (deleteCloud) {
        setStatus("Removing cloud row…");
        try {
          const supabase = getBrowserSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (user) await deleteVideosCloud({ userId: user.id, id: video.cloudId || video.id });
        } catch {}
      }
      if (isLocal) { await deleteVideo(video.id); }
      setStatus("✓ Deleted");
      await new Promise(r => setTimeout(r, 600));
      onDeleted(video.id);
    } catch(e) { setStatus(`Error: ${e.message}`); setDeleting(false); }
  };
  if (deleting) return(<div style={{background:"#071624",borderRadius:7,padding:"10px 12px",marginTop:14,border:"1px solid #EF444430",fontSize:11,color:"#EF4444",textAlign:"center"}}>{status}</div>);
  if (!armed) return(<button onClick={()=>setArmed(true)} style={{width:"100%",marginTop:14,background:"none",border:"1px solid #EF444430",borderRadius:7,padding:"8px 0",color:"#EF4444",cursor:"pointer",fontSize:11,opacity:0.6}}>🗑 Delete clip</button>);
  return(
    <div style={{background:"#0A1929",border:"1px solid #EF444440",borderRadius:7,padding:"12px 14px",marginTop:14}}>
      <div style={{fontSize:11,color:"#EF4444",fontWeight:600,marginBottom:4}}>Delete "{video.title}"?</div>
      <div style={{fontSize:10,color:"#475569",marginBottom:12}}>{isLocal && "Removes video blob from your browser (IndexedDB). "}{hasStream && "Choose whether to also remove from Bunny Stream. "}{!isLocal && !hasStream && "This is a cloud-only entry — no local blob to remove."}</div>
      <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
        {isLocal && hasStream && cloudStatus?.available && (<button onClick={()=>execute(true)} style={{flex:1,background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"7px 0",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:600}}>Delete local + cloud</button>)}
        <button onClick={()=>execute(false)} style={{flex:1,background:"#1E3A5A",border:"1px solid #2D4A6A",borderRadius:6,padding:"7px 0",color:"#94A3B8",cursor:"pointer",fontSize:11}}>{hasStream && cloudStatus?.available ? "Local only" : "Confirm delete"}</button>
        <button onClick={()=>setArmed(false)} style={{background:"none",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 10px",color:"#475569",cursor:"pointer",fontSize:11}}>Cancel</button>
      </div>
    </div>
  );
}


// ─── MOBILE SHELL ─────────────────────────────────────────────────────────────
// Receives the exact same props/state as the desktop shell but renders a
// phone-optimised layout:
//   • Sticky top bar  (logo + connection dot)
//   • Full-height content area  (swipeable between panes)
//   • Fixed bottom tab bar  (Library · Analytics · Upload · Admin)
//   • Progressive load flag — on mobile, boot() only loads today + thumbnails;
//     full log/event data loads lazily when Analytics tab is opened.

function MobileLibrary({allVideos,sessions,activeDate,selectedVideo,setSelectedVideo,
                        logData,xmlData,loadDate,syncOffsets,setSyncOffsets,
                        saveSyncForVideos,saveTagsForVideo,
                        sessionTzOffset,searchQuery,setSearchQuery,sortBy,setSortBy,
                        selectedTags,setSelectedTags,toggleTag,allTags,isManTag,displayed,perms,
                        onSyncProxies,onUploadOriginals,mobileSyncState,syncErrors,onRotateVideo,
                        setActiveTab,cloudStatus,updateVideoTagsFn,
                        computeAutoTagsFn,sessionTagList,setSessionTagList,tagSuggestionList,
                        handlePlayUtc,onDeleted,role,effectiveRole,
                        onThumbLoad,videoThumbsLoading,videoLoadedIds,videoTotalThumbs}){
  const [view, setView]   = React.useState("clips"); // "clips" | "player" | "sessions"
  const video = selectedVideo;
  const fmtDate_ = d=>{if(!d)return"";const p=d.split("-");return p.length===3?`${p[2]}/${p[1]}`:d;};

  if(view==="sessions") return(
    <div style={{flex:1,overflowY:"auto",background:"#030F1A"}}>
      <div style={{padding:"12px 14px 6px",display:"flex",alignItems:"center",gap:10}}>
        <button onClick={()=>setView("clips")} style={{background:"none",border:"none",color:"#06B6D4",fontSize:18,cursor:"pointer",padding:"4px 8px 4px 0"}}>←</button>
        <span style={{fontSize:14,fontWeight:700,color:"#E2E8F0"}}>Sessions</span>
      </div>
      {(()=>{
        // Day-N within each regatta (same logic as desktop sidebar).
        const evMap=new Map(); const g=new Map();
        for(const s of sessions){ if(s.event){ if(!g.has(s.event)) g.set(s.event,[]); g.get(s.event).push(s.date); } }
        for(const [ev,ds] of g){ ds.slice().sort().forEach((d,i)=>evMap.set(d,{event:ev,dayN:i+1})); }
        return sessions.filter(s=>(s.videoCount||0)>0 && s.date<=TODAY()).map(s=>{
          const isActive=activeDate===s.date;
          const isLocal=!(s.cloudSynced||s.source==="cloud"||s.source==="supabase");
          const ev=evMap.get(s.date);
          return(
          <div key={s.date} onClick={()=>{loadDate(s.date);setView("clips");}}
            style={{padding:"14px 16px",borderBottom:"1px solid #0F2030",
              background:isActive?"#0F2A45":"transparent",display:"flex",alignItems:"center",gap:12}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:14,color:isActive?"#06B6D4":"#E2E8F0",fontWeight:600}}>
                {s.date===TODAY()?"Today":fmtDate_(s.date)}
              </div>
              {ev&&<div style={{fontSize:11,color:"#EF4444",fontWeight:700,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>🏁 {ev.event} Day {ev.dayN}</div>}
              <div style={{fontSize:12,color:"#475569",marginTop:2}}>
                {s.videoCount||0} clips{s.hasLog?" · log":""}{s.hasXml?" · events":""}
                {s.location?` · ${s.location}`:""}
              </div>
            </div>
            <SrcBadge source={isLocal?"local":"cloud"}/>
            {isActive&&<span style={{color:"#06B6D4",fontSize:18}}>✓</span>}
          </div>
          );
        });
      })()}
    </div>
  );

  if(view==="player"&&video) return(
    <div style={{flex:1,overflowY:"auto",background:"#030F1A"}}>
      <div style={{display:"flex",alignItems:"center",padding:"10px 14px 6px",gap:10}}>
        <button onClick={()=>setView("clips")} style={{background:"none",border:"none",color:"#06B6D4",fontSize:18,cursor:"pointer",padding:"4px 8px 4px 0"}}>←</button>
        <span title={video.title||""} style={{fontSize:13,fontWeight:600,color:"#E2E8F0",flex:1,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{(()=>{
          if(video.startUtc==null) return "—";
          const d=new Date(video.startUtc + (sessionTzOffset||0)*60000);
          return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
        })()}</span>
      </div>
      <VideoPlayer video={video} logData={logData} xmlData={xmlData}
        syncOffset={syncOffsets[video.id]||0} sessionTzOffset={sessionTzOffset}
        onPlayUtc={handlePlayUtc}
        onRotate={onRotateVideo ? (deg)=>onRotateVideo(video, deg) : null}
        canPlayLocalHD={['admin','coach'].includes(effectiveRole)}/>
      <div style={{padding:"12px 16px"}}>
        {/* Sync offset — coach + admin only. Gate on effectiveRole (the real
            membership role); perms.canSync follows the legacy `role` selector
            which defaults to "coach", so it leaked this card to TL1/TL2. */}
        {['admin','coach'].includes(effectiveRole) && (
        <div style={{marginBottom:12}}>
          <SyncControl offset={syncOffsets[video.id]||0}
            onChange={v=>{saveSyncOffset(video.id,v);setSyncOffsets(p=>({...p,[video.id]:v}));}}
            onSave={async(secs)=>{ await saveSyncForVideos([video], secs); }}/>
        </div>
        )}
        {/* Tags — admin / coach / TL2 only */}
        {['admin','coach','tl2'].includes(effectiveRole)&&<TagEditor video={video} tagList={sessionTagList} suggestionList={tagSuggestionList} sessionDate={activeDate}
          onTagListChange={async t=>{
            setSessionTagList(t);
            try {
              const supabase=getBrowserSupabase();
              const {data:{user}}=await supabase.auth.getUser();
              if(user) await saveTagListCloud({userId:user.id,date:activeDate,tags:t});
              else saveTagList(activeDate,t);
            } catch { saveTagList(activeDate,t); }
          }}
          onSave={async (id,tags)=>{ const vid=allVideos.find(v=>v.id===id)||video; await saveTagsForVideo(vid, tags); }}/>}
      </div>
    </div>
  );

  // Default: clip grid view
  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:"#030F1A"}}>
      {/* Session selector row */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px 8px",borderBottom:"1px solid #0F2030",flexShrink:0}}>
        <button onClick={()=>setView("sessions")}
          style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,
            padding:"6px 12px",color:"#06B6D4",fontSize:12,cursor:"pointer",fontWeight:600}}>
          {activeDate===TODAY()?"Today":fmtDate_(activeDate)} ▾
        </button>
        <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
          placeholder="Search…"
          style={{flex:1,background:"#071624",border:"1px solid #1E3A5A",borderRadius:6,
            padding:"8px 10px",color:"#E2E8F0",fontSize:14,outline:"none"}}/>
        {selectedTags.length>0&&<button onClick={()=>setSelectedTags([])}
          style={{background:"none",border:"1px solid #EF444440",borderRadius:5,padding:"6px 8px",
            color:"#EF4444",fontSize:12,cursor:"pointer"}}>✕</button>}
      </div>
      {/* ── Cloud upload — mobile ────────────────────────────────────────────
          The desktop Videos tab has had BatchSyncPanel ("Sync proxies" /
          "Upload originals") all along; mobile had NO upload control at all, so a
          crew member (TL3) who shot the footage on their phone had no way to get it
          off the device — it sat local forever and no coach ever saw it.
          Gated on canImport, not canSync: if you're trusted to import footage you're
          trusted to push the footage you imported. Hidden when there's nothing on
          this device to upload (cloud-only clips have no blob to send). */}
      {perms.canImport && cloudStatus?.available && allVideos.some(v=>v.hasLocalBlob) && (
        <div style={{padding:"8px 14px",borderBottom:"1px solid #0F2030",flexShrink:0}}>
          <BatchSyncPanel
            videos={allVideos}
            syncState={mobileSyncState}
            onSyncProxies={onSyncProxies}
            onUploadOriginals={onUploadOriginals}
            syncErrors={syncErrors}
          />
        </div>
      )}
      {/* Tag filter pills */}
      {allTags.filter(isManTag).length>0&&(
        <div style={{display:"flex",gap:6,padding:"6px 14px",overflowX:"auto",flexShrink:0,borderBottom:"1px solid #0F2030"}}>
          {allTags.filter(isManTag).map(t=>(
            <button key={t} onClick={()=>toggleTag(t)}
              style={{background:selectedTags.includes(t)?"#06B6D4":"#0A1929",
                border:`1px solid ${selectedTags.includes(t)?"#06B6D4":"#1E3A5A"}`,
                borderRadius:16,padding:"5px 12px",color:selectedTags.includes(t)?"#000":"#7DD3FC",
                fontSize:12,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
              {t}
            </button>
          ))}
        </div>
      )}
      {/* Clip grid */}
      <div style={{flex:1,overflowY:"auto",padding:"10px 10px"}}>
        {(() => {
          const loadedCount = Math.min(videoLoadedIds?.size || 0, videoTotalThumbs || 0);
          const isLoading = videoThumbsLoading || ((videoTotalThumbs||0) > 0 && loadedCount < videoTotalThumbs);
          if(!isLoading) return null;
          const pct = (videoTotalThumbs||0) > 0 ? Math.round((loadedCount/videoTotalThumbs)*100) : 0;
          return (
            <div style={{background:"#06B6D410",border:"1px solid #06B6D430",borderRadius:6,padding:"7px 10px",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:10,color:"#06B6D4",fontFamily:"monospace",marginBottom:5}}>
                <span>⟳ Loading thumbnails…</span>
                <span>{videoThumbsLoading ? "…" : `${loadedCount} / ${videoTotalThumbs}`}</span>
              </div>
              <div style={{height:4,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
                <div style={{height:"100%",width: videoThumbsLoading ? "15%" : `${pct}%`,background:"#06B6D4",transition:"width 0.2s ease-out",animation: videoThumbsLoading ? "ssa-thumb-pulse 1.2s ease-in-out infinite" : "none"}}/>
              </div>
              <style>{`@keyframes ssa-thumb-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }`}</style>
            </div>
          );
        })()}
        {displayed.length===0&&(
          <div style={{textAlign:"center",padding:"60px 20px",color:"#334155"}}>
            <div style={{fontSize:40,marginBottom:12,opacity:0.3}}>📹</div>
            <div style={{fontSize:14,color:"#475569"}}>No clips for this session</div>
          </div>
        )}
        {(()=>{
          const groups=[], seen=new Map();
          for(const v of displayed){const d=v.sessionDate||"unknown";if(!seen.has(d)){seen.set(d,[]);groups.push(d);}seen.get(d).push(v);}
          return groups.map(date=>{
            const vids=seen.get(date);
            return(
              <div key={date} style={{marginBottom:20}}>
                <div style={{fontSize:12,fontWeight:700,color:"#475569",marginBottom:8,padding:"0 4px"}}>
                  {date===TODAY()?"Today":fmtDate_(date)} · {vids.length} clip{vids.length!==1?"s":""}
                </div>
                {/* Mobile: single column list with horizontal thumb */}
                {vids.map(v=>(
                  <div key={v.id} onClick={()=>{setSelectedVideo(v);setView("player");}}
                    style={{display:"flex",gap:10,background:selectedVideo?.id===v.id?"#0F2A45":"#0A1929",
                      border:`1px solid ${selectedVideo?.id===v.id?"#06B6D4":"#1E3A5A"}`,
                      borderRadius:10,overflow:"hidden",marginBottom:8,cursor:"pointer",
                      minHeight:64,alignItems:"stretch"}}>
                    {/* Thumbnail — FIXED 96×64 box. Earlier versions sized the
                        box via flex align-items:stretch and the image via
                        height:100% / inset:0 — both depend on the parent
                        having a "definite" height, which is unreliable across
                        mobile browsers and left thumbnails blank in portrait.
                        Explicit width+height removes every such dependency. */}
                    <div style={{width:96,height:64,flexShrink:0,alignSelf:"center",background:"#071624",position:"relative",overflow:"hidden"}}>
                      {v.thumbnailUrl
                        ? <img src={v.thumbnailUrl} alt=""
                            /* loading=eager + fetchpriority=high stop the
                               browser parking below-the-fold thumbnails at
                               Low priority — on weak wifi those requests
                               otherwise never start and the loader hangs
                               (e.g. 6/10) until a rotation re-prioritises. */
                            loading="eager" fetchpriority="high" decoding="async"
                            onLoad={()=>onThumbLoad?.(v.id)}
                            onError={()=>onThumbLoad?.(v.id)}
                            style={{display:"block",width:"100%",height:"100%",objectFit:"cover",pointerEvents:"none"}}/>
                        : v.objectUrl&&v.source!=="cloud"&&!String(v.objectUrl).includes(".m3u8")
                          ? <video src={v.objectUrl}
                              onLoadedData={()=>onThumbLoad?.(v.id)}
                              onError={()=>onThumbLoad?.(v.id)}
                              style={{display:"block",width:"100%",height:"100%",objectFit:"cover",pointerEvents:"none"}} muted preload="none"/>
                          : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:18}}>📹</div>}
                      <div style={{position:"absolute",bottom:2,right:4,background:"rgba(0,0,0,0.8)",
                        borderRadius:2,padding:"0 3px",fontSize:9,color:"#64748B",fontFamily:"monospace"}}>
                        {v.duration?fmtT(v.duration):"--:--"}
                      </div>
                    </div>
                    {/* Metadata — declutter for mobile: drop TWS/TWA/Polar%,
                        the boat-name and location auto-tags, and the "tack"
                        manoeuvre tag. Only race + sail tags + local time. */}
                    {(()=>{
                      const EVENT_TAGS = ["race-start","topmark","mark"];
                      const POS_TAGS   = ["upwind","reach","downwind"];
                      const SAIL_SKIP  = /^(main|msail|mainsail|main-)/;
                      const tags = v.tags||[];
                      const boatTag = xmlData?.meta?.boat?.toLowerCase().replace(/\s+/g,"-") || null;
                      const locTag  = xmlData?.meta?.location?.toLowerCase().replace(/\s+/g,"-") || null;
                      // raceTags — events + first position; "gybe" stays, "tack" is hidden.
                      const raceTags = [
                        ...tags.filter(t=>EVENT_TAGS.includes(t)),
                        ...tags.filter(t=>POS_TAGS.includes(t)).slice(0,1),
                        ...tags.filter(t=>t==="gybe"),
                      ];
                      const SKIP_ALL = new Set(["local","cloud","training","race","today","topmark","mark","race-start","upwind","reach","downwind","tack","gybe"]);
                      // Sail tags = everything that ISN'T a race/event/manoeuvre
                      // category, mainsail, a wind/count bucket, the boat-name
                      // auto-tag, or the location auto-tag. We deliberately do
                      // NOT also try to guess "location-like" tags from hyphens
                      // — sail names with descriptors (e.g. "j3-light", "a2-vmg")
                      // were being swept up by that heuristic and disappeared.
                      const sailTags = tags.filter(t=>
                        !SKIP_ALL.has(t) && !SAIL_SKIP.test(t)
                        && !t.startsWith("tws-") && !/^\d+x-/.test(t)
                        && t!==boatTag && t!==locTag
                      );
                      const tagCol = t => {
                        if(EVENT_TAGS.includes(t)) return{bg:"#EF444420",bd:"#EF444440",c:"#EF4444"};
                        if(POS_TAGS.includes(t))   return{bg:"#06B6D420",bd:"#06B6D440",c:"#06B6D4"};
                        if(t==="gybe")             return{bg:"#1D9E7520",bd:"#1D9E7540",c:"#1D9E75"};
                        if(sailTags.includes(t))   return{bg:"#8B5CF620",bd:"#8B5CF640",c:"#A78BFA"};
                        return                          {bg:"#1E3A5A",  bd:"#2D4A6A",  c:"#7DD3FC"};
                      };
                      return(
                        <div style={{flex:1,padding:"8px 8px",display:"flex",flexDirection:"column",justifyContent:"center",minWidth:0}}>
                          {/* 1) Race tags */}
                          {raceTags.length>0&&(
                            <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:3}}>
                              {raceTags.map(t=>{const{bg,bd,c}=tagCol(t);return(<span key={t} style={{background:bg,border:`1px solid ${bd}`,color:c,fontSize:9,borderRadius:3,padding:"1px 5px",fontFamily:"monospace"}}>{t}</span>);})}
                            </div>
                          )}
                          {/* 2) Sail tags */}
                          {sailTags.length>0&&(
                            <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:3}}>
                              {sailTags.map(t=>{const{bg,bd,c}=tagCol(t);return(<span key={t} style={{background:bg,border:`1px solid ${bd}`,color:c,fontSize:9,borderRadius:3,padding:"1px 5px",fontFamily:"monospace"}}>{t}</span>);})}
                            </div>
                          )}
                          {/* 4) Clip start time (session-local) at bottom — replaces filename */}
                          <div title={v.title||""} style={{fontSize:13,fontWeight:600,color:"#E2E8F0",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{(()=>{
                            if(v.startUtc==null) return "—";
                            const d=new Date(v.startUtc + (sessionTzOffset||0)*60000);
                            return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
                          })()}</div>
                        </div>
                      );
                    })()}
                    <div style={{display:"flex",alignItems:"center",padding:"0 10px",color:"#334155",fontSize:18}}>›</div>
                  </div>
                ))}
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}

function MobileShell(props){
  const {activeTab, setActiveTab, ...rest} = props;
  React.useEffect(()=>{ injectMobileCSS(); },[]);
  const tabDefs=[
    {id:"timeline", icon:"🧭", label:"Timeline"},
    {id:"campaign", icon:"🗓", label:"Plan"},
    {id:"boatconfig", icon:"⛵", label:"Boat"},
    {id:"weather",  icon:"🌦", label:"Weather"},
    {id:"library",  icon:"📹", label:"Videos"},
    {id:"photos",   icon:"📷", label:"Photos"},
    {id:"analytics",icon:"📊", label:"Analytics"},
    {id:"upload",   icon:"⬆", label:"Upload"},
    {id:"tools",    icon:"🧰", label:"Tools"},
    {id:"admin",    icon:"⚙",  label:"Admin"},
  ].filter(t => {
    if (t.id === "campaign" && (!props.campaignOn || props.effectiveRole === 'guest')) return false;
    if (t.id === "boatconfig" && (!props.campaignOn || !props.canSeeBoatConfig)) return false;
    // Weather tab is available to all roles (tl1, consultant, guest included).
    // Tools (Squash + SailScan): TL2+ and consultant-in-period.
    if (t.id === "tools" && props.canSeeToolsTab === false) return false;
    if (t.id === "admin" && props.effectiveRole !== 'admin') return false;
    return true;
  });
  return(
    <div className="ssa-mobile" style={{display:"flex",flexDirection:"column",
      height:"100dvh",background:"#030F1A",color:"#E2E8F0",
      fontFamily:"'Segoe UI',system-ui,sans-serif",overflow:"hidden"}}>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      {/* All header controls sit on the LEFT. The UserPill avatar is fixed
          at the top-right (position:fixed, z-index:9999); keeping the sync
          button + status left-aligned means they can never end up hidden
          underneath it, on any screen width. */}
      <header style={{background:"#050E1C",borderBottom:"1px solid #1E3A5A",
        padding:"0 12px",height:34,display:"flex",alignItems:"center",
        gap:7,flexShrink:0,position:"relative",zIndex:50}}>
        <span style={{fontSize:13,fontWeight:700,color:"#E2E8F0"}}>Shared</span>
        <span style={{fontSize:13,fontWeight:700,color:"#06B6D4",marginLeft:-3}}>Sailing Analytics</span>
        {/* ── Passive sync status pill (auto-syncs; tap to force a sync now) ── */}
        {/* The dot reflects the connection; the label auto-updates with sync   */}
        {/* state. No manual sync needed — it fires on foreground / reconnect.  */}
        {(()=>{
          const ph=props.mobileSyncState?.phase;
          const uc=props.unsyncedCount||0;
          const avail=props.cloudStatus?.available;
          const busy=ph==="pulling"||ph==="pushing";
          const dot=!avail?(props.cloudStatus===null?"#334155":"#F59E0B"):(busy?"#06B6D4":uc>0?"#F59E0B":"#1D9E75");
          let label="Cloud", color="#475569";
          if(!avail){label="Local";}
          else if(busy){label="syncing…";color="#06B6D4";}
          else if(ph==="done"){label="synced";color="#1D9E75";}
          else if(ph==="error"){label="sync failed";color="#F59E0B";}
          else if(uc>0){label=`${uc} pending`;color="#F59E0B";}
          return (
            <div onClick={()=>{ /* user-pressed sync: the ONLY path allowed to push video blobs */ if(avail&&!busy) props.onMobileSync?.({heavy:true,pushVideos:true}); }}
              title="Cloud sync is automatic — tap to sync now"
              style={{display:"flex",alignItems:"center",gap:5,fontSize:10,fontWeight:600,
                cursor:avail&&!busy?"pointer":"default",userSelect:"none"}}>
              {busy
                ? <span style={{fontSize:12,display:"inline-block",animation:"ssa-spin 1s linear infinite"}}>⟳</span>
                : <span style={{width:7,height:7,borderRadius:"50%",background:dot,display:"inline-block"}}/>}
              <span style={{color}}>{label}</span>
            </div>
          );
        })()}
        <div style={{flex:1}}/>
      </header>
      {/* ── Sync progress toast — slides in below header ─────────────────── */}
      {props.mobileSyncState?.phase&&(
        <div style={{background:props.mobileSyncState.phase==="error"?"#EF444415":props.mobileSyncState.phase==="done"?"#1D9E7515":"#06B6D415",
          borderBottom:`1px solid ${props.mobileSyncState.phase==="error"?"#EF444440":props.mobileSyncState.phase==="done"?"#1D9E7540":"#06B6D440"}`,
          padding:"6px 14px",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <div style={{flex:1,display:"flex",flexDirection:"column",gap:3}}>
            <div style={{fontSize:11,fontWeight:600,
              color:props.mobileSyncState.phase==="error"?"#EF4444":props.mobileSyncState.phase==="done"?"#1D9E75":"#06B6D4"}}>
              {props.mobileSyncState.message||"Working…"}
            </div>
            {(props.mobileSyncState.phase==="pulling"||props.mobileSyncState.phase==="pushing")&&(
              <div style={{height:2,background:"#1E3A5A",borderRadius:1,overflow:"hidden"}}>
                <div style={{height:"100%",background:"#06B6D4",
                  width:`${props.mobileSyncState.progress||0}%`,transition:"width .3s"}}/>
              </div>
            )}
          </div>
          {/* An error stays put until dismissed — it used to fade after a few seconds,
              which meant the message you actually needed was the one you couldn't read.
              Tapping it also reveals the per-clip reasons in the Videos tab panel. */}
          {props.mobileSyncState.phase==="error"&&(
            <button onClick={()=>props.setMobileSyncState?.({phase:null,message:"",progress:0})}
              aria-label="Dismiss"
              style={{background:"none",border:"1px solid #EF444440",borderRadius:5,color:"#EF4444",
                fontSize:11,padding:"3px 8px",cursor:"pointer",flexShrink:0}}>✕</button>
          )}
        </div>
      )}

      {/* ── Content area ─────────────────────────────────────────────────── */}
      <div style={{flex:1,overflow:"hidden",position:"relative"}}>

        {/* Library */}
        <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",
          visibility:activeTab==="library"?"visible":"hidden",
          pointerEvents:activeTab==="library"?"auto":"none",zIndex:activeTab==="library"?2:1}}>
          <MobileLibrary {...rest} setActiveTab={setActiveTab}/>
        </div>

        {/* Analytics — lazy mount */}
        {props.hasMountedAnalytics&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",
            visibility:activeTab==="analytics"?"visible":"hidden",
            pointerEvents:activeTab==="analytics"?"auto":"none",zIndex:activeTab==="analytics"?2:1}}>
            <ErrorBoundary label="Analytics"><AnalyticsTab logData={props.logData} xmlData={props.xmlData}
              allVideos={props.allVideos} sessions={props.sessions}
              selectedVideo={props.selectedVideo} onSelectVideo={props.setSelectedVideo}
              setActiveTab={setActiveTab} activeDate={props.activeDate}
              onSelectDate={props.onSelectDate}
              playUtc={props.playUtc} visible={activeTab==="analytics"} photos={props.photos}
              canUseAI={props.canUseAI} canSeeAnalyticsData={props.canSeeAnalyticsData}/></ErrorBoundary>
          </div>
        )}

        {/* Photos */}
        {activeTab==="photos"&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Photos"><PhotosTab role={props.role} logData={props.logData} xmlData={props.xmlData}
              activeDate={props.activeDate} sessions={props.sessions} loadDate={props.loadDate}
              cloudStatus={props.cloudStatus} onPhotosChange={props.setPhotos} sessionTzOffset={props.sessionTzOffset}
              canClearDay={['admin','team_manager','coach'].includes(props.effectiveRole)}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="upload"&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Upload"><UploadTab role={props.role} cloudStatus={props.cloudStatus} onImported={props.handleImported} sailInventory={props.sailInventory} campaignCfg={props.campaignCfg} setSailDiff={props.setSailDiff} syncOffsets={props.syncOffsets}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="tools"&&(
          <div style={{position:"absolute",inset:0,overflowY:"auto",zIndex:2,background:"#030F1A"}}>
            <div style={{padding:"8px 16px",fontWeight:800,fontSize:14,color:"#E2E8F0",background:"#0F2A45",borderBottom:"1px solid #1E3A5A"}}>🎯 Squash</div>
            <div style={{position:"relative",height:"85dvh"}}><ErrorBoundary label="Squash"><SquashShotsApp/></ErrorBoundary></div>
            <div style={{padding:"8px 16px",fontWeight:800,fontSize:14,color:"#E2E8F0",background:"#0F2A45",borderTop:"2px solid #1E3A5A",borderBottom:"1px solid #1E3A5A"}}>⛵ SailScan</div>
            <div style={{position:"relative",height:"85dvh"}}><ErrorBoundary label="SailScan"><SailScanTab teamId={props.campaignCfg?.teamId} boatId={props.campaignCfg?.boatId}/></ErrorBoundary></div>
          </div>
        )}

        {/* Campaign */}
        {activeTab==="campaign"&&props.campaignOn&&props.campaignCfg&&props.effectiveRole!=='guest'&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Campaign"><CampaignTab teamId={props.campaignCfg.teamId} boatId={props.campaignCfg.boatId} role={props.effectiveRole} config={props.campaignCfg} isMobile={true} onOpenVideo={props.openCampaignVideo}/></ErrorBoundary>
          </div>
        )}

        {/* Boat config (read-only viewer) */}
        {activeTab==="boatconfig"&&props.campaignOn&&props.campaignCfg&&props.canSeeBoatConfig&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Boat config"><BoatConfigTab teamId={props.campaignCfg.teamId} boatId={props.campaignCfg.boatId} role={props.effectiveRole} config={props.campaignCfg} isMobile={true} sessionTzOffset={props.sessionTzOffset}/></ErrorBoundary>
          </div>
        )}

        {/* Weather — wind-analysis tool, available to all roles (sub-features gated by role inside). */}
        {activeTab==="weather"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Weather"><WeatherTab isMobile={true} effectiveRole={props.effectiveRole} boatName={props.campaignCfg?.boatName} eventName={props.campaignCfg?.event} logData={props.logData}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="timeline"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Timeline"><TimelineTab teamId={props.campaignCfg?.teamId||props.activeMem?.team_id} boatId={props.campaignCfg?.boatId||props.activeMem?.boat_id} tzOffset={props.sessionTzOffset} onOpenVideo={props.openVideoModal}/></ErrorBoundary>
          </div>
        )}

        {/* Admin */}
        {activeTab==="admin"&&(
          <div style={{position:"absolute",inset:0,overflowY:"auto",padding:"16px 14px",zIndex:2}}>
            <div style={{fontSize:15,fontWeight:600,marginBottom:16}}>Admin</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {[
                {title:"Data tiers",items:["Tier 1: IndexedDB (local)","Tier 2: Bunny Cloud (R2+Stream)",`Unsynced: ${props.unsyncedCount}`]},
                {title:"Cloud",items:[`Storage: ${props.cloudStatus?.storage?"✓":"—"}`,`Stream: ${props.cloudStatus?.stream?"✓":"—"}`]},
              ].map(c=>(
                <div key={c.title} style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:14}}>
                  <div style={{fontSize:12,fontWeight:600,color:"#64748B",marginBottom:8}}>{c.title}</div>
                  {c.items.map((item,i)=><div key={i} style={{fontSize:12,color:"#334155",padding:"4px 0",borderBottom:"1px solid #0F2030"}}>{item}</div>)}
                </div>
              ))}
              {/* Storage management */}
              <div style={{background:"#0A1929",border:"1px solid #EF444430",borderRadius:10,padding:14}}>
                <div style={{fontSize:12,fontWeight:600,color:"#EF4444",marginBottom:10}}>Storage</div>
                <button onClick={()=>{
                  const all=JSON.parse(localStorage.getItem("ssa:sessions")||"[]");
                  const valid=all.filter(s=>{const y=parseInt((s.date||"").slice(0,4));return y>=2000&&y<=2100;});
                  localStorage.setItem("ssa:sessions",JSON.stringify(valid));
                  props.setSessions(valid);
                  alert(`Removed ${all.length-valid.length} bad sessions.`);
                }} style={{width:"100%",background:"#EF444415",border:"1px solid #EF444440",
                  borderRadius:8,padding:"12px",color:"#EF4444",fontSize:14,cursor:"pointer",marginBottom:8}}>
                  🗑 Remove bad-date sessions
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom tab bar ────────────────────────────────────────────────── */}
      <nav className="ssa-mob-bottom-nav" style={{background:"#050E1C",
        borderTop:"1px solid #1E3A5A",display:"flex",flexShrink:0,zIndex:50}}>
        {tabDefs.map(({id,icon,label})=>{
          const active=activeTab===id;
          const badge=id==="upload"&&props.unsyncedCount>0?props.unsyncedCount:null;
          return(
            <button key={id} onClick={()=>setActiveTab(id)}
              style={{flex:1,background:"none",border:"none",cursor:"pointer",
                padding:"8px 4px 6px",display:"flex",flexDirection:"column",
                alignItems:"center",gap:2,color:active?"#06B6D4":"#475569",
                position:"relative",minHeight:52}}>
              <span style={{fontSize:20,lineHeight:1}}>{icon}</span>
              <span style={{fontSize:10,fontWeight:active?700:400}}>{label}</span>
              {badge&&<span style={{position:"absolute",top:4,right:"calc(50% - 16px)",
                background:"#F59E0B",color:"#000",borderRadius:8,
                padding:"0 5px",fontSize:9,fontWeight:800}}>{badge}</span>}
              {active&&<div style={{position:"absolute",bottom:0,left:"20%",right:"20%",
                height:2,background:"#06B6D4",borderRadius:1}}/>}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function SSAApp(){
  const isMobile = useIsMobile();
  const[role,setRole]=useState("coach");
  const[activeTab,setActiveTab]=useState("timeline");
  const[allVideos,setAllVideos]=useState([]);
  const[logData,setLogData]=useState(null);
  const[sessionTzOffset,setSessionTzOffset]=useState(DEFAULT_TZ);
  const[sessionTagList,setSessionTagList]=useState([]);
  const[xmlData,setXmlData]=useState(null);
  const[selectedVideo,setSelectedVideo]=useState(null);
  // Timeline clip playback: open the real overlay player in a modal ON TOP of
  // the current view (usually the Timeline) instead of switching to the Videos
  // tab — so you never leave the timeline.
  const[videoModalOpen,setVideoModalOpen]=useState(false);
  // Phase B — crop state. The two cut markers are set by the player
  // toolbar buttons ("Delete UPTO here" / "Delete FROM here") and shown
  // as red lines on the timeline. The Save button commits via ffmpeg.
  //   pendingCrop : { deleteUpTo: secs|null, deleteFrom: secs|null } | null
  //   cropBusy    : true while the save is running
  //   cropProgress: { pct, message } during the save
  //   cropError   : last error string, surfaced as a small banner
  const[pendingCrop, setPendingCrop]   = useState(null);
  const[cropBusy,    setCropBusy]      = useState(false);
  const[cropProgress,setCropProgress]  = useState(null);
  const[cropError,   setCropError]     = useState(null);
  // Clear any pending crop when the selected video changes so cut marks
  // can't leak across clips.
  useEffect(()=>{
    setPendingCrop(null); setCropProgress(null); setCropError(null); setCropBusy(false);
  },[selectedVideo?.id]);
  const[syncOffsets,setSyncOffsets]=useState(()=>getSyncOffsets());
  const[selectedTags,setSelectedTags]=useState([]);
  const[searchQuery,setSearchQuery]=useState("");
  const[sortBy,setSortBy]=useState("date");
  // Sail inventory (BoatConfig) → sail-name filter dropdown in Videos + Photos.
  const[sailInventory,setSailInventory]=useState([]);
  const[sailFilter,setSailFilter]=useState(""); // selected sail id, "" = all
  const[sessions,setSessions]=useState([]);
  const[activeDate,setActiveDate]=useState(TODAY());
  // Effective "TAP TO ADD" suggestion list: union of the curated session tag
  // list (what gets persisted via saveTagListCloud) and the actual MANUAL
  // tags applied to every clip in the active session. This way a tag that
  // someone added directly to a clip on another device (or before we wired
  // tag-list cloud sync) still appears as a suggestion next time anyone
  // opens that session's TagEditor. Auto-computed tags (tws-/race-/upwind/
  // tack etc.) are deliberately excluded — they'd just clutter the picker.
  // Must come AFTER activeDate's useState — referencing it before throws a
  // TDZ "Cannot access 'P' before initialization" in the Vercel production
  // build (caught Mar 2026 prerender).
  const tagSuggestionList = useMemo(() => {
    const set = new Set(sessionTagList);
    for (const v of allVideos) {
      if (v.sessionDate !== activeDate) continue;
      for (const t of (v.tags || [])) {
        if (!t || isAutoTag(t)) continue;
        set.add(t);
      }
    }
    return [...set].sort();
  }, [sessionTagList, allVideos, activeDate]);
  const[cloudStatus,setCloudStatus]=useState(null);
  const[unsyncedCount,setUnsyncedCount]=useState(0);
  const[aiQuery,setAiQuery]=useState("");
  const[aiResult,setAiResult]=useState(null);
  const[aiLoading,setAiLoading]=useState(false);
  // Effective auth role — either 'admin' (from users.global_role) or the
  // active membership's role. Used to gate UI features. Null until the
  // identity check resolves.
  const[effectiveRole,setEffectiveRole]=useState(null);
  // Campaign engine config (null = off / unavailable). See the fetch effect below.
  const[campaignCfg,setCampaignCfg]=useState(null);
  // Resolved active workspace (team+boat) — a fallback so the Timeline works even
  // when the campaign feature flag is off (campaignCfg would be null then).
  const[activeMem,setActiveMem]=useState(null);
  useEffect(()=>{
    let alive=true;
    const read=async()=>{ try{ const {data:{user}}=await getBrowserSupabase().auth.getUser(); if(user&&alive) setActiveMem(getActiveMembership(user.id)); }catch{} };
    read();
    const on=()=>read();
    window.addEventListener('ssa:active-membership-changed',on);
    return ()=>{ alive=false; window.removeEventListener('ssa:active-membership-changed',on); };
  },[]);
  // Fetch the boat's sail inventory for the Videos/Photos sail-name filter and
  // the event-file saillist reconciliation.
  const refetchSails=()=>{
    const tId=campaignCfg?.teamId, bId=campaignCfg?.boatId;
    if(!tId||!bId){setSailInventory([]);return;}
    fetch(`/api/teams/${tId}/sails?boat_id=${bId}`).then(r=>r.json())
      .then(j=>setSailInventory(Array.isArray(j?.sails)?j.sails:[])).catch(()=>{});
  };
  useEffect(()=>{refetchSails();},[campaignCfg?.teamId,campaignCfg?.boatId]); // eslint-disable-line react-hooks/exhaustive-deps
  const[sailDiff,setSailDiff]=useState(null); // {names:[]} when an event file's sails differ from inventory
  const[loaded,setLoaded]=useState(false);
  const[playUtc,setPlayUtc]=useState(null);
  const[photos,setPhotos]=useState([]);
  const[hasMountedAnalytics,setHasMountedAnalytics]=useState(false);
  const[streamPollTick,setStreamPollTick]=useState(0); // re-arms the Bunny Stream encoding poll
  const playUtcThrottle=useRef(0);
  const[libSyncProgress,setLibSyncProgress]=useState(null);
  const[libSyncPhase,setLibSyncPhase]=useState(null);
  const libSyncAbortRef=useRef(false);
  const libSyncTimerRef=useRef(null);
  // Mobile-specific sync state — phase: null | "pulling" | "pushing" | "done" | "error"
  const[mobileSyncState,setMobileSyncState]=useState({phase:null,message:"",progress:0});

  // ── Logger ────────────────────────────────────────────────────────────────
  // SSAApp has NO upload console — `addLog` belongs to UploadTab and is not in this
  // scope. Calling it from here threw `ReferenceError: addLog is not defined`, and
  // because several of those calls sit BEFORE the work they announce, they killed it:
  //
  //     addLog('📶 Wi-Fi — uploading N held clips…')   ← threw
  //     enqueueAutoSync(held, activeDate)               ← never ran
  //
  // …which is exactly why clips never uploaded on Wi-Fi. Give SSAApp its own logger
  // so every call site resolves. Anything the USER must act on goes to the sync-error
  // panel / mobileSyncState, which are visible on mobile; this is the trace channel.
  const addLog = useCallback((msg) => { try { console.log('[ssa]', msg); } catch { /* */ } }, []);

  // Upload failures, surfaced IN THE UI. addLog() only writes to the console —
  // on mobile you're in the Videos tab and would never see it, so a failing
  // upload looked like a no-op. These are shown in the sync panel itself.
  // Ref mirror — the sync queues need the current clip list while draining, WITHOUT
  // calling getAllVideos(), which mints a brand-new blob: URL for every video on every
  // call. Called once per queued item, that leaked N object URLs per clip and pinned
  // every source Blob in memory.
  const allVideosRef = useRef([]);
  useEffect(()=>{ allVideosRef.current = allVideos; },[allVideos]);

  // Cache the authenticated user for the lifetime of the page. auth.getUser() is a
  // ~0.3-0.7s round-trip and the boot path was calling it ~6x (3 of them inside
  // loadDate alone). The auth user can't change without a full reload, so caching
  // is safe; an onAuthStateChange clears it if a session ever swaps in place.
  const authUserRef = useRef(undefined); // undefined = not yet fetched; null = signed out
  const getUserCached = useCallback(async () => {
    if (authUserRef.current !== undefined) return authUserRef.current;
    try { const { data:{ user } } = await getBrowserSupabase().auth.getUser(); authUserRef.current = user || null; }
    catch { authUserRef.current = null; }
    return authUserRef.current;
  }, []);
  useEffect(() => {
    const { data } = getBrowserSupabase().auth.onAuthStateChange((_e, session) => { authUserRef.current = session?.user || null; });
    return () => { try { data?.subscription?.unsubscribe(); } catch { /* */ } };
  }, []);
  // Monotonic token so a superseded loadDate (rapid date switch, or the two
  // overlapping boot-time calls) can't apply its late background cloud data on
  // top of a newer date. Latest loadDate wins.
  const loadDateSeqRef = useRef(0);
  const[syncErrors,setSyncErrors]=useState([]);
  const noteSyncError=useCallback((label,message)=>{
    setSyncErrors(p=>[...p.filter(e=>e.label!==label),{label,message:String(message||'upload failed')}]);
  },[]);

  // ── Phase B auto-sync queue ─────────────────────────────────────────────────
  // Background queue that uploads newly-imported videos to Bunny Storage as
  // proxy MP4s without any manual button press. Drives `mobileSyncState` so
  // the existing top-of-screen progress strip shows what's happening.
  //
  // Sequential by design — ffmpeg.wasm is single-instance per page, parallel
  // runs just contend for the same WASM core. One clip at a time keeps memory
  // bounded too.
  //
  // The Ref-based queue avoids stale-closure problems with the processor loop;
  // the React state lives only on the visible progress strip.
  const autoSyncRef = useRef({
    queue: [],          // [{videoId, sessionDate, label}, …]
    running: false,
    activePromise: null,// in-flight drain promise — lets the batch flow await it
    done: 0,
    total: 0,
    failed: 0,          // so the final state can report failure instead of a fake ✓
  });

  // ── Phase B.3 originals queue ───────────────────────────────────────────────
  // Full-resolution originals follow the proxies ("two-tier" sync). They are
  // large, so the queue only drains on an unmetered link unless force-run via
  // the batch button. A connection-change listener resumes a held queue.
  const originalsSyncRef = useRef({
    queue: [],          // [{videoId, sessionDate, label}, …]
    running: false,
    done: 0,
    total: 0,
  });
  // Shared timer that clears the progress strip a few seconds after a queue
  // finishes. Held in a ref so a follow-on phase (proxies → originals) can
  // cancel the pending clear instead of having its progress wiped mid-run.
  const syncClearTimerRef = useRef(null);

  // Batch select / delete — admin + coach only
  const[batchMode,setBatchMode]=useState(false);
  const[batchSelected,setBatchSelected]=useState(()=>new Set());
  const toggleBatchSelect=useCallback(id=>{
    setBatchSelected(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;});
  },[]);
  const clearBatch=useCallback(()=>{setBatchMode(false);setBatchSelected(new Set());},[]);
  // A clip lives in THREE stores — IndexedDB (blob), Bunny (rendition) and the
  // Supabase `videos` row. This used to delete only the first, so the cloud row
  // survived and merged straight back in on the next load as a phantom cloud-only
  // clip: deleted clips kept coming back. Delete all three, Bunny + cloud first so
  // that if anything fails we still have the local entry to retry from.
  const handleBatchDelete=useCallback(async()=>{
    if(!batchSelected.size)return;
    const ids=[...batchSelected];
    const targets=allVideos.filter(v=>batchSelected.has(v.id));
    let supabaseUser=null;
    try{
      const supabase=getBrowserSupabase();
      const {data:{user}}=await supabase.auth.getUser();
      supabaseUser=user;
    }catch{}
    for(const v of targets){
      if(v.streamId){try{await deleteStreamVideo(v.streamId);}catch{}}
      if(supabaseUser){try{await deleteVideosCloud({userId:supabaseUser.id,id:v.cloudId||v.id});}catch{}}
    }
    for(const id of ids){try{await deleteVideo(id);}catch{}}
    setAllVideos(p=>p.filter(v=>!batchSelected.has(v.id)));
    if(selectedVideo&&batchSelected.has(selectedVideo.id))setSelectedVideo(null);
    clearBatch();
    addLog(`🗑 Deleted ${ids.length} clip${ids.length>1?"s":""} — local + Bunny + cloud row`);
  },[batchSelected,selectedVideo,clearBatch,allVideos]);

  // Nuke every clip for the active day across all three stores. Unlike batch
  // delete this also removes ORPHAN cloud rows — rows whose local entry is already
  // gone, which the library can't always surface for selection, and which are the
  // residue of the old delete path that never touched Supabase. Use to start a day
  // fresh before re-importing.
  const[clearDayBusy,setClearDayBusy]=useState(false);
  const[clearDayArmed,setClearDayArmed]=useState(false);
  const handleClearDay=useCallback(async()=>{
    if(!activeDate)return;
    setClearDayBusy(true);
    try{
      // 1. Bunny renditions — needs the stream ids, which only exist while the rows do.
      for(const v of allVideos){ if(v.streamId){try{await deleteStreamVideo(v.streamId);}catch{}} }
      // 2. Cloud rows for the whole day (catches orphans with no local entry).
      let n=0;
      try{
        const supabase=getBrowserSupabase();
        const {data:{user}}=await supabase.auth.getUser();
        if(user){ const r=await deleteVideosCloud({userId:user.id,date:activeDate}); n=r.deleted; }
      }catch{}
      // 3. Local IDB.
      const locals=await getVideosForDate(activeDate);
      for(const v of locals){try{await deleteVideo(v.id);}catch{}}
      setAllVideos([]); setSelectedVideo(null); clearBatch();
      addLog(`🗑 Cleared ${activeDate}: ${locals.length} local + ${n} cloud row${n===1?"":"s"} removed. Re-import to start fresh.`);
    } finally { setClearDayBusy(false); setClearDayArmed(false); }
  },[activeDate,allVideos,clearBatch]);

  // Batch ↓ Save to disk — ask the user once for a destination folder,
  // then stream every selected clip's blob straight into it via the File
  // System Access API. Anchor-download fallback for browsers that don't
  // support showDirectoryPicker (notably Safari) — but that path will
  // again only honour the user's chosen folder for the first download;
  // subsequent ones go to the OS default. Progress is surfaced through
  // the existing sync state strip.
  const handleBatchSaveToDisk = useCallback(async () => {
    if (!batchSelected.size) return;
    const selected = allVideos.filter(v => batchSelected.has(v.id) && v.hasLocalBlob);
    if (!selected.length) { alert('None of the selected clips have a local file on this device.'); return; }

    let dirHandle = null;
    if ('showDirectoryPicker' in window) {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (e) {
        // AbortError = user cancelled. Anything else, fall through to the
        // single-prompt download path with a console warning.
        if (e?.name === 'AbortError') return;
        console.warn('[batch-save] showDirectoryPicker failed, falling back to downloads:', e);
      }
    }

    setMobileSyncState({ phase: 'pushing', message: `Saving 0/${selected.length}…`, progress: 0 });
    let saved = 0;
    for (let i = 0; i < selected.length; i++) {
      const v = selected[i];
      const label = v.title || v.name || v.id;
      try {
        const blob = await getVideoBlob(v.id);
        if (!blob) { console.warn('[batch-save] no local blob for', v.id); continue; }
        const stem = (v.title || v.name || 'clip').replace(/\.[^.]+$/, '');
        const name = `${stem}.mp4`;

        if (dirHandle) {
          // FS Access API — stream the blob straight into the picked
          // folder, no per-file prompts, no Downloads-folder hijack.
          const fh = await dirHandle.getFileHandle(name, { create: true });
          const writable = await fh.createWritable();
          try {
            await blob.stream().pipeTo(writable);
          } catch (e) {
            try { await writable.abort(); } catch {}
            throw e;
          }
        } else {
          // Legacy anchor-download — only really useful for one file at
          // a time. We still try in case the user is on Safari; they'll
          // get the first file in their chosen folder and the rest in
          // their default Downloads.
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60_000);
          await new Promise(r => setTimeout(r, 400));
        }

        saved++;
        setMobileSyncState({
          phase: 'pushing',
          message: `Saved ${saved}/${selected.length} · ${label}`,
          progress: Math.round((saved / selected.length) * 100),
        });
      } catch (e) {
        console.error('[batch-save] failed for', v.id, e);
      }
    }

    setMobileSyncState({
      phase: 'done',
      message: `✓ Saved ${saved} of ${selected.length} to disk`,
      progress: 100,
    });
    setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 4000);
    if (saved < selected.length) {
      alert(`Saved ${saved} of ${selected.length}. The rest failed (see console).${dirHandle ? '' : '\n\nTip: your browser does not support a single-folder picker. On Chrome/Edge the batch saves all clips to one folder; on Safari only the first goes where you asked.'}`);
    }
  }, [batchSelected, allVideos]);

  // Batch ↑ Upload compressed — pick N compressed files, match each to a
  // selected clip by filename stem (case-insensitive prefix), then push
  // each to Bunny Stream as the cloud "original". The local IDB blobs
  // stay untouched so HD-local debrief playback still works.
  const handleBatchUploadCompressed = useCallback(async () => {
    if (!batchSelected.size) return;
    const selected = allVideos.filter(v => batchSelected.has(v.id));
    if (!selected.length) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/mp4,video/quicktime,.mp4,.mov,.m4v';
    input.onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      // Match files to clips by filename stem (case-insensitive). Accepts
      // "<stem>.mp4", "<stem>_<anything>.mp4", "<stem>-<anything>.mp4"
      // — e.g. matches "Race1.mp4" → Race1.mp4 / Race1_720p.mp4 / Race1-720.mp4.
      const norm = s => (s || '').replace(/\.[^.]+$/, '').toLowerCase().trim();
      const pairs = [];
      const usedFiles = new Set();
      for (const v of selected) {
        const clipStem = norm(v.title || v.name || v.id);
        if (!clipStem) continue;
        const match = files.find(f => {
          if (usedFiles.has(f)) return false;
          const fs = norm(f.name);
          return fs === clipStem || fs.startsWith(clipStem + '_') || fs.startsWith(clipStem + '-');
        });
        if (match) {
          pairs.push({ video: v, file: match });
          usedFiles.add(match);
        }
      }
      if (!pairs.length) {
        alert('No picked files matched the selected clips by name.\n\nThe match looks at filename stem — e.g. a clip titled "Race1" matches Race1.mp4 / Race1_720p.mp4 / Race1-compressed.mp4. Re-export from "Save to disk" if you renamed them.');
        return;
      }
      if (pairs.length < selected.length) {
        if (!confirm(`Matched ${pairs.length} of ${selected.length} clips. Continue with those?`)) return;
      }

      try {
        const supabase = getBrowserSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { alert('You need to be signed in.'); return; }

        for (let i = 0; i < pairs.length; i++) {
          const { video, file } = pairs[i];
          const label = video.title || video.name || video.id;
          try {
            const cloudId = await ensureCloudVideoId({
              userId: user.id,
              video,
              sessionDate: video.sessionDate || activeDate,
            });
            if (!cloudId) { console.warn('[batch-upload-compressed] no cloud row for', video.id); continue; }
            setMobileSyncState({ phase: 'pushing', message: `Uploading ${i+1}/${pairs.length} · ${label}`, progress: 0 });
            let streamId = getPendingOrigStream(video.id);
            if (!streamId) {
              const created = await createStreamUpload(label, file.size);
              streamId = created?.streamId || null;
              if (streamId) setPendingOrigStream(video.id, streamId);
            }
            if (!streamId) { console.warn('[batch-upload-compressed] no Stream video for', video.id); continue; }
            const uploaded = await uploadFileToStream(
              { streamId },
              file,
              (pct) => setMobileSyncState({
                phase: 'pushing',
                message: `Uploading ${i+1}/${pairs.length} · ${label}`,
                progress: pct,
              }),
            );
            if (!uploaded) { console.warn('[batch-upload-compressed] interrupted for', video.id); continue; }
            await fetch(
              `/api/videos/${encodeURIComponent(cloudId)}/renditions`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ original: { streamId } }),
              },
            ).catch(()=>{});
            clearPendingOrigStream(video.id);
            setAllVideos(p => p.map(v => v.id === video.id
              ? { ...v, hasOriginal: true, originalStreamId: streamId, streamProcessing: true, cloudId }
              : v));
          } catch (err) {
            console.error('[batch-upload-compressed] failed for', video.id, err);
          }
        }
        setMobileSyncState({ phase: 'done', message: `✓ Uploaded ${pairs.length} compressed clip${pairs.length===1?'':'s'}`, progress: 100 });
        setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 4000);
        clearBatch();
      } catch (err) {
        console.error('[batch-upload-compressed] outer failure', err);
        setMobileSyncState({ phase: 'error', message: err?.message || 'Batch upload failed', progress: 0 });
      }
    };
    input.click();
  }, [batchSelected, allVideos, activeDate, clearBatch]);

  // Batch sync — admin + coach only. A pending offset (seconds) that can be
  // applied to every clip currently in batchSelected.
  const[batchSyncOffset,setBatchSyncOffset]=useState(0);
  const[batchSyncOpen,setBatchSyncOpen]=useState(false);
  const[batchSyncBusy,setBatchSyncBusy]=useState(false);

  // Bake a sync offset into one or more clips' startUtc — local IDB + cloud
  // row + auto-tag recomputation in one shot. Used by both the per-clip Save
  // button in the SyncControl and the batch Sync apply path. Returns the
  // number of clips actually updated (clips with no startUtc are skipped).
  // Rotate a clip — TL3 and above (the senior ladder, same as Boat Config). Writes the
  // ANGLE to IndexedDB and to the cloud row; the source file is never re-encoded, which
  // is the entire point: QuickTime Player's rotate transcodes and strips the capture
  // metadata, so clips arrived carrying their edit time instead of their recording time.
  const canRotate = ['admin','team_manager','coach','tl3'].includes(effectiveRole);
  const rotateVideo = useCallback(async (video, deg) => {
    if (!canRotate || !video?.id) return;
    setAllVideos(p => p.map(v => v.id === video.id ? { ...v, rotation: deg } : v));
    setSelectedVideo(v => (v && v.id === video.id ? { ...v, rotation: deg } : v));
    try { await updateVideoRotation(video.id, deg); } catch { /* local only */ }
    const cloudId = video.cloudId || (isCloudVideoId(video.id) ? video.id : null);
    if (cloudId) {
      try {
        await fetch(`/api/videos/${encodeURIComponent(cloudId)}/rotation`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rotation: deg }),
        });
      } catch { /* stays local until the next sync */ }
    }
  }, [canRotate]);

  const saveSyncForVideos = useCallback(async (videos, offsetSecs) => {
    if (!offsetSecs || !videos?.length) return 0;
    let supabaseUser = null;
    try {
      const supabase = getBrowserSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      supabaseUser = user;
    } catch {}
    const enriched = {};
    const newOffsetMap = { ...syncOffsets };
    for (const v of videos) {
      if (v.startUtc == null) continue;
      const newStartUtc = v.startUtc + offsetSecs * 1000;
      // Recompute auto-tags from the new startUtc (window shifts).
      const autoTags = computeAutoTags(newStartUtc, v.duration, logData, xmlData, 0);
      const manualTags = (v.tags || []).filter(t => !isAutoTag(t));
      const mergedTags = [...new Set([...autoTags, ...manualTags])];
      // 1. Local IDB (no-op for cloud-only entries).
      try { await updateVideoStartUtc(v.id, newStartUtc); } catch {}
      try { await updateVideoTags(v.id, mergedTags); } catch {}
      // 2. Cloud row — propagate startUtc + tags + reset stored offset.
      if (supabaseUser) {
        try {
          await upsertVideoCloud({
            userId: supabaseUser.id,
            sessionDate: v.sessionDate || activeDate,
            title: v.title || v.name || null,
            startUtc: newStartUtc,
            durationSec: v.duration ?? null,
            tags: mergedTags,
            syncOffsetSecs: 0,                // baked in
            thumbnailUrl: v.thumbnailUrl ?? null,
            bunnyStreamId: v.streamId ?? null,
            bunnyStoragePath: v.bunny_storage_path ?? null,
            bytes: v.size ?? null,
            externalId: v.externalId || v.id,
          });
        } catch { /* non-fatal — local copy is updated */ }
      }
      // 3. Local sync-offset preference → 0.
      saveSyncOffset(v.id, 0);
      delete newOffsetMap[v.id];
      enriched[v.id] = enrichVideo({ ...v, startUtc: newStartUtc, tags: mergedTags }, logData, xmlData, newOffsetMap);
    }
    const updatedCount = Object.keys(enriched).length;
    if (updatedCount) {
      setSyncOffsets(newOffsetMap);
      setAllVideos(p => p.map(v => enriched[v.id] || v));
      if (selectedVideo && enriched[selectedVideo.id]) setSelectedVideo(enriched[selectedVideo.id]);
    }
    return updatedCount;
  }, [activeDate, syncOffsets, logData, xmlData, selectedVideo]);

  // Fire-and-forget cloud upsert for a single clip's metadata. Used by
  // every code path that mutates a clip's tags / startUtc / duration on
  // disk — crop, StartTimeEditor, Re-tag-all — so that the videos row
  // reflects the change and other users / devices pick it up via the
  // cloud-authoritative tags merge in loadDate. `overrides` lets the
  // caller send the post-mutation values (e.g. newStartUtc after a crop)
  // even when the in-memory `video` shape hasn't been re-rendered yet.
  const pushVideoMetadataToCloud = useCallback(async (video, overrides = {}) => {
    if (!video) return false;
    try {
      const supabase = getBrowserSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return false;
      await upsertVideoCloud({
        userId: user.id,
        sessionDate: video.sessionDate || activeDate,
        title: video.title || video.name || null,
        startUtc: video.startUtc ?? null,
        durationSec: video.duration ?? null,
        tags: video.tags ?? [],
        syncOffsetSecs: syncOffsets[video.id] ?? 0,
        thumbnailUrl: video.thumbnailUrl ?? null,
        bunnyStreamId: video.streamId ?? null,
        bunnyStoragePath: video.bunny_storage_path ?? null,
        bytes: video.size ?? null,
        externalId: video.externalId || video.id,
        ...overrides,
      });
      return true;
    } catch (e) { console.warn('[cloud] meta push failed', e); return false; }
  }, [activeDate, syncOffsets]);

  // Persist tag edits to BOTH local IDB and the Supabase row. Without the
  // cloud upsert, tag edits on cloud-only clips (uploaded from another
  // device, no local IDB entry) silently revert on the next library reload
  // — updateVideoTags is a no-op for missing IDB entries. On desktop the
  // earlier wiring didn't even hit IDB, only React state, so every tag
  // edit reverted there too. Used by both TagEditor onSave handlers.
  const saveTagsForVideo = useCallback(async (video, newTags) => {
    if (!video) return;
    // 1. Local IDB (no-op for cloud-only entries).
    try { await updateVideoTags(video.id, newTags); } catch (e) { console.warn('[tags] IDB write failed', e); }
    // 2. Cloud row — preserves the edit across tab close + other devices.
    //    Surface failures: silent returns from upsertVideoCloud (no active
    //    membership, RLS denial, network) were hiding real cloud-sync
    //    breakage and making "tags don't propagate" hard to diagnose.
    try {
      const supabase = getBrowserSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        console.warn('[tags] cloud sync skipped — not signed in');
      } else {
        const res = await upsertVideoCloud({
          userId: user.id,
          sessionDate: video.sessionDate || activeDate,
          title: video.title || video.name || null,
          startUtc: video.startUtc ?? null,
          durationSec: video.duration ?? null,
          tags: newTags,
          syncOffsetSecs: syncOffsets[video.id] ?? 0,
          thumbnailUrl: video.thumbnailUrl ?? null,
          bunnyStreamId: video.streamId ?? null,
          bunnyStoragePath: video.bunny_storage_path ?? null,
          bytes: video.size ?? null,
          externalId: video.externalId || video.id,
        });
        if (!res.ok) {
          console.warn('[tags] cloud upsert FAILED', {
            videoId: video.id,
            externalId: video.externalId || video.id,
            sessionDate: video.sessionDate || activeDate,
            error: res.error,
            noMembership: res.noMembership,
          });
        } else {
          // Action=updated means the dedupe found the existing row and
          // applied tags. action=created means the server didn't find a
          // matching row (external_id / bunny_stream_id mismatch) and
          // inserted a NEW row — symptom of a duplicate-clip problem
          // where the original cloud row still has the old tags.
          console.log('[tags] cloud upsert OK', {
            videoId: video.id,
            externalId: video.externalId || video.id,
            cloudRowId: res.videoId,
            action: res.action,
            tags: newTags,
          });
          if (res.action === 'created') {
            console.warn('[tags] ⚠ INSERTED a new cloud row instead of updating — likely a duplicate. mobile will keep reading the original row.', {
              externalIdSent: video.externalId || video.id,
              newRowId: res.videoId,
            });
          }
        }
      }
    } catch (e) { console.warn('[tags] cloud upsert threw', e); }
    // 3. Update React state so the UI reflects immediately.
    setAllVideos(p => p.map(v => v.id === video.id ? { ...v, tags: newTags } : v));
    setSelectedVideo(p => p && p.id === video.id ? { ...p, tags: newTags } : p);
  }, [activeDate, syncOffsets]);

  // Video thumbnail load tracking — mirrors the PhotosTab pattern
  const[videoThumbsLoading,setVideoThumbsLoading]=useState(false);
  const[videoLoadedIds,setVideoLoadedIds]=useState(()=>new Set());
  const[videoTotalThumbs,setVideoTotalThumbs]=useState(0);
  const markVideoThumbLoaded=useCallback(id=>{
    setVideoLoadedIds(prev=>{
      if(prev.has(id))return prev;
      const n=new Set(prev);n.add(id);return n;
    });
  },[]);
  const perms=ROLES[role];

  // Mount analytics pane on first visit OR as soon as log data arrives
  // (whichever comes first — avoids blank tab after upload without visiting first)
  useEffect(()=>{
    if(activeTab==="analytics"||logData) setHasMountedAnalytics(true);
  },[activeTab, logData]);

  // Safety: if user switches to Analytics and logData is missing, reload from IDB
  useEffect(()=>{
    if(activeTab==="analytics" && !logData && activeDate){
      loadDate(activeDate);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[activeTab]);

  // Resolve ONE clip's signed playback URL, on demand. loadDate no longer resolves
  // every clip on the day (that was ~one /url request per clip and the startup
  // bottleneck — see the boot profiling). The grid cards render from the inline
  // Bunny poster; a clip only needs a playback URL when it's actually selected to
  // play, which is what the effect below drives. Idempotent: a clip that already
  // has a resolved https URL is skipped.
  const ensureClipUrl = useCallback(async (videoId) => {
    if (!videoId) return;
    const v = allVideosRef.current.find(x => x.id === videoId);
    if (!v) return;
    if (v.objectUrl && String(v.objectUrl).startsWith('http')) return;   // already resolved
    if (!(v.hasProxy || v.hasOriginal || v.streamId)) return;            // nothing in the cloud to resolve
    let upd = null;
    try {
      if (v.hasProxy || v.hasOriginal) {
        const res = await fetch(`/api/videos/${encodeURIComponent(v.cloudId || v.id)}/url?prefer=${isMobile ? 'proxy' : 'auto'}`);
        if (res.ok) {
          const j = await res.json();
          if (j?.url) upd = { objectUrl: j.url, servedRendition: j.served || null, thumbnailUrl: v.thumbnailUrl || j.thumbnail || null };
          else if (j?.kind === 'processing') upd = { streamProcessing: true, thumbnailUrl: v.thumbnailUrl || j.thumbnail || null };
        }
      }
      if (!upd && v.streamId) {
        const res = await fetch(`/api/stream/status/${v.streamId}`);
        if (res.ok) { const s = await res.json(); if (s.playbackUrl) upd = { objectUrl: s.playbackUrl, thumbnailUrl: v.thumbnailUrl || s.thumbnailUrl || null }; }
      }
    } catch { /* offline / transient — the poster stays, retried on next select */ }
    if (!upd) return;
    // Defer revoking the old blob: URL — a live <video> may still be reading it
    // (see the note in loadDate); revoking synchronously spams ERR_FILE_NOT_FOUND.
    const old = v.objectUrl;
    if (old && String(old).startsWith('blob:')) setTimeout(() => { try { URL.revokeObjectURL(old); } catch { /* */ } }, 15_000);
    setAllVideos(prev => prev.map(x => x.id === videoId ? { ...x, ...upd } : x));
    setSelectedVideo(prev => (prev && prev.id === videoId) ? { ...prev, ...upd } : prev);
  }, [isMobile]);

  // When a clip becomes selected, make sure its playback URL is resolved (it plays
  // the instant the fetch returns; a clip with a local blob already plays from that).
  useEffect(()=>{
    setPlayUtc(selectedVideo?.startUtc||null);
    if(selectedVideo?.id) ensureClipUrl(selectedVideo.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[selectedVideo?.id]);

  // Poll Bunny Stream for clips still encoding their adaptive HLS ladder.
  // Once a clip is ready, swap its playback URL in with no manual reload.
  // Self-terminating: stops as soon as no clip is left processing, and is
  // capped (~10 min) so a genuinely stuck encode can't poll forever.
  useEffect(()=>{
    if(streamPollTick>30 || !allVideos.some(v=>v.streamProcessing)) return;
    const t=setTimeout(async()=>{
      const procs=allVideos.filter(v=>v.streamProcessing);
      const updates={};
      await Promise.all(procs.map(async v=>{
        try{
          const res=await fetch(`/api/videos/${encodeURIComponent(v.cloudId||v.id)}/url?prefer=${isMobile?'proxy':'auto'}`);
          if(!res.ok) return;
          const j=await res.json();
          if(j?.url) updates[v.id]={objectUrl:j.url,servedRendition:j.served||null,streamProcessing:false,thumbnailUrl:v.thumbnailUrl||j.thumbnail||null};
        }catch{}
      }));
      if(Object.keys(updates).length){
        setAllVideos(prev=>prev.map(v=>updates[v.id]?{...v,...updates[v.id]}:v));
        setSelectedVideo(prev=>(prev&&updates[prev.id])?{...prev,...updates[prev.id]}:prev);
      }
      setStreamPollTick(n=>n+1); // re-arm until no clip is processing
    },20000);
    return ()=>clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[allVideos,streamPollTick,isMobile]);

  // Throttled callback passed to VideoPlayer — ~12 fps max to keep renders light
  const handlePlayUtc=useCallback(utc=>{
    const now=performance.now();
    if(now-playUtcThrottle.current<80) return;
    playUtcThrottle.current=now;
    setPlayUtc(utc);
  },[]);

  // Resolve the effective auth role once on mount and re-resolve when the
  // active membership changes. Admin (global_role='admin') always wins.
  useEffect(()=>{
    let cancelled=false;
    async function resolve(){
      try{
        const supabase=getBrowserSupabase();
        // Verified user id — getClaims() checks the JWT signature locally against
        // the cached JWKS (asymmetric key), skipping the ~0.9s getUser() round-trip.
        // Fall back to getUser() if claims can't be verified. The admin decision
        // stays server-authoritative: the global_role read below is RLS-gated.
        let uid=null;
        try {
          if(typeof supabase.auth.getClaims==='function'){
            const {data:cl}=await supabase.auth.getClaims();
            uid=cl?.claims?.sub||null;
          }
        } catch { /* fall through to getUser */ }
        if(!uid){ const {data:{user}}=await supabase.auth.getUser(); uid=user?.id||null; }
        if(!uid||cancelled) return;
        const {data:profile}=await supabase.from('users').select('global_role').eq('id',uid).maybeSingle();
        if(cancelled) return;
        if(profile?.global_role==='admin'){ setEffectiveRole('admin'); return; }
        const m=getActiveMembership(uid);
        setEffectiveRole(m?.role||null);
      } catch { /* non-fatal */ }
    }
    resolve();
    const onChange=()=>resolve();
    window.addEventListener('ssa:active-membership-changed',onChange);
    return ()=>{ cancelled=true; window.removeEventListener('ssa:active-membership-changed',onChange); };
  },[]);

  // Campaign engine config for the active team. Null unless the team has
  // features.campaign_engine = true AND the active membership has a boat. When
  // set, it carries {teamId, boatId, members, targetDate, startDate} and
  // the Campaign tab becomes available.
  useEffect(()=>{
    let cancelled=false;
    async function run(){
      try{
        const supabase=getBrowserSupabase();
        const {data:{user}}=await supabase.auth.getUser();
        if(!user||cancelled) return;
        const m=getActiveMembership(user.id);
        if(!m||!m.team_id||!m.boat_id){ setCampaignCfg(null); return; }
        const res=await fetch(`/api/teams/${m.team_id}/campaign/config?boat_id=${m.boat_id}`);
        if(!res.ok||cancelled) return;
        const j=await res.json();
        if(cancelled) return;
        setCampaignCfg(j?.campaignOn ? {...j, teamId:m.team_id, boatId:m.boat_id, boatName:m.boat_name} : null);
      } catch { /* non-fatal — campaign tab just stays hidden */ }
    }
    run();
    const onChange=()=>run();
    window.addEventListener('ssa:active-membership-changed',onChange);
    return ()=>{ cancelled=true; window.removeEventListener('ssa:active-membership-changed',onChange); };
  },[]);

  // Workspace-switch isolation. When the user changes their active
  // membership via UserPill, in-memory `sessions` / `allVideos` still hold
  // the previous workspace's data — including LOCAL entries that belong to
  // another team's boat. Reset both, re-read local (now filtered by the new
  // membership) and re-fetch the cloud session list for the new workspace.
  // Without this, an admin switching teams keeps seeing the previous team's
  // folders in the sidebar.
  useEffect(()=>{
    async function rescope(){
      try{
        const supabase=getBrowserSupabase();
        const {data:{user}}=await supabase.auth.getUser();
        if(!user) return;
        const m=getActiveMembership(user.id);
        // Clear what we may still have from the previous workspace.
        setSessions([]);
        setAllVideos([]);
        setActiveDate(null);
        setSelectedVideo(null);
        setLogData(null);
        setXmlData(null);
        // Re-load filtered local data for the new workspace.
        const localSessions=getSessionsForMembership(m).sort((a,b)=>b.date.localeCompare(a.date));
        setSessions(localSessions);
        const vids=await getAllVideosForMembership(m);
        setAllVideos(vids);
        // Cloud list will be refreshed by the boot effect's
        // listSessionsCloud call when it re-runs; but to make the
        // switch feel instant, also trigger one here.
        const cloudSessions=await listSessionsCloud({userId:user.id});
        if(cloudSessions.length>0){
          setSessions(p=>{
            const merged=[...p];
            for(const s of cloudSessions){
              const existing=merged.find(x=>x.date===s.date);
              if(existing){
                if(!existing.videoCount && s.video_count) existing.videoCount=s.video_count;
                if(!existing.photoCount && s.photo_count) existing.photoCount=s.photo_count;
                if(s.event!==undefined) existing.event=s.event;
              }else{
                merged.push({date:s.date,source:'supabase',videoCount:s.video_count||0,photoCount:s.photo_count||0,event:s.event||null});
              }
            }
            return merged.sort((a,b)=>b.date.localeCompare(a.date));
          });
        }
        // Open the most recent day that has VIDEO data for the NEW boat, and load
        // it — so the switch lands on a populated folder with thumbnails already
        // loading, instead of a blank date the user has to click into.
        const localVideoDates=vids.map(v=>v.sessionDate).filter(Boolean);
        const cloudVideoDates=cloudSessions.filter(s=>s.video_count>0).map(s=>s.date);
        const bestDate=[...localVideoDates,...cloudVideoDates].sort().reverse()[0]
          || [...localSessions.map(s=>s.date),...cloudSessions.map(s=>s.date)].sort().reverse()[0]
          || null;
        if(bestDate) await loadDate(bestDate);
        // Warm the new boat's Boat Config tab too.
        if(m?.team_id&&m?.boat_id) prefetchBoatConfig(m.team_id,m.boat_id);
      }catch{ /* non-fatal — boot will retry */ }
    }
    const onChange=()=>{ rescope(); };
    window.addEventListener('ssa:active-membership-changed',onChange);
    return ()=>{ window.removeEventListener('ssa:active-membership-changed',onChange); };
  },[]);

  // Role-gated convenience flags. Default to permissive while role
  // resolves so UI doesn't briefly hide things from admins.
  // tl1: no SailScan, no analytics data (map OK), no SailScan-tagged photos.
  // guest: no SailScan, no SquashShots, no analytics data, no SailScan
  //   photos, only the latest session day shown.
  // consultant: full access — already gated by valid_from/valid_to via RLS.
  const canSeeSailScanTab     = !['tl1','guest'].includes(effectiveRole);
  const canSeeSquashShotsTab  = effectiveRole !== 'guest';
  // Tools tab (Squash + SailScan combined): TL2 and above, plus consultant (in-period).
  const canSeeToolsTab        = ['admin','team_manager','coach','tl3','tl2','consultant'].includes(effectiveRole);
  // Boat Config tab: TL3 and above (the senior team-leadership ladder). Not
  // visible to TL2 or lower. Edits (sails/polars/rig) are TL3+ via EDIT_ROLES
  // in BoatConfigTab and the DB RLS. Consultants (e.g. a sailmaker) also get
  // the tab but only see the Sail inventory + Sail data sub-tabs (Rig / Targets
  // / Log profile are hidden for them inside BoatConfigTab via canSeeTuning).
  const canSeeBoatConfig      = ['admin','team_manager','coach','tl3','consultant'].includes(effectiveRole);
  const canSeeAnalyticsData   = !['tl1','guest'].includes(effectiveRole);

  // Durability + background sync (Phase 4): ask for persistent storage so
  // unsynced captures survive eviction, and register an app-level pending-photo
  // flush that fires when the link improves / the app resumes (the iOS fallback
  // for the missing Background Sync API). Runs once for the app's lifetime.
  useEffect(()=>{
    requestPersistentStorage().catch(()=>{});
    const stop = startPhotoAutoFlush({});
    return stop;
  },[]);

  // Windweight MOS producer: when a session's log with on-board air-temp/sea-temp
  // /RH loads, store the hourly forecast-vs-observed windweight + Δheel samples
  // into windweight_samples for calculated-vs-observed analysis. Fire-and-forget,
  // idempotent per (boat, hour), guarded to logs that actually carry the sensors.
  useEffect(()=>{
    if(!logData?.rows?.length || !activeDate) return;
    let cancelled=false;
    (async()=>{
      let uid=null;
      try{ const {data:{user}}=await getBrowserSupabase().auth.getUser(); uid=user?.id||null; }catch{}
      if(cancelled||!uid) return;
      const am = getActiveMembership(uid);
      if(!am?.team_id || !am?.boat_id) return;
      const { storeWindweightSamples } = await import('../lib/windweightSamples');
      if(cancelled) return;
      storeWindweightSamples({ logData, sessionDate: activeDate, teamId: am.team_id, boatId: am.boat_id,
        tzOffsetMin: sessionTzOffset||0, mastHeight: 34 }).catch(()=>{});
    })();
    return ()=>{ cancelled=true; };
  },[logData, activeDate]); // eslint-disable-line react-hooks/exhaustive-deps
  const canSeeSailScanPhotos  = !['tl1','guest'].includes(effectiveRole);
  const canUseAI              = effectiveRole === null || !['tl1','consultant','guest'].includes(effectiveRole);
  const showOnlyLatestDay     = effectiveRole === 'guest';
  // Kept for backwards-compat with mobile shell prop; analytics tab is now
  // visible to every role (the content inside is what's gated).
  const canSeeAnalytics = true;
  // Campaign tab available only when the active team has the engine on.
  const campaignOn = !!campaignCfg;
  // Open a clip referenced from a debrief note: switch to the Library tab,
  // load that date if needed, and select the clip. loadDate honours the
  // pending-clip ref at its first paint (see below).
  const campaignPendingClipRef = React.useRef(null);
  const openCampaignVideo = async (date, clipId) => {
    campaignPendingClipRef.current = clipId || null;
    setActiveTab("library");
    if (date && date !== activeDate) {
      await loadDate(date);
    } else {
      setSelectedVideo(prev => {
        const m = allVideos.find(v => v.id === clipId || v.cloudId === clipId || v.externalId === clipId);
        return m || prev;
      });
      campaignPendingClipRef.current = null;
    }
  };

  // Timeline → play a clip in a modal overlay with the full instrument data
  // overlay, WITHOUT leaving the timeline. Loads that day's log/telemetry so
  // the overlay has data, resolves the clip into selectedVideo (loadDate does
  // this via campaignPendingClipRef), then opens the modal.
  const openVideoModal = async (date, clipId) => {
    campaignPendingClipRef.current = clipId || null;
    if (date && date !== activeDate) {
      await loadDate(date);
    } else {
      setSelectedVideo(prev => {
        const m = allVideos.find(v => v.id === clipId || v.cloudId === clipId || v.externalId === clipId);
        return m || prev;
      });
      campaignPendingClipRef.current = null;
    }
    setVideoModalOpen(true);
  };

  // Sessions visible in the sidebar — guests see only the latest day.
  const visibleSessions = useMemo(
    () => showOnlyLatestDay && sessions.length ? [sessions[0]] : sessions,
    [sessions, showOnlyLatestDay]
  );

  // When SailScan (or SquashShots) saves a new photo + creates a session,
  // they emit a CustomEvent so the sessions sidebar and PhotosTab can pick
  // up the new date without requiring a full page reload. We also use this
  // hook to mirror the photo's metadata into Supabase (active membership
  // scope) so teammates see it without re-importing.
  useEffect(()=>{
    const refresh=async (e)=>{
      try{
        const sx=getSessions().sort((a,b)=>b.date.localeCompare(a.date));
        setSessions(sx);
      }catch(err){console.warn("[ssa:photo-saved] refresh failed",err);}

      // Mirror the saved photo to Supabase. The CustomEvent detail carries
      // {id, date, source}; the full metadata lives in localStorage.
      try {
        const detail = e?.detail || {};
        if(!detail.id || !detail.date) return;
        const supabase=getBrowserSupabase();
        const {data:{user}}=await supabase.auth.getUser();
        if(!user) return;
        const list = JSON.parse(localStorage.getItem(`ssa:photos-meta:${detail.date}`) || "[]");
        const photo = list.find(p => p.id === detail.id);
        if(!photo) return;
        await upsertPhotoCloud({
          userId: user.id,
          sessionDate: detail.date,
          takenUtc: photo.utc,
          exif: photo.exif,
          thumbnailUrl: photo.thumbnailUrl,
          bunnyStoragePath: photo.bunnyPath || photo.url || null,
          bytes: photo.size,
          analysis: photo.analysis,
        });
      } catch(err) { /* non-fatal */ }
    };
    window.addEventListener("ssa:photo-saved",refresh);
    return ()=>window.removeEventListener("ssa:photo-saved",refresh);
  },[]);

  // Seamless photo sync (like videos): on app open / tab refocus / coming back
  // online, push any pending photo THUMBNAILS (with their tags) immediately and
  // full ORIGINALS when on a good (WiFi) connection. No user action required.
  useEffect(()=>{
    if(!cloudStatus?.available) return;
    const flush=()=>{ if(cloudStatus?.available) syncPendingPhotos({}).catch(()=>{}); };
    flush(); // on open / when cloud becomes available
    const onVis=()=>{ if(typeof document!=="undefined" && document.visibilityState==="visible") flush(); };
    if(typeof document!=="undefined") document.addEventListener("visibilitychange",onVis);
    if(typeof window!=="undefined") window.addEventListener("online",flush);
    return ()=>{
      if(typeof document!=="undefined") document.removeEventListener("visibilitychange",onVis);
      if(typeof window!=="undefined") window.removeEventListener("online",flush);
    };
  },[cloudStatus?.available]);

  useEffect(()=>{
    async function boot(){
      const today=TODAY();
      // ── STARTUP PROFILING ────────────────────────────────────────────────
      // Cheap phase timing so a single cold load reveals the bottleneck. Open the
      // browser console and filter for "[boot]". Each line is ms since boot start;
      // the big jumps are your slow steps. Remove once the culprit is found.
      const _pt0=performance.now();
      const _pm=(label)=>{ try{ console.info(`[boot] ${label}: +${Math.round(performance.now()-_pt0)}ms`); }catch{ /* */ } };
      // Read the active membership BEFORE pulling local data so we only show
      // sessions/videos belonging to the current workspace. Untagged legacy
      // entries are visible only when there is no active membership.
      const supaForBoot = getBrowserSupabase();
      // Fast path: read the user from the STORED session (cookie), not the
      // /auth/v1/user endpoint. getUser() is a ~0.9s round-trip that was gating
      // FIRST PAINT; getSession() is local. Safe here because (a) every cloud
      // read is RLS-gated — the JWT sent with each request is what the server
      // validates, so a stale/tampered session yields empty results, never
      // another tenant's data — and (b) the admin gate is resolved separately by
      // a verified getUser + users.global_role lookup (see effectiveRole effect).
      const { data: { session: bootSession } } = await supaForBoot.auth.getSession();
      const bootUser = bootSession?.user || null;
      authUserRef.current = bootUser;   // seed cache; onAuthStateChange keeps it fresh
      const bootMembership = bootUser ? getActiveMembership(bootUser.id) : null;
      _pm('auth.getSession + membership (local, no round-trip)');
      // Revalidate the session in the background — does not block paint. Prefer
      // getClaims(): with the project's asymmetric signing key it verifies the JWT
      // locally against the cached JWKS (no /auth/v1/user round-trip). Only when
      // the signature/subject can't be confirmed do we fall back to the
      // authoritative getUser(), so a transient JWKS fetch failure can't wrongly
      // drop the cached user. Corrects the cache if the server disagrees.
      (async()=>{
        try {
          if(typeof supaForBoot.auth.getClaims==='function'){
            const { data:cl } = await supaForBoot.auth.getClaims();
            const sub = cl?.claims?.sub || null;
            if(!sub){ authUserRef.current=null; return; }
            if(authUserRef.current && authUserRef.current.id===sub) return; // seeded user confirmed
            const { data:{ user:v } } = await supaForBoot.auth.getUser();
            authUserRef.current = v || null;
            return;
          }
        } catch { /* fall through to getUser */ }
        try { const { data:{ user:v } } = await supaForBoot.auth.getUser(); authUserRef.current = v || null; } catch { /* */ }
      })();
      const localSessions=getSessionsForMembership(bootMembership).sort((a,b)=>b.date.localeCompare(a.date));setSessions(localSessions);
      _pm(`local sessions (${localSessions.length})`);

      // Drop clips that have neither a local blob nor a cloud copy — they can't be
      // played, thumbnailed or uploaded, so they're pure noise in the library. These
      // are the leftovers of the Android "skip blob on mobile" bug; crew (TL3) can't
      // delete clips themselves, so the app clears them out on load.
      try {
        const nDead = await pruneInertVideos();
        if (nDead) addLog(`🧹 Removed ${nDead} unusable clip${nDead === 1 ? '' : 's'} (no video data, never reached the cloud) — re-import to upload them.`);
        // Collapse duplicate rows left by retried imports — each copy was separately
        // queued to sync, so the same footage would upload several times over.
        const nDupe = await dedupeVideos();
        if (nDupe) addLog(`🧹 Merged ${nDupe} duplicate clip entr${nDupe === 1 ? 'y' : 'ies'} from repeated imports.`);
      } catch { /* non-fatal */ }
      _pm('prune + dedupe');

      // ── Mobile progressive load ───────────────────────────────────────────
      // On mobile we only fetch full video blobs + log data for the latest session.
      // Older sessions show thumbnail/metadata only — full data loads on-demand.
      const vids=await getAllVideosForMembership(bootMembership);
      _pm(`getAllVideos (${vids.length} clips, blob URLs minted)`);
      // Open the most recent day that actually has VIDEO footage — skip log-only
      // or empty days (and today, if nothing was shot today). Falls back to the
      // latest session day, then today, when there's no video anywhere.
      const videoDates=vids.map(v=>v.sessionDate).filter(Boolean).sort();
      const latestVideoDate=videoDates.length?videoDates[videoDates.length-1]:null;
      const latestDate=latestVideoDate||localSessions[0]?.date||today;
      const isRecent=(date)=>date===today||date===latestDate;
      // On mobile: skip expensive enrichVideo (requires full log read) for old sessions.
      // Clips share dates (e.g. 10 sessions ⇒ ~10 unique days but ~100 clips), so read
      // each day's log+xml ONCE and reuse. Reading them per-clip re-deserialised the same
      // big day-logs from IndexedDB ~N times and was the dominant first-paint cost
      // (~6s for 97 clips). Cache the PROMISE so concurrent map() calls dedupe too.
      const _lxCache=new Map();
      const _getLX=(d)=>{ let p=_lxCache.get(d); if(!p){ p=(async()=>({log:await getLogData(d),xml:await getXmlData(d)}))(); _lxCache.set(d,p); } return p; };
      const enriched=await Promise.all(vids.map(async v=>{
        const d=v.sessionDate||today;
        if(isMobile && !isRecent(d)) return v; // mobile: skip log read for old clips
        const {log,xml}=await _getLX(d);
        return enrichVideo(v,log,xml);
      }));
      setAllVideos(enriched);
      _pm('enrich videos (log+xml reads)');
      if(enriched.length>0)setSelectedVideo(enriched[0]);

      // Reuse the per-date cache — latestDate was almost always already read above.
      const {log:latestLog,xml:latestXml}=await _getLX(latestDate);
      if(latestLog){setLogData({...latestLog,source:"local"});setSessionTzOffset(latestLog.tzOffset??DEFAULT_TZ);}
      if(latestXml)setXmlData({...latestXml,source:"local"});
      setActiveDate(latestDate);
      // Tag list — paint from the LOCAL list immediately, then refresh from the
      // cloud in the background. cloudFetchTagList is a network round-trip that was
      // sitting in the pre-paint path (~1.3s of first paint on a real load).
      setSessionTagList(getTagList(latestDate));
      if(bootUser){
        cloudFetchTagList({userId:bootUser.id,date:latestDate})
          .then(tl=>{ if(tl) setSessionTagList(tl); })
          .catch(()=>{});
      }
      const latestSession=localSessions.find(s=>s.date===latestDate);
      if(latestSession?.tzOffset!=null)setSessionTzOffset(latestSession.tzOffset);
      setUnsyncedCount(getUnsyncedCount());setLoaded(true);
      _pm('★ FIRST PAINT (loaded=true)');

      // Cloud check — on mobile defer until after paint
      const doCloud=async()=>{
        _pm('cloud: start');
        const cs=await checkCloudStatus();setCloudStatus(cs);
        _pm('cloud: checkCloudStatus');
        // Bunny R2 session listing is GLOBAL — every date in the zone, every
        // team. Historically only admins saw it; now we skip it entirely when
        // a workspace is active (per-team isolation wins). The Supabase
        // session list below is the team-scoped source of truth.
        if(cs?.available && effectiveRole==='admin' && !bootMembership){
          const remote=await listR2Sessions();
          const localDates=new Set(localSessions.map(s=>s.date));
          const newR=remote.filter(s=>!localDates.has(s.date));
          if(newR.length>0)setSessions(p=>[...p,...newR].sort((a,b)=>b.date.localeCompare(a.date)));
        }
        // Supabase sessions list (active membership scope) — merge into UI.
        try {
          const user=bootUser;   // reuse — no third auth.getUser round-trip
          if(user){
            // <UserPill> resolves the active membership and writes it to
            // localStorage asynchronously. On a first login — especially
            // mobile on slow wifi — that can land well after this boot step,
            // which would make the cloud session list come back empty and
            // leave the app blank until a manual Sync. Wait for it (up to
            // ~20s; the loop exits the instant the membership appears).
            const _wl=performance.now(); let _wi=0;
            for(;_wi<80 && !getActiveMembership(user.id);_wi++){
              await new Promise(r=>setTimeout(r,250));
            }
            _pm(`cloud: membership-wait (${Math.round(performance.now()-_wl)}ms, ${_wi} polls)`);
            // Eagerly warm the Boat Config tab (sails/scans/polar/rig) so it's
            // ready before the user opens it. Fire-and-forget.
            { const am=getActiveMembership(user.id); if(am?.team_id&&am?.boat_id) prefetchBoatConfig(am.team_id,am.boat_id); }
            const cloudSessions=await listSessionsCloud({userId:user.id});
            _pm(`cloud: listSessionsCloud (${cloudSessions.length} sessions)`);
            if(cloudSessions.length>0){
              setSessions(p=>{
                const merged=[...p];
                for(const s of cloudSessions){
                  const existing=merged.find(m=>m.date===s.date);
                  if(existing){
                    // Fill in the cloud video/photo counts if the local entry lacks them.
                    if(!existing.videoCount && s.video_count) existing.videoCount=s.video_count;
                    if(!existing.photoCount && s.photo_count) existing.photoCount=s.photo_count;
                    // Campaign event name (regatta) — cloud is the source of truth.
                    if(s.event!==undefined) existing.event=s.event;
                  }else{
                    merged.push({date:s.date, source:'supabase', videoCount:s.video_count||0, photoCount:s.photo_count||0, event:s.event||null});
                  }
                }
                return merged.sort((a,b)=>b.date.localeCompare(a.date));
              });
              // Pick the freshest session of either tier and jump there.
              // Previously we only jumped to the newest cloud date when
              // the user had ZERO local clips on the local-latest date —
              // which meant someone with stale May-20 clips on their
              // phone stayed on May 20 even though the cloud had a May-27
              // session ready. Now we always land on max(latest local,
              // newest cloud), so a refresh after a coach's desktop sync
              // takes mobile straight to the new session and auto-fills
              // its thumbnails via loadDate.
              //
              // Uses `latestDate` (the date boot() actually set active)
              // rather than the `activeDate` state var — that one's a
              // stale closure, frozen at TODAY() from the initial render.
              // Prefer the newest day that actually has VIDEO data (video_count>0)
              // across local + cloud; only fall back to the newest session day
              // when there's no video anywhere.
              const newestCloudVideoDate = cloudSessions
                .filter(s => s.video_count > 0).map(s => s.date).sort().reverse()[0];
              const newestCloudDate = cloudSessions.map(s => s.date).sort().reverse()[0];
              const haveVideo = latestVideoDate || newestCloudVideoDate;
              const bestDate = haveVideo
                ? [latestVideoDate, newestCloudVideoDate].filter(Boolean).sort().reverse()[0]
                : [latestDate, newestCloudDate].filter(Boolean).sort().reverse()[0];
              if (bestDate && bestDate !== latestDate) {
                await loadDate(bestDate);
                _pm(`cloud: loadDate(${bestDate})`);
              }
            }
          }
        } catch { /* non-fatal */ }
        _pm('cloud: done');
      };
      if(isMobile) setTimeout(doCloud,1500); else doCloud();
    }
    boot();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  async function loadDate(date){
    const _lt0=performance.now(); const _lm=(l)=>{ try{ console.info(`[loadDate] ${l}: +${Math.round(performance.now()-_lt0)}ms`); }catch{ /* */ } };
    const loadSeq = ++loadDateSeqRef.current;   // this call's turn; latest wins
    setActiveDate(date);
    // Reset video thumbnail load tracking for the new date
    setVideoThumbsLoading(true);
    setVideoLoadedIds(new Set());
    setVideoTotalThumbs(0);
    setStreamPollTick(0); // fresh encoding-poll budget for the new session

    // ── Load log + xml — LOCAL ONLY here. The cloud download (getSessionCloud,
    // ~2.4s cold) is deferred to a background pass AFTER the video grid paints
    // (see end of function). The grid's thumbnails come from the inline Bunny
    // poster, not the day-log, so there's no reason to block clips-visible on it.
    let log = await getLogData(date);
    let xml = await getXmlData(date);
    _lm('local log+xml');

    // Reflect local state immediately — and clear the previous date's overlay.
    // Null when this is a cloud-only day; the background pass fills it in when
    // the download lands.
    setLogData(log?{...log,source:log.source||"local"}:null);
    if(log)setSessionTzOffset(log.tzOffset??DEFAULT_TZ);
    setXmlData(xml?{...xml,source:xml.source||"local"}:null);

    // Self-heal sync state against the cloud manifest, then refresh the unsynced
    // badge — so a log/xml already in the cloud (from another device or a lost
    // local flag) is recognised as synced and never re-uploaded (Phase 2).
    reconcileSessionSyncState(date).then(()=>setUnsyncedCount(getUnsyncedCount())).catch(()=>{});
    // ── Load videos ─────────────────────────────────────────────────────────
    let vids=await getVideosForDate(date);
    if(!vids.length){const all=await getAllVideos();vids=all.filter(v=>v.sessionDate===date);}
    _lm('local video rows');
    // Merge Supabase rows in. A clip can exist BOTH on this device (local
    // IDB, has the blob) and in Supabase (a cloud row). They must collapse
    // to ONE entry, or the library shows duplicates and batch-sync tries to
    // sync the blob-less cloud copy. The link is external_id (the cloud row
    // stores the local IDB id it was mirrored from); legacy rows fall back
    // to a bunny_stream_id match. When a match is found we keep the LOCAL
    // entry (its id + blob drive transcode/upload/crop) and copy the cloud
    // rendition state onto it; the cloud UUID is stashed as `cloudId` for
    // rendition PATCH + playback-URL resolution.
    try {
      const user=await getUserCached();
      _lm('getUser #3 (cached)');
      if(user){
        const cloudVids=await listVideosCloud({userId:user.id,date});
        _lm(`listVideosCloud (${cloudVids.length} clips)`);
        if(cloudVids.length){
          const localById=new Map(vids.map(v=>[v.id,v]));
          const localByStream=new Map(vids.filter(v=>v.streamId).map(v=>[v.streamId,v]));
          for(const cv of cloudVids){
            const shaped=toLegacyVideoShape(cv);
            const local=(shaped.externalId && localById.get(shaped.externalId))
                      || (cv.bunny_stream_id && localByStream.get(cv.bunny_stream_id))
                      || null;
            if(local){
              // Always link the cloud row so a later resync targets the
              // same Supabase entry. Only adopt the cloud's rendition
              // flags (hasProxy / hasOriginal / streamId) when the local
              // blob is in sync with what's actually uploaded — measured
              // by comparing localBlobModifiedAt (stamped on every crop)
              // against the cloud's proxy_uploaded_at. Without a stamp on
              // the local entry the cloud is assumed fresh, so legacy
              // already-uploaded clips don't get re-queued for sync.
              local.cloudId=shaped.id;
              // Tags are CLOUD-AUTHORITATIVE: every editor path now pushes
              // the tag set to the videos row, so adopting the cloud's
              // tags on every load propagates desktop edits to mobile (and
              // vice versa). Without this the merge kept the device's
              // stale IDB tags forever.
              if(Array.isArray(shaped.tags)) local.tags=shaped.tags;
              // startUtc is CLOUD-AUTHORITATIVE too — same reasoning as tags, and
              // for a bug that was live on 2026-07-11: the TIMELINE reads
              // videos.start_utc straight from the API, while the library, the
              // player and Analytics read this merged LOCAL entry. With no adoption
              // here the two stores drift and the SAME clip renders at two different
              // times (timeline 14:32, player 12:32). Take the cloud's start time and
              // write it back into IDB so both stores converge instead of arguing.
              if(shaped.startUtc!=null && shaped.startUtc!==local.startUtc){
                local.startUtc=shaped.startUtc;
                updateVideoStartUtc(local.id,shaped.startUtc).catch(()=>{});
              }
              const localMtime = local.localBlobModifiedAt || 0;
              const proxyMtime = shaped.proxyUploadedAt ? new Date(shaped.proxyUploadedAt).getTime() : 0;
              const origMtime  = shaped.originalUploadedAt ? new Date(shaped.originalUploadedAt).getTime() : 0;
              const cloudMtime = Math.max(proxyMtime, origMtime);
              const cloudFresh = localMtime === 0 || cloudMtime >= localMtime;
              if(cloudFresh){
                local.hasProxy=shaped.hasProxy;
                local.hasOriginal=shaped.hasOriginal;
                local.originalStreamId=shaped.originalStreamId;
                if(shaped.streamId && !local.streamId) local.streamId=shaped.streamId;
              }
            } else {
              vids.push(shaped); // cloud-only clip (uploaded from another device)
            }
          }
        }
      }
    } catch { /* non-fatal */ }

    // Admin fallback — if the boat-scoped query found nothing, try the
    // legacy single-tenant cloud session. Done BEFORE the first paint so
    // those clips are part of the early render.
    if(!vids.length&&cloudStatus?.available&&effectiveRole==='admin'){const r2=await fetchCloudSession(date);if(r2?.videos?.length)vids=r2.videos;}

    // Re-enrich the current vids array with log + xml + sync offsets.
    const enrichAll=()=>vids.map(v=>enrichVideo(v,log,xml,syncOffsets));

    // EARLY PAINT — render the cards now. The videos GET route attaches each
    // clip's Bunny poster thumbnail inline, so the library can show an image
    // immediately instead of waiting on a per-clip signed-URL round-trip.
    // Playback URLs are resolved below in the background; that triggers a
    // second, cheap re-render once they land.
    _lm('video cloud-merge done → early paint');
    {
      const early=enrichAll();
      setAllVideos(early);
      setVideoTotalThumbs(early.filter(v => v.thumbnailUrl || (v.objectUrl && v.source!=="cloud")).length);
      setVideoThumbsLoading(false);
      const pend=campaignPendingClipRef.current;
      const match=pend?early.find(v=>v.id===pend||v.cloudId===pend||v.externalId===pend):null;
      setSelectedVideo(match||early[0]||null);
      if(pend) campaignPendingClipRef.current=null;
    }

    // ── Background: cloud day-log/xml + tag list + timeline ──────────────────
    // The grid is already on screen. The day-log is only needed for the on-clip
    // instrument overlay and auto-tags, so download it now (this is the ~2.4s
    // getSessionCloud that used to gate the grid) and re-enrich when it lands.
    // Guarded by loadSeq so a fast date switch can't clobber the newer date.
    (async()=>{
      try {
        let logChanged=false, xmlChanged=false;
        if(!log || !xml){
          const user=await getUserCached();
          if(user){
            const cs=await getSessionCloud({userId:user.id,date});
            _lm('getSessionCloud (log_data+xml_data download)');
            if(cs){
              if(!log && cs.log_data){ log={...cs.log_data,source:'supabase'}; logChanged=true; }
              if(!xml && cs.xml_data){ xml={...cs.xml_data,source:'supabase'}; xmlChanged=true; }
            }
          }
        }
        // Admin-only GLOBAL Bunny R2 fallback for a day with no team-scoped
        // log/xml. Everyone else stays inside their team's RLS-protected data.
        if((!log || !xml) && cloudStatus?.available && effectiveRole==='admin'){
          const r2=await fetchCloudSession(date);
          if(!log && r2?.logData){ log={...r2.logData,source:'cloud'}; logChanged=true; }
          if(!xml && r2?.xmlData){ xml={...r2.xmlData,source:'cloud'}; xmlChanged=true; }
        }
        if(loadDateSeqRef.current!==loadSeq) return; // superseded by a newer loadDate

        if(logChanged && log){ setLogData({...log,source:log.source||"cloud"}); setSessionTzOffset(log.tzOffset??DEFAULT_TZ); }
        if(xmlChanged && xml){ setXmlData({...xml,source:xml.source||"cloud"}); }

        // Auto-build this day's Timeline Tree (needs xml) — best-effort, persists
        // to timeline_nodes. Backfills days uploaded before the producer existed.
        try {
          if(xml && campaignCfg?.teamId && campaignCfg?.boatId){
            const tlNodes=buildDayTimeline({ xml, boatId: campaignCfg.boatId, date });
            if(tlNodes.length){
              fetch(`/api/teams/${campaignCfg.teamId}/timeline`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ boat_id: campaignCfg.boatId, session_date: date, nodes: tlNodes })}).catch(()=>{});
            }
          }
        } catch {}
        _lm('xml + timeline build');

        // Re-enrich the grid now that the day-log/xml is in — overlay averages
        // and auto-tags populate. Keep the current selection, refreshed.
        if(logChanged || xmlChanged){
          const re=vids.map(v=>enrichVideo(v,log,xml,syncOffsets));
          setAllVideos(re);
          setSelectedVideo(prev=> prev ? (re.find(v=>v.id===prev.id)||prev) : prev);
        }
      } catch { /* non-fatal */ }

      // Tag list (cloud-backed when signed in) — also off the paint path.
      try {
        const user=await getUserCached();
        if(loadDateSeqRef.current!==loadSeq) return;
        if(user) setSessionTagList(await cloudFetchTagList({userId:user.id,date}));
        else setSessionTagList(getTagList(date));
      } catch { setSessionTagList(getTagList(date)); }
      _lm('tag list');
    })();

    // Playback URLs are NOT resolved here any more. Fetching a signed URL for every
    // clip on the day was ~one request per clip and the dominant cold-start cost
    // (boot profiling showed loadDate at ~4.7s for a 30-clip day). The grid cards
    // render from the inline Bunny poster attached by the videos GET route; a clip's
    // signed playback URL is resolved lazily by ensureClipUrl the moment it becomes
    // the selected clip (see the resolve-on-select effect above). A clip with a local
    // blob still plays from that immediately. The encoding poller keeps refreshing
    // any clip still transcoding.
  }

  // Run the proxy auto-sync queue until it's empty. Returns the in-flight
  // drain promise so callers (the batch flow) can await completion; repeated
  // calls while running return the same promise rather than starting a
  // second drain.
  function processAutoSyncQueue(){
    if (autoSyncRef.current.activePromise) return autoSyncRef.current.activePromise;
    autoSyncRef.current.activePromise = (async () => {
    if (syncClearTimerRef.current) { clearTimeout(syncClearTimerRef.current); syncClearTimerRef.current = null; }
    autoSyncRef.current.running = true;
    try {
      while (autoSyncRef.current.queue.length > 0) {
        const item = autoSyncRef.current.queue.shift();
        const idx = autoSyncRef.current.done + 1;
        const total = autoSyncRef.current.total;
        const label = item.label || `clip ${idx}`;

        setMobileSyncState({
          phase: 'pushing',
          message: `Preparing ${idx}/${total} · ${label}`,
          progress: 0,
        });

        try {
          // Need an authed user — without it we have no Supabase row to
          // mark the proxy against. Quietly skip; the user can sync
          // manually once they sign in.
          const supabase = getBrowserSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) { addLog(`✕ ${label}: not signed in — cannot upload.`); autoSyncRef.current.failed++; autoSyncRef.current.done = idx; continue; }

          // Source blob from IDB. If it's missing (e.g. mobile-skipped
          // storage on a small device) the user has no way to re-upload
          // from here; flag and move on.
          const blob = await getVideoBlob(item.videoId);
          if (!blob) {
            console.warn('[autoSync] no local blob for', item.videoId);
            addLog(`✕ ${label}: no video data on this device — re-import the clip.`);
            noteSyncError(label,'no video data on this device — re-import the clip');
            autoSyncRef.current.failed++;
            autoSyncRef.current.done = idx; continue;
          }

          // Find the in-memory video record for ensureCloudVideoId to work
          // out title/duration/etc.
          const localVid = allVideosRef.current.find(v => v.id === item.videoId)
                          || { id: item.videoId, sessionDate: item.sessionDate };

          const cloudId = await ensureCloudVideoId({
            userId: user.id,
            video: localVid,
            sessionDate: item.sessionDate,
          });
          if (!cloudId) {
            console.warn('[autoSync] no cloud row for', item.videoId);
            addLog(`✕ ${label}: no active boat workspace — can't create the cloud entry.`);
            noteSyncError(label,"no active boat workspace — can't create the cloud entry");
            autoSyncRef.current.failed++;
            autoSyncRef.current.done = idx; continue;
          }

          await syncProxyForVideo({
            videoId: cloudId,
            sessionDate: item.sessionDate,
            source: blob,
            onProgress: ({phase, pct, message}) => {
              // Phase leads the message so it stays visible even where the
              // progress line is narrow (the clip name is what gets clipped,
              // not the phase the user needs to see).
              const phaseLabel = phase === 'transcoding' ? 'Compressing'
                               : phase === 'uploading'   ? 'Uploading'
                               : phase === 'marking'     ? 'Finalizing'
                               : phase;
              setMobileSyncState({
                phase: 'pushing',
                message: `${phaseLabel} ${idx}/${total} · ${label}`,
                progress: Math.round((pct||0) * 100),
              });
            },
          });

          // Update the live UI so the clip's "proxy ready" badge shows up
          // without waiting for a manual refresh.
          setAllVideos(p => p.map(v => v.id === item.videoId
            ? {...v, hasProxy: true, cloudId, streamProcessing: true, proxyUploadedAt: new Date().toISOString()}
            : v));
        } catch (e) {
          // Surface it. Silently swallowing this is what made an upload "succeed"
          // in a second while nothing left the phone.
          console.error('[autoSync] failed for', item.videoId, e);
          addLog(`✕ ${label}: ${e?.message || 'upload failed'}`);
          noteSyncError(label, e?.message || 'upload failed');
          autoSyncRef.current.failed++;
        }
        autoSyncRef.current.done = idx;
      }
    } finally {
      autoSyncRef.current.running = false;
      // Report the TRUTH. This used to always say "✓ Synced N" even when every clip
      // had failed — which is precisely why an instant no-op looked like a success.
      const nFailed = autoSyncRef.current.failed || 0;
      const nOk = Math.max(0, autoSyncRef.current.done - nFailed);
      if (nFailed) {
        setMobileSyncState({
          phase: 'error',
          message: `${nFailed} clip${nFailed===1?'':'s'} failed to upload — see the log`,
          progress: 0,
        });
      } else {
        setMobileSyncState({ phase: 'done', message: `✓ Synced ${nOk} clip${nOk===1?'':'s'}`, progress: 100 });
      }
      autoSyncRef.current.done = 0;
      autoSyncRef.current.total = 0;
      autoSyncRef.current.failed = 0;
      // A SUCCESS may fade; a FAILURE must not. It used to auto-clear after a few
      // seconds, so the one thing the user needed to read was the one thing they
      // couldn't. Errors now stay until dismissed (or until the next upload run).
      if (!nFailed) {
        syncClearTimerRef.current = setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 3000);
      }
    }
    })();
    autoSyncRef.current.activePromise.finally(() => { autoSyncRef.current.activePromise = null; });
    return autoSyncRef.current.activePromise;
  }

  // ── Phase B.3 originals queue ───────────────────────────────────────────────
  // Add session clips to the originals upload queue. Skips anything already
  // uploaded or already queued.
  function enqueueOriginals(videos, sessionDate){
    if (!videos?.length) return;
    const queued = new Set(originalsSyncRef.current.queue.map(it => it.videoId));
    const items = videos
      .filter(v => !v.hasOriginal && !queued.has(v.id))
      // Each clip keeps its OWN session date — not the batch-wide one — so a
      // May-19 clip can't be filed under a May-20 cloud session.
      .map(v => ({ videoId: v.id, sessionDate: v.sessionDate || sessionDate, label: v.title || v.name || v.id }));
    if (!items.length) return;
    originalsSyncRef.current.queue.push(...items);
    originalsSyncRef.current.total += items.length;
  }

  // Drain the originals queue — uploads the full-resolution source bytes
  // (no transcode). Runs only when the user explicitly presses the
  // "Upload originals" button; originals are multi-GB so they are never
  // uploaded automatically.
  async function processOriginalsQueue(){
    if (originalsSyncRef.current.running) return;
    if (autoSyncRef.current.activePromise) return;        // let proxies finish first
    if (!originalsSyncRef.current.queue.length) return;
    if (syncClearTimerRef.current) { clearTimeout(syncClearTimerRef.current); syncClearTimerRef.current = null; }
    originalsSyncRef.current.running = true;
    try {
      while (originalsSyncRef.current.queue.length > 0) {
        const item = originalsSyncRef.current.queue.shift();
        const idx = originalsSyncRef.current.done + 1;
        const total = originalsSyncRef.current.total;
        const label = item.label || `clip ${idx}`;

        setMobileSyncState({ phase: 'pushing', message: `Uploading HD ${idx}/${total} · ${label}`, progress: 0 });

        try {
          const supabase = getBrowserSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) { originalsSyncRef.current.done = idx; continue; }

          const blob = await getVideoBlob(item.videoId);
          if (!blob) {
            console.warn('[originals] no local blob for', item.videoId);
            addLog(`✕ ${label}: no video data on this device — re-import the clip.`);
            noteSyncError(label,'no video data on this device — re-import the clip');
            originalsSyncRef.current.failed = (originalsSyncRef.current.failed||0) + 1;
            originalsSyncRef.current.done = idx; continue;
          }

          const localVid = allVideosRef.current.find(v => v.id === item.videoId)
                          || { id: item.videoId, sessionDate: item.sessionDate };
          const cloudId = await ensureCloudVideoId({
            userId: user.id,
            video: localVid,
            sessionDate: item.sessionDate,
          });
          if (!cloudId) {
            console.warn('[originals] no cloud row for', item.videoId);
            originalsSyncRef.current.done = idx; continue;
          }

          // Bunny Stream's TUS metadata wants a File (name + type).
          const safeName = `${(label || cloudId)}`.replace(/[^\w.-]+/g, '_');
          const fileForUpload = new File([blob], `${safeName}.mp4`, {
            type: blob.type || 'video/mp4',
          });

          // Reuse a Stream video object from a prior unfinished attempt so the
          // TUS client resumes it; otherwise create a fresh one.
          let streamId = getPendingOrigStream(item.videoId);
          if (!streamId) {
            const created = await createStreamUpload(label || cloudId, blob.size);
            streamId = created?.streamId || null;
            if (streamId) setPendingOrigStream(item.videoId, streamId);
          }
          if (!streamId) {
            console.warn('[originals] could not create Stream video for', item.videoId);
            originalsSyncRef.current.done = idx; continue;
          }

          // Resumable TUS upload to Bunny Stream. uploadFileToStream auto-
          // retries dropped chunks and resumes from localStorage; a hard
          // failure leaves the pending streamId so the next run continues it.
          const uploaded = await uploadFileToStream(
            { streamId },
            fileForUpload,
            (pct) => {
              setMobileSyncState({
                phase: 'pushing',
                message: `Uploading HD ${idx}/${total} · ${label}`,
                progress: pct,
              });
            }
          );
          if (!uploaded) {
            console.warn('[originals] Stream upload interrupted for', item.videoId);
            originalsSyncRef.current.done = idx; continue;
          }

          // Record the original (its Bunny Stream GUID) on the Supabase row.
          try {
            const patchRes = await fetch(
              `/api/videos/${encodeURIComponent(cloudId)}/renditions`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ original: { streamId } }),
              }
            );
            if (!patchRes.ok) {
              const j = await patchRes.json().catch(() => null);
              console.warn('[originals] renditions PATCH failed:', j?.error || patchRes.status);
            }
          } catch (e) {
            console.warn('[originals] renditions PATCH threw:', e);
          }

          clearPendingOrigStream(item.videoId);
          setAllVideos(p => p.map(v => v.id === item.videoId
            ? { ...v, hasOriginal: true, originalStreamId: streamId }
            : v));
        } catch (e) {
          console.error('[originals] failed for', item.videoId, e);
          addLog(`✕ ${label}: ${e?.message || 'original upload failed'}`);
          noteSyncError(label, e?.message || 'original upload failed');
          originalsSyncRef.current.failed = (originalsSyncRef.current.failed||0) + 1;
        }
        originalsSyncRef.current.done = idx;
      }
    } finally {
      originalsSyncRef.current.running = false;
      const nFailed = originalsSyncRef.current.failed || 0;
      const nOk = Math.max(0, originalsSyncRef.current.done - nFailed);
      if (nFailed) {
        setMobileSyncState({ phase: 'error', message: `${nFailed} original${nFailed===1?'':'s'} failed — see the log`, progress: 0 });
      } else {
        setMobileSyncState({ phase: 'done', message: `✓ Uploaded ${nOk} original${nOk===1?'':'s'}`, progress: 100 });
      }
      originalsSyncRef.current.done = 0;
      originalsSyncRef.current.total = 0;
      originalsSyncRef.current.failed = 0;
      if (!nFailed) {
        syncClearTimerRef.current = setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 3500);
      }
    }
  }

  // Batch "Sync proxies" — coach/admin button. Transcodes + uploads every
  // un-proxied clip in the session. Proxies ONLY — the full-resolution
  // originals are a separate, deliberate action (handleBatchUploadOriginals)
  // so a slow link is never hit with a multi-GB upload by surprise.
  async function handleBatchSyncProxies(){
    if (!cloudStatus?.available) return;
    setSyncErrors([]);
    // Only clips whose source file is on THIS device can be transcoded +
    // uploaded from here. Cloud-only clips (uploaded elsewhere) have no
    // local blob — skip them rather than erroring on a missing blob.
    const toSync = allVideos.filter(v => !v.hasProxy && v.hasLocalBlob);
    if (!toSync.length) return;
    enqueueAutoSync(toSync, activeDate);
    await processAutoSyncQueue();
  }

  // Batch "Upload originals" — coach/admin button. Uploads the full-
  // resolution source for every clip in the session that doesn't have one
  // yet. Deliberately manual: originals are multi-GB, so the user triggers
  // this only when on fast wifi.
  function handleBatchUploadOriginals(){
    if (!cloudStatus?.available) return;
    setSyncErrors([]);
    // Only clips with the source file on this device can be uploaded.
    const toUpload = allVideos.filter(v => !v.hasOriginal && v.hasLocalBlob);
    if (!toUpload.length) return;
    enqueueOriginals(toUpload, activeDate);
    processOriginalsQueue();
  }

  // Add clips to the auto-sync queue and kick the processor if idle.
  // Caller passes the local IDB video records (id + title/name for labels).
  function enqueueAutoSync(videos, sessionDate){
    if (!videos?.length) return;
    const items = videos
      // Filter out anything already proxy-uploaded so re-imports don't
      // re-transcode unnecessarily.
      .filter(v => !v.hasProxy)
      .map(v => ({
        videoId: v.id,
        // Each clip keeps its OWN session date — not the batch-wide
        // activeDate — so a May-19 clip can't be filed under May 20.
        sessionDate: v.sessionDate || sessionDate,
        label: v.title || v.name || v.id,
      }));
    if (!items.length) return;
    autoSyncRef.current.queue.push(...items);
    autoSyncRef.current.total += items.length;
    processAutoSyncQueue();
  }

  async function handleImported({date,videos,logData:ld,xmlData:xd}){
    if(ld)setLogData({...ld,source:"local"});if(xd)setXmlData({...xd,source:"local"});
    // Read local sessions filtered to the active workspace so imports into
    // workspace A don't appear when later viewing workspace B.
    const supaForReload = getBrowserSupabase();
    const { data: { user: reloadUser } } = await supaForReload.auth.getUser();
    const reloadMembership = reloadUser ? getActiveMembership(reloadUser.id) : null;
    setSessions(getSessionsForMembership(reloadMembership));setUnsyncedCount(getUnsyncedCount());
    // Load from IDB to ensure state matches storage (catches second import race)
    await loadDate(date);
    setActiveTab("library");

    // ── Phase B auto-sync (mobile only) ────────────────────────────────────
    // Mobile users (especially TL1/crew/etc.) need their imports to reach
    // the cloud without having to find a button, so mobile imports auto-sync
    // their proxies in the background. Desktop is deliberately NOT auto-synced:
    // coaches crop clips first and then push everything with the batch
    // "Sync proxies" button (see BatchSyncPanel / handleBatchSyncProxies).
    if (isMobile && videos?.length && cloudStatus?.available) {
      // WI-FI ONLY. Phone clips are smaller than a GoPro's, but a session is still
      // hundreds of MB — never spend a crew member's cellular data without asking.
      // On mobile data we hold the clips; `flushOnWifi` below picks them up the
      // moment a Wi-Fi link appears, and the Upload button is always there to
      // override. See onWifi() for why an unknown link counts as "not Wi-Fi".
      if (onWifi()) {
        enqueueAutoSync(videos, date);
      } else {
        addLog(`📶 ${videos.length} clip${videos.length === 1 ? '' : 's'} held — will upload automatically on Wi-Fi (or tap Upload now).`);
      }
    }

    // ── Re-enrich & update cloud metadata ──────────────────────────────────
    // When log/event files are uploaded after videos were already synced,
    // update the cloud metadata so other devices get enriched data.
    if((ld||xd)&&cloudStatus?.available){
      // loadDate already enriched allVideos in state — use the freshly enriched data
      // Small delay to let loadDate's setState propagate
      setTimeout(async()=>{
        try{
          const log=await getLogData(date);
          const xml=await getXmlData(date);
          const vids=await getVideosForDate(date);
          const enrichedVids=vids.map(v=>enrichVideo(v,log,xml,syncOffsets));
          // Get photos from localStorage for this date
          const photoMeta=JSON.parse(localStorage.getItem(`ssa:photos-meta:${date}`)||"[]");
          const enrichedPhotos=photoMeta.length&&(log||xml)
            ? photoMeta.map(p=>{
                const e={...p};
                if(log?.rows?.length&&p.utc){
                  const nearRow=log.rows.reduce((best,r)=>Math.abs(r.utc-p.utc)<Math.abs(best.utc-p.utc)?r:best,log.rows[0]);
                  if(Math.abs(nearRow.utc-p.utc)<300000){e.tws=nearRow.tws;e.twa=nearRow.twa;e.awa=nearRow.awa;e.bsp=nearRow.bsp;e.heel=nearRow.heel;e.vmg=nearRow.vmg;}
                }
                if(xml){
                  const sailEvts=xml.sailsUpEvents||[];
                  const before=sailEvts.filter(s=>s.utc<=p.utc).sort((a,b)=>b.utc-a.utc)[0];
                  e.sails=before?.sails||[];
                  e.boat=xml.meta?.boat||null;e.location=xml.meta?.location||null;
                }
                return e;
              })
            : photoMeta;
          // Save enriched photos back to localStorage
          if(enrichedPhotos.length&&(log||xml)){
            localStorage.setItem(`ssa:photos-meta:${date}`,JSON.stringify(enrichedPhotos.map(({objectUrl,...p})=>p)));
          }
          await updateCloudSessionMetadata(date,{
            videos:enrichedVids,logData:log,xmlData:xml,
            photos:enrichedPhotos.length?enrichedPhotos:undefined
          });
        }catch(err){console.error("[SSA] Cloud metadata update failed:",err);}
      },500);
    }
  }

  // ── Mobile cloud sync handler ──────────────────────────────────────────────
  // Two-phase sync tailored for phones:
  //   1. PULL — fetch cloud session for the active date so thumbnails/video URLs
  //      appear even when only local metadata existed before. Merges cloud
  //      videos with any local ones (cloud thumbnails win when local has none).
  //   2. PUSH — if the user has unsynced local data + canSync, upload it.
  // Progress is reported via mobileSyncState so the top-bar button can show
  // a spinner and the content area can show a non-blocking toast.
  async function handleMobileCloudSync(opts){
    // heavy = run the upload PUSH (log/xml/videos). Auto-sync sets heavy=false on
    // a metered/poor link so only the light session-list PULL runs there.
    const heavy = !opts || opts.heavy !== false;
    // pushVideos = also upload the VIDEO BLOBS. Only ever true for a sync the user
    // explicitly pressed. The automatic path must never do it: video originals are
    // multi-GB, and auto-sync fires on mount / foreground / regained link, so it
    // would silently start a huge upload for whatever session happens to be loaded
    // — including an old boat's session — and then pin mobileSyncState to "pushing",
    // which disables the whole BatchSyncPanel (that is the stuck 63% DJI upload).
    // Logs + events still sync automatically; they are small.
    const pushVideos = !!opts?.pushVideos;
    if(!cloudStatus?.available){
      setMobileSyncState({phase:"error",message:"Cloud not configured",progress:0});
      setTimeout(()=>setMobileSyncState({phase:null,message:"",progress:0}),2500);
      return;
    }
    try{
      // ── PULL phase — team-scoped, works for EVERY role ─────────────────
      // Previously this was admin-only and used the global Bunny R2
      // listing. That left TL1/crew/coach unable to see anything but the
      // current local day. Now every role refreshes the Supabase
      // (RLS-protected, team-scoped) session list; admins additionally
      // merge the global R2 listing.
      setMobileSyncState({phase:"pulling",message:"Fetching cloud sessions…",progress:10});

      let supaUser=null;
      try{const sb=getBrowserSupabase();const {data:{user}}=await sb.auth.getUser();supaUser=user||null;}catch{}

      // Supabase team-scoped session list — all roles.
      if(supaUser){
        try{
          const cloudSessions=await listSessionsCloud({userId:supaUser.id});
          if(cloudSessions.length){
            setSessions(prev=>{
              const merged=[...prev];
              for(const s of cloudSessions){
                const existing=merged.find(m=>m.date===s.date);
                if(existing){
                  if(!existing.videoCount && s.video_count) existing.videoCount=s.video_count;
                  if(!existing.photoCount && s.photo_count) existing.photoCount=s.photo_count;
                  if(s.event!==undefined) existing.event=s.event;
                }else{
                  merged.push({date:s.date,source:'supabase',videoCount:s.video_count||0,photoCount:s.photo_count||0,event:s.event||null});
                }
              }
              return merged.sort((a,b)=>b.date.localeCompare(a.date));
            });
          }
        }catch{ /* non-fatal */ }
      }

      // Admin-only extra: merge the global Bunny R2 listing.
      if(effectiveRole==='admin'){
        try{
          const remote=await listR2Sessions();
          if(remote.length){
            setSessions(prev=>{
              const byDate=new Map(prev.map(s=>[s.date,s]));
              for(const s of remote) if(!byDate.has(s.date)) byDate.set(s.date,{...s,source:"cloud"});
              return Array.from(byDate.values()).sort((a,b)=>b.date.localeCompare(a.date));
            });
          }
        }catch{ /* non-fatal */ }
      }

      // Refresh the active date's videos + thumbnails through the standard
      // loader (Supabase-first, resolves proxy/stream URLs + thumbnails).
      setMobileSyncState({phase:"pulling",message:`Loading ${activeDate}…`,progress:45});
      await loadDate(activeDate);
      setMobileSyncState({phase:"pulling",message:"Thumbnails refreshed",progress:70});

      // PUSH phase — only if heavy (good link), user has permission + unsynced local
      const uc=getUnsyncedCount();
      if(heavy && uc>0 && perms.canSync){
        // ── Boat guard ───────────────────────────────────────────────────────
        // syncSessionToCloud files everything under the ACTIVE membership's
        // team/boat, but activeDate can be a session belonging to a DIFFERENT
        // boat (the local stores are keyed by date, not by boat). Pushing then
        // would silently re-file e.g. old Northstar 72 footage and its log
        // against Northstar 76. Refuse, and say exactly why.
        const syncMem = supaUser ? getActiveMembership(supaUser.id) : null;
        const ownsDay = getSessionsForMembership(syncMem).some(s=>s.date===activeDate);
        if(!ownsDay){
          const boat = syncMem?.boat_name || "the active boat";
          const why = `⚠ ${fmtDate(activeDate)} belongs to a different boat — not uploaded. It would be filed under ${boat}. Switch to that session's boat to sync it.`;
          addLog(why);
          setMobileSyncState({phase:"error",message:`${fmtDate(activeDate)} is another boat's session — skipped`,progress:0});
          setTimeout(()=>setMobileSyncState({phase:null,message:"",progress:0}),4000);
          return;
        }
        setMobileSyncState({phase:"pushing",message:`Uploading ${uc} unsynced…`,progress:75});
        const logD=await getLogData(activeDate);
        const xmlD=await getXmlData(activeDate);
        // Videos only when the user asked for it — see `pushVideos` above.
        const vids=pushVideos?await getVideosForDate(activeDate):[];
        await syncSessionToCloud(activeDate,logD,xmlD,vids,msg=>{
          setMobileSyncState(p=>({...p,message:msg.length>48?msg.slice(0,45)+"…":msg}));
        },{
          // Mirror each clip the moment its Bunny upload finishes so the
          // crew watching from their phones see clips appear progressively.
          // supaUser was resolved up-front in the PULL phase above.
          onVideoSynced: makeVideoMirrorCallback({
            userId: supaUser?.id || null,
            sessionDate: activeDate,
            syncOffsets,
          }),
        });
        markCloudSynced(activeDate);
        setUnsyncedCount(getUnsyncedCount());
      }
      setMobileSyncState({phase:"done",message:"✓ Synced",progress:100});
      setTimeout(()=>setMobileSyncState({phase:null,message:"",progress:0}),2200);
    }catch(e){
      setMobileSyncState({phase:"error",message:"Sync failed: "+(e?.message||e),progress:0});
      setTimeout(()=>setMobileSyncState({phase:null,message:"",progress:0}),3500);
    }
  }

  // ── Wi-Fi flush — push clips that were held on mobile data ────────────────
  // Clips imported on cellular are deliberately NOT auto-uploaded (see handleImported).
  // They'd otherwise sit local forever, so re-check whenever the link changes, the app
  // comes back to the foreground, or connectivity returns — and push the moment we're
  // on Wi-Fi. Proxies only; originals stay manual (multi-GB, user's call).
  const flushOnWifi = useCallback(() => {
    if (!isMobile || !cloudStatus?.available || !perms.canImport) return;
    if (!onWifi()) return;
    const held = allVideos.filter(v => !v.hasProxy && v.hasLocalBlob);
    if (!held.length) return;
    addLog(`📶 Wi-Fi — uploading ${held.length} held clip${held.length === 1 ? '' : 's'}…`);
    enqueueAutoSync(held, activeDate);
  }, [isMobile, cloudStatus, perms.canImport, allVideos, activeDate]);

  const flushRef = useRef(flushOnWifi);
  flushRef.current = flushOnWifi;
  useEffect(() => {
    const fire = () => { try { flushRef.current?.(); } catch { /* */ } };
    const onVis = () => { if (document.visibilityState === "visible") fire(); };
    const c = typeof navigator !== "undefined"
      ? (navigator.connection || navigator.mozConnection || navigator.webkitConnection)
      : null;
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", fire);
    c?.addEventListener?.("change", fire);          // wifi ⇄ cellular transitions
    const t = setTimeout(fire, 2500);               // and once after the app settles
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", fire);
      c?.removeEventListener?.("change", fire);
      clearTimeout(t);
    };
  }, []); // register once — the ref keeps the callback fresh

  // ── Automatic cloud sync — event-driven, network-aware ────────────────────
  // No timers: fires on app foreground, when connectivity returns, and once on
  // mount. The light session-list PULL runs on any online link; the heavy upload
  // PUSH (logs/videos) only on a good/unmetered link. Debounced + exponential
  // backoff so a flaky offshore signal never spins or drains the battery. The
  // video transcode/upload queues are NOT touched here.
  const autoSyncMetaRef = useRef({ last: 0, running: false, backoffUntil: 0 });
  async function autoCloudSync(reason){
    const st = autoSyncMetaRef.current;
    if(!cloudStatus?.available) return;
    const ci = connInfo();
    if(!ci.online) return;
    if(st.running) return;
    if(mobileSyncState?.phase==="pulling"||mobileSyncState?.phase==="pushing") return; // a sync is already active
    const now = Date.now();
    if(now < st.backoffUntil) return;
    if(reason!=="online" && now - st.last < 20000) return; // debounce (a regained link bypasses)
    st.running = true;
    try {
      await handleMobileCloudSync({ heavy: ci.good });
      st.last = Date.now(); st.backoffUntil = 0;
    } catch {
      st.backoffUntil = Date.now() + Math.min(Math.max((st.backoffUntil - now) * 2, 15000), 5*60*1000);
    } finally { st.running = false; }
  }
  const autoSyncFnRef = useRef(null);
  autoSyncFnRef.current = autoCloudSync;
  useEffect(() => {
    const fire = (reason) => { try { autoSyncFnRef.current?.(reason); } catch { /* */ } };
    const onVis = () => { if (document.visibilityState === "visible") fire("foreground"); };
    const onOnline = () => fire("online");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onOnline);
    const t = setTimeout(() => fire("mount"), 1500); // let the initial load settle first
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("online", onOnline); clearTimeout(t); };
  }, []); // register once
  // Fire once when cloud status first resolves to available (mount may race it).
  const cloudReadyFiredRef = useRef(false);
  useEffect(() => {
    if (cloudStatus?.available && !cloudReadyFiredRef.current) {
      cloudReadyFiredRef.current = true;
      autoSyncFnRef.current?.("cloud-ready");
    } else if (!cloudStatus?.available) {
      cloudReadyFiredRef.current = false;
    }
  }, [cloudStatus]);

  async function runAiQuery(){
    if(!aiQuery.trim()||!allVideos.length)return;
    setAiLoading(true);setAiResult(null);
    try{
      const vl=allVideos.map(v=>({id:v.id,title:v.title,date:v.sessionDate,source:v.source,tags:v.tags||[],tws:v.twsAvg!=null?+R(v.twsAvg):null,twa:v.twaAvg!=null?+R(v.twaAvg,0):null,vmg:v.vmgAvg!=null?+R(v.vmgAvg):null,polperc:v.polpercAvg!=null?+R(v.polpercAvg,0):null,vsTargPerc:v.vsTargPercAvg!=null?+R(v.vsTargPercAvg,0):null,sog:v.sogAvg!=null?+R(v.sogAvg):null}));
      const systemPrompt=`You are the AI assistant for Shared Sailing Analytics. Fields per clip: id, title, date, tags, tws, twa, vmg, polperc, vsTargPerc, sog. Library: ${JSON.stringify(vl)}\nReturn ONLY valid JSON: {"matches":[],"explanation":"","insight":""}`;
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:800,system:systemPrompt,messages:[{role:"user",content:aiQuery}]})});
      const data=await res.json();const text=data.content?.find(b=>b.type==="text")?.text||"{}";
      setAiResult(JSON.parse(text.replace(/```json|```/g,"").trim()));
    }catch{setAiResult({matches:[],explanation:"Search unavailable.",insight:""});}
    setAiLoading(false);
  }

  const aiIds=new Set(aiResult?.matches||[]);
  const selectedSail=sailFilter?sailInventory.find(s=>s.id===sailFilter):null;
  const sailTokens=selectedSail?[selectedSail.name,selectedSail.category,selectedSail.design_code,...(Array.isArray(selectedSail.specs?.aliases)?selectedSail.specs.aliases:[])].filter(Boolean).map(s=>String(s).trim().toLowerCase()):null;
  const matchesSail=tags=>!sailTokens||(tags||[]).some(t=>sailTokens.includes(String(t).trim().toLowerCase()));
  const displayed=(aiResult?allVideos.filter(v=>aiIds.has(v.id)):allVideos)
    .filter(v=>{const ok=selectedTags.length===0||selectedTags.every(t=>(v.tags||[]).includes(t));const q=searchQuery.toLowerCase();return ok&&matchesSail(v.tags)&&(!q||v.title?.toLowerCase().includes(q)||(v.tags||[]).some(t=>t.includes(q)));})
    // "Date" means WHEN THE CLIP WAS SHOT, not when it was imported. It used to sort by
    // addedAt, so uploading a day's footage in three batches interleaved them and the
    // library read out of order. Sort by startUtc — the clip's place on the water —
    // ASCENDING, so the session reads first-to-last like the day did. Clips with no
    // start time yet sink to the bottom rather than jumping to the top.
    .sort((a,b)=>{
      if(sortBy==="tws")   return (b.twsAvg||0)-(a.twsAvg||0);
      if(sortBy==="twa")   return (Math.abs(a.twaAvg||0))-(Math.abs(b.twaAvg||0));
      if(sortBy==="vmg")   return (b.vmgAvg||0)-(a.vmgAvg||0);
      if(sortBy==="polar") return (b.polpercAvg||0)-(a.polpercAvg||0);
      const ta=a.startUtc??null, tb=b.startUtc??null;
      if(ta==null && tb==null) return (b.addedAt||0)-(a.addedAt||0); // neither timed: newest import first
      if(ta==null) return 1;                                          // untimed clips last
      if(tb==null) return -1;
      return ta-tb;                                                   // chronological, as sailed
    });

  const allTags=[...new Set(allVideos.flatMap(v=>v.tags||[]))].sort();
  const isManTag=t=>["tack","gybe","topmark","mark","race-start","upwind","reach","downwind"].includes(t);
  const toggleTag=t=>setSelectedTags(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t]);
  const tabStyle=tab=>({padding:"6px 15px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,border:"none",background:activeTab===tab?"#06B6D4":"transparent",color:activeTab===tab?"#000":"#64748B"});

  if(!loaded)return<div style={{minHeight:"100vh",background:"#030F1A",display:"flex",alignItems:"center",justifyContent:"center",color:"#334155",fontSize:13}}>Loading Shared Sailing Analytics…</div>;

  // Event-file saillist reconciliation modal (rendered over both layouts).
  const sailDiffModal = sailDiff && campaignCfg?.teamId && campaignCfg?.boatId ? (
    <SailListDiffModal
      teamId={campaignCfg.teamId} boatId={campaignCfg.boatId}
      canEdit={['admin','team_manager','coach'].includes(effectiveRole)}
      inventory={sailInventory} names={sailDiff.names}
      onClose={()=>setSailDiff(null)} onResolved={refetchSails}
    />
  ) : null;

  // Timeline clip playback — the real overlay player in a modal over everything
  // (incl. the Timeline). Minimal props: no crop / sync / HD-toggle toolbar
  // buttons, but the base "Fullscreen (with data overlay)" control stays.
  const videoModal = (videoModalOpen && selectedVideo) ? (
    <div onClick={()=>setVideoModalOpen(false)} style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(3,15,26,0.55)",display:"flex",alignItems:"stretch",justifyContent:"flex-end",overflow:"hidden"}}>
      {/* Left spacer keeps the narrow timeline visible; the drawer FLEXES to fill
          the rest — no 100vw (which would include the scrollbar and cause a
          document-wide horizontal scroll). Full screen on mobile. */}
      {!isMobile && <div style={{width:320,flexShrink:0}} aria-hidden/>}
      <div onClick={e=>e.stopPropagation()} style={{position:"relative",flex:"1 1 auto",minWidth:0,height:"100%",overflowY:"auto",background:"#050E1C",borderLeft:"1px solid #1E3A5A",boxShadow:"-12px 0 40px rgba(0,0,0,0.5)",padding:isMobile?"40px 10px 12px":"44px 16px 16px"}}>
        <button onClick={()=>setVideoModalOpen(false)} aria-label="Close" style={{position:"absolute",top:8,left:"50%",transform:"translateX(-50%)",zIndex:3,width:38,height:34,borderRadius:8,border:"1px solid #1E3A5A",background:"#0A1929",color:"#E2E8F0",fontSize:18,lineHeight:"1",cursor:"pointer"}}>✕</button>
        {/* Cap the width so the 16:9 stage + controls fit the viewport height —
            the BOX fills the screen, the video sizes to fit inside it. */}
        <div style={{width:"100%",maxWidth:isMobile?"none":"calc((100vh - 190px) * 16 / 9)",margin:"0 auto"}}>
          <VideoPlayer
            video={selectedVideo}
            logData={logData}
            xmlData={xmlData}
            syncOffset={syncOffsets[selectedVideo.id]||0}
            sessionTzOffset={sessionTzOffset}
            onPlayUtc={handlePlayUtc}
            onRotate={canRotate ? (deg)=>rotateVideo(selectedVideo, deg) : null}
            autoPlay
          />
        </div>
      </div>
    </div>
  ) : null;

  // ── Mobile render ────────────────────────────────────────────────────────────
  if(isMobile) return(
    <TzCtx.Provider value={sessionTzOffset||0}>
    <>{sailDiffModal}{videoModal}<MobileShell
      activeTab={activeTab} setActiveTab={setActiveTab}
      role={role} perms={perms}
      allVideos={allVideos} setAllVideos={setAllVideos}
      sessions={visibleSessions} setSessions={setSessions}
      activeDate={activeDate} setActiveDate={setActiveDate}
      selectedVideo={selectedVideo} setSelectedVideo={setSelectedVideo}
      logData={logData} setLogData={setLogData}
      xmlData={xmlData} setXmlData={setXmlData}
      sessionTzOffset={sessionTzOffset}
      sessionTagList={sessionTagList} setSessionTagList={setSessionTagList}
      syncOffsets={syncOffsets} setSyncOffsets={setSyncOffsets}
      saveSyncForVideos={saveSyncForVideos}
      saveTagsForVideo={saveTagsForVideo}
      tagSuggestionList={tagSuggestionList}
      cloudStatus={cloudStatus} unsyncedCount={unsyncedCount}
      searchQuery={searchQuery} setSearchQuery={setSearchQuery}
      sortBy={sortBy} setSortBy={setSortBy}
      selectedTags={selectedTags} setSelectedTags={setSelectedTags}
      allTags={allTags} isManTag={isManTag} toggleTag={toggleTag}
      displayed={displayed}
      loadDate={loadDate} onSelectDate={loadDate} handleImported={handleImported}
      handlePlayUtc={handlePlayUtc} playUtc={playUtc}
      canSeeAnalytics={canSeeAnalytics} canUseAI={canUseAI}
      canSeeSailScanTab={canSeeSailScanTab} canSeeSquashShotsTab={canSeeSquashShotsTab} canSeeToolsTab={canSeeToolsTab} canSeeBoatConfig={canSeeBoatConfig}
      canSeeAnalyticsData={canSeeAnalyticsData} canSeeSailScanPhotos={canSeeSailScanPhotos}
      showOnlyLatestDay={showOnlyLatestDay} effectiveRole={effectiveRole}
      campaignOn={campaignOn} campaignCfg={campaignCfg} activeMem={activeMem} openCampaignVideo={openCampaignVideo} openVideoModal={openVideoModal}
      sailInventory={sailInventory} setSailDiff={setSailDiff}
      onRotateVideo={canRotate ? rotateVideo : null}
      hasMountedAnalytics={hasMountedAnalytics}
      updateVideoTagsFn={updateVideoTags}
      computeAutoTagsFn={computeAutoTags}
      photos={photos} setPhotos={setPhotos}
      onMobileSync={handleMobileCloudSync}
      onSyncProxies={handleBatchSyncProxies}
      onUploadOriginals={handleBatchUploadOriginals}
      syncErrors={syncErrors}
      mobileSyncState={mobileSyncState}
      setMobileSyncState={setMobileSyncState}
      onThumbLoad={markVideoThumbLoaded}
      videoThumbsLoading={videoThumbsLoading}
      videoLoadedIds={videoLoadedIds}
      videoTotalThumbs={videoTotalThumbs}
    /></>
    </TzCtx.Provider>
  );

  return(
    <TzCtx.Provider value={sessionTzOffset||0}>
    <>{sailDiffModal}{videoModal}
    <div style={{minHeight:"100vh",width:"100%",maxWidth:"100%",overflowX:"hidden",background:"#030F1A",color:"#E2E8F0",fontFamily:"'Segoe UI',system-ui,sans-serif",display:"flex",flexDirection:"column"}}>
      <header style={{background:"#050E1C",borderBottom:"1px solid #1E3A5A",padding:"0 18px",display:"flex",alignItems:"center",height:52,gap:14,position:"sticky",top:0,zIndex:100,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:15,fontWeight:700,color:"#E2E8F0"}}>Shared</span><span style={{fontSize:15,fontWeight:700,color:"#06B6D4"}}>Sailing Analytics</span></div>
        <nav style={{marginLeft:10}}>
          <select value={activeTab} onChange={e=>setActiveTab(e.target.value)} title="Menu"
            style={{background:"#071624",border:"1px solid #1E3A5A",borderRadius:7,padding:"6px 12px",color:"#E2E8F0",fontSize:12,fontWeight:600,cursor:"pointer",outline:"none",minWidth:130}}>
            {["timeline","campaign","boatconfig","weather","library","photos","analytics","upload","tools","admin"].filter(tab => {
              if (tab === "campaign" && (!campaignOn || effectiveRole === 'guest')) return false;
              if (tab === "boatconfig" && (!campaignOn || !canSeeBoatConfig)) return false;
              if (tab === "tools" && !canSeeToolsTab) return false;
              if (tab === "admin" && effectiveRole !== 'admin') return false;
              return true;
            }).map(tab=>{
              const label = tab==="timeline"?"Timeline":tab==="library"?"Videos":tab==="weather"?"Weather":tab==="boatconfig"?"Boat":tab==="tools"?"Tools":tab.charAt(0).toUpperCase()+tab.slice(1);
              return <option key={tab} value={tab} style={{background:"#0A1929"}}>{label}{tab==="upload"&&unsyncedCount>0?` (${unsyncedCount})`:""}</option>;
            })}
          </select>
        </nav>
        <div style={{flex:1}}/>
        {canUseAI && (
        <div style={{display:"flex",gap:5,width:290}}>
          <input value={aiQuery} onChange={e=>setAiQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&runAiQuery()} placeholder="✦ AI search…" style={{flex:1,background:"#071624",border:"1px solid #1E3A5A",borderRadius:6,padding:"5px 10px",color:"#E2E8F0",fontSize:11,outline:"none"}}/>
          <button onClick={runAiQuery} disabled={aiLoading} style={{background:aiLoading?"#1E3A5A":"#8B5CF6",border:"none",borderRadius:6,padding:"5px 12px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:11}}>{aiLoading?"…":"Search"}</button>
          {aiResult&&<button onClick={()=>setAiResult(null)} style={{background:"none",border:"1px solid #EF444440",borderRadius:6,padding:"5px 8px",color:"#EF4444",cursor:"pointer",fontSize:11}}>✕</button>}
        </div>
        )}
        <div style={{display:"flex",alignItems:"center",gap:5,background:"#071624",border:"1px solid #1E3A5A",borderRadius:7,padding:"4px 8px"}}>
          <span style={{fontSize:8,color:"#334155",letterSpacing:1}}>ROLE</span>
          <select value={role} onChange={e=>setRole(e.target.value)} style={{background:"transparent",border:"none",color:"#94A3B8",fontSize:11,cursor:"pointer",outline:"none"}}>
            {Object.entries(ROLES).map(([k,v])=><option key={k} value={k} style={{background:"#0A1929"}}>{v.label}</option>)}
          </select>
        </div>
      </header>

      {aiResult&&<div style={{background:"#0D1829",borderBottom:"1px solid #8B5CF620",padding:"7px 18px",display:"flex",gap:10,alignItems:"flex-start",flexShrink:0}}><span style={{color:"#8B5CF6",fontSize:12}}>✦</span><div style={{flex:1}}><div style={{fontSize:11,color:"#A78BFA",fontWeight:600,marginBottom:1}}>{aiResult.matches?.length||0} clips — {aiResult.explanation}</div>{aiResult.insight&&<div style={{fontSize:10,color:"#334155"}}>💡 {aiResult.insight}</div>}</div></div>}

      {/* ── Tab panes ────────────────────────────────────────────────────────────
          Library and Analytics stay mounted after first visit (visibility:hidden
          rather than display:none) so the video element keeps playing and
          Leaflet retains its map dimensions when switching between tabs.
          Upload and Admin are cheap to remount on demand.
      ─────────────────────────────────────────────────────────────────────── */}
      <div style={{display:"flex",flex:1,overflow:"hidden",position:"relative"}}>

        {/* ── LIBRARY PANE — always mounted ──────────────────────────────────── */}
        <div style={{
          position:"absolute",inset:0,display:"flex",overflow:"hidden",
          visibility:activeTab==="library"?"visible":"hidden",
          pointerEvents:activeTab==="library"?"auto":"none",
          zIndex:activeTab==="library"?2:1,
        }}>
          {/* Sidebar */}
          <aside style={{width:160,background:"#050E1C",borderRight:"1px solid #1E3A5A",display:"flex",flexDirection:"column",overflowY:"auto",flexShrink:0}}>
            <div style={{padding:"12px 11px 6px"}}>
              <div style={{fontSize:9,color:"#1E3A5A",letterSpacing:2,textTransform:"uppercase",marginBottom:7}}>Sessions</div>
              {visibleSessions.length===0&&<div style={{fontSize:10,color:"#1E3A5A",padding:"4px 3px"}}>No sessions yet</div>}
              {(()=>{
                // Compute Day N per regatta: group all known sessions by
                // event, sort each group by date, assign 1..N. Built once
                // over the full session list so day numbering survives
                // photo-only or no-video days within the regatta.
                const evMap=new Map(); // date → {event, dayN}
                const g=new Map();
                for(const s of visibleSessions){ if(s.event){ if(!g.has(s.event)) g.set(s.event,[]); g.get(s.event).push(s.date); } }
                for(const [ev,ds] of g){ ds.slice().sort().forEach((d,i)=>evMap.set(d,{event:ev,dayN:i+1})); }
                return visibleSessions.filter(s=>(s.videoCount||0)>0 && s.date<=TODAY()).map(s=>{
                  const isLocal=!(s.cloudSynced||s.source==="cloud"||s.source==="supabase");const isActive=activeDate===s.date;
                  const ev=evMap.get(s.date);
                  return(<div key={s.date} onClick={()=>loadDate(s.date)} style={{padding:"5px 6px",borderRadius:5,cursor:"pointer",marginBottom:2,background:isActive?"#1E3A5A":"transparent",border:`1px solid ${isActive?"#06B6D430":"transparent"}`}}>
                    <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}><span style={{fontSize:11,color:isActive?"#06B6D4":"#64748B",fontFamily:"monospace"}}>{s.date===TODAY()?"Today":fmtDate(s.date)}</span><SrcBadge source={isLocal?"local":"cloud"}/></div>
                    {ev&&<div style={{fontSize:9,color:"#EF4444",fontWeight:700,marginBottom:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={`${ev.event} Day ${ev.dayN}`}>🏁 {ev.event} Day {ev.dayN}</div>}
                    <div style={{fontSize:9,color:"#1E3A5A"}}>{s.videoCount||0}v{s.hasLog?" ·log":""}{s.hasXml?" ·ev":""}{s.location?` · ${s.location}`:""}</div>
                  </div>);
                });
              })()}
            </div>
            <div style={{height:1,background:"#0F2030",margin:"4px 11px 6px"}}/>
            <div style={{padding:"0 11px 8px"}}>
              <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search clips…" style={{width:"100%",background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 8px",color:"#E2E8F0",fontSize:11,outline:"none",boxSizing:"border-box",marginBottom:7}}/>
              {sailInventory.length>0&&<select value={sailFilter} onChange={e=>setSailFilter(e.target.value)} style={{width:"100%",background:"#071624",border:`1px solid ${sailFilter?"#06B6D4":"#1E3A5A"}`,borderRadius:5,padding:"5px 8px",color:sailFilter?"#06B6D4":"#E2E8F0",fontSize:11,outline:"none",boxSizing:"border-box",marginBottom:7,cursor:"pointer"}}>
                <option value="">All sails</option>
                {sailInventory.filter(s=>!s.retired).map(s=><option key={s.id} value={s.id}>{s.category?`${s.category} · ${s.name}`:s.name}</option>)}
              </select>}
              {["date","tws","twa","vmg","polar"].map(s=><button key={s} onClick={()=>setSortBy(s)} style={{display:"block",width:"100%",textAlign:"left",background:sortBy===s?"#1E3A5A":"none",border:"none",borderRadius:4,padding:"3px 6px",color:sortBy===s?"#06B6D4":"#334155",cursor:"pointer",fontSize:10,marginBottom:1}}>{sortBy===s?"▸ ":"  "}{s==="date"?"Time (as sailed)":s==="tws"?"Wind (TWS)":s==="twa"?"Wind angle":s==="vmg"?"VMG":"Polar %"}</button>)}
            </div>
            {allTags.length>0&&<div style={{padding:"0 11px",flex:1}}>
              <div style={{fontSize:8,color:"#1E3A5A",letterSpacing:2,textTransform:"uppercase",marginBottom:5}}>Filter</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
                {allTags.filter(isManTag).map(t=><button key={t} onClick={()=>toggleTag(t)} style={{background:selectedTags.includes(t)?"#06B6D4":"#0A1929",border:`1px solid ${selectedTags.includes(t)?"#06B6D4":"#1E3A5A"}`,borderRadius:3,padding:"1px 5px",color:selectedTags.includes(t)?"#000":"#7DD3FC",fontSize:9,cursor:"pointer",fontFamily:"monospace"}}>{t}</button>)}
              </div>
              {selectedTags.length>0&&<button onClick={()=>setSelectedTags([])} style={{background:"none",border:"1px solid #EF444440",borderRadius:4,padding:"2px 8px",color:"#EF4444",fontSize:9,cursor:"pointer",width:"100%",marginTop:6}}>Clear</button>}
            </div>}
          </aside>

          {/* Library main content */}
          <main style={{flex:1,display:"flex",overflow:"hidden",position:"relative"}}>

            {/* ── Sync modal overlay ──────────────────────────────────────── */}
            {libSyncProgress&&(
              <div style={{position:"absolute",inset:0,background:"rgba(3,15,26,0.88)",
                zIndex:50,display:"flex",flexDirection:"column",justifyContent:"center",
                alignItems:"center",padding:24}}>
                <div style={{width:"100%",maxWidth:480}}>
                  <SyncProgressPanel progress={libSyncProgress} phase={libSyncPhase||"syncing"}
                    onCancel={()=>{
                      libSyncAbortRef.current=true;
                      clearInterval(libSyncTimerRef.current);
                      setLibSyncProgress(null);setLibSyncPhase(null);
                    }}/>
                  {libSyncPhase==="done"&&(
                    <button onClick={()=>{setLibSyncProgress(null);setLibSyncPhase(null);setUnsyncedCount(getUnsyncedCount());}}
                      style={{marginTop:12,width:"100%",background:"#1D9E75",border:"none",
                        borderRadius:8,padding:"10px",color:"#fff",fontWeight:700,
                        fontSize:13,cursor:"pointer"}}>
                      ✓ Done
                    </button>
                  )}
                </div>
              </div>
            )}

            <div style={{width:280,minWidth:280,overflowY:"auto",padding:"10px 8px",flexShrink:0,borderRight:"1px solid #0F2030"}}>
              {(logData||xmlData)&&<div style={{display:"flex",gap:7,marginBottom:10,flexWrap:"wrap",alignItems:"center"}}>
                {logData&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:3,background:logData.source==="local"?"#1D9E7510":"#8B5CF610",border:`1px solid ${logData.source==="local"?"#1D9E7530":"#8B5CF630"}`,color:logData.source==="local"?"#1D9E75":"#8B5CF6"}}>{logData.source==="local"?"● Local":"● Cloud"} log · {logData.rows?.length?.toLocaleString()} rows</span>}
                {xmlData&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:3,background:"#8B5CF610",border:"1px solid #8B5CF630",color:"#8B5CF6"}}>{xmlData.source==="local"?"● Local":"● Cloud"} events · {xmlData.tackJibes?.length} manoeuvres</span>}
                <span style={{fontSize:10,color:"#1E3A5A"}}>{displayed.length} clip{displayed.length!==1?"s":""}</span>
                <div style={{flex:1}}/>
                {/* ── Sync ↑ button — visible when session has unsynced local data ── */}
                {cloudStatus?.available&&perms.canSync&&(logData||xmlData||allVideos.length>0)&&(
                  <button onClick={async()=>{
                    const vids=await getVideosForDate(activeDate);
                    const logD=await getLogData(activeDate);
                    const xmlD=await getXmlData(activeDate);
                    const items=[
                      {id:"log",label:"Log & Events",state:"pending",pct:0},
                      ...vids.map(v=>({id:v.id,label:v.name||v.title,state:"pending",pct:0}))
                    ];
                    libSyncAbortRef.current=false;
                    const startMs=Date.now();
                    libSyncTimerRef.current=setInterval(()=>
                      setLibSyncProgress(p=>p?{...p,elapsed:Math.round((Date.now()-startMs)/1000)}:p),1000);
                    setLibSyncProgress({items,overall:0,elapsed:0,error:null});
                    setLibSyncPhase("syncing");
                    const setItem=(id,patch)=>setLibSyncProgress(p=>p?{...p,items:p.items.map(it=>it.id===id?{...it,...patch}:it)}:p);
                    try{
                      let curVid=null;
                      // Resolve user once so the mirror callback below can
                      // push each clip to Supabase as soon as it lands.
                      let libUser=null;
                      try{const sb=getBrowserSupabase();const {data:{user}}=await sb.auth.getUser();libUser=user||null;}catch{}
                      await syncSessionToCloud(activeDate,logD,xmlD,
                        vids,
                        msg=>{
                          if(libSyncAbortRef.current)return;
                          if(msg.includes("log")&&msg.includes("✓")) setItem("log",{state:"done",pct:100});
                          const vMatch=vids.find(v=>msg.includes(v.name||v.title||"")&&msg.includes("✓"));
                          if(vMatch) setItem(vMatch.id,{state:"done",pct:100});
                          else if(vids.find(v=>msg.includes(v.name||v.title||""))){
                            const vf=vids.find(v=>msg.includes(v.name||v.title||""));
                            if(vf&&!curVid){curVid=vf.id;setItem(curVid,{state:"active",pct:50});}
                          }
                          // recalc overall
                          setLibSyncProgress(p=>{
                            if(!p)return p;
                            const avg=p.items.reduce((s,it)=>s+(it.pct||0),0)/p.items.length;
                            return{...p,overall:Math.round(avg)};
                          });
                        },
                        {
                          // Per-video Supabase mirror — clips appear for
                          // teammates as each finishes, not after the batch.
                          onVideoSynced: makeVideoMirrorCallback({
                            userId: libUser?.id || null,
                            sessionDate: activeDate,
                            syncOffsets,
                          }),
                        });
                      setLibSyncPhase("done");
                      setLibSyncProgress(p=>p?{...p,overall:100}:p);
                      markCloudSynced(activeDate);
                      setUnsyncedCount(getUnsyncedCount());
                    }catch(e){
                      setLibSyncProgress(p=>p?{...p,error:String(e)}:p);
                    }finally{clearInterval(libSyncTimerRef.current);}
                  }}
                  style={{background:"#8B5CF6",border:"none",borderRadius:5,padding:"3px 10px",
                    color:"#fff",cursor:"pointer",fontSize:10,fontWeight:700,display:"flex",
                    alignItems:"center",gap:4}}>
                    ↑ {unsyncedCount>0?"Sync":"Re-sync"}{unsyncedCount>0?` (${unsyncedCount})`:""}
                  </button>
                )}
                {xmlData&&allVideos.length>0&&perms.canImport&&(
                  <button onClick={async()=>{
                    let count=0;
                    const updated=await Promise.all(allVideos.map(async v=>{
                      if(!v.startUtc)return v;
                      const newTags=computeAutoTags(v.startUtc,v.duration,logData,xmlData,syncOffsets[v.id]||0);
                      const manualTags=(v.tags||[]).filter(t=>{if(isAutoTag(t))return false;const meta=xmlData?.meta;if(meta?.location&&t===meta.location.toLowerCase().replace(/\s+/g,"-"))return false;if(meta?.boat&&t===meta.boat.toLowerCase().replace(/\s+/g,"-"))return false;if(meta?.dayType&&t===meta.dayType.toLowerCase().replace(/\s+/g,"-"))return false;return true;});
                      const merged=[...new Set([...newTags,...manualTags])];
                      await updateVideoTags(v.id,merged);
                      // Push to cloud so other devices pick up the re-tag.
                      pushVideoMetadataToCloud(v,{tags:merged});
                      count++;return{...v,tags:merged};
                    }));
                    setAllVideos(updated);
                    if(selectedVideo){const u=updated.find(v=>v.id===selectedVideo.id);if(u)setSelectedVideo(u);}
                    alert(`Re-tagged ${count} clip${count!==1?"s":""} using event data.`);
                  }} style={{background:"#8B5CF620",border:"1px solid #8B5CF640",borderRadius:5,padding:"3px 10px",color:"#8B5CF6",cursor:"pointer",fontSize:10,fontWeight:600}}>
                    ⚡ Re-tag {allVideos.filter(v=>v.startUtc).length} clips
                  </button>
                )}
              </div>}
              {/* ── Batch cloud sync — coach/admin, Phase B.3 ──────────────── */}
              {cloudStatus?.available && perms.canSync && allVideos.length>0 && (
                <BatchSyncPanel
                  videos={allVideos}
                  syncState={mobileSyncState}
                  onSyncProxies={handleBatchSyncProxies}
                  onUploadOriginals={handleBatchUploadOriginals}
                  syncErrors={syncErrors}
                />
              )}
              {allVideos.length===0&&<div style={{textAlign:"center",padding:"50px 20px",color:"#1E3A5A"}}><div style={{fontSize:32,marginBottom:14,opacity:0.4}}>📹</div><div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:6}}>No videos for this session</div><div style={{fontSize:11,marginBottom:16}}>{perms.canImport?"Import in the Upload tab.":"Session not yet uploaded to cloud."}</div>{perms.canImport&&<button onClick={()=>setActiveTab("upload")} style={{background:"#06B6D4",border:"none",borderRadius:8,padding:"8px 20px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>Go to Upload</button>}</div>}
              {/* ── Clear-day nuke (admin/coach). Shown even with 0 local clips,
                     because ORPHAN cloud rows are exactly what needs clearing. ── */}
              {perms.canDelete && (
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  {clearDayBusy ? (
                    <span style={{fontSize:11,color:"#EF4444"}}>Clearing {activeDate}…</span>
                  ) : clearDayArmed ? (
                    <>
                      <span style={{fontSize:11,color:"#EF4444",fontWeight:600}}>Delete ALL clips for {fmtDate(activeDate)} — local, Bunny and cloud?</span>
                      <button onClick={handleClearDay} style={{background:"#EF4444",border:"none",borderRadius:6,padding:"5px 12px",color:"#fff",cursor:"pointer",fontSize:11,fontWeight:700}}>Delete all</button>
                      <button onClick={()=>setClearDayArmed(false)} style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,padding:"5px 10px",color:"#64748B",cursor:"pointer",fontSize:11}}>Cancel</button>
                    </>
                  ) : (
                    <button onClick={()=>setClearDayArmed(true)} style={{background:"none",border:"1px solid #EF444430",borderRadius:6,padding:"5px 12px",color:"#EF4444",cursor:"pointer",fontSize:11,opacity:0.75}}>🗑 Clear all clips for this day</button>
                  )}
                </div>
              )}
              {/* ── Batch select toolbar (admin/coach only) ── */}
              {perms.canDelete && allVideos.length > 0 && (
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  <button onClick={()=>batchMode?clearBatch():setBatchMode(true)}
                    style={{background:batchMode?"#EF444420":"#0A1929",border:`1px solid ${batchMode?"#EF444440":"#1E3A5A"}`,
                      borderRadius:6,padding:"5px 12px",color:batchMode?"#EF4444":"#64748B",cursor:"pointer",fontSize:11,fontWeight:600}}>
                    {batchMode?"✕ Cancel":"☑ Select"}
                  </button>
                  {batchMode&&(
                    <>
                      <button onClick={()=>{const allIds=new Set(displayed.map(v=>v.id));setBatchSelected(allIds);}}
                        style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,padding:"5px 10px",color:"#64748B",cursor:"pointer",fontSize:10}}>All</button>
                      <button onClick={()=>setBatchSelected(new Set())}
                        style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,padding:"5px 10px",color:"#64748B",cursor:"pointer",fontSize:10}}>None</button>
                      <span style={{fontSize:11,color:"#475569",fontFamily:"monospace"}}>{batchSelected.size} selected</span>
                      {batchSelected.size>0&&(
                        <>
                          <button onClick={()=>setBatchSyncOpen(o=>!o)}
                            style={{marginLeft:"auto",background:batchSyncOpen?"#06B6D420":"#0A1929",border:`1px solid ${batchSyncOpen?"#06B6D450":"#1E3A5A"}`,borderRadius:6,padding:"5px 12px",color:"#06B6D4",cursor:"pointer",fontSize:11,fontWeight:700}}>
                            ⟲ Sync {batchSelected.size}
                          </button>
                          <button onClick={handleBatchSaveToDisk}
                            title="Download each selected clip's local file to disk for external ffmpeg compression"
                            style={{background:"#06B6D420",border:"1px solid #06B6D450",borderRadius:6,padding:"5px 12px",color:"#06B6D4",cursor:"pointer",fontSize:11,fontWeight:700}}>
                            ↓ Save {batchSelected.size} to disk
                          </button>
                          <button onClick={handleBatchUploadCompressed}
                            title="Upload compressed copies (from disk) for each selected clip — matched by filename stem. Local HD blobs are left untouched."
                            style={{background:"#8B5CF620",border:"1px solid #8B5CF650",borderRadius:6,padding:"5px 12px",color:"#A78BFA",cursor:"pointer",fontSize:11,fontWeight:700}}>
                            ↑ Upload {batchSelected.size} compressed
                          </button>
                          <button onClick={()=>{if(confirm(`Delete ${batchSelected.size} video${batchSelected.size>1?"s":""}? This cannot be undone.`))handleBatchDelete();}}
                            style={{background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"5px 14px",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700}}>
                            🗑 Delete {batchSelected.size}
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
              {/* ── Batch sync offset panel — apply the same shift to every
                  selected clip in one go. Bakes into startUtc (local + cloud)
                  and recomputes auto-tags from the shifted window. ── */}
              {batchMode && batchSelected.size>0 && batchSyncOpen && (
                <div style={{marginBottom:10,maxWidth:420}}>
                  <SyncControl
                    offset={batchSyncOffset}
                    onChange={setBatchSyncOffset}
                    saving={batchSyncBusy}
                    saveLabel={`💾 Apply to ${batchSelected.size}`}
                    onSave={async(secs)=>{
                      setBatchSyncBusy(true);
                      try {
                        const sel = allVideos.filter(v => batchSelected.has(v.id));
                        const n = await saveSyncForVideos(sel, secs);
                        if (n === 0) {
                          alert('Nothing to update — none of the selected clips have a start time set.');
                        }
                      } finally {
                        setBatchSyncBusy(false);
                        setBatchSyncOffset(0);
                        setBatchSyncOpen(false);
                        setBatchSelected(new Set());
                      }
                    }}/>
                </div>
              )}
              {/* ── Loading thumbnails banner ── */}
              {(() => {
                const loadedCount = Math.min(videoLoadedIds.size, videoTotalThumbs);
                const isLoading = videoThumbsLoading || (videoTotalThumbs > 0 && loadedCount < videoTotalThumbs);
                if(!isLoading) return null;
                const pct = videoTotalThumbs > 0 ? Math.round((loadedCount/videoTotalThumbs)*100) : 0;
                return (
                  <div style={{background:"#06B6D410",border:"1px solid #06B6D430",borderRadius:6,padding:"7px 10px",marginBottom:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:10,color:"#06B6D4",fontFamily:"monospace",marginBottom:5}}>
                      <span>⟳ Loading thumbnails…</span>
                      <span>{videoThumbsLoading ? "…" : `${loadedCount} / ${videoTotalThumbs}`}</span>
                    </div>
                    <div style={{height:4,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
                      <div style={{
                        height:"100%",
                        width: videoThumbsLoading ? "15%" : `${pct}%`,
                        background:"#06B6D4",
                        transition:"width 0.2s ease-out",
                        animation: videoThumbsLoading ? "ssa-thumb-pulse 1.2s ease-in-out infinite" : "none",
                      }}/>
                    </div>
                    <style>{`@keyframes ssa-thumb-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }`}</style>
                  </div>
                );
              })()}
              {(()=>{
                const groups=[]; const seen=new Map();
                for(const v of displayed){const d=v.sessionDate||"unknown";if(!seen.has(d)){seen.set(d,[]);groups.push(d);}seen.get(d).push(v);}
                const SKIP_HDR=new Set(["race-start","topmark","mark","upwind","reach","downwind","tack","gybe","race","training"]);
                return groups.map(date=>{
                  const vids=seen.get(date);
                  const location=(vids[0]?.tags||[]).find(t=>!SKIP_HDR.has(t)&&t.includes("-")&&!t.startsWith("tws-")&&!/-20\d{2}$/.test(t)&&t.length>3&&!/^\d/.test(t))||null;
                  const boat=(vids[0]?.tags||[]).find(t=>!SKIP_HDR.has(t)&&!t.startsWith("tws-")&&!t.includes("-")&&t.length>2&&!/^\d/.test(t))||null;
                  return(<div key={date} style={{marginBottom:18}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,paddingBottom:5,borderBottom:"1px solid #0F2030"}}>
                      <div style={{fontSize:11,fontWeight:700,color:"#64748B",fontFamily:"monospace"}}>{date===TODAY()?"Today":fmtDate(date)}</div>
                      {location&&<span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:"#06B6D420",border:"1px solid #06B6D440",color:"#06B6D4",fontWeight:600}}>{location}</span>}
                      {boat&&<span style={{fontSize:9,color:"#334155",fontFamily:"monospace"}}>{boat}</span>}
                      <span style={{fontSize:9,color:"#1E3A5A",marginLeft:"auto"}}>{vids.length} clip{vids.length!==1?"s":""}</span>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:8}}>
                      {vids.map(v=><VideoCard key={v.id} video={v} selected={selectedVideo?.id===v.id} onClick={()=>setSelectedVideo(v)} onThumbLoad={markVideoThumbLoaded} batchMode={batchMode} batchSelected={batchSelected} onBatchToggle={toggleBatchSelect} sessionTzOffset={sessionTzOffset}/>)}
                    </div>
                  </div>);
                });
              })()}
            </div>
            {selectedVideo&&(
              <div style={{flex:1,background:"#050E1C",borderLeft:"1px solid #1E3A5A",overflowY:"auto",padding:16,minWidth:400}}>
                {/* onPlayUtc wires VideoPlayer → shared playUtc state → Analytics */}
                <VideoPlayer
                  video={selectedVideo}
                  logData={logData}
                  xmlData={xmlData}
                  syncOffset={syncOffsets[selectedVideo.id]||0}
                  sessionTzOffset={sessionTzOffset}
                  onPlayUtc={handlePlayUtc}
                  onRotate={canRotate ? (deg)=>rotateVideo(selectedVideo, deg) : null}
                  canPlayLocalHD={['admin','coach'].includes(effectiveRole)}
                  // Phase B crop UX: three toolbar buttons + timeline
                  // markers. Gated on perms.canSync + local original
                  // present. Re-clicking a button moves that marker.
                  pendingCrop={pendingCrop}
                  cropBusy={cropBusy}
                  cropProgress={cropProgress}
                  onDeleteUpTo={
                    perms.canSync && selectedVideo.hasLocalBlob
                      ? (t)=>{
                          const clamped = Math.max(0, Math.min(t, (selectedVideo.duration||0)));
                          setPendingCrop(p => ({ ...(p||{deleteFrom:null}), deleteUpTo: clamped }));
                          setCropError(null);
                        }
                      : undefined
                  }
                  onDeleteFromHere={
                    perms.canSync && selectedVideo.hasLocalBlob
                      ? (t)=>{
                          const clamped = Math.max(0, Math.min(t, (selectedVideo.duration||0)));
                          setPendingCrop(p => ({ ...(p||{deleteUpTo:null}), deleteFrom: clamped }));
                          setCropError(null);
                        }
                      : undefined
                  }
                  onSaveCrop={
                    perms.canSync && selectedVideo.hasLocalBlob
                      ? async ()=>{
                          // Compute the keep range from the two markers,
                          // clamped to the clip's actual duration.
                          const fullDur = selectedVideo.duration || 0;
                          const startSec = pendingCrop?.deleteUpTo ?? 0;
                          const endSec   = pendingCrop?.deleteFrom ?? fullDur;
                          if (endSec - startSec < 0.5) {
                            setCropError("Nothing to keep — markers overlap.");
                            return;
                          }
                          setCropBusy(true);
                          setCropError(null);
                          setCropProgress({ pct: 0, message: "Loading original…" });
                          try {
                            const blob = await getVideoBlob(selectedVideo.id);
                            if (!blob) {
                              setCropError("Original not on this device.");
                              setCropBusy(false); setCropProgress(null); return;
                            }
                            const result = await cropVideo({
                              source: blob,
                              startSec, endSec,
                              inputStem: `v_${selectedVideo.id}`,
                              onProgress: ({progress, message}) => setCropProgress({ pct: progress, message }),
                            });
                            setCropProgress({ pct: 0.95, message: "Saving…" });
                            const newStartUtc = (typeof selectedVideo.startUtc === "number")
                              ? selectedVideo.startUtc + Math.round(startSec * 1000)
                              : null;
                            const ok = await updateVideoBlobAndDuration(
                              selectedVideo.id, result.blob, result.durationSec, newStartUtc
                            );
                            if (!ok) {
                              setCropError("Failed to save cropped video.");
                              setCropBusy(false); setCropProgress(null); return;
                            }
                            // Recompute auto-tags for the new time window.
                            const cur = (allVideos.find(v=>v.id===selectedVideo.id) || selectedVideo) || {};
                            const startUtcForTags = (typeof newStartUtc === 'number') ? newStartUtc : cur.startUtc;
                            let mergedTags = cur.tags || [];
                            if (typeof startUtcForTags === 'number') {
                              const autoTags = new Set(computeAutoTags(startUtcForTags, result.durationSec, logData, xmlData, syncOffsets[selectedVideo.id]||0));
                              const manualTags = (cur.tags||[]).filter(t => !isAutoTag(t));
                              mergedTags = [...new Set([...autoTags, ...manualTags])];
                              await updateVideoTags(selectedVideo.id, mergedTags);
                            }
                            const patch = {
                              duration: result.durationSec,
                              size: result.bytes,
                              tags: mergedTags,
                              hasProxy: false,
                              proxyPath: null,
                              proxyUploadedAt: null,
                              objectUrl: null,
                            };
                            if (typeof newStartUtc === 'number') patch.startUtc = newStartUtc;
                            setAllVideos(p => p.map(v => v.id === selectedVideo.id ? {...v, ...patch} : v));
                            setSelectedVideo(p => p && p.id === selectedVideo.id ? {...p, ...patch} : p);
                            // Push the post-crop metadata (new tags, startUtc,
                            // duration) to the cloud row so teammates pick
                            // them up on next library load.
                            pushVideoMetadataToCloud(selectedVideo, {
                              tags: mergedTags,
                              ...(typeof newStartUtc === 'number' ? { startUtc: newStartUtc } : {}),
                              durationSec: result.durationSec,
                              bytes: result.bytes,
                            });
                            setPendingCrop(null);
                            setCropProgress(null);
                            setCropBusy(false);
                            // Reload the date so the player picks up the new blob.
                            loadDate(activeDate);
                          } catch (e) {
                            setCropError(e?.message || String(e));
                            setCropBusy(false); setCropProgress(null);
                          }
                        }
                      : undefined
                  }
                  // ↓ Save to disk — download the local blob as MP4 so the
                  // user can run native ffmpeg + VideoToolbox compression on
                  // it (much faster than ffmpeg.wasm for multi-GB sources).
                  onExportToDisk={
                    perms.canSync && selectedVideo.hasLocalBlob
                      ? async () => {
                          try {
                            const blob = await getVideoBlob(selectedVideo.id);
                            if (!blob) { alert('No local file to export.'); return; }
                            // Strip any extension from the title (camera files
                            // often end in .MP4) and tack on .mp4 so the
                            // downloaded file is unambiguous.
                            const stem = (selectedVideo.title || selectedVideo.name || 'clip').replace(/\.[^.]+$/, '');
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `${stem}.mp4`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            // Browsers need the URL alive for the duration of
                            // the streaming download. 60s is generous for any
                            // realistic SSD write speed.
                            setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60_000);
                          } catch (e) {
                            alert(`Export failed: ${e?.message || e}`);
                          }
                        }
                      : undefined
                  }
                  // ↑ Upload compressed — file picker that pushes the
                  // chosen file STRAIGHT to Bunny Stream as the cloud's
                  // "original" rendition. The IDB blob is deliberately
                  // not touched, so the coach can keep playing the full
                  // HD locally (HD-local toggle) while teammates stream
                  // the smaller compressed version's adaptive ladder.
                  onUploadCompressed={
                    perms.canSync && selectedVideo.hasLocalBlob
                      ? () => {
                          const input = document.createElement('input');
                          input.type = 'file';
                          input.accept = 'video/mp4,video/quicktime,.mp4,.mov,.m4v';
                          input.onchange = async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            try {
                              const supabase = getBrowserSupabase();
                              const { data: { user } } = await supabase.auth.getUser();
                              if (!user) { alert('You need to be signed in.'); return; }
                              const cloudId = await ensureCloudVideoId({
                                userId: user.id,
                                video: selectedVideo,
                                sessionDate: selectedVideo.sessionDate || activeDate,
                              });
                              if (!cloudId) {
                                alert('No cloud row available — check your team membership.');
                                return;
                              }
                              const label = selectedVideo.title || selectedVideo.name || cloudId;
                              setMobileSyncState({ phase: 'pushing', message: `Uploading compressed · ${label}`, progress: 0 });
                              // Reuse a pending Stream video object from a
                              // half-finished attempt so the TUS client
                              // resumes; otherwise create a fresh one.
                              let streamId = getPendingOrigStream(selectedVideo.id);
                              if (!streamId) {
                                const created = await createStreamUpload(label, file.size);
                                streamId = created?.streamId || null;
                                if (streamId) setPendingOrigStream(selectedVideo.id, streamId);
                              }
                              if (!streamId) {
                                setMobileSyncState({ phase: 'error', message: 'Stream create failed', progress: 0 });
                                alert('Could not create a Stream video.');
                                return;
                              }
                              const uploaded = await uploadFileToStream(
                                { streamId },
                                file,
                                (pct) => setMobileSyncState({
                                  phase: 'pushing',
                                  message: `Uploading compressed · ${label}`,
                                  progress: pct,
                                }),
                              );
                              if (!uploaded) {
                                setMobileSyncState({ phase: 'error', message: 'Upload interrupted', progress: 0 });
                                alert('Upload was interrupted — retry to resume.');
                                return;
                              }
                              // Flip has_original=true + record the Stream GUID.
                              await fetch(
                                `/api/videos/${encodeURIComponent(cloudId)}/renditions`,
                                {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ original: { streamId } }),
                                },
                              ).catch(()=>{});
                              clearPendingOrigStream(selectedVideo.id);
                              setAllVideos(p => p.map(v => v.id === selectedVideo.id
                                ? { ...v, hasOriginal: true, originalStreamId: streamId, streamProcessing: true, cloudId }
                                : v));
                              setSelectedVideo(p => p && p.id === selectedVideo.id
                                ? { ...p, hasOriginal: true, originalStreamId: streamId, streamProcessing: true, cloudId }
                                : p);
                              setMobileSyncState({ phase: 'done', message: `✓ Compressed uploaded · ${label}`, progress: 100 });
                              setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 3000);
                            } catch (err) {
                              console.error('[upload-compressed] failed', err);
                              setMobileSyncState({ phase: 'error', message: err?.message || 'Upload failed', progress: 0 });
                              alert(`Upload failed: ${err?.message || err}`);
                            }
                          };
                          input.click();
                        }
                      : undefined
                  }
                />
                <div style={{marginTop:12}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:2}}>
                    <div title={selectedVideo.title||""} style={{fontSize:13,fontWeight:600,color:"#E2E8F0",flex:1,marginRight:8,fontFamily:"monospace"}}>{(()=>{
                      if(selectedVideo.startUtc==null) return "—";
                      const d=new Date(selectedVideo.startUtc + (sessionTzOffset||0)*60000);
                      return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
                    })()}</div>
                    <SrcBadge source={selectedVideo.source||"local"}/>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
                    <div style={{fontSize:10,color:"#334155"}}>{fmtDate(selectedVideo.sessionDate)} · {selectedVideo.camera}{selectedVideo.duration?` · ${fmtT(selectedVideo.duration)}`:""}</div>
                    {selectedVideo.tsSource&&(<span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:selectedVideo.tsSource==="mp4-meta"?"#1D9E7515":"#F59E0B15",border:`1px solid ${selectedVideo.tsSource==="mp4-meta"?"#1D9E7530":"#F59E0B30"}`,color:selectedVideo.tsSource==="mp4-meta"?"#1D9E75":"#F59E0B"}}>{selectedVideo.tsSource==="mp4-meta"?"📷 camera metadata":"⚠ file modified time"}</span>)}
                  </div>
                  {['admin','coach'].includes(effectiveRole) && <div style={{marginBottom:12}}><SyncControl offset={syncOffsets[selectedVideo.id]||0} onChange={v=>{saveSyncOffset(selectedVideo.id,v);setSyncOffsets(p=>({...p,[selectedVideo.id]:v}));}} onSave={async(secs)=>{ await saveSyncForVideos([selectedVideo], secs); }}/></div>}
                  <div style={{marginBottom:12}}>
                    {/* Where the start time CAME FROM. The import log lives in the
                        Upload tab, which the app leaves the moment an import finishes —
                        so this rode along on the clip instead. It states the two
                        timestamps the file carries and how they relate to its duration,
                        which is what decides whether a stamp marks the start or the end
                        of the recording. */}
                    {(selectedVideo.tsHow||selectedVideo.tsDiag)&&(
                      <div style={{background:selectedVideo.tsSuspect?"#F59E0B12":"#071624",
                        border:`1px solid ${selectedVideo.tsSuspect?"#F59E0B40":"#1E3A5A"}`,
                        borderRadius:7,padding:"7px 9px",marginBottom:8}}>
                        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                          <span style={{fontSize:10,fontWeight:700,color:selectedVideo.tsSuspect?"#F59E0B":"#7DD3FC",letterSpacing:0.5}}>
                            TIMESTAMP{selectedVideo.cameraVendor?` · ${selectedVideo.cameraVendor}`:""}
                          </span>
                          <button onClick={()=>{
                            const txt=[selectedVideo.name,selectedVideo.tsHow,selectedVideo.tsDiag].filter(Boolean).join('\n');
                            try{navigator.clipboard?.writeText(txt);}catch{}
                          }} style={{marginLeft:"auto",background:"none",border:"1px solid #1E3A5A",borderRadius:4,
                            color:"#64748B",fontSize:9,padding:"1px 6px",cursor:"pointer"}}>Copy</button>
                        </div>
                        {selectedVideo.tsHow&&<div style={{fontSize:10,color:"#94A3B8",lineHeight:1.4}}>{selectedVideo.tsHow}</div>}
                        {selectedVideo.tsDiag&&<div style={{fontSize:9,color:"#64748B",fontFamily:"monospace",marginTop:3,wordBreak:"break-word",lineHeight:1.45}}>{selectedVideo.tsDiag}</div>}
                      </div>
                    )}
                    <StartTimeEditor video={selectedVideo} logData={logData} sessionTzOffset={sessionTzOffset} onSave={async(id,startUtc)=>{
                      // The clip's DAY = the venue-local date of the new start time.
                      // Recompute it so the clip moves to the right folder (not just
                      // its displayed time).
                      const newDate=new Date(startUtc+(sessionTzOffset||0)*60000).toISOString().slice(0,10);
                      const oldDate=selectedVideo.sessionDate||activeDate;
                      await updateVideoStartUtc(id,startUtc,newDate);
                      const updatedVideo={...selectedVideo,startUtc,sessionDate:newDate};
                      const autoTags=computeAutoTags(startUtc,selectedVideo.duration,logData,xmlData,syncOffsets[id]||0);
                      const autoTags2=new Set(computeAutoTags(startUtc,selectedVideo.duration,logData,xmlData,syncOffsets[id]||0));const manualTags=(selectedVideo.tags||[]).filter(t=>!autoTags2.has(t));
                      const mergedTags=[...new Set([...autoTags,...manualTags])];
                      await updateVideoTags(id,mergedTags);
                      // Push to cloud so teammates / other devices pick up the new
                      // start time, folder date + recomputed tag set.
                      pushVideoMetadataToCloud(selectedVideo,{startUtc,tags:mergedTags,sessionDate:newDate});
                      const enriched=enrichVideo({...updatedVideo,tags:mergedTags},logData,xmlData,syncOffsets);
                      setAllVideos(p=>p.map(v=>v.id===id?enriched:v));
                      setSelectedVideo(enriched);
                      // Day changed → open the corrected folder (and load its log)
                      // so the clip doesn't appear to vanish from the old one.
                      if(newDate!==oldDate) loadDate(newDate);
                    }}/>
                  </div>
                  {/* Crop status banner — only renders when there's an
                      error to surface or the user marked a cut but the
                      original blob isn't on this device. The whole crop
                      UI is otherwise inside the video player toolbar. */}
                  {perms.canSync && (
                    <VideoCropStatusBanner
                      video={selectedVideo}
                      pendingCrop={pendingCrop}
                      cropError={cropError}
                      onDismissError={()=>setCropError(null)}
                    />
                  )}
                  {/* Manual proxy sync — any role that can import sees
                      this. Auto-sync runs in the background after each
                      import (see enqueueAutoSync), but the manual button
                      stays useful for re-syncing after a crop or for
                      retrying a previously-failed upload. */}
                  {perms.canImport && (
                    <RenditionSyncPanel
                      video={selectedVideo}
                      activeDate={activeDate}
                      onSynced={(id, {proxyStreamId, proxyBytes, cloudId}) => {
                        // Proxy is now on Bunny Stream and encoding — flag it
                        // processing so the poll effect swaps in the adaptive
                        // URL once Bunny finishes, with no manual reload.
                        const patch = { hasProxy: true, proxyStreamId, cloudId, streamProcessing: true, proxyUploadedAt: new Date().toISOString() };
                        if (typeof proxyBytes === 'number') patch.proxyBytes = proxyBytes;
                        setAllVideos(p => p.map(v => v.id === id ? {...v, ...patch} : v));
                        setSelectedVideo(p => p && p.id === id ? {...p, ...patch} : p);
                      }}
                    />
                  )}
                  {['admin','coach','tl2'].includes(effectiveRole)&&<TagEditor video={selectedVideo} tagList={sessionTagList} suggestionList={tagSuggestionList} sessionDate={activeDate} onTagListChange={async updated=>{
                    setSessionTagList(updated);
                    try {
                      const supabase=getBrowserSupabase();
                      const {data:{user}}=await supabase.auth.getUser();
                      if(user) await saveTagListCloud({userId:user.id,date:activeDate,tags:updated});
                      else saveTagList(activeDate,updated);
                    } catch { saveTagList(activeDate,updated); }
                  }} onSave={async (id,tags)=>{ const vid=allVideos.find(v=>v.id===id)||selectedVideo; await saveTagsForVideo(vid, tags); }}/>}
                  <ShareButton video={selectedVideo} canShare={canRotate}/>
                  {perms.canDelete&&(<DeleteButton video={selectedVideo} cloudStatus={cloudStatus} onDeleted={id=>{setAllVideos(p=>p.filter(v=>v.id!==id));setSelectedVideo(null);saveSyncOffset(id,0);}}/>)}
                </div>
              </div>
            )}
          </main>
        </div>

        {/* ── ANALYTICS PANE — lazy-mounted on first visit, then kept alive ─── */}
        {hasMountedAnalytics&&(
          <div style={{
            position:"absolute",inset:0,display:"flex",overflow:"hidden",
            visibility:activeTab==="analytics"?"visible":"hidden",
            pointerEvents:activeTab==="analytics"?"auto":"none",
            zIndex:activeTab==="analytics"?2:1,
          }}>
            <ErrorBoundary label="Analytics"><AnalyticsTab
              logData={logData} xmlData={xmlData} allVideos={allVideos}
              sessions={sessions} selectedVideo={selectedVideo}
              onSelectVideo={setSelectedVideo} setActiveTab={setActiveTab}
              activeDate={activeDate}
              onSelectDate={loadDate}
              playUtc={playUtc}
              visible={activeTab==="analytics"} photos={photos}
              canUseAI={canUseAI} canSeeAnalyticsData={canSeeAnalyticsData}
            /></ErrorBoundary>
          </div>
        )}

        {/* ── UPLOAD & ADMIN — standard conditional render ─────────────────── */}
        {activeTab==="photos"&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Photos"><PhotosTab role={role} logData={logData} xmlData={xmlData} activeDate={activeDate} sessions={visibleSessions} loadDate={loadDate} cloudStatus={cloudStatus} onPhotosChange={setPhotos} canSeeSailScanPhotos={canSeeSailScanPhotos} sessionTzOffset={sessionTzOffset} sailInventory={sailInventory} canClearDay={['admin','team_manager','coach'].includes(effectiveRole)}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="upload"&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Upload"><UploadTab role={role} cloudStatus={cloudStatus} onImported={handleImported} sailInventory={sailInventory} campaignCfg={campaignCfg} setSailDiff={setSailDiff} syncOffsets={syncOffsets}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="tools"&&(
          <div style={{position:"absolute",inset:0,overflowY:"auto",zIndex:2,background:"#030F1A"}}>
            <div style={{padding:"8px 16px",fontWeight:800,fontSize:14,color:"#E2E8F0",background:"#0F2A45",borderBottom:"1px solid #1E3A5A"}}>🎯 Squash</div>
            <div style={{position:"relative",height:"85dvh"}}><ErrorBoundary label="Squash"><SquashShotsApp/></ErrorBoundary></div>
            <div style={{padding:"8px 16px",fontWeight:800,fontSize:14,color:"#E2E8F0",background:"#0F2A45",borderTop:"2px solid #1E3A5A",borderBottom:"1px solid #1E3A5A"}}>⛵ SailScan</div>
            <div style={{position:"relative",height:"85dvh"}}><ErrorBoundary label="SailScan"><SailScanTab teamId={campaignCfg?.teamId} boatId={campaignCfg?.boatId}/></ErrorBoundary></div>
          </div>
        )}
        {activeTab==="admin"&&(
          <div style={{position:"absolute",inset:0,overflowY:"auto",padding:20,zIndex:2}}>
            <ErrorBoundary label="Admin"><AdminTab
              unsyncedCount={unsyncedCount}
              cloudStatus={cloudStatus}
              sessions={sessions}
              setSessions={setSessions}
              setLogData={setLogData}
              setXmlData={setXmlData}
            /></ErrorBoundary>
          </div>
        )}
        {activeTab==="campaign"&&campaignOn&&effectiveRole!=='guest'&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Campaign"><CampaignTab teamId={campaignCfg.teamId} boatId={campaignCfg.boatId} role={effectiveRole} config={campaignCfg} isMobile={false} onOpenVideo={openCampaignVideo}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="boatconfig"&&campaignOn&&canSeeBoatConfig&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Boat config"><BoatConfigTab teamId={campaignCfg.teamId} boatId={campaignCfg.boatId} role={effectiveRole} config={campaignCfg} isMobile={false} sessionTzOffset={sessionTzOffset}/></ErrorBoundary>
          </div>
        )}
        {/* Weather — wind-analysis tool, available to all roles (sub-features gated by role inside). */}
        {activeTab==="weather"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Weather"><WeatherTab isMobile={false} effectiveRole={effectiveRole} boatName={campaignCfg?.boatName} eventName={campaignCfg?.event} logData={logData}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="timeline"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Timeline"><TimelineTab teamId={campaignCfg?.teamId||activeMem?.team_id} boatId={campaignCfg?.boatId||activeMem?.boat_id} tzOffset={sessionTzOffset} onOpenVideo={openVideoModal}/></ErrorBoundary>
          </div>
        )}
      </div>
    </div>
    </>
    </TzCtx.Provider>
  );
}

export default SSAApp;
