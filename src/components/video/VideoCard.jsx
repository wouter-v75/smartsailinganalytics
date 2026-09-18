'use client'
import React from "react";
import { thumbSrc } from '../../lib/thumbSrc';
import { videoBadgeSrc } from '../../lib/videoBadge';
import { SrcBadge } from '../ssa/SrcBadge';
import { R, fmtT } from '../ssa/format';
import { rotStyle } from '../ssa/format';

function VideoCard({video,selected,onClick,onThumbLoad,batchMode,batchSelected,onBatchToggle,sessionTzOffset=0}){
  const handleLoaded = () => onThumbLoad?.(video.id);
  const tags = video.tags||[];
  // Clip's start time in session-local clock — replaces the filename label.
  const localStart = (()=>{
    if(video.startUtc==null) return "—";
    const d=new Date(video.startUtc + sessionTzOffset*60000);
    return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
  })();
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
        {video.thumbnailUrl?<img src={thumbSrc(video.thumbnailUrl,640)} alt="" loading="eager" fetchpriority="high" decoding="async" onLoad={handleLoaded}
          onError={e=>{
            // Optimiser unavailable (plan quota, a hiccup): fall back to the original once.
            const el=e.currentTarget;
            if(el.dataset.raw!=="1"&&el.src.includes("/_next/image")){ el.dataset.raw="1"; el.src=video.thumbnailUrl; return; }
            handleLoaded(e);
          }}
          style={{width:"100%",height:"100%",objectFit:"cover",pointerEvents:"none"}}/>:
         video.objectUrl&&video.source!=="cloud"&&!String(video.objectUrl).includes(".m3u8")?<video src={video.objectUrl} onLoadedData={handleLoaded} onError={handleLoaded} style={{width:"100%",height:"100%",objectFit:"cover",pointerEvents:"none",...rotStyle(video.rotation,16,9)}} muted preload="metadata"/>:
         (video.source==="processing"||video.streamProcessing)?<div style={{color:"#F59E0B",fontSize:9}}>⏳</div>:
         <div style={{color:"#1E3A5A",fontSize:9}}>📹</div>}
        <div style={{position:"absolute",bottom:3,right:4,background:"rgba(0,0,0,0.8)",borderRadius:2,padding:"0 3px",fontSize:8,color:"#64748B",fontFamily:"monospace"}}>{video.duration?fmtT(video.duration):"--:--"}</div>
        <div style={{position:"absolute",top:3,right:4}}><SrcBadge source={videoBadgeSrc(video)}/></div>
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
        {/* 4) Clip start time (session-local) at bottom — replaces filename */}
        <div title={video.title||""} style={{fontSize:11,fontWeight:600,color:"#E2E8F0",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{localStart}</div>
      </div>
    </div>
  );
}

export { VideoCard };