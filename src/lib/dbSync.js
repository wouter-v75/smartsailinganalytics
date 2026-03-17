// src/lib/dbSync.js
// ─────────────────────────────────────────────────────────────────────────────
// SmartSailingAnalytics — database sync layer
//
// When NEXT_PUBLIC_SUPABASE_URL is set, this module:
//   1. Pushes locally-stored log/XML/video metadata to Supabase (background)
//   2. Fetches sessions from past dates that aren't in local storage
//
// When Supabase is NOT configured, all functions are no-ops that return null —
// the app works entirely from local storage with no errors.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL  = typeof window !== "undefined" ? process.env.NEXT_PUBLIC_SUPABASE_URL  : null;
const SUPABASE_ANON = typeof window !== "undefined" ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY : null;
const DB_AVAILABLE  = !!(SUPABASE_URL && SUPABASE_ANON);

const TODAY = () => new Date().toISOString().slice(0, 10);

// ── Supabase fetch wrapper ────────────────────────────────────────────────────
async function sbFetch(path, options = {}) {
  if (!DB_AVAILABLE) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      headers: {
        "apikey":        SUPABASE_ANON,
        "Authorization": `Bearer ${SUPABASE_ANON}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
      },
      ...options,
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ── Check if DB is reachable ──────────────────────────────────────────────────
export async function checkDbConnection() {
  if (!DB_AVAILABLE) return { available: false, reason: "Supabase not configured" };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/sessions?select=id&limit=1`, {
      headers: { "apikey": SUPABASE_ANON, "Authorization": `Bearer ${SUPABASE_ANON}` },
      signal: AbortSignal.timeout(3000),
    });
    return { available: res.ok, reason: res.ok ? "Connected" : `HTTP ${res.status}` };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ── Push local session data to DB ─────────────────────────────────────────────
export async function syncSessionToDb(date, logData, xmlData, videoMetas) {
  if (!DB_AVAILABLE) return { success: false, skipped: true };

  try {
    // 1. Upsert session record
    await sbFetch("/sessions", {
      method: "POST",
      body: JSON.stringify({
        date,
        boat:       xmlData?.meta?.boat     || null,
        location:   xmlData?.meta?.location || null,
        day_type:   xmlData?.meta?.dayType  || null,
        has_log:    !!logData,
        has_xml:    !!xmlData,
        video_count: videoMetas?.length || 0,
        updated_at: new Date().toISOString(),
      }),
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
    });

    // 2. Push log rows in batches of 500
    if (logData?.rows?.length) {
      const BATCH = 500;
      for (let i = 0; i < logData.rows.length; i += BATCH) {
        const batch = logData.rows.slice(i, i + BATCH).map(r => ({
          session_date: date,
          utc_ms:       r.utc,
          lat:          r.lat,
          lon:          r.lon,
          tws:          r.tws,
          twa:          r.twa,
          bsp:          r.bsp,
          sog:          r.sog,
          heel:         r.heel,
          vmg:          r.vmg,
          vs_targ_pct:  r.vsTargPct,
          rudder:       r.rudder,
        }));
        await sbFetch("/log_rows", { method: "POST", body: JSON.stringify(batch) });
      }
    }

    // 3. Push event markers
    if (xmlData) {
      const markers = [
        ...(xmlData.tackJibes || []).map(tj => ({
          session_date: date, utc_ms: tj.utc,
          marker_type: tj.isTack ? "tack" : "gybe",
          is_valid: tj.isValid, label: tj.label,
        })),
        ...(xmlData.markRoundings || []).map(mr => ({
          session_date: date, utc_ms: mr.utc,
          marker_type: mr.isTop ? "top_mark" : "leeward_gate",
          is_valid: mr.isValid, label: mr.label,
        })),
        ...(xmlData.sailsUpEvents || []).map(su => ({
          session_date: date, utc_ms: su.utc,
          marker_type: "sail_change", is_valid: true,
          label: su.sails.join(", "),
        })),
      ];
      if (markers.length) {
        await sbFetch("/event_markers", { method: "POST", body: JSON.stringify(markers) });
      }
    }

    // 4. Push video metadata (no blobs — videos stay in R2/Cloudflare)
    if (videoMetas?.length) {
      const metas = videoMetas.map(v => ({
        id:           v.id,
        session_date: date,
        name:         v.name,
        size:         v.size,
        duration:     v.duration,
        camera:       v.camera,
        title:        v.title,
        tags:         v.tags,
        added_at:     new Date(v.addedAt).toISOString(),
      }));
      await sbFetch("/videos", { method: "POST", body: JSON.stringify(metas) });
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Fetch sessions from DB for dates NOT in local storage ──────────────────────
export async function fetchRemoteSessions(excludeDates = []) {
  if (!DB_AVAILABLE) return [];
  const exclude = [...excludeDates, TODAY()].map(d => `"${d}"`).join(",");
  const data = await sbFetch(
    `/sessions?select=date,boat,location,video_count,has_log,has_xml&date=not.in.(${exclude})&order=date.desc&limit=90`
  );
  return data || [];
}

// ── Fetch log rows from DB for a specific date ────────────────────────────────
export async function fetchRemoteLogRows(date) {
  if (!DB_AVAILABLE) return null;
  const data = await sbFetch(
    `/log_rows?session_date=eq.${date}&select=utc_ms,lat,lon,tws,twa,bsp,sog,heel,vmg,vs_targ_pct,rudder&order=utc_ms.asc&limit=50000`
  );
  if (!data?.length) return null;
  return {
    rows: data.map(r => ({
      utc: r.utc_ms, lat: r.lat, lon: r.lon,
      tws: r.tws, twa: r.twa, bsp: r.bsp, sog: r.sog,
      heel: r.heel, vmg: r.vmg, vsTargPct: r.vs_targ_pct, rudder: r.rudder,
    })),
    source: "remote",
  };
}

// ── Fetch event markers from DB for a specific date ────────────────────────────
export async function fetchRemoteXmlData(date) {
  if (!DB_AVAILABLE) return null;
  const data = await sbFetch(
    `/event_markers?session_date=eq.${date}&select=utc_ms,marker_type,is_valid,label&order=utc_ms.asc`
  );
  if (!data?.length) return null;
  return {
    tackJibes:     data.filter(m => m.marker_type === "tack" || m.marker_type === "gybe")
                       .map(m => ({ utc: m.utc_ms, isTack: m.marker_type === "tack", isValid: m.is_valid, label: m.label, color: m.marker_type === "tack" ? "#1D9E75" : "#7F77DD" })),
    markRoundings: data.filter(m => m.marker_type === "top_mark" || m.marker_type === "leeward_gate")
                       .map(m => ({ utc: m.utc_ms, isTop: m.marker_type === "top_mark", isValid: m.is_valid, label: m.label, color: m.marker_type === "top_mark" ? "#EF4444" : "#8B5CF6" })),
    sailsUpEvents: data.filter(m => m.marker_type === "sail_change")
                       .map(m => ({ utc: m.utc_ms, sails: m.label.split(", "), label: m.label })),
    source: "remote",
  };
}

// ── Fetch video metadata from DB for a specific date ──────────────────────────
export async function fetchRemoteVideos(date) {
  if (!DB_AVAILABLE) return [];
  const data = await sbFetch(
    `/videos?session_date=eq.${date}&select=id,name,size,duration,camera,title,tags,added_at&order=added_at.asc`
  );
  if (!data?.length) return [];
  return data.map(v => ({
    id:          v.id,
    name:        v.name,
    size:        v.size,
    duration:    v.duration,
    camera:      v.camera,
    title:       v.title,
    tags:        v.tags || [],
    addedAt:     new Date(v.added_at).getTime(),
    sessionDate: date,
    objectUrl:   null, // no blob for remote videos — would be served from R2
    syncedToDb:  true,
    source:      "remote",
  }));
}

export { DB_AVAILABLE };
