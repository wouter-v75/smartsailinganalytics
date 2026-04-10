// src/components/PhotosTab.jsx
// Photos stored as blobs in IndexedDB, metadata in localStorage

import React, { useState, useRef, useCallback, useEffect } from "react";
import { uploadJsonToStorage } from "../lib/bunny";

const DB_NAME = "ssa-db";
const R = (n, d=1) => (n==null||isNaN(n))?"--":Number(n).toFixed(d);

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

function renderOverlay(canvas,img,inst){
  const ctx=canvas.getContext("2d");
  canvas.width=img.naturalWidth||img.width;canvas.height=img.naturalHeight||img.height;
  ctx.drawImage(img,0,0);
  const W=canvas.width,H=canvas.height,scale=Math.min(W,H)/1000;
  const fs=Math.max(11,Math.round(14*scale)),pad=Math.round(12*scale);
  const bw=Math.round(90*scale),bh=Math.round(52*scale),gap=Math.round(8*scale);
  const gauges=[
    {l:"TWS",v:inst.tws!=null?R(inst.tws)+" kn":"--",c:"#06B6D4"},
    {l:"TWA",v:inst.twa!=null?R(inst.twa,0)+"°":"--",c:"#8B5CF6"},
    {l:"AWA",v:inst.awa!=null?R(inst.awa,0)+"°":"--",c:"#A78BFA"},
    {l:"BSP",v:inst.bsp!=null?R(inst.bsp)+" kn":"--",c:"#10B981"},
    {l:"Heel",v:inst.heel!=null?R(inst.heel,0)+"°":"--",c:"#F59E0B"},
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

function SrcBadge({source}){const m={local:{l:"LOCAL",bg:"#06B6D415",bd:"#06B6D430",c:"#06B6D4"},cloud:{l:"CLOUD",bg:"#8B5CF615",bd:"#8B5CF630",c:"#8B5CF6"},processing:{l:"PROC",bg:"#F59E0B15",bd:"#F59E0B30",c:"#F59E0B"}};const s=m[source]||m.local;return<span style={{fontSize:9,padding:"1px 5px",borderRadius:3,letterSpacing:1,fontWeight:600,background:s.bg,border:`1px solid ${s.bd}`,color:s.c}}>{s.l}</span>;}

function PhotoCard({photo,selected,onClick}){
  const sails = (photo.sails||[]).filter(s=>!SAIL_SKIP.test(s));
  return(
    <div onClick={onClick} style={{background:selected?"#0F2A45":"#0A1929",border:`2px solid ${selected?"#06B6D4":"#1E3A5A"}`,borderRadius:10,overflow:"hidden",cursor:"pointer",transition:"border-color 0.12s"}}>
      <div style={{aspectRatio:"4/3",background:"#071624",position:"relative",overflow:"hidden"}}>
        {photo.objectUrl
          ?<img src={photo.objectUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          :<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:22}}>📷</div>}
        {/* Source badge top-right */}
        <div style={{position:"absolute",top:3,right:4}}><SrcBadge source={photo.cloudSynced?"cloud":"local"}/></div>
        {/* GPS pin */}
        {photo.lat&&photo.lon&&<div style={{position:"absolute",bottom:3,left:4,fontSize:9,color:"#22C55E"}}>📍</div>}
        {/* Time badge bottom-right */}
        <div style={{position:"absolute",bottom:3,right:4,background:"rgba(0,0,0,0.8)",borderRadius:2,padding:"0 3px",fontSize:8,color:"#64748B",fontFamily:"monospace"}}>{photo.utc?new Date(photo.utc).toISOString().slice(11,16)+" UTC":"--:--"}</div>
      </div>
      <div style={{padding:"6px 9px"}}>
        <div style={{fontSize:10,fontWeight:600,color:"#E2E8F0",marginBottom:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{photo.name||"Photo"}</div>
        <div style={{fontSize:9,color:"#334155",marginBottom:sails.length?4:0}}>{photo.tws!=null?`TWS ${R(photo.tws)}kn`:""}{ photo.twa!=null?` · TWA ${R(photo.twa,0)}°`:""}</div>
        {sails.length>0&&(
          <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
            {sails.map(t=>(<span key={t} style={{background:sailTagColor.bg,border:`1px solid ${sailTagColor.bd}`,color:sailTagColor.c,fontSize:8,borderRadius:3,padding:"0 4px",fontFamily:"monospace"}}>{t}</span>))}
          </div>
        )}
      </div>
    </div>
  );
}

function PhotoDetail({photo,onDelete,onUpload,uploading}){
  const canvasRef=useRef(null);
  const [rendered,setRendered]=useState(false);
  useEffect(()=>{
    if(!photo?.objectUrl||!canvasRef.current){setRendered(false);return;}
    const img=new Image();
    img.onload=()=>{renderOverlay(canvasRef.current,img,{tws:photo.tws,twa:photo.twa,awa:photo.awa,bsp:photo.bsp,heel:photo.heel,vmg:photo.vmg,sails:photo.sails,location:photo.location,boat:photo.boat});setRendered(true);};
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
    <div style={{flex:1,background:"#050E1C",borderLeft:"1px solid #1E3A5A",overflowY:"auto",padding:16}}>
      <div style={{position:"relative",marginBottom:12}}>
        <canvas ref={canvasRef} style={{width:"100%",borderRadius:8,border:"1px solid #1E3A5A",display:"block"}}/>
        {dateStr&&<div style={{position:"absolute",top:8,right:10,background:"rgba(0,0,0,0.75)",borderRadius:4,padding:"3px 8px",fontSize:11,fontWeight:700,color:"#E2E8F0",fontFamily:"monospace",letterSpacing:0.5}}>{fmtDate(dateStr)}</div>}
      </div>
      <div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:8,padding:"10px 14px",marginBottom:10}}>
        <div style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Instrument data</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
          {[["TWS",photo.tws,"kn","#06B6D4"],["TWA",photo.twa,"°","#8B5CF6"],["AWA",photo.awa,"°","#A78BFA"],
            ["BSP",photo.bsp,"kn","#10B981"],["Heel",photo.heel,"°","#F59E0B"],["VMG",photo.vmg,"kn","#22C55E"]]
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
        <button onClick={onDelete} style={{background:"none",border:"1px solid #EF444440",borderRadius:7,padding:"9px 14px",color:"#EF4444",cursor:"pointer",fontSize:12}}>🗑</button>
      </div>
    </div>
  );
}

// ── Main PhotosTab ────────────────────────────────────────────────────────────
export default function PhotosTab({role,logData,xmlData,activeDate,sessions=[],loadDate,cloudStatus,onPhotosChange}){
  const [photos,setPhotos]     = useState([]);   // metadata only — no blobs
  const [selected,setSelected] = useState(null);
  const [uploading,setUploading]= useState(false);
  const [dragOver,setDragOver] = useState(false);
  const [log,setLog]           = useState([]);
  const fileRef = useRef(null);
  const addLog  = msg => setLog(p=>[...p.slice(-20),msg]);

  const LS_KEY = `ssa:photos-meta:${activeDate}`;

  // Load metadata from localStorage, blobs from IDB
  useEffect(()=>{
    if(!activeDate)return;
    const meta = JSON.parse(localStorage.getItem(LS_KEY)||"[]");
    // Restore objectUrls from IDB blobs
    Promise.all(meta.map(async p=>{
      const blob = await idbGetPhoto(p.id).catch(()=>null);
      return{...p, objectUrl: blob?URL.createObjectURL(blob):null};
    })).then(restored=>{
      setPhotos(restored);
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
    if(xml){e.sails=activeSailsAt(xml.sailsUpEvents,photo.utc);e.boat=xml.meta?.boat||null;e.location=xml.meta?.location||null;}
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

  const handleUpload = async()=>{
    if(!selected||!cloudStatus?.available)return;
    setUploading(true);
    addLog(`Uploading ${selected.name.slice(0,25)}…`);
    try{
      const blob = await idbGetPhoto(selected.id);
      if(!blob){addLog("✕ No blob found");setUploading(false);return;}
      const{accessKey,zone,host}=await fetch("/api/storage/credentials").then(r=>r.json());
      const imgRes=await fetch(`${host}/${zone}/sessions/${activeDate}/photos/${selected.id}.jpg`,
        {method:"PUT",headers:{AccessKey:accessKey,"Content-Type":"image/jpeg"},body:blob});
      if(imgRes.ok||imgRes.status===201){
        const{objectUrl,...meta}=selected;
        await uploadJsonToStorage(`sessions/${activeDate}/photos/${selected.id}_meta.json`,meta);
        addLog("✓ Uploaded to cloud");
        const updated=photos.map(p=>p.id===selected.id?{...p,cloudSynced:true}:p);
        setPhotos(updated);setSelected(p=>({...p,cloudSynced:true}));savePhotos(updated);
      }else{addLog(`✕ Upload failed: ${imgRes.status}`);}
    }catch(e){addLog(`✕ ${e.message}`);}
    setUploading(false);
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
                  {plist.map(p=><PhotoCard key={p.id} photo={p} selected={selected?.id===p.id} onClick={()=>setSelected(p)}/>)}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Detail panel ── */}
      {selected
        ?<PhotoDetail photo={selected} onDelete={handleDelete} onUpload={handleUpload} uploading={uploading}/>
        :<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"#334155"}}>
          <div style={{textAlign:"center"}}><div style={{fontSize:40,marginBottom:12,opacity:0.2}}>📷</div><div style={{fontSize:13,color:"#475569"}}>Select a photo to view</div></div>
        </div>}
    </div>
  );
}
