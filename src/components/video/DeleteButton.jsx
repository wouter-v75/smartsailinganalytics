'use client'
import React, { useState } from "react";
import { deleteStreamVideo } from '../../lib/bunny';
import { deleteVideosCloud, isCloudVideoId } from '../../lib/cloud-videos';
import { deleteVideo } from '../../lib/localStore';
import { getBrowserSupabase } from '../../lib/supabase/browser';

// ─── DELETE BUTTON ────────────────────────────────────────────────────────────
//
// A clip lives in up to three places: the blob in IndexedDB, the objects in
// Bunny, and the `videos` row in Supabase. The row is the one that matters,
// because the library is rebuilt from it: loadDate() merges every cloud row for
// the day and pushes anything it cannot match locally as a cloud-only clip. So a
// delete that misses the row is not a delete — it is a clip that comes back on
// the next sync, seconds later.
//
// It missed the row constantly, because the cloud option was gated on
// `!!video.streamId` — Bunny STREAM. A clip uploaded to Bunny STORAGE has no
// stream id, so the only button on offer was the local one, labelled "Confirm
// delete" as if it were the whole thing. And for a cloud-only clip (source
// 'supabase', no local blob) that button deleted nothing whatsoever: it removed
// the card from the list and the next load put it straight back.
//
// So the question is no longer "is this a Stream video" but "does this clip have
// a cloud row", and the answer can be a UUID, or the local IDB key the row was
// mirrored from, or neither.

/** The cloud row's own id, if this clip carries one. */
function cloudRowId(video) {
  return video.cloudId || (isCloudVideoId(video.id) ? video.id : null);
}

/** The IDB key the cloud row was mirrored from — how to find the row when the
 *  merge has not run and so has not stamped a cloudId on this clip. */
function cloudRowExternalId(video) {
  if (cloudRowId(video)) return null;
  return video.externalId || (isCloudVideoId(video.id) ? null : video.id) || null;
}

function DeleteButton({video, cloudStatus, onDeleted}){
  const[armed,  setArmed]   = useState(false);
  const[deleting,setDeleting]= useState(false);
  const[status, setStatus]  = useState(null);
  const[failed, setFailed]  = useState(null);
  const isLocal    = !video.source || video.source === "local";
  const cloudReady = !!cloudStatus?.available;
  // Evidence that this clip has a cloud row, for the WORDING only. An IDB key is
  // not evidence — every local clip has one, uploaded or not — so it is how the
  // row is found, never why we think there is one.
  const mayBeInCloud = !!(
    !isLocal || cloudRowId(video) || video.cloudSynced || video.syncedToDb ||
    video.hasProxy || video.hasOriginal || video.streamId
  );
  // The full delete is offered whenever the cloud is reachable, INCLUDING for a
  // clip we believe was never uploaded: the belief is a set of local flags, and
  // a flag that did not survive a reload would otherwise leave a row nobody ever
  // sweeps. The lookup costs one request and finding nothing is not a failure.

  // A failure collapses the panel and leaves the reason on screen, because the
  // clip is still there and the next thing the user does should be informed by
  // why — not by a spinner that stopped.
  const stop = (why) => { setFailed(why); setStatus(null); setDeleting(false); setArmed(false); };

  const execute = async (deleteCloud) => {
    setDeleting(true); setFailed(null); setStatus("Deleting…");
    try {
      // ── 1. the cloud row FIRST ──────────────────────────────────────────────
      // Before the blobs and before the local record, because it is the only one
      // that can resurrect the clip, and because the row carries the paths of
      // every Bunny object behind it — delete it last and there is nothing left
      // to say what to purge. The server purges them as part of the same call:
      // it holds the storage WRITE key, and the browser only ever gets the
      // read-only one.
      if (deleteCloud) {
        setStatus("Removing cloud row…");
        const supabase = getBrowserSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { stop("Not signed in — the cloud row was left alone."); return; }
        const res = await deleteVideosCloud({
          userId: user.id,
          id: cloudRowId(video),
          externalId: cloudRowExternalId(video),
        });
        // A refusal must STOP here. Deleting locally over a surviving row is
        // what made the clip come back: gone from this device, still in the
        // cloud, merged back in on the next sync as a clip that can no longer
        // be deleted properly because it has become cloud-only.
        if (res.error) { stop(`Cloud delete failed: ${res.error}`); return; }
        if (res.purged?.failed?.length) {
          setStatus(`Row deleted · ${res.purged.failed.length} Bunny object(s) left behind`);
          await new Promise(r => setTimeout(r, 1200));
        }
        // No row, but a stream id on the local record: an upload whose row is
        // already gone. The server had nothing to purge from, so purge it here.
        if (!res.deleted && video.streamId) {
          setStatus("Removing from Bunny Stream…");
          await deleteStreamVideo(video.streamId).catch(() => false);
        }
      }

      // ── 2. then this device ────────────────────────────────────────────────
      // Attempted even for a cloud-only clip: deleting a key that is not there
      // is a no-op, and if a stale record IS there it is holding a thumbnail and
      // an object URL that would otherwise outlive the clip.
      setStatus("Removing from this device…");
      await deleteVideo(video.id).catch(() => {});

      setStatus("✓ Deleted");
      await new Promise(r => setTimeout(r, 600));
      onDeleted(video.id);
    } catch(e) { stop(`Error: ${e.message}`); }
  };

  if (deleting) return(<div style={{background:"#071624",borderRadius:7,padding:"10px 12px",marginTop:14,border:"1px solid #EF444430",fontSize:11,color:"#EF4444",textAlign:"center"}}>{status}</div>);
  if (!armed) return(
    <div style={{marginTop:14}}>
      {failed && <div style={{fontSize:10,color:"#EF4444",marginBottom:6,textAlign:"center"}}>{failed} — the clip is still here.</div>}
      <button onClick={()=>{setFailed(null);setArmed(true);}} style={{width:"100%",background:"none",border:"1px solid #EF444430",borderRadius:7,padding:"8px 0",color:"#EF4444",cursor:"pointer",fontSize:11,opacity:0.6}}>🗑 Delete clip</button>
    </div>
  );
  return(
    <div style={{background:"#0A1929",border:"1px solid #EF444440",borderRadius:7,padding:"12px 14px",marginTop:14}}>
      <div style={{fontSize:11,color:"#EF4444",fontWeight:600,marginBottom:4}}>Delete &quot;{video.title}&quot;?</div>
      <div style={{fontSize:10,color:"#475569",marginBottom:12}}>
        {!cloudReady
          ? "Cloud is unavailable, so only this device's copy can go — if this clip was ever uploaded it will come back on the next sync."
          : mayBeInCloud
            ? "Deletes the cloud row and its Bunny files, then this device's copy. Without the cloud row the clip comes back on the next sync."
            : "This clip looks local-only. Delete everywhere still checks the cloud for a row, and finding none is fine."}
      </div>
      <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
        {cloudReady && (<button onClick={()=>execute(true)} style={{flex:1,background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"7px 0",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:600}}>Delete everywhere</button>)}
        {isLocal && (<button onClick={()=>execute(false)} style={{flex:1,background:"#1E3A5A",border:"1px solid #2D4A6A",borderRadius:6,padding:"7px 0",color:"#94A3B8",cursor:"pointer",fontSize:11}}>{cloudReady ? "This device only" : "Confirm delete"}</button>)}
        <button onClick={()=>setArmed(false)} style={{background:"none",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 10px",color:"#475569",cursor:"pointer",fontSize:11}}>Cancel</button>
      </div>
    </div>
  );
}

export { DeleteButton, cloudRowExternalId, cloudRowId };
