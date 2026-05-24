'use client'
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { saveVideo, getAllVideos, getVideosForDate, updateVideoTags, updateVideoStartUtc, deleteVideo, saveLogData, getLogData, saveXmlData, getXmlData, computeAutoTags, getSessions, getUnsyncedCount, markCloudSynced, getTagList, saveTagList, mergeTagList } from "../lib/localStore";
import { deleteStreamVideo, updateCloudSessionMetadata, checkCloudStatus, syncSessionToCloud, fetchCloudSession, listR2Sessions, waitForStreamReady, createStreamUpload, uploadFileToStream } from "../lib/bunny";
import PhotosTab from "./PhotosTab";
import SquashShotsApp from "./SquashShotsApp";
import SailScanTab from "./SailScanTab";
import { POLAR_KEY, savePolarToLS, loadPolarFromLS, parsePolarFile,
  buildSpline, evalSpline, goldenMax, preparePolar,
  polarInterp, polarVMGTarget, polarPerf, perfColor } from '../lib/polarCalc';
import { getBrowserSupabase } from '../lib/supabase/browser';
import { fetchTagList as cloudFetchTagList, saveTagListCloud, mergeTagListCloud } from '../lib/cloud-tag-list';
import { listSessionsCloud, getSessionCloud, saveLogDataCloud, saveXmlDataCloud } from '../lib/cloud-sessions';
import { listVideosCloud, upsertVideoCloud, makeVideoMirrorCallback, toLegacyVideoShape, ensureCloudVideoId } from '../lib/cloud-videos';
import { syncProxyForVideo } from '../lib/video-rendition-sync';
import { getVideoBlob, updateVideoBlobAndDuration } from '../lib/localStore';
import { cropVideo } from '../lib/video-crop';
import { listPhotosCloud, upsertPhotoCloud, toLegacyPhotoShape } from '../lib/cloud-photos';
import { getActiveMembership } from '../lib/active-membership';

// Sync offset persistence — inline to avoid module resolution issues
const OFFSET_KEY = "ssa:syncOffsets";
function getSyncOffsets() { try { const v=localStorage.getItem(OFFSET_KEY); return v?JSON.parse(v):{};} catch{return{};} }
function saveSyncOffset(videoId, secs) { try { const o=getSyncOffsets(); if(secs===0){delete o[videoId];}else{o[videoId]=secs;} localStorage.setItem(OFFSET_KEY,JSON.stringify(o));} catch{} }

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

// Returns { utc, source } | null where source is "mp4-meta" or "filename"
async function extractVideoCreationTime(file) {
  try {
    // 1) Scan the first 512KB — fast path, covers most consumer cameras.
    const head = await file.slice(0, 524288).arrayBuffer();
    const fromHead = _scanMvhd(head);
    if (fromHead) return { utc: fromHead, source: "mp4-meta" };

    // 2) Scan the last 1MB — DJI HEVC / re-muxed files often put `moov` at
    //    the end of the file instead of the start. Without this pass we'd
    //    never find mvhd and the timestamp would fall back to mtime.
    if (file.size > 524288) {
      const tailStart = Math.max(0, file.size - 1048576);
      const tail = await file.slice(tailStart, file.size).arrayBuffer();
      const fromTail = _scanMvhd(tail);
      if (fromTail) return { utc: fromTail, source: "mp4-meta" };
    }

    // 3) Filename fallback — DJI / Android / generic cameras embed the
    //    capture time directly in the filename (e.g. DJI_20250903122919_…).
    const fromName = extractTimestampFromFilename(file.name || "");
    if (fromName) return { utc: fromName, source: "filename" };
  } catch {}
  return null;
}

const ROLES = {
  admin:      { label:"Admin",      canImport:true,  canSync:true,  seeLocal:true, canDelete:true  },
  coach:      { label:"Coach",      canImport:true,  canSync:true,  seeLocal:true, canDelete:true  },
  crew:       { label:"Crew",       canImport:true,  canSync:false, seeLocal:true, canDelete:false },
  viewer:     { label:"Viewer",     canImport:false, canSync:false, seeLocal:false,canDelete:false },
  consultant: { label:"Consultant", canImport:false, canSync:false, seeLocal:false,canDelete:false },
};

function parseNmea(s){
  if(!s||!s.trim())return{lat:0,lon:0};
  const p=s.trim().split(/\s+/);
  if(p.length<2)return{lat:0,lon:0};
  const cvt=(str,degDigits)=>{
    if(!str)return 0;
    const hem=str.slice(-1);
    const num=str.slice(0,-1);
    const deg=parseFloat(num.slice(0,degDigits))||0;
    const min=parseFloat(num.slice(degDigits))||0;
    const v=deg+min/60;
    return(hem==="S"||hem==="W")?-v:v;
  };
  try{return{lat:cvt(p[0],2),lon:cvt(p[1],3)};}catch{return{lat:0,lon:0};}
}

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
    const mq = window.matchMedia("(max-width:767px)");
    const handler = e => setMobile(e.matches);
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

function expToUtc(ds,ts,offsetMin=0){
  const[d,m,y]=ds.split("/").map(Number);
  const yr=y>99?y:(y<50?2000+y:1900+y);
  const[h,mn,sc]=ts.split(":").map(Number);
  return Date.UTC(yr,m-1,d,h,mn,sc) - offsetMin*60000;
}
function parseCsvLog(text,offsetMin=0){
  const lines=text.replace(/\r/g,"").split("\n").filter(l=>l.trim());
  const rows=[];
  for(let i=1;i<lines.length;i++){
    const c=lines[i].split(",");
    if(c.length<27)continue; // need at least up to Vs_perf% (col 26)
    const bsp=parseFloat(c[4])||0, tws=parseFloat(c[12])||0;
    if(bsp<0.05&&tws<0.3)continue;
    const ds=c[1]?.trim(), ts=c[2]?.trim();
    if(!ds?.includes("/")||!ts?.includes(":"))continue;
    const utc=expToUtc(ds,ts,offsetMin);
    if(isNaN(utc))continue;
    const pos=parseNmea(c[0]);

    // Starting data — null if zero/missing (Expedition outputs 0 when not applicable)
    const opt=(i,zeroNull=true)=>{if(c.length<=i)return null;const v=parseFloat(c[i]);return(isNaN(v)||(zeroNull&&v===0))?null:v;};
    const dstLine = opt(29);                 // DST_LINE nm — 0 = not in start zone
    const tmLine  = opt(30);                 // TM_LINE seconds — 0 = not in start zone
    const ttbPort = opt(50, false);          // TTB_Port seconds — keep 0 (perfectly timed start)
    const ttbStbd = opt(51, false);          // TTB_Stbd seconds — keep 0
    const ttbPin  = opt(52, false);          // TTB_Pin seconds
    const ttbCB   = opt(53, false);          // TTB_CB seconds
    // Timer-1: treat 0 as "sequence not active yet" → null so event-UTC fallback is used.
    // Expedition only runs Timer-1 during the start sequence (last ~5 min before gun).
    // A stored 0 means inactive, NOT that the gun has just fired.
    const timer1  = opt(55, true);           // null when 0 → uses event-UTC diff as fallback

    rows.push({
      utc, lat:pos.lat, lon:pos.lon,
      heel:  parseFloat(c[3])||0,
      bsp,
      awa:   parseFloat(c[5])||0,   // AW_angle — apparent wind angle directly from log
      twa:   parseFloat(c[11])||0,
      tws,
      sog:   parseFloat(c[20])||0,
      vmg:   parseFloat(c[19])||0,
      vsTargPct: parseFloat(c[23])||0,
      vsPerfPct: parseFloat(c[26])||0,
      dstLine, tmLine, ttbPort, ttbStbd, ttbPin, ttbCB, timer1,
      rudder:parseFloat(c[56]??0)||0,       // col 56 (was wrongly col 52)
      yawR:  parseFloat(c[41]??0)||0,
    });
  }
  return{rows,startUtc:rows[0]?.utc||0,endUtc:rows[rows.length-1]?.utc||0};
}

function isoUtc(s,offsetMin=0){
  return new Date(s.trim().replace(" ","T")+"Z").getTime() - offsetMin*60000;
}
function parseXmlEvents(text,offsetMin=0){
  // Strip UTF-8 BOM — must happen before any processing
  const t = text.charCodeAt(0)===0xFEFF ? text.slice(1) : text;

  // ── Pure text-based parsing — bypasses DOMParser entirely ─────────────────
  // DOMParser for text/xml is fragile (BOM, undeclared entities, partial parse).
  // Regex on the raw text is simpler and works on any well-structured XML.

  // Return named attribute value from a tag string, case-insensitive
  const getAttr=(str,attr)=>{
    const m=str.match(new RegExp(`\\b${attr}="([^"]*)"`, 'i'));
    return m?m[1]:'';
  };

  // Find all opening or self-closing tags named `name` → array of full tag strings
  const findTags=name=>{
    const rx=new RegExp(`<${name}\\b[^>]*?/?>`, 'gi');
    return t.match(rx)||[];
  };

  // Single val="..." metadata element
  const getMeta=tag=>{
    const m=t.match(new RegExp(`<${tag}\\b[^>]*?\\bval="([^"]*)"`, 'i'));
    return m?m[1]:'';
  };

  // ── Metadata ───────────────────────────────────────────────────────────────
  const meta={
    boat:     getMeta('boat'),
    location: getMeta('location'),
    date:     getMeta('date'),
    dayType:  getMeta('daytypestr'),
    sailsUsed:getMeta('sailsused').split(';').map(s=>s.trim()).filter(Boolean),
  };

  // ── Events ─────────────────────────────────────────────────────────────────
  const sailsUpEvents=[],raceGuns=[];
  let dayStartUtc=null,dayStopUtc=null;
  for(const tag of findTags('event')){
    const utc=isoUtc(`${getAttr(tag,'date')} ${getAttr(tag,'time')}`,offsetMin);
    const type=getAttr(tag,'type'), attr=getAttr(tag,'attribute');
    if(type==='SailsUp'){
      const sails=attr.split(';').map(s=>s.trim()).filter(Boolean);
      sailsUpEvents.push({utc,sails,label:sails.join(' + ')||'Sails changed'});
    } else if(type==='RaceStartGun'){
      raceGuns.push({utc,raceNum:parseInt(attr)||0,label:`Race ${attr||'?'} start`,color:'#EF4444'});
    } else if(type==='DayStart'){ dayStartUtc=utc; }
    else if(type==='DayStop'){   dayStopUtc=utc; }
  }

  // ── Mark roundings ─────────────────────────────────────────────────────────
  const markRoundings=findTags('markrounding').map(tag=>({
    utc:    isoUtc(getAttr(tag,'datetime'),offsetMin),
    isTop:  getAttr(tag,'istopmark')==='true',
    isValid:getAttr(tag,'isvalid')!=='false',
    label:  getAttr(tag,'istopmark')==='true'?'Top mark':'Leeward gate',
    color:  getAttr(tag,'istopmark')==='true'?'#EF4444':'#8B5CF6',
  }));

  // ── Tack / jibes ───────────────────────────────────────────────────────────
  const tackJibes=findTags('tackjibe').map(tag=>({
    utc:    isoUtc(getAttr(tag,'datetime'),offsetMin),
    isTack: getAttr(tag,'istack')==='true',
    isValid:getAttr(tag,'isvalidperf')==='true',
    label:  getAttr(tag,'istack')==='true'?'Tack':'Gybe',
    color:  getAttr(tag,'istack')==='true'?'#1D9E75':'#7F77DD',
  }));

  // ── Phases — 30/60s analysis windows with sailing mode ────────────────────
  // sailingmode: 1=Upwind, 2=Reach, 4=Downwind, 8=Gybing/transitional
  const phases=[];
  // findTags matches self-closing <tag/> but phase has children — use a different approach
  const phaseBlocks=t.match(/<phase\b[^>]*>[\s\S]*?<\/phase>/gi)||[];
  for(const pb of phaseBlocks){
    const dt  = getAttr(pb.match(/<startdatetime\b[^>]*/i)?.[0]||'','val');
    const dur = getAttr(pb.match(/<duration\b[^>]*/i)?.[0]||'','val');
    const sm  = getAttr(pb.match(/<sailingmode\b[^>]*/i)?.[0]||'','val');
    if(!dt||!dur||!sm) continue;
    const utc=isoUtc(dt, offsetMin);
    if(utc) phases.push({utc, endUtc:utc+parseInt(dur)*1000, mode:parseInt(sm)});
  }

  const startLinesMap={};
  for(const tag of findTags('mark')){
    const mtype=getAttr(tag,'marktype');
    if(mtype!=='StartBoat'&&mtype!=='StartPin') continue;
    const name=getAttr(tag,'name');
    const lat=parseFloat(getAttr(tag,'lat')); const lon=parseFloat(getAttr(tag,'lon'));
    if(isNaN(lat)||isNaN(lon)) continue;
    const nm=name.match(/(\d+)$/); const rn=nm?parseInt(nm[1]):0;
    if(!startLinesMap[rn]) startLinesMap[rn]={};
    if(mtype==='StartPin')  startLinesMap[rn].pin ={lat,lon,name};
    if(mtype==='StartBoat') startLinesMap[rn].boat={lat,lon,name};
  }
  const startLines=Object.entries(startLinesMap)
    .map(([rn,{pin,boat}])=>({raceNum:parseInt(rn),pin,boat}))
    .filter(sl=>sl.pin&&sl.boat);

  return{meta,sailsUpEvents,raceGuns,markRoundings,tackJibes,dayStartUtc,dayStopUtc,startLines,phases};
}

// ─── POLAR (see src/lib/polarCalc.js) ──────────────────────────────────────
// (imports moved to top of file)


const R=(n,d=1)=>(n==null||isNaN(n))?"--":Number(n).toFixed(d);
const TACK_COLORS=['#1D9E75','#06B6D4','#8B5CF6','#F59E0B','#EF4444','#EC4899','#34D399','#60A5FA','#A78BFA','#FCD34D'];
const fmtT=s=>{const x=Math.max(0,Math.floor(s));return`${String(Math.floor(x/60)).padStart(2,"0")}:${String(x%60).padStart(2,"0")}`;};
const fmtUtc=u=>u?new Date(u).toISOString().slice(11,19):"--:--:--";
const TODAY=()=>new Date().toISOString().slice(0,10);
const fmtDate=d=>{if(!d)return"";const p=d.split("-");return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:d;};
const fmtDateTime=u=>{if(!u)return"";const dt=new Date(u);const dd=String(dt.getUTCDate()).padStart(2,"0");const mm=String(dt.getUTCMonth()+1).padStart(2,"0");const yyyy=dt.getUTCFullYear();const hh=String(dt.getUTCHours()).padStart(2,"0");const mi=String(dt.getUTCMinutes()).padStart(2,"0");return`${dd}/${mm}/${yyyy} ${hh}:${mi}`;};
const fmtSize=b=>b>1e9?`${(b/1e9).toFixed(1)} GB`:`${(b/1e6).toFixed(0)} MB`;
function nearestRow(rows,utc){if(!rows?.length)return null;let lo=0,hi=rows.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].utc<utc)lo=mid+1;else hi=mid;}if(lo>0&&Math.abs(rows[lo-1].utc-utc)<Math.abs(rows[lo].utc-utc))lo--;return Math.abs(rows[lo].utc-utc)<300000?rows[lo]:null;}
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
    const autoPattern = /^(tws-|upwind|reach|downwind|tack|gybe|topmark|mark|race-start|race|training|\d+x-)/;
    const manualTags = (v.tags||[]).filter(t => {
      if(autoPattern.test(t)) return false;
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

function SrcBadge({source}){const m={local:{l:"LOCAL",bg:"#06B6D415",bd:"#06B6D430",c:"#06B6D4"},cloud:{l:"CLOUD",bg:"#8B5CF615",bd:"#8B5CF630",c:"#8B5CF6"},processing:{l:"PROC",bg:"#F59E0B15",bd:"#F59E0B30",c:"#F59E0B"}};const s=m[source]||m.local;return<span style={{fontSize:9,padding:"1px 5px",borderRadius:3,letterSpacing:1,fontWeight:600,background:s.bg,border:`1px solid ${s.bd}`,color:s.c}}>{s.l}</span>;}
function Gauge({label,value,unit,color="#06B6D4",size="md",highlight=false}){
  // Gauge is only used for the on-video instrument overlay. On phones the
  // desktop sizing covers half the frame, so shrink everything ~40 %.
  const isMobile = useIsMobile();
  const baseFs = size==="lg"?28:size==="sm"?16:22;
  const fs     = isMobile ? Math.round(baseFs*0.6) : baseFs;
  const labelFs= isMobile ? 7 : 9;
  const unitFs = isMobile ? 7 : 10;
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
      <div style={{fontSize:unitFs,color:"#475569",marginTop:1}}>{unit}</div>
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

// Perpendicular (signed) distance from point to start line in metres.
// Positive = boat is on the pre-start side (has not crossed).
// Negative = boat is over the line (OCS).
// The "pre-start" side is determined by which side the wind comes from — we use
// the fact that the course is upwind: the boat should approach from downwind,
// so we check if the boat is on the downwind side of the line.
function perpDistToLine(lat,lon,pin,boat){
  if(!pin||!boat) return null;
  const latRef=(pin.lat+boat.lat)/2;
  const mLat=111319;
  const mLon=111319*Math.cos(latRef*Math.PI/180);
  const ax=0, ay=0;
  const bx=(boat.lon-pin.lon)*mLon, by=(boat.lat-pin.lat)*mLat;
  const cx=(lon-pin.lon)*mLon,       cy=(lat-pin.lat)*mLat;
  const len=Math.sqrt(bx*bx+by*by);
  if(len<1) return null;
  // Signed cross product: positive = left of pin→boat vector (pre-start side
  // when line runs roughly E-W and course is south / downwind is south)
  return (bx*cy-by*cx)/len;
}

// Extract boat length in metres from name — e.g. "NORTHSTAR72" → 72 ft → 21.9 m
function extractBoatLengthM(boatName){
  const m=(boatName||"").match(/(\d+)/);
  if(m){const n=parseInt(m[1]);if(n>=20&&n<=150)return n*0.3048;}
  return 12; // fallback ~40 ft
}

function VideoPlayer({video,logData,xmlData,syncOffset,sessionTzOffset=0,onPlayUtc,
                      // Phase B crop UX — three callbacks + the current
                      // cut points + busy flag. All optional; toolbar
                      // crop UI only renders when the setters are provided.
                      pendingCrop,onDeleteUpTo,onDeleteFromHere,onSaveCrop,cropBusy=false,cropProgress=null}){
  const vidRef=useRef(null),hlsRef=useRef(null);
  const[curTime,setCurTime]=useState(0);
  const[playing,setPlaying]=useState(false);
  const[dur,setDur]=useState(video.duration||0);
  const isHls=video.source==="cloud"||video.objectUrl?.includes(".m3u8");
  const lastUtcEmit=useRef(0);
  const isMobile=useIsMobile();

  // Load polar for target BSP calculation
  const polar=useMemo(()=>loadPolarFromLS(),[]);

  useEffect(()=>{
    if(!vidRef.current||!video.objectUrl)return;
    setCurTime(0);setPlaying(false);
    if(isHls){
      const init=()=>{
        if(hlsRef.current){hlsRef.current.destroy();hlsRef.current=null;}
        if(window.Hls?.isSupported()){const hls=new window.Hls();hls.loadSource(video.objectUrl);hls.attachMedia(vidRef.current);hlsRef.current=hls;}
        else if(vidRef.current.canPlayType("application/vnd.apple.mpegurl"))vidRef.current.src=video.objectUrl;
      };
      if(!window.Hls){const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.14/hls.min.js";s.onload=init;document.head.appendChild(s);}
      else init();
    }else{
      if(hlsRef.current){hlsRef.current.destroy();hlsRef.current=null;}
      vidRef.current.src=video.objectUrl;
    }
    return()=>{if(hlsRef.current){hlsRef.current.destroy();hlsRef.current=null;}};
  },[video.id,video.objectUrl]);

  const emitUtc=useCallback((t)=>{
    if(!onPlayUtc||!video.startUtc)return;
    const now=performance.now();
    if(now-lastUtcEmit.current<80)return;
    lastUtcEmit.current=now;
    onPlayUtc(video.startUtc+(t+(syncOffset||0))*1000);
  },[onPlayUtc,video.startUtc,syncOffset]);

  const logUtc=video.startUtc?video.startUtc+(curTime+(syncOffset||0))*1000:0;
  const row=logData&&logUtc?nearestRow(logData.rows,logUtc):null;
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

  // Pre-compute derived values
  const targBsp  = (polar && row) ? polarInterp(polar, row.tws, Math.abs(row.twa||0)) : null;
  const polPct   = (polar && row) ? polarPerf(polar, row.bsp, row.twa, row.tws)?.pct : null;

  // AWA: use log col 5 (AW_angle) directly; fall back to computed if 0/missing
  const awaRaw = row?.awa;
  const awa = (awaRaw && Math.abs(awaRaw) > 0.5)
    ? awaRaw
    : calcAWA(row?.twa, row?.tws, row?.bsp);

  // VMG% vs polar optimal — for upwind/downwind overlay
  const vmgTarget = (polar && row) ? polarVMGTarget(polar, row.tws) : null;
  const absA = Math.abs(row?.twa||0);
  const isUpwindAngle = absA < 90;
  const optVMG = vmgTarget ? (isUpwindAngle ? vmgTarget.upVMG : vmgTarget.downVMG) : null;
  const vmgPct = (optVMG && optVMG > 0.01 && row?.vmg != null)
    ? Math.max(0, Math.min(200, (row.vmg / optVMG) * 100))
    : null;

  // ── Starting instruments ────────────────────────────────────────────────────
  const guns       = xmlData?.raceGuns||[];
  const startLines = xmlData?.startLines||[];
  const boatLenM   = extractBoatLengthM(xmlData?.meta?.boat);

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

  // DISTANCE TO LINE — log DST_LINE (col 29, nm); geometry fallback
  const dstLineNm = (row?.dstLine!=null&&!isNaN(row.dstLine)) ? row.dstLine : null;
  const activeLine = nearestGun
    ? startLines.find(sl=>sl.raceNum===nearestGun.raceNum)||startLines[0]||null
    : startLines[0]||null;
  const distMGeom = (activeLine&&row?.lat&&row?.lon)
    ? perpDistToLine(row.lat,row.lon,activeLine.pin,activeLine.boat) : null;
  const distBL = dstLineNm!=null
    ? dstLineNm*1852/boatLenM
    : (distMGeom!=null ? distMGeom/boatLenM : null);
  const lineSrc = dstLineNm!=null ? "log" : (distMGeom!=null ? "gps" : null);

  // TIME TO LINE — log TM_LINE (col 30, seconds); geometry fallback from dist/SOG
  const sogMs = (row?.sog||0)*0.5144;
  const tmLineLog  = (row?.tmLine!=null&&!isNaN(row.tmLine)&&row.tmLine>0) ? row.tmLine : null;
  const tmLineGeom = (distMGeom!=null&&sogMs>0.1) ? Math.abs(distMGeom)/sogMs : null;
  const timeToLine = tmLineLog ?? tmLineGeom;

  // TIME TO BURN — log TTB_Port/Stbd (cols 50/51, opt keeps 0); fallback: gun timer − time to line
  // Expedition only populates these during the active start sequence.
  // opt(50, false) stored 0 = perfect start, null = not in sequence.
  const ttbPort = row?.ttbPort;  // already null-cleaned by opt(50, false) in parseCsvLog
  const ttbStbd = row?.ttbStbd;
  const ttbCalc = (secToGun!=null&&timeToLine!=null) ? secToGun-timeToLine : null;
  // Use log value when available (including 0 = perfect); otherwise calculated fallback
  const ttbPortFmt = (ttbPort!=null) ? ttbPort : ttbCalc;
  const ttbStbdFmt = (ttbStbd!=null) ? ttbStbd : ttbCalc;

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

  const overlay=row&&(()=>{
    if(mode==="start") return(
      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
        {/* GUN: red counting down, green after gun fires */}
        <Gauge label="GUN"
               value={gunActive?fmtGun(secToGun):"--:--"}
               unit={secToGun==null?"":secToGun>0?"to start":"after gun"}
               color={afterGun?"#10B981":"#EF4444"} size="lg"
               highlight={gunActive&&!afterGun&&secToGun<=60}/>
        {/* DIST TO LINE — log or GPS geometry */}
        <Gauge label={`LINE·${lineSrc||"--"}`}
               value={fmtDist(distBL)}
               unit={distBL==null?"BL":`BL`}
               color={distBL!=null&&distBL<0?"#EF4444":"#F59E0B"} size="lg"
               highlight={distBL!=null&&distBL<0}/>
        {/* TTB PORT */}
        <Gauge label={`TTB·P${ttbPort!=null?"·log":"·calc"}`}
               value={ttbPortFmt!=null?fmtBurn(ttbPortFmt):"--:--"}
               unit={ttbPortFmt==null?"":ttbPortFmt>0?"early":"late"}
               color={ttbPortFmt!=null&&ttbPortFmt<0?"#EF4444":"#10B981"} size="lg"
               highlight={ttbPortFmt!=null&&ttbPortFmt<-10}/>
        {/* TTB STBD */}
        <Gauge label={`TTB·S${ttbStbd!=null?"·log":"·calc"}`}
               value={ttbStbdFmt!=null?fmtBurn(ttbStbdFmt):"--:--"}
               unit={ttbStbdFmt==null?"":ttbStbdFmt>0?"early":"late"}
               color={ttbStbdFmt!=null&&ttbStbdFmt<0?"#EF4444":"#10B981"} size="lg"
               highlight={ttbStbdFmt!=null&&ttbStbdFmt<-10}/>
        <Gauge label="BSP"  value={R(row.bsp)}         unit="kn"   color="#10B981" size="sm"/>
        <Gauge label="SOG"  value={R(row.sog)}         unit="kn"   color="#FBBF24" size="sm"/>
        <Gauge label="TWS"  value={R(row.tws)}         unit="kn"   color="#7DD3FC" size="sm"/>
        <Gauge label="TWA"  value={`${R(row.twa,0)}°`} unit="true" color="#7DD3FC" size="sm"/>
        <Gauge label="Heel" value={`${R(row.heel,0)}°`}unit="°"    color="#F97316" size="sm"/>
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
      <div style={{position:"relative",background:"#000",aspectRatio:"16/9",width:"100%",overflow:"hidden",borderRadius:"12px 12px 0 0"}}>
        {video.objectUrl?<video ref={vidRef} style={{width:"100%",height:"100%",objectFit:"contain"}} onTimeUpdate={onUpdate} onPlay={onUpdate} onPause={onUpdate} onLoadedMetadata={e=>{setDur(e.target.duration);}}/>:
         video.source==="processing"?<div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"#F59E0B"}}><div style={{fontSize:28,marginBottom:8}}>⏳</div><div style={{fontSize:12}}>Processing in Stream…</div><div style={{fontSize:10,color:"#475569",marginTop:4}}>1–3 min typically</div></div>:
         <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"#334155"}}><div style={{fontSize:28,marginBottom:8,opacity:0.3}}>📹</div><div style={{fontSize:11}}>No playback available</div></div>}
        {!playing&&video.objectUrl&&<div onClick={()=>vidRef.current?.play()} style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:64,height:64,background:"rgba(6,182,212,0.9)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:22}}>▶</div>}
        {/* On mobile, pin to all-but-bottom so tiles wrap within the
            frame width instead of overflowing off the right edge. */}
        {overlay&&<div style={{position:"absolute",top:isMobile?6:10,left:isMobile?6:10,right:isMobile?6:undefined}}>{overlay}</div>}
        {modeBadge}
        {/* Phase B — PREVIEW badge when the player is serving the 720p
            proxy rendition and the full-resolution original hasn't been
            uploaded yet. Disappears automatically once the original lands. */}
        {video.servedRendition==='proxy' && !video.hasOriginal && (
          <div style={{position:"absolute",top:10,right:10,background:"rgba(245,158,11,0.95)",color:"#000",borderRadius:4,padding:"3px 8px",fontSize:10,fontWeight:700,letterSpacing:1}}>
            PREVIEW · HD COMING LATER
          </div>
        )}
        <div style={{position:"absolute",bottom:8,left:8}}><SrcBadge source={video.source||"local"}/></div>
        <div style={{position:"absolute",bottom:8,right:8,background:"rgba(0,0,0,0.7)",borderRadius:4,padding:"2px 7px",fontSize:10,color:"#64748B",fontFamily:"monospace"}}>{fmtT(curTime)} / {fmtT(dur)}{logUtc&&row?`  ${(()=>{const d=new Date(logUtc+sessionTzOffset*60000);return String(d.getUTCHours()).padStart(2,"0")+":"+String(d.getUTCMinutes()).padStart(2,"0")+":"+String(d.getUTCSeconds()).padStart(2,"0");})()} local`:""}</div>
      </div>
      <div style={{padding:"8px 12px 0"}}>
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
          title="Fullscreen"
          onClick={()=>{
            const el=vidRef.current;
            if(!el)return;
            if(document.fullscreenElement) document.exitFullscreen?.();
            else if(el.requestFullscreen) el.requestFullscreen();
            else if(el.webkitEnterFullscreen) el.webkitEnterFullscreen();
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
        <div style={{flex:1}}/>
        {row&&<span style={{fontSize:10,color:"#1D9E75"}}>● live instruments</span>}
        {!polar&&row&&<span style={{fontSize:9,color:"#475569"}}>· upload polar for target BSP</span>}
        {isHls&&<span style={{fontSize:9,color:"#8B5CF6"}}>HLS · Stream</span>}
      </div>
    </div>
  );
}

function VideoCard({video,selected,onClick,onThumbLoad,batchMode,batchSelected,onBatchToggle}){
  const handleLoaded = () => onThumbLoad?.(video.id);
  const tags = video.tags||[];
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
        {video.thumbnailUrl?<img src={video.thumbnailUrl} alt="" loading="lazy" onLoad={handleLoaded} onError={handleLoaded} style={{width:"100%",height:"100%",objectFit:"cover"}}/>:
         video.objectUrl&&video.source!=="cloud"?<video src={video.objectUrl} onLoadedData={handleLoaded} onError={handleLoaded} style={{width:"100%",height:"100%",objectFit:"cover"}} muted preload="metadata"/>:
         video.source==="processing"?<div style={{color:"#F59E0B",fontSize:9}}>⏳</div>:
         <div style={{color:"#1E3A5A",fontSize:9}}>📹</div>}
        <div style={{position:"absolute",bottom:3,right:4,background:"rgba(0,0,0,0.8)",borderRadius:2,padding:"0 3px",fontSize:8,color:"#64748B",fontFamily:"monospace"}}>{video.duration?fmtT(video.duration):"--:--"}</div>
        <div style={{position:"absolute",top:3,right:4}}><SrcBadge source={video.source||"local"}/></div>
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
        {/* 4) Filename (title) at bottom */}
        <div style={{fontSize:10,fontWeight:600,color:"#E2E8F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{video.title}</div>
      </div>
    </div>
  );
}

function TagEditor({video, onSave, tagList=[], sessionDate, onTagListChange}){
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
  const save = async () => { await updateVideoTags(video.id, tags); onSave(video.id, tags); setDirty(false); };
  const deleteFromList = tag => { onTagListChange?.(tagList.filter(t => t !== tag)); };
  const suggestions = tagList.filter(t => !tags.includes(t));
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
          proxyPath: result.proxyPath,
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
function BatchSyncPanel({videos, syncState, onSyncProxies, onUploadOriginals}){
  const total     = videos.length;
  const haveProxy = videos.filter(v=>v.hasProxy).length;
  const haveOrig  = videos.filter(v=>v.hasOriginal).length;
  const needProxy = total - haveProxy;
  const needOrig  = total - haveOrig;
  const busy      = syncState?.phase==="pushing" || syncState?.phase==="pulling";

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
      {row("Proxies · 720p", haveProxy, "#06B6D4")}
      {row("Originals · HD", haveOrig, "#8B5CF6")}
      {busy && syncState?.message && (
        <div style={{margin:"7px 0"}}>
          <div style={{fontSize:9,color:"#7DD3FC",fontFamily:"monospace",lineHeight:1.4,wordBreak:"break-word",marginBottom:3}}>{syncState.message}</div>
          <div style={{height:4,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${syncState.progress||0}%`,background:"#06B6D4",transition:"width .3s"}}/>
          </div>
        </div>
      )}
      <button onClick={onSyncProxies} disabled={busy||needProxy===0}
        style={{width:"100%",marginTop:8,background:needProxy===0?"#0A1929":"#06B6D4",border:"none",borderRadius:6,
          padding:"7px 0",color:needProxy===0?"#475569":"#000",fontWeight:700,fontSize:11,
          cursor:(busy||needProxy===0)?"not-allowed":"pointer",opacity:busy?0.6:1}}>
        {needProxy===0?"✓ All proxies synced":`☁ Sync ${needProxy} prox${needProxy===1?"y":"ies"}`}
      </button>
      <button onClick={onUploadOriginals} disabled={busy||needOrig===0}
        style={{width:"100%",marginTop:6,background:"none",border:`1px solid ${needOrig===0?"#1E3A5A":"#8B5CF6"}`,
          borderRadius:6,padding:"6px 0",color:needOrig===0?"#475569":"#A78BFA",fontWeight:700,fontSize:11,
          cursor:(busy||needOrig===0)?"not-allowed":"pointer",opacity:busy?0.6:1}}>
        {needOrig===0?"✓ All originals uploaded":`⇪ Upload ${needOrig} original${needOrig===1?"":"s"}`}
      </button>
      <div style={{fontSize:8,color:"#334155",marginTop:6,lineHeight:1.4}}>
        Proxies stream instantly on phones. Originals are full quality — upload them with the button when on fast wifi.
      </div>
    </div>
  );
}

function SyncControl({offset,onChange}){
  return(
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:"1px solid #1E3A5A"}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
        <span style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase"}}>Sync offset</span>
        <span style={{fontSize:11,fontFamily:"monospace",color:offset!==0?"#F59E0B":"#334155"}}>{offset>0?"+":""}{offset}s</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:3,marginBottom:offset!==0?5:0}}>
        {[[-3600,"-1h"],[-60,"-1m"],[-10,"-10s"],[-1,"-1s"],[1,"+1s"],[10,"+10s"],[60,"+1m"],[3600,"+1h"]].map(([v,l])=><button key={l} onClick={()=>onChange(offset+v)} style={{background:"#1E3A5A",border:"none",borderRadius:3,padding:"4px 0",color:"#7DD3FC",cursor:"pointer",fontSize:10,fontFamily:"monospace"}}>{l}</button>)}
      </div>
      {offset!==0&&<button onClick={()=>onChange(0)} style={{width:"100%",background:"none",border:"1px solid #EF444440",borderRadius:4,padding:"3px",color:"#EF4444",cursor:"pointer",fontSize:10}}>Reset</button>}
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

function UploadTab({role,cloudStatus,onImported}){
  const perms=ROLES[role];
  // ── Refs ──────────────────────────────────────────────────────────────────
  const vidRef=useRef(null),csvRef=useRef(null),xmlRef=useRef(null),polarRef=useRef(null);
  const[pendingVids,setPendingVids]=useState([]);
  const[csvParsed,setCsvParsed]=useState(null);
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

  const addLog=msg=>setLog(p=>[...p.slice(-30),msg]);

  const TzSelect=({value,onChange,label})=>(
    <div style={{marginTop:8}}>
      <div style={{fontSize:9,color:"#475569",letterSpacing:1,marginBottom:3}}>{label}</div>
      <select value={value} onChange={e=>onChange(Number(e.target.value))} style={{width:"100%",background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 7px",color:"#94A3B8",fontSize:10,cursor:"pointer"}}>
        {TZ_OPTIONS.map(o=>(<option key={o.offsetMin} value={o.offsetMin}>{o.label}</option>))}
      </select>
    </div>
  );

  const handleVids=useCallback(files=>{
    const valid=Array.from(files).filter(f=>f.type.startsWith("video/")||/\.(mp4|mov|mts|avi|mkv|m4v)$/i.test(f.name));
    if(!valid.length){addLog("✕ No video files found. MP4/MOV/MTS/AVI accepted.");return;}
    setPendingVids(p=>[...p,...valid.map(f=>({id:Math.random().toString(36).slice(2),file:f,name:f.name,size:f.size,url:URL.createObjectURL(f),duration:null,startUtc:null,tsSource:null}))]);
    addLog(`✓ ${valid.length} video${valid.length>1?"s":""} queued — reading timestamps…`);
    valid.forEach(async f=>{
      const result=await extractVideoCreationTime(f);
      setPendingVids(p=>p.map(v=>{
        if(v.file!==f)return v;
        if(result){
          const adjusted=result.utc - vidTz*60000;
          const label=result.source==="filename"?"filename timestamp":"camera timestamp";
          addLog(`✓ ${f.name}: ${label} ${fmtDateTime(adjusted)} UTC`);
          return{...v,startUtc:adjusted,tsSource:result.source};
        }
        if(f.lastModified&&v.duration){const ts=f.lastModified-v.duration*1000 - vidTz*60000;addLog(`✓ ${f.name}: using file modified time (no MP4 metadata)`);return{...v,startUtc:ts,tsSource:"lastmodified"};}
        addLog(`⚠ ${f.name}: no timestamp — set manually in Library`);
        return v;
      }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[vidTz]);

  const parseCsvWithTz=useCallback((file,tz)=>{
    if(!file)return;setCsvFile(file);
    const r=new FileReader();
    r.onload=e=>{
      try{const p=parseCsvLog(e.target.result,tz);setCsvParsed(p);const tzLabel=TZ_OPTIONS.find(o=>o.offsetMin===tz)?.label||`UTC+${tz/60}`;addLog(`✓ Log: ${p.rows.length.toLocaleString()} rows · ${file.name} · ${tzLabel}`);}
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

  const handleCsv=useCallback(file=>{parseCsvWithTz(file,csvTz);},[csvTz,parseCsvWithTz]);
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
      const rawUtc=v.startUtc+vidTz*60000;
      const adjusted=rawUtc-tz*60000;
      return{...v,startUtc:adjusted};
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
      await saveLogData(d, csvParsed.rows, csvFile.name, csvParsed.startUtc, csvParsed.endUtc, csvTz);
      // Mirror to Supabase if there's an active membership.
      try {
        const supabase = getBrowserSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const ok = await saveLogDataCloud({
            userId: user.id,
            date: d,
            logData: { rows: csvParsed.rows, fileName: csvFile.name, startUtc: csvParsed.startUtc, endUtc: csvParsed.endUtc, tzOffset: csvTz },
            tzOffsetMinutes: csvTz,
          });
          if (ok) addLog(`☁ Log synced to cloud → ${d}`);
        }
      } catch (e) { /* non-fatal — local copy is the source of truth until L3.F */ }
      addLog(`✓ Log saved (${csvParsed.rows.length.toLocaleString()} rows) → ${d}`);
    }
    if (xmlParsed) {
      const d = xmlDate || csvDate || fallbackDate;
      addLog(`Saving events → session ${fmtDate(d)}…`);
      await saveXmlData(d, xmlParsed, xmlFile.name);
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
        }
      } catch (e) { /* non-fatal */ }
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
        const s = await saveVideo(pv.file, {
          duration: pv.duration, startUtc: pv.startUtc, tsSource: pv.tsSource,
          tags, title: pv.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
          sessionDate: vidDate,
        });
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
    addLog(cloudStatus?.available && perms.canSync ? "Saved. Click Push to Cloud to upload." : "Saved to local storage. Ready in Library.");
    setPhase("saved");
    onImported({ date: primaryDate, videos: saved, logData: csvParsed, xmlData: xmlParsed });
  };

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
          <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}><SrcBadge source="local"/><span style={{fontSize:11,fontWeight:600,color:"#06B6D4"}}>① Local — instant</span></div><div style={{fontSize:10,color:"#475569"}}>Saved to browser IndexedDB + localStorage. Available in Library immediately. Coach/Admin only.</div></div>
          <div style={{width:1,background:"#1E3A5A"}}/>
          <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}><SrcBadge source="cloud"/><span style={{fontSize:11,fontWeight:600,color:"#8B5CF6"}}>② Cloud — background</span></div><div style={{fontSize:10,color:"#475569"}}>Log + events → Bunny Storage. Videos → Bunny Stream (HLS). Accessible to all team roles.</div></div>
        </div>

        {phase==="idle"||phase==="saving"?(
          <>
            {/* Video drop zone */}
            <div style={{background:"#0A1929",border:`1px solid ${pendingVids.length?"#06B6D4":"#1E3A5A"}`,borderRadius:12,padding:16}}>
              <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:11}}>Video files</div>
              <input ref={vidRef} type="file" accept="video/*,.mov,.mp4,.mts,.avi,.mkv,.m4v" multiple style={{display:"none"}} onChange={e=>handleVids(e.target.files)}/>
              <div onClick={()=>vidRef.current?.click()} onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);handleVids(e.dataTransfer.files);}} style={{border:`2px dashed ${dragOver?"#06B6D4":"#1E3A5A"}`,borderRadius:8,padding:"24px 16px",textAlign:"center",cursor:"pointer",background:dragOver?"#071E30":"transparent",marginBottom:pendingVids.length?11:0,transition:"all 0.12s"}}>
                <div style={{fontSize:20,marginBottom:7}}>📹</div>
                <div style={{fontSize:12,color:"#64748B"}}>Drop videos or click to browse</div>
                <div style={{fontSize:10,color:"#334155",marginTop:3}}>MP4 · MOV · MTS · AVI · multiple files</div>
              </div>
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
                <TzSelect value={csvTz} onChange={onCsvTzChange} label="Log file timezone (times are local)"/>
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

            {/* Video timezone */}
            {pendingVids.length>0&&(
              <div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:"12px 14px"}}>
                <TzSelect value={vidTz} onChange={onVidTzChange} label="Video timestamp timezone"/>
                <div style={{fontSize:9,color:"#334155",marginTop:5}}>
                  Most cameras (GoPro, Garmin, older iPhones) write <strong style={{color:"#475569"}}>local time</strong> in the video file.
                  Newer iPhones write UTC. Default matches the log timezone ({TZ_OPTIONS.find(o=>o.offsetMin===DEFAULT_TZ)?.label}).
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
        {xTicks.map((x,i)=><text key={i} x={Math.max(pad.l+2,Math.min(pad.l+W-2,px(x)))} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill="#475569">{new Date(x).toISOString().slice(11,16)}</text>)}
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
        {xTicks.map((x,i)=><text key={i} x={Math.max(pad.l+2,Math.min(pad.l+W-2,px(x)))} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill="#475569">{new Date(x).toISOString().slice(11,16)}</text>)}
        {polPts.length>0&&<><rect x={pad.l+4} y={4} width="8" height="5" fill="#22C55E" rx="1"/><text x={pad.l+15} y={9} fontSize="8" fill="#22C55E">Polar %</text></>}
        {tgtPts.length>0&&<><rect x={pad.l+60} y={4} width="8" height="5" fill="#22C55E" rx="1"/><text x={pad.l+71} y={9} fontSize="8" fill="#22C55E">Target %</text></>}
      </svg>
    </div>
  );
}

// ─── AI CHART CHAT ────────────────────────────────────────────────────────────
const LOG_FIELDS = "tws (true wind speed kn), twa (true wind angle °), bsp (boat speed kn), sog (speed over ground kn), vmg (velocity made good kn), heel (heel angle °), vsTargPct (% of target speed col23), vsPerfPct (% of polar speed col26), rudder (rudder angle °)";
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
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!loading&&ask()} placeholder={hasData?"Ask about your sailing data…":"Load a session in Library first"} disabled={!hasData||loading} style={{flex:1,background:"#071624",border:"1px solid #8B5CF640",borderRadius:6,padding:"7px 11px",color:"#E2E8F0",fontSize:11,outline:"none",opacity:hasData?1:0.4}}/>
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

  // ── Map init ─────────────────────────────────────────────────────────────────
  React.useEffect(()=>{
    if(!containerRef.current || filteredRows.length < 2) return;

    const initMap = () => {
      const L = window.L;
      if(!L) return;
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
      const covVideos=(allVideos||[]).filter(v=>v.startUtc&&v.duration);
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
          .bindTooltip(`📹 ${vid.title||'Video'} · ${Math.round(vid.duration/60)}min<br><span style="font-size:10px;color:#94A3B8">Click to open in Library</span>`,{allowHTML:true})
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
      const fmtU=utc=>{try{const d=new Date(utc);return isNaN(d)?'--:--':d.toISOString().slice(11,16);}catch{return'--:--';}};
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

      if(allLatLngs.length>0){try{map.fitBounds(L.latLngBounds(allLatLngs),{padding:[24,24]});}catch{}}
    };

    if(!window.L){
      if(!document.getElementById('leaflet-css')){const css=document.createElement('link');css.id='leaflet-css';css.rel='stylesheet';css.href='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';document.head.appendChild(css);}
      const js=document.createElement('script');js.src='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';js.onload=initMap;document.head.appendChild(js);
    } else { initMap(); }
    return()=>{ if(mapRef.current){mapRef.current.remove();mapRef.current=null;boatMarkerRef.current=null;} };
  },[filteredRows, hlRows, xmlData, polar, allVideos]);

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
        {dayStart&&<span>Start: <strong style={{color:"#22C55E"}}>{new Date(dayStart).toISOString().slice(11,16)}</strong></span>}
        {dayStop&&<span>End: <strong style={{color:"#F59E0B"}}>{new Date(dayStop).toISOString().slice(11,16)}</strong></span>}
        {hlRows.length>0&&<span style={{color:"#06B6D4",marginLeft:"auto"}}>● Clip: {hlRows.length} pts</span>}
        {playUtc&&<span style={{color:"#F59E0B",marginLeft:"auto"}}>▲ Live: {new Date(playUtc).toISOString().slice(11,16)} UTC</span>}
      </div>
    </div>
  );
}

// ─── ANALYTICS TAB ────────────────────────────────────────────────────────────
function AnalyticsTab({logData,xmlData,allVideos,sessions,selectedVideo,onSelectVideo,setActiveTab,activeDate,onSelectDate,playUtc=null,visible=true,photos=[],canUseAI=true,canSeeAnalyticsData=true}){
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
              {sessions.map(s => (
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
              ⚠ No event file — select session in Library or re-import XML
            </span>
          )}
          {!logData&&<span style={{fontSize:10,color:"#EF4444"}}>No log data loaded — select a session in Library</span>}
        </div>

        {/* ── Now Playing bar — live instrument data from video ── */}
        {liveActive&&(
          <div style={{background:"#0A1929",border:"1px solid #F59E0B40",borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <span style={{fontSize:9,color:"#F59E0B",fontWeight:700,letterSpacing:1,textTransform:"uppercase",flexShrink:0}}>▶ Now playing</span>
            <span style={{fontSize:11,fontFamily:"monospace",color:"#94A3B8"}}>{new Date(playUtc).toISOString().slice(11,19)} UTC</span>
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
              <button onClick={()=>setActiveTab("library")} style={{background:"#06B6D4",border:"none",borderRadius:8,padding:"8px 20px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>Go to Library</button>
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
                  const fmtUTC=u=>new Date(u).toISOString().slice(11,16);
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

              // Polar for target BSP
              const upPolar = loadPolarFromLS();

              // Sample rows inside upwind phases (max ~1200 pts for perf)
              const step=Math.max(1,Math.floor(rows.length/1200));
              const upRows=rows.filter((_,i)=>i%step===0)
                .filter(r=>r.tws>0&&r.tws<50&&inUpwind(r.utc));

              // a) VMG % of polar optimal upwind VMG
              const vmgPts=upRows.filter(r=>r.vmg>0).map(r=>{
                if(!upPolar) return null;
                const t=polarVMGTarget(upPolar,r.tws);
                const pct=t.upVMG>0.01?(r.vmg/t.upVMG)*100:null;
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
                    {!upPolar&&<span style={{fontSize:9,color:"#F59E0B",marginLeft:4}}>⚠ Upload polar for VMG% and target BSP%</span>}
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
                        T{i+1} {new Date(tk.utc).toISOString().slice(11,16)}
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
                                  {tk?new Date(tk.utc).toISOString().slice(11,16):"--"}
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
                        sessionTzOffset,searchQuery,setSearchQuery,sortBy,setSortBy,
                        selectedTags,toggleTag,allTags,isManTag,displayed,perms,
                        setActiveTab,cloudStatus,updateVideoTagsFn,
                        computeAutoTagsFn,sessionTagList,setSessionTagList,
                        handlePlayUtc,onDeleted,role,
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
      {sessions.map(s=>{
        const isActive=activeDate===s.date;
        const isLocal=!s.source||s.source==="local";
        return(
          <div key={s.date} onClick={()=>{loadDate(s.date);setView("clips");}}
            style={{padding:"14px 16px",borderBottom:"1px solid #0F2030",
              background:isActive?"#0F2A45":"transparent",display:"flex",alignItems:"center",gap:12}}>
            <div style={{flex:1}}>
              <div style={{fontSize:14,color:isActive?"#06B6D4":"#E2E8F0",fontWeight:600}}>
                {s.date===TODAY()?"Today":fmtDate_(s.date)}
              </div>
              <div style={{fontSize:12,color:"#475569",marginTop:2}}>
                {s.videoCount||0} clips{s.hasLog?" · log":""}{s.hasXml?" · events":""}
                {s.location?` · ${s.location}`:""}
              </div>
            </div>
            <SrcBadge source={isLocal?"local":"cloud"}/>
            {isActive&&<span style={{color:"#06B6D4",fontSize:18}}>✓</span>}
          </div>
        );
      })}
    </div>
  );

  if(view==="player"&&video) return(
    <div style={{flex:1,overflowY:"auto",background:"#030F1A"}}>
      <div style={{display:"flex",alignItems:"center",padding:"10px 14px 6px",gap:10}}>
        <button onClick={()=>setView("clips")} style={{background:"none",border:"none",color:"#06B6D4",fontSize:18,cursor:"pointer",padding:"4px 8px 4px 0"}}>←</button>
        <span style={{fontSize:13,fontWeight:600,color:"#E2E8F0",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{video.title}</span>
      </div>
      <VideoPlayer video={video} logData={logData} xmlData={xmlData}
        syncOffset={syncOffsets[video.id]||0} sessionTzOffset={sessionTzOffset}
        onPlayUtc={handlePlayUtc}/>
      <div style={{padding:"12px 16px"}}>
        {video.twsAvg!=null&&(
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:14}}>
            {[["TWS",video.twsAvg,"kt","#7DD3FC"],["TWA",video.twaAvg,"°","#7DD3FC"],["VMG",video.vmgAvg,"kt","#22C55E"],
              ["Polar%",video.polpercAvg,"%",video.polpercAvg==null?"#22C55E":video.polpercAvg>=110?"#166534":video.polpercAvg>=90?"#22C55E":"#EF4444"],["Target%",video.vsTargPercAvg,"%",video.vsTargPercAvg==null?"#22C55E":video.vsTargPercAvg>=110?"#166534":video.vsTargPercAvg>=90?"#22C55E":"#EF4444"],["BSP",video.bspAvg,"kt","#10B981"]]
              .map(([l,v,u,c])=>(
                <div key={l} style={{background:"#0A1929",borderRadius:8,padding:"10px 10px",border:`1px solid ${c}20`,textAlign:"center"}}>
                  <div style={{fontSize:10,color:"#475569",marginBottom:3}}>{l}</div>
                  <div style={{fontSize:18,fontWeight:700,color:c,fontFamily:"monospace"}}>{v!=null?R(v):"--"}<span style={{fontSize:10,marginLeft:1}}>{u}</span></div>
                </div>
              ))}
          </div>
        )}
        {/* Sync offset */}
        <div style={{marginBottom:12}}>
          <SyncControl offset={syncOffsets[video.id]||0}
            onChange={v=>{saveSyncOffset(video.id,v);setSyncOffsets(p=>({...p,[video.id]:v}));}}/>
        </div>
        {/* Tags */}
        {perms.canImport&&<TagEditor video={video} tagList={sessionTagList} sessionDate={activeDate}
          onTagListChange={async t=>{
            setSessionTagList(t);
            try {
              const supabase=getBrowserSupabase();
              const {data:{user}}=await supabase.auth.getUser();
              if(user) await saveTagListCloud({userId:user.id,date:activeDate,tags:t});
              else saveTagList(activeDate,t);
            } catch { saveTagList(activeDate,t); }
          }}
          onSave={(id,tags)=>{updateVideoTagsFn(id,tags);setSelectedVideo(p=>({...p,tags}));}}/>}
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
                    {/* Thumbnail */}
                    <div style={{width:96,flexShrink:0,background:"#071624",position:"relative",overflow:"hidden"}}>
                      {v.thumbnailUrl
                        ? <img src={v.thumbnailUrl} alt="" loading="lazy"
                            onLoad={()=>onThumbLoad?.(v.id)}
                            onError={()=>onThumbLoad?.(v.id)}
                            style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                        : v.objectUrl&&v.source!=="cloud"
                          ? <video src={v.objectUrl}
                              onLoadedData={()=>onThumbLoad?.(v.id)}
                              onError={()=>onThumbLoad?.(v.id)}
                              style={{width:"100%",height:"100%",objectFit:"cover"}} muted preload="none"/>
                          : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:18}}>📹</div>}
                      <div style={{position:"absolute",bottom:2,right:4,background:"rgba(0,0,0,0.8)",
                        borderRadius:2,padding:"0 3px",fontSize:9,color:"#64748B",fontFamily:"monospace"}}>
                        {v.duration?fmtT(v.duration):"--:--"}
                      </div>
                    </div>
                    {/* Metadata — order: race tags, sail tags, TWS/TWA, filename */}
                    {(()=>{
                      const EVENT_TAGS = ["race-start","topmark","mark"];
                      const POS_TAGS   = ["upwind","reach","downwind"];
                      const MANO_TAGS  = ["tack","gybe"];
                      const SAIL_SKIP  = /^(main|msail|mainsail|main-)/;
                      const tags = v.tags||[];
                      const raceTags = [
                        ...tags.filter(t=>EVENT_TAGS.includes(t)),
                        ...tags.filter(t=>POS_TAGS.includes(t)).slice(0,1),
                        ...tags.filter(t=>MANO_TAGS.includes(t)),
                      ];
                      const SKIP_ALL = new Set(["local","cloud","training","race","today","topmark","mark","race-start","upwind","reach","downwind","tack","gybe"]);
                      const isLocTag = t => !SKIP_ALL.has(t)&&!t.startsWith("tws-")&&!SAIL_SKIP.test(t)&&!/^\d+x-/.test(t)&&t.includes("-")&&!EVENT_TAGS.includes(t)&&!POS_TAGS.includes(t)&&!MANO_TAGS.includes(t);
                      const sailTags = tags.filter(t=>!SKIP_ALL.has(t)&&!SAIL_SKIP.test(t)&&!t.startsWith("tws-")&&!/^\d+x-/.test(t)&&!isLocTag(t));
                      const tagCol = t => {
                        if(EVENT_TAGS.includes(t)) return{bg:"#EF444420",bd:"#EF444440",c:"#EF4444"};
                        if(POS_TAGS.includes(t))   return{bg:"#06B6D420",bd:"#06B6D440",c:"#06B6D4"};
                        if(MANO_TAGS.includes(t))  return{bg:"#1D9E7520",bd:"#1D9E7540",c:"#1D9E75"};
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
                          {/* 3) TWS & TWA */}
                          <div style={{fontSize:11,color:"#7DD3FC",fontFamily:"monospace",marginBottom:3,display:"flex",gap:8}}>
                            {v.twsAvg!=null?<span>TWS {R(v.twsAvg)}kt</span>:null}
                            {v.twaAvg!=null?<span>TWA {R(v.twaAvg,0)}°</span>:null}
                            {v.polpercAvg!=null&&<span style={{color:v.polpercAvg>=110?"#166534":v.polpercAvg>=90?"#22C55E":"#EF4444"}}>Pol {R(v.polpercAvg,0)}%</span>}
                            {v.twsAvg==null&&v.twaAvg==null&&<span style={{color:"#334155"}}>—</span>}
                          </div>
                          {/* 4) Filename at bottom */}
                          <div style={{fontSize:12,fontWeight:600,color:"#E2E8F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.title}</div>
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
    {id:"library",  icon:"📹", label:"Videos"},
    {id:"photos",   icon:"📷", label:"Photos"},
    {id:"analytics",icon:"📊", label:"Analytics"},
    {id:"upload",   icon:"⬆", label:"Upload"},
    {id:"squashshots",icon:"🎯",label:"Squash"},
    {id:"sailscan", icon:"⛵", label:"SailScan"},
    {id:"admin",    icon:"⚙",  label:"Admin"},
  ].filter(t => {
    if (t.id === "sailscan" && props.canSeeSailScanTab === false) return false;
    if (t.id === "squashshots" && props.canSeeSquashShotsTab === false) return false;
    if (t.id === "admin" && props.effectiveRole !== 'admin') return false;
    return true;
  });
  return(
    <div className="ssa-mobile" style={{display:"flex",flexDirection:"column",
      height:"100dvh",background:"#030F1A",color:"#E2E8F0",
      fontFamily:"'Segoe UI',system-ui,sans-serif",overflow:"hidden"}}>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      {/* Right padding reserves ~60px for the fixed UserPill avatar that
          floats at top-right (position:fixed, z-index:9999). Without it
          the Sync button sits underneath the avatar and can't be tapped. */}
      <header style={{background:"#050E1C",borderBottom:"1px solid #1E3A5A",
        padding:"0 62px 0 14px",height:48,display:"flex",alignItems:"center",
        gap:8,flexShrink:0,position:"relative",zIndex:50}}>
        <span style={{fontSize:14,fontWeight:700,color:"#E2E8F0"}}>Shared</span>
        <span style={{fontSize:14,fontWeight:700,color:"#06B6D4"}}>Sailing</span>
        <div style={{flex:1}}/>
        {/* Connection dot */}
        <div style={{display:"flex",alignItems:"center",gap:4,fontSize:11}}>
          <div style={{width:6,height:6,borderRadius:"50%",
            background:props.cloudStatus?.available?"#1D9E75":props.cloudStatus===null?"#334155":"#F59E0B"}}/>
          <span style={{color:"#475569"}}>{props.cloudStatus?.available?"Cloud":"Local"}</span>
        </div>
        {/* ── Cloud sync / refresh button ─────────────────────────────────── */}
        {/* Clearly labelled, tappable 36px target. Always visible when cloud */}
        {/* is available — pulls fresh session data (thumbnails) and pushes   */}
        {/* any unsynced local data. Shows a spinner while running.           */}
        <button onClick={()=>props.onMobileSync?.()}
          disabled={!props.cloudStatus?.available||props.mobileSyncState?.phase==="pulling"||props.mobileSyncState?.phase==="pushing"}
          aria-label="Sync with cloud"
          style={{background:props.unsyncedCount>0?"#F59E0B":"#06B6D420",
            border:`1px solid ${props.unsyncedCount>0?"#F59E0B":"#06B6D4"}`,
            borderRadius:8,padding:"6px 10px",
            color:props.unsyncedCount>0?"#000":"#06B6D4",
            fontSize:12,fontWeight:700,cursor:"pointer",
            display:"flex",alignItems:"center",gap:5,minHeight:32,
            opacity:props.cloudStatus?.available?1:0.4}}>
          <span style={{fontSize:13,display:"inline-block",
            transform:(props.mobileSyncState?.phase==="pulling"||props.mobileSyncState?.phase==="pushing")?"rotate(360deg)":"none",
            animation:(props.mobileSyncState?.phase==="pulling"||props.mobileSyncState?.phase==="pushing")?"ssa-spin 1s linear infinite":"none"}}>
            {props.mobileSyncState?.phase==="done"?"✓":props.mobileSyncState?.phase==="error"?"⚠":"⟳"}
          </span>
          <span>{props.unsyncedCount>0?`Sync (${props.unsyncedCount})`:"Sync"}</span>
        </button>
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
            <AnalyticsTab logData={props.logData} xmlData={props.xmlData}
              allVideos={props.allVideos} sessions={props.sessions}
              selectedVideo={props.selectedVideo} onSelectVideo={props.setSelectedVideo}
              setActiveTab={setActiveTab} activeDate={props.activeDate}
              onSelectDate={props.onSelectDate}
              playUtc={props.playUtc} visible={activeTab==="analytics"} photos={props.photos}
              canUseAI={props.canUseAI} canSeeAnalyticsData={props.canSeeAnalyticsData}/>
          </div>
        )}

        {/* Photos */}
        {activeTab==="photos"&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",zIndex:2}}>
            <PhotosTab role={props.role} logData={props.logData} xmlData={props.xmlData}
              activeDate={props.activeDate} sessions={props.sessions} loadDate={props.loadDate}
              cloudStatus={props.cloudStatus} onPhotosChange={props.setPhotos}/>
          </div>
        )}
        {activeTab==="upload"&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",zIndex:2}}>
            <UploadTab role={props.role} cloudStatus={props.cloudStatus} onImported={props.handleImported}/>
          </div>
        )}
        {activeTab==="squashshots"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <SquashShotsApp/>
          </div>
        )}
        {activeTab==="sailscan"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <SailScanTab/>
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
  const[activeTab,setActiveTab]=useState("library");
  const[allVideos,setAllVideos]=useState([]);
  const[logData,setLogData]=useState(null);
  const[sessionTzOffset,setSessionTzOffset]=useState(DEFAULT_TZ);
  const[sessionTagList,setSessionTagList]=useState([]);
  const[xmlData,setXmlData]=useState(null);
  const[selectedVideo,setSelectedVideo]=useState(null);
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
  const[sessions,setSessions]=useState([]);
  const[activeDate,setActiveDate]=useState(TODAY());
  const[cloudStatus,setCloudStatus]=useState(null);
  const[unsyncedCount,setUnsyncedCount]=useState(0);
  const[aiQuery,setAiQuery]=useState("");
  const[aiResult,setAiResult]=useState(null);
  const[aiLoading,setAiLoading]=useState(false);
  // Effective auth role — either 'admin' (from users.global_role) or the
  // active membership's role. Used to gate UI features. Null until the
  // identity check resolves.
  const[effectiveRole,setEffectiveRole]=useState(null);
  const[loaded,setLoaded]=useState(false);
  const[playUtc,setPlayUtc]=useState(null);
  const[photos,setPhotos]=useState([]);
  const[hasMountedAnalytics,setHasMountedAnalytics]=useState(false);
  const playUtcThrottle=useRef(0);
  const[libSyncProgress,setLibSyncProgress]=useState(null);
  const[libSyncPhase,setLibSyncPhase]=useState(null);
  const libSyncAbortRef=useRef(false);
  const libSyncTimerRef=useRef(null);
  // Mobile-specific sync state — phase: null | "pulling" | "pushing" | "done" | "error"
  const[mobileSyncState,setMobileSyncState]=useState({phase:null,message:"",progress:0});

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
  const handleBatchDelete=useCallback(async()=>{
    if(!batchSelected.size)return;
    const ids=[...batchSelected];
    for(const id of ids){try{await deleteVideo(id);}catch{}}
    setAllVideos(p=>p.filter(v=>!batchSelected.has(v.id)));
    if(selectedVideo&&batchSelected.has(selectedVideo.id))setSelectedVideo(null);
    clearBatch();
  },[batchSelected,selectedVideo,clearBatch]);
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
  useEffect(()=>{ setPlayUtc(selectedVideo?.startUtc||null); },[selectedVideo?.id]);

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
        const {data:{user}}=await supabase.auth.getUser();
        if(!user||cancelled) return;
        const {data:profile}=await supabase.from('users').select('global_role').eq('id',user.id).maybeSingle();
        if(cancelled) return;
        if(profile?.global_role==='admin'){ setEffectiveRole('admin'); return; }
        const m=getActiveMembership(user.id);
        setEffectiveRole(m?.role||null);
      } catch { /* non-fatal */ }
    }
    resolve();
    const onChange=()=>resolve();
    window.addEventListener('ssa:active-membership-changed',onChange);
    return ()=>{ cancelled=true; window.removeEventListener('ssa:active-membership-changed',onChange); };
  },[]);

  // Role-gated convenience flags. Default to permissive while role
  // resolves so UI doesn't briefly hide things from admins.
  // tl1: no SailScan, no analytics data (map OK), no SailScan-tagged photos.
  // guest: no SailScan, no SquashShots, no analytics data, no SailScan
  //   photos, only the latest session day shown.
  // consultant: full access — already gated by valid_from/valid_to via RLS.
  const canSeeSailScanTab     = !['tl1','guest'].includes(effectiveRole);
  const canSeeSquashShotsTab  = effectiveRole !== 'guest';
  const canSeeAnalyticsData   = !['tl1','guest'].includes(effectiveRole);
  const canSeeSailScanPhotos  = !['tl1','guest'].includes(effectiveRole);
  const canUseAI              = effectiveRole === null || !['tl1','consultant','guest'].includes(effectiveRole);
  const showOnlyLatestDay     = effectiveRole === 'guest';
  // Kept for backwards-compat with mobile shell prop; analytics tab is now
  // visible to every role (the content inside is what's gated).
  const canSeeAnalytics = true;

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

  useEffect(()=>{
    async function boot(){
      const today=TODAY();
      const localSessions=getSessions().sort((a,b)=>b.date.localeCompare(a.date));setSessions(localSessions);

      // ── Mobile progressive load ───────────────────────────────────────────
      // On mobile we only fetch full video blobs + log data for the latest session.
      // Older sessions show thumbnail/metadata only — full data loads on-demand.
      const latestDate=localSessions[0]?.date||today;
      const isRecent=(date)=>date===today||date===latestDate;

      const vids=await getAllVideos();
      // On mobile: skip expensive enrichVideo (requires full log read) for old sessions
      const enriched=await Promise.all(vids.map(async v=>{
        const d=v.sessionDate||today;
        if(isMobile && !isRecent(d)) return v; // mobile: skip log read for old clips
        const log=await getLogData(d);
        const xml=await getXmlData(d);
        return enrichVideo(v,log,xml);
      }));
      setAllVideos(enriched);
      if(enriched.length>0)setSelectedVideo(enriched[0]);

      const latestLog=await getLogData(latestDate);
      const latestXml=await getXmlData(latestDate);
      if(latestLog){setLogData({...latestLog,source:"local"});setSessionTzOffset(latestLog.tzOffset??DEFAULT_TZ);}
      if(latestXml)setXmlData({...latestXml,source:"local"});
      setActiveDate(latestDate);
      // Load tag list — cloud-backed when there's an active membership,
      // localStorage fallback otherwise.
      try {
        const supabase=getBrowserSupabase();
        const {data:{user}}=await supabase.auth.getUser();
        if(user) setSessionTagList(await cloudFetchTagList({userId:user.id,date:latestDate}));
        else setSessionTagList(getTagList(latestDate));
      } catch { setSessionTagList(getTagList(latestDate)); }
      const latestSession=localSessions.find(s=>s.date===latestDate);
      if(latestSession?.tzOffset!=null)setSessionTzOffset(latestSession.tzOffset);
      setUnsyncedCount(getUnsyncedCount());setLoaded(true);

      // Cloud check — on mobile defer until after paint
      const doCloud=async()=>{
        const cs=await checkCloudStatus();setCloudStatus(cs);
        // Bunny R2 session listing is GLOBAL (every date in the zone,
        // every team). Only admins can see it; everyone else relies on
        // Supabase below for the team-scoped view.
        if(cs?.available && effectiveRole==='admin'){
          const remote=await listR2Sessions();
          const localDates=new Set(localSessions.map(s=>s.date));
          const newR=remote.filter(s=>!localDates.has(s.date));
          if(newR.length>0)setSessions(p=>[...p,...newR].sort((a,b)=>b.date.localeCompare(a.date)));
        }
        // Supabase sessions list (active membership scope) — merge into UI.
        try {
          const supabase=getBrowserSupabase();
          const {data:{user}}=await supabase.auth.getUser();
          if(user){
            const cloudSessions=await listSessionsCloud({userId:user.id});
            if(cloudSessions.length>0){
              setSessions(p=>{
                const merged=[...p];
                for(const s of cloudSessions){
                  const existing=merged.find(m=>m.date===s.date);
                  if(existing){
                    // Fill in the cloud video count if the local entry lacks one.
                    if(!existing.videoCount && s.video_count) existing.videoCount=s.video_count;
                  }else{
                    merged.push({date:s.date, source:'supabase', videoCount:s.video_count||0});
                  }
                }
                return merged.sort((a,b)=>b.date.localeCompare(a.date));
              });
              // ── #4 fix: if the user has no local data on the date we
              // booted into (typical TL1 mobile-first scenario — fresh
              // device, empty IDB), jump them to the newest cloud session
              // so the library shows videos + thumbnails immediately
              // instead of an empty "no sessions" state.
              //
              // Use `latestDate` (the date boot() actually set active) —
              // the `activeDate` state var is a stale closure here,
              // frozen at TODAY() from the initial render.
              const localVidsForActive = (await getAllVideos()).filter(v => v.sessionDate === latestDate);
              if (localVidsForActive.length === 0) {
                const newestCloudDate = cloudSessions
                  .map(s => s.date)
                  .sort()
                  .reverse()[0];
                if (newestCloudDate && newestCloudDate !== latestDate) {
                  await loadDate(newestCloudDate);
                }
              }
            }
          }
        } catch { /* non-fatal */ }
      };
      if(isMobile) setTimeout(doCloud,1500); else doCloud();
    }
    boot();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  async function loadDate(date){
    setActiveDate(date);
    // Reset video thumbnail load tracking for the new date
    setVideoThumbsLoading(true);
    setVideoLoadedIds(new Set());
    setVideoTotalThumbs(0);

    // ── Load log + xml (local first, then Supabase, then Bunny R2) ──────────
    let log = await getLogData(date);
    let xml = await getXmlData(date);

    // If neither local has it, try Supabase (active membership scope).
    if(!log || !xml){
      try {
        const supabase=getBrowserSupabase();
        const {data:{user}}=await supabase.auth.getUser();
        if(user){
          const cs=await getSessionCloud({userId:user.id,date});
          if(cs){
            if(!log && cs.log_data) log={...cs.log_data, source:'supabase'};
            if(!xml && cs.xml_data) xml={...cs.xml_data, source:'supabase'};
          }
        }
      } catch { /* non-fatal */ }
    }

    if(log){setLogData({...log,source:log.source||"local"});setSessionTzOffset(log.tzOffset??DEFAULT_TZ);}
    // Bunny R2 fallback is GLOBAL (not team-scoped). Only admins can use
    // it; everyone else must stay inside their team's RLS-protected data.
    else if(cloudStatus?.available && effectiveRole==='admin'){const r2=await fetchCloudSession(date);log=r2?.logData||null;setLogData(log?{...log,source:"cloud"}:null);}
    else setLogData(null);

    try {
      const supabase=getBrowserSupabase();
      const {data:{user}}=await supabase.auth.getUser();
      if(user) setSessionTagList(await cloudFetchTagList({userId:user.id,date}));
      else setSessionTagList(getTagList(date));
    } catch { setSessionTagList(getTagList(date)); }

    if(xml){setXmlData({...xml,source:xml.source||"local"});}
    else if(cloudStatus?.available && effectiveRole==='admin'){const r2=await fetchCloudSession(date);xml=r2?.xmlData||null;setXmlData(xml?{...xml,source:"cloud"}:null);}
    else setXmlData(null);

    // ── Load videos ─────────────────────────────────────────────────────────
    let vids=await getVideosForDate(date);
    if(!vids.length){const all=await getAllVideos();vids=all.filter(v=>v.sessionDate===date);}
    // Supabase first when active membership; merge into result so locals
    // and cloud-only videos coexist (deduped by streamId / id).
    try {
      const supabase=getBrowserSupabase();
      const {data:{user}}=await supabase.auth.getUser();
      if(user){
        const cloudVids=await listVideosCloud({userId:user.id,date});
        if(cloudVids.length){
          const seen=new Set(vids.map(v=>v.streamId).filter(Boolean));
          for(const cv of cloudVids){
            if(cv.bunny_stream_id && seen.has(cv.bunny_stream_id)) continue;
            vids.push(toLegacyVideoShape(cv));
          }
        }
      }
    } catch { /* non-fatal */ }

    // Resolve playback URLs for any cloud video that doesn't already have
    // a local objectUrl. Two-tier preference:
    //   1. If the row has a Phase-B proxy/original rendition, ask
    //      /api/videos/[id]/url for a signed Bunny Storage URL. Cheap, MP4,
    //      no HLS parsing needed.
    //   2. Otherwise (legacy Stream-only row), fall back to the existing
    //      /api/stream/status path that returns an HLS playlist URL.
    // Either way, the player gets a single objectUrl to load.
    const needsResolve=vids.filter(v=>!v.objectUrl && (v.streamId || v.hasProxy || v.hasOriginal));
    if(needsResolve.length){
      await Promise.all(needsResolve.map(async v=>{
        // Phase B path — preferred when available.
        if(v.hasProxy || v.hasOriginal){
          try{
            const res=await fetch(`/api/videos/${encodeURIComponent(v.id)}/url?prefer=auto`);
            if(res.ok){
              const j=await res.json();
              if(j?.url){
                v.objectUrl=j.url;
                v.servedRendition=j.served||null; // 'proxy' | 'original' | 'legacy'
                return;
              }
            }
          } catch { /* fall through to Stream */ }
        }
        // Legacy Stream path.
        if(v.streamId){
          try{
            const res=await fetch(`/api/stream/status/${v.streamId}`);
            if(!res.ok) return;
            const s=await res.json();
            v.objectUrl=s.playbackUrl||null;
            if(!v.thumbnailUrl) v.thumbnailUrl=s.thumbnailUrl||null;
          } catch { /* ignore */ }
        }
      }));
    }
    if(!vids.length&&cloudStatus?.available&&effectiveRole==='admin'){const r2=await fetchCloudSession(date);if(r2?.videos?.length)vids=r2.videos;}

    // Enrich with BOTH log AND xml — uses the resolved values above (local or cloud)
    const enriched=vids.map(v=>enrichVideo(v,log,xml,syncOffsets));
    setAllVideos(enriched);
    // Count videos that will actually render a thumb/preview source
    setVideoTotalThumbs(enriched.filter(v => v.thumbnailUrl || (v.objectUrl && v.source!=="cloud")).length);
    setVideoThumbsLoading(false);
    setSelectedVideo(vids[0]||null);
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
          if (!user) { autoSyncRef.current.done = idx; continue; }

          // Source blob from IDB. If it's missing (e.g. mobile-skipped
          // storage on a small device) the user has no way to re-upload
          // from here; flag and move on.
          const blob = await getVideoBlob(item.videoId);
          if (!blob) {
            console.warn('[autoSync] no local blob for', item.videoId);
            autoSyncRef.current.done = idx; continue;
          }

          // Find the in-memory video record for ensureCloudVideoId to work
          // out title/duration/etc.
          const localVid = (await getAllVideos()).find(v => v.id === item.videoId)
                          || { id: item.videoId, sessionDate: item.sessionDate };

          const cloudId = await ensureCloudVideoId({
            userId: user.id,
            video: localVid,
            sessionDate: item.sessionDate,
          });
          if (!cloudId) {
            console.warn('[autoSync] no cloud row for', item.videoId);
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
            ? {...v, hasProxy: true, proxyUploadedAt: new Date().toISOString()}
            : v));
        } catch (e) {
          console.error('[autoSync] failed for', item.videoId, e);
        }
        autoSyncRef.current.done = idx;
      }
    } finally {
      autoSyncRef.current.running = false;
      // Show a brief done state, then clear.
      const finalCount = autoSyncRef.current.done;
      setMobileSyncState({ phase: 'done', message: `✓ Synced ${finalCount} clip${finalCount===1?'':'s'}`, progress: 100 });
      autoSyncRef.current.done = 0;
      autoSyncRef.current.total = 0;
      syncClearTimerRef.current = setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 3000);
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
      .map(v => ({ videoId: v.id, sessionDate, label: v.title || v.name || v.id }));
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
            originalsSyncRef.current.done = idx; continue;
          }

          const localVid = (await getAllVideos()).find(v => v.id === item.videoId)
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

          const res = await syncOriginalForVideo({
            videoId: cloudId,
            sessionDate: item.sessionDate,
            source: blob,
            onProgress: ({ pct }) => {
              setMobileSyncState({
                phase: 'pushing',
                message: `Uploading HD ${idx}/${total} · ${label}`,
                progress: Math.round((pct || 0) * 100),
              });
            },
          });
          if (res.ok) {
            setAllVideos(p => p.map(v => v.id === item.videoId
              ? { ...v, hasOriginal: true, originalPath: res.originalPath }
              : v));
          } else {
            console.warn('[originals] upload failed for', item.videoId, res.error);
          }
        } catch (e) {
          console.error('[originals] failed for', item.videoId, e);
        }
        originalsSyncRef.current.done = idx;
      }
    } finally {
      originalsSyncRef.current.running = false;
      const finalCount = originalsSyncRef.current.done;
      setMobileSyncState({ phase: 'done', message: `✓ Uploaded ${finalCount} original${finalCount===1?'':'s'}`, progress: 100 });
      originalsSyncRef.current.done = 0;
      originalsSyncRef.current.total = 0;
      syncClearTimerRef.current = setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 3500);
    }
  }

  // Batch "Sync proxies" — coach/admin button. Transcodes + uploads every
  // un-proxied clip in the session. Proxies ONLY — the full-resolution
  // originals are a separate, deliberate action (handleBatchUploadOriginals)
  // so a slow link is never hit with a multi-GB upload by surprise.
  async function handleBatchSyncProxies(){
    if (!cloudStatus?.available) return;
    const toSync = allVideos.filter(v => !v.hasProxy);
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
    const toUpload = allVideos.filter(v => !v.hasOriginal);
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
        sessionDate,
        label: v.title || v.name || v.id,
      }));
    if (!items.length) return;
    autoSyncRef.current.queue.push(...items);
    autoSyncRef.current.total += items.length;
    processAutoSyncQueue();
  }

  async function handleImported({date,videos,logData:ld,xmlData:xd}){
    if(ld)setLogData({...ld,source:"local"});if(xd)setXmlData({...xd,source:"local"});
    setSessions(getSessions());setUnsyncedCount(getUnsyncedCount());
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
      enqueueAutoSync(videos, date);
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
  async function handleMobileCloudSync(){
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
                }else{
                  merged.push({date:s.date,source:'supabase',videoCount:s.video_count||0});
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

      // PUSH phase — only if user has permission + unsynced local
      const uc=getUnsyncedCount();
      if(uc>0 && perms.canSync){
        setMobileSyncState({phase:"pushing",message:`Uploading ${uc} unsynced…`,progress:75});
        const logD=await getLogData(activeDate);
        const xmlD=await getXmlData(activeDate);
        const vids=await getVideosForDate(activeDate);
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
  const displayed=(aiResult?allVideos.filter(v=>aiIds.has(v.id)):allVideos)
    .filter(v=>{const ok=selectedTags.length===0||selectedTags.every(t=>(v.tags||[]).includes(t));const q=searchQuery.toLowerCase();return ok&&(!q||v.title?.toLowerCase().includes(q)||(v.tags||[]).some(t=>t.includes(q)));})
    .sort((a,b)=>sortBy==="tws"?(b.twsAvg||0)-(a.twsAvg||0):sortBy==="twa"?(Math.abs(a.twaAvg||0))-(Math.abs(b.twaAvg||0)):sortBy==="vmg"?(b.vmgAvg||0)-(a.vmgAvg||0):sortBy==="polar"?(b.polpercAvg||0)-(a.polpercAvg||0):(b.addedAt||0)-(a.addedAt||0));

  const allTags=[...new Set(allVideos.flatMap(v=>v.tags||[]))].sort();
  const isManTag=t=>["tack","gybe","topmark","mark","race-start","upwind","reach","downwind"].includes(t);
  const toggleTag=t=>setSelectedTags(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t]);
  const tabStyle=tab=>({padding:"6px 15px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,border:"none",background:activeTab===tab?"#06B6D4":"transparent",color:activeTab===tab?"#000":"#64748B"});

  if(!loaded)return<div style={{minHeight:"100vh",background:"#030F1A",display:"flex",alignItems:"center",justifyContent:"center",color:"#334155",fontSize:13}}>Loading Shared Sailing Analytics…</div>;

  // ── Mobile render ────────────────────────────────────────────────────────────
  if(isMobile) return(
    <MobileShell
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
      cloudStatus={cloudStatus} unsyncedCount={unsyncedCount}
      searchQuery={searchQuery} setSearchQuery={setSearchQuery}
      sortBy={sortBy} setSortBy={setSortBy}
      selectedTags={selectedTags} setSelectedTags={setSelectedTags}
      allTags={allTags} isManTag={isManTag} toggleTag={toggleTag}
      displayed={displayed}
      loadDate={loadDate} onSelectDate={loadDate} handleImported={handleImported}
      handlePlayUtc={handlePlayUtc} playUtc={playUtc}
      canSeeAnalytics={canSeeAnalytics} canUseAI={canUseAI}
      canSeeSailScanTab={canSeeSailScanTab} canSeeSquashShotsTab={canSeeSquashShotsTab}
      canSeeAnalyticsData={canSeeAnalyticsData} canSeeSailScanPhotos={canSeeSailScanPhotos}
      showOnlyLatestDay={showOnlyLatestDay} effectiveRole={effectiveRole}
      hasMountedAnalytics={hasMountedAnalytics}
      updateVideoTagsFn={updateVideoTags}
      computeAutoTagsFn={computeAutoTags}
      photos={photos} setPhotos={setPhotos}
      onMobileSync={handleMobileCloudSync}
      mobileSyncState={mobileSyncState}
      setMobileSyncState={setMobileSyncState}
      onThumbLoad={markVideoThumbLoaded}
      videoThumbsLoading={videoThumbsLoading}
      videoLoadedIds={videoLoadedIds}
      videoTotalThumbs={videoTotalThumbs}
    />
  );

  return(
    <div style={{minHeight:"100vh",background:"#030F1A",color:"#E2E8F0",fontFamily:"'Segoe UI',system-ui,sans-serif",display:"flex",flexDirection:"column"}}>
      <header style={{background:"#050E1C",borderBottom:"1px solid #1E3A5A",padding:"0 18px",display:"flex",alignItems:"center",height:52,gap:14,position:"sticky",top:0,zIndex:100,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:15,fontWeight:700,color:"#E2E8F0"}}>Shared</span><span style={{fontSize:15,fontWeight:700,color:"#06B6D4"}}>Sailing Analytics</span></div>
        <nav style={{display:"flex",gap:2,marginLeft:10}}>
          {["library","photos","analytics","upload","squashshots","sailscan","admin"].filter(tab => {
            if (tab === "sailscan" && !canSeeSailScanTab) return false;
            if (tab === "squashshots" && !canSeeSquashShotsTab) return false;
            if (tab === "admin" && effectiveRole !== 'admin') return false;
            return true;
          }).map(tab=>(<button key={tab} style={tabStyle(tab)} onClick={()=>setActiveTab(tab)}>{tab==="upload"&&unsyncedCount>0?<span>{tab}<span style={{background:"#F59E0B",color:"#000",borderRadius:8,padding:"0 4px",fontSize:9,fontWeight:800,marginLeft:3}}>{unsyncedCount}</span></span>:tab==="squashshots"?"Squash":tab==="sailscan"?"SailScan":tab.charAt(0).toUpperCase()+tab.slice(1)}</button>))}
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
              {visibleSessions.map(s=>{
                const isLocal=!s.source||s.source==="local";const isActive=activeDate===s.date;
                return(<div key={s.date} onClick={()=>loadDate(s.date)} style={{padding:"5px 6px",borderRadius:5,cursor:"pointer",marginBottom:2,background:isActive?"#1E3A5A":"transparent",border:`1px solid ${isActive?"#06B6D430":"transparent"}`}}>
                  <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}><span style={{fontSize:11,color:isActive?"#06B6D4":"#64748B",fontFamily:"monospace"}}>{s.date===TODAY()?"Today":fmtDate(s.date)}</span><SrcBadge source={isLocal?"local":"cloud"}/></div>
                  <div style={{fontSize:9,color:"#1E3A5A"}}>{s.videoCount||0}v{s.hasLog?" ·log":""}{s.hasXml?" ·ev":""}{s.location?` · ${s.location}`:""}</div>
                </div>);
              })}
            </div>
            <div style={{height:1,background:"#0F2030",margin:"4px 11px 6px"}}/>
            <div style={{padding:"0 11px 8px"}}>
              <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search clips…" style={{width:"100%",background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 8px",color:"#E2E8F0",fontSize:11,outline:"none",boxSizing:"border-box",marginBottom:7}}/>
              {["date","tws","twa","vmg","polar"].map(s=><button key={s} onClick={()=>setSortBy(s)} style={{display:"block",width:"100%",textAlign:"left",background:sortBy===s?"#1E3A5A":"none",border:"none",borderRadius:4,padding:"3px 6px",color:sortBy===s?"#06B6D4":"#334155",cursor:"pointer",fontSize:10,marginBottom:1}}>{sortBy===s?"▸ ":"  "}{s==="date"?"Date":s==="tws"?"Wind (TWS)":s==="twa"?"Wind angle":s==="vmg"?"VMG":"Polar %"}</button>)}
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
                      const autoTagPatterns=/^(tws-|upwind|reach|downwind|tack|gybe|topmark|mark|race-start|race|training|\d+x-)/;
                      const manualTags=(v.tags||[]).filter(t=>{if(autoTagPatterns.test(t))return false;const meta=xmlData?.meta;if(meta?.location&&t===meta.location.toLowerCase().replace(/\s+/g,"-"))return false;if(meta?.boat&&t===meta.boat.toLowerCase().replace(/\s+/g,"-"))return false;if(meta?.dayType&&t===meta.dayType.toLowerCase().replace(/\s+/g,"-"))return false;return true;});
                      const merged=[...new Set([...newTags,...manualTags])];
                      await updateVideoTags(v.id,merged);count++;return{...v,tags:merged};
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
                />
              )}
              {allVideos.length===0&&<div style={{textAlign:"center",padding:"50px 20px",color:"#1E3A5A"}}><div style={{fontSize:32,marginBottom:14,opacity:0.4}}>📹</div><div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:6}}>No videos for this session</div><div style={{fontSize:11,marginBottom:16}}>{perms.canImport?"Import in the Upload tab.":"Session not yet uploaded to cloud."}</div>{perms.canImport&&<button onClick={()=>setActiveTab("upload")} style={{background:"#06B6D4",border:"none",borderRadius:8,padding:"8px 20px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>Go to Upload</button>}</div>}
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
                        <button onClick={()=>{if(confirm(`Delete ${batchSelected.size} video${batchSelected.size>1?"s":""}? This cannot be undone.`))handleBatchDelete();}}
                          style={{marginLeft:"auto",background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"5px 14px",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700}}>
                          🗑 Delete {batchSelected.size}
                        </button>
                      )}
                    </>
                  )}
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
                      {vids.map(v=><VideoCard key={v.id} video={v} selected={selectedVideo?.id===v.id} onClick={()=>setSelectedVideo(v)} onThumbLoad={markVideoThumbLoaded} batchMode={batchMode} batchSelected={batchSelected} onBatchToggle={toggleBatchSelect}/>)}
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
                              const autoTagPatterns = /^(tws-|upwind|reach|downwind|tack|gybe|topmark|mark|race-start|race|training|\d+x-)/;
                              const manualTags = (cur.tags||[]).filter(t => !autoTagPatterns.test(t));
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
                />
                <div style={{marginTop:12}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:2}}>
                    <div style={{fontSize:13,fontWeight:600,color:"#E2E8F0",flex:1,marginRight:8}}>{selectedVideo.title}</div>
                    <SrcBadge source={selectedVideo.source||"local"}/>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
                    <div style={{fontSize:10,color:"#334155"}}>{fmtDate(selectedVideo.sessionDate)} · {selectedVideo.camera}{selectedVideo.duration?` · ${fmtT(selectedVideo.duration)}`:""}</div>
                    {selectedVideo.tsSource&&(<span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:selectedVideo.tsSource==="mp4-meta"?"#1D9E7515":"#F59E0B15",border:`1px solid ${selectedVideo.tsSource==="mp4-meta"?"#1D9E7530":"#F59E0B30"}`,color:selectedVideo.tsSource==="mp4-meta"?"#1D9E75":"#F59E0B"}}>{selectedVideo.tsSource==="mp4-meta"?"📷 camera metadata":"⚠ file modified time"}</span>)}
                  </div>
                  {selectedVideo.twsAvg!=null&&(
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:12}}>
                      {[["Avg TWS",selectedVideo.twsAvg,"kt","#7DD3FC"],["Avg TWA",selectedVideo.twaAvg,"°","#7DD3FC"],["Avg VMG",selectedVideo.vmgAvg,"kt","#22C55E"],["Polar %",selectedVideo.polpercAvg,"%",selectedVideo.polpercAvg==null?"#22C55E":selectedVideo.polpercAvg>=110?"#166534":selectedVideo.polpercAvg>=90?"#22C55E":"#EF4444"],["Target %",selectedVideo.vsTargPercAvg,"%",selectedVideo.vsTargPercAvg==null?"#22C55E":selectedVideo.vsTargPercAvg>=110?"#166534":selectedVideo.vsTargPercAvg>=90?"#22C55E":"#EF4444"],["Avg BSP",selectedVideo.bspAvg,"kt","#10B981"]].map(([l,val,u,c])=>(<div key={l} style={{background:"#071624",borderRadius:6,padding:"8px 10px",border:`1px solid ${c}15`}}><div style={{fontSize:9,color:"#334155",letterSpacing:1,marginBottom:2}}>{l}</div><div style={{fontSize:17,fontWeight:700,color:c,fontFamily:"monospace"}}>{val!=null?R(val):"--"}<span style={{fontSize:10,marginLeft:2}}>{u}</span></div></div>))}
                    </div>
                  )}
                  <div style={{marginBottom:12}}><SyncControl offset={syncOffsets[selectedVideo.id]||0} onChange={v=>{saveSyncOffset(selectedVideo.id,v);setSyncOffsets(p=>({...p,[selectedVideo.id]:v}));}}/></div>
                  <div style={{marginBottom:12}}>
                    <StartTimeEditor video={selectedVideo} logData={logData} sessionTzOffset={sessionTzOffset} onSave={async(id,startUtc)=>{
                      await updateVideoStartUtc(id,startUtc);
                      const updatedVideo={...selectedVideo,startUtc};
                      const autoTags=computeAutoTags(startUtc,selectedVideo.duration,logData,xmlData,syncOffsets[id]||0);
                      const autoTags2=new Set(computeAutoTags(startUtc,selectedVideo.duration,logData,xmlData,syncOffsets[id]||0));const manualTags=(selectedVideo.tags||[]).filter(t=>!autoTags2.has(t));
                      const mergedTags=[...new Set([...autoTags,...manualTags])];
                      await updateVideoTags(id,mergedTags);
                      const enriched=enrichVideo({...updatedVideo,tags:mergedTags},logData,xmlData,syncOffsets);
                      setAllVideos(p=>p.map(v=>v.id===id?enriched:v));
                      setSelectedVideo(enriched);
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
                      onSynced={(id, {proxyPath, proxyBytes}) => {
                        const patch = { hasProxy: true, proxyPath, proxyUploadedAt: new Date().toISOString() };
                        if (typeof proxyBytes === 'number') patch.proxyBytes = proxyBytes;
                        setAllVideos(p => p.map(v => v.id === id ? {...v, ...patch} : v));
                        setSelectedVideo(p => p && p.id === id ? {...p, ...patch} : p);
                      }}
                    />
                  )}
                  {perms.canImport&&<TagEditor video={selectedVideo} tagList={sessionTagList} sessionDate={activeDate} onTagListChange={async updated=>{
                    setSessionTagList(updated);
                    try {
                      const supabase=getBrowserSupabase();
                      const {data:{user}}=await supabase.auth.getUser();
                      if(user) await saveTagListCloud({userId:user.id,date:activeDate,tags:updated});
                      else saveTagList(activeDate,updated);
                    } catch { saveTagList(activeDate,updated); }
                  }} onSave={(id,tags)=>{setAllVideos(p=>p.map(v=>v.id===id?{...v,tags}:v));if(selectedVideo.id===id)setSelectedVideo(p=>({...p,tags}));}}/>}
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
            <AnalyticsTab
              logData={logData} xmlData={xmlData} allVideos={allVideos}
              sessions={sessions} selectedVideo={selectedVideo}
              onSelectVideo={setSelectedVideo} setActiveTab={setActiveTab}
              activeDate={activeDate}
              onSelectDate={loadDate}
              playUtc={playUtc}
              visible={activeTab==="analytics"} photos={photos}
              canUseAI={canUseAI} canSeeAnalyticsData={canSeeAnalyticsData}
            />
          </div>
        )}

        {/* ── UPLOAD & ADMIN — standard conditional render ─────────────────── */}
        {activeTab==="photos"&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",zIndex:2}}>
            <PhotosTab role={role} logData={logData} xmlData={xmlData} activeDate={activeDate} sessions={visibleSessions} loadDate={loadDate} cloudStatus={cloudStatus} onPhotosChange={setPhotos} canSeeSailScanPhotos={canSeeSailScanPhotos}/>
          </div>
        )}
        {activeTab==="upload"&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",zIndex:2}}>
            <UploadTab role={role} cloudStatus={cloudStatus} onImported={handleImported}/>
          </div>
        )}
        {activeTab==="squashshots"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <SquashShotsApp/>
          </div>
        )}
        {activeTab==="sailscan"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <SailScanTab/>
          </div>
        )}
        {activeTab==="admin"&&(
          <div style={{position:"absolute",inset:0,overflowY:"auto",padding:20,zIndex:2}}>
            <div style={{fontSize:15,fontWeight:600,color:"#E2E8F0",marginBottom:18}}>Admin</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
              {[
                {title:"Data tiers",items:["Tier 1 · Local: IndexedDB (videos + logs + events)","Tier 2 · Cloud: Bunny Storage (JSON) + Bunny Stream (HLS)","Today = always local  ·  Older = local → cloud fallback",`Unsynced items: ${unsyncedCount}`]},
                {title:"Cloud status (Bunny.net)",items:[`Storage: ${cloudStatus?.storage?"Connected ✓":"Not configured"}`,`Stream: ${cloudStatus?.stream?"Connected ✓":"Not configured"}`,`Zone: ${cloudStatus?.zone||"—"} · Region: ${cloudStatus?.region||"de"}`,"Env vars: BUNNY_STORAGE_API_KEY, BUNNY_STORAGE_ZONE, BUNNY_STORAGE_REGION, BUNNY_STREAM_API_KEY, BUNNY_STREAM_LIBRARY_ID, BUNNY_CDN_HOSTNAME"]},
                {title:"Roles (testing — NextAuth in Phase 2)",items:["Admin/Coach → local import + cloud sync + older sessions","Crew → local import today + cloud older (read-only)","Viewer/Consultant → cloud only, no import","Switch roles with the header dropdown"]},
                {title:"Sessions",items:sessions.length>0?sessions.map(s=>`${s.date===TODAY()?"Today":fmtDate(s.date)} · ${s.source||"local"} · ${s.videoCount||0}v${s.hasLog?" + log":""}${s.hasXml?" + events":""}${s.location?` · ${s.location}`:""}`):[" No sessions yet — import in Upload tab"]},
              ].map(c=>(<div key={c.title} style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:14}}><div style={{fontSize:11,fontWeight:600,color:"#64748B",marginBottom:8}}>{c.title}</div>{c.items.map((item,i)=><div key={i} style={{fontSize:10,color:"#334155",padding:"3px 0",borderBottom:"1px solid #0F2030"}}>{item}</div>)}</div>))}
            </div>

            {/* ── Storage management ───────────────────────────────────────── */}
            <div style={{background:"#0A1929",border:"1px solid #EF444430",borderRadius:10,padding:14}}>
              <div style={{fontSize:11,fontWeight:600,color:"#EF4444",marginBottom:8}}>Storage management</div>
              <div style={{fontSize:10,color:"#475569",marginBottom:12}}>
                Use these tools if sessions show wrong dates (e.g. year 3925) or stale data after a parser fix.
                Videos in IndexedDB are NOT affected — only the session index and log/event metadata.
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={()=>{
                  if(!confirm("Remove sessions with obviously wrong dates (year < 2000 or > 2100) from the index? Video blobs are untouched."))return;
                  const all=JSON.parse(localStorage.getItem("ssa:sessions")||"[]");
                  const valid=all.filter(s=>{const y=parseInt((s.date||"").slice(0,4));return y>=2000&&y<=2100;});
                  const removed=all.length-valid.length;
                  localStorage.setItem("ssa:sessions",JSON.stringify(valid));
                  setSessions(valid);
                  alert(`Removed ${removed} bad session(s). Reload the page then re-import your log files.`);
                }} style={{background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"7px 14px",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:600}}>
                  🗑 Remove bad-date sessions
                </button>
                <button onClick={()=>{
                  if(!confirm("Clear ALL local session metadata (log/event data)? Video blobs are untouched. You will need to re-import CSV and XML files."))return;
                  // Remove all ssa:* keys except ssa:polar and ssa:syncOffsets
                  const keep=new Set(["ssa:polar","ssa:syncOffsets"]);
                  Object.keys(localStorage).filter(k=>k.startsWith("ssa:")&&!keep.has(k)).forEach(k=>localStorage.removeItem(k));
                  // Clear IDB log_data and xml_data (but not videos)
                  const req=indexedDB.open("ssa-db");
                  req.onsuccess=e=>{
                    const db=e.target.result;
                    ["log_data","xml_data"].forEach(store=>{
                      if(db.objectStoreNames.contains(store)){
                        db.transaction(store,"readwrite").objectStore(store).clear();
                      }
                    });
                  };
                  setSessions([]);setLogData(null);setXmlData(null);
                  alert("Session metadata cleared. Reload the page then re-import your files.");
                }} style={{background:"#EF444410",border:"1px solid #EF444430",borderRadius:6,padding:"7px 14px",color:"#EF4444",cursor:"pointer",fontSize:11}}>
                  🧹 Clear all session metadata
                </button>
                <button onClick={()=>{
                  const lsKeys=Object.keys(localStorage).filter(k=>k.startsWith("ssa:"));
                  const lsSize=lsKeys.reduce((s,k)=>s+(localStorage.getItem(k)||"").length,0);
                  alert(`localStorage: ${lsKeys.length} keys, ~${(lsSize/1024).toFixed(1)} KB\nSessions: ${sessions.length}\nVideos: in IndexedDB (blobs not counted)`);
                }} style={{background:"#0F2030",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 14px",color:"#64748B",cursor:"pointer",fontSize:11}}>
                  📊 Storage info
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SSAApp;
