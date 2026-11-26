'use client'
import { useState, useCallback } from "react";
import { deleteStreamVideo } from '../../lib/bunny';
import { deleteVideosCloud } from '../../lib/cloud-videos';
import { cloudRowExternalId, cloudRowId } from '../video/DeleteButton';
import { deleteVideo, getVideosForDate } from '../../lib/localStore';
import { getBrowserSupabase } from '../../lib/supabase/browser';

export function useBatchActions({
  allVideos, setAllVideos, selectedVideo, setSelectedVideo, activeDate,
  setMobileSyncState, addLog,
}) {
  // Batch select / delete — admin + coach only
  const[batchMode,setBatchMode]=useState(false);
  const[batchSelected,setBatchSelected]=useState(()=>new Set());
  const toggleBatchSelect=useCallback(id=>{
    setBatchSelected(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;});
  },[]);
  const clearBatch=useCallback(()=>{setBatchMode(false);setBatchSelected(new Set());},[]);
  // A clip lives in THREE stores — IndexedDB (blob), Bunny (rendition) and the
  // Supabase `videos` row. This used to delete only the first, so the cloud row
  // survived and merged straight back in on the next load as a phantom cloud-only
  // clip: deleted clips kept coming back. Delete all three, Bunny + cloud first so
  // that if anything fails we still have the local entry to retry from.
  const handleBatchDelete=useCallback(async()=>{
    if(!batchSelected.size)return;
    const ids=[...batchSelected];
    const targets=allVideos.filter(v=>batchSelected.has(v.id));
    let supabaseUser=null;
    try{
      const supabase=getBrowserSupabase();
      const {data:{user}}=await supabase.auth.getUser();
      supabaseUser=user;
    }catch{}
    // The cloud row goes FIRST for each clip, and a clip whose row refuses to go
    // is LEFT ALONE — deleting it locally over a surviving row is exactly how a
    // clip comes back on the next sync, and worse, comes back cloud-only.
    // `id` used to be `v.cloudId||v.id`, which sent an IDB key where a UUID
    // belongs whenever the merge had not run; the server has an external_id
    // route for that now.
    const gone=new Set(); const kept=[];
    for(const v of targets){
      if(supabaseUser){
        const res=await deleteVideosCloud({
          userId:supabaseUser.id, id:cloudRowId(v), externalId:cloudRowExternalId(v),
        });
        if(res.error){ kept.push(`${v.title||v.id}: ${res.error}`); continue; }
        // No row to purge from, but a stream id here: an upload whose row has
        // already gone. Nothing server-side knows about it.
        if(!res.deleted&&v.streamId){try{await deleteStreamVideo(v.streamId);}catch{}}
      }
      gone.add(v.id);
    }
    for(const id of ids){ if(gone.has(id)){try{await deleteVideo(id);}catch{}} }
    setAllVideos(p=>p.filter(v=>!gone.has(v.id)));
    if(selectedVideo&&gone.has(selectedVideo.id))setSelectedVideo(null);
    clearBatch();
    addLog(`🗑 Deleted ${gone.size} clip${gone.size===1?"":"s"} — cloud row + Bunny + local`);
    for(const k of kept) addLog(`⚠ Kept — ${k}`);
  },[batchSelected, selectedVideo, clearBatch, allVideos, addLog, setAllVideos, setSelectedVideo]);

  // Nuke every clip for the active day across all three stores. Unlike batch
  // delete this also removes ORPHAN cloud rows — rows whose local entry is already
  // gone, which the library can't always surface for selection, and which are the
  // residue of the old delete path that never touched Supabase. Use to start a day
  // fresh before re-importing.
  const[clearDayBusy,setClearDayBusy]=useState(false);
  const[clearDayArmed,setClearDayArmed]=useState(false);
  const handleClearDay=useCallback(async()=>{
    if(!activeDate)return;
    setClearDayBusy(true);
    try{
      // 1. Bunny renditions — needs the stream ids, which only exist while the rows do.
      for(const v of allVideos){ if(v.streamId){try{await deleteStreamVideo(v.streamId);}catch{}} }
      // 2. Cloud rows for the whole day (catches orphans with no local entry).
      let n=0;
      try{
        const supabase=getBrowserSupabase();
        const {data:{user}}=await supabase.auth.getUser();
        if(user){ const r=await deleteVideosCloud({userId:user.id,date:activeDate}); n=r.deleted; }
      }catch{}
      // 3. Local IDB.
      const locals=await getVideosForDate(activeDate);
      for(const v of locals){try{await deleteVideo(v.id);}catch{}}
      setAllVideos([]); setSelectedVideo(null); clearBatch();
      addLog(`🗑 Cleared ${activeDate}: ${locals.length} local + ${n} cloud row${n===1?"":"s"} removed. Re-import to start fresh.`);
    } finally { setClearDayBusy(false); setClearDayArmed(false); }
  },[activeDate, allVideos, clearBatch, addLog, setAllVideos, setSelectedVideo]);

  // Batch ↓ Save to disk — ask the user once for a destination folder,
  // then stream every selected clip's blob straight into it via the File
  // System Access API. Anchor-download fallback for browsers that don't
  // support showDirectoryPicker (notably Safari) — but that path will
  // again only honour the user's chosen folder for the first download;
  // subsequent ones go to the OS default. Progress is surfaced through
  // the existing sync state strip.

  // Batch ↑ Upload compressed — pick N compressed files, match each to a
  // selected clip by filename stem (case-insensitive prefix), then push
  // each to Bunny Stream as the cloud "original". The local IDB blobs
  // stay untouched so HD-local debrief playback still works.

  // Batch sync — admin + coach only. A pending offset (seconds) that can be
  // applied to every clip currently in batchSelected.
  const[batchSyncOffset,setBatchSyncOffset]=useState(0);
  const[batchSyncOpen,setBatchSyncOpen]=useState(false);
  const[batchSyncBusy,setBatchSyncBusy]=useState(false);

  return { batchMode, setBatchMode, batchSelected, setBatchSelected, toggleBatchSelect, clearBatch, handleBatchDelete, clearDayBusy, clearDayArmed, setClearDayArmed, handleClearDay, batchSyncOffset, setBatchSyncOffset, batchSyncOpen, setBatchSyncOpen, batchSyncBusy, setBatchSyncBusy };
}
