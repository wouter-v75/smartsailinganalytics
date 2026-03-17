'use client'
import { useState, useEffect, useRef } from "react";

// ─── Mock Data ──────────────────────────────────────────────────────────────
const VIDEOS = [
  { id: 1, title: "Race 3 — Start Sequence", event: "Cowes Week 2024", date: "2024-08-06", duration: "4:32", tws: 18.2, twa: 42, sog: 9.1, heel: 24, tags: ["start", "starboard-tack", "J1"], manoeuvre: "start", thumbnail: "🌊", camera: "GoPro" },
  { id: 2, title: "Windward Leg — Port Tack", event: "Cowes Week 2024", date: "2024-08-06", duration: "7:14", tws: 19.5, twa: 38, sog: 10.2, heel: 28, tags: ["beat", "port-tack", "J1", "staysail-1"], manoeuvre: "beat", thumbnail: "⛵", camera: "iPhone" },
  { id: 3, title: "Top Mark Rounding — Gate", event: "Cowes Week 2024", date: "2024-08-06", duration: "2:48", tws: 20.1, twa: 165, sog: 11.4, heel: 12, tags: ["top-mark", "gybe", "A3"], manoeuvre: "mark", thumbnail: "🔴", camera: "GoPro" },
  { id: 4, title: "Training — Tack Practice", event: "Training Day", date: "2024-08-03", duration: "12:05", tws: 12.4, twa: 45, sog: 7.8, heel: 18, tags: ["tack", "training", "J1", "port-tack"], manoeuvre: "tack", thumbnail: "🌀", camera: "iPhone" },
  { id: 5, title: "Downwind — Gybe Set", event: "Fastnet 2024", date: "2024-08-12", duration: "3:22", tws: 22.8, twa: 158, sog: 13.1, heel: 8, tags: ["gybe", "A3", "staysail-2", "gate"], manoeuvre: "gybe", thumbnail: "🏁", camera: "GoPro" },
  { id: 6, title: "Gate Rounding — Peel to J2", event: "Fastnet 2024", date: "2024-08-13", duration: "5:51", tws: 24.3, twa: 48, sog: 9.8, heel: 31, tags: ["peel", "J2", "gate", "beat"], manoeuvre: "peel", thumbnail: "🔄", camera: "GoPro" },
  { id: 7, title: "Start — Leeward End Bias", event: "RORC Race", date: "2024-07-20", duration: "3:10", tws: 14.6, twa: 40, sog: 8.4, heel: 20, tags: ["start", "port-tack", "J1"], manoeuvre: "start", thumbnail: "🚀", camera: "iPhone" },
  { id: 8, title: "Staysail Peel Sequence", event: "Training Day", date: "2024-08-04", duration: "6:33", tws: 16.9, twa: 52, sog: 8.9, heel: 22, tags: ["peel", "staysail-1", "staysail-2", "training"], manoeuvre: "peel", thumbnail: "🔃", camera: "GoPro" },
];

const TAG_CATEGORIES = {
  "Manoeuvre": ["tack", "gybe", "start", "top-mark", "gate", "peel"],
  "Point of Sail": ["beat", "port-tack", "starboard-tack", "run"],
  "Sails": ["J1", "J2", "A3", "staysail-1", "staysail-2"],
  "Event": ["Cowes Week 2024", "Fastnet 2024", "Training Day", "RORC Race"],
};

const MANOEUVRE_COLORS = {
  start: "#F59E0B",
  tack: "#06B6D4",
  gybe: "#8B5CF6",
  mark: "#EF4444",
  beat: "#10B981",
  peel: "#F97316",
};

function DataGauge({ label, value, unit, color = "#06B6D4" }) {
  return (
    <div style={{
      background: "rgba(0,0,0,0.6)",
      border: `1px solid ${color}40`,
      borderRadius: 8,
      padding: "10px 14px",
      backdropFilter: "blur(8px)",
      minWidth: 90
    }}>
      <div style={{ fontSize: 10, color: "#94A3B8", letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 900, color: color, fontFamily: "'Courier New', monospace", lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "#64748B", marginTop: 2 }}>{unit}</div>
    </div>
  );
}

function VideoCard({ video, selected, onClick, onSelect }) {
  const manColor = MANOEUVRE_COLORS[video.manoeuvre] || "#06B6D4";
  return (
    <div onClick={onClick} style={{
      background: selected ? "#0F2A45" : "#0A1929",
      border: selected ? `2px solid ${manColor}` : "2px solid #1E3A5A",
      borderRadius: 12,
      overflow: "hidden",
      cursor: "pointer",
      transition: "all 0.2s",
      transform: selected ? "scale(1.02)" : "scale(1)",
      boxShadow: selected ? `0 0 20px ${manColor}40` : "none"
    }}>
      {/* Thumbnail */}
      <div style={{
        height: 120,
        background: `linear-gradient(135deg, ${manColor}20, #0A2240)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        fontSize: 40
      }}>
        {video.thumbnail}
        <div style={{
          position: "absolute",
          top: 8, left: 8,
          background: manColor,
          borderRadius: 4,
          padding: "2px 8px",
          fontSize: 10,
          fontWeight: 700,
          color: "#000",
          letterSpacing: 1,
          textTransform: "uppercase"
        }}>{video.manoeuvre}</div>
        <div style={{
          position: "absolute",
          bottom: 8, right: 8,
          background: "rgba(0,0,0,0.7)",
          borderRadius: 4,
          padding: "2px 6px",
          fontSize: 11,
          color: "#CBD5E1"
        }}>{video.duration}</div>
        <div style={{
          position: "absolute",
          top: 8, right: 8,
          background: "rgba(0,0,0,0.7)",
          borderRadius: 4,
          padding: "2px 6px",
          fontSize: 10,
          color: "#94A3B8"
        }}>{video.camera}</div>
      </div>

      {/* Info */}
      <div style={{ padding: "12px 14px" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#E2E8F0", marginBottom: 4, lineHeight: 1.3 }}>{video.title}</div>
        <div style={{ fontSize: 11, color: "#64748B", marginBottom: 8 }}>{video.event} · {video.date}</div>

        {/* Quick stats */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {[
            { l: "TWS", v: video.tws, u: "kt" },
            { l: "SOG", v: video.sog, u: "kt" },
            { l: "Heel", v: video.heel, u: "°" },
          ].map(s => (
            <div key={s.l} style={{ flex: 1, textAlign: "center", background: "#071624", borderRadius: 6, padding: "4px 0" }}>
              <div style={{ fontSize: 9, color: "#475569", letterSpacing: 1 }}>{s.l}</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#06B6D4", fontFamily: "monospace" }}>{s.v}</div>
              <div style={{ fontSize: 9, color: "#475569" }}>{s.u}</div>
            </div>
          ))}
        </div>

        {/* Tags */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {video.tags.slice(0, 3).map(t => (
            <span key={t} style={{
              background: "#1E3A5A",
              color: "#7DD3FC",
              fontSize: 10,
              borderRadius: 4,
              padding: "2px 7px",
              fontFamily: "monospace"
            }}>#{t}</span>
          ))}
          {video.tags.length > 3 && <span style={{ color: "#475569", fontSize: 10, alignSelf: "center" }}>+{video.tags.length - 3}</span>}
        </div>
      </div>

      {/* Select checkbox */}
      <div
        onClick={e => { e.stopPropagation(); onSelect(video.id); }}
        style={{
          position: "absolute",
          top: 50, left: 8
        }}
      />
    </div>
  );
}

function VideoPlayer({ video }) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [syncMode, setSyncMode] = useState(false);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let interval;
    if (playing) {
      interval = setInterval(() => setTime(t => {
        const max = parseDuration(video.duration);
        return t >= max ? 0 : t + 1;
      }), 1000);
    }
    return () => clearInterval(interval);
  }, [playing, video]);

  const parseDuration = (dur) => {
    const [m, s] = dur.split(":").map(Number);
    return m * 60 + s;
  };
  const totalSecs = parseDuration(video.duration);
  const progress = (time / totalSecs) * 100;
  const manColor = MANOEUVRE_COLORS[video.manoeuvre] || "#06B6D4";

  const nudge = (secs) => setOffset(o => o + secs);

  return (
    <div style={{
      background: "#030F1A",
      borderRadius: 12,
      overflow: "hidden",
      border: "1px solid #1E3A5A",
      height: fullscreen ? "100vh" : "auto",
      position: fullscreen ? "fixed" : "relative",
      top: fullscreen ? 0 : "auto",
      left: fullscreen ? 0 : "auto",
      right: fullscreen ? 0 : "auto",
      bottom: fullscreen ? 0 : "auto",
      zIndex: fullscreen ? 9999 : "auto"
    }}>
      {/* Video area */}
      <div style={{
        position: "relative",
        background: `radial-gradient(ellipse at center, ${manColor}15 0%, #030F1A 70%)`,
        height: fullscreen ? "calc(100vh - 140px)" : 320,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden"
      }}>
        {/* Big emoji placeholder */}
        <div style={{ fontSize: 80, opacity: 0.4 }}>{video.thumbnail}</div>

        {/* Play overlay */}
        {!playing && (
          <div
            onClick={() => setPlaying(true)}
            style={{
              position: "absolute",
              width: 64, height: 64,
              background: "rgba(6,182,212,0.9)",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: 24
            }}
          >▶</div>
        )}

        {/* HUD Overlay — top left */}
        <div style={{ position: "absolute", top: 16, left: 16, display: "flex", gap: 8 }}>
          <DataGauge label="TWS" value={video.tws.toFixed(1)} unit="knots" color="#06B6D4" />
          <DataGauge label="TWA" value={video.twa + "°"} unit="true" color="#8B5CF6" />
          <DataGauge label="SOG" value={video.sog.toFixed(1)} unit="knots" color="#10B981" />
          <DataGauge label="Heel" value={video.heel + "°"} unit="stbd" color="#F59E0B" />
        </div>

        {/* Camera / sync info */}
        <div style={{ position: "absolute", top: 16, right: 16, background: "rgba(0,0,0,0.6)", borderRadius: 8, padding: "6px 12px" }}>
          <div style={{ fontSize: 11, color: "#64748B" }}>{video.camera} · {video.event}</div>
          {offset !== 0 && <div style={{ fontSize: 10, color: "#F59E0B" }}>Sync offset: {offset > 0 ? "+" : ""}{offset}s</div>}
        </div>

        {/* Manoeuvre badge */}
        <div style={{
          position: "absolute",
          bottom: 16, left: 16,
          background: manColor,
          borderRadius: 6,
          padding: "4px 12px",
          fontSize: 12,
          fontWeight: 800,
          color: "#000",
          letterSpacing: 2,
          textTransform: "uppercase"
        }}>{video.manoeuvre}</div>

        {/* Fullscreen toggle */}
        <button
          onClick={() => setFullscreen(f => !f)}
          style={{
            position: "absolute",
            bottom: 16, right: 16,
            background: "rgba(0,0,0,0.6)",
            border: "1px solid #1E3A5A",
            color: "#94A3B8",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 12
          }}
        >{fullscreen ? "⊠ Exit" : "⛶ Full"}</button>
      </div>

      {/* Timeline */}
      <div style={{ padding: "12px 16px 0" }}>
        <div style={{ position: "relative", height: 32, background: "#071624", borderRadius: 6, overflow: "hidden", cursor: "pointer" }}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            setTime(Math.floor(pct * totalSecs));
          }}
        >
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${progress}%`, background: `linear-gradient(90deg, ${manColor}60, ${manColor})`, transition: "width 1s linear" }} />
          {/* Event markers */}
          {[15, 40, 65, 85].map((pct, i) => (
            <div key={i} style={{ position: "absolute", top: 0, bottom: 0, left: `${pct}%`, width: 2, background: MANOEUVRE_COLORS[Object.keys(MANOEUVRE_COLORS)[i % 6]] }} title="Event marker" />
          ))}
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", paddingLeft: 10 }}>
            <span style={{ fontSize: 11, color: "#475569", fontFamily: "monospace" }}>
              {String(Math.floor(time / 60)).padStart(2, "0")}:{String(time % 60).padStart(2, "0")} / {video.duration}
            </span>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div style={{ padding: "10px 16px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={() => { setPlaying(p => !p); }} style={{ background: manColor, border: "none", borderRadius: 6, padding: "8px 18px", color: "#000", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>
          {playing ? "⏸" : "▶"} {playing ? "Pause" : "Play"}
        </button>
        <button onClick={() => { setTime(0); setPlaying(false); }} style={{ background: "#1E3A5A", border: "none", borderRadius: 6, padding: "8px 12px", color: "#94A3B8", cursor: "pointer" }}>⏹</button>

        <div style={{ flex: 1 }} />

        {/* Sync controls */}
        <button onClick={() => setSyncMode(s => !s)} style={{ background: syncMode ? "#F59E0B20" : "#1E3A5A", border: `1px solid ${syncMode ? "#F59E0B" : "#2D4A6A"}`, borderRadius: 6, padding: "6px 12px", color: syncMode ? "#F59E0B" : "#94A3B8", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
          ⏱ SYNC
        </button>
        {syncMode && (
          <div style={{ display: "flex", gap: 4, background: "#071624", borderRadius: 8, padding: "4px 8px" }}>
            {[[-3600, "-1h"], [-60, "-1m"], [-10, "-10s"], [-1, "-1s"], [1, "+1s"], [10, "+10s"], [60, "+1m"], [3600, "+1h"]].map(([v, l]) => (
              <button key={l} onClick={() => nudge(v)} style={{ background: "#1E3A5A", border: "none", borderRadius: 4, padding: "4px 8px", color: "#7DD3FC", cursor: "pointer", fontSize: 10, fontFamily: "monospace" }}>{l}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TagEditor({ video }) {
  const [tags, setTags] = useState(video.tags);
  const [input, setInput] = useState("");
  const remove = (t) => setTags(ts => ts.filter(x => x !== t));
  const add = () => { if (input.trim()) { setTags(ts => [...ts, input.trim()]); setInput(""); } };
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#94A3B8", letterSpacing: 2, marginBottom: 10, textTransform: "uppercase" }}>Tags</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {tags.map(t => (
          <span key={t} style={{ background: "#1E3A5A", color: "#7DD3FC", fontSize: 11, borderRadius: 5, padding: "3px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
            onClick={() => remove(t)}>#{t} <span style={{ color: "#EF4444", fontSize: 10 }}>×</span></span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          placeholder="Add tag…"
          style={{ flex: 1, background: "#071624", border: "1px solid #1E3A5A", borderRadius: 6, padding: "6px 10px", color: "#E2E8F0", fontSize: 12, fontFamily: "monospace", outline: "none" }}
        />
        <button onClick={add} style={{ background: "#06B6D4", border: "none", borderRadius: 6, padding: "6px 14px", color: "#000", fontWeight: 700, cursor: "pointer", fontSize: 12 }}>+</button>
      </div>
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────────────────
export default function SmartSailingAnalytics() {
  const [activeTab, setActiveTab] = useState("library");
  const [selectedVideo, setSelectedVideo] = useState(VIDEOS[0]);
  const [selectedTags, setSelectedTags] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("date");
  const [aiQuery, setAiQuery] = useState("");
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [user] = useState({ name: "James Thornton", role: "Coach", avatar: "JT" });

  const toggleTag = (t) => setSelectedTags(ts => ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t]);

  const filtered = VIDEOS.filter(v => {
    const matchesTags = selectedTags.length === 0 || selectedTags.every(t => v.tags.includes(t) || v.manoeuvre === t || v.event === t);
    const q = searchQuery.toLowerCase();
    const matchesSearch = !q || v.title.toLowerCase().includes(q) || v.tags.some(t => t.includes(q)) || v.event.toLowerCase().includes(q);
    return matchesTags && matchesSearch;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "date") return new Date(b.date) - new Date(a.date);
    if (sortBy === "tws") return b.tws - a.tws;
    if (sortBy === "sog") return b.sog - a.sog;
    return 0;
  });

  const runAiQuery = async () => {
    if (!aiQuery.trim()) return;
    setAiLoading(true);
    setAiResult(null);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: `You are an AI assistant for SmartSailingAnalytics, a sailing video library. The user will query the video library in natural language. 
Given these videos: ${JSON.stringify(VIDEOS.map(v => ({ id: v.id, title: v.title, event: v.event, tags: v.tags, tws: v.tws, sog: v.sog, heel: v.heel, manoeuvre: v.manoeuvre })))}
Return a JSON object with:
- "matches": array of video ids that match the query (be intelligent about it)
- "explanation": brief human-readable explanation of what you found and why
- "insight": one useful sailing insight about these clips
Always respond with ONLY valid JSON, no markdown.`,
          messages: [{ role: "user", content: `Query: "${aiQuery}"` }]
        })
      });
      const data = await response.json();
      const text = data.content?.find(b => b.type === "text")?.text || "{}";
      const parsed = JSON.parse(text);
      setAiResult(parsed);
    } catch (e) {
      setAiResult({ matches: [], explanation: "Search unavailable — check API connection.", insight: "" });
    }
    setAiLoading(false);
  };

  const aiMatchedVideos = aiResult?.matches ? VIDEOS.filter(v => aiResult.matches.includes(v.id)) : [];

  // ─── STYLES ───
  const tabStyle = (tab) => ({
    padding: "8px 20px",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 1,
    border: "none",
    background: activeTab === tab ? "#06B6D4" : "transparent",
    color: activeTab === tab ? "#000" : "#64748B",
    transition: "all 0.2s"
  });

  return (
    <div style={{
      minHeight: "100vh",
      background: "#030F1A",
      color: "#E2E8F0",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      display: "flex",
      flexDirection: "column"
    }}>

      {/* ── HEADER ── */}
      <header style={{
        background: "#050E1C",
        borderBottom: "1px solid #1E3A5A",
        padding: "0 24px",
        display: "flex",
        alignItems: "center",
        height: 56,
        gap: 20,
        position: "sticky",
        top: 0,
        zIndex: 100
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 22 }}>⚓</div>
          <div>
            <span style={{ fontSize: 18, fontWeight: 900, color: "#E2E8F0", letterSpacing: -0.5 }}>Sail</span>
            <span style={{ fontSize: 18, fontWeight: 900, color: "#06B6D4", letterSpacing: -0.5 }}>Vault</span>
          </div>
        </div>

        <nav style={{ display: "flex", gap: 4, marginLeft: 20 }}>
          {["library", "analytics", "upload", "admin"].map(tab => (
            <button key={tab} style={tabStyle(tab)} onClick={() => setActiveTab(tab)}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>

        <div style={{ flex: 1 }} />

        {/* AI Search bar */}
        <div style={{ display: "flex", gap: 8, width: 380 }}>
          <input
            value={aiQuery}
            onChange={e => setAiQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && runAiQuery()}
            placeholder="✦ AI Search: 'tacks in 18+ knots TWS…'"
            style={{
              flex: 1,
              background: "#071624",
              border: "1px solid #1E3A5A",
              borderRadius: 8,
              padding: "7px 14px",
              color: "#E2E8F0",
              fontSize: 13,
              outline: "none"
            }}
          />
          <button onClick={runAiQuery} disabled={aiLoading} style={{
            background: aiLoading ? "#1E3A5A" : "linear-gradient(135deg, #06B6D4, #8B5CF6)",
            border: "none",
            borderRadius: 8,
            padding: "7px 16px",
            color: "#fff",
            fontWeight: 700,
            cursor: "pointer",
            fontSize: 13
          }}>
            {aiLoading ? "…" : "Search"}
          </button>
        </div>

        {/* User badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 12 }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg, #06B6D4, #8B5CF6)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#fff" }}>{user.avatar}</div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#E2E8F0" }}>{user.name}</div>
            <div style={{ fontSize: 10, color: "#06B6D4", letterSpacing: 1, textTransform: "uppercase" }}>{user.role}</div>
          </div>
        </div>
      </header>

      {/* ── AI RESULT BANNER ── */}
      {aiResult && (
        <div style={{
          background: "linear-gradient(90deg, #8B5CF620, #06B6D420)",
          borderBottom: "1px solid #8B5CF640",
          padding: "12px 24px",
          display: "flex",
          alignItems: "flex-start",
          gap: 16
        }}>
          <div style={{ fontSize: 20 }}>✦</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: "#C4B5FD", fontWeight: 700, marginBottom: 4 }}>AI Search · {aiMatchedVideos.length} clips found</div>
            <div style={{ fontSize: 12, color: "#94A3B8" }}>{aiResult.explanation}</div>
            {aiResult.insight && <div style={{ fontSize: 12, color: "#06B6D4", marginTop: 4 }}>💡 {aiResult.insight}</div>}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {aiMatchedVideos.map(v => (
              <button key={v.id} onClick={() => setSelectedVideo(v)} style={{ background: "#1E3A5A", border: "1px solid #06B6D440", borderRadius: 6, padding: "4px 10px", color: "#7DD3FC", fontSize: 11, cursor: "pointer" }}>{v.title}</button>
            ))}
          </div>
          <button onClick={() => setAiResult(null)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>
      )}

      {/* ── MAIN LAYOUT ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── SIDEBAR ── */}
        {activeTab === "library" && (
          <aside style={{
            width: 220,
            background: "#050E1C",
            borderRight: "1px solid #1E3A5A",
            padding: "16px 14px",
            overflowY: "auto",
            flexShrink: 0
          }}>
            {/* Search */}
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Filter…"
              style={{
                width: "100%",
                background: "#071624",
                border: "1px solid #1E3A5A",
                borderRadius: 6,
                padding: "7px 10px",
                color: "#E2E8F0",
                fontSize: 12,
                marginBottom: 14,
                boxSizing: "border-box",
                outline: "none"
              }}
            />

            {/* Sort */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: 2, marginBottom: 6, textTransform: "uppercase" }}>Sort by</div>
              {["date", "tws", "sog"].map(s => (
                <button key={s} onClick={() => setSortBy(s)} style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: sortBy === s ? "#1E3A5A" : "none",
                  border: "none",
                  borderRadius: 5,
                  padding: "5px 8px",
                  color: sortBy === s ? "#06B6D4" : "#64748B",
                  cursor: "pointer",
                  fontSize: 12,
                  textTransform: "capitalize",
                  marginBottom: 2
                }}>{sortBy === s ? "▸ " : "  "}{s === "date" ? "Date" : s === "tws" ? "Wind (TWS)" : "Speed (SOG)"}</button>
              ))}
            </div>

            {/* Tag filters */}
            {Object.entries(TAG_CATEGORIES).map(([cat, tags]) => (
              <div key={cat} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10, color: "#475569", letterSpacing: 2, marginBottom: 6, textTransform: "uppercase" }}>{cat}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {tags.map(t => {
                    const active = selectedTags.includes(t);
                    return (
                      <button key={t} onClick={() => toggleTag(t)} style={{
                        background: active ? "#06B6D4" : "#0A1929",
                        border: `1px solid ${active ? "#06B6D4" : "#1E3A5A"}`,
                        borderRadius: 4,
                        padding: "2px 7px",
                        color: active ? "#000" : "#7DD3FC",
                        fontSize: 10,
                        cursor: "pointer",
                        fontFamily: "monospace"
                      }}>{t}</button>
                    );
                  })}
                </div>
              </div>
            ))}

            {selectedTags.length > 0 && (
              <button onClick={() => setSelectedTags([])} style={{ background: "none", border: "1px solid #EF444460", borderRadius: 5, padding: "4px 10px", color: "#EF4444", fontSize: 11, cursor: "pointer", width: "100%" }}>
                Clear filters
              </button>
            )}
          </aside>
        )}

        {/* ── CONTENT ── */}
        <main style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {activeTab === "library" && (
            <>
              {/* Video grid */}
              <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                  <div style={{ fontSize: 13, color: "#64748B" }}>{sorted.length} clips</div>
                  {selectedTags.length > 0 && (
                    <div style={{ display: "flex", gap: 4 }}>
                      {selectedTags.map(t => <span key={t} style={{ background: "#06B6D420", border: "1px solid #06B6D440", borderRadius: 4, padding: "2px 8px", fontSize: 11, color: "#06B6D4" }}>#{t}</span>)}
                    </div>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14, position: "relative" }}>
                  {sorted.map(v => (
                    <VideoCard
                      key={v.id}
                      video={v}
                      selected={selectedVideo?.id === v.id}
                      onClick={() => setSelectedVideo(v)}
                      onSelect={() => {}}
                    />
                  ))}
                </div>
                {sorted.length === 0 && (
                  <div style={{ textAlign: "center", padding: 60, color: "#475569" }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
                    <div>No clips match your filters</div>
                  </div>
                )}
              </div>

              {/* Right panel — player + details */}
              {selectedVideo && (
                <div style={{ width: 440, background: "#050E1C", borderLeft: "1px solid #1E3A5A", overflowY: "auto", padding: 16, flexShrink: 0 }}>
                  <VideoPlayer video={selectedVideo} />

                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: "#E2E8F0", marginBottom: 4 }}>{selectedVideo.title}</div>
                    <div style={{ fontSize: 12, color: "#64748B", marginBottom: 16 }}>{selectedVideo.event} · {selectedVideo.date} · {selectedVideo.camera}</div>

                    {/* Instrument summary */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
                      {[
                        { l: "Avg TWS", v: selectedVideo.tws + " kt", c: "#06B6D4" },
                        { l: "Avg TWA", v: selectedVideo.twa + "°", c: "#8B5CF6" },
                        { l: "Avg SOG", v: selectedVideo.sog + " kt", c: "#10B981" },
                        { l: "Avg Heel", v: selectedVideo.heel + "°", c: "#F59E0B" },
                      ].map(s => (
                        <div key={s.l} style={{ background: "#071624", borderRadius: 8, padding: "10px 12px", border: `1px solid ${s.c}20` }}>
                          <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 4 }}>{s.l}</div>
                          <div style={{ fontSize: 20, fontWeight: 900, color: s.c, fontFamily: "monospace" }}>{s.v}</div>
                        </div>
                      ))}
                    </div>

                    <TagEditor video={selectedVideo} />
                  </div>
                </div>
              )}
            </>
          )}

          {activeTab === "analytics" && (
            <div style={{ flex: 1, padding: 24, overflowY: "auto" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#E2E8F0", marginBottom: 6 }}>Analytics</div>
              <div style={{ fontSize: 13, color: "#64748B", marginBottom: 24 }}>Grafana dashboards embedded below. Configure datasource in Admin → Integrations.</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                {[
                  { label: "Total Clips", value: VIDEOS.length, unit: "videos", color: "#06B6D4", icon: "🎥" },
                  { label: "Avg TWS", value: (VIDEOS.reduce((a, v) => a + v.tws, 0) / VIDEOS.length).toFixed(1), unit: "knots", color: "#8B5CF6", icon: "💨" },
                  { label: "Avg SOG", value: (VIDEOS.reduce((a, v) => a + v.sog, 0) / VIDEOS.length).toFixed(1), unit: "knots", color: "#10B981", icon: "⚡" },
                  { label: "Events", value: new Set(VIDEOS.map(v => v.event)).size, unit: "regattas", color: "#F59E0B", icon: "🏆" },
                ].map(s => (
                  <div key={s.label} style={{ background: "#0A1929", border: `1px solid ${s.color}30`, borderRadius: 12, padding: 20 }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>{s.icon}</div>
                    <div style={{ fontSize: 32, fontWeight: 900, color: s.color, fontFamily: "monospace" }}>{s.value}</div>
                    <div style={{ fontSize: 12, color: "#64748B" }}>{s.label} <span style={{ color: "#475569" }}>· {s.unit}</span></div>
                  </div>
                ))}
              </div>
              {/* Grafana placeholder */}
              <div style={{ background: "#0A1929", borderRadius: 12, border: "2px dashed #1E3A5A", padding: 40, textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#475569", marginBottom: 6 }}>Grafana Dashboard</div>
                <div style={{ fontSize: 12, color: "#334155" }}>Connect your Grafana Cloud instance in Admin → Integrations to embed polar charts, wind roses, and track plots here.</div>
              </div>
            </div>
          )}

          {activeTab === "upload" && (
            <div style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <div style={{ maxWidth: 500, width: "100%", textAlign: "center" }}>
                <div style={{ fontSize: 64, marginBottom: 16 }}>📹</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#E2E8F0", marginBottom: 8 }}>Upload Videos</div>
                <div style={{ fontSize: 13, color: "#64748B", marginBottom: 32 }}>iPhone MOV · GoPro MP4 · Multiple files supported</div>
                <div style={{
                  border: "2px dashed #1E3A5A",
                  borderRadius: 16,
                  padding: "48px 32px",
                  background: "#071624",
                  marginBottom: 24,
                  cursor: "pointer"
                }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>⬆️</div>
                  <div style={{ fontSize: 14, color: "#64748B" }}>Drop videos here or click to browse</div>
                  <div style={{ fontSize: 12, color: "#334155", marginTop: 8 }}>Max 4GB per file · Uploads directly to Cloudflare R2</div>
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ flex: 1, background: "#0A1929", border: "1px solid #1E3A5A", borderRadius: 10, padding: "14px 16px", textAlign: "left" }}>
                    <div style={{ fontSize: 12, color: "#64748B", marginBottom: 6 }}>Log File (NMEA / CSV)</div>
                    <button style={{ background: "#1E3A5A", border: "none", borderRadius: 6, padding: "6px 12px", color: "#7DD3FC", fontSize: 12, cursor: "pointer" }}>Choose File</button>
                  </div>
                  <div style={{ flex: 1, background: "#0A1929", border: "1px solid #1E3A5A", borderRadius: 10, padding: "14px 16px", textAlign: "left" }}>
                    <div style={{ fontSize: 12, color: "#64748B", marginBottom: 6 }}>Event File (XML)</div>
                    <button style={{ background: "#1E3A5A", border: "none", borderRadius: 6, padding: "6px 12px", color: "#7DD3FC", fontSize: 12, cursor: "pointer" }}>Choose File</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "admin" && (
            <div style={{ flex: 1, padding: 24, overflowY: "auto" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#E2E8F0", marginBottom: 20 }}>Admin Panel</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {[
                  { title: "Users & Roles", icon: "👥", desc: "Manage team members, roles, and permissions", items: ["James Thornton — Coach", "Sarah Chen — Admin", "Mike Ross — Crew", "Dr. Harris — Consultant"] },
                  { title: "Integrations", icon: "🔗", desc: "Connect external services", items: ["Grafana Cloud — Configure", "Cloudflare R2 — Connected ✓", "Supabase DB — Connected ✓", "OpenAI API — Connected ✓"] },
                  { title: "Tag Taxonomy", icon: "🏷️", desc: "Manage tag categories and defaults", items: ["Manoeuvre tags", "Instrument thresholds", "Sail configurations", "Custom team tags"] },
                  { title: "Storage", icon: "💾", desc: "Video storage and quota management", items: ["Used: 147 GB / 500 GB", "Videos: 8 clips", "Thumbnails: 8 images", "Avg per clip: 18.4 GB"] },
                ].map(card => (
                  <div key={card.title} style={{ background: "#0A1929", border: "1px solid #1E3A5A", borderRadius: 12, padding: 18 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                      <span style={{ fontSize: 22 }}>{card.icon}</span>
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#E2E8F0" }}>{card.title}</div>
                    </div>
                    <div style={{ fontSize: 12, color: "#64748B", marginBottom: 12 }}>{card.desc}</div>
                    {card.items.map(item => (
                      <div key={item} style={{ fontSize: 12, color: "#475569", padding: "4px 0", borderBottom: "1px solid #0F2030" }}>{item}</div>
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
