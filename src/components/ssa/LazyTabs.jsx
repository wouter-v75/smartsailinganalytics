'use client'
import React, { useState } from "react";
import { ErrorBoundary } from '../ui';
import dynamic from 'next/dynamic';

// ── Lazy-loaded tab components ──────────────────────────────────────────────
// Each ships as its own JS chunk the browser downloads only when the user
// first opens that tab — keeps the initial app bundle small (matters on
// phones / slow wifi). A user whose role hides a tab can never open it, so
// its chunk is simply never downloaded for them.
const TabLoading = () => (
  <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",minHeight:240,color:"#475569",fontSize:13}}>Loading…</div>
);

const PhotosTab      = dynamic(() => import("../PhotosTab"),      { ssr:false, loading:TabLoading });

const SquashShotsApp = dynamic(() => import("../SquashShotsApp"), { ssr:false, loading:TabLoading });

const SailScanTab    = dynamic(() => import("../SailScanTab"),    { ssr:false, loading:TabLoading });

const TaggerTab      = dynamic(() => import("../tagging/TaggerTab"), { ssr:false, loading:TabLoading });

const SailTrimTab     = dynamic(() => import("../sailtrim/SailTrimTab"), { ssr:false, loading:TabLoading });

// Tools tab = SEPARATE sub-tabs (Squash | SailScan | SailTrim), one visible at a
// time, each filling the whole area. All stay mounted (display toggle) so
// in-progress state (a loaded scan / marks) survives switching. Replaces the old
// stacked 85dvh-each layout that made everything small.
function ToolsTabs({ teamId, boatId }) {
  const [sub, setSub] = useState('sailscan');
  const tabBtn = (id, label) => (
    <button key={id} onClick={() => setSub(id)} style={{
      padding: "11px 22px", fontWeight: 800, fontSize: 14, cursor: "pointer",
      color: sub === id ? "#fff" : "#94A3B8",
      background: sub === id ? "#123253" : "transparent",
      border: "none", borderBottom: sub === id ? "3px solid #38BDF8" : "3px solid transparent",
    }}>{label}</button>
  );
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", zIndex: 2, background: "#030F1A" }}>
      <div style={{ flexShrink: 0, display: "flex", gap: 2, background: "#0F2A45", borderBottom: "1px solid #1E3A5A" }}>
        {tabBtn('squash', '🎯 Squash')}
        {tabBtn('sailscan', '⛵ SailScan')}
        {tabBtn('sailtrim', '📐 SailTrim')}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div style={{ position: "absolute", inset: 0, display: sub === 'squash' ? 'block' : 'none' }}>
          <ErrorBoundary label="Squash"><SquashShotsApp/></ErrorBoundary>
        </div>
        <div style={{ position: "absolute", inset: 0, display: sub === 'sailscan' ? 'block' : 'none' }}>
          <ErrorBoundary label="SailScan"><SailScanTab teamId={teamId} boatId={boatId}/></ErrorBoundary>
        </div>
        <div style={{ position: "absolute", inset: 0, display: sub === 'sailtrim' ? 'block' : 'none' }}>
          <ErrorBoundary label="SailTrim"><SailTrimTab/></ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

const AdminTab       = dynamic(() => import("../AdminTab"),       { ssr:false, loading:TabLoading });

const CampaignTab    = dynamic(() => import("../CampaignTab"),    { ssr:false, loading:TabLoading });

const BoatConfigTab  = dynamic(() => import("../BoatConfigTab"),  { ssr:false, loading:TabLoading });

const WeatherTab     = dynamic(() => import("../WeatherTab"),     { ssr:false, loading:TabLoading });

const TimelineTab    = dynamic(() => import("../timeline/TimelineTab"), { ssr:false, loading:TabLoading });

export { TabLoading, PhotosTab, SquashShotsApp, SailScanTab, TaggerTab, ToolsTabs, AdminTab, CampaignTab, BoatConfigTab, WeatherTab, TimelineTab };