'use client'
import { useState, useEffect, useRef, useCallback } from "react";
import {
  saveVideo, getVideosForDate, getAllVideos, updateVideoTags,
  saveLogData, getLogData, saveXmlData, getXmlData,
  computeAutoTags, getSessions, getUnsyncedCount,
} from "../lib/localStore";
import {
  checkDbConnection, syncSessionToDb, fetchRemoteSessions,
  fetchRemoteLogRows, fetchRemoteXmlData, fetchRemoteVideos, DB_AVAILABLE,
} from "../lib/dbSync";

// ─── CSV PARSER ──────────────────────────────────────────────────────────────
function parseNmea(s) {
  const p = s.trim().split(/\s+/);
  if (p.length < 2) return { lat: 0, lon: 0 };
  const f = (str, d) => {
    const h = str.slice(-1), n = str.slice(0, -1);
    const v = parseFloat(n.slice(0, d)) + parseFloat(n.slice(d)) / 60;
    return h === "S" || h === "W" ? -v : v;
  };
  try { return { lat: f(p[0], 2), lon: f(p[1], 3) }; } catch { return { lat: 0, lon: 0 }; }
}
function expToUtc(ds, ts) {
  const [d, m, y] = ds.split("/").map(Number);
  const yr = y < 50 ? 2000 + y : 1900 + y;
  const [h, mn, sc] = ts.split(":").map(Number);
  return Date.UTC(yr, m - 1, d, h, mn, sc);
}
function parseCsvLog(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (c.length < 27) continue;
    const bsp = parseFloat(c[4]) || 0, tws = parseFloat(c[12]) || 0;
    if (bsp < 0.05 && tws < 0.3) continue;
    const ds = c[1]?.trim(), ts = c[2]?.trim();
    if (!ds?.includes("/") || !ts?.includes(":")) continue;
    const utc = expToUtc(ds, ts);
    if (isNaN(utc)) continue;
    const pos = parseNmea(c[0]);
    rows.push({ utc, lat: pos.lat, lon: pos.lon,
      heel: parseFloat(c[3]) || 0, bsp, twa: parseFloat(c[11]) || 0, tws,
      sog: parseFloat(c[20]) || 0, vmg: parseFloat(c[19]) || 0,
      vsTargPct: parseFloat(c[23]) || 0, vsPerfPct: parseFloat(c[26]) || 0,
      rudder: parseFloat(c[52]) || 0 });
  }
  return { rows, startUtc: rows[0]?.utc || 0, endUtc: rows[rows.length - 1]?.utc || 0 };
}

// ─── XML PARSER ──────────────────────────────────────────────────────────────
function isoUtc(s) { return new Date(s.trim().replace(" ", "T") + "Z").getTime(); }
function parseXmlEvents(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const ga = (el, a, d = "") => el?.getAttribute(a) ?? d;
  const meta = {
    boat: ga(doc.querySelector("boat"), "val"),
    location: ga(doc.querySelector("location"), "val"),
    date: ga(doc.querySelector("date"), "val"),
    sailsUsed: (ga(doc.querySelector("sailsused"), "val") || "").split(";").map(s => s.trim()).filter(Boolean),
  };
  const sailsUpEvents = [], raceGuns = [];
  for (const ev of doc.getElementsByTagName("event")) {
    const utc = isoUtc(`${ga(ev,"date")} ${ga(ev,"time")}`);
    const type = ga(ev, "type"), attr = ga(ev, "attribute");
    if (type === "SailsUp") {
      const sails = attr.split(";").map(s => s.trim()).filter(Boolean);
      sailsUpEvents.push({ utc, sails, label: sails.join(" + ") || "Sails changed" });
    } else if (type === "RaceStartGun") {
      raceGuns.push({ utc, raceNum: parseInt(attr) || 0, label: `Race ${attr} gun` });
    }
  }
  const markRoundings = Array.from(doc.getElementsByTagName("markrounding")).map(mr => ({
    utc: isoUtc(ga(mr, "datetime")), isTop: ga(mr, "istopmark") === "true",
    isValid: ga(mr, "isvalid") === "true",
    label: ga(mr, "istopmark") === "true" ? "Top mark" : "Leeward gate",
    color: ga(mr, "istopmark") === "true" ? "#EF4444" : "#8B5CF6",
  }));
  const tackJibes = Array.from(doc.getElementsByTagName("tackjibe")).map(tj => ({
    utc: isoUtc(ga(tj, "datetime")), isTack: ga(tj, "istack") === "true",
    isValid: ga(tj, "isvalidperf") === "true",
    label: ga(tj, "istack") === "true" ? "Tack" : "Gybe",
    color: ga(tj, "istack") === "true" ? "#1D9E75" : "#7F77DD",
  }));
  return { meta, sailsUpEvents, raceGuns, markRoundings, tackJibes };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const R = (n, d = 1) => (n == null || isNaN(n)) ? "--" : Number(n).toFixed(d);
const fmtT = secs => { const s = Math.max(0, Math.floor(secs)); return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`; };
const fmtUtc = utc => utc ? new Date(utc).toISOString().slice(11,19) : "--:--:--";
const TODAY = () => new Date().toISOString().slice(0, 10);
const fmtSize = b => b > 1e9 ? `${(b/1e9).toFixed(1)} GB` : `${(b/1e6).toFixed(0)} MB`;

function nearestRow(rows, utc) {
  if (!rows?.length) return null;
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) { const mid = (lo+hi)>>1; if (rows[mid].utc < utc) lo = mid+1; else hi = mid; }
  if (lo > 0 && Math.abs(rows[lo-1].utc-utc) < Math.abs(rows[lo].utc-utc)) lo--;
  return Math.abs(rows[lo].utc - utc) < 120000 ? rows[lo] : null;
}

function enrichVideo(v, log, xml) {
  if (!log?.rows?.length || !v.startUtc) return v;
  const winStart = v.startUtc, winEnd = v.startUtc + (v.duration||0)*1000;
  const rows = log.rows.filter(r => r.utc >= winStart && r.utc <= winEnd);
  if (!rows.length) return v;
  const avg = f => rows.reduce((s,r) => s+(r[f]||0), 0) / rows.length;
  return { ...v, twsAvg: avg("tws"), sogAvg: avg("sog"), heelAvg: avg("heel") };
}

// ─── GAUGE ────────────────────────────────────────────────────────────────────
function Gauge({ label, value, unit, color="#06B6D4" }) {
  return (
    <div style={{ background:"rgba(0,0,0,0.75)", border:`1px solid ${color}40`, borderRadius:7, padding:"7px 11px", minWidth:76 }}>
      <div style={{ fontSize:9, color:"#64748B", letterSpacing:2, textTransform:"uppercase", marginBottom:2 }}>{label}</div>
      <div style={{ fontSize:23, fontWeight:700, color, fontFamily:"'Courier New',monospace", lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:10, color:"#475569", marginTop:1 }}>{unit}</div>
    </div>
  );
}

// ─── SOURCE BADGE ─────────────────────────────────────────────────────────────
function SrcBadge({ source }) {
  const local = !source || source === "local";
  return <span style={{ fontSize:9, padding:"1px 5px", borderRadius:3, letterSpacing:1, fontWeight:600, background:local?"#06B6D415":"#8B5CF615", border:`1px solid ${local?"#06B6D430":"#8B5CF630"}`, color:local?"#06B6D4":"#8B5CF6" }}>{local?"LOCAL":"DB"}</span>;
}

// ─── VIDEO PLAYER ─────────────────────────────────────────────────────────────
function VideoPlayer({ video, logData, xmlData, syncOffset }) {
  const vidRef = useRef(null);
  const [curTime, setCurTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dur, setDur] = useState(video.duration || 0);

  useEffect(() => { if (vidRef.current) { vidRef.current.currentTime = 0; setCurTime(0); setPlaying(false); } }, [video.id]);

  const logUtc = video.startUtc ? video.startUtc + (curTime + (syncOffset||0)) * 1000 : 0;
  const row = logData && logUtc ? nearestRow(logData.rows, logUtc) : null;

  const markers = xmlData && video.startUtc ? [
    ...(xmlData.tackJibes||[]), ...(xmlData.markRoundings||[]),
    ...(xmlData.sailsUpEvents||[]).map(s => ({...s, color:"#F59E0B"})),
  ].map(m => ({ ...m, vidSec: (m.utc - video.startUtc)/1000 - (syncOffset||0) }))
   .filter(m => m.vidSec >= 0 && m.vidSec <= dur) : [];

  const upcoming = markers.filter(m => m.vidSec > curTime && m.vidSec < curTime + 30).slice(0,2);
  const progress = dur > 0 ? (curTime/dur)*100 : 0;
  const onUpdate = () => { if (vidRef.current) { setCurTime(vidRef.current.currentTime); setPlaying(!vidRef.current.paused); } };
  const seekPct = e => { const r = e.currentTarget.getBoundingClientRect(); if (vidRef.current) vidRef.current.currentTime = ((e.clientX-r.left)/r.width)*dur; };

  return (
    <div style={{ background:"#030F1A", borderRadius:12, overflow:"hidden", border:"1px solid #1E3A5A" }}>
      <div style={{ position:"relative", background:"#000", height:290, display:"flex", alignItems:"center", justifyContent:"center" }}>
        {video.objectUrl ? (
          <video ref={vidRef} src={video.objectUrl} style={{ width:"100%", height:"100%", objectFit:"contain" }}
            onTimeUpdate={onUpdate} onPlay={onUpdate} onPause={onUpdate} onLoadedMetadata={e => setDur(e.target.duration)} />
        ) : (
          <div style={{ color:"#334155", fontSize:12, textAlign:"center" }}>
            <div style={{ fontSize:28, marginBottom:8 }}>📹</div>
            {video.source === "remote" ? "Remote video — R2 not yet configured" : "No video file"}
          </div>
        )}
        {!playing && video.objectUrl && (
          <div onClick={() => vidRef.current?.play()} style={{ position:"absolute", width:52, height:52, background:"rgba(6,182,212,0.9)", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:18 }}>▶</div>
        )}
        {row && (
          <div style={{ position:"absolute", top:10, left:10, display:"flex", gap:5 }}>
            <Gauge label="TWS" value={R(row.tws)} unit="kn" color="#06B6D4" />
            <Gauge label="TWA" value={`${R(row.twa,0)}°`} unit="true" color="#8B5CF6" />
            <Gauge label="SOG" value={R(row.sog)} unit="kn" color="#10B981" />
            <Gauge label="Heel" value={`${R(row.heel,0)}°`} unit="°" color="#F59E0B" />
          </div>
        )}
        {upcoming.length > 0 && (
          <div style={{ position:"absolute", top:10, right:10, display:"flex", flexDirection:"column", gap:4 }}>
            {upcoming.map((m,i) => (
              <div key={i} style={{ background:"rgba(0,0,0,0.8)", borderRadius:5, padding:"3px 7px", fontSize:10, color:m.color, border:`1px solid ${m.color}40` }}>
                {m.label} in {Math.round(m.vidSec - curTime)}s
              </div>
            ))}
          </div>
        )}
        <div style={{ position:"absolute", bottom:8, right:8, background:"rgba(0,0,0,0.7)", borderRadius:4, padding:"2px 7px", fontSize:10, color:"#64748B", fontFamily:"monospace" }}>
          {fmtT(curTime)} / {fmtT(dur)}{logUtc ? `  ${fmtUtc(logUtc)}` : ""}
        </div>
      </div>
      {/* Timeline */}
      <div style={{ padding:"8px 12px 0" }}>
        <div style={{ position:"relative", height:26, background:"#071624", borderRadius:4, cursor:"pointer", overflow:"hidden" }} onClick={seekPct}>
          <div style={{ position:"absolute", left:0, top:0, bottom:0, width:`${progress}%`, background:"#06B6D430", transition:"width 0.5s linear" }} />
          <div style={{ position:"absolute", left:`${progress}%`, top:0, bottom:0, width:2, background:"#06B6D4", transform:"translateX(-50%)" }} />
          {markers.map((m,i) => (
            <div key={i} onClick={e => { e.stopPropagation(); if(vidRef.current) vidRef.current.currentTime=m.vidSec; }}
              title={`${m.label} at +${fmtT(m.vidSec)}`}
              style={{ position:"absolute", left:`${(m.vidSec/dur)*100}%`, top:0, bottom:0, width:2, background:m.color, opacity:m.isValid===false?0.3:1, cursor:"pointer" }} />
          ))}
          <span style={{ position:"absolute", left:6, top:"50%", transform:"translateY(-50%)", fontSize:9, color:"#334155", pointerEvents:"none", fontFamily:"monospace" }}>
            {markers.length > 0 ? `${markers.length} events — click to jump` : row ? "● live data" : "click to seek"}
          </span>
        </div>
      </div>
      {/* Controls */}
      <div style={{ padding:"8px 12px 12px", display:"flex", gap:7, alignItems:"center" }}>
        <button onClick={() => playing ? vidRef.current?.pause() : vidRef.current?.play()} style={{ background:"#06B6D4", border:"none", borderRadius:6, padding:"6px 14px", color:"#000", fontWeight:700, cursor:"pointer", fontSize:12 }}>
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button onClick={() => { if(vidRef.current) vidRef.current.currentTime=0; }} style={{ background:"#1E3A5A", border:"none", borderRadius:6, padding:"6px 9px", color:"#94A3B8", cursor:"pointer" }}>⏹</button>
        <div style={{ flex:1 }} />
        {row && <span style={{ fontSize:10, color:"#1D9E75" }}>● live instruments</span>}
        {!video.startUtc && video.objectUrl && <span style={{ fontSize:10, color:"#F59E0B" }}>Set start time to sync data</span>}
      </div>
    </div>
  );
}

// ─── VIDEO CARD ───────────────────────────────────────────────────────────────
function VideoCard({ video, selected, onClick }) {
  const manTags = (video.tags||[]).filter(t => ["tack","gybe","top-mark","leeward-gate","upwind","downwind","reaching"].includes(t));
  const otherTags = (video.tags||[]).filter(t => !["tack","gybe","top-mark","leeward-gate","upwind","downwind","reaching","local","remote","training","today"].includes(t) && !t.startsWith("tws-") && !t.includes(".") && !t.includes("/")).slice(0, 2);

  return (
    <div onClick={onClick} style={{ background:selected?"#0F2A45":"#0A1929", border:`2px solid ${selected?"#06B6D4":"#1E3A5A"}`, borderRadius:12, overflow:"hidden", cursor:"pointer", transition:"border-color 0.12s" }}>
      <div style={{ height:105, background:"#071624", display:"flex", alignItems:"center", justifyContent:"center", position:"relative", overflow:"hidden" }}>
        {video.objectUrl ? (
          <video src={video.objectUrl} style={{ width:"100%", height:"100%", objectFit:"cover" }} muted preload="metadata" />
        ) : (
          <div style={{ color:"#1E3A5A", fontSize:10, textAlign:"center" }}><div style={{ fontSize:26, marginBottom:4, opacity:0.4 }}>📹</div>Remote</div>
        )}
        <div style={{ position:"absolute", bottom:5, right:5, background:"rgba(0,0,0,0.75)", borderRadius:3, padding:"1px 4px", fontSize:9, color:"#64748B", fontFamily:"monospace" }}>{video.duration ? fmtT(video.duration) : "--:--"}</div>
        <div style={{ position:"absolute", top:5, right:5 }}><SrcBadge source={video.source} /></div>
        {video.camera && <div style={{ position:"absolute", top:5, left:5, background:"rgba(0,0,0,0.7)", borderRadius:3, padding:"1px 4px", fontSize:9, color:"#475569" }}>{video.camera}</div>}
      </div>
      <div style={{ padding:"9px 11px" }}>
        <div style={{ fontSize:11, fontWeight:600, color:"#E2E8F0", marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{video.title}</div>
        <div style={{ fontSize:10, color:"#334155", marginBottom:6 }}>{video.sessionDate}</div>
        {video.twsAvg != null && (
          <div style={{ display:"flex", gap:4, marginBottom:7 }}>
            {[["TWS",video.twsAvg,"kt"],["SOG",video.sogAvg,"kt"],["Heel",video.heelAvg,"°"]].map(([l,v,u]) => (
              <div key={l} style={{ flex:1, background:"#071624", borderRadius:4, padding:"3px 0", textAlign:"center" }}>
                <div style={{ fontSize:8, color:"#334155" }}>{l}</div>
                <div style={{ fontSize:11, fontWeight:700, color:"#06B6D4", fontFamily:"monospace" }}>{R(v)}</div>
                <div style={{ fontSize:8, color:"#334155" }}>{u}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
          {[...manTags, ...otherTags].slice(0,5).map(t => (
            <span key={t} style={{ background:"#1E3A5A", color:"#7DD3FC", fontSize:9, borderRadius:3, padding:"1px 4px", fontFamily:"monospace" }}>#{t}</span>
          ))}
          {(video.tags||[]).length > 5 && <span style={{ fontSize:9, color:"#334155" }}>+{video.tags.length-5}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── TAG EDITOR ───────────────────────────────────────────────────────────────
function TagEditor({ video, onSave }) {
  const [tags, setTags] = useState(video.tags||[]);
  const [input, setInput] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setTags(video.tags||[]); setDirty(false); }, [video.id]);
  const add = () => { if (input.trim() && !tags.includes(input.trim())) { setTags(p => [...p, input.trim()]); setInput(""); setDirty(true); } };
  const rem = t => { setTags(p => p.filter(x => x!==t)); setDirty(true); };
  const save = async () => { await updateVideoTags(video.id, tags); onSave(video.id, tags); setDirty(false); };
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:7 }}>
        <div style={{ fontSize:9, fontWeight:700, color:"#475569", letterSpacing:2, textTransform:"uppercase" }}>Tags</div>
        {dirty && <button onClick={save} style={{ background:"#1D9E75", border:"none", borderRadius:4, padding:"2px 9px", color:"#fff", fontSize:10, cursor:"pointer", fontWeight:700 }}>Save</button>}
      </div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:8, minHeight:24 }}>
        {tags.map(t => (
          <span key={t} onClick={() => rem(t)} style={{ background:"#1E3A5A", color:"#7DD3FC", fontSize:10, borderRadius:4, padding:"2px 7px", cursor:"pointer", display:"flex", gap:3, alignItems:"center" }}>
            #{t} <span style={{ color:"#EF4444", fontSize:9 }}>×</span>
          </span>
        ))}
        {!tags.length && <span style={{ fontSize:10, color:"#334155" }}>No tags — auto-tags added on import</span>}
      </div>
      <div style={{ display:"flex", gap:5 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key==="Enter"&&add()} placeholder="Add tag…"
          style={{ flex:1, background:"#071624", border:"1px solid #1E3A5A", borderRadius:5, padding:"5px 8px", color:"#E2E8F0", fontSize:11, fontFamily:"monospace", outline:"none" }} />
        <button onClick={add} style={{ background:"#06B6D4", border:"none", borderRadius:5, padding:"5px 11px", color:"#000", fontWeight:700, cursor:"pointer", fontSize:12 }}>+</button>
      </div>
    </div>
  );
}

// ─── SYNC CONTROL ─────────────────────────────────────────────────────────────
function SyncControl({ offset, onChange }) {
  return (
    <div style={{ background:"#071624", borderRadius:7, padding:"9px 11px", border:"1px solid #1E3A5A" }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:7 }}>
        <span style={{ fontSize:9, color:"#475569", letterSpacing:2, textTransform:"uppercase" }}>Video sync offset</span>
        <span style={{ fontSize:11, fontFamily:"monospace", color:offset!==0?"#F59E0B":"#334155" }}>{offset>0?"+":""}{offset}s</span>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:3, marginBottom: offset!==0?6:0 }}>
        {[[-3600,"-1h"],[-60,"-1m"],[-10,"-10s"],[-1,"-1s"],[1,"+1s"],[10,"+10s"],[60,"+1m"],[3600,"+1h"]].map(([v,l]) => (
          <button key={l} onClick={() => onChange(offset+v)} style={{ background:"#1E3A5A", border:"none", borderRadius:3, padding:"4px 0", color:"#7DD3FC", cursor:"pointer", fontSize:10, fontFamily:"monospace" }}>{l}</button>
        ))}
      </div>
      {offset!==0 && <button onClick={() => onChange(0)} style={{ width:"100%", background:"none", border:"1px solid #EF444440", borderRadius:4, padding:"3px", color:"#EF4444", cursor:"pointer", fontSize:10 }}>Reset</button>}
    </div>
  );
}

// ─── UPLOAD TAB ───────────────────────────────────────────────────────────────
function UploadTab({ onImported }) {
  const vidInpRef = useRef(null), csvRef = useRef(null), xmlRef = useRef(null);
  const [pendingVids, setPendingVids] = useState([]);
  const [csvParsed, setCsvParsed]     = useState(null);
  const [xmlParsed, setXmlParsed]     = useState(null);
  const [csvFile, setCsvFile]         = useState(null);
  const [xmlFile, setXmlFile]         = useState(null);
  const [dragOver, setDragOver]       = useState(false);
  const [status, setStatus]           = useState(null);
  const [importing, setImporting]     = useState(false);

  const handleVids = useCallback(files => {
    const valid = Array.from(files).filter(f => f.type.startsWith("video/") || /\.(mp4|mov|mts|avi|mkv|m4v)$/i.test(f.name));
    if (!valid.length) { setStatus({ msg:"No video files recognised. Supported: MP4 MOV MTS AVI.", type:"error" }); return; }
    setPendingVids(p => [...p, ...valid.map(f => ({ id:Math.random().toString(36).slice(2), file:f, name:f.name, size:f.size, url:URL.createObjectURL(f), duration:null }))]);
    setStatus({ msg:`${valid.length} video${valid.length>1?"s":""} ready`, type:"ok" });
  }, []);

  const handleCsv = useCallback(file => {
    if (!file) return; setCsvFile(file);
    setStatus({ msg:"Parsing log file…", type:"loading" });
    const r = new FileReader();
    r.onload = e => {
      try {
        const p = parseCsvLog(e.target.result);
        setCsvParsed(p);
        const d = p.startUtc ? new Date(p.startUtc).toISOString().slice(0,10) : "?";
        setStatus({ msg:`Log: ${p.rows.length.toLocaleString()} rows · ${d}`, type:"ok" });
      } catch(err) { setStatus({ msg:`CSV error: ${err.message}`, type:"error" }); }
    };
    r.readAsText(file);
  }, []);

  const handleXml = useCallback(file => {
    if (!file) return; setXmlFile(file);
    setStatus({ msg:"Parsing event file…", type:"loading" });
    const r = new FileReader();
    r.onload = e => {
      try {
        const p = parseXmlEvents(e.target.result);
        setXmlParsed(p);
        setStatus({ msg:`Events: ${p.tackJibes.length} tack/gybes · ${p.markRoundings.length} marks · ${p.meta.location||"?"}`, type:"ok" });
      } catch(err) { setStatus({ msg:`XML error: ${err.message}`, type:"error" }); }
    };
    r.readAsText(file);
  }, []);

  const doImport = async () => {
    if (!pendingVids.length && !csvParsed && !xmlParsed) return;
    setImporting(true);
    setStatus({ msg:"Saving to local storage…", type:"loading" });
    const date = csvParsed?.startUtc
      ? new Date(csvParsed.startUtc).toISOString().slice(0,10)
      : xmlParsed?.meta?.date || TODAY();

    if (csvParsed) saveLogData(date, csvParsed.rows, csvFile.name, csvParsed.startUtc, csvParsed.endUtc);
    if (xmlParsed) saveXmlData(date, xmlParsed, xmlFile.name);

    const saved = [];
    for (const pv of pendingVids) {
      const autoTags = computeAutoTags(null, pv.duration, csvParsed, xmlParsed);
      try {
        const s = await saveVideo(pv.file, { duration:pv.duration, tags:autoTags, title:pv.name.replace(/\.[^.]+$/,"").replace(/[_-]/g," ") });
        saved.push(s);
      } catch(e) { setStatus({ msg:`Save error: ${e.message}`, type:"error" }); }
    }

    setStatus({ msg:`Saved ${saved.length} video${saved.length!==1?"s":""}${csvParsed?" + log":""}${xmlParsed?" + events":""} for ${date}`, type:"ok" });
    onImported({ date, videos:saved, logData:csvParsed, xmlData:xmlParsed });
    setPendingVids([]); setCsvParsed(null); setXmlParsed(null); setCsvFile(null); setXmlFile(null);
    setImporting(false);
  };

  const sc = { info:"#94A3B8", ok:"#1D9E75", error:"#EF4444", loading:"#F59E0B" };

  return (
    <div style={{ flex:1, overflowY:"auto", padding:24 }}>
      <div style={{ maxWidth:640, margin:"0 auto", display:"flex", flexDirection:"column", gap:14 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:600, color:"#E2E8F0", marginBottom:3 }}>Import session</div>
          <div style={{ fontSize:11, color:"#475569" }}>Files saved locally first — available instantly. Auto-syncs to database in the background when available.</div>
        </div>

        {/* Video zone */}
        <div style={{ background:"#0A1929", border:`1px solid ${pendingVids.length?"#06B6D4":"#1E3A5A"}`, borderRadius:12, padding:16 }}>
          <div style={{ fontSize:9, fontWeight:700, color:"#475569", letterSpacing:2, textTransform:"uppercase", marginBottom:11 }}>Video files</div>
          <input ref={vidInpRef} type="file" accept="video/*,.mov,.mp4,.mts,.avi,.mkv,.m4v" multiple style={{ display:"none" }} onChange={e => handleVids(e.target.files)} />
          <div onClick={() => vidInpRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); handleVids(e.dataTransfer.files); }}
            style={{ border:`2px dashed ${dragOver?"#06B6D4":"#1E3A5A"}`, borderRadius:8, padding:"26px 16px", textAlign:"center", cursor:"pointer", background:dragOver?"#071E30":"transparent", marginBottom:pendingVids.length?12:0, transition:"all 0.12s" }}>
            <div style={{ fontSize:22, marginBottom:8 }}>📹</div>
            <div style={{ fontSize:13, color:"#64748B" }}>Drop videos or click to browse</div>
            <div style={{ fontSize:11, color:"#334155", marginTop:3 }}>MP4 · MOV · MTS · AVI · multiple files OK</div>
          </div>
          {pendingVids.map(v => (
            <div key={v.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"6px 0", borderBottom:"1px solid #0F2030" }}>
              <video src={v.url} style={{ width:54, height:34, borderRadius:3, objectFit:"cover", background:"#071624", flexShrink:0 }} muted preload="metadata"
                onLoadedMetadata={e => setPendingVids(p => p.map(x => x.id===v.id?{...x,duration:Math.round(e.target.duration)}:x))} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:11, fontWeight:500, color:"#CBD5E1", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{v.name}</div>
                <div style={{ fontSize:10, color:"#475569" }}>{fmtSize(v.size)}{v.duration?` · ${fmtT(v.duration)}`:""}</div>
              </div>
              <button onClick={() => setPendingVids(p => p.filter(x => x.id!==v.id))} style={{ background:"none", border:"none", color:"#EF4444", cursor:"pointer", fontSize:16, padding:"0 4px" }}>×</button>
            </div>
          ))}
        </div>

        {/* CSV + XML */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          {[
            { label:"Expedition log (CSV)", ref:csvRef, file:csvFile, parsed:csvParsed, accept:".csv,text/csv", onChange:e=>handleCsv(e.target.files[0]),
              detail:csvParsed?`${csvParsed.rows.length.toLocaleString()} rows · ${fmtSize(csvFile.size)}`:null, color:"#1D9E75" },
            { label:"Event file (XML)", ref:xmlRef, file:xmlFile, parsed:xmlParsed, accept:".xml,text/xml", onChange:e=>handleXml(e.target.files[0]),
              detail:xmlParsed?`${xmlParsed.meta.boat} · ${xmlParsed.meta.location}\n${xmlParsed.tackJibes.length} manoeuvres · ${xmlParsed.markRoundings.length} marks`:null, color:"#8B5CF6" },
          ].map(({ label,ref,file,parsed,accept,onChange,detail,color }) => (
            <div key={label} style={{ background:"#0A1929", border:`1px solid ${parsed?color:"#1E3A5A"}`, borderRadius:12, padding:14 }}>
              <div style={{ fontSize:9, fontWeight:700, color:"#475569", letterSpacing:2, textTransform:"uppercase", marginBottom:9 }}>{label}</div>
              <input ref={ref} type="file" accept={accept} style={{ display:"none" }} onChange={onChange} />
              <button onClick={() => ref.current?.click()} style={{ width:"100%", background:parsed?`${color}18`:"#071624", border:`1px solid ${parsed?color:"#1E3A5A"}`, borderRadius:7, padding:"9px 0", color:parsed?color:"#7DD3FC", cursor:"pointer", fontSize:11 }}>
                {parsed ? `✓ ${file.name}` : `Choose ${accept.includes("csv")?"CSV":"XML"} file`}
              </button>
              {detail && <div style={{ marginTop:7, fontSize:10, color:"#475569", whiteSpace:"pre-line" }}>{detail}</div>}
            </div>
          ))}
        </div>

        {/* Status */}
        {status && (
          <div style={{ background:"#071624", border:`1px solid ${sc[status.type]}30`, borderRadius:6, padding:"7px 11px", fontSize:11, color:sc[status.type] }}>
            {status.type==="loading"?"⏳ ":status.type==="ok"?"✓ ":"✕ "}{status.msg}
          </div>
        )}

        {/* Import CTA */}
        {(pendingVids.length > 0 || csvParsed || xmlParsed) && (
          <button onClick={doImport} disabled={importing}
            style={{ background:importing?"#1E3A5A":"#06B6D4", border:"none", borderRadius:10, padding:"13px", color:importing?"#64748B":"#000", fontWeight:700, fontSize:14, cursor:importing?"default":"pointer", width:"100%" }}>
            {importing ? "Saving to local storage…" :
              `Import ${pendingVids.length>0?`${pendingVids.length} video${pendingVids.length>1?"s":""}`:""} ${csvParsed?"+ log":""} ${xmlParsed?"+ events":""} → local storage`}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function SmartSailingAnalytics() {
  const [activeTab, setActiveTab]         = useState("library");
  const [allVideos, setAllVideos]         = useState([]);
  const [logData, setLogData]             = useState(null);
  const [xmlData, setXmlData]             = useState(null);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [syncOffsets, setSyncOffsets]     = useState({});
  const [selectedTags, setSelectedTags]   = useState([]);
  const [searchQuery, setSearchQuery]     = useState("");
  const [sortBy, setSortBy]               = useState("date");
  const [sessions, setSessions]           = useState([]);
  const [activeDate, setActiveDate]       = useState(TODAY());
  const [dbStatus, setDbStatus]           = useState(null);
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [syncing, setSyncing]             = useState(false);
  const [aiQuery, setAiQuery]             = useState("");
  const [aiResult, setAiResult]           = useState(null);
  const [aiLoading, setAiLoading]         = useState(false);
  const [loaded, setLoaded]               = useState(false);

  // ── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function boot() {
      const sesh = getSessions();
      setSessions(sesh);
      const today = TODAY();
      const todayLog = getLogData(today);
      const todayXml = getXmlData(today);
      if (todayLog) setLogData({ ...todayLog, source:"local" });
      if (todayXml) setXmlData({ ...todayXml, source:"local" });
      const local = await getAllVideos();
      setAllVideos(local.map(v => enrichVideo(v, todayLog, todayXml)));
      if (local.length > 0) setSelectedVideo(local[0]);
      setUnsyncedCount(getUnsyncedCount());
      setLoaded(true);
      checkDbConnection().then(r => setDbStatus(r.available ? "online" : "offline"));

      // Pull remote sessions list for dates not in local
      if (sesh.length === 0) {
        const remote = await fetchRemoteSessions([today]);
        if (remote?.length) setSessions(p => [...p, ...remote.map(r => ({ date:r.date, videoCount:r.video_count, hasLog:r.has_log, hasXml:r.has_xml, source:"remote" }))]);
      }
    }
    boot();
  }, []);

  // ── Load a session date ───────────────────────────────────────────────────
  async function loadDate(date) {
    setActiveDate(date);
    const isToday = date === TODAY();

    // Log data
    const localLog = getLogData(date);
    if (localLog) {
      setLogData({ ...localLog, source:"local" });
    } else if (!isToday && dbStatus === "online") {
      const remote = await fetchRemoteLogRows(date);
      setLogData(remote ? { ...remote, source:"remote" } : null);
    } else { setLogData(null); }

    // XML data
    const localXml = getXmlData(date);
    if (localXml) {
      setXmlData({ ...localXml, source:"local" });
    } else if (!isToday && dbStatus === "online") {
      const remote = await fetchRemoteXmlData(date);
      setXmlData(remote ? { ...remote, source:"remote" } : null);
    } else { setXmlData(null); }

    // Videos
    const localVids = await getVideosForDate(date);
    let videos = [...localVids];
    if (!videos.length && !isToday && dbStatus === "online") {
      videos = await fetchRemoteVideos(date);
    }
    const log = getLogData(date), xml = getXmlData(date);
    const enriched = videos.map(v => enrichVideo(v, log, xml));
    setAllVideos(enriched);
    setSelectedVideo(enriched[0] || null);
  }

  // ── Handle import ─────────────────────────────────────────────────────────
  async function handleImported({ date, videos, logData:ld, xmlData:xd }) {
    if (ld) setLogData({ ...ld, source:"local" });
    if (xd) setXmlData({ ...xd, source:"local" });
    setSessions(getSessions());
    setUnsyncedCount(getUnsyncedCount());
    await loadDate(date);
    setActiveTab("library");
    // Background sync
    if (dbStatus === "online") {
      syncSessionToDb(date, ld, xd, videos).then(() => setUnsyncedCount(getUnsyncedCount()));
    }
  }

  // ── Manual sync ───────────────────────────────────────────────────────────
  async function pushSync() {
    if (syncing || dbStatus !== "online") return;
    setSyncing(true);
    for (const s of sessions.filter(s => !s.source)) { // only local sessions
      const ld = getLogData(s.date), xd = getXmlData(s.date);
      const vids = await getVideosForDate(s.date);
      await syncSessionToDb(s.date, ld, xd, vids);
    }
    setUnsyncedCount(getUnsyncedCount());
    setSyncing(false);
  }

  // ── AI search ─────────────────────────────────────────────────────────────
  async function runAiQuery() {
    if (!aiQuery.trim() || !allVideos.length) return;
    setAiLoading(true); setAiResult(null);
    try {
      const vl = allVideos.map(v => ({ id:v.id, title:v.title, tags:v.tags, tws:v.twsAvg, sog:v.sogAvg, date:v.sessionDate }));
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:800,
          system:`You are the AI for SmartSailingAnalytics. Library: ${JSON.stringify(vl)}\nReturn ONLY valid JSON: {"matches":[],"explanation":"","insight":""}`,
          messages:[{ role:"user", content:aiQuery }] }),
      });
      const data = await res.json();
      const text = data.content?.find(b => b.type==="text")?.text || "{}";
      setAiResult(JSON.parse(text.replace(/```json|```/g,"").trim()));
    } catch { setAiResult({ matches:[], explanation:"Search unavailable.", insight:"" }); }
    setAiLoading(false);
  }

  // ── Filter + sort ─────────────────────────────────────────────────────────
  const aiIds = new Set(aiResult?.matches || []);
  const displayed = (aiResult ? allVideos.filter(v => aiIds.has(v.id)) : allVideos)
    .filter(v => {
      const ok = selectedTags.length === 0 || selectedTags.every(t => (v.tags||[]).includes(t));
      const q = searchQuery.toLowerCase();
      return ok && (!q || v.title?.toLowerCase().includes(q) || (v.tags||[]).some(t => t.includes(q)));
    })
    .sort((a,b) => sortBy==="tws" ? (b.twsAvg||0)-(a.twsAvg||0) : sortBy==="sog" ? (b.sogAvg||0)-(a.sogAvg||0) : (b.addedAt||0)-(a.addedAt||0));

  const allTags = [...new Set(allVideos.flatMap(v => v.tags||[]))].sort();
  const isManTag = t => ["tack","gybe","top-mark","leeward-gate","upwind","downwind","reaching"].includes(t);
  const isSailTag = t => !isManTag(t) && !["local","remote","training","today"].includes(t) && !t.startsWith("tws-") && !t.includes(".") && !t.includes("/");
  const toggleTag = t => setSelectedTags(p => p.includes(t) ? p.filter(x=>x!==t) : [...p,t]);

  const tabStyle = tab => ({ padding:"6px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontWeight:600, border:"none",
    background:activeTab===tab?"#06B6D4":"transparent", color:activeTab===tab?"#000":"#64748B", transition:"all 0.12s" });

  if (!loaded) return (
    <div style={{ minHeight:"100vh", background:"#030F1A", display:"flex", alignItems:"center", justifyContent:"center", color:"#334155", fontSize:13 }}>
      Loading SmartSailingAnalytics…
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", background:"#030F1A", color:"#E2E8F0", fontFamily:"'Segoe UI',system-ui,sans-serif", display:"flex", flexDirection:"column" }}>

      {/* HEADER */}
      <header style={{ background:"#050E1C", borderBottom:"1px solid #1E3A5A", padding:"0 18px", display:"flex", alignItems:"center", height:52, gap:14, position:"sticky", top:0, zIndex:100, flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <span style={{ fontSize:16 }}>⚓</span>
          <span style={{ fontSize:15, fontWeight:700, color:"#E2E8F0" }}>Smart</span>
          <span style={{ fontSize:15, fontWeight:700, color:"#06B6D4" }}>Sailing Analytics</span>
        </div>
        <nav style={{ display:"flex", gap:2, marginLeft:10 }}>
          {["library","analytics","upload","admin"].map(tab => (
            <button key={tab} style={tabStyle(tab)} onClick={() => setActiveTab(tab)}>
              {tab==="upload" && unsyncedCount > 0
                ? <span>{tab} <span style={{ background:"#F59E0B", color:"#000", borderRadius:8, padding:"0 4px", fontSize:9, fontWeight:800, marginLeft:3 }}>{unsyncedCount}</span></span>
                : tab.charAt(0).toUpperCase()+tab.slice(1)}
            </button>
          ))}
        </nav>
        <div style={{ flex:1 }} />
        <div style={{ display:"flex", gap:5, width:320 }}>
          <input value={aiQuery} onChange={e=>setAiQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&runAiQuery()}
            placeholder="✦ AI search — 'tacks in 18+ knots…'"
            style={{ flex:1, background:"#071624", border:"1px solid #1E3A5A", borderRadius:6, padding:"5px 10px", color:"#E2E8F0", fontSize:11, outline:"none" }} />
          <button onClick={runAiQuery} disabled={aiLoading} style={{ background:aiLoading?"#1E3A5A":"#8B5CF6", border:"none", borderRadius:6, padding:"5px 12px", color:"#fff", fontWeight:700, cursor:"pointer", fontSize:11 }}>
            {aiLoading?"…":"Search"}
          </button>
          {aiResult && <button onClick={()=>setAiResult(null)} style={{ background:"none", border:"1px solid #EF444440", borderRadius:6, padding:"5px 8px", color:"#EF4444", cursor:"pointer", fontSize:11 }}>✕</button>}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <div style={{ display:"flex", alignItems:"center", gap:4, fontSize:10, color:dbStatus==="online"?"#1D9E75":dbStatus==="offline"?"#EF4444":"#334155" }}>
            <div style={{ width:5, height:5, borderRadius:"50%", background:dbStatus==="online"?"#1D9E75":dbStatus==="offline"?"#EF4444":"#334155" }} />
            {dbStatus==="online"?"DB":"No DB"}
          </div>
          {dbStatus==="online" && unsyncedCount > 0 && (
            <button onClick={pushSync} disabled={syncing} style={{ background:"none", border:"1px solid #F59E0B50", borderRadius:4, padding:"2px 7px", color:"#F59E0B", cursor:"pointer", fontSize:9, fontWeight:700 }}>
              {syncing?"Syncing…":`↑ Sync ${unsyncedCount}`}
            </button>
          )}
        </div>
      </header>

      {/* AI BANNER */}
      {aiResult && (
        <div style={{ background:"#0D1829", borderBottom:"1px solid #8B5CF620", padding:"8px 18px", display:"flex", gap:10, alignItems:"flex-start", flexShrink:0 }}>
          <span style={{ color:"#8B5CF6", fontSize:12 }}>✦</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:11, color:"#A78BFA", fontWeight:600, marginBottom:1 }}>{aiResult.matches?.length||0} clips — {aiResult.explanation}</div>
            {aiResult.insight && <div style={{ fontSize:10, color:"#334155" }}>💡 {aiResult.insight}</div>}
          </div>
        </div>
      )}

      {/* BODY */}
      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>

        {/* SIDEBAR */}
        {activeTab === "library" && (
          <aside style={{ width:200, background:"#050E1C", borderRight:"1px solid #1E3A5A", display:"flex", flexDirection:"column", overflowY:"auto", flexShrink:0 }}>
            <div style={{ padding:"12px 11px 6px" }}>
              <div style={{ fontSize:9, color:"#1E3A5A", letterSpacing:2, textTransform:"uppercase", marginBottom:7 }}>Sessions</div>
              {sessions.length === 0 && (
                <div style={{ fontSize:10, color:"#1E3A5A", padding:"6px 3px" }}>No sessions yet</div>
              )}
              {sessions.map(s => (
                <div key={s.date} onClick={() => loadDate(s.date)}
                  style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"5px 6px", borderRadius:5, cursor:"pointer", marginBottom:2,
                    background:activeDate===s.date?"#1E3A5A":"transparent",
                    border:`1px solid ${activeDate===s.date?"#06B6D430":"transparent"}` }}>
                  <div>
                    <div style={{ fontSize:11, color:activeDate===s.date?"#06B6D4":"#64748B", fontFamily:"monospace" }}>{s.date===TODAY()?"Today":s.date}</div>
                    <div style={{ fontSize:9, color:"#1E3A5A" }}>{s.videoCount||0}v{s.hasLog?" ·log":""}{s.hasXml?" ·ev":""}{s.source==="remote"?" ·db":""}</div>
                  </div>
                  <div style={{ display:"flex", gap:2 }}>
                    {s.hasLog && <span style={{ width:4, height:4, borderRadius:"50%", background:"#1D9E75" }} />}
                    {s.hasXml && <span style={{ width:4, height:4, borderRadius:"50%", background:"#8B5CF6" }} />}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ height:1, background:"#0F2030", margin:"4px 11px 6px" }} />

            <div style={{ padding:"0 11px 8px" }}>
              <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search…"
                style={{ width:"100%", background:"#071624", border:"1px solid #1E3A5A", borderRadius:5, padding:"5px 8px", color:"#E2E8F0", fontSize:11, outline:"none", boxSizing:"border-box", marginBottom:7 }} />
              {["date","tws","sog"].map(s => (
                <button key={s} onClick={()=>setSortBy(s)} style={{ display:"block", width:"100%", textAlign:"left", background:sortBy===s?"#1E3A5A":"none", border:"none", borderRadius:4, padding:"3px 6px", color:sortBy===s?"#06B6D4":"#334155", cursor:"pointer", fontSize:10, marginBottom:1 }}>
                  {sortBy===s?"▸ ":"  "}{s==="date"?"Date":s==="tws"?"Wind (TWS)":"Speed (SOG)"}
                </button>
              ))}
            </div>

            {allTags.length > 0 && (
              <div style={{ padding:"0 11px", flex:1 }}>
                {[{label:"Manoeuvre",f:isManTag},{label:"Other tags",f:isSailTag}].map(({label,f}) => {
                  const tags = allTags.filter(f);
                  if (!tags.length) return null;
                  return (
                    <div key={label} style={{ marginBottom:10 }}>
                      <div style={{ fontSize:8, color:"#1E3A5A", letterSpacing:2, textTransform:"uppercase", marginBottom:4 }}>{label}</div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                        {tags.map(t => (
                          <button key={t} onClick={()=>toggleTag(t)} style={{ background:selectedTags.includes(t)?"#06B6D4":"#0A1929", border:`1px solid ${selectedTags.includes(t)?"#06B6D4":"#1E3A5A"}`, borderRadius:3, padding:"1px 5px", color:selectedTags.includes(t)?"#000":"#7DD3FC", fontSize:9, cursor:"pointer", fontFamily:"monospace" }}>{t}</button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {selectedTags.length > 0 && (
                  <button onClick={()=>setSelectedTags([])} style={{ background:"none", border:"1px solid #EF444440", borderRadius:4, padding:"2px 8px", color:"#EF4444", fontSize:9, cursor:"pointer", width:"100%", marginTop:4 }}>Clear filters</button>
                )}
              </div>
            )}
          </aside>
        )}

        <main style={{ flex:1, display:"flex", overflow:"hidden" }}>

          {/* LIBRARY */}
          {activeTab === "library" && (
            <>
              <div style={{ flex:1, overflowY:"auto", padding:12 }}>
                {/* Data banner */}
                {(logData || xmlData) && (
                  <div style={{ display:"flex", gap:7, marginBottom:10, alignItems:"center", flexWrap:"wrap" }}>
                    {logData && (
                      <span style={{ fontSize:10, padding:"2px 7px", borderRadius:3, background:logData.source==="local"?"#1D9E7510":"#8B5CF610", border:`1px solid ${logData.source==="local"?"#1D9E7530":"#8B5CF630"}`, color:logData.source==="local"?"#1D9E75":"#8B5CF6" }}>
                        {logData.source==="local"?"● Local":"● DB"} log · {logData.rows?.length?.toLocaleString()} rows
                      </span>
                    )}
                    {xmlData && (
                      <span style={{ fontSize:10, padding:"2px 7px", borderRadius:3, background:xmlData.source==="local"?"#8B5CF610":"#8B5CF610", border:"1px solid #8B5CF630", color:"#8B5CF6" }}>
                        {xmlData.source==="local"?"● Local":"● DB"} events · {xmlData.tackJibes?.length} manoeuvres
                      </span>
                    )}
                    <span style={{ fontSize:10, color:"#1E3A5A" }}>{displayed.length} clip{displayed.length!==1?"s":""}</span>
                  </div>
                )}

                {/* Empty state */}
                {allVideos.length === 0 && (
                  <div style={{ textAlign:"center", padding:"50px 20px", color:"#1E3A5A" }}>
                    <div style={{ fontSize:32, marginBottom:14, opacity:0.5 }}>📹</div>
                    <div style={{ fontSize:13, fontWeight:600, color:"#334155", marginBottom:6 }}>No videos in this session</div>
                    <div style={{ fontSize:11, color:"#1E3A5A", marginBottom:16 }}>Import videos, log files and event data in the Upload tab.</div>
                    <button onClick={()=>setActiveTab("upload")} style={{ background:"#06B6D4", border:"none", borderRadius:8, padding:"9px 22px", color:"#000", fontWeight:700, cursor:"pointer", fontSize:12 }}>
                      Go to Upload
                    </button>
                  </div>
                )}

                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(195px, 1fr))", gap:11 }}>
                  {displayed.map(v => (
                    <VideoCard key={v.id} video={v} selected={selectedVideo?.id===v.id} onClick={()=>setSelectedVideo(v)} />
                  ))}
                </div>
              </div>

              {/* Detail panel */}
              {selectedVideo && (
                <div style={{ width:410, background:"#050E1C", borderLeft:"1px solid #1E3A5A", overflowY:"auto", padding:12, flexShrink:0 }}>
                  <VideoPlayer video={selectedVideo} logData={logData} xmlData={xmlData} syncOffset={syncOffsets[selectedVideo.id]||0} />
                  <div style={{ marginTop:12 }}>
                    <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:2 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:"#E2E8F0", flex:1, marginRight:8 }}>{selectedVideo.title}</div>
                      <SrcBadge source={selectedVideo.source} />
                    </div>
                    <div style={{ fontSize:10, color:"#334155", marginBottom:12 }}>
                      {selectedVideo.sessionDate} · {selectedVideo.camera}{selectedVideo.duration?` · ${fmtT(selectedVideo.duration)}`:""}
                    </div>
                    {selectedVideo.twsAvg != null && (
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:7, marginBottom:12 }}>
                        {[["Avg TWS",selectedVideo.twsAvg,"kt","#06B6D4"],["Avg SOG",selectedVideo.sogAvg,"kt","#10B981"],["Avg Heel",selectedVideo.heelAvg,"°","#F59E0B"]].map(([l,v,u,c]) => (
                          <div key={l} style={{ background:"#071624", borderRadius:6, padding:"8px 10px", border:`1px solid ${c}15` }}>
                            <div style={{ fontSize:9, color:"#334155", letterSpacing:1, marginBottom:2 }}>{l}</div>
                            <div style={{ fontSize:17, fontWeight:700, color:c, fontFamily:"monospace" }}>{R(v)}<span style={{ fontSize:10 }}> {u}</span></div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginBottom:12 }}>
                      <SyncControl offset={syncOffsets[selectedVideo.id]||0} onChange={v=>setSyncOffsets(p=>({...p,[selectedVideo.id]:v}))} />
                    </div>
                    <TagEditor video={selectedVideo} onSave={(id,tags)=>{
                      setAllVideos(p => p.map(v => v.id===id?{...v,tags}:v));
                      if (selectedVideo.id===id) setSelectedVideo(p => ({...p,tags}));
                    }} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* ANALYTICS */}
          {activeTab === "analytics" && (
            <div style={{ flex:1, padding:20, overflowY:"auto" }}>
              <div style={{ fontSize:15, fontWeight:600, color:"#E2E8F0", marginBottom:4 }}>Analytics</div>
              <div style={{ fontSize:11, color:"#475569", marginBottom:18 }}>All loaded sessions.</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:11, marginBottom:18 }}>
                {[
                  ["Clips",allVideos.length,"","#06B6D4"],
                  ["Sessions",sessions.length,"days","#8B5CF6"],
                  ["Avg TWS",allVideos.filter(v=>v.twsAvg).length?R(allVideos.reduce((s,v)=>s+(v.twsAvg||0),0)/allVideos.filter(v=>v.twsAvg).length):"--","kn","#1D9E75"],
                  ["Avg SOG",allVideos.filter(v=>v.sogAvg).length?R(allVideos.reduce((s,v)=>s+(v.sogAvg||0),0)/allVideos.filter(v=>v.sogAvg).length):"--","kn","#F59E0B"],
                ].map(([l,v,u,c])=>(
                  <div key={l} style={{ background:"#0A1929", border:`1px solid ${c}25`, borderRadius:10, padding:14 }}>
                    <div style={{ fontSize:9, color:"#334155", letterSpacing:1, marginBottom:3 }}>{l}</div>
                    <div style={{ fontSize:26, fontWeight:700, color:c, fontFamily:"monospace" }}>{v}</div>
                    {u&&<div style={{ fontSize:10, color:"#1E3A5A" }}>{u}</div>}
                  </div>
                ))}
              </div>
              <div style={{ background:"#0A1929", borderRadius:10, border:"2px dashed #1E3A5A", padding:36, textAlign:"center" }}>
                <div style={{ fontSize:10, color:"#1E3A5A", marginBottom:4 }}>Grafana dashboards</div>
                <div style={{ fontSize:11, color:"#1E3A5A" }}>Add NEXT_PUBLIC_GRAFANA_URL in Vercel env vars</div>
              </div>
            </div>
          )}

          {/* UPLOAD */}
          {activeTab === "upload" && <UploadTab onImported={handleImported} />}

          {/* ADMIN */}
          {activeTab === "admin" && (
            <div style={{ flex:1, padding:20, overflowY:"auto" }}>
              <div style={{ fontSize:15, fontWeight:600, color:"#E2E8F0", marginBottom:18 }}>Admin</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                {[
                  { title:"Database", items:[`Status: ${dbStatus||"not configured"}`,`Unsynced items: ${unsyncedCount}`,`Sessions indexed: ${sessions.length}`,"Set NEXT_PUBLIC_SUPABASE_URL in Vercel to enable"] },
                  { title:"Local storage", items:["Videos: IndexedDB (browser)","Log data: localStorage per date","Events: localStorage per date","Survives page refresh — clears if browser storage cleared"] },
                  { title:"Data flow", items:[`Today (${TODAY()}): always local`,"Older dates: local first, then DB","Import: local → DB syncs in background","Offline mode: full local operation"] },
                  { title:"Storage used", items:[`Sessions: ${sessions.length}`,`Videos loaded: ${allVideos.length}`,`Log rows today: ${getLogData(TODAY())?.rows?.length?.toLocaleString()||0}`,"Cloud video (Phase 2): Cloudflare R2"] },
                ].map(c=>(
                  <div key={c.title} style={{ background:"#0A1929", border:"1px solid #1E3A5A", borderRadius:10, padding:14 }}>
                    <div style={{ fontSize:11, fontWeight:600, color:"#64748B", marginBottom:8 }}>{c.title}</div>
                    {c.items.map((item,i)=>(
                      <div key={i} style={{ fontSize:10, color:"#334155", padding:"3px 0", borderBottom:"1px solid #0F2030" }}>{item}</div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
