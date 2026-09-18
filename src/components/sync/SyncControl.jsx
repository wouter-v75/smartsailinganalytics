import React from "react";

function SyncControl({offset,onChange,onSave,saving=false,saveLabel="💾 Save"}){
  return(
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:"1px solid #1E3A5A"}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
        <span style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase"}}>Sync offset</span>
        <span style={{fontSize:11,fontFamily:"monospace",color:offset!==0?"#F59E0B":"#334155"}}>{offset>0?"+":""}{offset}s</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:3,marginBottom:offset!==0?5:0}}>
        {[[-3600,"-1h"],[-60,"-1m"],[-10,"-10s"],[-1,"-1s"],[1,"+1s"],[10,"+10s"],[60,"+1m"],[3600,"+1h"]].map(([v,l])=><button key={l} disabled={saving} onClick={()=>onChange(offset+v)} style={{background:"#1E3A5A",border:"none",borderRadius:3,padding:"4px 0",color:"#7DD3FC",cursor:saving?"not-allowed":"pointer",fontSize:10,fontFamily:"monospace",opacity:saving?0.5:1}}>{l}</button>)}
      </div>
      {offset!==0&&(
        <div style={{display:"flex",gap:5}}>
          {onSave && (
            <button onClick={()=>onSave(offset)} disabled={saving}
              style={{flex:2,background:saving?"#1E3A5A":"#1D9E75",border:"none",borderRadius:4,padding:"5px",color:saving?"#94A3B8":"#fff",cursor:saving?"not-allowed":"pointer",fontSize:11,fontWeight:700}}>
              {saving?"Saving…":saveLabel}
            </button>
          )}
          <button onClick={()=>onChange(0)} disabled={saving}
            style={{flex:1,background:"none",border:"1px solid #EF444440",borderRadius:4,padding:"3px",color:"#EF4444",cursor:saving?"not-allowed":"pointer",fontSize:10,opacity:saving?0.5:1}}>
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

export { SyncControl };