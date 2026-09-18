'use client'
import React, { useState, useEffect, useCallback } from "react";
import { isCloudVideoId } from '../../lib/cloud-videos';
import { resolveShareTarget } from './shareTarget';

// ─── SHARE BUTTON ─────────────────────────────────────────────────────────────
// Mints a PUBLIC link to this one clip + its overlay. No login for the viewer, so the
// token is the whole authorisation: it expires, and it can be revoked. TL2 and up,
// plus the boat owner (see lib/shareRoles + migration 0058) — sharing puts footage on
// the open internet, and with the data box ticked the instrument numbers too.
function ShareButton({ video, canShare }){
  const [open,setOpen]     = useState(false);
  const [busy,setBusy]     = useState(false);
  const [shares,setShares] = useState(null);
  const [err,setErr]       = useState(null);
  const [days,setDays]     = useState(14);
  const [withData,setWithData] = useState(true);

  // The share is against the CLOUD row — a clip that hasn't synced can't be shared,
  // because the viewer streams it from Bunny.
  // Resolved from the SERVER when the panel opens (see resolveShareTarget): the
  // local flags said "upload this first" for clips that were already in the cloud.
  // Only on open — resolving for every clip viewed would create a cloud row for
  // clips nobody has uploaded.
  const [target,setTarget] = useState(null);
  const cloudId = target?.cloudId || video.cloudId || (isCloudVideoId(video.id) ? video.id : null);
  const notUploaded = target ? !target.playable : false;

  const load = useCallback(async ()=>{
    if(!cloudId) return;
    try{
      const r = await fetch(`/api/videos/${encodeURIComponent(cloudId)}/share`).then(x=>x.json());
      setShares(r.shares||[]);
    }catch{ setShares([]); }
  },[cloudId]);
  useEffect(()=>{ if(open) load(); },[open,load]);
  useEffect(()=>{
    if(!open) return undefined;
    let alive = true;
    (async()=>{ const t = await resolveShareTarget(video); if(alive) setTarget(t); })();
    return ()=>{ alive = false; };
  },[open,video]);

  const mint = async ()=>{
    setBusy(true); setErr(null);
    try{
      const res = await fetch(`/api/videos/${encodeURIComponent(cloudId)}/share`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ days, includeOverlay: withData }),
      });
      const j = await res.json().catch(()=>({}));
      if(!res.ok){ setErr(j.error || `failed (HTTP ${res.status})`); return; }
      const url = `${window.location.origin}/share/${j.share.token}`;
      try{ await navigator.clipboard?.writeText(url); }catch{}
      await load();
    } finally { setBusy(false); }
  };

  const revoke = async (id)=>{
    if(!confirm('Revoke this link? Anyone holding it loses access immediately.')) return;
    await fetch(`/api/videos/${encodeURIComponent(cloudId)}/share?id=${id}`,{method:'DELETE'}).catch(()=>{});
    load();
  };

  if(!canShare) return null;

  const live = (shares||[]).filter(sh=>!sh.revoked_at && new Date(sh.expires_at) > new Date());

  return (
    <div style={{marginTop:14}}>
      {!open ? (
        <button onClick={()=>setOpen(true)}
          style={{width:"100%",background:"none",border:"1px solid #06B6D440",borderRadius:7,padding:"8px 0",color:"#06B6D4",cursor:"pointer",fontSize:11,fontWeight:600}}>
          🔗 Share a link{live.length?` (${live.length} active)`:""}
        </button>
      ) : (
        <div style={{background:"#0A1929",border:"1px solid #06B6D440",borderRadius:7,padding:"11px 12px"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#06B6D4",marginBottom:7}}>Share this clip</div>
          {notUploaded&&(
            <div style={{fontSize:10,color:"#FCA5A5",lineHeight:1.5,marginBottom:9}}>
              Upload this clip to the cloud before sharing — whoever you send it to streams it from there.
            </div>
          )}
          <div style={{fontSize:10,color:"#64748B",lineHeight:1.5,marginBottom:9}}>
            Anyone with the link can watch this one clip — no login. Nothing else about the
            session, boat or team is reachable from it.
          </div>
          <label style={{display:"flex",alignItems:"center",gap:7,fontSize:11,color:"#94A3B8",marginBottom:7,cursor:"pointer"}}>
            <input type="checkbox" checked={withData} onChange={e=>setWithData(e.target.checked)}/>
            include the instrument overlay
          </label>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:9}}>
            <span style={{fontSize:11,color:"#94A3B8"}}>expires in</span>
            <select value={days} onChange={e=>setDays(Number(e.target.value))}
              style={{background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,color:"#E2E8F0",fontSize:11,padding:"3px 6px"}}>
              <option value={1}>1 day</option><option value={7}>7 days</option>
              <option value={14}>14 days</option><option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
          {err && <div style={{fontSize:10,color:"#EF4444",marginBottom:7}}>{err}</div>}
          <div style={{display:"flex",gap:6}}>
            <button onClick={mint} disabled={busy||notUploaded}
              style={{flex:1,background:(busy||notUploaded)?"#0E7490":"#06B6D4",border:"none",borderRadius:6,padding:"7px 0",color:"#000",fontWeight:700,fontSize:11,cursor:(busy||notUploaded)?"default":"pointer"}}>
              {busy?"Creating…":"Create link + copy"}
            </button>
            <button onClick={()=>setOpen(false)}
              style={{background:"none",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 12px",color:"#64748B",fontSize:11,cursor:"pointer"}}>Close</button>
          </div>

          {live.length>0 && (
            <div style={{marginTop:10,borderTop:"1px solid #1E3A5A",paddingTop:8}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:1,marginBottom:5}}>ACTIVE LINKS</div>
              {live.map(sh=>(
                <div key={sh.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                  <button onClick={()=>{try{navigator.clipboard?.writeText(`${window.location.origin}/share/${sh.token}`);}catch{}}}
                    style={{flex:1,textAlign:"left",background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"4px 7px",color:"#7DD3FC",fontSize:9,fontFamily:"monospace",cursor:"pointer",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    /share/{String(sh.token).slice(0,12)}… · {sh.view_count} view{sh.view_count===1?"":"s"} · to {new Date(sh.expires_at).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}
                  </button>
                  <button onClick={()=>revoke(sh.id)} title="Revoke"
                    style={{background:"none",border:"1px solid #EF444440",borderRadius:5,color:"#EF4444",fontSize:9,padding:"4px 7px",cursor:"pointer"}}>Revoke</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { ShareButton };