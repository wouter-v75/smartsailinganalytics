'use client'
import React, { useState } from "react";
import { deleteStreamVideo } from '../../lib/bunny';
import { deleteVideosCloud } from '../../lib/cloud-videos';
import { deleteVideo } from '../../lib/localStore';
import { getBrowserSupabase } from '../../lib/supabase/browser';

// ─── DELETE BUTTON ────────────────────────────────────────────────────────────
function DeleteButton({video, cloudStatus, onDeleted}){
  const[armed,  setArmed]   = useState(false);
  const[deleting,setDeleting]= useState(false);
  const[status, setStatus]  = useState(null);
  const hasStream = !!video.streamId;
  const isLocal   = !video.source || video.source === "local";
  const execute = async (deleteCloud) => {
    setDeleting(true); setStatus("Deleting…");
    try {
      if (deleteCloud && hasStream) { setStatus("Removing from Bunny Stream…"); const ok = await deleteStreamVideo(video.streamId); if (!ok) { setStatus("⚠ Stream delete failed — removing locally only"); await new Promise(r => setTimeout(r, 1500)); } }
      // The Supabase row MUST go too. Without this the clip is gone from IDB and
      // from Bunny, but the orphan row merges back in on the next load as a
      // phantom cloud-only entry — the clip "comes back from the dead".
      if (deleteCloud) {
        setStatus("Removing cloud row…");
        try {
          const supabase = getBrowserSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (user) await deleteVideosCloud({ userId: user.id, id: video.cloudId || video.id });
        } catch {}
      }
      if (isLocal) { await deleteVideo(video.id); }
      setStatus("✓ Deleted");
      await new Promise(r => setTimeout(r, 600));
      onDeleted(video.id);
    } catch(e) { setStatus(`Error: ${e.message}`); setDeleting(false); }
  };
  if (deleting) return(<div style={{background:"#071624",borderRadius:7,padding:"10px 12px",marginTop:14,border:"1px solid #EF444430",fontSize:11,color:"#EF4444",textAlign:"center"}}>{status}</div>);
  if (!armed) return(<button onClick={()=>setArmed(true)} style={{width:"100%",marginTop:14,background:"none",border:"1px solid #EF444430",borderRadius:7,padding:"8px 0",color:"#EF4444",cursor:"pointer",fontSize:11,opacity:0.6}}>🗑 Delete clip</button>);
  return(
    <div style={{background:"#0A1929",border:"1px solid #EF444440",borderRadius:7,padding:"12px 14px",marginTop:14}}>
      <div style={{fontSize:11,color:"#EF4444",fontWeight:600,marginBottom:4}}>Delete "{video.title}"?</div>
      <div style={{fontSize:10,color:"#475569",marginBottom:12}}>{isLocal && "Removes video blob from your browser (IndexedDB). "}{hasStream && "Choose whether to also remove from Bunny Stream. "}{!isLocal && !hasStream && "This is a cloud-only entry — no local blob to remove."}</div>
      <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
        {isLocal && hasStream && cloudStatus?.available && (<button onClick={()=>execute(true)} style={{flex:1,background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"7px 0",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:600}}>Delete local + cloud</button>)}
        <button onClick={()=>execute(false)} style={{flex:1,background:"#1E3A5A",border:"1px solid #2D4A6A",borderRadius:6,padding:"7px 0",color:"#94A3B8",cursor:"pointer",fontSize:11}}>{hasStream && cloudStatus?.available ? "Local only" : "Confirm delete"}</button>
        <button onClick={()=>setArmed(false)} style={{background:"none",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 10px",color:"#475569",cursor:"pointer",fontSize:11}}>Cancel</button>
      </div>
    </div>
  );
}

export { DeleteButton };