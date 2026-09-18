'use client'
import React, { useState } from "react";

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

export { StartTimeEditor };