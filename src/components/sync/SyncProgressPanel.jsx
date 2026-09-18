'use client'
import React from "react";
import { SrcBadge } from '../ssa/SrcBadge';

// ─── UPLOAD TAB ───────────────────────────────────────────────────────────────
// ─── SYNC PROGRESS PANEL ─────────────────────────────────────────────────────
// Shows an overall progress bar + per-item status rows.
// Used both inside UploadTab (inline) and as a modal overlay from Library header.
function SyncProgressPanel({progress, phase, onCancel, compact=false}){
  if(!progress) return null;
  const {items=[], overall=0, elapsed=0, error=null} = progress;
  const done = phase==="done";
  // A failed sync used to go on reading "⟳ Syncing to cloud…" above its own error
  // message, with a Cancel button, for as long as the panel stayed up. Say what
  // happened in the header too, and offer a way out rather than a cancel.
  const failed = !!error && !done;

  const stateIcon = s => s==="done"?"✓":s==="active"?"⟳":s==="processing"?"⌛":s==="error"?"✕":"·";
  const stateColor = s => s==="done"?"#1D9E75":s==="active"?"#06B6D4":s==="processing"?"#F59E0B":s==="error"?"#EF4444":"#334155";
  const fmtElapsed = s => s<60?`${s}s`:`${Math.floor(s/60)}m ${s%60}s`;

  return(
    <div style={{background:"#0A1929",border:`1px solid ${failed?"#EF4444":done?"#1D9E75":"#8B5CF6"}40`,borderRadius:10,padding:compact?"10px 12px":"14px 16px"}}>
      {/* Header row */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
        <span style={{fontSize:compact?11:13,fontWeight:700,color:failed?"#EF4444":done?"#1D9E75":"#8B5CF6"}}>
          {failed?"✕ Not synced":done?"✓ Sync complete":"⟳ Syncing to cloud…"}
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
            {failed?"Close":"Cancel"}
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

export { SyncProgressPanel };