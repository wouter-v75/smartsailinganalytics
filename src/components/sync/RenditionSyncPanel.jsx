'use client'
import React, { useState } from "react";
import { uploadClipProxy } from '../../lib/uploadFlows';

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
    // FLOW A for one clip — the same call the watch folder, Push to Cloud and
    // the batch queue make. See src/lib/uploadFlows.ts. This used to inline the
    // auth / cloud-row / blob / PATCH sequence itself, with its own copy of the
    // UUID test that lives next to ensureCloudVideoId, and it was the only one
    // of the four that never recorded the upload on this device.
    const result = await uploadClipProxy({
      video,
      sessionDate: video.sessionDate || activeDate,
      onProgress: setProgress,
    });
    if (!result.ok) {
      setError(result.error || 'Sync failed');
      setProgress(null);
      return;
    }
    if (result.streamError) {
      // Uploaded and playable; only the adaptive ladder is missing. Saying
      // "failed" here would send the user re-uploading footage the team can
      // already watch.
      setError(`Uploaded and playable — the adaptive encode was not queued (${result.streamError})`);
    }
    // Tell the parent so it can refresh the row's hasProxy state. Pass BOTH
    // ids: the UI may be looking the clip up either way.
    onSynced?.(video.id, {
      proxyStreamId: result.proxyStreamId,
      proxyBytes: result.proxyBytes,
      cloudId: result.cloudId,
    });
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