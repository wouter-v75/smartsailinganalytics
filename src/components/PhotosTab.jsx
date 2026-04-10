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
        dtStr=type===2&&cnt<=20?gStr(eo+8,cnt):gStr(vo,cnt);
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

async function convertToJpeg(file) {
  if(file.type==="image/jpeg") return file;
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      const c=document.createElement("canvas");
      c.width=img.naturalWidth;c.height=img.naturalHeight;
      c.getContext("2d").drawImage(img,0,0);
      c.toBlob(blob=>{URL.revokeObjectURL(url);blob?resolve(new File([blob],file.name.replace(/\.[^.]+$/,".jpg"),{type:"image/jpeg"})):reject(new Error("Conversion failed"));},"image/jpeg",0.92);
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

function PhotoCard({photo,selected,onClick}){
  return(
    <div onClick={onClick} style={{background:selected?"#0F2A45":"#0A1929",border:`2px solid ${selected?"#8B5CF6":"#1E3A5A"}`,borderRadius:10,overflow:"hidden",cursor:"pointer"}}>
      <div style={{aspectRatio:"4/3",background:"#071624",position:"relative",overflow:"hidden"}}>
        {photo.objectUrl
          ?<img src={photo.objectUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          :<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:22}}>📷</div>}
        {photo.cloudSynced&&<div style={{position:"absolute",top:3,right:3,fontSize:8,padding:"1px 4px",borderRadius:2,background:"#8B5CF615",border:"1px solid #8B5CF630",color:"#8B5CF6",fontWeight:600}}>CLOUD</div>}
        {photo.lat&&photo.lon&&<div style={{position:"absolute",bottom:3,left:4,fontSize:9,color:"#22C55E"}}>📍</div>}
      </div>
      <div style={{padding:"5px 8px"}}>
        <div style={{fontSize:9,color:"#64748B"}}>{photo.utc?new Date(photo.utc).toISOString().slice(11,16)+" UTC":"No timestamp"}</div>
        <div style={{display:"flex",gap:6,marginTop:2}}>
          {photo.tws!=null&&<span style={{fontSize:9,color:"#06B6D4"}}>TWS {R(photo.tws)}kn</span>}
          {photo.twa!=null&&<span style={{fontSize:9,color:"#8B5CF6"}}>{R(photo.twa,0)}°</span>}
          {photo.sails?.length>0&&<span style={{fontSize:9,color:"#F59E0B"}}>{photo.sails[0]}</span>}
        </div>
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
  return(
    <div style={{flex:1,background:"#050E1C",borderLeft:"1px solid #1E3A5A",overflowY:"auto",padding:16}}>
      <canvas ref={canvasRef} style={{width:"100%",borderRadius:8,border:"1px solid #1E3A5A",display:"block",marginBottom:12}}/>
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
        {photo.sails?.length>0&&<div style={{marginTop:8,fontSize:10,color:"#F59E0B"}}>⛵ {photo.sails.join(" · ")}</div>}
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
export default function PhotosTab({role,logData,xmlData,activeDate,cloudStatus,onPhotosChange}){
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
        const exif = await extractExif(file);
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

  return(
    <div style={{flex:1,display:"flex",overflow:"hidden"}}>
      <div style={{width:300,minWidth:300,background:"#050E1C",borderRight:"1px solid #0F2030",display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{padding:"10px 10px 0"}}>
          <input ref={fileRef} type="file" accept="image/*,.heic,.heif" multiple style={{display:"none"}} onChange={e=>handleFiles(e.target.files)}/>
          <div onClick={()=>fileRef.current?.click()}
            onDragOver={e=>{e.preventDefault();setDragOver(true);}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();setDragOver(false);handleFiles(e.dataTransfer.files);}}
            style={{border:`2px dashed ${dragOver?"#8B5CF6":"#1E3A5A"}`,borderRadius:8,padding:"16px 12px",textAlign:"center",cursor:"pointer",background:dragOver?"#0D1829":"transparent",marginBottom:8,transition:"all 0.12s"}}>
            <div style={{fontSize:20,marginBottom:4}}>📷</div>
            <div style={{fontSize:11,color:"#64748B"}}>Drop photos or click to browse</div>
            <div style={{fontSize:9,color:"#334155",marginTop:2}}>JPEG · PNG · HEIC · multiple files</div>
          </div>
          {!logData&&<div style={{fontSize:9,color:"#F59E0B",background:"#F59E0B10",border:"1px solid #F59E0B30",borderRadius:5,padding:"5px 8px",marginBottom:8}}>⚠ No log loaded — instrument data won't be available</div>}
          <div style={{fontSize:9,color:"#334155",marginBottom:6}}>{photos.length} photo{photos.length!==1?"s":""} · {photos.filter(p=>p.cloudSynced).length} in cloud</div>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"0 10px 10px"}}>
          {photos.length===0&&(
            <div style={{textAlign:"center",padding:"40px 20px",color:"#334155"}}>
              <div style={{fontSize:28,marginBottom:8,opacity:0.3}}>📷</div>
              <div style={{fontSize:11,color:"#475569"}}>No photos yet</div>
              <div style={{fontSize:10,marginTop:4}}>Upload from your camera roll</div>
            </div>
          )}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {photos.map(p=><PhotoCard key={p.id} photo={p} selected={selected?.id===p.id} onClick={()=>setSelected(p)}/>)}
          </div>
        </div>
        {log.length>0&&(
          <div style={{padding:"6px 10px",borderTop:"1px solid #0F2030",maxHeight:80,overflowY:"auto"}}>
            {log.map((l,i)=><div key={i} style={{fontSize:9,color:l.startsWith("✕")?"#EF4444":l.startsWith("✓")?"#1D9E75":"#475569",fontFamily:"monospace"}}>{l}</div>)}
          </div>
        )}
      </div>
      {selected
        ?<PhotoDetail photo={selected} onDelete={handleDelete} onUpload={handleUpload} uploading={uploading}/>
        :<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"#334155"}}>
          <div style={{textAlign:"center"}}><div style={{fontSize:40,marginBottom:12,opacity:0.2}}>📷</div><div style={{fontSize:13,color:"#475569"}}>Select a photo to view</div></div>
        </div>}
    </div>
  );
}
