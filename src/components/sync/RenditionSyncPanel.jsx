'use client'
import React, { useState } from "react";
import { ensureCloudVideoId } from '../../lib/cloud-videos';
import { getVideoBlob } from '../../lib/localStore';
import { currentStorageScope } from '../../lib/storageScope';
import { getBrowserSupabase } from '../../lib/supabase/browser';
import { syncProxyForVideo } from '../../lib/video-rendition-sync';

// Phase B — per-video proxy upload control. Manual trigger by design:
// crew often want to crop a clip first (future feature) before paying
// the transcode cost. Shown only when the row doesn't yet have a proxy.
function RenditionSyncPanel({video, activeDate, onSynced}){
  const [progress, setProgress] = useState(null); // {phase, pct, message}
  const [error, setError]       = useState(null);
  const isBusy = progress && progress.phase !== 'done' && progress.phase !== 'error';

  if (video.hasProxy) {
    const when = video.proxyUploadedAt
      ? new Date(video.proxyUploadedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})
      : null;
    return (
      <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:"1px solid #1D9E7540",marginBottom:8,display:"flex",alignItems:"center",gap:8}}>
        <span style={{color:"#1D9E75",fontSize:13}}>✓</span>
        <div style={{flex:1}}>
          <div style={{fontSize:11,color:"#1D9E75",fontWeight:600}}>Proxy ready{when?` · ${when}`:""}</div>
          <div style={{fontSize:9,color:"#475569"}}>Teammates can stream the 720p preview now.</div>
        </div>
      </div>
    );
  }

  const handleSync = async () => {
    setError(null);
    setProgress({phase:'transcoding', pct:0, message:'Loading source…'});
    try {
      const blob = await getVideoBlob(video.id);
      if (!blob) {
        setError("Original file not on this device. Open this video on the device that imported it.");
        setProgress(null);
        return;
      }
      const sessionDate = video.sessionDate || activeDate;

      // The PATCH endpoint targets the Supabase row by its UUID. For
      // locally-imported videos, `video.id` is still the IDB key (e.g.
      // `v_1779...`), so first ensure a cloud row exists and grab its
      // UUID. Idempotent — repeated clicks dedupe by external_id.
      let cloudId = video.id;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cloudId)) {
        setProgress({phase:'transcoding', pct:0, message:'Registering cloud row…'});
        try {
          const supabase = getBrowserSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) {
            setError("You're signed out. Sign in and try again.");
            setProgress(null);
            return;
          }
          const resolved = await ensureCloudVideoId({
            userId: user.id,
            video,
            sessionDate,
          });
          if (!resolved) {
            setError("Couldn't create the cloud row for this video. Check your team membership in Admin.");
            setProgress(null);
            return;
          }
          cloudId = resolved;
        } catch (e) {
          setError("Failed to register video in cloud: " + (e?.message || String(e)));
          setProgress(null);
          return;
        }
      }

      const result = await syncProxyForVideo({
        videoId: cloudId,
        sessionDate,
        scope: await currentStorageScope(),
        source: blob,
        onProgress: setProgress,
      });
      if (!result.ok) {
        setError(result.error || "Sync failed");
      } else {
        // Tell the parent so it can refresh the row's hasProxy state.
        // Pass BOTH the local and cloud ids so the UI can update either
        // way it might be looking up.
        onSynced?.(video.id, {
          proxyStreamId: result.proxyStreamId,
          proxyBytes: result.proxyBytes,
          cloudId,
        });
      }
    } catch (e) {
      setError(e?.message || String(e));
    }
  };

  return (
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:"1px solid #1E3A5A",marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <div style={{fontSize:9,color:"#475569",letterSpacing:2,textTransform:"uppercase"}}>Proxy preview</div>
        <div style={{fontSize:9,color:"#334155"}}>720p · ~30 MB</div>
      </div>
      {!isBusy && (
        <>
          <div style={{fontSize:10,color:"#94A3B8",marginBottom:6}}>
            Generate a low-bandwidth preview and upload it for the team to watch on phones.
          </div>
          <button
            onClick={handleSync}
            style={{width:"100%",background:"#06B6D4",border:"none",borderRadius:5,padding:"7px 0",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}
          >
            ☁ Sync proxy
          </button>
        </>
      )}
      {isBusy && (
        <div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:10}}>
            <span style={{color:"#7DD3FC",textTransform:"capitalize"}}>{progress.phase}…</span>
            <span style={{color:"#94A3B8",fontFamily:"monospace"}}>{Math.round((progress.pct||0)*100)}%</span>
          </div>
          <div style={{height:6,background:"#1E3A5A",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${Math.round((progress.pct||0)*100)}%`,background:progress.phase==='transcoding'?"#F59E0B":"#06B6D4",transition:"width 0.2s"}}/>
          </div>
          {progress.message && (
            <div style={{fontSize:9,color:"#475569",marginTop:4,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{progress.message}</div>
          )}
        </div>
      )}
      {error && (
        <div style={{marginTop:6,fontSize:10,color:"#EF4444",background:"#EF444410",border:"1px solid #EF444430",borderRadius:4,padding:"5px 7px"}}>
          {error}
        </div>
      )}
    </div>
  );
}

export { RenditionSyncPanel };