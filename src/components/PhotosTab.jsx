// src/components/PhotosTab.jsx
// Photos stored as blobs in IndexedDB, metadata in localStorage
//
// Sync architecture (tiered):
//   1) ALL users upload full-resolution + thumbnail to Bunny Storage
//   2) ALL users pull thumbnails for fast browsing
//   3) ALL users can stream (view) via the CDN
//   4) Admin/Coach can optionally download full-res to IDB for offline debrief

import React, { useState, useRef, useCallback, useEffect } from "react";
import { uploadJsonToStorage, fetchFromStorage } from "../lib/bunny";

const DB_NAME = "ssa-db";
const R = (n, d=1) => (n==null||isNaN(n))?"--":Number(n).toFixed(d);

// Keys for cloud layout
const cloudKeys = (date, id) => ({
  original: `sessions/${date}/photos/${id}.jpg`,
  thumb:    `sessions/${date}/photos/${id}_thumb.jpg`,
  meta:     `sessions/${date}/photos/${id}_meta.json`,
  index:    `sessions/${date}/photos.json`,
});

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
function openDb() {
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, 4); // bump to v4 to add photos store
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
    req.onerror   = e=>reject(e.target.error);
  });
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

async function idbHasPhoto(id) {
  const db = await openDb();
  return new Promise((res)=>{
    const tx  = db.transaction("photos","readonly");
    const req = tx.objectStore("photos").getKey(id);
    req.onsuccess = ()=>res(!!req.result);
    req.onerror   = ()=>res(false);
  });
}

// ── EXIF parser ───────────────────────────────────────────────────────────────
async function extractExif(file) {
  try {
    const buf  = await file.slice(0,131072).arrayBuffer();
    const view = new DataView(buf);
    const u8   = new Uint8Array(buf);
    let exifOffset = -1;
    for(let i=0;i<u8.length-8;i++){
      if(u8[i]===0xFF&&u8[i+1]===0xE1&&u8[i+4]===0x45&&u8[i+5]===0x78&&u8[i+6]===0x69&&u8[i+7]===0x66){
        exifOffset=i+10; break;
      }
    }
    if(exifOffset<0) return null;
    const le = view.getUint16(exifOffset)===0x4949;
    const g16= o=>view.getUint16(exifOffset+o,le);
    const g32= o=>view.getUint32(exifOffset+o,le);
    const gStr=(o,l)=>String.fromCharCode(...u8.slice(exifOffset+o,exifOffset+o+l)).replace(/\0/g,"").trim();
    const ifd=g32(4), n=g16(ifd);
    let dtStr=null, gpsOff=null;
    for(let i=0;i<n;i++){
      const eo=ifd+2+i*12, tag=g16(eo), type=g16(eo+2), cnt=g32(eo+4), vo=g32(eo+8);
      if((tag===0x0132||tag===0x9003||tag===0x9004)&&!dtStr)
        dtStr=type===2&&cnt<=4?gStr(eo+8,cnt):gStr(vo,cnt);
      if(tag===0x8825) gpsOff=vo;
    }
    let lat=null,lon=null;
    if(gpsOff!=null){
      try{
        const ge=g16(gpsOff); let latRef="N",lonRef="E",latD=null,lonD=null;
        for(let i=0;i<ge;i++){
          const eo=gpsOff+2+i*12,gt=g16(eo),gv=g32(eo+8);
          if(gt===1)latRef=gStr(eo+8,1); if(gt===3)lonRef=gStr(eo+8,1);
          if(gt===2||gt===4){
            const d=[0,1,2].map(j=>{const n=g32(gv+j*8),d=g32(gv+j*8+4);return d?n/d:0;});
            if(gt===2)latD=d; else lonD=d;
          }
        }
        if(latD&&lonD){
          lat=(latD[0]+latD[1]/60+latD[2]/3600)*(latRef==="S"?-1:1);
          lon=(lonD[0]+lonD[1]/60+lonD[2]/3600)*(lonRef==="W"?-1:1);
        }
      }catch{}
    }
    let utc=null;
    if(dtStr){const m=dtStr.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);if(m)utc=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]);}
    return{utc,lat,lon};
  }catch{return null;}
}

// Load exifr from CDN for robust EXIF extraction (JPEG, HEIC, TIFF)
function loadExifr() {
  return new Promise((resolve,reject)=>{
    if(window.exifr){resolve(window.exifr);return;}
    const s=document.createElement("script");
    s.src="https://unpkg.com/exifr@7.1.3/dist/full.umd.js";
    s.onload=()=>resolve(window.exifr);
    s.onerror=reject;
    document.head.appendChild(s);
  });
}

// Load heic2any from CDN for HEIC conversion
function loadHeic2any() {
  return new Promise((resolve,reject)=>{
    if(window.heic2any){resolve(window.heic2any);return;}
    const s=document.createElement("script");
    s.src="https://cdnjs.cloudflare.com/ajax/libs/heic2any/0.0.4/heic2any.min.js";
    s.onload=()=>resolve(window.heic2any);
    s.onerror=reject;
    document.head.appendChild(s);
  });
}

async function convertToJpeg(file) {
  if(file.type==="image/jpeg") return file;

  // HEIC/HEIF — use heic2any library
  const isHeic = file.type==="image/heic"||file.type==="image/heif"||/\.(heic|heif)$/i.test(file.name);
  if(isHeic){
    const heic2any = await loadHeic2any();
    const blob = await heic2any({blob:file, toType:"image/jpeg", quality:0.92});
    return new File([blob], file.name.replace(/\.[^.]+$/,".jpg"), {type:"image/jpeg"});
  }

  // PNG/WebP — convert via canvas
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      const c=document.createElement("canvas");
      c.width=img.naturalWidth;c.height=img.naturalHeight;
      c.getContext("2d").drawImage(img,0,0);
      c.toBlob(blob=>{
        URL.revokeObjectURL(url);
        blob?resolve(new File([blob],file.name.replace(/\.[^.]+$/,".jpg"),{type:"image/jpeg"})):reject(new Error("Conversion failed"));
      },"image/jpeg",0.92);
    };
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("Load failed"));};
    img.src=url;
  });
}

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

function renderOverlay(canvas,img,inst){
  const ctx=canvas.getContext("2d");
  canvas.width=img.naturalWidth||img.width;canvas.height=img.naturalHeight||img.height;
  ctx.drawImage(img,0,0);
  const W=canvas.width,H=canvas.height,scale=Math.min(W,H)/1000;
  const fs=Math.max(11,Math.round(14*scale)),pad=Math.round(12*scale);
  const bw=Math.round(90*scale),bh=Math.round(52*scale),gap=Math.round(8*scale);
  const gauges=[
    {l:"TWS",v:inst.tws!=null?R(inst.tws)+" kn":"--",c:"#7DD3FC"},
    {l:"TWA",v:inst.twa!=null?R(inst.twa,0)+"°":"--",c:"#7DD3FC"},
    {l:"AWA",v:inst.awa!=null?R(inst.awa,0)+"°":"--",c:"#7DD3FC"},
    {l:"BSP",v:inst.bsp!=null?R(inst.bsp)+" kn":"--",c:"#10B981"},
    {l:"Heel",v:inst.heel!=null?R(inst.heel,0)+"°":"--",c:"#F97316"},
    {l:"VMG",v:inst.vmg!=null?R(inst.vmg)+" kn":"--",c:"#22C55E"},
  ];
  const cols=3,rows=Math.ceil(gauges.length/cols);
  const sx=W-cols*bw-(cols-1)*gap-pad,sy=H-rows*bh-(rows-1)*gap-pad;
  gauges.forEach((g,i)=>{
    const x=sx+(i%cols)*(bw+gap),y=sy+Math.floor(i/cols)*(bh+gap);
    ctx.fillStyle="rgba(3,15,26,0.82)";ctx.beginPath();
    if(ctx.roundRect)ctx.roundRect(x,y,bw,bh,5);else ctx.rect(x,y,bw,bh);ctx.fill();
    ctx.strokeStyle=g.c+"60";ctx.lineWidth=1.5;ctx.beginPath();
    if(ctx.roundRect)ctx.roundRect(x,y,bw,bh,5);else ctx.rect(x,y,bw,bh);ctx.stroke();
    ctx.fillStyle="#64748B";ctx.font=`${Math.round(fs*0.65)}px monospace`;ctx.textAlign="center";
    ctx.fillText(g.l.toUpperCase(),x+bw/2,y+Math.round(bh*0.35));
    ctx.fillStyle=g.c;ctx.font=`bold ${fs}px monospace`;
    ctx.fillText(g.v,x+bw/2,y+Math.round(bh*0.72));
  });
  if(inst.sails?.length){
    const txt=inst.sails.join(" · ");
    ctx.font=`${Math.round(fs*0.75)}px monospace`;
    const tw=ctx.measureText(txt).width+pad*2,th=Math.round(bh*0.6);
    ctx.fillStyle="rgba(3,15,26,0.82)";ctx.beginPath();
    if(ctx.roundRect)ctx.roundRect(pad,pad,tw,th,5);else ctx.rect(pad,pad,tw,th);ctx.fill();
    ctx.fillStyle="#F59E0B";ctx.textAlign="left";ctx.fillText(txt,pad*1.5,pad+Math.round(th*0.72));
  }
  if(inst.location||inst.boat){
    const badge=[inst.boat,inst.location].filter(Boolean).join(" · ");
    ctx.font=`${Math.round(fs*0.65)}px monospace`;
    const bwb=ctx.measureText(badge).width+pad*2,bhb=Math.round(bh*0.55);
    ctx.fillStyle="rgba(3,15,26,0.82)";ctx.beginPath();
    if(ctx.roundRect)ctx.roundRect(W-bwb-pad,pad,bwb,bhb,5);else ctx.rect(W-bwb-pad,pad,bwb,bhb);ctx.fill();
    ctx.fillStyle="#94A3B8";ctx.textAlign="right";ctx.fillText(badge,W-pad*1.5,pad+Math.round(bhb*0.72));
  }
}

const SAIL_SKIP = /^(main|msail|mainsail|main-)/;
const fmtDate = d=>{if(!d)return"";const p=d.split("-");return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:d;};
const TODAY = ()=>new Date().toISOString().slice(0,10);
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

function PhotoCard({photo,selected,onClick,onThumbLoad,batchMode,batchSelected,onBatchToggle}){
  const sails = (photo.sails||[]).filter(s=>!SAIL_SKIP.test(s));
  const race  = photo.raceTags||[];
  const handleLoad = () => onThumbLoad?.(photo.id);
  const handleError = () => onThumbLoad?.(photo.id);
  const isBatchSelected = batchMode && batchSelected?.has(photo.id);
  const handleClick = () => batchMode ? onBatchToggle?.(photo.id) : onClick?.();
  return(
    <div onClick={handleClick} style={{background:isBatchSelected?"#EF444420":selected&&!batchMode?"#0F2A45":"#0A1929",border:`2px solid ${isBatchSelected?"#EF4444":selected&&!batchMode?"#06B6D4":"#1E3A5A"}`,borderRadius:10,overflow:"hidden",cursor:"pointer",transition:"border-color 0.12s"}}>
      <div style={{aspectRatio:"4/3",background:"#071624",position:"relative",overflow:"hidden"}}>
        {photo.objectUrl
          ?<img src={photo.objectUrl} alt="" loading="lazy" onLoad={handleLoad} onError={handleError} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          :<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:22}}>📷</div>}
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
        <div style={{position:"absolute",bottom:3,right:4,background:"rgba(0,0,0,0.8)",borderRadius:2,padding:"0 3px",fontSize:8,color:"#64748B",fontFamily:"monospace"}}>{photo.utc?new Date(photo.utc).toISOString().slice(11,16)+" UTC":"--:--"}</div>
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
          {photo.tws==null&&photo.twa==null&&<span style={{color:"#334155"}}>—</span>}
        </div>
        {/* 4) Filename at bottom */}
        <div style={{fontSize:10,fontWeight:600,color:"#E2E8F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{photo.name||"Photo"}</div>
      </div>
    </div>
  );
}

function PhotoDetail({photo,onDelete,onUpload,uploading,canSync,canDelete,onDownloadOriginal,downloadingOriginal,onClose}){
  const canvasRef=useRef(null);
  const [rendered,setRendered]=useState(false);
  useEffect(()=>{
    if(!photo?.objectUrl||!canvasRef.current){setRendered(false);return;}
    const img=new Image();
    img.crossOrigin="anonymous";
    img.onload=()=>{renderOverlay(canvasRef.current,img,{tws:photo.tws,twa:photo.twa,awa:photo.awa,bsp:photo.bsp,heel:photo.heel,vmg:photo.vmg,sails:photo.sails,location:photo.location,boat:photo.boat});setRendered(true);};
    img.onerror=()=>setRendered(false);
    img.src=photo.objectUrl;
  },[photo.id,photo.objectUrl,photo.tws,photo.twa,photo.sails]);
  const handleExport=()=>{
    if(!canvasRef.current)return;
    const a=document.createElement("a");
    a.download=`${photo.name?.replace(/\.[^.]+$/,"")||"photo"}_overlay.jpg`;
    a.href=canvasRef.current.toDataURL("image/jpeg",0.92);a.click();
  };
  const dateStr = photo.utc ? new Date(photo.utc).toISOString().slice(0,10) : null;
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
      <div style={{position:"relative",marginBottom:12}}>
        <canvas ref={canvasRef} style={{width:"100%",borderRadius:8,border:"1px solid #1E3A5A",display:"block"}}/>
        {photo.utc&&<div style={{position:"absolute",bottom:8,left:10,background:"rgba(0,0,0,0.75)",borderRadius:4,padding:"3px 8px",fontSize:11,fontWeight:700,color:"#E2E8F0",fontFamily:"monospace",letterSpacing:0.5}}>{fmtDate(new Date(photo.utc).toISOString().slice(0,10))} {new Date(photo.utc).toISOString().slice(11,16)} UTC</div>}
      </div>
      <div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:8,padding:"10px 14px",marginBottom:10}}>
        <div style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Instrument data</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
          {[["TWS",photo.tws,"kn","#7DD3FC"],["TWA",photo.twa,"°","#7DD3FC"],["AWA",photo.awa,"°","#7DD3FC"],
            ["BSP",photo.bsp,"kn","#10B981"],["Heel",photo.heel,"°","#F97316"],["VMG",photo.vmg,"kn","#22C55E"]]
            .map(([l,v,u,c])=>(
              <div key={l} style={{background:"#071624",borderRadius:6,padding:"7px 8px",border:`1px solid ${c}15`,textAlign:"center"}}>
                <div style={{fontSize:8,color:"#334155",marginBottom:2}}>{l}</div>
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
        {photo.utc&&<div style={{marginTop:4,fontSize:9,color:"#475569"}}>🕐 {new Date(photo.utc).toISOString().slice(0,19).replace("T"," ")} UTC</div>}
      </div>
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
        <div style={{marginTop:8,textAlign:"center",fontSize:10,color:"#475569"}}>Streaming thumbnail · admin/coach can cache full-res</div>
      )}
    </div>
  );
}

// ── Main PhotosTab ────────────────────────────────────────────────────────────
export default function PhotosTab({role,logData,xmlData,activeDate,sessions=[],loadDate,cloudStatus,onPhotosChange}){
  const [photos,setPhotos]     = useState([]);   // metadata only — no blobs
  const [selected,setSelected] = useState(null);
  const [uploading,setUploading]= useState(false);
  const [syncing,setSyncing]   = useState(false);
  const [syncState,setSyncState] = useState(null); // { phase, current, total, msg }
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
  },[batchSelected,photos,selected,clearBatch]);
  const [dragOver,setDragOver] = useState(false);
  const [log,setLog]           = useState([]);
  const fileRef = useRef(null);
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

  // Load metadata from localStorage, blobs from IDB, fill in cloud thumb URLs
  useEffect(()=>{
    if(!activeDate)return;
    // Reset load-tracking for the new date
    setMetaLoading(true);
    setLoadedIds(new Set());
    setTotalThumbs(0);
    const meta = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
    // For each photo: prefer local blob URL; otherwise fall back to cloud thumb URL.
    Promise.all(meta.map(async p=>{
      const blob = await idbGetPhoto(p.id).catch(()=>null);
      const hasLocalOriginal = !!blob;
      const keys = cloudKeys(p.sessionDate||activeDate, p.id);
      // Display URL priority: local blob → cloud thumb (if cloud-synced) → null
      const objectUrl = blob
        ? URL.createObjectURL(blob)
        : (p.cloudSynced ? cloudImageUrl(keys.thumb) : null);
      return{...p, objectUrl, hasLocalOriginal};
    })).then(restored=>{
      setPhotos(restored);
      // Only count photos that actually have a thumbnail to load
      setTotalThumbs(restored.filter(p => p.objectUrl).length);
      setMetaLoading(false);
      if(restored.length>0) setSelected(restored[0]);
    });
  },[activeDate]);

  const savePhotos = useCallback((updated)=>{
    // Save metadata to localStorage (no blobs)
    const meta = updated.map(({objectUrl,...p})=>p);
    try{ localStorage.setItem(LS_KEY, JSON.stringify(meta)); }
    catch(e){ console.error("savePhotos localStorage:", e); }
    onPhotosChange?.(updated);
  },[LS_KEY,onPhotosChange]);

  const enrichPhoto = useCallback((photo,log,xml)=>{
    const e={...photo};
    if(log?.rows?.length&&photo.utc){
      const row=nearestLogRow(log.rows,photo.utc);
      if(row){e.tws=row.tws;e.twa=row.twa;e.awa=row.awa;e.bsp=row.bsp;e.heel=row.heel;e.vmg=row.vmg;}
    }
    if(xml){e.sails=activeSailsAt(xml.sailsUpEvents,photo.utc);e.raceTags=raceTagsAt(xml,photo.utc);e.boat=xml.meta?.boat||null;e.location=xml.meta?.location||null;}
    return e;
  },[]);

  const handleFiles = useCallback(async(files)=>{
    const imgs=Array.from(files).filter(f=>f.type.startsWith("image/")||/\.(jpg|jpeg|png|heic|heif|webp)$/i.test(f.name));
    if(!imgs.length){addLog("No image files found");return;}
    addLog(`Processing ${imgs.length} photo${imgs.length>1?"s":""}…`);
    const newPhotos=[];
    for(const file of imgs){
      try{
        let exif=null;
        try{
          const exifr=await loadExifr();
          const data=await exifr.parse(file,{tiff:true,exif:true,gps:true,ifd0:true});
          const dt=data?.DateTimeOriginal||data?.DateTime;
          const utc=dt instanceof Date?dt.getTime():null;
          exif={utc,lat:data?.latitude||null,lon:data?.longitude||null,camera:data?.Model||null};
        }catch{exif=await extractExif(file);}
        addLog(`${file.name.slice(0,25)}: ${exif?.utc?new Date(exif.utc).toISOString().slice(11,16)+" UTC":"no timestamp"}${exif?.lat?" 📍":""}`);
        let jpeg;
        try{jpeg=await convertToJpeg(file);}catch{jpeg=file;}
        // Store blob in IDB
        const id=`p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await idbPutPhoto(id, jpeg);
        const objectUrl = URL.createObjectURL(jpeg);
        let photo={id,name:file.name,size:jpeg.size,utc:exif?.utc||null,lat:exif?.lat||null,lon:exif?.lon||null,
          sessionDate:activeDate,objectUrl,cloudSynced:false,addedAt:Date.now()};
        photo=enrichPhoto(photo,logData,xmlData);
        newPhotos.push(photo);
      }catch(e){addLog(`✕ ${file.name.slice(0,20)}: ${e.message}`);}
    }
    const updated=[...photos,...newPhotos];
    setPhotos(updated);savePhotos(updated);
    if(newPhotos.length>0)setSelected(newPhotos[0]);
    addLog(`✓ ${newPhotos.length} photo${newPhotos.length>1?"s":""} added`);
  },[photos,activeDate,logData,xmlData,enrichPhoto,savePhotos]);

  // Re-enrich when log/xml loads
  useEffect(()=>{
    if(!photos.length||(!logData&&!xmlData))return;
    const enriched=photos.map(p=>enrichPhoto(p,logData,xmlData));
    setPhotos(enriched);savePhotos(enriched);
    if(selected)setSelected(enriched.find(p=>p.id===selected.id)||enriched[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[logData,xmlData]);

  // ── Upload a single photo (full-res + thumb + meta) ─────────────────────────
  // Returns updated photo metadata on success, null on failure.
  const uploadPhotoToCloud = useCallback(async (photo) => {
    if(!cloudStatus?.available) throw new Error("Cloud not available");
    const blob = await idbGetPhoto(photo.id);
    if(!blob) throw new Error("No local blob");
    const keys = cloudKeys(photo.sessionDate||activeDate, photo.id);
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

    return {...photo, cloudSynced: true, thumbSize: thumbBlob.size, originalSize: blob.size};
  }, [activeDate, cloudStatus]);

  // Rebuild and upload the session-level photos.json index from current photos.
  const writePhotoIndex = useCallback(async (list) => {
    const cloudEntries = list
      .filter(p => p.cloudSynced)
      .map(({objectUrl, hasLocalOriginal, ...meta}) => meta);
    await uploadJsonToStorage(`sessions/${activeDate}/photos.json`, {
      updatedAt: Date.now(),
      photos: cloudEntries,
    });
  }, [activeDate]);

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

  // ── Pull cloud photos for this session, merge with local state ──────────────
  // Cloud-only photos get thumbnail URLs; we don't auto-download originals.
  const handlePullFromCloud = useCallback(async () => {
    if(!activeDate || !cloudStatus?.available) return;
    const index = await fetchFromStorage(`sessions/${activeDate}/photos.json`);
    if(!index?.photos) return { added: 0, updated: 0 };
    const cloudPhotos = index.photos;

    // Merge: local wins on id collision (keeps objectUrl), but mark cloudSynced.
    const byId = new Map(photos.map(p => [p.id, p]));
    let added = 0, updated = 0;
    for(const cp of cloudPhotos) {
      if(byId.has(cp.id)) {
        const local = byId.get(cp.id);
        if(!local.cloudSynced) {
          byId.set(cp.id, {...local, ...cp, cloudSynced: true, objectUrl: local.objectUrl, hasLocalOriginal: local.hasLocalOriginal});
          updated++;
        }
      } else {
        const keys = cloudKeys(activeDate, cp.id);
        byId.set(cp.id, {
          ...cp,
          cloudSynced: true,
          sessionDate: activeDate,
          objectUrl: cloudImageUrl(keys.thumb),
          hasLocalOriginal: false,
        });
        added++;
      }
    }
    const merged = Array.from(byId.values()).sort((a,b)=>(b.utc||0)-(a.utc||0));
    setPhotos(merged);
    savePhotos(merged);
    return { added, updated };
  }, [activeDate, cloudStatus, photos, savePhotos]);

  // ── Full sync: push all local-only + pull all cloud-only ────────────────────
  const handleSyncAll = async () => {
    if(!cloudStatus?.available) { addLog("✕ Cloud not available"); return; }
    setSyncing(true);
    try {
      // PHASE 1 — Pull cloud index first so we don't re-upload anything
      setSyncState({ phase: "pull", current: 0, total: 0, msg: "Fetching cloud index…" });
      const pullResult = await handlePullFromCloud();
      if(pullResult?.added)   addLog(`✓ Pulled ${pullResult.added} cloud photo${pullResult.added>1?"s":""}`);
      if(pullResult?.updated) addLog(`✓ Updated ${pullResult.updated} photo${pullResult.updated>1?"s":""}`);

      // PHASE 2 — Push every local photo that isn't cloud-synced yet.
      // Read fresh state because handlePullFromCloud may have merged.
      const currentList = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
      const toPush = currentList.filter(p => !p.cloudSynced);
      const total = toPush.length;
      if(total === 0) {
        setSyncState({ phase: "done", current: 0, total: 0, msg: "Nothing to upload" });
        addLog("✓ Nothing to push — all photos in cloud");
      } else {
        addLog(`Pushing ${total} photo${total>1?"s":""} to cloud…`);
        let pushed = 0;
        let latestList = currentList;
        for(let i=0; i<total; i++) {
          const p = toPush[i];
          setSyncState({ phase: "push", current: i+1, total, msg: `Uploading ${p.name?.slice(0,20)||"photo"}…` });
          try {
            const updatedPhoto = await uploadPhotoToCloud(p);
            latestList = latestList.map(x => x.id===p.id ? {...updatedPhoto} : x);
            // Keep in-state UI in sync too
            setPhotos(prev => prev.map(x => x.id===p.id ? {...x, cloudSynced: true} : x));
            pushed++;
          } catch(e) {
            addLog(`✕ ${p.name?.slice(0,20)||p.id}: ${e.message}`);
          }
        }
        // Persist and write the updated index once at the end
        localStorage.setItem(LS_KEY, JSON.stringify(latestList));
        try { await writePhotoIndex(latestList.map(p => ({...p, objectUrl: null}))); } catch {}
        setSyncState({ phase: "done", current: pushed, total, msg: `✓ Synced ${pushed}/${total}` });
        addLog(`✓ Pushed ${pushed}/${total} photos`);
      }
    } catch(e) {
      setSyncState({ phase: "error", msg: String(e.message||e) });
      addLog(`✕ Sync error: ${e.message||e}`);
    }
    // Keep the final state visible briefly, then clear
    setTimeout(() => setSyncState(null), 3500);
    setSyncing(false);
  };

  // ── Admin/Coach: download full-res original for offline use ─────────────────
  const handleDownloadOriginal = async () => {
    if(!selected || !canSync) return;
    if(selected.hasLocalOriginal) { addLog("✓ Already local"); return; }
    setDownloadingOriginal(true);
    try {
      const keys = cloudKeys(selected.sessionDate||activeDate, selected.id);
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

  // All unique tags across photos
  const allTags = [...new Set(photos.flatMap(p => p.sails||[]))].sort();

  // Filtered + sorted photos
  const displayed = photos
    .filter(p => {
      const q = searchQuery.toLowerCase();
      const matchQ = !q || p.name?.toLowerCase().includes(q) || (p.sails||[]).some(s=>s.toLowerCase().includes(q));
      const matchT = selectedTags.length===0 || selectedTags.every(t=>(p.sails||[]).includes(t));
      return matchQ && matchT;
    })
    .sort((a,b) => sortBy==="tws" ? (b.tws||0)-(a.tws||0) : (b.utc||0)-(a.utc||0));

  // Group by date
  const groups = [];
  const seen = new Map();
  for(const p of displayed){
    const d = p.utc ? new Date(p.utc).toISOString().slice(0,10) : "unknown";
    if(!seen.has(d)){seen.set(d,[]);groups.push(d);}
    seen.get(d).push(p);
  }

  return(
    <div style={{flex:1,display:"flex",overflow:"hidden"}}>

      {/* ── Left sidebar — sessions + search + sort (matches Videos) ── */}
      <aside style={{width:160,background:"#050E1C",borderRight:"1px solid #1E3A5A",display:"flex",flexDirection:"column",overflowY:"auto",flexShrink:0}}>
        <div style={{padding:"12px 11px 6px"}}>
          <div style={{fontSize:9,color:"#1E3A5A",letterSpacing:2,textTransform:"uppercase",marginBottom:7}}>Sessions</div>
          {sessions.length===0&&<div style={{fontSize:10,color:"#1E3A5A",padding:"4px 3px"}}>No sessions yet</div>}
          {sessions.map(s=>{
            const isLocal=!s.source||s.source==="local";const isActive=activeDate===s.date;
            return(<div key={s.date} onClick={()=>loadDate?.(s.date)} style={{padding:"5px 6px",borderRadius:5,cursor:"pointer",marginBottom:2,background:isActive?"#1E3A5A":"transparent",border:`1px solid ${isActive?"#06B6D430":"transparent"}`}}>
              <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}><span style={{fontSize:11,color:isActive?"#06B6D4":"#64748B",fontFamily:"monospace"}}>{s.date===TODAY()?"Today":fmtDate(s.date)}</span><SrcBadge source={isLocal?"local":"cloud"}/></div>
              <div style={{fontSize:9,color:"#1E3A5A"}}>{s.videoCount||0}v{s.hasLog?" ·log":""}{s.hasXml?" ·ev":""}{s.location?` · ${s.location}`:""}</div>
            </div>);
          })}
        </div>
        <div style={{height:1,background:"#0F2030",margin:"4px 11px 6px"}}/>
        <div style={{padding:"0 11px 8px"}}>
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" multiple style={{display:"none"}} onChange={e=>handleFiles(e.target.files)}/>
          <div onClick={()=>fileRef.current?.click()}
            onDragOver={e=>{e.preventDefault();setDragOver(true);}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();setDragOver(false);handleFiles(e.dataTransfer.files);}}
            style={{border:`2px dashed ${dragOver?"#8B5CF6":"#1E3A5A"}`,borderRadius:7,padding:"8px 6px",textAlign:"center",cursor:"pointer",background:dragOver?"#0D1829":"transparent",marginBottom:8,transition:"all 0.12s"}}>
            <div style={{fontSize:13,marginBottom:1}}>📷</div>
            <div style={{fontSize:8,color:"#64748B"}}>Drop or click</div>
          </div>

          {/* ── Sync All — push local + pull cloud ── */}
          {(() => {
            const unsynced = photos.filter(p => !p.cloudSynced).length;
            const disabled = syncing || !cloudStatus?.available || !activeDate;
            return (
              <button onClick={handleSyncAll} disabled={disabled}
                title={!cloudStatus?.available ? "Cloud not available" : (unsynced ? `Upload ${unsynced} photo${unsynced>1?"s":""} + pull cloud index` : "Pull cloud index")}
                style={{
                  width:"100%", marginBottom:8,
                  background: disabled ? "#0A1929" : (unsynced>0 ? "#06B6D4" : "#1E3A5A"),
                  color: disabled ? "#334155" : (unsynced>0 ? "#000" : "#06B6D4"),
                  border: `1px solid ${disabled ? "#1E3A5A" : (unsynced>0 ? "#06B6D4" : "#06B6D440")}`,
                  borderRadius:6, padding:"7px 0", fontSize:10, fontWeight:700,
                  cursor: disabled ? "default" : "pointer", letterSpacing:0.3,
                }}>
                {syncing ? "⟳ Syncing…" : unsynced>0 ? `☁ Sync All (${unsynced})` : "⟳ Pull cloud"}
              </button>
            );
          })()}

          {/* ── Sync progress readout ── */}
          {syncState && (
            <div style={{
              marginBottom:8, padding:"6px 8px",
              background: syncState.phase==="error" ? "#EF444415" : "#06B6D410",
              border: `1px solid ${syncState.phase==="error" ? "#EF444440" : "#06B6D430"}`,
              borderRadius:5, fontSize:9, fontFamily:"monospace",
              color: syncState.phase==="error" ? "#EF4444" : "#06B6D4",
            }}>
              <div style={{marginBottom: syncState.total>0 ? 4 : 0}}>
                {syncState.total>0 ? `${syncState.current}/${syncState.total} · ` : ""}{syncState.msg}
              </div>
              {syncState.total>0 && (
                <div style={{height:3,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
                  <div style={{
                    height:"100%",
                    width:`${Math.round((syncState.current/syncState.total)*100)}%`,
                    background:"#06B6D4", transition:"width 0.15s",
                  }}/>
                </div>
              )}
            </div>
          )}
          <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
            placeholder="Search photos…"
            style={{width:"100%",background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 8px",color:"#E2E8F0",fontSize:11,outline:"none",boxSizing:"border-box",marginBottom:7}}/>
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

      {/* ── Photo grid ── */}
      <div style={{width:280,minWidth:280,overflowY:"auto",padding:"10px 8px",flexShrink:0,borderRight:"1px solid #0F2030"}}>
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
                  style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:5,padding:"4px 8px",color:"#64748B",cursor:"pointer",fontSize:9}}>All</button>
                <button onClick={()=>setBatchSelected(new Set())}
                  style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:5,padding:"4px 8px",color:"#64748B",cursor:"pointer",fontSize:9}}>None</button>
                <span style={{fontSize:10,color:"#475569",fontFamily:"monospace"}}>{batchSelected.size}</span>
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
        <div style={{fontSize:9,color:"#334155",marginBottom:8}}>{displayed.length} of {photos.length} photo{photos.length!==1?"s":""} · {photos.filter(p=>p.cloudSynced).length} in cloud</div>
        {photos.length===0?(
          <div style={{textAlign:"center",padding:"40px 20px",color:"#334155"}}>
            <div style={{fontSize:28,marginBottom:8,opacity:0.3}}>📷</div>
            <div style={{fontSize:11,color:"#475569"}}>No photos yet</div>
            <div style={{fontSize:10,marginTop:4}}>Upload from the sidebar</div>
          </div>
        ):(
          groups.map(date=>{
            const plist=seen.get(date);
            return(
              <div key={date} style={{marginBottom:18}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,paddingBottom:5,borderBottom:"1px solid #0F2030"}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#64748B",fontFamily:"monospace"}}>{date==="unknown"?"No date":date===TODAY()?"Today":fmtDate(date)}</div>
                  <span style={{fontSize:9,color:"#1E3A5A",marginLeft:"auto"}}>{plist.length} photo{plist.length!==1?"s":""}</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {plist.map(p=><PhotoCard key={p.id} photo={p} selected={selected?.id===p.id} onClick={()=>{setSelected(p);if(isNarrow)setMobileDetailOpen(true);}} onThumbLoad={markThumbLoaded} batchMode={batchMode} batchSelected={batchSelected} onBatchToggle={toggleBatchSelect}/>)}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Detail panel — desktop-only (mobile renders as overlay below) ── */}
      {!isNarrow && (selected
        ?<PhotoDetail photo={selected} onDelete={handleDelete} onUpload={handleUpload} uploading={uploading}
           canSync={canSync} canDelete={canDelete} onDownloadOriginal={handleDownloadOriginal} downloadingOriginal={downloadingOriginal}/>
        :<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"#334155"}}>
          <div style={{textAlign:"center"}}><div style={{fontSize:40,marginBottom:12,opacity:0.2}}>📷</div><div style={{fontSize:13,color:"#475569"}}>Select a photo to view</div></div>
        </div>)}

      {/* ── Mobile fullscreen overlay ── */}
      {isNarrow && mobileDetailOpen && selected && (
        <div style={{position:"fixed",inset:0,background:"#050E1C",zIndex:50,display:"flex",flexDirection:"column"}}
             role="dialog" aria-modal="true">
          <PhotoDetail photo={selected} onDelete={()=>{handleDelete();setMobileDetailOpen(false);}}
            onUpload={handleUpload} uploading={uploading}
            canSync={canSync} canDelete={canDelete} onDownloadOriginal={handleDownloadOriginal} downloadingOriginal={downloadingOriginal}
            onClose={()=>setMobileDetailOpen(false)}/>
        </div>
      )}
    </div>
  );
}
