'use client'
import React, { useState, useEffect } from "react";
import { canNativeShare, instagramUrl, mailtoUrl, nativeShare, smsUrl, whatsappUrl } from '../../lib/shareTargets';
import { resolveShareTarget } from './shareTarget';

// ─── SHARE SHEET (inside the player) ──────────────────────────────────────────
// One tap from the player: mint a link to THIS clip and hand it to WhatsApp,
// Messages, email, or whatever else the phone offers.
//
// FOOTAGE ONLY — include_overlay:false — so no instrument data leaves the team
// this way. (The Videos-tab panel still offers a with-data link for a sailmaker
// who needs the numbers.) TL2 and up, plus the boat owner; the database policies
// enforce the same rule, so a refusal here is shown rather than guessed at.
function ShareSheet({ video, onClose }){
  const [url,setUrl]       = useState(null);
  const [busy,setBusy]     = useState(true);
  const [err,setErr]       = useState(null);
  const [notUploaded,setNotUploaded] = useState(false);
  const [copied,setCopied] = useState(false);

  useEffect(()=>{
    let alive = true;
    (async()=>{
      try{
        const target = await resolveShareTarget(video);
        if(!alive) return;
        if(!target.cloudId){ setErr(target.error || 'could not find this clip in the cloud'); return; }
        if(!target.playable){ setNotUploaded(true); if(target.error) setErr(target.error); return; }
        const res = await fetch(`/api/videos/${encodeURIComponent(target.cloudId)}/share`,{
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ days: 14, includeOverlay: false }),
        });
        const j = await res.json().catch(()=>({}));
        if(!alive) return;
        if(!res.ok) setErr(j.error || `could not create the link (HTTP ${res.status})`);
        else setUrl(`${window.location.origin}/share/${j.share.token}`);
      }catch(e){ if(alive) setErr(e?.message || 'could not create the link'); }
      finally{ if(alive) setBusy(false); }
    })();
    return ()=>{ alive = false; };
  },[video]);

  const subject = { title: video.title || video.name || null, url: url || '' };
  // sms: and mailto: must go through the current tab — a popup is blocked or
  // leaves an empty window behind. Only the WhatsApp https link opens a tab.
  const go = (href,newTab)=>{ try{ if(newTab) window.open(href,'_blank','noopener'); else window.location.href = href; }catch{} };
  const btn = {flex:"1 1 40%",border:"none",borderRadius:8,padding:"10px 8px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"};

  return (
    <div onClick={(e)=>e.stopPropagation()} role="dialog" aria-label="Share this clip"
      style={{position:"absolute",inset:0,zIndex:6,background:"rgba(3,15,26,0.94)",display:"flex",flexDirection:"column",
        alignItems:"center",justifyContent:"center",padding:16,textAlign:"center"}}>
      <div style={{fontSize:13,fontWeight:700,color:"#E2E8F0",marginBottom:4}}>Share this clip</div>
      <div style={{fontSize:10,color:"#94A3B8",marginBottom:12,maxWidth:330,lineHeight:1.45}}>
        Footage only — no instrument data. Works without an account, expires in 14 days,
        and can be revoked any time from the clip&apos;s Share panel. Instagram takes no
        link directly: we copy it and open the app for you to paste.
      </div>
      {busy&&<div style={{fontSize:11,color:"#7DD3FC"}}>Creating the link…</div>}
      {!busy&&notUploaded&&(
        <div style={{fontSize:11,color:"#FCA5A5",maxWidth:330,lineHeight:1.45}}>
          Upload this clip to the cloud first — whoever you send it to streams it from there.
        </div>
      )}
      {!busy&&err&&<div style={{fontSize:11,color:"#FCA5A5",maxWidth:330,lineHeight:1.45}}>{err}</div>}
      {url&&(
        <>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,width:"100%",maxWidth:340,marginBottom:10}}>
            <button style={{...btn,background:"#25D366",color:"#062A22"}} onClick={()=>go(whatsappUrl(subject),true)}>WhatsApp</button>
            <button style={{...btn,background:"#0EA5E9"}} onClick={()=>go(smsUrl(subject),false)}>Messages</button>
            <button style={{...btn,background:"#6366F1"}} onClick={()=>go(mailtoUrl(subject),false)}>Email</button>
            {/* Instagram takes no link from a web page (no web intent, and the app
                cannot be handed a URL). Copy it and open Instagram to paste into a
                story or DM — on a phone the share sheet below lists Instagram too. */}
            <button style={{...btn,background:"#C13584"}} onClick={async()=>{
              try{ await navigator.clipboard?.writeText(url); }catch{}
              setCopied(true);
              go(instagramUrl(typeof navigator!=="undefined"?navigator.userAgent:null), false);
            }}>Instagram</button>
            {canNativeShare(typeof navigator!=="undefined"?navigator:null)&&(
              <button style={{...btn,background:"#1E3A5A"}} onClick={()=>nativeShare(subject)}>Other app…</button>
            )}
          </div>
          <button onClick={async()=>{ try{ await navigator.clipboard?.writeText(url); setCopied(true); setTimeout(()=>setCopied(false),1500); }catch{} }}
            style={{background:"none",border:"1px solid #1E3A5A",borderRadius:6,padding:"6px 12px",color:"#7DD3FC",fontSize:11,cursor:"pointer"}}>
            {copied?"Link copied":"Copy link"}
          </button>
        </>
      )}
      <button onClick={onClose} style={{marginTop:14,background:"none",border:"none",color:"#64748B",fontSize:11,cursor:"pointer"}}>Close</button>
    </div>
  );
}

export { ShareSheet };