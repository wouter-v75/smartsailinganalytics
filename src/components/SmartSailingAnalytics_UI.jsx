'use client'
import { useState, useEffect, useRef, useCallback } from "react";
import { saveVideo, getAllVideos, getVideosForDate, updateVideoTags, updateVideoStartUtc, deleteVideo, saveLogData, getLogData, saveXmlData, getXmlData, computeAutoTags, getSessions, getUnsyncedCount, markCloudSynced } from "../lib/localStore";
import { deleteStreamVideo } from "../lib/bunny";

// Sync offset persistence — inline to avoid module resolution issues
const OFFSET_KEY = "ssa:syncOffsets";
function getSyncOffsets() { try { const v=localStorage.getItem(OFFSET_KEY); return v?JSON.parse(v):{};} catch{return{};} }
function saveSyncOffset(videoId, secs) { try { const o=getSyncOffsets(); if(secs===0){delete o[videoId];}else{o[videoId]=secs;} localStorage.setItem(OFFSET_KEY,JSON.stringify(o));} catch{} }
import { checkCloudStatus, syncSessionToCloud, fetchCloudSession, listR2Sessions, waitForStreamReady } from "../lib/bunny";

// ─── VIDEO CREATION TIME ─────────────────────────────────────────────────────
// Reads the MP4/MOV 'mvhd' atom — set by the camera at record time.
// NOT affected by file copy/transfer unlike file.lastModified.
async function extractVideoCreationTime(file) {
  try {
    const buf  = await file.slice(0, 524288).arrayBuffer(); // first 512 KB
    const view = new DataView(buf);
    const u8   = new Uint8Array(buf);
    for (let i = 0; i < u8.length - 12; i++) {
      // Look for 'mvhd' box (0x6d766864)
      if (u8[i]===0x6d&&u8[i+1]===0x76&&u8[i+2]===0x68&&u8[i+3]===0x64) {
        const version = view.getUint8(i+4);
        let secs;
        if (version===1) {
          // 64-bit: read hi+lo (JS loses precision above 2^53 but dates fit fine)
          const hi = view.getUint32(i+8);
          const lo = view.getUint32(i+12);
          secs = hi * 4294967296 + lo;
        } else {
          secs = view.getUint32(i+8); // 32-bit
        }
        // MP4 epoch: 1904-01-01. Unix epoch offset = 2082844800 s
        const unix = secs - 2082844800;
        if (unix > 0 && unix < 4102444800) return unix * 1000; // ms, sanity 1970-2100
      }
    }
  } catch {}
  return null;
}

const ROLES = {
  admin:      { label:"Admin",      canImport:true,  canSync:true,  seeLocal:true },
  coach:      { label:"Coach",      canImport:true,  canSync:true,  seeLocal:true },
  crew:       { label:"Crew",       canImport:true,  canSync:false, seeLocal:true },
  viewer:     { label:"Viewer",     canImport:false, canSync:false, seeLocal:false },
  consultant: { label:"Consultant", canImport:false, canSync:false, seeLocal:false },
};

function parseNmea(s){const p=s.trim().split(/\s+/);if(p.length<2)return{lat:0,lon:0};const f=(str,d)=>{const h=str.slice(-1),n=str.slice(0,-1);const v=parseFloat(n.slice(0,d))+parseFloat(n.slice(d))/60;return h==="S"||h==="W"?-v:v;};try{return{lat:f(p[0],2),lon:f(p[1],3)};}catch{return{lat:0,lon:0};}}
function expToUtc(ds,ts){const[d,m,y]=ds.split("/").map(Number);const yr=y<50?2000+y:1900+y;const[h,mn,sc]=ts.split(":").map(Number);return Date.UTC(yr,m-1,d,h,mn,sc);}
function parseCsvLog(text){const lines=text.replace(/\r/g,"").split("\n").filter(l=>l.trim());const rows=[];for(let i=1;i<lines.length;i++){const c=lines[i].split(",");if(c.length<27)continue;const bsp=parseFloat(c[4])||0,tws=parseFloat(c[12])||0;if(bsp<0.05&&tws<0.3)continue;const ds=c[1]?.trim(),ts=c[2]?.trim();if(!ds?.includes("/")||!ts?.includes(":"))continue;const utc=expToUtc(ds,ts);if(isNaN(utc))continue;const pos=parseNmea(c[0]);rows.push({utc,lat:pos.lat,lon:pos.lon,heel:parseFloat(c[3])||0,bsp,twa:parseFloat(c[11])||0,tws,sog:parseFloat(c[20])||0,vmg:parseFloat(c[19])||0,vsTargPct:parseFloat(c[23])||0,vsPerfPct:parseFloat(c[26])||0,rudder:parseFloat(c[52])||0});}return{rows,startUtc:rows[0]?.utc||0,endUtc:rows[rows.length-1]?.utc||0};}
function isoUtc(s){return new Date(s.trim().replace(" ","T")+"Z").getTime();}
function parseXmlEvents(text){
  const doc=new DOMParser().parseFromString(text,"text/xml");
  const ga=(el,a,d="")=>el?.getAttribute(a)??d;
  const meta={boat:ga(doc.querySelector("boat"),"val"),location:ga(doc.querySelector("location"),"val"),date:ga(doc.querySelector("date"),"val")};
  const sailsUpEvents=[],raceGuns=[];
  for(const ev of doc.getElementsByTagName("event")){
    const utc=isoUtc(`${ga(ev,"date")} ${ga(ev,"time")}`);
    const type=ga(ev,"type"),attr=ga(ev,"attribute");
    if(type==="SailsUp"){
      const sails=attr.split(";").map(s=>s.trim()).filter(Boolean);
      sailsUpEvents.push({utc,sails,label:sails.join(" + ")||"Sails changed"});
    } else if(type==="RaceStartGun"){
      raceGuns.push({utc,raceNum:parseInt(attr)||0,label:`Race ${attr||"?"} start`,color:"#EF4444"});
    }
  }
  const markRoundings=Array.from(doc.getElementsByTagName("markrounding")).map(mr=>({
    utc:isoUtc(ga(mr,"datetime")),isTop:ga(mr,"istopmark")==="true",isValid:ga(mr,"isvalid")==="true",
    label:ga(mr,"istopmark")==="true"?"Top mark":"Leeward gate",
    color:ga(mr,"istopmark")==="true"?"#EF4444":"#8B5CF6",
  }));
  const tackJibes=Array.from(doc.getElementsByTagName("tackjibe")).map(tj=>({
    utc:isoUtc(ga(tj,"datetime")),isTack:ga(tj,"istack")==="true",isValid:ga(tj,"isvalidperf")==="true",
    label:ga(tj,"istack")==="true"?"Tack":"Gybe",
    color:ga(tj,"istack")==="true"?"#1D9E75":"#7F77DD",
  }));
  return{meta,sailsUpEvents,raceGuns,markRoundings,tackJibes};
}

const R=(n,d=1)=>(n==null||isNaN(n))?"--":Number(n).toFixed(d);
const fmtT=s=>{const x=Math.max(0,Math.floor(s));return`${String(Math.floor(x/60)).padStart(2,"0")}:${String(x%60).padStart(2,"0")}`;};
const fmtUtc=u=>u?new Date(u).toISOString().slice(11,19):"--:--:--";
const TODAY=()=>new Date().toISOString().slice(0,10);
const fmtSize=b=>b>1e9?`${(b/1e9).toFixed(1)} GB`:`${(b/1e6).toFixed(0)} MB`;
function nearestRow(rows,utc){if(!rows?.length)return null;let lo=0,hi=rows.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].utc<utc)lo=mid+1;else hi=mid;}if(lo>0&&Math.abs(rows[lo-1].utc-utc)<Math.abs(rows[lo].utc-utc))lo--;return Math.abs(rows[lo].utc-utc)<120000?rows[lo]:null;}
function enrichVideo(v,log){
  if(!log?.rows?.length||!v.startUtc)return v;
  const w=log.rows.filter(r=>r.utc>=v.startUtc&&r.utc<=v.startUtc+(v.duration||0)*1000);
  if(!w.length)return v;
  const avg=f=>w.reduce((s,r)=>s+(r[f]||0),0)/w.length;
  const avgFiltered=(f,lo,hi)=>{const valid=w.filter(r=>r[f]>lo&&r[f]<hi);return valid.length?valid.reduce((s,r)=>s+r[f],0)/valid.length:null;};
  const max=f=>w.reduce((mx,r)=>Math.max(mx,r[f]||0),0);
  return{
    ...v,
    // ── 5 primary clip fields ──
    twsAvg:   avg("tws"),                          // avg true wind speed (kn)
    twaAvg:   avg("twa"),                          // avg true wind angle (°, signed: + stbd, - port)
    vmgAvg:   avg("vmg"),                          // avg velocity made good (kn)
    polpercAvg: avgFiltered("vsPerfPct",5,200),    // avg % of polar speed (Vs_perf%, col 26)
    vsTargPercAvg: avgFiltered("vsTargPct",5,200), // avg % of target speed (Vs_targ%, col 23)
    // ── secondary (for cards / sorting) ──
    sogAvg:   avg("sog"),
    sogMax:   max("sog"),
    twsMax:   max("tws"),
    heelAvg:  avg("heel"),
    bspAvg:   avg("bsp"),
    logRows:  w,
  };
}

function SrcBadge({source}){const m={local:{l:"LOCAL",bg:"#06B6D415",bd:"#06B6D430",c:"#06B6D4"},cloud:{l:"CLOUD",bg:"#8B5CF615",bd:"#8B5CF630",c:"#8B5CF6"},processing:{l:"PROC",bg:"#F59E0B15",bd:"#F59E0B30",c:"#F59E0B"}};const s=m[source]||m.local;return<span style={{fontSize:9,padding:"1px 5px",borderRadius:3,letterSpacing:1,fontWeight:600,background:s.bg,border:`1px solid ${s.bd}`,color:s.c}}>{s.l}</span>;}
function Gauge({label,value,unit,color="#06B6D4"}){return<div style={{background:"rgba(0,0,0,0.75)",border:`1px solid ${color}40`,borderRadius:7,padding:"7px 11px",minWidth:76}}><div style={{fontSize:9,color:"#64748B",letterSpacing:2,textTransform:"uppercase",marginBottom:2}}>{label}</div><div style={{fontSize:22,fontWeight:700,color,fontFamily:"'Courier New',monospace",lineHeight:1}}>{value}</div><div style={{fontSize:10,color:"#475569",marginTop:1}}>{unit}</div></div>;}

// Video player — handles local blob OR HLS stream from Cloudflare Stream
function VideoPlayer({video,logData,xmlData,syncOffset}){
  const vidRef=useRef(null),hlsRef=useRef(null);
  const[curTime,setCurTime]=useState(0);
  const[playing,setPlaying]=useState(false);
  const[dur,setDur]=useState(video.duration||0);
  const isHls=video.source==="cloud"||video.objectUrl?.includes(".m3u8");

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

  const logUtc=video.startUtc?video.startUtc+(curTime+(syncOffset||0))*1000:0;
  const row=logData&&logUtc?nearestRow(logData.rows,logUtc):null;
  const markers=xmlData&&video.startUtc?[...(xmlData.tackJibes||[]),...(xmlData.markRoundings||[]),...(xmlData.sailsUpEvents||[]).map(s=>({...s,color:"#F59E0B"}))].map(m=>({...m,vidSec:(m.utc-video.startUtc)/1000-(syncOffset||0)})).filter(m=>m.vidSec>=0&&m.vidSec<=dur):[];
  const upcoming=markers.filter(m=>m.vidSec>curTime&&m.vidSec<curTime+30).slice(0,2);
  const pct=dur>0?(curTime/dur)*100:0;
  const onUpdate=()=>{if(vidRef.current){setCurTime(vidRef.current.currentTime);setPlaying(!vidRef.current.paused);}};
  const seek=e=>{const r=e.currentTarget.getBoundingClientRect();if(vidRef.current)vidRef.current.currentTime=((e.clientX-r.left)/r.width)*dur;};

  return(
    <div style={{background:"#030F1A",borderRadius:12,overflow:"hidden",border:"1px solid #1E3A5A"}}>
      <div style={{position:"relative",background:"#000",height:290,display:"flex",alignItems:"center",justifyContent:"center"}}>
        {video.objectUrl?<video ref={vidRef} style={{width:"100%",height:"100%",objectFit:"contain"}} onTimeUpdate={onUpdate} onPlay={onUpdate} onPause={onUpdate} onLoadedMetadata={e=>setDur(e.target.duration)}/>:
         video.source==="processing"?<div style={{textAlign:"center",color:"#F59E0B"}}><div style={{fontSize:28,marginBottom:8}}>⏳</div><div style={{fontSize:12}}>Processing in Stream…</div><div style={{fontSize:10,color:"#475569",marginTop:4}}>1–3 min typically</div></div>:
         <div style={{color:"#334155",textAlign:"center"}}><div style={{fontSize:28,marginBottom:8,opacity:0.3}}>📹</div><div style={{fontSize:11}}>No playback available</div></div>}
        {!playing&&video.objectUrl&&<div onClick={()=>vidRef.current?.play()} style={{position:"absolute",width:52,height:52,background:"rgba(6,182,212,0.9)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18}}>▶</div>}
        {row&&<div style={{position:"absolute",top:10,left:10,display:"flex",gap:5}}><Gauge label="TWS" value={R(row.tws)} unit="kn" color="#06B6D4"/><Gauge label="TWA" value={`${R(row.twa,0)}°`} unit="true" color="#8B5CF6"/><Gauge label="SOG" value={R(row.sog)} unit="kn" color="#10B981"/><Gauge label="Heel" value={`${R(row.heel,0)}°`} unit="°" color="#F59E0B"/></div>}
        {upcoming.length>0&&<div style={{position:"absolute",top:10,right:10,display:"flex",flexDirection:"column",gap:4}}>{upcoming.map((m,i)=><div key={i} style={{background:"rgba(0,0,0,0.8)",borderRadius:5,padding:"3px 7px",fontSize:10,color:m.color,border:`1px solid ${m.color}40`}}>{m.label} in {Math.round(m.vidSec-curTime)}s</div>)}</div>}
        <div style={{position:"absolute",bottom:8,left:8}}><SrcBadge source={video.source||"local"}/></div>
        <div style={{position:"absolute",bottom:8,right:8,background:"rgba(0,0,0,0.7)",borderRadius:4,padding:"2px 7px",fontSize:10,color:"#64748B",fontFamily:"monospace"}}>{fmtT(curTime)} / {fmtT(dur)}{logUtc?`  ${fmtUtc(logUtc)}`:""}</div>
      </div>
      <div style={{padding:"8px 12px 0"}}>
        <div style={{position:"relative",height:26,background:"#071624",borderRadius:4,cursor:"pointer",overflow:"hidden"}} onClick={seek}>
          <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pct}%`,background:"#06B6D430",transition:"width 0.5s linear"}}/>
          <div style={{position:"absolute",left:`${pct}%`,top:0,bottom:0,width:2,background:"#06B6D4",transform:"translateX(-50%)"}}/>
          {markers.map((m,i)=><div key={i} onClick={e=>{e.stopPropagation();if(vidRef.current)vidRef.current.currentTime=m.vidSec;}} title={`${m.label} +${fmtT(m.vidSec)}`} style={{position:"absolute",left:`${(m.vidSec/Math.max(dur,1))*100}%`,top:0,bottom:0,width:2,background:m.color,opacity:m.isValid===false?0.3:1,cursor:"pointer"}}/>)}
          <span style={{position:"absolute",left:6,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#334155",pointerEvents:"none",fontFamily:"monospace"}}>{markers.length>0?`${markers.length} events`:row?"● live data":"click to seek"}</span>
        </div>
      </div>
      <div style={{padding:"7px 12px 11px",display:"flex",gap:7,alignItems:"center"}}>
        <button onClick={()=>playing?vidRef.current?.pause():vidRef.current?.play()} style={{background:"#06B6D4",border:"none",borderRadius:6,padding:"6px 14px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>{playing?"⏸ Pause":"▶ Play"}</button>
        <button onClick={()=>{if(vidRef.current)vidRef.current.currentTime=0;}} style={{background:"#1E3A5A",border:"none",borderRadius:6,padding:"6px 9px",color:"#94A3B8",cursor:"pointer"}}>⏹</button>
        <div style={{flex:1}}/>
        {row&&<span style={{fontSize:10,color:"#1D9E75"}}>● live instruments</span>}
        {isHls&&<span style={{fontSize:9,color:"#8B5CF6"}}>HLS · Stream</span>}
      </div>
    </div>
  );
}

// Video card
function VideoCard({video,selected,onClick}){
  const manTags=(video.tags||[]).filter(t=>["tack","gybe","top-mark","leeward-gate","upwind","downwind","reaching"].includes(t));
  const extraTags=(video.tags||[]).filter(t=>!["tack","gybe","top-mark","leeward-gate","upwind","downwind","reaching","local","cloud","training","today"].includes(t)&&!t.startsWith("tws-")).slice(0,2);
  return(
    <div onClick={onClick} style={{background:selected?"#0F2A45":"#0A1929",border:`2px solid ${selected?"#06B6D4":"#1E3A5A"}`,borderRadius:12,overflow:"hidden",cursor:"pointer",transition:"border-color 0.12s"}}>
      <div style={{height:108,background:"#071624",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",overflow:"hidden"}}>
        {video.thumbnailUrl?<img src={video.thumbnailUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:
         video.objectUrl&&video.source!=="cloud"?<video src={video.objectUrl} style={{width:"100%",height:"100%",objectFit:"cover"}} muted preload="metadata"/>:
         video.source==="processing"?<div style={{color:"#F59E0B",textAlign:"center",fontSize:11}}><div style={{fontSize:20,marginBottom:4}}>⏳</div>Processing</div>:
         <div style={{color:"#1E3A5A",textAlign:"center",fontSize:10}}><div style={{fontSize:24,marginBottom:4,opacity:0.3}}>📹</div>{video.source==="cloud"?"Stream":""}</div>}
        <div style={{position:"absolute",bottom:5,right:5,background:"rgba(0,0,0,0.75)",borderRadius:3,padding:"1px 4px",fontSize:9,color:"#64748B",fontFamily:"monospace"}}>{video.duration?fmtT(video.duration):"--:--"}</div>
        <div style={{position:"absolute",top:5,right:5}}><SrcBadge source={video.source||"local"}/></div>
        {video.camera&&<div style={{position:"absolute",top:5,left:5,background:"rgba(0,0,0,0.7)",borderRadius:3,padding:"1px 4px",fontSize:9,color:"#475569"}}>{video.camera}</div>}
      </div>
      <div style={{padding:"9px 11px"}}>
        <div style={{fontSize:11,fontWeight:600,color:"#E2E8F0",marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{video.title}</div>
        <div style={{fontSize:10,color:"#334155",marginBottom:6}}>{video.sessionDate}</div>
        {video.twsAvg!=null&&(
          <div style={{display:"flex",gap:3,marginBottom:6,flexWrap:"wrap"}}>
            {[
              ["TWS", video.twsAvg,    "kt",  "#06B6D4"],
              ["TWA", video.twaAvg,    "°",   "#8B5CF6"],
              ["VMG", video.vmgAvg,    "kt",  "#10B981"],
              ["Pol", video.polpercAvg,"%",   "#F59E0B"],
              ["Tgt", video.vsTargPercAvg,"%","#EF4444"],
            ].map(([l,val,u,c])=>(
              <div key={l} style={{flex:"1 1 0",background:"#071624",borderRadius:4,padding:"3px 0",textAlign:"center",minWidth:30}}>
                <div style={{fontSize:7,color:"#334155"}}>{l}</div>
                <div style={{fontSize:10,fontWeight:700,color:c,fontFamily:"monospace"}}>{val!=null?R(val)+"":"--"}</div>
                <div style={{fontSize:7,color:"#334155"}}>{u}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{display:"flex",flexWrap:"wrap",gap:3}}>{[...manTags,...extraTags].slice(0,5).map(t=><span key={t} style={{background:"#1E3A5A",color:"#7DD3FC",fontSize:9,borderRadius:3,padding:"1px 4px",fontFamily:"monospace"}}>#{t}</span>)}{(video.tags||[]).length>5&&<span style={{fontSize:9,color:"#334155"}}>+{video.tags.length-5}</span>}</div>
      </div>
    </div>
  );
}

// Tag editor
function TagEditor({video,onSave}){
  const[tags,setTags]=useState(video.tags||[]);const[input,setInput]=useState("");const[dirty,setDirty]=useState(false);
  useEffect(()=>{setTags(video.tags||[]);setDirty(false);},[video.id]);
  const add=()=>{if(input.trim()&&!tags.includes(input.trim())){setTags(p=>[...p,input.trim()]);setInput("");setDirty(true);}};
  const rem=t=>{setTags(p=>p.filter(x=>x!==t));setDirty(true);};
  const save=async()=>{await updateVideoTags(video.id,tags);onSave(video.id,tags);setDirty(false);};
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
        <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase"}}>Tags</div>
        {dirty&&<button onClick={save} style={{background:"#1D9E75",border:"none",borderRadius:4,padding:"2px 9px",color:"#fff",fontSize:10,cursor:"pointer",fontWeight:700}}>Save</button>}
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8,minHeight:24}}>
        {tags.map(t=><span key={t} onClick={()=>rem(t)} style={{background:"#1E3A5A",color:"#7DD3FC",fontSize:10,borderRadius:4,padding:"2px 7px",cursor:"pointer",display:"flex",gap:3,alignItems:"center"}}>#{t}<span style={{color:"#EF4444",fontSize:9}}>×</span></span>)}
        {!tags.length&&<span style={{fontSize:10,color:"#334155"}}>No tags</span>}
      </div>
      <div style={{display:"flex",gap:5}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()} placeholder="Add tag…" style={{flex:1,background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 8px",color:"#E2E8F0",fontSize:11,fontFamily:"monospace",outline:"none"}}/>
        <button onClick={add} style={{background:"#06B6D4",border:"none",borderRadius:5,padding:"5px 11px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>+</button>
      </div>
    </div>
  );
}

// Sync nudge control
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

// StartTimeEditor — the key link between video timeline and log/event data
function StartTimeEditor({video, logData, onSave}){
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const toLocal = utc => utc ? new Date(utc).toISOString().slice(0,19) : "";
  const fromLocal = s => s ? new Date(s+"Z").getTime() : null;
  const suggested = video.startUtc
    ? toLocal(video.startUtc)
    : logData?.startUtc ? toLocal(logData.startUtc) : "";
  const open = () => { setVal(suggested); setEditing(true); };
  const save = () => { const utc=fromLocal(val); if(utc&&!isNaN(utc)) onSave(video.id,utc); setEditing(false); };
  const hasStart = !!video.startUtc;
  const inLog = hasStart && logData?.rows?.length &&
    video.startUtc >= logData.startUtc &&
    video.startUtc <= logData.endUtc;
  return (
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:`1px solid ${!hasStart?"#EF444440":inLog?"#1D9E7540":"#F59E0B40"}`,marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:3}}>Video start time (UTC)</div>
          {hasStart
            ? <div style={{fontSize:11,fontFamily:"monospace",color:inLog?"#1D9E75":"#F59E0B"}}>
                {new Date(video.startUtc).toISOString().slice(11,19)} UTC
                <span style={{fontSize:9,marginLeft:6}}>{inLog?"✓ within log":logData?"⚠ outside log — adjust":"(no log)"}</span>
              </div>
            : <div style={{fontSize:10,color:"#EF4444"}}>Not set — instruments and events won't show</div>
          }
        </div>
        <button onClick={editing?save:open} style={{background:editing?"#1D9E75":"#1E3A5A",border:"none",borderRadius:4,padding:"3px 9px",color:editing?"#fff":"#94A3B8",cursor:"pointer",fontSize:10,fontWeight:editing?700:400,marginLeft:8,flexShrink:0}}>
          {editing?"Save":"Edit"}
        </button>
      </div>
      {editing && (
        <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:6}}>
          <input type="datetime-local" step="1" value={val} onChange={e=>setVal(e.target.value)}
            style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 8px",color:"#E2E8F0",fontSize:11,fontFamily:"monospace",outline:"none",width:"100%",boxSizing:"border-box"}}/>
          {logData?.startUtc && (
            <div style={{display:"flex",gap:5}}>
              <button onClick={()=>setVal(toLocal(logData.startUtc))} style={{flex:1,background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:4,padding:"4px 0",color:"#7DD3FC",cursor:"pointer",fontSize:10}}>
                Log start {new Date(logData.startUtc).toISOString().slice(11,16)}
              </button>
              {logData.endUtc && <button onClick={()=>setVal(toLocal(Math.round((logData.startUtc+logData.endUtc)/2)))} style={{flex:1,background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:4,padding:"4px 0",color:"#7DD3FC",cursor:"pointer",fontSize:10}}>
                Midpoint
              </button>}
            </div>
          )}
          <div style={{fontSize:9,color:"#334155"}}>Enter when this clip started recording (UTC). Most cameras set file time = end of clip, so start ≈ file time − duration.</div>
        </div>
      )}
    </div>
  );
}

// Upload tab — two-step: local save → cloud push
function UploadTab({role,cloudStatus,onImported}){
  const perms=ROLES[role];
  const vidRef=useRef(null),csvRef=useRef(null),xmlRef=useRef(null);
  const[pendingVids,setPendingVids]=useState([]);
  const[csvParsed,setCsvParsed]=useState(null);
  const[xmlParsed,setXmlParsed]=useState(null);
  const[csvFile,setCsvFile]=useState(null);
  const[xmlFile,setXmlFile]=useState(null);
  const[dragOver,setDragOver]=useState(false);
  const[phase,setPhase]=useState("idle");
  const[log,setLog]=useState([]);
  const[savedDate,setSavedDate]=useState(null);
  const[savedVids,setSavedVids]=useState([]);
  const[streamStatus,setStreamStatus]=useState({});

  const addLog=msg=>setLog(p=>[...p.slice(-30),msg]);

  const handleVids=useCallback(files=>{
    const valid=Array.from(files).filter(f=>f.type.startsWith("video/")||/\.(mp4|mov|mts|avi|mkv|m4v)$/i.test(f.name));
    if(!valid.length){addLog("✕ No video files found. MP4/MOV/MTS/AVI accepted.");return;}
    setPendingVids(p=>[...p,...valid.map(f=>({
      id:Math.random().toString(36).slice(2),
      file:f, name:f.name, size:f.size,
      url:URL.createObjectURL(f),
      duration:null,
      startUtc:null,      // filled by extractVideoCreationTime below
      tsSource:null,      // "mp4-meta" | "lastmodified" | null
    }))]);
    addLog(`✓ ${valid.length} video${valid.length>1?"s":""} queued — reading timestamps…`);
    // Extract creation_time from each file's MP4/MOV atom (async, non-blocking)
    valid.forEach(async f=>{
      const id=f.name+f.size; // temporary key to match
      const mp4ts=await extractVideoCreationTime(f);
      setPendingVids(p=>p.map(v=>{
        if(v.file!==f)return v;
        if(mp4ts){
          addLog(`✓ ${f.name}: camera timestamp ${new Date(mp4ts).toISOString().slice(11,19)} UTC`);
          return{...v,startUtc:mp4ts,tsSource:"mp4-meta"};
        }
        // Fallback: file.lastModified — reliable on iOS/GoPro SD cards when copied
        // but unreliable if file was downloaded or sent via messaging app
        if(f.lastModified&&v.duration){
          const ts=f.lastModified-v.duration*1000;
          addLog(`✓ ${f.name}: using file modified time (camera metadata not found)`);
          return{...v,startUtc:ts,tsSource:"lastmodified"};
        }
        addLog(`⚠ ${f.name}: no timestamp found — set manually in Library`);
        return v;
      }));
    });
  },[]);

  const handleCsv=useCallback(file=>{
    if(!file)return;setCsvFile(file);
    const r=new FileReader();r.onload=e=>{try{const p=parseCsvLog(e.target.result);setCsvParsed(p);addLog(`✓ Log: ${p.rows.length.toLocaleString()} rows · ${file.name}`);}catch(err){addLog(`✕ CSV: ${err.message}`);}};r.readAsText(file);
  },[]);

  const handleXml=useCallback(file=>{
    if(!file)return;setXmlFile(file);
    const r=new FileReader();r.onload=e=>{try{const p=parseXmlEvents(e.target.result);setXmlParsed(p);addLog(`✓ Events: ${p.tackJibes.length} tack/gybes · ${p.markRoundings.length} marks · ${file.name}`);}catch(err){addLog(`✕ XML: ${err.message}`);}};r.readAsText(file);
  },[]);

  const saveLocal=async()=>{
    if(!pendingVids.length&&!csvParsed&&!xmlParsed)return;
    setPhase("saving");setLog([]);
    const date=csvParsed?.startUtc?new Date(csvParsed.startUtc).toISOString().slice(0,10):xmlParsed?.meta?.date||TODAY();
    addLog(`Saving session ${date} to local storage…`);
    if(csvParsed){await saveLogData(date,csvParsed.rows,csvFile.name,csvParsed.startUtc,csvParsed.endUtc);addLog(`✓ Log saved (${csvParsed.rows.length.toLocaleString()} rows)`);}
    if(xmlParsed){saveXmlData(date,xmlParsed,xmlFile.name);addLog("✓ Events saved");}
    const saved=[];
    for(const pv of pendingVids){
      const tags=computeAutoTags(pv.startUtc,pv.duration,csvParsed,xmlParsed);
      const tsLabel=pv.tsSource==="mp4-meta"?"📷 camera meta":pv.tsSource==="lastmodified"?"⚠ file mtime":"❌ no timestamp";
      try{const s=await saveVideo(pv.file,{duration:pv.duration,startUtc:pv.startUtc,tsSource:pv.tsSource,tags,title:pv.name.replace(/\.[^.]+$/,"").replace(/[_-]/g," "),sessionDate:date});saved.push({...s,file:pv.file});addLog(`✓ ${pv.name} · ${tsLabel}${pv.startUtc?` · ${new Date(pv.startUtc).toISOString().slice(11,19)} UTC`:""}`);}
      catch(e){addLog(`✕ ${pv.name}: ${e.message}`);}
    }
    setSavedDate(date);setSavedVids(saved);
    addLog(cloudStatus?.available&&perms.canSync?"Saved. Click Push to Cloud to upload.":"Saved to local storage. Ready in Library.");
    setPhase("saved");
    onImported({date,videos:saved,logData:csvParsed,xmlData:xmlParsed});
  };

  const pushCloud=async()=>{
    if(!cloudStatus?.available||!perms.canSync||!savedDate)return;
    setPhase("syncing");addLog("Starting Bunny Storage + Stream upload…");
    savedVids.forEach(v=>setStreamStatus(p=>({...p,[v.id]:{state:"queued"}})));
    await syncSessionToCloud(savedDate,await getLogData(savedDate),getXmlData(savedDate),savedVids,msg=>{
      addLog(msg);
      // Extract stream IDs from status messages to track per-video
      const match=msg.match(/Stream \(([a-f0-9]+)\)/);
      if(match){const sid=match[1];const vid=savedVids.find(v=>v.name&&msg.includes(v.name));if(vid)setStreamStatus(p=>({...p,[vid.id]:{state:"processing",streamId:sid}}));}
    });
    setPhase("done");addLog("Bunny sync complete. Stream videos processing in background…");
    // Poll each video's stream status
    savedVids.forEach(async v=>{
      const st=streamStatus[v.id];if(!st?.streamId)return;
      const result=await waitForStreamReady(st.streamId,300000);
      setStreamStatus(p=>({...p,[v.id]:{...p[v.id],state:result?"ready":"timeout",playbackUrl:result?.playbackUrl}}));
      addLog(result?`✓ ${v.name} ready — HLS available`:`⚠ ${v.name} stream timeout`);
    });
  };

  const reset=()=>{setPendingVids([]);setCsvParsed(null);setXmlParsed(null);setCsvFile(null);setXmlFile(null);setPhase("idle");setLog([]);setSavedDate(null);setSavedVids([]);setStreamStatus({});};

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
                      // If we already have a good mp4-meta timestamp, just update duration
                      if(x.tsSource==="mp4-meta")return{...x,duration:dur};
                      // lastModified fallback: only reliable if tsSource not yet set
                      const ts=x.file?.lastModified?x.file.lastModified-dur*1000:null;
                      return{...x,duration:dur,startUtc:x.startUtc||ts,tsSource:x.tsSource||(ts?"lastmodified":null)};
                    }));
                  }}/>
                  <div style={{flex:1,minWidth:0}}><div style={{fontSize:11,fontWeight:500,color:"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.name}</div><div style={{fontSize:10,color:"#475569"}}>{fmtSize(v.size)}{v.duration?` · ${fmtT(v.duration)}`:""}</div></div>
                  <button onClick={()=>setPendingVids(p=>p.filter(x=>x.id!==v.id))} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:15}}>×</button>
                </div>
              ))}
            </div>
            {/* CSV + XML */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              {[{label:"Expedition log (CSV)",ref:csvRef,file:csvFile,parsed:csvParsed,accept:".csv,text/csv",onChange:e=>handleCsv(e.target.files[0]),detail:csvParsed?`${csvParsed.rows.length.toLocaleString()} rows`:null,color:"#1D9E75"},
                {label:"Event file (XML)",ref:xmlRef,file:xmlFile,parsed:xmlParsed,accept:".xml,text/xml",onChange:e=>handleXml(e.target.files[0]),detail:xmlParsed?`${xmlParsed.tackJibes.length} T/G · ${xmlParsed.markRoundings.length} marks`:null,color:"#8B5CF6"}]
                .map(({label,ref,file,parsed,accept,onChange,detail,color})=>(
                  <div key={label} style={{background:"#0A1929",border:`1px solid ${parsed?color:"#1E3A5A"}`,borderRadius:10,padding:14}}>
                    <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>{label}</div>
                    <input ref={ref} type="file" accept={accept} style={{display:"none"}} onChange={onChange}/>
                    <button onClick={()=>ref.current?.click()} style={{width:"100%",background:parsed?`${color}12`:"#071624",border:`1px solid ${parsed?color:"#1E3A5A"}`,borderRadius:6,padding:"9px 0",color:parsed?color:"#7DD3FC",cursor:"pointer",fontSize:11}}>{parsed?`✓ ${file.name}`:"Choose file"}</button>
                    {detail&&<div style={{marginTop:6,fontSize:10,color:"#475569"}}>{detail}</div>}
                  </div>
                ))}
            </div>
            {(pendingVids.length>0||csvParsed||xmlParsed)&&(
              <button onClick={saveLocal} disabled={phase==="saving"} style={{background:phase==="saving"?"#1E3A5A":"#06B6D4",border:"none",borderRadius:10,padding:"13px",color:phase==="saving"?"#64748B":"#000",fontWeight:700,fontSize:14,cursor:phase==="saving"?"default":"pointer",width:"100%"}}>
                {phase==="saving"?"Saving to local storage…":`① Save locally — ${pendingVids.length>0?`${pendingVids.length} video${pendingVids.length>1?"s":""}`:""} ${csvParsed?"+ log":""} ${xmlParsed?"+ events":""}`}
              </button>
            )}
          </>
        ):(
          <div style={{background:"#0A1929",border:"1px solid #1D9E7540",borderRadius:12,padding:18}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <SrcBadge source="local"/><span style={{fontSize:12,fontWeight:600,color:"#1D9E75"}}>Session {savedDate} saved locally</span>
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
              {(phase==="syncing"||phase==="done")&&savedVids.length>0&&(
                <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:10}}>
                  {savedVids.map(v=>{const st=streamStatus[v.id];return(
                    <div key={v.id} style={{display:"flex",alignItems:"center",gap:8,background:"#071624",borderRadius:6,padding:"6px 10px"}}>
                      <div style={{flex:1,minWidth:0,fontSize:10,color:"#94A3B8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.name}</div>
                      <SrcBadge source={st?.state==="ready"?"cloud":st?.state==="processing"?"processing":"local"}/>
                      {st?.streamId&&<span style={{fontSize:8,color:"#334155",fontFamily:"monospace"}}>{st.streamId.slice(0,8)}…</span>}
                    </div>
                  );})}
                </div>
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

// Main App
// ─── ANALYTICS CHARTS (pure SVG, no dependencies) ────────────────────────────

// Thin line chart: array of {x,y} normalised 0-1, with axis labels
// ─── CHART PRIMITIVES ────────────────────────────────────────────────────────

// Linear regression: returns {slope, intercept, r2}
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

// Time-series line chart with optional trend line overlay
function LineChart({points,color="#06B6D4",width=400,height=120,yLabel="",yMin,yMax,yLines=[],showTrend=false}){
  if(!points?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No data</div>;
  const pad={t:14,r:8,b:28,l:36};
  const W=width-pad.l-pad.r, H=height-pad.t-pad.b;
  const xs=points.map(p=>p.x), ys=points.map(p=>p.y);
  const x0=Math.min(...xs),x1=Math.max(...xs);
  const y0=yMin??Math.min(...ys),y1=yMax??Math.max(...ys);
  const px=x=>pad.l+((x-x0)/(x1-x0||1))*W;
  const py=y=>pad.t+H-((y-y0)/(y1-y0||1))*H;
  const d=points.map((p,i)=>`${i===0?"M":"L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const xTicks=Array.from({length:5},(_,i)=>x0+(x1-x0)*i/4);
  const yTicks=Array.from({length:4},(_,i)=>y0+(y1-y0)*i/3);
  // Trend line using normalised x to avoid float precision issues
  const reg=showTrend?linReg(points.map(p=>({x:(p.x-x0)/(x1-x0||1),y:p.y}))):null;
  const ty=t=>reg?reg.slope*t+reg.intercept:0;
  return(
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{overflow:"visible"}}>
      {yTicks.map((y,i)=><line key={i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke="#0F2030" strokeWidth="1"/>)}
      {yLines.map((y,i)=><line key={"r"+i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke={color} strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5"/>)}
      <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
      <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" opacity="0.9"/>
      {reg&&<line x1={px(x0)} y1={py(ty(0))} x2={px(x1)} y2={py(ty(1))} stroke="#fff" strokeWidth="1" strokeDasharray="4,3" opacity="0.5"/>}
      {reg&&<text x={pad.l+W-2} y={pad.t+6} textAnchor="end" fontSize="8" fill="#64748B">R²={reg.r2.toFixed(2)}</text>}
      {yTicks.map((y,i)=><text key={i} x={pad.l-4} y={py(y)+3} textAnchor="end" fontSize="8" fill="#475569">{y.toFixed(y<10?1:0)}</text>)}
      {xTicks.map((x,i)=><text key={i} x={px(x)} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill="#475569">{new Date(x).toISOString().slice(11,16)}</text>)}
      {yLabel&&<text x={8} y={pad.t+H/2} textAnchor="middle" fontSize="8" fill="#475569" transform={`rotate(-90,8,${pad.t+H/2})`}>{yLabel}</text>}
    </svg>
  );
}

// X-Y scatter plot with optional trend line — the core of goal 2
function XYPlot({points,xLabel="",yLabel="",color="#06B6D4",width=400,height=200,showTrend=true,title=""}){
  if(!points?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No data</div>;
  const pad={t:title?20:10,r:8,b:28,l:36};
  const W=width-pad.l-pad.r, H=height-pad.t-pad.b;
  const xs=points.map(p=>p.x), ys=points.map(p=>p.y);
  const x0=Math.min(...xs),x1=Math.max(...xs);
  const y0=Math.min(...ys),y1=Math.max(...ys);
  const px=x=>pad.l+((x-x0)/(x1-x0||1))*W;
  const py=y=>pad.t+H-((y-y0)/(y1-y0||1))*H;
  // Downsample dots for rendering (max 800)
  const step=Math.max(1,Math.floor(points.length/800));
  const dots=points.filter((_,i)=>i%step===0);
  const xTicks=Array.from({length:5},(_,i)=>x0+(x1-x0)*i/4);
  const yTicks=Array.from({length:4},(_,i)=>y0+(y1-y0)*i/3);
  const reg=showTrend?linReg(points):null;
  const ty=x=>reg?reg.slope*x+reg.intercept:0;
  return(
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{overflow:"visible"}}>
      {title&&<text x={pad.l+W/2} y={10} textAnchor="middle" fontSize="9" fill="#64748B" fontWeight="600">{title}</text>}
      {yTicks.map((y,i)=><line key={i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke="#0F2030" strokeWidth="1"/>)}
      <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
      <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
      {dots.map((p,i)=><circle key={i} cx={px(p.x)} cy={py(p.y)} r="1.5" fill={color} opacity="0.5"/>)}
      {reg&&<line x1={px(x0)} y1={py(ty(x0))} x2={px(x1)} y2={py(ty(x1))} stroke="#fff" strokeWidth="1.5" strokeDasharray="5,3" opacity="0.7"/>}
      {reg&&<text x={pad.l+W-2} y={pad.t+10} textAnchor="end" fontSize="8" fill="#64748B">R²={reg.r2.toFixed(2)}</text>}
      {yTicks.map((y,i)=><text key={i} x={pad.l-4} y={py(y)+3} textAnchor="end" fontSize="8" fill="#475569">{y.toFixed(1)}</text>)}
      {xTicks.map((x,i)=><text key={i} x={px(x)} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill="#475569">{x.toFixed(1)}</text>)}
      {xLabel&&<text x={pad.l+W/2} y={height-1} textAnchor="middle" fontSize="8" fill="#475569">{xLabel}</text>}
      {yLabel&&<text x={8} y={pad.t+H/2} textAnchor="middle" fontSize="8" fill="#475569" transform={`rotate(-90,8,${pad.t+H/2})`}>{yLabel}</text>}
    </svg>
  );
}

// Render a chart spec returned by AI — goal 3
// spec: { type:"xy"|"line"|"bar", title, xField, yField, xLabel, yLabel, color, filter }
function AIChart({spec,rows,allVideos}){
  if(!spec)return null;
  const c=spec.color||"#8B5CF6";

  if(spec.type==="xy"&&rows?.length){
    // Scatter plot of two log fields
    const xf=spec.xField, yf=spec.yField;
    const pts=rows
      .filter(r=>r[xf]!=null&&r[yf]!=null&&(spec.filter?eval(`(r)=>${spec.filter}`)(r):true))
      .map(r=>({x:r[xf],y:r[yf]}));
    return(
      <div style={{background:"#0A1929",border:`1px solid ${c}30`,borderRadius:10,padding:14,marginBottom:10}}>
        <XYPlot points={pts} xLabel={spec.xLabel||xf} yLabel={spec.yLabel||yf} color={c} width={520} height={200} title={spec.title} showTrend/>
      </div>
    );
  }

  if(spec.type==="line"&&rows?.length){
    const yf=spec.yField;
    const step=Math.max(1,Math.floor(rows.length/400));
    const pts=rows.filter((_,i)=>i%step===0).filter(r=>r[yf]!=null).map(r=>({x:r.utc,y:r[yf]}));
    return(
      <div style={{background:"#0A1929",border:`1px solid ${c}30`,borderRadius:10,padding:14,marginBottom:10}}>
        <div style={{fontSize:10,color:c,fontWeight:600,marginBottom:6}}>{spec.title}</div>
        <LineChart points={pts} color={c} height={130} yLabel={spec.yLabel||yf} showTrend/>
      </div>
    );
  }

  if(spec.type==="bar"&&allVideos?.length){
    // Bar chart across clips — e.g. twsAvg or polpercAvg per clip
    const field=spec.xField||"twsAvg";
    const clips=allVideos.filter(v=>v[field]!=null).slice(0,12);
    if(!clips.length)return<div style={{fontSize:10,color:"#334155"}}>No clip data for this field</div>;
    const maxV=Math.max(...clips.map(v=>v[field]));
    const W=520,H=160,pad={t:16,r:8,b:40,l:40};
    const bw=(W-pad.l-pad.r)/clips.length-3;
    return(
      <div style={{background:"#0A1929",border:`1px solid ${c}30`,borderRadius:10,padding:14,marginBottom:10}}>
        <div style={{fontSize:10,color:c,fontWeight:600,marginBottom:6}}>{spec.title}</div>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
          {clips.map((v,i)=>{
            const bh=((v[field]||0)/maxV)*(H-pad.t-pad.b);
            const x=pad.l+i*(bw+3);
            return(<g key={v.id}>
              <rect x={x} y={H-pad.b-bh} width={bw} height={bh} fill={c} rx="2" opacity="0.8"/>
              <text x={x+bw/2} y={H-pad.b+12} textAnchor="middle" fontSize="7" fill="#475569"
                transform={`rotate(-35,${x+bw/2},${H-pad.b+12})`}>
                {v.title?.slice(0,10)}
              </text>
              <text x={x+bw/2} y={H-pad.b-bh-3} textAnchor="middle" fontSize="8" fill={c}>
                {R(v[field])}
              </text>
            </g>);
          })}
          <line x1={pad.l} x2={W-pad.r} y1={H-pad.b} y2={H-pad.b} stroke="#1E3A5A" strokeWidth="1"/>
          <text x={pad.l+((W-pad.l-pad.r)/2)} y={H-2} textAnchor="middle" fontSize="8" fill="#475569">{spec.xLabel}</text>
          <text x={8} y={(H-pad.t-pad.b)/2+pad.t} textAnchor="middle" fontSize="8" fill="#475569" transform={`rotate(-90,8,${(H-pad.t-pad.b)/2+pad.t})`}>{spec.yLabel}</text>
        </svg>
      </div>
    );
  }

  return<div style={{fontSize:10,color:"#EF4444"}}>Chart type "{spec.type}" not recognised</div>;
}

// Scatter polar chart: TWA (0-180 each side) vs BSP
function SpeedPolar({rows,width=320,height=320}){
  if(!rows?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No log data</div>;
  const cx=width/2, cy=height/2, maxR=cx-24;
  const maxBsp=Math.max(...rows.map(r=>r.bsp||0),12);
  // Bin by TWA (0-180) and TWS range
  const colors={"0-8":"#7DD3FC","8-12":"#06B6D4","12-16":"#8B5CF6","16-20":"#F59E0B","20+":"#EF4444"};
  const twsBin=tws=>tws<8?"0-8":tws<12?"8-12":tws<16?"12-16":tws<20?"16-20":"20+";
  const dots=rows.filter(r=>r.bsp>0.5&&r.twa!=null).map(r=>{
    const twa=Math.abs(r.twa)*Math.PI/180;
    const r2=(r.bsp/maxBsp)*maxR;
    const side=r.twa>=0?1:-1;
    return{x:cx+side*Math.sin(twa)*r2, y:cy-Math.cos(twa)*r2, bin:twsBin(r.tws)};
  });
  // Rings
  const rings=[0.25,0.5,0.75,1].map(f=>f*maxBsp);
  return(
    <svg width="100%" viewBox={`0 0 ${width} ${height}`}>
      {/* Rings */}
      {rings.map((b,i)=><circle key={i} cx={cx} cy={cy} r={(b/maxBsp)*maxR} fill="none" stroke="#0F2030" strokeWidth="1"/>)}
      {rings.map((b,i)=><text key={i} x={cx+4} y={cy-(b/maxBsp)*maxR-2} fontSize="7" fill="#334155">{b.toFixed(0)}kt</text>)}
      {/* Axes */}
      <line x1={cx} x2={cx} y1={8} y2={height-8} stroke="#1E3A5A" strokeWidth="0.5"/>
      <line x1={8} x2={width-8} y1={cy} y2={cy} stroke="#1E3A5A" strokeWidth="0.5"/>
      {/* Angle lines */}
      {[45,90,135].map(a=>{const r=a*Math.PI/180;return(<g key={a}><line x1={cx} y1={cy} x2={cx+Math.sin(r)*maxR} y2={cy-Math.cos(r)*maxR} stroke="#0F2030" strokeWidth="0.5"/><line x1={cx} y1={cy} x2={cx-Math.sin(r)*maxR} y2={cy-Math.cos(r)*maxR} stroke="#0F2030" strokeWidth="0.5"/><text x={cx+Math.sin(r)*(maxR+12)} y={cy-Math.cos(r)*(maxR+12)} textAnchor="middle" fontSize="8" fill="#334155">{a}°</text></g>);})}
      {/* Data points */}
      {dots.map((d,i)=><circle key={i} cx={d.x} cy={d.y} r="1.2" fill={colors[d.bin]} opacity="0.6"/>)}
      {/* Labels */}
      <text x={cx} y={12} textAnchor="middle" fontSize="8" fill="#475569">0° (head)</text>
      <text x={cx} y={height-4} textAnchor="middle" fontSize="8" fill="#475569">180° (run)</text>
      {/* Legend */}
      {Object.entries(colors).map(([k,c],i)=><g key={k}><rect x={8} y={height-60+i*10} width="8" height="6" fill={c} rx="1"/><text x={19} y={height-55+i*10} fontSize="7" fill="#475569">{k} kn</text></g>)}
    </svg>
  );
}

// Bar chart for tack/gybe quality
function ManoeuvreChart({tackJibes,logRows,width=400,height=140}){
  if(!tackJibes?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No manoeuvre data</div>;
  const valid=tackJibes.filter(t=>t.isValid!==false);
  const tacks=valid.filter(t=>t.isTack).length;
  const gybes=valid.filter(t=>!t.isTack).length;
  const invalid=tackJibes.length-valid.length;
  const pad={t:14,r:12,b:30,l:40};
  const W=width-pad.l-pad.r, H=height-pad.t-pad.b;
  // TWS at each manoeuvre
  const twsBins={"<8":0,"8-12":0,"12-16":0,"16-20":0,"20+":0};
  if(logRows?.length){
    valid.forEach(tj=>{
      const nearest=logRows.reduce((a,b)=>Math.abs(b.utc-tj.utc)<Math.abs(a.utc-tj.utc)?b:a,logRows[0]);
      const tws=nearest?.tws||0;
      if(tws<8)twsBins["<8"]++;else if(tws<12)twsBins["8-12"]++;else if(tws<16)twsBins["12-16"]++;else if(tws<20)twsBins["16-20"]++;else twsBins["20+"]++;
    });
  }
  const bins=Object.entries(twsBins);
  const maxVal=Math.max(...bins.map(([,v])=>v),1);
  const bw=W/bins.length-4;
  return(
    <svg width="100%" viewBox={`0 0 ${width} ${height}`}>
      {/* Summary text */}
      <text x={pad.l} y={10} fontSize="9" fill="#06B6D4">{tacks} tacks</text>
      <text x={pad.l+60} y={10} fontSize="9" fill="#8B5CF6">{gybes} gybes</text>
      {invalid>0&&<text x={pad.l+120} y={10} fontSize="9" fill="#EF4444">{invalid} invalid</text>}
      {/* Bars */}
      {bins.map(([label,val],i)=>{
        const x=pad.l+i*(bw+4);
        const barH=(val/maxVal)*H;
        return(<g key={label}>
          <rect x={x} y={pad.t+H-barH} width={bw} height={barH} fill="#06B6D4" rx="2" opacity="0.8"/>
          <text x={x+bw/2} y={pad.t+H+10} textAnchor="middle" fontSize="8" fill="#475569">{label}</text>
          {val>0&&<text x={x+bw/2} y={pad.t+H-barH-3} textAnchor="middle" fontSize="8" fill="#06B6D4">{val}</text>}
        </g>);
      })}
      <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
      <text x={pad.l+W/2} y={height-2} textAnchor="middle" fontSize="8" fill="#475569">TWS at manoeuvre (kn)</text>
    </svg>
  );
}

// Performance charts: polar % and target % over time
function PerfChart({rows,width=400,height=110}){
  if(!rows?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No data</div>;
  const validPol=rows.filter(r=>r.vsPerfPct>5&&r.vsPerfPct<200);
  const validTgt=rows.filter(r=>r.vsTargPct>5&&r.vsTargPct<200);
  if(!validPol.length&&!validTgt.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No performance data in log</div>;
  const step=Math.max(1,Math.floor(rows.length/300));
  const polPts=validPol.filter((_,i)=>i%step===0).map(r=>({x:r.utc,y:r.vsPerfPct}));
  const tgtPts=validTgt.filter((_,i)=>i%step===0).map(r=>({x:r.utc,y:r.vsTargPct}));
  // Render both lines on one SVG
  const pad={t:14,r:8,b:28,l:36};
  const W=width-pad.l-pad.r, H=height-pad.t-pad.b;
  const allPts=[...polPts,...tgtPts];
  if(!allPts.length)return null;
  const x0=Math.min(...allPts.map(p=>p.x)),x1=Math.max(...allPts.map(p=>p.x));
  const y0=50,y1=150;
  const px=x=>pad.l+((x-x0)/(x1-x0||1))*W;
  const py=y=>pad.t+H-((y-y0)/(y1-y0))*H;
  const line=(pts,color)=>pts.length<2?"":pts.map((p,i)=>`${i===0?"M":"L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const xTicks=Array.from({length:5},(_,i)=>x0+(x1-x0)*i/4);
  const yTicks=[60,80,100,120,140];
  return(
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{overflow:"visible"}}>
      {yTicks.map(y=><line key={y} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke={y===100?"#475569":"#0F2030"} strokeWidth={y===100?"1":"0.5"} strokeDasharray={y===100?"4,2":"none"}/>)}
      <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
      <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
      {polPts.length>1&&<path d={line(polPts,"#F59E0B")} fill="none" stroke="#F59E0B" strokeWidth="1.5" strokeLinejoin="round" opacity="0.9"/>}
      {tgtPts.length>1&&<path d={line(tgtPts,"#10B981")} fill="none" stroke="#10B981" strokeWidth="1.5" strokeLinejoin="round" opacity="0.7"/>}
      {yTicks.map(y=><text key={y} x={pad.l-4} y={py(y)+3} textAnchor="end" fontSize="8" fill="#475569">{y}</text>)}
      {xTicks.map((x,i)=><text key={i} x={px(x)} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill="#475569">{new Date(x).toISOString().slice(11,16)}</text>)}
      {/* Legend */}
      {polPts.length>0&&<><rect x={pad.l+4} y={4} width="8" height="5" fill="#F59E0B" rx="1"/><text x={pad.l+15} y={9} fontSize="8" fill="#F59E0B">Polar %</text></>}
      {tgtPts.length>0&&<><rect x={pad.l+60} y={4} width="8" height="5" fill="#10B981" rx="1"/><text x={pad.l+71} y={9} fontSize="8" fill="#10B981">Target %</text></>}
    </svg>
  );
}

// ─── AI CHART CHAT ────────────────────────────────────────────────────────────
// Sends natural language questions to Claude; Claude returns a chart spec + text.
// Available log fields: tws, twa, bsp, sog, vmg, heel, vsTargPct, vsPerfPct, rudder
// Available clip fields: twsAvg, twaAvg, vmgAvg, polpercAvg, vsTargPercAvg, sogAvg

const LOG_FIELDS = "tws (true wind speed kn), twa (true wind angle °), bsp (boat speed kn), sog (speed over ground kn), vmg (velocity made good kn), heel (heel angle °), vsTargPct (% of target speed col23), vsPerfPct (% of polar speed col26), rudder (rudder angle °)";
const CLIP_FIELDS = "twsAvg, twaAvg, vmgAvg, polpercAvg, vsTargPercAvg, sogAvg, heelAvg";

const CHART_SYSTEM = `You are a sailing data analyst AI for SmartSailingAnalytics.
The user has log data (1 Hz rows with fields: ${LOG_FIELDS}) and clip summaries (fields: ${CLIP_FIELDS}).
When the user asks a question, respond with JSON ONLY — no markdown, no explanation outside JSON.
Return: {
  "answer": "brief natural language answer (1-3 sentences)",
  "chart": {                   // optional — omit if no chart is useful
    "type": "xy" | "line" | "bar",
    "title": "chart title",
    "xField": "field name for X axis",   // for xy: log field; for bar: clip field
    "yField": "field name for Y axis",   // for xy and line: log field
    "xLabel": "axis label",
    "yLabel": "axis label",
    "color": "#hexcolor"
  },
  "insight": "one actionable coaching insight"
}
For "xy" charts use log row fields. For "bar" charts use clip fields (xField = clip field name).
For "line" charts yField is a log field plotted over time (x=utc is automatic).
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

    const history = messages.map(m=>({
      role: m.role==="user"?"user":"assistant",
      content: m.rawJson ? JSON.stringify(m.rawJson) : m.text,
    }));

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1000,
          system: CHART_SYSTEM,
          messages:[...history,{role:"user",content:q}],
        }),
      });
      const data = await res.json();
      const text = data.content?.find(b=>b.type==="text")?.text||"{}";
      const parsed = JSON.parse(text.replace(/```json|```/g,"").trim());
      setMessages(p=>[...p,{role:"assistant",text:parsed.answer||"",chart:parsed.chart,insight:parsed.insight,rawJson:parsed}]);
    } catch(e) {
      setMessages(p=>[...p,{role:"assistant",text:`Error: ${e.message}`}]);
    }
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

      {/* Suggestion pills */}
      {messages.length===0&&(
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:12}}>
          {[
            "Plot TWS vs SOG",
            "How does heel change with wind?",
            "Show polar % over time",
            "Compare VMG across clips",
            "Which TWA gives best VMG?",
            "Show rudder vs heel scatter",
          ].map(s=>(
            <button key={s} onClick={()=>{setInput(s);}} style={{background:"#071624",border:"1px solid #8B5CF640",borderRadius:5,padding:"4px 10px",color:"#8B5CF6",cursor:"pointer",fontSize:10}}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Message thread */}
      {messages.length>0&&(
        <div style={{maxHeight:480,overflowY:"auto",marginBottom:10,display:"flex",flexDirection:"column",gap:10}}>
          {messages.map((m,i)=>(
            <div key={i}>
              {m.role==="user"&&(
                <div style={{display:"flex",justifyContent:"flex-end"}}>
                  <div style={{background:"#1E3A5A",borderRadius:"8px 8px 2px 8px",padding:"6px 10px",fontSize:11,color:"#E2E8F0",maxWidth:"70%"}}>{m.text}</div>
                </div>
              )}
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

      {/* Input */}
      <div style={{display:"flex",gap:6}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!loading&&ask()}
          placeholder={hasData?"Ask about your sailing data e.g. 'plot TWS vs SOG'…":"Load a session in Library first"}
          disabled={!hasData||loading}
          style={{flex:1,background:"#071624",border:"1px solid #8B5CF640",borderRadius:6,padding:"7px 11px",color:"#E2E8F0",fontSize:11,outline:"none",opacity:hasData?1:0.4}}/>
        <button onClick={ask} disabled={!hasData||loading||!input.trim()}
          style={{background:loading||!input.trim()?"#1E3A5A":"#8B5CF6",border:"none",borderRadius:6,padding:"7px 14px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:11}}>
          {loading?"…":"Ask"}
        </button>
        {messages.length>0&&<button onClick={()=>setMessages([])} style={{background:"none",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 10px",color:"#475569",cursor:"pointer",fontSize:10}}>Clear</button>}
      </div>
    </div>
  );
}

// Main Analytics component
function AnalyticsTab({logData,xmlData,allVideos,sessions,selectedVideo,onSelectVideo,setActiveTab}){
  const [activeSession,setActiveSession]=useState(null); // null = use logData passed in

  // Use either the logData for the current session or picked session
  const rows=logData?.rows||[];
  const noData=!rows.length;

  // Downsample rows for timeline charts
  const step=Math.max(1,Math.floor(rows.length/400));
  const twsPts=rows.filter((_,i)=>i%step===0).map(r=>({x:r.utc,y:r.tws}));
  const sogPts=rows.filter((_,i)=>i%step===0).map(r=>({x:r.utc,y:r.sog}));
  const heelPts=rows.filter((_,i)=>i%step===0).map(r=>({x:r.utc,y:Math.abs(r.heel)}));

  // Session stats
  const twsAvg=rows.length?rows.reduce((s,r)=>s+r.tws,0)/rows.length:0;
  const sogAvg=rows.length?rows.reduce((s,r)=>s+r.sog,0)/rows.length:0;
  const sogMax=rows.length?Math.max(...rows.map(r=>r.sog)):0;
  const twsMax=rows.length?Math.max(...rows.map(r=>r.tws)):0;
  const vsTargRows=rows.filter(r=>r.vsTargPct>5&&r.vsTargPct<200);
  const vsTargAvg=vsTargRows.length?vsTargRows.reduce((s,r)=>s+r.vsTargPct,0)/vsTargRows.length:null;
  const vsPerfRows=rows.filter(r=>r.vsPerfPct>5&&r.vsPerfPct<200);
  const vsPerfAvg=vsPerfRows.length?vsPerfRows.reduce((s,r)=>s+r.vsPerfPct,0)/vsPerfRows.length:null;

  // Manoeuvre stats
  const tacks=(xmlData?.tackJibes||[]).filter(t=>t.isTack&&t.isValid!==false).length;
  const gybes=(xmlData?.tackJibes||[]).filter(t=>!t.isTack&&t.isValid!==false).length;
  const marks=(xmlData?.markRoundings||[]).filter(m=>m.isValid!==false).length;
  const topMarks=(xmlData?.markRoundings||[]).filter(m=>m.isTop&&m.isValid!==false).length;
  const durationH=rows.length?(rows[rows.length-1].utc-rows[0].utc)/3600000:0;

  const card=(label,val,unit,color)=>(
    <div style={{background:"#0A1929",border:`1px solid ${color}25`,borderRadius:8,padding:"12px 14px"}}>
      <div style={{fontSize:9,color:"#334155",letterSpacing:1,textTransform:"uppercase",marginBottom:3}}>{label}</div>
      <div style={{fontSize:22,fontWeight:700,color,fontFamily:"monospace"}}>{val}<span style={{fontSize:11,color:"#475569",marginLeft:3}}>{unit}</span></div>
    </div>
  );

  const section=(title,children)=>(
    <div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:"14px 16px",marginBottom:14}}>
      <div style={{fontSize:11,fontWeight:600,color:"#64748B",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>{title}</div>
      {children}
    </div>
  );

  return(
    <div style={{flex:1,overflowY:"auto",padding:16}}>
      <div style={{maxWidth:900,margin:"0 auto"}}>

        {/* Header */}
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
          <div style={{fontSize:15,fontWeight:600,color:"#E2E8F0"}}>Analytics</div>
          {logData&&<span style={{fontSize:10,color:logData.source==="local"?"#1D9E75":"#8B5CF6",background:logData.source==="local"?"#1D9E7510":"#8B5CF610",border:`1px solid ${logData.source==="local"?"#1D9E7530":"#8B5CF630"}`,borderRadius:3,padding:"2px 7px"}}>
            {logData.source==="local"?"● Local":"● Cloud"} log · {rows.length.toLocaleString()} rows · {durationH.toFixed(1)}h
          </span>}
          {!logData&&<span style={{fontSize:10,color:"#EF4444"}}>No log data loaded — select a session in Library</span>}
          <div style={{flex:1}}/>
          <button onClick={()=>setActiveTab("library")} style={{background:"none",border:"1px solid #1E3A5A",borderRadius:5,padding:"3px 10px",color:"#475569",cursor:"pointer",fontSize:10}}>← Library</button>
        </div>

        {noData ? (
          <div style={{textAlign:"center",padding:"50px 20px",color:"#334155"}}>
            <div style={{fontSize:32,marginBottom:12,opacity:0.3}}>📊</div>
            <div style={{fontSize:13,color:"#475569",marginBottom:6}}>No log data loaded</div>
            <div style={{fontSize:11,color:"#334155",marginBottom:6}}>
              Select a session in the Library sidebar — click any date to load its log and event data.
            </div>
            <div style={{fontSize:10,color:"#475569",marginBottom:16,maxWidth:360,margin:"0 auto 16px"}}>
              If you just imported data and don't see it here, your log file may have been too large for the old storage system. Re-import your CSV in the Upload tab — it will now save correctly to IndexedDB.
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"center"}}>
              <button onClick={()=>setActiveTab("library")} style={{background:"#06B6D4",border:"none",borderRadius:8,padding:"8px 20px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>Go to Library</button>
              <button onClick={()=>setActiveTab("upload")} style={{background:"#1E3A5A",border:"none",borderRadius:8,padding:"8px 20px",color:"#94A3B8",fontWeight:700,cursor:"pointer",fontSize:12}}>Re-import CSV</button>
            </div>
          </div>
        ) : (
          <>
            {/* KPI row */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
              {card("Avg TWS",R(twsAvg),"kn","#06B6D4")}
              {card("Max TWS",R(twsMax),"kn","#7DD3FC")}
              {card("Avg SOG",R(sogAvg),"kn","#10B981")}
              {card("Max SOG",R(sogMax),"kn","#34D399")}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
              {card("Tacks",tacks,"","#1D9E75")}
              {card("Gybes",gybes,"","#7F77DD")}
              {card("Polar %",vsPerfAvg?R(vsPerfAvg)+"%":"--","","#F59E0B")}
              {card("Target %",vsTargAvg?R(vsTargAvg)+"%":"--","","#EF4444")}
            </div>

            {/* TWS + SOG timeline */}
            {section("Wind & boat speed timeline",(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>TRUE WIND SPEED (kn)</div>
                  <LineChart points={twsPts} color="#06B6D4" height={110} yLabel="TWS kn" showTrend/>
                </div>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>SPEED OVER GROUND (kn)</div>
                  <LineChart points={sogPts} color="#10B981" height={110} yLabel="SOG kn" showTrend/>
                </div>
              </div>
            ))}

            {section("Heel & performance",(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>HEEL ANGLE (°)</div>
                  <LineChart points={heelPts} color="#F59E0B" height={110} yLabel="Heel °" showTrend/>
                </div>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>POLAR % &amp; TARGET %</div>
                  <PerfChart rows={rows} height={110}/>
                </div>
              </div>
            ))}

            {rows.length>50&&section("X-Y plots — correlations & trends",(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>TWS vs SOG</div>
                  <XYPlot points={rows.filter((_,i)=>i%3===0).filter(r=>r.tws>0&&r.sog>0).map(r=>({x:r.tws,y:r.sog}))} xLabel="TWS (kn)" yLabel="SOG (kn)" color="#06B6D4" height={170} showTrend/>
                </div>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>TWS vs Heel</div>
                  <XYPlot points={rows.filter((_,i)=>i%3===0).filter(r=>r.tws>0).map(r=>({x:r.tws,y:Math.abs(r.heel)}))} xLabel="TWS (kn)" yLabel="Heel (°)" color="#F59E0B" height={170} showTrend/>
                </div>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>TWS vs Polar %</div>
                  <XYPlot points={rows.filter((_,i)=>i%3===0).filter(r=>r.tws>0&&r.vsPerfPct>5&&r.vsPerfPct<200).map(r=>({x:r.tws,y:r.vsPerfPct}))} xLabel="TWS (kn)" yLabel="Polar %" color="#8B5CF6" height={170} showTrend/>
                </div>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>TWA vs VMG</div>
                  <XYPlot points={rows.filter((_,i)=>i%3===0).filter(r=>r.vmg>0&&r.twa!=null).map(r=>({x:Math.abs(r.twa),y:r.vmg}))} xLabel="TWA (°)" yLabel="VMG (kn)" color="#10B981" height={170} showTrend/>
                </div>
              </div>
            ))}

            {/* Speed polar */}
            {section("Speed polar — TWA vs BSP by wind range",(
              <div style={{display:"flex",gap:16,alignItems:"flex-start"}}>
                <SpeedPolar rows={rows} width={280} height={280}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:"#475569",marginBottom:10}}>
                    Each dot is one second of sailing. The radial distance = boat speed (BSP), the angle = true wind angle. Colour shows wind strength band.
                  </div>
                  {/* Polar summary by TWA zone */}
                  {[["Upwind (30-60°)",30,60],["Beam (60-120°)",60,120],["Downwind (120-180°)",120,180]].map(([label,lo,hi])=>{
                    const zone=rows.filter(r=>Math.abs(r.twa)>=lo&&Math.abs(r.twa)<hi);
                    const avgBsp=zone.length?zone.reduce((s,r)=>s+r.bsp,0)/zone.length:0;
                    const avgTws=zone.length?zone.reduce((s,r)=>s+r.tws,0)/zone.length:0;
                    const pct=rows.length?(zone.length/rows.length*100):0;
                    return(
                      <div key={label} style={{background:"#071624",borderRadius:6,padding:"8px 10px",marginBottom:6}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                          <span style={{fontSize:10,color:"#94A3B8"}}>{label}</span>
                          <span style={{fontSize:9,color:"#475569"}}>{pct.toFixed(0)}% of session</span>
                        </div>
                        <div style={{display:"flex",gap:16}}>
                          <span style={{fontSize:11,fontFamily:"monospace",color:"#10B981"}}>BSP {R(avgBsp)} kn</span>
                          <span style={{fontSize:11,fontFamily:"monospace",color:"#06B6D4"}}>TWS {R(avgTws)} kn</span>
                          <span style={{fontSize:11,fontFamily:"monospace",color:"#475569"}}>{zone.length.toLocaleString()} pts</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Tack/gybe analysis */}
            {xmlData?.tackJibes?.length>0&&section(`Manoeuvre analysis — ${xmlData.tackJibes.length} total`,(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>MANOEUVRES BY WIND STRENGTH</div>
                  <ManoeuvreChart tackJibes={xmlData.tackJibes} logRows={rows} width={360} height={130}/>
                </div>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:10,letterSpacing:1}}>MANOEUVRE BREAKDOWN</div>
                  {[
                    ["Valid tacks",tacks,"#1D9E75"],
                    ["Valid gybes",gybes,"#7F77DD"],
                    ["Top mark roundings",topMarks,"#EF4444"],
                    ["Leeward gates",marks-topMarks,"#8B5CF6"],
                    ["Invalid / flagged",(xmlData.tackJibes.length-tacks-gybes),"#475569"],
                  ].map(([label,val,color])=>(
                    <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid #0F2030"}}>
                      <span style={{fontSize:11,color:"#94A3B8"}}>{label}</span>
                      <span style={{fontSize:13,fontWeight:700,fontFamily:"monospace",color}}>{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Clips linked to this session */}
            {allVideos.filter(v=>v.twsAvg!=null).length>0&&section("Clips with instrument data",(
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {allVideos.filter(v=>v.twsAvg!=null).map(v=>(
                  <div key={v.id} onClick={()=>{onSelectVideo(v);setActiveTab("library");}}
                    style={{display:"flex",alignItems:"center",gap:10,background:"#071624",borderRadius:6,padding:"7px 10px",cursor:"pointer",border:"1px solid #1E3A5A"}}>
                    <div style={{fontSize:10,color:"#E2E8F0",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.title}</div>
                    {[
                      ["TWS", v.twsAvg,        "kt",  "#06B6D4"],
                      ["TWA", v.twaAvg,         "°",  "#8B5CF6"],
                      ["VMG", v.vmgAvg,         "kt", "#10B981"],
                      ["Pol", v.polpercAvg,     "%",  "#F59E0B"],
                      ["Tgt", v.vsTargPercAvg,  "%",  "#EF4444"],
                    ].map(([l,val,u,c])=>(
                      <div key={l} style={{textAlign:"center",minWidth:42}}>
                        <div style={{fontSize:8,color:"#334155"}}>{l}</div>
                        <div style={{fontSize:11,fontWeight:700,color:c,fontFamily:"monospace"}}>{val!=null?R(val):"--"}{u}</div>
                      </div>
                    ))}
                    <div style={{fontSize:9,color:"#334155"}}>→</div>
                  </div>
                ))}
              </div>
            ))}

            {/* AI chart chat — goal 3 */}
            <AIChatPanel rows={rows} allVideos={allVideos}/>
          </>
        )}
      </div>
    </div>
  );
}

// ─── DELETE BUTTON ────────────────────────────────────────────────────────────
// Handles deletion from local IndexedDB and optionally from Bunny Stream.
// Two-step confirm: first click arms it, second click executes.
function DeleteButton({video, cloudStatus, onDeleted}){
  const[armed,  setArmed]   = useState(false);
  const[deleting,setDeleting]= useState(false);
  const[status, setStatus]  = useState(null);

  const hasStream = !!video.streamId;
  const isLocal   = !video.source || video.source === "local";

  const execute = async (deleteCloud) => {
    setDeleting(true);
    setStatus("Deleting…");
    try {
      // 1. Delete from Bunny Stream if requested and streamId exists
      if (deleteCloud && hasStream) {
        setStatus("Removing from Bunny Stream…");
        const ok = await deleteStreamVideo(video.streamId);
        if (!ok) {
          setStatus("⚠ Stream delete failed — removing locally only");
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      // 2. Delete from IndexedDB (only if local blob exists)
      if (isLocal) {
        await deleteVideo(video.id);
      }
      setStatus("✓ Deleted");
      await new Promise(r => setTimeout(r, 600));
      onDeleted(video.id);
    } catch(e) {
      setStatus(`Error: ${e.message}`);
      setDeleting(false);
    }
  };

  if (deleting) return(
    <div style={{background:"#071624",borderRadius:7,padding:"10px 12px",marginTop:14,
      border:"1px solid #EF444430",fontSize:11,color:"#EF4444",textAlign:"center"}}>
      {status}
    </div>
  );

  if (!armed) return(
    <button onClick={()=>setArmed(true)}
      style={{width:"100%",marginTop:14,background:"none",border:"1px solid #EF444430",
        borderRadius:7,padding:"8px 0",color:"#EF4444",cursor:"pointer",fontSize:11,
        opacity:0.6}}>
      🗑 Delete clip
    </button>
  );

  // Armed state — show options
  return(
    <div style={{background:"#0A1929",border:"1px solid #EF444440",borderRadius:7,
      padding:"12px 14px",marginTop:14}}>
      <div style={{fontSize:11,color:"#EF4444",fontWeight:600,marginBottom:4}}>
        Delete "{video.title}"?
      </div>
      <div style={{fontSize:10,color:"#475569",marginBottom:12}}>
        {isLocal && "Removes video blob from your browser (IndexedDB). "}
        {hasStream && "Choose whether to also remove from Bunny Stream. "}
        {!isLocal && !hasStream && "This is a cloud-only entry — no local blob to remove."}
      </div>
      <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
        {isLocal && hasStream && cloudStatus?.available && (
          <button onClick={()=>execute(true)}
            style={{flex:1,background:"#EF444420",border:"1px solid #EF444450",
              borderRadius:6,padding:"7px 0",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:600}}>
            Delete local + cloud
          </button>
        )}
        <button onClick={()=>execute(false)}
          style={{flex:1,background:"#1E3A5A",border:"1px solid #2D4A6A",
            borderRadius:6,padding:"7px 0",color:"#94A3B8",cursor:"pointer",fontSize:11}}>
          {hasStream && cloudStatus?.available ? "Local only" : "Confirm delete"}
        </button>
        <button onClick={()=>setArmed(false)}
          style={{background:"none",border:"1px solid #1E3A5A",borderRadius:6,
            padding:"7px 10px",color:"#475569",cursor:"pointer",fontSize:11}}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function SmartSailingAnalytics(){
  const[role,setRole]=useState("coach");
  const[activeTab,setActiveTab]=useState("library");
  const[allVideos,setAllVideos]=useState([]);
  const[logData,setLogData]=useState(null);
  const[xmlData,setXmlData]=useState(null);
  const[selectedVideo,setSelectedVideo]=useState(null);
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
  const[loaded,setLoaded]=useState(false);
  const perms=ROLES[role];

  useEffect(()=>{
    async function boot(){
      const today=TODAY();
      const localSessions=getSessions();setSessions(localSessions);

      // Load ALL videos from IndexedDB regardless of date
      const vids=await getAllVideos();

      // Enrich each video with the log data for its own session date
      const enriched=await Promise.all(vids.map(async v=>{
        const log=await getLogData(v.sessionDate||today);
        return enrichVideo(v,log);
      }));
      setAllVideos(enriched);
      if(enriched.length>0)setSelectedVideo(enriched[0]);

      // Load log/xml for the most recent session (or today if no sessions)
      const latestDate=localSessions[0]?.date||today;
      const latestLog=await getLogData(latestDate);
      const latestXml=getXmlData(latestDate);
      if(latestLog)setLogData({...latestLog,source:"local"});
      if(latestXml)setXmlData({...latestXml,source:"local"});
      setActiveDate(latestDate);
      setUnsyncedCount(getUnsyncedCount());setLoaded(true);
      const cs=await checkCloudStatus();setCloudStatus(cs);
      if(cs?.available){
        const remote=await listR2Sessions();
        const localDates=new Set(localSessions.map(s=>s.date));
        const newR=remote.filter(s=>!localDates.has(s.date));
        if(newR.length>0)setSessions(p=>[...p,...newR].sort((a,b)=>b.date.localeCompare(a.date)));
      }
    }
    boot();
  },[]);

  async function loadDate(date){
    setActiveDate(date);
    const localLog=await getLogData(date);const localXml=getXmlData(date);
    if(localLog){setLogData({...localLog,source:"local"});}
    else if(cloudStatus?.available){const r2=await fetchCloudSession(date);setLogData(r2?.logData?{...r2.logData,source:"cloud"}:null);}
    else setLogData(null);
    if(localXml){setXmlData({...localXml,source:"local"});}
    else if(cloudStatus?.available){const r2=await fetchCloudSession(date);setXmlData(r2?.xmlData?{...r2.xmlData,source:"cloud"}:null);}
    else setXmlData(null);

    // Try exact date first, then fall back to all local videos filtered by date
    let vids=await getVideosForDate(date);
    if(!vids.length){
      // Videos may have been saved under a different date key — search all
      const all=await getAllVideos();
      vids=all.filter(v=>v.sessionDate===date);
    }
    if(!vids.length&&cloudStatus?.available){const r2=await fetchCloudSession(date);if(r2?.videos?.length)vids=r2.videos;}
    const log=await getLogData(date);
    setAllVideos(vids.map(v=>enrichVideo(v,log)));
    setSelectedVideo(vids[0]||null);
  }

  function handleImported({date,videos,logData:ld,xmlData:xd}){
    if(ld)setLogData({...ld,source:"local"});if(xd)setXmlData({...xd,source:"local"});
    setSessions(getSessions());setUnsyncedCount(getUnsyncedCount());
    getVideosForDate(date).then(vids=>{
      const e=vids.map(v=>enrichVideo(v,ld));
      setAllVideos(e);
      if(e.length>0)setSelectedVideo(e[0]);
    });
    setActiveDate(date);
    setActiveTab("library");  // switch to library so user can see the imported clips
  }

  async function runAiQuery(){
    if(!aiQuery.trim()||!allVideos.length)return;
    setAiLoading(true);setAiResult(null);
    try{
      const vl=allVideos.map(v=>({
        id:v.id, title:v.title, date:v.sessionDate, source:v.source,
        tags:v.tags||[],
        tws:v.twsAvg!=null?+R(v.twsAvg):null,
        twa:v.twaAvg!=null?+R(v.twaAvg,0):null,
        vmg:v.vmgAvg!=null?+R(v.vmgAvg):null,
        polperc:v.polpercAvg!=null?+R(v.polpercAvg,0):null,
        vsTargPerc:v.vsTargPercAvg!=null?+R(v.vsTargPercAvg,0):null,
        sog:v.sogAvg!=null?+R(v.sogAvg):null,
      }));
      const systemPrompt=`You are the AI assistant for SmartSailingAnalytics, a sailing video library.
Fields per clip: id, title, date, tags (manoeuvre/sail tags), tws (avg true wind speed kn), twa (avg true wind angle °), vmg (avg velocity made good kn), polperc (avg % of polar boat speed), vsTargPerc (avg % of target speed), sog (avg speed over ground kn). Null means no instrument data.
Library: ${JSON.stringify(vl)}
Return ONLY valid JSON (no markdown): {"matches":[],"explanation":"","insight":""}
matches = array of video ids. explanation = brief natural language summary. insight = one actionable sailing coaching insight.`;
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
  const isManTag=t=>["tack","gybe","top-mark","leeward-gate","upwind","downwind","reaching"].includes(t);
  const toggleTag=t=>setSelectedTags(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t]);
  const tabStyle=tab=>({padding:"6px 15px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,border:"none",background:activeTab===tab?"#06B6D4":"transparent",color:activeTab===tab?"#000":"#64748B"});

  if(!loaded)return<div style={{minHeight:"100vh",background:"#030F1A",display:"flex",alignItems:"center",justifyContent:"center",color:"#334155",fontSize:13}}>Loading SmartSailingAnalytics…</div>;

  return(
    <div style={{minHeight:"100vh",background:"#030F1A",color:"#E2E8F0",fontFamily:"'Segoe UI',system-ui,sans-serif",display:"flex",flexDirection:"column"}}>
      {/* HEADER */}
      <header style={{background:"#050E1C",borderBottom:"1px solid #1E3A5A",padding:"0 18px",display:"flex",alignItems:"center",height:52,gap:14,position:"sticky",top:0,zIndex:100,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:16}}>⚓</span><span style={{fontSize:15,fontWeight:700,color:"#E2E8F0"}}>Smart</span><span style={{fontSize:15,fontWeight:700,color:"#06B6D4"}}>Sailing Analytics</span></div>
        <nav style={{display:"flex",gap:2,marginLeft:10}}>
          {["library","analytics","upload","admin"].map(tab=>(
            <button key={tab} style={tabStyle(tab)} onClick={()=>setActiveTab(tab)}>
              {tab==="upload"&&unsyncedCount>0?<span>{tab}<span style={{background:"#F59E0B",color:"#000",borderRadius:8,padding:"0 4px",fontSize:9,fontWeight:800,marginLeft:3}}>{unsyncedCount}</span></span>:tab.charAt(0).toUpperCase()+tab.slice(1)}
            </button>
          ))}
        </nav>
        <div style={{flex:1}}/>
        <div style={{display:"flex",gap:5,width:290}}>
          <input value={aiQuery} onChange={e=>setAiQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&runAiQuery()} placeholder="✦ AI search…" style={{flex:1,background:"#071624",border:"1px solid #1E3A5A",borderRadius:6,padding:"5px 10px",color:"#E2E8F0",fontSize:11,outline:"none"}}/>
          <button onClick={runAiQuery} disabled={aiLoading} style={{background:aiLoading?"#1E3A5A":"#8B5CF6",border:"none",borderRadius:6,padding:"5px 12px",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:11}}>{aiLoading?"…":"Search"}</button>
          {aiResult&&<button onClick={()=>setAiResult(null)} style={{background:"none",border:"1px solid #EF444440",borderRadius:6,padding:"5px 8px",color:"#EF4444",cursor:"pointer",fontSize:11}}>✕</button>}
        </div>
        {/* Cloud status dot */}
        <div style={{display:"flex",alignItems:"center",gap:4,fontSize:10}}>
          <div style={{width:5,height:5,borderRadius:"50%",background:cloudStatus?.available?"#1D9E75":cloudStatus===null?"#334155":"#F59E0B"}}/>
          <span style={{color:cloudStatus?.available?"#1D9E75":cloudStatus===null?"#334155":"#F59E0B"}}>{cloudStatus?.available?"R2+Stream":cloudStatus===null?"…":"Local only"}</span>
        </div>
        {/* Role switcher — testing only, replaced by NextAuth Phase 2 */}
        <div style={{display:"flex",alignItems:"center",gap:5,background:"#071624",border:"1px solid #1E3A5A",borderRadius:7,padding:"4px 8px"}}>
          <span style={{fontSize:8,color:"#334155",letterSpacing:1}}>ROLE</span>
          <select value={role} onChange={e=>setRole(e.target.value)} style={{background:"transparent",border:"none",color:"#94A3B8",fontSize:11,cursor:"pointer",outline:"none"}}>
            {Object.entries(ROLES).map(([k,v])=><option key={k} value={k} style={{background:"#0A1929"}}>{v.label}</option>)}
          </select>
        </div>
      </header>

      {aiResult&&<div style={{background:"#0D1829",borderBottom:"1px solid #8B5CF620",padding:"7px 18px",display:"flex",gap:10,alignItems:"flex-start",flexShrink:0}}><span style={{color:"#8B5CF6",fontSize:12}}>✦</span><div style={{flex:1}}><div style={{fontSize:11,color:"#A78BFA",fontWeight:600,marginBottom:1}}>{aiResult.matches?.length||0} clips — {aiResult.explanation}</div>{aiResult.insight&&<div style={{fontSize:10,color:"#334155"}}>💡 {aiResult.insight}</div>}</div></div>}

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        {/* SIDEBAR */}
        {activeTab==="library"&&(
          <aside style={{width:198,background:"#050E1C",borderRight:"1px solid #1E3A5A",display:"flex",flexDirection:"column",overflowY:"auto",flexShrink:0}}>
            <div style={{padding:"12px 11px 6px"}}>
              <div style={{fontSize:9,color:"#1E3A5A",letterSpacing:2,textTransform:"uppercase",marginBottom:7}}>Sessions</div>
              {sessions.length===0&&<div style={{fontSize:10,color:"#1E3A5A",padding:"4px 3px"}}>No sessions yet</div>}
              {sessions.map(s=>{
                const isLocal=!s.source||s.source==="local";const isActive=activeDate===s.date;
                return(
                  <div key={s.date} onClick={()=>loadDate(s.date)} style={{padding:"5px 6px",borderRadius:5,cursor:"pointer",marginBottom:2,background:isActive?"#1E3A5A":"transparent",border:`1px solid ${isActive?"#06B6D430":"transparent"}`}}>
                    <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
                      <span style={{fontSize:11,color:isActive?"#06B6D4":"#64748B",fontFamily:"monospace"}}>{s.date===TODAY()?"Today":s.date}</span>
                      <SrcBadge source={isLocal?"local":"cloud"}/>
                    </div>
                    <div style={{fontSize:9,color:"#1E3A5A"}}>{s.videoCount||0}v{s.hasLog?" ·log":""}{s.hasXml?" ·ev":""}{s.location?` · ${s.location}`:""}</div>
                  </div>
                );
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
        )}

        <main style={{flex:1,display:"flex",overflow:"hidden"}}>
          {/* LIBRARY */}
          {activeTab==="library"&&(
            <>
              <div style={{flex:1,overflowY:"auto",padding:12}}>
                {(logData||xmlData)&&<div style={{display:"flex",gap:7,marginBottom:10,flexWrap:"wrap",alignItems:"center"}}>
                  {logData&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:3,background:logData.source==="local"?"#1D9E7510":"#8B5CF610",border:`1px solid ${logData.source==="local"?"#1D9E7530":"#8B5CF630"}`,color:logData.source==="local"?"#1D9E75":"#8B5CF6"}}>{logData.source==="local"?"● Local":"● Cloud"} log · {logData.rows?.length?.toLocaleString()} rows</span>}
                  {xmlData&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:3,background:"#8B5CF610",border:"1px solid #8B5CF630",color:"#8B5CF6"}}>{xmlData.source==="local"?"● Local":"● Cloud"} events · {xmlData.tackJibes?.length} manoeuvres</span>}
                  <span style={{fontSize:10,color:"#1E3A5A"}}>{displayed.length} clip{displayed.length!==1?"s":""}</span>
                  <div style={{flex:1}}/>
                  {xmlData&&allVideos.length>0&&perms.canImport&&(
                    <button onClick={async()=>{
                      // Re-tag all clips in this session using the new priority logic
                      let count=0;
                      const updated=await Promise.all(allVideos.map(async v=>{
                        if(!v.startUtc)return v;
                        const newTags=computeAutoTags(v.startUtc,v.duration,logData,xmlData,syncOffsets[v.id]||0);
                        // Keep any purely manual tags (not generated by auto-tag)
                        const autoTagPatterns=/^(tws-|upwind|reaching|downwind|tack|gybe|top-mark|leeward-gate|race-start|race|training|\d+x-)|\.(Porto|location)/;
                        const manualTags=(v.tags||[]).filter(t=>!autoTagPatterns.test(t)&&!xmlData?.meta?.location?.includes(t));
                        const merged=[...new Set([...newTags,...manualTags])];
                        await updateVideoTags(v.id,merged);
                        count++;
                        return{...v,tags:merged};
                      }));
                      setAllVideos(updated);
                      if(selectedVideo){const u=updated.find(v=>v.id===selectedVideo.id);if(u)setSelectedVideo(u);}
                      alert(`Re-tagged ${count} clip${count!==1?"s":""} using event data.`);
                    }}
                    style={{background:"#8B5CF620",border:"1px solid #8B5CF640",borderRadius:5,padding:"3px 10px",color:"#8B5CF6",cursor:"pointer",fontSize:10,fontWeight:600}}>
                      ⚡ Re-tag {allVideos.filter(v=>v.startUtc).length} clips
                    </button>
                  )}
                </div>}
                {allVideos.length===0&&<div style={{textAlign:"center",padding:"50px 20px",color:"#1E3A5A"}}>
                  <div style={{fontSize:32,marginBottom:14,opacity:0.4}}>📹</div>
                  <div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:6}}>No videos for this session</div>
                  <div style={{fontSize:11,marginBottom:16}}>{perms.canImport?"Import in the Upload tab.":"Session not yet uploaded to cloud."}</div>
                  {perms.canImport&&<button onClick={()=>setActiveTab("upload")} style={{background:"#06B6D4",border:"none",borderRadius:8,padding:"8px 20px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>Go to Upload</button>}
                </div>}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(192px, 1fr))",gap:11}}>
                  {displayed.map(v=><VideoCard key={v.id} video={v} selected={selectedVideo?.id===v.id} onClick={()=>setSelectedVideo(v)}/>)}
                </div>
              </div>
              {selectedVideo&&(
                <div style={{width:408,background:"#050E1C",borderLeft:"1px solid #1E3A5A",overflowY:"auto",padding:12,flexShrink:0}}>
                  <VideoPlayer video={selectedVideo} logData={logData} xmlData={xmlData} syncOffset={syncOffsets[selectedVideo.id]||0}/>
                  <div style={{marginTop:12}}>
                    {/* Title row */}
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:2}}>
                      <div style={{fontSize:13,fontWeight:600,color:"#E2E8F0",flex:1,marginRight:8}}>{selectedVideo.title}</div>
                      <SrcBadge source={selectedVideo.source||"local"}/>
                    </div>
                    {/* Meta row with timestamp source */}
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
                      <div style={{fontSize:10,color:"#334155"}}>{selectedVideo.sessionDate} · {selectedVideo.camera}{selectedVideo.duration?` · ${fmtT(selectedVideo.duration)}`:""}</div>
                      {selectedVideo.tsSource&&(
                        <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,
                          background:selectedVideo.tsSource==="mp4-meta"?"#1D9E7515":"#F59E0B15",
                          border:`1px solid ${selectedVideo.tsSource==="mp4-meta"?"#1D9E7530":"#F59E0B30"}`,
                          color:selectedVideo.tsSource==="mp4-meta"?"#1D9E75":"#F59E0B"}}>
                          {selectedVideo.tsSource==="mp4-meta"?"📷 camera metadata":"⚠ file modified time"}
                        </span>
                      )}
                    </div>
                    {selectedVideo.twsAvg!=null&&(
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:12}}>
                        {[
                          ["Avg TWS",       selectedVideo.twsAvg,        "kt",  "#06B6D4"],
                          ["Avg TWA",       selectedVideo.twaAvg,        "°",   "#8B5CF6"],
                          ["Avg VMG",       selectedVideo.vmgAvg,        "kt",  "#10B981"],
                          ["Polar %",       selectedVideo.polpercAvg,    "%",   "#F59E0B"],
                          ["Target %",      selectedVideo.vsTargPercAvg, "%",   "#EF4444"],
                          ["Avg SOG",       selectedVideo.sogAvg,        "kt",  "#34D399"],
                        ].map(([l,val,u,c])=>(
                          <div key={l} style={{background:"#071624",borderRadius:6,padding:"8px 10px",border:`1px solid ${c}15`}}>
                            <div style={{fontSize:9,color:"#334155",letterSpacing:1,marginBottom:2}}>{l}</div>
                            <div style={{fontSize:17,fontWeight:700,color:c,fontFamily:"monospace"}}>
                              {val!=null?R(val):"--"}<span style={{fontSize:10,marginLeft:2}}>{u}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{marginBottom:12}}><SyncControl offset={syncOffsets[selectedVideo.id]||0} onChange={v=>{
                      saveSyncOffset(selectedVideo.id,v);
                      setSyncOffsets(p=>({...p,[selectedVideo.id]:v}));
                    }}/></div>
                    <div style={{marginBottom:12}}>
                      <StartTimeEditor
                        video={selectedVideo}
                        logData={logData}
                        onSave={async(id,startUtc)=>{
                          await updateVideoStartUtc(id,startUtc);
                          const updatedVideo={...selectedVideo,startUtc};
                          const autoTags=computeAutoTags(startUtc,selectedVideo.duration,logData,xmlData,syncOffsets[id]||0);
                          const manualTags=(selectedVideo.tags||[]).filter(t=>!t.startsWith("tws-")&&!["upwind","reaching","downwind","tack","gybe","top-mark","leeward-gate","training","today"].includes(t)&&!xmlData?.meta?.location?.includes(t));
                          const mergedTags=[...new Set([...autoTags,...manualTags])];
                          await updateVideoTags(id,mergedTags);
                          const enriched=enrichVideo({...updatedVideo,tags:mergedTags},logData);
                          setAllVideos(p=>p.map(v=>v.id===id?enriched:v));
                          setSelectedVideo(enriched);
                        }}
                      />
                    </div>
                    {perms.canImport&&<TagEditor video={selectedVideo} onSave={(id,tags)=>{setAllVideos(p=>p.map(v=>v.id===id?{...v,tags}:v));if(selectedVideo.id===id)setSelectedVideo(p=>({...p,tags}));}}/>}

                    {/* Delete section */}
                    {perms.canImport&&(
                      <DeleteButton
                        video={selectedVideo}
                        cloudStatus={cloudStatus}
                        onDeleted={id=>{
                          setAllVideos(p=>p.filter(v=>v.id!==id));
                          setSelectedVideo(null);
                          saveSyncOffset(id,0); // clean up offset
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ANALYTICS */}
          {activeTab==="analytics"&&(
            <AnalyticsTab logData={logData} xmlData={xmlData} allVideos={allVideos} sessions={sessions} selectedVideo={selectedVideo} onSelectVideo={setSelectedVideo} setActiveTab={setActiveTab} />
          )}

          {activeTab==="upload"&&<UploadTab role={role} cloudStatus={cloudStatus} onImported={handleImported}/>}

          {/* ADMIN */}
          {activeTab==="admin"&&(
            <div style={{flex:1,padding:20,overflowY:"auto"}}>
              <div style={{fontSize:15,fontWeight:600,color:"#E2E8F0",marginBottom:18}}>Admin</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[
                  {title:"Data tiers",items:["Tier 1 · Local: IndexedDB (blobs) + localStorage (log/events)","Tier 2 · Cloud: Bunny Storage (JSON) + Bunny Stream (HLS)","Today = always local  ·  Older = local → cloud fallback",`Unsynced items: ${unsyncedCount}`]},
                  {title:"Cloud status (Bunny.net)",items:[`Storage: ${cloudStatus?.storage?"Connected ✓":"Not configured"}`,`Stream: ${cloudStatus?.stream?"Connected ✓":"Not configured"}`,`Zone: ${cloudStatus?.zone||"—"} · Region: ${cloudStatus?.region||"de"}`,"Env vars: BUNNY_STORAGE_API_KEY, BUNNY_STORAGE_ZONE, BUNNY_STORAGE_REGION, BUNNY_STREAM_API_KEY, BUNNY_STREAM_LIBRARY_ID, BUNNY_CDN_HOSTNAME"]},
                  {title:"Roles (testing — NextAuth in Phase 2)",items:["Admin/Coach → local import + cloud sync + older sessions","Crew → local import today + cloud older (read-only)","Viewer/Consultant → cloud only, no import","Switch roles with the header dropdown"]},
                  {title:"Sessions",items:sessions.length>0?sessions.map(s=>`${s.date===TODAY()?"Today":s.date} · ${s.source||"local"} · ${s.videoCount||0}v${s.hasLog?" + log":""}${s.hasXml?" + events":""}${s.location?` · ${s.location}`:""}`):[" No sessions yet — import in Upload tab"]},
                ].map(c=>(
                  <div key={c.title} style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:14}}>
                    <div style={{fontSize:11,fontWeight:600,color:"#64748B",marginBottom:8}}>{c.title}</div>
                    {c.items.map((item,i)=><div key={i} style={{fontSize:10,color:"#334155",padding:"3px 0",borderBottom:"1px solid #0F2030"}}>{item}</div>)}
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
