// src/lib/csvLogParse.js
// ─────────────────────────────────────────────────────────────────────────────
// Flat-CSV Expedition log parser — the format used by the older Northstar 72
// exports (and any legacy session upload). Extracted verbatim from the app so
// the live upload (parseCsvWithTz) and the N72 backfill CLI share one source of
// truth. Pure / no React or browser deps.
//
// NOTE: the 2026 Northstar 76 uses a different *raw* log → src/lib/expLogParse.ts.
// ─────────────────────────────────────────────────────────────────────────────

// NMEA "ddmm.mmmmH dddmm.mmmmH" position → decimal degrees.
export function parseNmea(s) {
  if (!s || !s.trim()) return { lat: 0, lon: 0 };
  const p = s.trim().split(/\s+/);
  if (p.length < 2) return { lat: 0, lon: 0 };
  const cvt = (str, degDigits) => {
    if (!str) return 0;
    const hem = str.slice(-1);
    const num = str.slice(0, -1);
    const deg = parseFloat(num.slice(0, degDigits)) || 0;
    const min = parseFloat(num.slice(degDigits)) || 0;
    const v = deg + min / 60;
    return (hem === "S" || hem === "W") ? -v : v;
  };
  try { return { lat: cvt(p[0], 2), lon: cvt(p[1], 3) }; } catch { return { lat: 0, lon: 0 }; }
}

// Expedition "dd/mm/yy" + "hh:mm:ss" (local) → UTC ms, given the venue offset.
export function expToUtc(ds, ts, offsetMin = 0) {
  const [d, m, y] = ds.split("/").map(Number);
  const yr = y > 99 ? y : (y < 50 ? 2000 + y : 1900 + y);
  const [h, mn, sc] = ts.split(":").map(Number);
  return Date.UTC(yr, m - 1, d, h, mn, sc) - offsetMin * 60000;
}

export function parseCsvLog(text, offsetMin = 0) {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim());
  if (!lines.length) return { rows: [], startUtc: 0, endUtc: 0 };
  const rows = [];

  // Expedition writes a header row. Map column NAME → index so the parser reads
  // by name and survives reordering or inserted columns. Fixed positions are
  // fallbacks for header-less legacy exports.
  const H = {};
  const norm = s => String(s || "").toLowerCase().replace(/%/g, "pct").replace(/[^a-z0-9]/g, "");
  lines[0].split(",").forEach((name, i) => {
    const k = norm(name);
    if (k && !(k in H)) H[k] = i;
  });
  const col = (names, fallback) => {
    for (const nm of [].concat(names)) { const k = norm(nm); if (k in H) return H[k]; }
    return fallback;
  };
  const IX = {
    pos: col('pos[dddmm.mm]', 0), date: col('dd/mm/yy', 1), time: col('hhmmss', 2),
    heel: col('heel', 3), bsp: col('boatspeed', 4), awa: col('aw_angle', 5),
    twd: col('tw_dirn', 10), twa: col('tw_angle', 11), tws: col('tw_speed', 12), vmg: col('vmg', 19),
    sog: col('ext_sog', 20),
    vsTarget: col(['vs_target', 'vs_targ'], 22),
    vsTargPct: col(['vs_targ%', 'vs_target%'], 23),
    twaTarg: col(['twa_targ', 'twa_target'], 24),
    vsPerf: col('vs_perf', 25),
    vsPerfPct: col('vs_perf%', 26),
    dstLine: col('dst_line', 29), tmLine: col('tm_line', 30),
    ttbPort: col('ttb_port', 31), ttbStbd: col('ttb_stbd', 32),
    ttbPin: col('ttb_pin', 52), ttbCB: col('ttb_cb', 53),
    timer1: col('timer-1', 55), rudder: col('rudder', 56), yawR: col('yawr', 41),
    magvar: col('magvar', 74),
  };

  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (c.length < 27) continue;
    const n = (ix) => parseFloat(c[ix]) || 0;
    const bsp = n(IX.bsp), tws = n(IX.tws);
    if (bsp < 0.05 && tws < 0.3) continue;
    const ds = c[IX.date]?.trim(), ts = c[IX.time]?.trim();
    if (!ds?.includes("/") || !ts?.includes(":")) continue;
    const utc = expToUtc(ds, ts, offsetMin);
    if (isNaN(utc)) continue;
    const pos = parseNmea(c[IX.pos]);
    const opt = (ix, zeroNull = true) => { if (ix == null || c.length <= ix) return null; const v = parseFloat(c[ix]); return (isNaN(v) || (zeroNull && v === 0)) ? null : v; };

    rows.push({
      utc, lat: pos.lat, lon: pos.lon,
      heel: n(IX.heel),
      bsp,
      awa: n(IX.awa),
      twd: n(IX.twd),
      twa: n(IX.twa),
      tws,
      sog: n(IX.sog),
      vmg: n(IX.vmg),
      vsTarget: opt(IX.vsTarget),
      vsTargPct: n(IX.vsTargPct),
      twaTarg: opt(IX.twaTarg),
      vsPerf: opt(IX.vsPerf),
      vsPerfPct: n(IX.vsPerfPct),
      dstLine: opt(IX.dstLine),
      tmLine: opt(IX.tmLine),
      ttbPort: opt(IX.ttbPort, false),
      ttbStbd: opt(IX.ttbStbd, false),
      ttbPin: opt(IX.ttbPin, false),
      ttbCB: opt(IX.ttbCB, false),
      timer1: opt(IX.timer1, true),
      rudder: n(IX.rudder),
      yawR: n(IX.yawR),
      magvar: n(IX.magvar),
    });
  }
  return { rows, startUtc: rows[0]?.utc || 0, endUtc: rows[rows.length - 1]?.utc || 0 };
}
