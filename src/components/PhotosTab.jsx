// src/components/PhotosTab.jsx
// Photos stored as blobs in IndexedDB, metadata in localStorage
//
// Sync architecture (tiered):
//   1) ALL users upload full-resolution + thumbnail to Bunny Storage
//   2) ALL users pull thumbnails for fast browsing
//   3) ALL users can stream (view) via the CDN
//   4) Admin/Coach can optionally download full-res to IDB for offline debrief

import React, { useState, useRef, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { uploadJsonToStorage } from "../lib/bunny";
import { syncPending as syncPendingPhotos, connectionIsGood, clearDayCloud, startAutoFlush, keysForPhoto } from "../lib/photoStore";
import { getWifiOnly, setWifiOnly, connectionLabel } from "../lib/netAware";
import { buildSailResolver } from "../lib/sailResolve";
import { useUiNext } from "../lib/ui-flags";
import PhotosNext from "./photos/PhotosNext";
import PhotoCanvas from "./photos/PhotoCanvas";
import { writeKey, SESSION_LEAVES } from "../lib/storageKeys";
import { currentStorageScope } from "../lib/storageScope";
import { renderOverlay } from "../lib/photoOverlay";
import { drawSailTrimAnnotation, isAnnotation, annotationHeadline } from "../lib/sailTrimOverlay";
import { venueTodayIso as TODAY } from "../lib/localStore";   // venue-local, not UTC

// The digitiser is a big component with its own CDN libraries, and most visits
// to the Photos tab never open it — so it arrives as its own chunk, on demand.
const SailTrimTab = dynamic(() => import("./sailtrim/SailTrimTab"), {
  ssr: false,
  loading: () => <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"#7DD3FC",fontSize:13}}>Loading the digitiser…</div>,
});

/** The sail-geometry payload on a photo, or null. Tolerates the string form. */
function sailTrimOf(photo){
  const raw = photo?.sailtrim_data;
  if(!raw) return null;
  let parsed;
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { return null; }
  if(!parsed || !isAnnotation(parsed.annotation)) return null;
  return parsed;
}

const DB_NAME = "ssa-db";
const R = (n, d=1) => (n==null||isNaN(n))?"--":Number(n).toFixed(d);

// Keys for cloud layout
// Keys come from photoStore, which owns the layout and the team+boat scoping
// (src/lib/storageKeys.ts). This file used to carry a second copy, with a comment
// on the other one asking that they be kept in step by hand.

// Full-res originals are served via the binary proxy.
// Thumbs are tiny so we fetch through the same route.
const cloudImageUrl = key => `/api/bunny/image?key=${encodeURIComponent(key)}`;

// Generate a thumbnail from a blob using canvas. Keeps aspect ratio.
async function generateThumbnail(blob, maxSize=480, quality=0.78) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxSize / Math.max(w, h));
      const tw = Math.max(1, Math.round(w*scale));
      const th = Math.max(1, Math.round(h*scale));
      const c = document.createElement("canvas");
      c.width = tw; c.height = th;
      c.getContext("2d").drawImage(img, 0, 0, tw, th);
      c.toBlob(b => {
        URL.revokeObjectURL(url);
        b ? resolve(b) : reject(new Error("thumb encode failed"));
      }, "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("thumb load failed")); };
    img.src = url;
  });
}

// ── IndexedDB helpers for photos ─────────────────────────────────────────────
// Cache the connection — opening a fresh IndexedDB handle per photo made loading
// a folder with many photos slow (N opens). One shared handle for the session.
let _photoDbPromise = null;
function openDb() {
  if (_photoDbPromise) return _photoDbPromise;
  _photoDbPromise = new Promise((resolve,reject)=>{
        // Opened WITHOUT a version on purpose. localStore.js owns this database's schema
    // and opens it at DB_VER; hardcoding a number here means that the day DB_VER is
    // bumped, every open() left behind on the old number throws
    // "The requested version (N) is less than the existing version (N+1)" and the
    // feature dies silently. That is exactly what commit 333255e did on 17 Sep 2026:
    // it took DB_VER to 5 for the phases store and left four call sites on 4, which
    // broke photo import, SailScan and SquashShots. A versionless open attaches to
    // whatever version exists; the upgrade handler below still runs if the database
    // does not exist yet, and localStore creates anything it misses.
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains("videos")){
        const s=db.createObjectStore("videos",{keyPath:"id"});
        s.createIndex("sessionDate","sessionDate",{unique:false});
        s.createIndex("addedAt","addedAt",{unique:false});
        s.createIndex("synced","syncedToDb",{unique:false});
      }
      if(!db.objectStoreNames.contains("log_data")) db.createObjectStore("log_data",{keyPath:"date"});
      if(!db.objectStoreNames.contains("xml_data")) db.createObjectStore("xml_data",{keyPath:"date"});
      if(!db.objectStoreNames.contains("photos"))   db.createObjectStore("photos",{keyPath:"id"});
    };
    req.onsuccess = e=>resolve(e.target.result);
    req.onerror   = e=>{ _photoDbPromise=null; reject(e.target.error); };
  });
  return _photoDbPromise;
}

async function idbPutPhoto(id, blob) {
  const db = await openDb();
  return new Promise((res,rej)=>{
    const tx  = db.transaction("photos","readwrite");
    const req = tx.objectStore("photos").put({id, blob});
    req.onsuccess = ()=>res();
    req.onerror   = ()=>rej(req.error);
  });
}

async function idbGetPhoto(id) {
  const db = await openDb();
  return new Promise((res,rej)=>{
    const tx  = db.transaction("photos","readonly");
    const req = tx.objectStore("photos").get(id);
    req.onsuccess = ()=>res(req.result?.blob||null);
    req.onerror   = ()=>rej(req.error);
  });
}

async function idbDeletePhoto(id) {
  const db = await openDb();
  return new Promise((res,rej)=>{
    const tx  = db.transaction("photos","readwrite");
    const req = tx.objectStore("photos").delete(id);
    req.onsuccess = ()=>res();
    req.onerror   = ()=>rej(req.error);
  });
}


// ── EXIF parser ───────────────────────────────────────────────────────────────

// Load exifr from CDN for robust EXIF extraction (JPEG, HEIC, TIFF)


function nearestLogRow(rows,utc,maxMs=300000){
  if(!rows?.length||!utc)return null;
  let lo=0,hi=rows.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].utc<utc)lo=mid+1;else hi=mid;}
  if(lo>0&&Math.abs(rows[lo-1].utc-utc)<Math.abs(rows[lo].utc-utc))lo--;
  return Math.abs(rows[lo].utc-utc)<maxMs?rows[lo]:null;
}

function activeSailsAt(evts,utc){
  if(!evts?.length||!utc)return[];
  return evts.filter(s=>s.utc<=utc).sort((a,b)=>b.utc-a.utc)[0]?.sails||[];
}

// Derive race-context tags for a single photo UTC from XML events.
// Mirrors the priority logic used by computeAutoTags for videos.
function raceTagsAt(xml,utc){
  if(!xml||!utc)return[];
  const BUFFER_MS=120_000;
  const tags=[];
  for(const m of (xml.markRoundings||[])){
    if(Math.abs(m.utc-utc)<=BUFFER_MS) tags.push(m.isTop?"topmark":"mark");
  }
  for(const g of (xml.raceGuns||[])){
    if(Math.abs(g.utc-utc)<=BUFFER_MS) tags.push("race-start");
  }
  for(const tj of (xml.tackJibes||[])){
    if(tj.isValid===false) continue;
    if(Math.abs(tj.utc-utc)<=BUFFER_MS) tags.push(tj.isTack?"tack":"gybe");
  }
  return [...new Set(tags)];
}

// Log variables the user can ADD to the photo overlay (on top of the fixed
// TWS/TWA/AWA/BSP/Heel/VMG). key = canonical row field carried onto the photo by
// enrichPhoto. Mirrors the video overlay catalog.
const PHOTO_OVERLAY_VARS = [
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

// renderOverlay moved to ../lib/photoOverlay (shared with the timeline lightbox
// so the instrument overlay looks identical there). Imported at the top.

const SAIL_SKIP = /^(main|msail|mainsail|main-)/;
const fmtDate = d=>{if(!d)return"";const p=d.split("-");return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:d;};

// Local-time display helpers — photos are stored as true-UTC epochs (matching the
// video + logfile model) and rendered in the venue/local zone (sessionTzOffset).
const TZ_SHORT = off => off===120?"CEST":off===60?"UTC+1":off===0?"UTC":`UTC${off>=0?"+":""}${off/60}`;
const fmtLocalHM = (u,off=0)=> u?new Date(u+off*60000).toISOString().slice(11,16):"--:--";
const fmtLocalDate = (u,off=0)=> u?new Date(u+off*60000).toISOString().slice(0,10):null;
const fmtLocalDT = (u,off=0)=> u?new Date(u+off*60000).toISOString().slice(0,19).replace("T"," "):null;
const sailTagColor = {bg:"#8B5CF620",bd:"#8B5CF640",c:"#A78BFA"};

// Narrow-viewport hook — matches the same threshold used by MobileShell
function useIsNarrow(breakpoint=768){
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(`(max-width:${breakpoint}px)`).matches
  );
  useEffect(()=>{
    if(typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width:${breakpoint}px)`);
    const onChange = e => setIsNarrow(e.matches);
    mq.addEventListener ? mq.addEventListener("change", onChange) : mq.addListener(onChange);
    return () => {
      mq.removeEventListener ? mq.removeEventListener("change", onChange) : mq.removeListener(onChange);
    };
  },[breakpoint]);
  return isNarrow;
}

function SrcBadge({source}){const m={local:{l:"LOCAL",bg:"#06B6D415",bd:"#06B6D430",c:"#06B6D4"},cloud:{l:"CLOUD",bg:"#8B5CF615",bd:"#8B5CF630",c:"#8B5CF6"},processing:{l:"PROC",bg:"#F59E0B15",bd:"#F59E0B30",c:"#F59E0B"}};const s=m[source]||m.local;return<span style={{fontSize:9,padding:"1px 5px",borderRadius:3,letterSpacing:1,fontWeight:600,background:s.bg,border:`1px solid ${s.bd}`,color:s.c}}>{s.l}</span>;}

// Race-tag colour scheme — must match VideoCard.tagColor in SmartSailingAnalytics_UI.jsx
const RACE_EVENT_TAGS = ["race-start","topmark","mark"];
const RACE_POS_TAGS   = ["upwind","reach","downwind"];
const RACE_MANO_TAGS  = ["tack","gybe"];
const raceTagColor = t => {
  if(RACE_EVENT_TAGS.includes(t)) return{bg:"#EF444420",bd:"#EF444440",c:"#EF4444"};
  if(RACE_POS_TAGS.includes(t))   return{bg:"#06B6D420",bd:"#06B6D440",c:"#06B6D4"};
  if(RACE_MANO_TAGS.includes(t))  return{bg:"#1D9E7520",bd:"#1D9E7540",c:"#1D9E75"};
  return                               {bg:"#1E3A5A",  bd:"#2D4A6A",  c:"#7DD3FC"};
};

function PhotoCard({photo,selected,onClick,onThumbLoad,batchMode,batchSelected,onBatchToggle,tzOffset=0}){
  const sails = (photo.sails||[]).filter(s=>!SAIL_SKIP.test(s));
  const race  = photo.raceTags||[];
  const handleLoad = () => onThumbLoad?.(photo.id);
  const handleError = () => onThumbLoad?.(photo.id);
  const isBatchSelected = batchMode && batchSelected?.has(photo.id);
  const handleClick = () => batchMode ? onBatchToggle?.(photo.id) : onClick?.();
  return(
    <div onClick={handleClick} style={{background:isBatchSelected?"#EF444420":selected&&!batchMode?"#0F2A45":"#0A1929",border:`2px solid ${isBatchSelected?"#EF4444":selected&&!batchMode?"#06B6D4":"#1E3A5A"}`,borderRadius:10,overflow:"hidden",cursor:"pointer",transition:"border-color 0.12s"}}>
      <div style={{aspectRatio:"4/3",background:"#071624",position:"relative",overflow:"hidden"}}>
        {/* Instant blurred placeholder (LQIP) shown under the thumbnail until it
            loads — a few hundred bytes stored in the photo's metadata row. */}
        {photo.lqip&&<div style={{position:"absolute",inset:0,backgroundImage:`url(${photo.lqip})`,backgroundSize:"cover",backgroundPosition:"center",filter:"blur(8px)",transform:"scale(1.1)"}}/>}
        {photo.objectUrl
          ?<img src={photo.objectUrl} alt="" loading="lazy" onLoad={handleLoad} onError={handleError} style={{position:"relative",width:"100%",height:"100%",objectFit:"cover"}}/>
          :!photo.lqip&&<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:22}}>📷</div>}
        {/* Source badge top-right */}
        <div style={{position:"absolute",top:3,right:4}}><SrcBadge source={photo.cloudSynced?"cloud":"local"}/></div>
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
        {/* GPS pin */}
        {photo.lat&&photo.lon&&<div style={{position:"absolute",bottom:3,left:4,fontSize:9,color:"#22C55E"}}>📍</div>}
        {/* Time badge bottom-right */}
        <div style={{position:"absolute",bottom:3,right:4,background:"rgba(0,0,0,0.8)",borderRadius:2,padding:"0 3px",fontSize:8,color:"#8A97A9",fontFamily:"monospace"}}>{photo.utc?fmtLocalHM(photo.utc,tzOffset)+" "+TZ_SHORT(tzOffset):"--:--"}</div>
      </div>
      <div style={{padding:"6px 9px"}}>
        {/* 1) Race tags */}
        {race.length>0&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:3}}>
            {race.map(t=>{const{bg,bd,c}=raceTagColor(t);return(<span key={t} style={{background:bg,border:`1px solid ${bd}`,color:c,fontSize:8,borderRadius:3,padding:"0 4px",fontFamily:"monospace"}}>{t}</span>);})}
          </div>
        )}
        {/* 2) Sail tags */}
        {sails.length>0&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:3}}>
            {sails.map(t=>(<span key={t} style={{background:sailTagColor.bg,border:`1px solid ${sailTagColor.bd}`,color:sailTagColor.c,fontSize:8,borderRadius:3,padding:"0 4px",fontFamily:"monospace"}}>{t}</span>))}
          </div>
        )}
        {/* 3) TWS & TWA */}
        <div style={{fontSize:9,color:"#7DD3FC",marginBottom:2,fontFamily:"monospace"}}>
          {photo.tws!=null?`TWS ${R(photo.tws)}kn`:""}{photo.tws!=null&&photo.twa!=null?" · ":""}{photo.twa!=null?`TWA ${R(photo.twa,0)}°`:""}
          {photo.tws==null&&photo.twa==null&&<span style={{color:"#4E5D71"}}>—</span>}
        </div>
        {/* 4) Filename at bottom */}
        <div style={{fontSize:10,fontWeight:600,color:"#E2E8F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{photo.name||"Photo"}</div>
      </div>
    </div>
  );
}

// Exported for its own test: it is the whole right-hand pane, it composes the
// canvas, and a throw in here takes the Photos tab with it.
export function PhotoDetail({photo,onDelete,onUpload,uploading,canSync,canDelete,onDownloadOriginal,downloadingOriginal,onClose,tzOffset=0,onEditTime,onMeasureGeometry,onToggleGeometryOverlay}){
  const [rendered,setRendered]=useState(false);
  const [editTime,setEditTime]=useState(false);
  const [timeVal,setTimeVal]=useState('');
  const [extraGauges,setExtraGauges]=useState([]); // session-only overlay vars
  // The values the overlay burns into the canvas, as one string. See the effect's
  // dep list below.
  const overlaySig=[photo.tws,photo.twa,photo.awa,photo.bsp,photo.heel,photo.vmg,
    photo.keelAng,photo.location,photo.boat,photo.mast_var_manual_setting,
    photo.mast_var_manual_chins,photo.mast_var_manual_rake,photo.mast_var_manual_butt,
    photo.mast_var_manual_v1,photo.mast_var_manual_d1,photo.mast_var_manual_d2,
    (photo.sails||[]).join(','),
    // The user-chosen extra gauges are read as photo[k], so their VALUES belong in
    // the signature too — otherwise adding a gauge redraws but changing its value
    // does not.
    extraGauges.map(k=>photo[k]).join(',')].join('|');
  // The sail-geometry lines are burned into the same composite, so a new
  // measurement or a flick of the overlay switch has to reach the compose effect
  // exactly as an instrument change does.
  const geom = sailTrimOf(photo);
  const geomSig = geom ? `${geom.overlay?1:0}|${geom.annotation.measuredAt}|${geom.annotation.targets.length}` : '';
  // ── compose once, at full resolution ──────────────────────────────────────
  // The composite — photograph plus burned-in overlay, at the image's OWN size
  // — is what gets exported and what PhotoCanvas looks at. Held in state, not a
  // ref, so that re-composing actually reaches the viewport.
  const composeRef=useRef(null);
  const haveFull=useRef(false);
  const [compose,setCompose]=useState(null);
  const [composed,setComposed]=useState(null);
  const [fullLoaded,setFullLoaded]=useState(false);
  const [fullMissing,setFullMissing]=useState(false);
  const [fullSlow,setFullSlow]=useState(false);
  const [retryFull,setRetryFull]=useState(0);
  const slowTimer=useRef(null);

  useEffect(()=>{
    const thumb=photo?.objectUrl, full=photo?.fullUrl;
    if(!thumb&&!full){setRendered(false);setCompose(null);setComposed(null);return;}
    let dead=false;
    haveFull.current=false; setFullLoaded(false); setFullMissing(false); setFullSlow(false);
    if(slowTimer.current) clearTimeout(slowTimer.current);
    const extra=extraGauges.map(k=>{const o=PHOTO_OVERLAY_VARS.find(x=>x.key===k);if(!o)return null;const v=photo[k];
      return {l:o.label,v:v!=null?(o.unit==='°'?R(v,o.dec)+'°':R(v,o.dec)+(o.unit?' '+o.unit:'')):'--',c:'#A78BFA'};}).filter(Boolean);
    const inst={tws:photo.tws,twa:photo.twa,awa:photo.awa,bsp:photo.bsp,heel:photo.heel,vmg:photo.vmg,keelAng:photo.keelAng,sails:photo.sails,location:photo.location,boat:photo.boat,mast_var_manual_setting:photo.mast_var_manual_setting,mast_var_manual_chins:photo.mast_var_manual_chins,mast_var_manual_rake:photo.mast_var_manual_rake,mast_var_manual_butt:photo.mast_var_manual_butt,mast_var_manual_v1:photo.mast_var_manual_v1,mast_var_manual_d1:photo.mast_var_manual_d1,mast_var_manual_d2:photo.mast_var_manual_d2,extra};
    const draw=(img,isFull)=>{
      // The thumbnail is only a placeholder. If the original has already
      // landed, a late-arriving thumb must not paint over it.
      if(dead||(!isFull&&haveFull.current))return;
      if(isFull)haveFull.current=true;
      const c=composeRef.current||(composeRef.current=document.createElement('canvas'));
      renderOverlay(c,img,inst);
      // Sail geometry on top: the measured lines are about the picture itself, so
      // they belong under the gauge boxes in importance but over the photograph.
      // renderOverlay has just sized the canvas to the image, which is the frame
      // the annotation's points are in — modulo resolution, which it scales for.
      if(geom?.overlay){
        const gctx=c.getContext('2d');
        if(gctx) drawSailTrimAnnotation(gctx, geom.annotation);
      }
      setCompose(c); setComposed({w:c.width,h:c.height}); setRendered(true);
      if(isFull){setFullLoaded(true);setFullSlow(false);if(slowTimer.current)clearTimeout(slowTimer.current);}
    };
    const load=(url,isFull)=>{
      if(!url)return;
      const i=new Image(); i.crossOrigin="anonymous";
      i.onload=()=>draw(i,isFull);
      // The browser import uploads the original only once the connection is
      // good enough (photoStore.goodForOriginals), so a photo can be in the
      // cloud as a thumbnail and nothing else. Say that, rather than leaving
      // "loading full resolution…" up for ever over a soft picture.
      i.onerror=()=>{ if(isFull&&!dead){ setFullMissing(true); setFullSlow(false); if(slowTimer.current)clearTimeout(slowTimer.current); } };
      i.src=url;
    };
    load(thumb,false);
    if(full&&full!==thumb){
      // A retry gets a fresh URL: a browser that has cached the failure will
      // not go back to the network for the same one.
      load(retryFull?`${full}${full.includes('?')?'&':'?'}retry=${retryFull}`:full,true);
      slowTimer.current=setTimeout(()=>{ if(!dead&&!haveFull.current) setFullSlow(true); },12000);
    }
    return ()=>{dead=true; if(slowTimer.current) clearTimeout(slowTimer.current);};
    // Every field the overlay DRAWS, not just three of them. It used to list
    // tws/twa/sails only, so correcting heel — or any mast measurement — redrew
    // nothing and the burned-in overlay kept showing the old value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[photo.id,photo.objectUrl,photo.fullUrl,overlaySig,geomSig,extraGauges,retryFull]);

  const handleExport=()=>{
    if(!composeRef.current)return;
    const a=document.createElement("a");
    a.download=`${photo.name?.replace(/\.[^.]+$/,"")||"photo"}_overlay.jpg`;
    a.href=composeRef.current.toDataURL("image/jpeg",0.92);a.click();
  };
  return(
    <div style={{flex:1,background:"#050E1C",borderLeft:onClose?"none":"1px solid #1E3A5A",overflowY:"auto",padding:onClose?"0 14px 20px":16,width:"100%"}}>
      {/* Mobile: sticky back bar at top */}
      {onClose && (
        <div style={{position:"sticky",top:0,zIndex:5,background:"#050E1C",padding:"10px 0 10px",borderBottom:"1px solid #0F2030",marginBottom:12,display:"flex",alignItems:"center",gap:10}}>
          <button onClick={onClose} aria-label="Back to photos"
            style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:7,padding:"8px 14px",color:"#E2E8F0",fontSize:13,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
            ← Back
          </button>
          <div style={{fontSize:12,color:"#94A3B8",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>
            {photo.name||"Photo"}
          </div>
          <SrcBadge source={photo.cloudSynced?"cloud":"local"}/>
        </div>
      )}
      <PhotoCanvas
        source={compose} sourceSize={composed} resetKey={photo.id}
        fullStatus={(!photo.fullUrl||photo.fullUrl===photo.objectUrl||fullLoaded)?'none'
          :fullMissing?'missing':fullSlow?'slow':'loading'}
        onRetryFull={()=>setRetryFull(n=>n+1)}>
        {photo.utc&&<div style={{position:"absolute",bottom:8,left:10,background:"rgba(0,0,0,0.75)",borderRadius:4,padding:"3px 8px",fontSize:11,fontWeight:700,color:"#E2E8F0",fontFamily:"monospace",letterSpacing:0.5,pointerEvents:"none"}}>{fmtDate(fmtLocalDate(photo.utc,tzOffset))} {fmtLocalHM(photo.utc,tzOffset)} {TZ_SHORT(tzOffset)}</div>}
      </PhotoCanvas>
      {/* Overlay variables — add extra gauges to the photo overlay, this session only. */}
      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:10}}>
        <span style={{fontSize:9,color:"#64748B",letterSpacing:1,textTransform:"uppercase"}}>Overlay +</span>
        {extraGauges.map(k=>{const o=PHOTO_OVERLAY_VARS.find(x=>x.key===k);return(
          <span key={k} style={{display:"inline-flex",alignItems:"center",gap:4,background:"#8B5CF615",border:"1px solid #8B5CF640",borderRadius:4,padding:"1px 4px 1px 7px",fontSize:9,color:"#A78BFA"}}>
            {o?.label||k}
            <button onClick={()=>setExtraGauges(p=>p.filter(x=>x!==k))} style={{background:"none",border:"none",color:"#A78BFA",cursor:"pointer",fontSize:11,lineHeight:1,padding:0}}>×</button>
          </span>);})}
        <select value="" onChange={e=>{const v=e.target.value;if(v)setExtraGauges(p=>p.includes(v)?p:[...p,v]);}}
          style={{background:"#071624",border:"1px solid #1E3A5A",borderRadius:4,padding:"3px 6px",color:"#7DD3FC",fontSize:10,cursor:"pointer"}}>
          <option value="">+ add variable…</option>
          {PHOTO_OVERLAY_VARS.filter(o=>!extraGauges.includes(o.key)).map(o=><option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </div>
      <div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:8,padding:"10px 14px",marginBottom:10}}>
        <div style={{fontSize:9,color:"#64748B",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Instrument data</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
          {[["TWS",photo.tws,"kn","#7DD3FC"],["TWA",photo.twa,"°","#7DD3FC"],["AWA",photo.awa,"°","#7DD3FC"],
            ["BSP",photo.bsp,"kn","#10B981"],["Heel",photo.heel,"°","#F97316"],["VMG",photo.vmg,"kn","#22C55E"]]
            .map(([l,v,u,c])=>(
              <div key={l} style={{background:"#071624",borderRadius:6,padding:"7px 8px",border:`1px solid ${c}15`,textAlign:"center"}}>
                <div style={{fontSize:8,color:"#4E5D71",marginBottom:2}}>{l}</div>
                <div style={{fontSize:14,fontWeight:700,color:v!=null?c:"#334155",fontFamily:"monospace"}}>
                  {v!=null?R(v,l==="TWA"||l==="AWA"||l==="Heel"?0:1):"--"}<span style={{fontSize:8,marginLeft:1}}>{u}</span>
                </div>
              </div>
            ))}
        </div>
        {photo.sails?.length>0&&<div style={{marginTop:8,display:"flex",flexWrap:"wrap",gap:4}}>
          {photo.sails.filter(s=>!SAIL_SKIP.test(s)).map(t=>(<span key={t} style={{background:sailTagColor.bg,border:`1px solid ${sailTagColor.bd}`,color:sailTagColor.c,fontSize:9,borderRadius:3,padding:"1px 6px",fontFamily:"monospace"}}>{t}</span>))}
        </div>}
        {photo.lat&&photo.lon&&<div style={{marginTop:5,fontSize:9,color:"#22C55E"}}>📍 {photo.lat.toFixed(5)}°, {photo.lon.toFixed(5)}°</div>}
        {photo.utc&&!editTime&&(
          <div style={{marginTop:4,fontSize:9,color:"#64748B",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span>🕐 {fmtLocalDT(photo.utc,tzOffset)} {TZ_SHORT(tzOffset)}</span>
            {onEditTime&&<button onClick={()=>{setTimeVal(new Date(photo.utc+tzOffset*60000).toISOString().slice(0,16));setEditTime(true);}}
              style={{background:"none",border:"1px solid #1E3A5A",borderRadius:4,padding:"1px 6px",color:"#7DD3FC",cursor:"pointer",fontSize:9}}>✎ edit time</button>}
          </div>
        )}
        {photo.utc&&editTime&&(
          <div style={{marginTop:6,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            <input type="datetime-local" value={timeVal} onChange={e=>setTimeVal(e.target.value)}
              style={{background:"#071624",border:"1px solid #1E3A5A",borderRadius:4,padding:"3px 6px",color:"#E2E8F0",fontSize:10}}/>
            <span style={{fontSize:9,color:"#8A97A9"}}>{TZ_SHORT(tzOffset)} (venue local)</span>
            <button onClick={()=>{
              if(!timeVal){setEditTime(false);return;}
              const utc=new Date(timeVal+":00Z").getTime()-tzOffset*60000; // venue-local → true UTC
              if(Number.isFinite(utc)) onEditTime(photo,utc);
              setEditTime(false);
            }} style={{background:"#06B6D4",border:"none",borderRadius:4,padding:"3px 10px",color:"#001018",fontWeight:700,cursor:"pointer",fontSize:10}}>Save</button>
            <button onClick={()=>setEditTime(false)} style={{background:"none",border:"1px solid #1E3A5A",borderRadius:4,padding:"3px 8px",color:"#8A97A9",cursor:"pointer",fontSize:10}}>Cancel</button>
          </div>
        )}
      </div>

      {/* SailScan analysis card — appears for photos saved from the SailScan
          tab. Reads the sailscan_data JSON we stash on save and renders the
          per-stripe metrics + inter-stripe twist. */}
      {photo.sailscan_data && (()=>{
        let parsed;
        try { parsed = typeof photo.sailscan_data === "string"
          ? JSON.parse(photo.sailscan_data)
          : photo.sailscan_data; }
        catch { return null; }
        const stripes = parsed?.stripes || [];
        if (!stripes.length) return null;
        const fmt = (v,d=1)=> v==null||isNaN(v) ? "—" : (+v).toFixed(d);
        return (
          <div style={{background:"#0A1929",border:"1px solid #8B5CF640",borderRadius:8,padding:"10px 14px",marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontSize:9,color:"#8B5CF6",letterSpacing:2,textTransform:"uppercase"}}>⛵ SailScan analysis</div>
              {parsed.algorithmVersion && <div style={{fontSize:8,color:"#8A97A9",fontFamily:"monospace"}}>{parsed.algorithmVersion}</div>}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {stripes.map((s,i)=>{
                const m = s.metrics;
                if (!m) return (
                  <div key={i} style={{background:"#071624",borderRadius:6,padding:"6px 10px",border:"1px solid #8B5CF615",fontSize:10,color:"#94A3B8"}}>
                    Stripe {(s.idx??i)+1}: chord only (no curve fit)
                  </div>
                );
                return (
                  <div key={i} style={{background:"#071624",borderRadius:6,padding:"8px 10px",border:"1px solid #8B5CF615"}}>
                    <div style={{fontSize:11,fontWeight:700,color:"#A78BFA",marginBottom:4}}>Stripe {(s.idx??i)+1}</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:4,fontSize:10,fontFamily:"monospace",color:"#94A3B8"}}>
                      <span>camber: <b style={{color:"#E2E8F0"}}>{fmt(m.draftPct,2)}%</b></span>
                      <span>draft: <b style={{color:"#E2E8F0"}}>{fmt(m.draftPositionPct,0)}%</b></span>
                      <span>entry: <b style={{color:"#E2E8F0"}}>{fmt(m.entryAngleDeg,1)}°</b></span>
                      <span>exit: <b style={{color:"#E2E8F0"}}>{fmt(m.exitAngleDeg,1)}°</b></span>
                    </div>
                  </div>
                );
              })}
            </div>
            {parsed.twist?.length>0 && (
              <div style={{marginTop:6,fontSize:10,color:"#94A3B8"}}>
                Inter-stripe twist: <span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{parsed.twist.map(t=>`${(+t.deg).toFixed(1)}°`).join(" / ")}</span>
              </div>
            )}
            {parsed.stripes.some(s=>s.userTaps?.length>0) && (
              <div style={{marginTop:4,fontSize:9,color:"#8A97A9"}}>
                User-anchored stripes: {parsed.stripes.filter(s=>s.userTaps?.length>0).map(s=>s.userTaps.length).join("+")} mid hint{parsed.stripes.reduce((n,s)=>n+(s.userTaps?.length||0),0)===1?"":"s"}
              </div>
            )}
          </div>
        );
      })()}
      {/* ── Sail geometry (SailTrim) ────────────────────────────────────────
          The three astern measurements the speed team draws by hand in Rhino.
          The numbers are shown unsigned: the sign is a direction in the image,
          which nobody says out loud. */}
      {geom && (
        <div style={{background:"#0A1929",border:"1px solid #38BDF840",borderRadius:8,padding:"10px 14px",marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,gap:8}}>
            <div style={{fontSize:9,color:"#38BDF8",letterSpacing:2,textTransform:"uppercase"}}>📐 Sail geometry</div>
            <div style={{fontSize:8,color:"#8A97A9",fontFamily:"monospace"}}>{geom.annotation.version}</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.max(1,Math.min(3,geom.annotation.targets.length))},1fr)`,gap:8}}>
            {geom.annotation.targets.map(t=>(
              <div key={t.key} style={{background:"#071624",borderRadius:6,padding:"7px 8px",border:`1px solid ${t.colour}20`,textAlign:"center"}}>
                <div style={{fontSize:8,color:"#4E5D71",marginBottom:2}}>{t.label.replace(/^Jib /,"").replace(/ @ reference height$/," @ ref")}</div>
                <div style={{fontSize:14,fontWeight:700,color:t.colour,fontFamily:"monospace"}}>
                  {Math.round(Math.abs(t.mm))}<span style={{fontSize:8,marginLeft:1}}>mm</span>
                </div>
                <div style={{fontSize:8,color:"#64748B",fontFamily:"monospace"}}>±{Math.round(t.sigmaMm)}</div>
              </div>
            ))}
          </div>
          <div style={{marginTop:7,fontSize:9,color:"#64748B",lineHeight:1.5}}>
            {geom.annotation.defn==="world"?"World-horizontal":"Athwartships"} from the mast axis ·{" "}
            <span style={{color:geom.annotation.psiMeasured?"#4ADE80":"#FCD34D"}}>
              ψ {geom.annotation.psiDeg.toFixed(2)}° {geom.annotation.psiMeasured?"measured":"assumed"}
            </span>
            {geom.annotation.heelDeg!=null&&<> · heel {geom.annotation.heelDeg.toFixed(1)}°</>}
          </div>
          <div style={{marginTop:8,display:"flex",gap:7,flexWrap:"wrap"}}>
            {onToggleGeometryOverlay&&(
              <button onClick={()=>onToggleGeometryOverlay(photo)}
                style={{background:geom.overlay?"#38BDF820":"none",border:"1px solid #38BDF840",borderRadius:6,padding:"5px 10px",color:"#38BDF8",cursor:"pointer",fontSize:10,fontWeight:600}}>
                {geom.overlay?"✓ lines on the photo":"Draw lines on the photo"}
              </button>
            )}
            {onMeasureGeometry&&(
              <button onClick={()=>onMeasureGeometry(photo)}
                style={{background:"none",border:"1px solid #1E3A5A",borderRadius:6,padding:"5px 10px",color:"#94A3B8",cursor:"pointer",fontSize:10}}>
                Re-measure…
              </button>
            )}
          </div>
        </div>
      )}
      {!geom&&onMeasureGeometry&&(
        <button onClick={()=>onMeasureGeometry(photo)}
          style={{width:"100%",background:"#0A1929",border:"1px solid #38BDF840",borderRadius:8,padding:"10px 0",color:"#38BDF8",fontWeight:700,cursor:"pointer",fontSize:12,marginBottom:10}}>
          📐 Analyse sail geometry
        </button>
      )}

      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button onClick={handleExport} disabled={!rendered} style={{flex:1,background:rendered?"#8B5CF6":"#1E3A5A",border:"none",borderRadius:7,padding:"9px 0",color:rendered?"#fff":"#475569",fontWeight:700,cursor:rendered?"pointer":"default",fontSize:12}}>⬇ Export JPEG</button>
        {!photo.cloudSynced&&<button onClick={onUpload} disabled={uploading} style={{flex:1,background:uploading?"#1E3A5A":"#06B6D4",border:"none",borderRadius:7,padding:"9px 0",color:uploading?"#475569":"#000",fontWeight:700,cursor:uploading?"default":"pointer",fontSize:12}}>{uploading?"Uploading…":"☁ Upload"}</button>}
        {photo.cloudSynced&&<div style={{flex:1,background:"#1D9E7510",border:"1px solid #1D9E7530",borderRadius:7,padding:"9px 0",color:"#1D9E75",fontSize:12,textAlign:"center"}}>✓ In cloud</div>}
        {canDelete!==false&&<button onClick={onDelete} style={{background:"none",border:"1px solid #EF444440",borderRadius:7,padding:"9px 14px",color:"#EF4444",cursor:"pointer",fontSize:12}}>🗑</button>}
      </div>

      {/* Admin/Coach: download full-res original for offline debrief */}
      {photo.cloudSynced && !photo.hasLocalOriginal && canSync && (
        <button onClick={onDownloadOriginal} disabled={downloadingOriginal}
          style={{marginTop:8,width:"100%",background:downloadingOriginal?"#1E3A5A":"#0A1929",border:"1px solid #06B6D440",borderRadius:7,padding:"9px 0",color:downloadingOriginal?"#475569":"#06B6D4",fontWeight:600,cursor:downloadingOriginal?"default":"pointer",fontSize:11}}>
          {downloadingOriginal ? "Downloading full-res…" : "⬇ Download full-res to device (for offline debrief)"}
        </button>
      )}
      {photo.cloudSynced && photo.hasLocalOriginal && (
        <div style={{marginTop:8,textAlign:"center",fontSize:10,color:"#1D9E75"}}>✓ Full-res available offline</div>
      )}
      {photo.cloudSynced && !photo.hasLocalOriginal && !canSync && (
        <div style={{marginTop:8,textAlign:"center",fontSize:10,color:"#64748B"}}>Streaming thumbnail · admin/coach can cache full-res</div>
      )}
    </div>
  );
}

// ── Main PhotosTab ────────────────────────────────────────────────────────────
export default function PhotosTab({role,logData,xmlData,activeDate,sessions=[],loadDate,cloudStatus,onPhotosChange,canSeeSailScanPhotos=true,sessionTzOffset=0,canClearDay=false,sailInventory=[]}){
  const [photos,setPhotos]     = useState([]);   // metadata only — no blobs
  const [selected,setSelected] = useState(null);
  const [uploading,setUploading]= useState(false);
  const [clearingDay,setClearingDay] = useState(false);
  const [downloadingOriginal,setDownloadingOriginal] = useState(false);
  // Batch select / delete — admin + coach only
  const canDelete = role === "admin" || role === "coach";
  const [batchMode,setBatchMode] = useState(false);
  const [batchSelected,setBatchSelected] = useState(()=>new Set());
  const toggleBatchSelect = useCallback(id=>{
    setBatchSelected(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;});
  },[]);
  const clearBatch = useCallback(()=>{setBatchMode(false);setBatchSelected(new Set());},[]);
  const handleBatchDeletePhotos = useCallback(async()=>{
    if(!batchSelected.size)return;
    for(const id of batchSelected){try{await idbDeletePhoto(id);}catch{}}
    const updated=photos.filter(p=>!batchSelected.has(p.id));
    setPhotos(updated);savePhotos(updated);
    if(selected&&batchSelected.has(selected.id))setSelected(updated[0]||null);
    clearBatch();
    // savePhotos is NOT named here, though the rule asks for it: it is a const
    // useCallback declared ~170 lines further down, and a dep array is evaluated
    // during render, in source order — so naming it throws "Cannot access
    // 'savePhotos' before initialization" the first time this component renders.
    // (npm run lint:undef catches exactly this; the same trap is documented on a
    // useMemo in SmartSailingAnalytics_UI.) It writes through to localStorage and
    // takes its argument, so a stale identity cannot give a stale result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[batchSelected,photos,selected,clearBatch]);
  const [log,setLog]           = useState([]);
  const addLog  = msg => setLog(p=>[...p.slice(-20),msg]);

  const canSync = role === "admin" || role === "coach";
  const isNarrow = useIsNarrow(768);
  // Mobile: only show the fullscreen photo detail when user explicitly taps a thumbnail
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  // Auto-close the mobile overlay if we switch sessions / clear selection / resize to desktop
  useEffect(()=>{ if(!isNarrow || !selected) setMobileDetailOpen(false); },[isNarrow, selected, activeDate]);

  // ── Thumbnail load tracking ─────────────────────────────────────────────────
  // "metaLoading" = restoring metadata + IDB blobs (before photos render)
  // "loadedIds"   = Set of photo IDs whose <img> has fired onLoad/onError
  // "totalThumbs" = total photos we expect to render for this date
  const [metaLoading, setMetaLoading] = useState(false);
  const [loadedIds, setLoadedIds] = useState(() => new Set());
  const [totalThumbs, setTotalThumbs] = useState(0);
  const markThumbLoaded = useCallback((id) => {
    setLoadedIds(prev => {
      if(prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const LS_KEY = `ssa:photos-meta:${activeDate}`;

  // Bumped when SailScan / SquashShots save a new photo so the load-effect
  // below re-runs without requiring a page reload. Filter to saves on the
  // currently-viewed date so an unrelated save doesn't churn the list.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const savedTimerRef = useRef(null);
  useEffect(()=>{
    const onSaved = (e) => {
      const d = e?.detail?.date;
      if(d && d !== activeDate) return;
      // Debounce: a burst of saves (importing many photos) → ONE reload, not N.
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(()=> setRefreshNonce(n => n + 1), 600);
    };
    window.addEventListener('ssa:photo-saved', onSaved);
    return ()=>{ clearTimeout(savedTimerRef.current); window.removeEventListener('ssa:photo-saved', onSaved); };
  },[activeDate]);

  // Merge a photo with the day's log/event data (instruments, sails, race tags).
  // Declared BEFORE the load effect and handleEditPhotoTime so those can list it
  // in their dependency arrays without hitting a temporal-dead-zone ReferenceError.
  // Resolve event-file sail names → canonical SSA inventory names (via aliases).
  const sailResolver = React.useMemo(()=>buildSailResolver(sailInventory),[sailInventory]);
  const enrichPhoto = useCallback((photo,log,xml)=>{
    const e={...photo};
    let matched=false;
    if(log?.rows?.length&&photo.utc){
      const row=nearestLogRow(log.rows,photo.utc);
      if(row){
        matched=true;
        e.tws=row.tws;e.twa=row.twa;e.awa=row.awa;e.bsp=row.bsp;e.heel=row.heel;e.vmg=row.vmg;
        // Carry the remaining overlay-able fields so the "add variable" picker has data.
        for(const o of PHOTO_OVERLAY_VARS){ if(row[o.key]!=null) e[o.key]=row[o.key]; }
      }
    }
    // Fall back to the instrument snapshot baked into `analysis` at import/mirror
    // time when the live log didn't match (e.g. log not loaded, cloud-only photo,
    // or timestamp just outside the match window) — so the overlay still shows
    // data, like a video's baked twsAvg does.
    const inst=photo.analysis?.inst;
    if(!matched&&inst){
      if(e.tws==null)e.tws=inst.tws??null; if(e.twa==null)e.twa=inst.twa??null;
      if(e.awa==null)e.awa=inst.awa??null; if(e.bsp==null)e.bsp=inst.bsp??null;
      if(e.heel==null)e.heel=inst.heel??null; if(e.vmg==null)e.vmg=inst.vmg??null;
    }
    if(xml){
      const sails=activeSailsAt(xml.sailsUpEvents,photo.utc);
      const race=raceTagsAt(xml,photo.utc);
      // Prefer live tags; keep baked ones if the live lookup found nothing.
      e.sails=sails.length?sails:(e.sails||photo.analysis?.sails||[]);
      e.raceTags=race.length?race:(e.raceTags||photo.analysis?.raceTags||[]);
      e.boat=xml.meta?.boat||e.boat||null;e.location=xml.meta?.location||e.location||null;
    }
    // Relabel event-file sail names to the SSA inventory name where linked.
    if(Array.isArray(e.sails)&&e.sails.length) e.sails=e.sails.map(s=>sailResolver.resolve(s));
    // Re-bundle what we just resolved into `analysis`, the shape that travels.
    // This used to set only the flat fields above, which are what THIS device
    // draws its overlay from — so a photo looked fully tagged here while the
    // Supabase row kept whatever it was imported with. Everything that is not
    // this component reads analysis_data: the Timeline (DayMedia, DayTimeline)
    // and every other device. A photo imported on a laptop without that day's
    // log in IndexedDB therefore showed instruments to the person who imported
    // it and to nobody else, permanently.
    // Only rebuilt when the live lookup actually learned something, so a day
    // whose log is not loaded cannot blank an analysis baked in at import.
    if(matched||xml){
      e.analysis={
        // Anything else already in `analysis` is kept. This rebuild used to be a
        // wholesale replacement, which would silently delete the SailTrim
        // annotation the moment the day's log loaded and re-enriched the photo —
        // and the deletion would then be pushed to the cloud row as an update.
        ...(photo.analysis||{}),
        sails:e.sails||[], raceTags:e.raceTags||[], boat:e.boat||null, location:e.location||null,
        inst:{ tws:e.tws??null, twa:e.twa??null, awa:e.awa??null, bsp:e.bsp??null, heel:e.heel??null, vmg:e.vmg??null },
      };
    }
    return e;
  },[sailResolver]);

  // Load metadata from localStorage, blobs from IDB, fill in cloud thumb URLs
  useEffect(()=>{
    if(!activeDate)return;
    // Reset load-tracking for the new date
    setMetaLoading(true);
    setLoadedIds(new Set());
    setTotalThumbs(0);
    let meta = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
    let cancelled = false;
    // ONE unified load: local photos + team-shared cloud photos for this date,
    // merged → display URLs resolved → ALL enriched with the day's log/event
    // data → committed once. Previously cloud-only photos (everything a viewer
    // who didn't upload, e.g. a TL3, sees) were added raw and never enriched,
    // and the empty-local Promise.all cleared state + never selected one — so
    // the folder showed unenriched photos with nothing opened. This fixes both.
    (async ()=>{
      // 1) Cloud (team-shared) photos for this date. Dedupe against local by the
      //    stable Bunny original path.
      let cloudOnly = [];
      try {
        const { getBrowserSupabase } = await import('../lib/supabase/browser');
        const { listPhotosCloud, toLegacyPhotoShape } = await import('../lib/cloud-photos');
        const { data:{ user } } = await getBrowserSupabase().auth.getUser();
        if (user) {
          const cps = await listPhotosCloud({ userId: user.id, date: activeDate });
          const stableKey = (p) => p.bunnyPath || p.url || null;
          const localKeys = new Set(meta.map(stableKey).filter(Boolean));
          for (const cp of cps) {
            const shape = toLegacyPhotoShape(cp);
            const k = shape.bunnyPath || null;
            if (k && localKeys.has(k)) continue;
            cloudOnly.push({ ...shape, name: 'Photo', cloudSynced: true, hasLocalOriginal: false });
          }
        }
      } catch { /* cloud optional */ }
      if (cancelled) return;
      // 2) Resolve display URLs. Only LOCALLY-owned photos have a blob in IndexedDB;
      //    cloud-shared photos (all a TL3 sees) never do, so skip the IDB lookup for
      //    them entirely — that per-photo open was what made the folder slow.
      const localIds = new Set(meta.map(m=>m.id));
      const combined = [...meta, ...cloudOnly];
      const restored = await Promise.all(combined.map(async p=>{
        const blob = localIds.has(p.id) ? await idbGetPhoto(p.id).catch(()=>null) : null;
        const hasLocalOriginal = !!blob;
        const keys = keysForPhoto(p, activeDate);
        const objectUrl = blob
          ? URL.createObjectURL(blob)
          : (p.thumbnailUrl || (p.cloudSynced ? cloudImageUrl(keys.thumb) : null));
        // The GRID wants the thumb — it is painting a 94 px box and there are
        // hundreds of them. The DETAIL view wants the original, which has been
        // sitting in Bunny since import: `day-media-upload` puts the camera's
        // own bytes there untouched. Until now the detail view drew the 480 px
        // thumb for everyone who had not imported the photo themselves, which
        // is everyone but one person — hence "too grainy to be of any use",
        // and an overlay export that was 480 px wide as well.
        const fullUrl = blob
          ? URL.createObjectURL(blob)
          : (p.cloudSynced ? cloudImageUrl(keys.original) : null);
        return { ...p, objectUrl, fullUrl, hasLocalOriginal };
      }));
      if (cancelled) return;
      // 3) Enrich ALL photos (local + shared) with the day's log/event data, then
      //    commit once and open the most recent one.
      const willEnrich = !!(logData || xmlData);
      const enriched = (willEnrich ? restored.map(p=>enrichPhoto(p, logData, xmlData)) : restored)
        .sort((a,b)=>(b.utc||0)-(a.utc||0));
      setPhotos(enriched);
      setTotalThumbs(enriched.filter(p => p.objectUrl).length);
      setMetaLoading(false);
      if(enriched.length>0) setSelected(prev => prev || enriched[0]);
      // Persist only locally-owned photos to localStorage (not team-shared rows).
      if(willEnrich && meta.length) savePhotos(enriched.filter(p => !p.cloudSynced || p.hasLocalOriginal));
    })();
    return ()=>{ cancelled = true; };
  // logData/xmlData intentionally in deps so photos re-enrich when data arrives.
  // refreshNonce in deps lets ssa:photo-saved trigger a reload of the date.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[activeDate, logData, xmlData, refreshNonce]);

  // Mirror the Videos tab: when the Photos tab opens on a day with no photos
  // (e.g. today has none yet), jump to the most recent day that DOES have
  // photos. One-shot per mount (autoDayRef) so it never fights later manual
  // day navigation.
  const autoDayRef = useRef(false);
  useEffect(()=>{
    if(autoDayRef.current) return;
    if(!sessions?.length) return;
    const withPhotos = sessions.filter(s=>(s.photoCount||0)>0 && s.date<=TODAY());
    if(!withPhotos.length) return; // nothing to jump to yet — wait for sessions
    const activeHasPhotos = activeDate && withPhotos.some(s=>s.date===activeDate);
    if(!activeHasPhotos){
      const latest = withPhotos.map(s=>s.date).sort().slice(-1)[0];
      if(latest && latest!==activeDate){ autoDayRef.current=true; loadDate?.(latest); return; }
    }
    autoDayRef.current=true; // active day already has photos → settled
  },[sessions, activeDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const savePhotos = useCallback((updated)=>{
    // Save metadata to localStorage (no blobs)
    const meta = updated.map(({objectUrl,...p})=>p);
    try{ localStorage.setItem(LS_KEY, JSON.stringify(meta)); }
    catch(e){ console.error("savePhotos localStorage:", e); }
    // (flush effect declared below handles deferred originals)
    onPhotosChange?.(updated);
  },[LS_KEY,onPhotosChange]);

  // Edit a photo's capture time (like the video start-time editor). The photo's
  // day (folder) is derived from photo.utc, so changing it re-buckets the photo;
  // we re-enrich with the log/event data at the new instant and persist the new
  // taken_utc + session date to the cloud row so teammates see the move too.
  const handleEditPhotoTime = useCallback(async (photo, newUtc)=>{
    if(!photo || !Number.isFinite(newUtc)) return;
    const updated = enrichPhoto({...photo, utc:newUtc}, logData, xmlData);
    setPhotos(prev=>{
      const next = prev.map(p=>p.id===photo.id?updated:p).sort((a,b)=>(b.utc||0)-(a.utc||0));
      savePhotos(next);
      return next;
    });
    setSelected(s=> (s && s.id===photo.id) ? updated : s);
    // Update the team-shared DB row (same bunny path → route UPDATEs it, and
    // re-points its session to the new day).
    try {
      const { getBrowserSupabase } = await import('../lib/supabase/browser');
      const { upsertPhotoCloud } = await import('../lib/cloud-photos');
      const { data:{ user } } = await getBrowserSupabase().auth.getUser();
      if(user && (photo.bunnyPath || photo.url)){
        await upsertPhotoCloud({
          userId: user.id,
          sessionDate: fmtLocalDate(newUtc, sessionTzOffset),
          takenUtc: newUtc,
          exif: photo.exif ?? null,
          thumbnailUrl: photo.thumbnailUrl ?? null,
          bunnyStoragePath: photo.bunnyPath || photo.url,
          bytes: photo.size ?? null,
          analysis: photo.analysis ?? photo.sailscan_data ?? null,
        });
      }
    } catch { /* non-fatal — local edit still applied */ }
  },[enrichPhoto,logData,xmlData,savePhotos,sessionTzOffset]);

  // Deferred-original flush: photos imported in the Upload tab on cellular get
  // their thumbnail up immediately but the full original waits. When this tab
  // mounts on a good (WiFi) connection, push any still-pending originals.
  useEffect(()=>{
    if(!cloudStatus?.available) return;
    if(!connectionIsGood()) return;
    let cancelled=false;
    (async()=>{
      try{ const r=await syncPendingPhotos({}); if(!cancelled && (r.originals||r.thumbs)) setRefreshNonce(n=>n+1); }catch{}
    })();
    return ()=>{ cancelled=true; };
  },[activeDate, cloudStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-flush deferred originals when the link improves (Wi-Fi returns / back
  // online). Also the iOS fallback for the missing Background Sync API.
  useEffect(()=>{
    if(!cloudStatus?.available) return;
    const stop = startAutoFlush({ onLog: addLog });
    return stop;
  },[cloudStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wi-Fi-only-for-originals preference (persisted; honoured by the sync gate).
  const [wifiOnly, setWifiOnlyState] = useState(()=>{ try { return getWifiOnly(); } catch { return false; } });
  const toggleWifiOnly = ()=>{ const v=!wifiOnly; setWifiOnly(v); setWifiOnlyState(v); if(!v) syncPendingPhotos({}).then(r=>{ if(r.originals) setRefreshNonce(n=>n+1); }).catch(()=>{}); };



  // Re-enrich is handled by the loading effect above (logData/xmlData are in its deps).
  // A separate effect would race with the async loading effect and cause stale-state bugs.

  // ── Upload a single photo (full-res + thumb + meta) ─────────────────────────
  // Returns updated photo metadata on success, null on failure.
  const uploadPhotoToCloud = useCallback(async (photo) => {
    if(!cloudStatus?.available) throw new Error("Cloud not available");
    const blob = await idbGetPhoto(photo.id);
    if(!blob) throw new Error("No local blob");
    const keys = keysForPhoto(photo, activeDate);
    const {accessKey,zone,host} = await fetch("/api/storage/credentials").then(r=>r.json());

    // 1) Generate and upload thumbnail
    let thumbBlob;
    try { thumbBlob = await generateThumbnail(blob, 480, 0.78); }
    catch(e){ throw new Error(`thumb: ${e.message}`); }
    const thumbRes = await fetch(`${host}/${zone}/${keys.thumb}`, {
      method: "PUT",
      headers: { AccessKey: accessKey, "Content-Type": "image/jpeg" },
      body: thumbBlob,
    });
    if(!thumbRes.ok && thumbRes.status !== 201) throw new Error(`thumb HTTP ${thumbRes.status}`);

    // 2) Upload full-resolution original
    const imgRes = await fetch(`${host}/${zone}/${keys.original}`, {
      method: "PUT",
      headers: { AccessKey: accessKey, "Content-Type": "image/jpeg" },
      body: blob,
    });
    if(!imgRes.ok && imgRes.status !== 201) throw new Error(`img HTTP ${imgRes.status}`);

    // 3) Upload per-photo metadata JSON
    const {objectUrl, hasLocalOriginal, ...meta} = photo;
    const metaPayload = {...meta, cloudSynced: true, originalSize: blob.size, thumbSize: thumbBlob.size};
    await uploadJsonToStorage(keys.meta, metaPayload);

    // 4) Write the TEAM-scoped DB row so EVERY member sees this photo (not just
    //    the uploader). The gallery loads from this `photos` table via
    //    listPhotosCloud; without this insert the table stays empty and the
    //    photo is visible only on the uploader's own device.
    try {
      const { getBrowserSupabase } = await import('../lib/supabase/browser');
      const { upsertPhotoCloud } = await import('../lib/cloud-photos');
      const { data:{ user } } = await getBrowserSupabase().auth.getUser();
      if (user) {
        await upsertPhotoCloud({
          userId: user.id,
          sessionDate: photo.sessionDate || activeDate,
          takenUtc: photo.utc ?? null,
          exif: photo.exif ?? null,
          thumbnailUrl: cloudImageUrl(keys.thumb),
          bunnyStoragePath: keys.original,
          bytes: blob.size,
          analysis: photo.sailscan_data ?? photo.analysis ?? null,
        });
      }
    } catch { /* non-fatal — blob is in Bunny; row write can be retried on next sync */ }

    return {...photo, cloudSynced: true, thumbSize: thumbBlob.size, originalSize: blob.size};
  }, [activeDate, cloudStatus]);

  // Rebuild and upload the session-level photos.json index from current photos.
  const writePhotoIndex = useCallback(async (list) => {
    const cloudEntries = list
      .filter(p => p.cloudSynced)
      .map(({objectUrl, hasLocalOriginal, ...meta}) => meta);
    // The index is per (team, boat, date). It used to be per date alone, so two
    // boats sailing one day overwrote each other's photo list.
    const key = writeKey(await currentStorageScope(), activeDate, SESSION_LEAVES.photoIndex);
    if (!key) return;
    await uploadJsonToStorage(key, {
      updatedAt: Date.now(),
      photos: cloudEntries,
    });
  }, [activeDate]);

  // ── Sail geometry (SailTrim) on a photo ──────────────────────────────────
  // The digitiser opens on the photo's full-resolution original and hands back a
  // finished annotation. Persisting it has to do THREE things, and the middle one
  // is the one that matters: localStorage keeps it for this browser, the Supabase
  // row's analysis_data is what every other member reads, and the session
  // photos.json index is what a fresh device sees before the row query returns.
  // Write only the first and the numbers exist for whoever clicked and nobody
  // else — the same failure that made photo instrument data invisible to
  // everyone but the importer.
  const [geomFor, setGeomFor] = useState(null);   // the photo being measured

  const persistPhotoPatch = useCallback(async (photo, patch) => {
    let next = null;
    setPhotos(prev => {
      next = prev.map(p => p.id === photo.id ? { ...p, ...patch } : p);
      savePhotos(next);
      return next;
    });
    setSelected(s => (s && s.id === photo.id) ? { ...s, ...patch } : s);
    setGeomFor(g => (g && g.id === photo.id) ? { ...g, ...patch } : g);

    // The team-shared row. `analysis` is the only field that travels.
    const merged = { ...photo, ...patch };
    const { getBrowserSupabase } = await import('../lib/supabase/browser');
    const { upsertPhotoCloud } = await import('../lib/cloud-photos');
    const { data:{ user } } = await getBrowserSupabase().auth.getUser();
    if(!user) throw new Error('Not signed in — saved on this device only.');
    if(!(merged.bunnyPath || merged.url)) throw new Error('This photo is not in the cloud yet, so there is no shared row to write to. Saved on this device only; it will travel once the photo uploads.');
    await upsertPhotoCloud({
      userId: user.id,
      sessionDate: merged.sessionDate || activeDate,
      takenUtc: merged.utc ?? null,
      exif: merged.exif ?? null,
      thumbnailUrl: merged.thumbnailUrl ?? null,
      bunnyStoragePath: merged.bunnyPath || merged.url,
      bytes: merged.size ?? null,
      analysis: merged.analysis ?? null,
    });
    if(next) await writePhotoIndex(next);
  }, [activeDate, savePhotos, writePhotoIndex]);

  const handleSaveSailTrim = useCallback(async (photo, save) => {
    const payload = {
      annotation: save.annotation,
      overlay: !!save.showOverlay,
      headline: annotationHeadline(save.annotation),
      result: save.result,
    };
    const patch = {
      ...save.fields,
      sailtrim_data: JSON.stringify(payload),
      analysis: { ...(photo.analysis || {}), sailTrim: payload },
    };
    try {
      await persistPhotoPatch(photo, patch);
    } catch (e) {
      // Local state is already updated — this is "saved, not shared", which is
      // worth a warning rather than an error that implies nothing happened.
      return { warning: `${e?.message || 'The shared copy could not be written.'} Teammates will not see these numbers until it syncs.` };
    }
    return {};
  }, [persistPhotoPatch]);

  /** Turn the burned-in lines on or off on a photo that already has geometry. */
  const handleToggleSailTrimOverlay = useCallback(async (photo) => {
    let parsed;
    try { parsed = typeof photo.sailtrim_data === 'string' ? JSON.parse(photo.sailtrim_data) : photo.sailtrim_data; }
    catch { return; }
    if(!parsed) return;
    const payload = { ...parsed, overlay: !parsed.overlay };
    const patch = {
      sailtrim_data: JSON.stringify(payload),
      analysis: { ...(photo.analysis || {}), sailTrim: payload },
    };
    try { await persistPhotoPatch(photo, patch); } catch { /* local toggle still applied */ }
  }, [persistPhotoPatch]);

  // ── Upload-only for the currently selected photo (legacy single-photo flow) ─
  const handleUpload = async () => {
    if(!selected||!cloudStatus?.available)return;
    setUploading(true);
    addLog(`Uploading ${selected.name.slice(0,25)}…`);
    try {
      const updatedPhoto = await uploadPhotoToCloud(selected);
      const updated = photos.map(p => p.id===selected.id ? {...updatedPhoto, objectUrl: p.objectUrl, hasLocalOriginal: p.hasLocalOriginal} : p);
      setPhotos(updated);
      setSelected(p => ({...p, cloudSynced: true}));
      savePhotos(updated);
      await writePhotoIndex(updated);
      addLog("✓ Uploaded (thumb + original + index)");
    } catch(e) {
      addLog(`✕ ${e.message}`);
    }
    setUploading(false);
  };

  // ── Admin/Coach: download full-res original for offline use ─────────────────
  const handleDownloadOriginal = async () => {
    if(!selected || !canSync) return;
    if(selected.hasLocalOriginal) { addLog("✓ Already local"); return; }
    setDownloadingOriginal(true);
    try {
      const keys = keysForPhoto(selected, activeDate);
      const res = await fetch(cloudImageUrl(keys.original));
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await idbPutPhoto(selected.id, blob);
      const localUrl = URL.createObjectURL(blob);
      const updated = photos.map(p => p.id===selected.id
        ? {...p, objectUrl: localUrl, hasLocalOriginal: true}
        : p);
      setPhotos(updated);
      setSelected(p => ({...p, objectUrl: localUrl, hasLocalOriginal: true}));
      savePhotos(updated);
      addLog("✓ Downloaded full-res");
    } catch(e) {
      addLog(`✕ Download failed: ${e.message||e}`);
    }
    setDownloadingOriginal(false);
  };

  const handleDelete = async()=>{
    if(!selected)return;
    await idbDeletePhoto(selected.id).catch(()=>{});
    const updated=photos.filter(p=>p.id!==selected.id);
    setPhotos(updated);savePhotos(updated);setSelected(updated[0]||null);
  };

  // ── Sidebar filtering state ──────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = React.useState("");
  const [selectedTags, setSelectedTags] = React.useState([]);
  const [sortBy, setSortBy] = React.useState("date");
  const [showSessionsMobile, setShowSessionsMobile] = React.useState(false);
  const [sailFilter, setSailFilter] = React.useState(""); // inventory sail id, "" = all
  const uiNext = useUiNext(); // ?ui=next → redesigned browse view (Phase 1)

  // All unique tags across photos
  const allTags = [...new Set(photos.flatMap(p => p.sails||[]))].sort();
  // Selected inventory sail → the tag tokens a photo must carry to match.
  const selectedSail = sailFilter ? sailInventory.find(s=>s.id===sailFilter) : null;
  const sailTokens = selectedSail ? [selectedSail.name,selectedSail.category,selectedSail.design_code,...(Array.isArray(selectedSail.specs?.aliases)?selectedSail.specs.aliases:[])].filter(Boolean).map(s=>String(s).trim().toLowerCase()) : null;

  // Filtered + sorted photos. When canSeeSailScanPhotos is false (tl1, guest)
  // we drop photos that carry SailScan analysis. Detected via `analysis`
  // field on the photo metadata, which SailScan populates on save.
  const displayed = photos
    .filter(p => {
      if (!canSeeSailScanPhotos && p.analysis) return false;
      const q = searchQuery.toLowerCase();
      const matchQ = !q || p.name?.toLowerCase().includes(q) || (p.sails||[]).some(s=>s.toLowerCase().includes(q));
      const matchT = selectedTags.length===0 || selectedTags.every(t=>(p.sails||[]).includes(t));
      const matchSail = !sailTokens || (p.sails||[]).some(s=>sailTokens.includes(String(s).trim().toLowerCase()));
      return matchQ && matchT && matchSail;
    })
    .sort((a,b) => sortBy==="tws" ? (b.tws||0)-(a.tws||0) : (b.utc||0)-(a.utc||0));

  // Group by date
  const groups = [];
  const seen = new Map();
  for(const p of displayed){
    const d = p.utc ? fmtLocalDate(p.utc,sessionTzOffset) : "unknown";
    if(!seen.has(d)){seen.set(d,[]);groups.push(d);}
    seen.get(d).push(p);
  }

  // Session rows — shared by the desktop left sidebar and the mobile top bar.
  const renderSessionRows = () => {
    const evMap=new Map(); const g=new Map();
    for(const s of sessions){ if(s.event){ if(!g.has(s.event)) g.set(s.event,[]); g.get(s.event).push(s.date); } }
    for(const [ev,ds] of g){ ds.slice().sort().forEach((d,i)=>evMap.set(d,{event:ev,dayN:i+1})); }
    return sessions.filter(s=>(s.photoCount||0)>0 && s.date<=TODAY()).map(s=>{
      const isLocal=!(s.cloudSynced||s.source==="cloud"||s.source==="supabase");const isActive=activeDate===s.date;
      const ev=evMap.get(s.date);
      return(<div key={s.date} onClick={()=>{loadDate?.(s.date);setShowSessionsMobile(false);}} style={{padding:"5px 6px",borderRadius:5,cursor:"pointer",marginBottom:2,background:isActive?"#1E3A5A":"transparent",border:`1px solid ${isActive?"#06B6D430":"transparent"}`}}>
        <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}><span style={{fontSize:11,color:isActive?"#06B6D4":"#64748B",fontFamily:"monospace"}}>{s.date===TODAY()?"Today":fmtDate(s.date)}</span><SrcBadge source={isLocal?"local":"cloud"}/></div>
        {ev&&<div style={{fontSize:9,color:"#EF4444",fontWeight:700,marginBottom:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={`${ev.event} Day ${ev.dayN}`}>🏁 {ev.event} Day {ev.dayN}</div>}
        <div style={{fontSize:9,color:"#1E3A5A"}}>{s.videoCount||0}v{s.hasLog?" ·log":""}{s.hasXml?" ·ev":""}{s.location?` · ${s.location}`:""}</div>
      </div>);
    });
  };

  if (uiNext) return (
    <PhotosNext photos={displayed} total={photos.length} searchQuery={searchQuery} setSearchQuery={setSearchQuery}
      sailInventory={sailInventory} sailFilter={sailFilter} setSailFilter={setSailFilter} tzOffset={sessionTzOffset} />
  );

  return(
    <div style={{flex:1,display:"flex",flexDirection:isNarrow?"column":"row",overflow:"hidden"}}>

      {/* ── Mobile: sessions + search as a TOP bar (matches Videos) ── */}
      {isNarrow && (
        <div style={{flexShrink:0,background:"#050E1C",borderBottom:"1px solid #1E3A5A"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 12px 8px"}}>
            <button onClick={()=>setShowSessionsMobile(v=>!v)}
              style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 12px",color:"#06B6D4",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>
              {activeDate?(activeDate===TODAY()?"Today":fmtDate(activeDate)):"Sessions"} ▾
            </button>
            <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search photos…"
              style={{flex:1,minWidth:0,background:"#071624",border:"1px solid #1E3A5A",borderRadius:6,padding:"8px 10px",color:"#E2E8F0",fontSize:14,outline:"none"}}/>
            <button onClick={()=>setSortBy(sortBy==="date"?"tws":"date")}
              style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 10px",color:"#7DD3FC",fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>
              {sortBy==="date"?"Date":"TWS"}
            </button>
          </div>
          {showSessionsMobile && (
            <div style={{maxHeight:220,overflowY:"auto",padding:"2px 10px 8px",borderTop:"1px solid #0F2030"}}>
              {sessions.length===0&&<div style={{fontSize:10,color:"#1E3A5A",padding:"4px 3px"}}>No sessions yet</div>}
              {renderSessionRows()}
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:10,color:"#8A97A9",margin:"8px 2px 4px",cursor:"pointer"}}>
                <input type="checkbox" checked={wifiOnly} onChange={toggleWifiOnly}/>
                Wi-Fi only for full-res <span style={{color:"#4E5D71",marginLeft:"auto"}}>{connectionLabel()}</span>
              </label>
              {canClearDay && activeDate && (
                <button disabled={clearingDay}
                  onClick={async()=>{ if(!confirm(`Permanently delete ALL photos for ${activeDate} from the cloud (Bunny + database) and this device? This cannot be undone.`)) return; setClearingDay(true); try{ const r=await clearDayCloud(activeDate); setPhotos([]); setSelected(null); setRefreshNonce(n=>n+1); addLog(r?.error?`✕ Clear failed: ${r.error}`:`✓ Cleared ${activeDate}`);}catch(e){addLog(`✕ ${e.message||e}`);}finally{setClearingDay(false);} }}
                  style={{width:"100%",background:clearingDay?"#0A1929":"#3a0d0d",color:clearingDay?"#334155":"#F87171",border:"1px solid #7f1d1d",borderRadius:6,padding:"7px 0",fontSize:10,fontWeight:700,cursor:clearingDay?"default":"pointer"}}>
                  {clearingDay?"⟳ Clearing…":"🗑 Clear day (cloud + device)"}
                </button>
              )}
            </div>
          )}
        </div>
      )}


      {/* ── Left sidebar — sessions + search + sort (desktop only; mobile shows
             the sessions as a top bar above) ── */}
      {!isNarrow && (
      <aside style={{width:160,background:"#050E1C",borderRight:"1px solid #1E3A5A",display:"flex",flexDirection:"column",overflowY:"auto",flexShrink:0}}>
        <div style={{padding:"12px 11px 6px"}}>
          <div style={{fontSize:9,color:"#1E3A5A",letterSpacing:2,textTransform:"uppercase",marginBottom:7}}>Sessions</div>
          {sessions.length===0&&<div style={{fontSize:10,color:"#1E3A5A",padding:"4px 3px"}}>No sessions yet</div>}
          {renderSessionRows()}
        </div>
        <div style={{height:1,background:"#0F2030",margin:"4px 11px 6px"}}/>
        <div style={{padding:"0 11px 8px"}}>
          {/* Photo import lives in the Upload tab now; this gallery is view-only. */}
          <div style={{fontSize:8,color:"#4E5D71",textAlign:"center",marginBottom:8,lineHeight:1.5}}>
            Add photos in the <span style={{color:"#8A97A9"}}>Upload</span> tab
          </div>

          {/* Manual Sync/Pull button removed — photos auto-push to the cloud on
              import (Phase B) and the cloud index auto-pulls on day load. */}

          {/* Network-aware originals: thumbnails always sync; full-res originals
              upload automatically in the background on a good link (auto-flush on
              reconnect / resume). Toggle restricts that to Wi-Fi. */}
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:9,color:"#8A97A9",marginBottom:8,cursor:"pointer"}}>
            <input type="checkbox" checked={wifiOnly} onChange={toggleWifiOnly}/>
            Wi-Fi only for full-res <span style={{color:"#4E5D71",marginLeft:"auto"}}>{connectionLabel()}</span>
          </label>

          {/* ── Coach and above (real membership role): clear this day
                 (cloud + device) and start afresh. Destructive → gated tighter
                 than per-photo delete; TL3 and below cannot see it. ── */}
          {canClearDay && activeDate && (
            <button
              disabled={clearingDay}
              onClick={async()=>{
                if(!confirm(`Permanently delete ALL photos for ${activeDate} from the cloud (Bunny + database) and this device? This cannot be undone.`)) return;
                setClearingDay(true);
                try {
                  const r = await clearDayCloud(activeDate);
                  setPhotos([]); setSelected(null); setRefreshNonce(n=>n+1);
                  addLog(r?.error ? `✕ Clear failed: ${r.error}` : `✓ Cleared ${activeDate}: ${r.deletedRows||0} rows · ${r.bunnyDeleted||0} files`);
                } catch(e){ addLog(`✕ ${e.message||e}`); }
                finally { setClearingDay(false); }
              }}
              style={{ width:"100%", marginBottom:8, background: clearingDay?"#0A1929":"#3a0d0d",
                color: clearingDay?"#334155":"#F87171", border:"1px solid #7f1d1d",
                borderRadius:6, padding:"7px 0", fontSize:10, fontWeight:700, cursor: clearingDay?"default":"pointer" }}>
              {clearingDay ? "⟳ Clearing…" : "🗑 Clear day (cloud + device)"}
            </button>
          )}

          <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
            placeholder="Search photos…"
            style={{width:"100%",background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 8px",color:"#E2E8F0",fontSize:11,outline:"none",boxSizing:"border-box",marginBottom:7}}/>
          {sailInventory.length>0&&<select value={sailFilter} onChange={e=>setSailFilter(e.target.value)} style={{width:"100%",background:"#071624",border:`1px solid ${sailFilter?"#06B6D4":"#1E3A5A"}`,borderRadius:5,padding:"5px 8px",color:sailFilter?"#06B6D4":"#E2E8F0",fontSize:11,outline:"none",boxSizing:"border-box",marginBottom:7,cursor:"pointer"}}>
            <option value="">All sails</option>
            {sailInventory.filter(s=>!s.retired).map(s=><option key={s.id} value={s.id}>{s.category?`${s.category} · ${s.name}`:s.name}</option>)}
          </select>}
          {["date","tws"].map(s=>(
            <button key={s} onClick={()=>setSortBy(s)} style={{display:"block",width:"100%",textAlign:"left",background:sortBy===s?"#1E3A5A":"none",border:"none",borderRadius:4,padding:"3px 6px",color:sortBy===s?"#06B6D4":"#334155",cursor:"pointer",fontSize:10,marginBottom:1}}>
              {sortBy===s?"▸ ":"  "}{s==="date"?"Date":"Wind (TWS)"}
            </button>
          ))}
        </div>
        {allTags.length>0&&<div style={{padding:"0 11px",flex:1}}>
          <div style={{fontSize:8,color:"#1E3A5A",letterSpacing:2,textTransform:"uppercase",marginBottom:5}}>Filter</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
            {allTags.map(t=>(
              <button key={t} onClick={()=>setSelectedTags(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t])}
                style={{background:selectedTags.includes(t)?sailTagColor.bg:"#0A1929",border:`1px solid ${selectedTags.includes(t)?sailTagColor.bd:"#1E3A5A"}`,borderRadius:3,padding:"1px 5px",color:selectedTags.includes(t)?sailTagColor.c:"#7DD3FC",fontSize:9,cursor:"pointer",fontFamily:"monospace"}}>
                {t}
              </button>
            ))}
          </div>
          {selectedTags.length>0&&<button onClick={()=>setSelectedTags([])} style={{background:"none",border:"1px solid #EF444440",borderRadius:4,padding:"2px 8px",color:"#EF4444",fontSize:9,cursor:"pointer",width:"100%",marginTop:6}}>Clear</button>}
        </div>}
        {log.length>0&&(
          <div style={{padding:"6px 10px",borderTop:"1px solid #0F2030",maxHeight:80,overflowY:"auto",marginTop:"auto"}}>
            {log.map((l,i)=><div key={i} style={{fontSize:8,color:l.startsWith("✕")?"#EF4444":l.startsWith("✓")?"#1D9E75":"#475569",fontFamily:"monospace"}}>{l}</div>)}
          </div>
        )}
      </aside>
      )}

      {/* ── Photo grid ── */}
      <div style={{width:isNarrow?"100%":280,minWidth:isNarrow?0:280,flex:isNarrow?1:"none",overflowY:"auto",padding:"10px 8px",flexShrink:isNarrow?1:0,borderRight:isNarrow?"none":"1px solid #0F2030"}}>
        {!logData&&<div style={{fontSize:9,color:"#F59E0B",background:"#F59E0B10",border:"1px solid #F59E0B30",borderRadius:5,padding:"5px 8px",marginBottom:8}}>⚠ No log loaded — instrument data won't be available</div>}

        {/* ── Loading thumbnails banner ── */}
        {(() => {
          const loadedCount = Math.min(loadedIds.size, totalThumbs);
          const isLoading = metaLoading || (totalThumbs > 0 && loadedCount < totalThumbs);
          if(!isLoading) return null;
          const pct = totalThumbs > 0 ? Math.round((loadedCount/totalThumbs)*100) : 0;
          return (
            <div style={{background:"#06B6D410",border:"1px solid #06B6D430",borderRadius:6,padding:"7px 10px",marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:10,color:"#06B6D4",fontFamily:"monospace",marginBottom:5}}>
                <span>⟳ Loading thumbnails…</span>
                <span>{metaLoading ? "…" : `${loadedCount} / ${totalThumbs}`}</span>
              </div>
              <div style={{height:4,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
                <div style={{
                  height:"100%",
                  width: metaLoading ? "15%" : `${pct}%`,
                  background:"#06B6D4",
                  transition:"width 0.2s ease-out",
                  animation: metaLoading ? "ssa-thumb-pulse 1.2s ease-in-out infinite" : "none",
                }}/>
              </div>
              <style>{`@keyframes ssa-thumb-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }`}</style>
            </div>
          );
        })()}

        {/* ── Batch select toolbar (admin/coach only) ── */}
        {canDelete && photos.length > 0 && (
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8,flexWrap:"wrap"}}>
            <button onClick={()=>batchMode?clearBatch():setBatchMode(true)}
              style={{background:batchMode?"#EF444420":"#0A1929",border:`1px solid ${batchMode?"#EF444440":"#1E3A5A"}`,
                borderRadius:5,padding:"4px 10px",color:batchMode?"#EF4444":"#64748B",cursor:"pointer",fontSize:10,fontWeight:600}}>
              {batchMode?"✕ Cancel":"☑ Select"}
            </button>
            {batchMode&&(
              <>
                <button onClick={()=>{const allIds=new Set(displayed.map(p=>p.id));setBatchSelected(allIds);}}
                  style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:5,padding:"4px 8px",color:"#8A97A9",cursor:"pointer",fontSize:9}}>All</button>
                <button onClick={()=>setBatchSelected(new Set())}
                  style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:5,padding:"4px 8px",color:"#8A97A9",cursor:"pointer",fontSize:9}}>None</button>
                <span style={{fontSize:10,color:"#64748B",fontFamily:"monospace"}}>{batchSelected.size}</span>
                {batchSelected.size>0&&(
                  <button onClick={()=>{if(confirm(`Delete ${batchSelected.size} photo${batchSelected.size>1?"s":""}? This cannot be undone.`))handleBatchDeletePhotos();}}
                    style={{background:"#EF444420",border:"1px solid #EF444450",borderRadius:5,padding:"4px 10px",color:"#EF4444",cursor:"pointer",fontSize:10,fontWeight:700}}>
                    🗑 Delete {batchSelected.size}
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <div style={{fontSize:9,color:"#4E5D71",marginBottom:8}}>{displayed.length} of {photos.length} photo{photos.length!==1?"s":""} · {photos.filter(p=>p.cloudSynced).length} in cloud</div>
        {photos.length===0?(
          <div style={{textAlign:"center",padding:"40px 20px",color:"#4E5D71"}}>
            <div style={{fontSize:28,marginBottom:8,opacity:0.3}}>📷</div>
            <div style={{fontSize:11,color:"#64748B"}}>No photos yet</div>
            <div style={{fontSize:10,marginTop:4}}>Upload from the sidebar</div>
          </div>
        ):(
          groups.map(date=>{
            const plist=seen.get(date);
            return(
              <div key={date} style={{marginBottom:18}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,paddingBottom:5,borderBottom:"1px solid #0F2030"}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#8A97A9",fontFamily:"monospace"}}>{date==="unknown"?"No date":date===TODAY()?"Today":fmtDate(date)}</div>
                  <span style={{fontSize:9,color:"#1E3A5A",marginLeft:"auto"}}>{plist.length} photo{plist.length!==1?"s":""}</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {plist.map(p=><PhotoCard key={p.id} photo={p} selected={selected?.id===p.id} onClick={()=>{setSelected(p);if(isNarrow)setMobileDetailOpen(true);}} onThumbLoad={markThumbLoaded} batchMode={batchMode} batchSelected={batchSelected} onBatchToggle={toggleBatchSelect} tzOffset={sessionTzOffset}/>)}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Detail panel — desktop-only (mobile renders as overlay below) ── */}
      {!isNarrow && (selected
        ?<PhotoDetail photo={selected} onDelete={handleDelete} onUpload={handleUpload} uploading={uploading}
           canSync={canSync} canDelete={canDelete} onDownloadOriginal={handleDownloadOriginal} downloadingOriginal={downloadingOriginal} tzOffset={sessionTzOffset} onEditTime={handleEditPhotoTime}
           onMeasureGeometry={canSync?setGeomFor:null} onToggleGeometryOverlay={canSync?handleToggleSailTrimOverlay:null}/>
        :<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"#4E5D71"}}>
          <div style={{textAlign:"center"}}><div style={{fontSize:40,marginBottom:12,opacity:0.2}}>📷</div><div style={{fontSize:13,color:"#64748B"}}>Select a photo to view</div></div>
        </div>)}

      {/* ── Mobile fullscreen overlay ── */}
      {isNarrow && mobileDetailOpen && selected && (
        <div style={{position:"fixed",inset:0,background:"#050E1C",zIndex:50,display:"flex",flexDirection:"column"}}
             role="dialog" aria-modal="true">
          <PhotoDetail photo={selected} onDelete={()=>{handleDelete();setMobileDetailOpen(false);}}
            onUpload={handleUpload} uploading={uploading}
            canSync={canSync} canDelete={canDelete} onDownloadOriginal={handleDownloadOriginal} downloadingOriginal={downloadingOriginal}
            onClose={()=>setMobileDetailOpen(false)} tzOffset={sessionTzOffset} onEditTime={handleEditPhotoTime}
            onMeasureGeometry={canSync?setGeomFor:null} onToggleGeometryOverlay={canSync?handleToggleSailTrimOverlay:null}/>
        </div>
      )}

      {/* ── The digitiser, full screen ──────────────────────────────────────
          Full screen because it is a measuring instrument: the mast is two
          pixels wide at fit zoom, and the marking has to be done zoomed in with
          the rig model and the checks visible beside it. It is handed the
          full-resolution ORIGINAL — never the composite, whose burned-in gauges
          and any previous annotation would then be measured as though they were
          the photograph. */}
      {geomFor && (
        <div style={{position:"fixed",inset:0,zIndex:80,background:"#030F1A",display:"flex",flexDirection:"column"}}
             role="dialog" aria-modal="true" aria-label="Sail geometry">
          <div style={{flexShrink:0,display:"flex",alignItems:"center",gap:12,padding:"9px 12px",background:"#0F2A45",borderBottom:"1px solid #1E3A5A"}}>
            <button onClick={()=>setGeomFor(null)}
              style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:7,padding:"7px 13px",color:"#E2E8F0",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
              ← Back to photo
            </button>
            <div style={{fontSize:12.5,fontWeight:800,color:"#38BDF8"}}>📐 Sail geometry</div>
            <div style={{fontSize:11,color:"#94A3B8",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>
              {geomFor.name||"Photo"}{geomFor.utc?` · ${fmtLocalDT(geomFor.utc,sessionTzOffset)} ${TZ_SHORT(sessionTzOffset)}`:""}
            </div>
          </div>
          <div style={{flex:1,minHeight:0,position:"relative"}}>
            <SailTrimTab
              boatName={geomFor.boat||""}
              initialFileUrl={geomFor.fullUrl||geomFor.objectUrl||""}
              initialFileName={geomFor.name||"photo.jpg"}
              photoLabel={geomFor.name||"this photo"}
              onSaveToPhoto={(save)=>handleSaveSailTrim(geomFor,save)}/>
          </div>
        </div>
      )}
    </div>
  );
}
