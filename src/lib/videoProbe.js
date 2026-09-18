
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

// Has this queued clip finished being READ? Duration is not the answer: it arrives
// from the preview <video> within a few hundred ms, while the capture time needs
// probeVideo (up to 15 s) and then a metadata scan. Auto-save used to gate on
// duration alone, so it fired while startUtc was still null — filing the clip under
// TODAY with no time and, because computeAutoTags has no window, no tags either.
// A clip whose probe FAILED counts as read: it has had its answer, and waiting on it
// would strand the whole batch.
function clipTimestampSettled(v) {
  return v.tsSource != null || !!v.error || !!v.undecodable;
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

export { _scanMvhd, _scanCameraMeta, _scanAppleCreationDate, clipTimestampSettled, extractTimestampFromFilename, probeVideo, extractVideoCreationTime, resolveStartUtc };