'use client'
import React from "react";
import { onWifi } from '../../lib/connection';
import { useIsMobile } from '../ssa/useIsMobile';

// Phase B.3 — session-level batch sync. Coach/admin tool shown in the
// library's left column. One press transcodes + uploads proxies for every
// un-proxied clip in the session; a second button uploads full-resolution
// originals. Progress rides the shared `syncState` channel (mobileSyncState)
// that the auto-sync queue also drives.
export function BatchSyncPanel({videos, syncState, onSyncProxies, onUploadOriginals, syncErrors=[]}){
  // Only clips whose source file is on this device can be synced from here,
  // so the panel counts (and the buttons) consider just those.
  const syncable  = videos.filter(v=>v.hasLocalBlob);
  const total     = syncable.length;
  const haveProxy = syncable.filter(v=>v.hasProxy).length;
  const haveOrig  = syncable.filter(v=>v.hasOriginal).length;
  const needProxy = total - haveProxy;
  const needOrig  = total - haveOrig;
  const busy      = syncState?.phase==="pushing" || syncState?.phase==="pulling";
  // On desktop we now skip the client-side proxy transcode entirely —
  // Bunny Stream encodes the full adaptive ladder (incl. 720p for mobile
  // viewers) from the uploaded original, so the proxy is wasted CPU on
  // multi-GB sources. The proxy button + progress row are hidden here;
  // mobile keeps both because field wifi makes the small proxy useful
  // as a first-pass preview before originals upload from a fast link.
  const isMobile  = useIsMobile();
  const showProxy = isMobile;

  const row = (label, have, color) => (
    <div style={{marginBottom:6}}>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,marginBottom:3}}>
        <span style={{color:"#475569",letterSpacing:1,textTransform:"uppercase"}}>{label}</span>
        <span style={{color:total>0&&have===total?color:"#64748B",fontFamily:"monospace"}}>{have}/{total}</span>
      </div>
      <div style={{height:4,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
        <div style={{height:"100%",width:`${total?Math.round((have/total)*100):0}%`,background:color,transition:"width .3s"}}/>
      </div>
    </div>
  );

  return (
    <div style={{background:"#071624",borderRadius:8,padding:"10px 11px",border:"1px solid #1E3A5A",marginBottom:12}}>
      <div style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Cloud sync · session</div>
      {total === 0 ? (
        <div style={{fontSize:9,color:"#64748B",lineHeight:1.5}}>
          No clips in this session have their source file on this device, so
          there is nothing to sync from here. Open the session on the device
          that imported the clips to sync their proxies and originals.
        </div>
      ) : (
        <>
          {showProxy && row("Proxies · 720p", haveProxy, "#06B6D4")}
          {/* On desktop there is no client-side proxy, so "the original" is simply
              the file you imported — which, with a pre-compressed workflow, IS the
              720p proxy. Labelling that row "Originals · HD" made one sequential
              upload of small files look like a second full-resolution pass running
              alongside the first. On mobile the distinction is real, so it stays. */}
          {row(showProxy ? "Originals · HD" : "Uploaded · the file you imported", haveOrig, "#8B5CF6")}
          {busy && syncState?.message && (
            <div style={{margin:"7px 0"}}>
              <div style={{fontSize:9,color:"#7DD3FC",fontFamily:"monospace",lineHeight:1.4,wordBreak:"break-word",marginBottom:3}}>{syncState.message}</div>
              <div style={{height:4,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${syncState.progress||0}%`,background:"#06B6D4",transition:"width .3s"}}/>
              </div>
            </div>
          )}
          {/* WHY an upload failed — shown here because addLog() only renders in the
              Upload tab, which mobile users never see. Without this a rejected
              upload finished instantly and looked like it simply did nothing. */}
          {syncErrors.length>0 && (
            <div style={{marginTop:8,background:"#EF444412",border:"1px solid #EF444440",
              borderRadius:6,padding:"7px 8px"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <div style={{fontSize:10,fontWeight:700,color:"#EF4444",flex:1}}>
                  {syncErrors.length} upload{syncErrors.length===1?"":"s"} failed
                </div>
                {/* No devtools on a phone — let the reason be copied out. */}
                <button
                  onClick={()=>{
                    const txt=syncErrors.map(e=>`${e.label}: ${e.message}`).join('\n');
                    try{navigator.clipboard?.writeText(txt);}catch{}
                  }}
                  style={{background:"none",border:"1px solid #EF444440",borderRadius:4,
                    color:"#FCA5A5",fontSize:9,padding:"2px 6px",cursor:"pointer",flexShrink:0}}>
                  Copy
                </button>
              </div>
              {syncErrors.slice(0,4).map((e,i)=>(
                <div key={i} style={{fontSize:9,color:"#FCA5A5",lineHeight:1.4,marginBottom:2,wordBreak:"break-word"}}>
                  <span style={{color:"#F87171",fontWeight:600}}>{e.label}</span>: {e.message}
                </div>
              ))}
            </div>
          )}
          {/* Auto-upload is Wi-Fi-only. Say so, otherwise a crew member on 4G just
              sees clips sitting there and assumes the app is broken. The buttons
              below still work on any link — this is an explanation, not a block. */}
          {showProxy && needProxy>0 && !busy && !onWifi() && (
            <div style={{marginTop:8,fontSize:10,color:"#F59E0B",background:"#F59E0B12",
              border:"1px solid #F59E0B30",borderRadius:5,padding:"5px 7px",lineHeight:1.35}}>
              📶 Not on Wi-Fi — {needProxy} clip{needProxy===1?"":"s"} held. They upload automatically
              when you're on Wi-Fi, or tap below to upload now on mobile data.
            </div>
          )}
          {showProxy && (
            <button onClick={onSyncProxies} disabled={busy||needProxy===0}
              style={{width:"100%",marginTop:8,background:needProxy===0?"#0A1929":"#06B6D4",border:"none",borderRadius:6,
                padding:"7px 0",color:needProxy===0?"#475569":"#000",fontWeight:700,fontSize:11,
                cursor:(busy||needProxy===0)?"not-allowed":"pointer",opacity:busy?0.6:1}}>
              {needProxy===0?"✓ All proxies synced":`☁ Upload ${needProxy} clip${needProxy===1?"":"s"} now`}
            </button>
          )}
          {/* Originals are the primary sync action on desktop (we skip the
              proxy entirely there) — promote to filled style + larger pad
              when the proxy button is hidden. */}
          <button onClick={onUploadOriginals} disabled={busy||needOrig===0}
            style={{width:"100%",marginTop:showProxy?6:8,
              background: showProxy
                ? "none"
                : (needOrig===0?"#0A1929":"#8B5CF6"),
              border: showProxy
                ? `1px solid ${needOrig===0?"#1E3A5A":"#8B5CF6"}`
                : "none",
              borderRadius:6,
              padding: showProxy ? "6px 0" : "7px 0",
              color: showProxy
                ? (needOrig===0?"#475569":"#A78BFA")
                : (needOrig===0?"#475569":"#fff"),
              fontWeight:700,fontSize:11,
              cursor:(busy||needOrig===0)?"not-allowed":"pointer",opacity:busy?0.6:1}}>
            {needOrig===0
              ? (showProxy ? "✓ All originals uploaded" : "✓ All clips uploaded")
              : (showProxy
                  ? `⇪ Upload ${needOrig} original${needOrig===1?"":"s"}`
                  : `⇪ Upload ${needOrig} clip${needOrig===1?"":"s"}`)}
          </button>
          <div style={{fontSize:8,color:"#334155",marginTop:6,lineHeight:1.4}}>
            {showProxy
              ? "Proxies stream instantly on phones. Originals are full quality — upload them with the button when on fast wifi."
              : "The bar counts clips finished; the line above it is the one uploading now. Clips go up one at a time, and the streaming versions are built in the cloud from whatever you upload — so a file you already compressed is not compressed or uploaded twice."}
          </div>
        </>
      )}
    </div>
  );
}
