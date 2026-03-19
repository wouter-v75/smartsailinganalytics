'use client'
import { useState, useEffect, useRef, useCallback } from "react";
import { saveVideo, getAllVideos, getVideosForDate, updateVideoTags, updateVideoStartUtc, saveLogData, getLogData, saveXmlData, getXmlData, computeAutoTags, getSessions, getUnsyncedCount, markCloudSynced } from "../lib/localStore";
import { checkCloudStatus, syncSessionToCloud, fetchCloudSession, listR2Sessions, waitForStreamReady } from "../lib/bunny";

const ROLES = {
  admin:      { label:"Admin",      canImport:true,  canSync:true,  seeLocal:true },
  coach:      { label:"Coach",      canImport:true,  canSync:true,  seeLocal:true },
  crew:       { label:"Crew",       canImport:true,  canSync:false, seeLocal:true },
  viewer:     { label:"Viewer",     canImport:false, canSync:false, seeLocal:false },
  consultant: { label:"Consultant", canImport:false, canSync:false, seeLocal:false },
};

function parseNmea(s){const p=s.trim().split(/\s+/);if(p.length<2)return{lat:0,lon:0};const f=(str,d)=>{const h=str.slice(-1),n=str.slice(0,-1);const v=parseFloat(n.slice(0,d))+parseFloat(n.slice(d))/60;return h==="S"||h==="W"?-v:v;};try{return{lat:f(p[0],2),lon:f(p[1],3)};}catch{return{lat:0,lon:0};}}
function expToUtc(ds,ts){const[d,m,y]=ds.split("/").map(Number);const yr=y<50?2000+y:1900+y;const[h,mn,sc]=ts.split(":").map(Number);return Date.UTC(yr,m-1,d,h,mn,sc);}
function parseCsvLog(text){const lines=text.replace(/\r/g,"").split("\n").filter(l=>l.trim());const rows=[];for(let i=1;i<lines.length;i++){const c=lines[i].split(",");if(c.length<27)continue;const bsp=parseFloat(c[4])||0,tws=parseFloat(c[12])||0;if(bsp<0.05&&tws<0.3)continue;const ds=c[1]?.trim(),ts=c[2]?.trim();if(!ds?.includes("/")||!ts?.includes(":"))continue;const utc=expToUtc(ds,ts);if(isNaN(utc))continue;const pos=parseNmea(c[0]);rows.push({utc,lat:pos.lat,lon:pos.lon,heel:parseFloat(c[3])||0,bsp,twa:parseFloat(c[11])||0,tws,sog:parseFloat(c[20])||0,vmg:parseFloat(c[19])||0,vsTargPct:parseFloat(c[23])||0,rudder:parseFloat(c[52])||0});}return{rows,startUtc:rows[0]?.utc||0,endUtc:rows[rows.length-1]?.utc||0};}
function isoUtc(s){return new Date(s.trim().replace(" ","T")+"Z").getTime();}
function parseXmlEvents(text){const doc=new DOMParser().parseFromString(text,"text/xml");const ga=(el,a,d="")=>el?.getAttribute(a)??d;const meta={boat:ga(doc.querySelector("boat"),"val"),location:ga(doc.querySelector("location"),"val"),date:ga(doc.querySelector("date"),"val")};const sailsUpEvents=[];for(const ev of doc.getElementsByTagName("event")){const utc=isoUtc(`${ga(ev,"date")} ${ga(ev,"time")}`);const type=ga(ev,"type"),attr=ga(ev,"attribute");if(type==="SailsUp"){const sails=attr.split(";").map(s=>s.trim()).filter(Boolean);sailsUpEvents.push({utc,sails,label:sails.join(" + ")||"Sails"});}}const markRoundings=Array.from(doc.getElementsByTagName("markrounding")).map(mr=>({utc:isoUtc(ga(mr,"datetime")),isTop:ga(mr,"istopmark")==="true",isValid:ga(mr,"isvalid")==="true",label:ga(mr,"istopmark")==="true"?"Top mark":"Leeward gate",color:ga(mr,"istopmark")==="true"?"#EF4444":"#8B5CF6"}));const tackJibes=Array.from(doc.getElementsByTagName("tackjibe")).map(tj=>({utc:isoUtc(ga(tj,"datetime")),isTack:ga(tj,"istack")==="true",isValid:ga(tj,"isvalidperf")==="true",label:ga(tj,"istack")==="true"?"Tack":"Gybe",color:ga(tj,"istack")==="true"?"#1D9E75":"#7F77DD"}));return{meta,sailsUpEvents,markRoundings,tackJibes};}

const R=(n,d=1)=>(n==null||isNaN(n))?"--":Number(n).toFixed(d);
const fmtT=s=>{const x=Math.max(0,Math.floor(s));return`${String(Math.floor(x/60)).padStart(2,"0")}:${String(x%60).padStart(2,"0")}`;};
const fmtUtc=u=>u?new Date(u).toISOString().slice(11,19):"--:--:--";
const TODAY=()=>new Date().toISOString().slice(0,10);
const fmtSize=b=>b>1e9?`${(b/1e9).toFixed(1)} GB`:`${(b/1e6).toFixed(0)} MB`;
function nearestRow(rows,utc){if(!rows?.length)return null;let lo=0,hi=rows.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].utc<utc)lo=mid+1;else hi=mid;}if(lo>0&&Math.abs(rows[lo-1].utc-utc)<Math.abs(rows[lo].utc-utc))lo--;return Math.abs(rows[lo].utc-utc)<120000?rows[lo]:null;}
function enrichVideo(v,log){if(!log?.rows?.length||!v.startUtc)return v;const w=log.rows.filter(r=>r.utc>=v.startUtc&&r.utc<=v.startUtc+(v.duration||0)*1000);if(!w.length)return v;const avg=f=>w.reduce((s,r)=>s+(r[f]||0),0)/w.length;return{...v,twsAvg:avg("tws"),sogAvg:avg("sog"),heelAvg:avg("heel")};}

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
        {video.twsAvg!=null&&<div style={{display:"flex",gap:4,marginBottom:6}}>{[["TWS",video.twsAvg,"kt"],["SOG",video.sogAvg,"kt"],["Heel",video.heelAvg,"°"]].map(([l,v,u])=><div key={l} style={{flex:1,background:"#071624",borderRadius:4,padding:"3px 0",textAlign:"center"}}><div style={{fontSize:8,color:"#334155"}}>{l}</div><div style={{fontSize:11,fontWeight:700,color:"#06B6D4",fontFamily:"monospace"}}>{R(v)}</div><div style={{fontSize:8,color:"#334155"}}>{u}</div></div>)}</div>}
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
      // lastModified is end-of-recording on most cameras; startUtc = lastModified - duration
      // We store lastModified now and compute startUtc once duration is known
      lastModified: f.lastModified || null,
      startUtc: null,
    }))]);
    addLog(`✓ ${valid.length} video${valid.length>1?"s":""} queued`);
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
    if(csvParsed){saveLogData(date,csvParsed.rows,csvFile.name,csvParsed.startUtc,csvParsed.endUtc);addLog(`✓ Log saved (${csvParsed.rows.length.toLocaleString()} rows)`);}
    if(xmlParsed){saveXmlData(date,xmlParsed,xmlFile.name);addLog("✓ Events saved");}
    const saved=[];
    for(const pv of pendingVids){
      const tags=computeAutoTags(null,pv.duration,csvParsed,xmlParsed);
      try{const s=await saveVideo(pv.file,{duration:pv.duration,startUtc:pv.startUtc,tags,title:pv.name.replace(/\.[^.]+$/,"").replace(/[_-]/g," "),sessionDate:date});saved.push({...s,file:pv.file});addLog(`✓ ${pv.name} → IndexedDB${pv.startUtc?` · starts ${new Date(pv.startUtc).toISOString().slice(11,19)} UTC`:" · no start time"}`);}
      catch(e){addLog(`✕ ${pv.name}: ${e.message}`);}
    }
    setSavedDate(date);setSavedVids(saved);
    addLog(cloudStatus?.available&&perms.canSync?"Saved. Click Push to Cloud to upload.":"Saved to local storage. Ready in Library.");
    setPhase("saved");
    onImported({date,videos:saved,logData:csvParsed,xmlData:xmlParsed});
  };

  const pushCloud=async()=>{
    if(!cloudStatus?.available||!perms.canSync||!savedDate)return;
    setPhase("syncing");addLog("Starting Cloudflare R2 + Stream upload…");
    savedVids.forEach(v=>setStreamStatus(p=>({...p,[v.id]:{state:"queued"}})));
    await syncSessionToCloud(savedDate,getLogData(savedDate),getXmlData(savedDate),savedVids,msg=>{
      addLog(msg);
      // Extract stream IDs from status messages to track per-video
      const match=msg.match(/Stream \(([a-f0-9]+)\)/);
      if(match){const sid=match[1];const vid=savedVids.find(v=>v.name&&msg.includes(v.name));if(vid)setStreamStatus(p=>({...p,[vid.id]:{state:"processing",streamId:sid}}));}
    });
    setPhase("done");addLog("R2 sync complete. Stream videos processing in background…");
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
          <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}><SrcBadge source="cloud"/><span style={{fontSize:11,fontWeight:600,color:"#8B5CF6"}}>② Cloud — background</span></div><div style={{fontSize:10,color:"#475569"}}>Log + events → Cloudflare R2. Videos → Stream (HLS). Accessible to all team roles.</div></div>
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
                    // startUtc = lastModified (end of clip) minus duration in ms
                    const startUtc=v.lastModified?v.lastModified-dur*1000:null;
                    setPendingVids(p=>p.map(x=>x.id===v.id?{...x,duration:dur,startUtc}:x));
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
                <span style={{fontSize:11,fontWeight:600,color:phase==="done"?"#8B5CF6":"#F59E0B"}}>Cloudflare R2 + Stream</span>
                {!cloudStatus?.available&&<span style={{fontSize:9,color:"#EF4444",background:"#EF444415",border:"1px solid #EF444430",borderRadius:3,padding:"1px 5px"}}>Not configured</span>}
                {!perms.canSync&&<span style={{fontSize:9,color:"#F59E0B",background:"#F59E0B15",border:"1px solid #F59E0B30",borderRadius:3,padding:"1px 5px"}}>Coach required</span>}
              </div>
              {phase==="saved"&&cloudStatus?.available&&perms.canSync&&(
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:10,color:"#475569",marginBottom:10}}>Uploads log + events to R2 and transcodes videos in Stream. All team roles can view once processing completes (~1–3 min per video).</div>
                  <button onClick={pushCloud} style={{background:"#8B5CF6",border:"none",borderRadius:8,padding:"11px 0",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",width:"100%"}}>② Push to Cloud — {savedVids.length} video{savedVids.length!==1?"s":""} + log + events</button>
                </div>
              )}
              {phase==="saved"&&!cloudStatus?.available&&<div style={{fontSize:10,color:"#334155",background:"#071624",borderRadius:6,padding:"8px 10px"}}>Cloud not configured. Set Cloudflare env vars in Vercel to enable sync. Session is fully usable from local storage.</div>}
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
export default function SmartSailingAnalytics(){
  const[role,setRole]=useState("coach");
  const[activeTab,setActiveTab]=useState("library");
  const[allVideos,setAllVideos]=useState([]);
  const[logData,setLogData]=useState(null);
  const[xmlData,setXmlData]=useState(null);
  const[selectedVideo,setSelectedVideo]=useState(null);
  const[syncOffsets,setSyncOffsets]=useState({});
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
      const enriched=vids.map(v=>{
        const log=getLogData(v.sessionDate||today);
        return enrichVideo(v,log);
      });
      setAllVideos(enriched);
      if(enriched.length>0)setSelectedVideo(enriched[0]);

      // Load log/xml for the most recent session (or today if no sessions)
      const latestDate=localSessions[0]?.date||today;
      const latestLog=getLogData(latestDate);
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
    const localLog=getLogData(date);const localXml=getXmlData(date);
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
    const log=getLogData(date);
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
      const vl=allVideos.map(v=>({id:v.id,title:v.title,tags:v.tags,tws:v.twsAvg,sog:v.sogAvg,date:v.sessionDate,source:v.source}));
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:800,system:`You are the AI for SmartSailingAnalytics. Library: ${JSON.stringify(vl)}\nReturn ONLY valid JSON: {"matches":[],"explanation":"","insight":""}`,messages:[{role:"user",content:aiQuery}]})});
      const data=await res.json();const text=data.content?.find(b=>b.type==="text")?.text||"{}";
      setAiResult(JSON.parse(text.replace(/```json|```/g,"").trim()));
    }catch{setAiResult({matches:[],explanation:"Search unavailable.",insight:""});}
    setAiLoading(false);
  }

  const aiIds=new Set(aiResult?.matches||[]);
  const displayed=(aiResult?allVideos.filter(v=>aiIds.has(v.id)):allVideos)
    .filter(v=>{const ok=selectedTags.length===0||selectedTags.every(t=>(v.tags||[]).includes(t));const q=searchQuery.toLowerCase();return ok&&(!q||v.title?.toLowerCase().includes(q)||(v.tags||[]).some(t=>t.includes(q)));})
    .sort((a,b)=>sortBy==="tws"?(b.twsAvg||0)-(a.twsAvg||0):sortBy==="sog"?(b.sogAvg||0)-(a.sogAvg||0):(b.addedAt||0)-(a.addedAt||0));

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
              {["date","tws","sog"].map(s=><button key={s} onClick={()=>setSortBy(s)} style={{display:"block",width:"100%",textAlign:"left",background:sortBy===s?"#1E3A5A":"none",border:"none",borderRadius:4,padding:"3px 6px",color:sortBy===s?"#06B6D4":"#334155",cursor:"pointer",fontSize:10,marginBottom:1}}>{sortBy===s?"▸ ":"  "}{s==="date"?"Date":s==="tws"?"Wind (TWS)":"Speed (SOG)"}</button>)}
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
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:2}}>
                      <div style={{fontSize:13,fontWeight:600,color:"#E2E8F0",flex:1,marginRight:8}}>{selectedVideo.title}</div>
                      <SrcBadge source={selectedVideo.source||"local"}/>
                    </div>
                    <div style={{fontSize:10,color:"#334155",marginBottom:12}}>{selectedVideo.sessionDate} · {selectedVideo.camera}{selectedVideo.duration?` · ${fmtT(selectedVideo.duration)}`:""}</div>
                    {selectedVideo.twsAvg!=null&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:7,marginBottom:12}}>
                      {[["Avg TWS",selectedVideo.twsAvg,"kt","#06B6D4"],["Avg SOG",selectedVideo.sogAvg,"kt","#10B981"],["Avg Heel",selectedVideo.heelAvg,"°","#F59E0B"]].map(([l,v,u,c])=>(
                        <div key={l} style={{background:"#071624",borderRadius:6,padding:"8px 10px",border:`1px solid ${c}15`}}><div style={{fontSize:9,color:"#334155",letterSpacing:1,marginBottom:2}}>{l}</div><div style={{fontSize:17,fontWeight:700,color:c,fontFamily:"monospace"}}>{R(v)}<span style={{fontSize:10}}> {u}</span></div></div>
                      ))}
                    </div>}
                    <div style={{marginBottom:12}}><SyncControl offset={syncOffsets[selectedVideo.id]||0} onChange={v=>setSyncOffsets(p=>({...p,[selectedVideo.id]:v}))}/></div>
                    <div style={{marginBottom:12}}>
                      <StartTimeEditor
                        video={selectedVideo}
                        logData={logData}
                        onSave={async(id,startUtc)=>{
                          await updateVideoStartUtc(id,startUtc);
                          // Update in state so VideoPlayer and enrichVideo both see new startUtc immediately
                          setAllVideos(p=>p.map(v=>v.id===id?enrichVideo({...v,startUtc},logData):v));
                          setSelectedVideo(p=>enrichVideo({...p,startUtc},logData));
                        }}
                      />
                    </div>
                    {perms.canImport&&<TagEditor video={selectedVideo} onSave={(id,tags)=>{setAllVideos(p=>p.map(v=>v.id===id?{...v,tags}:v));if(selectedVideo.id===id)setSelectedVideo(p=>({...p,tags}));}}/>}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ANALYTICS */}
          {activeTab==="analytics"&&(
            <div style={{flex:1,padding:20,overflowY:"auto"}}>
              <div style={{fontSize:15,fontWeight:600,color:"#E2E8F0",marginBottom:18}}>Analytics</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:11,marginBottom:18}}>
                {[["Clips",allVideos.length,"","#06B6D4"],["Sessions",sessions.length,"days","#8B5CF6"],["Avg TWS",allVideos.filter(v=>v.twsAvg).length?R(allVideos.reduce((s,v)=>s+(v.twsAvg||0),0)/allVideos.filter(v=>v.twsAvg).length):"--","kn","#1D9E75"],["Avg SOG",allVideos.filter(v=>v.sogAvg).length?R(allVideos.reduce((s,v)=>s+(v.sogAvg||0),0)/allVideos.filter(v=>v.sogAvg).length):"--","kn","#F59E0B"]].map(([l,v,u,c])=>(
                  <div key={l} style={{background:"#0A1929",border:`1px solid ${c}25`,borderRadius:10,padding:14}}><div style={{fontSize:9,color:"#334155",letterSpacing:1,marginBottom:3}}>{l}</div><div style={{fontSize:26,fontWeight:700,color:c,fontFamily:"monospace"}}>{v}</div>{u&&<div style={{fontSize:10,color:"#1E3A5A"}}>{u}</div>}</div>
                ))}
              </div>
              <div style={{background:"#0A1929",borderRadius:10,border:"2px dashed #1E3A5A",padding:36,textAlign:"center"}}><div style={{fontSize:10,color:"#1E3A5A"}}>Grafana dashboards — add NEXT_PUBLIC_GRAFANA_URL in Vercel env vars</div></div>
            </div>
          )}

          {activeTab==="upload"&&<UploadTab role={role} cloudStatus={cloudStatus} onImported={handleImported}/>}

          {/* ADMIN */}
          {activeTab==="admin"&&(
            <div style={{flex:1,padding:20,overflowY:"auto"}}>
              <div style={{fontSize:15,fontWeight:600,color:"#E2E8F0",marginBottom:18}}>Admin</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[
                  {title:"Data tiers",items:["Tier 1 · Local: IndexedDB (blobs) + localStorage (log/events)","Tier 2 · Cloud: R2 (JSON) + Cloudflare Stream (HLS)","Today = always local  ·  Older = local → cloud fallback",`Unsynced items: ${unsyncedCount}`]},
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
