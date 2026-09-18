'use client'
import { useState, useCallback } from "react";
import { deleteStreamVideo } from '../../lib/bunny';
import { deleteVideosCloud, ensureCloudVideoId } from '../../lib/cloud-videos';
import { deleteVideo, getVideoBlob, getVideosForDate, markVideoOriginalUploaded } from '../../lib/localStore';
import { clearPendingOrigStream } from '../../lib/pendingOrigStreams';
import { currentStorageScope } from '../../lib/storageScope';
import { getBrowserSupabase } from '../../lib/supabase/browser';
import { sortForUpload } from '../../lib/uploadOrder';
import { uploadOriginalStorageFirst } from '../../lib/video-rendition-sync';

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
    for(const v of targets){
      if(v.streamId){try{await deleteStreamVideo(v.streamId);}catch{}}
      if(supabaseUser){try{await deleteVideosCloud({userId:supabaseUser.id,id:v.cloudId||v.id});}catch{}}
    }
    for(const id of ids){try{await deleteVideo(id);}catch{}}
    setAllVideos(p=>p.filter(v=>!batchSelected.has(v.id)));
    if(selectedVideo&&batchSelected.has(selectedVideo.id))setSelectedVideo(null);
    clearBatch();
    addLog(`🗑 Deleted ${ids.length} clip${ids.length>1?"s":""} — local + Bunny + cloud row`);
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
  const handleBatchSaveToDisk = useCallback(async () => {
    if (!batchSelected.size) return;
    const selected = allVideos.filter(v => batchSelected.has(v.id) && v.hasLocalBlob);
    if (!selected.length) { alert('None of the selected clips have a local file on this device.'); return; }

    let dirHandle = null;
    if ('showDirectoryPicker' in window) {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (e) {
        // AbortError = user cancelled. Anything else, fall through to the
        // single-prompt download path with a console warning.
        if (e?.name === 'AbortError') return;
        console.warn('[batch-save] showDirectoryPicker failed, falling back to downloads:', e);
      }
    }

    setMobileSyncState({ phase: 'pushing', message: `Saving 0/${selected.length}…`, progress: 0 });
    let saved = 0;
    for (let i = 0; i < selected.length; i++) {
      const v = selected[i];
      const label = v.title || v.name || v.id;
      try {
        const blob = await getVideoBlob(v.id);
        if (!blob) { console.warn('[batch-save] no local blob for', v.id); continue; }
        const stem = (v.title || v.name || 'clip').replace(/\.[^.]+$/, '');
        const name = `${stem}.mp4`;

        if (dirHandle) {
          // FS Access API — stream the blob straight into the picked
          // folder, no per-file prompts, no Downloads-folder hijack.
          const fh = await dirHandle.getFileHandle(name, { create: true });
          const writable = await fh.createWritable();
          try {
            await blob.stream().pipeTo(writable);
          } catch (e) {
            try { await writable.abort(); } catch {}
            throw e;
          }
        } else {
          // Legacy anchor-download — only really useful for one file at
          // a time. We still try in case the user is on Safari; they'll
          // get the first file in their chosen folder and the rest in
          // their default Downloads.
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60_000);
          await new Promise(r => setTimeout(r, 400));
        }

        saved++;
        setMobileSyncState({
          phase: 'pushing',
          message: `Saved ${saved}/${selected.length} · ${label}`,
          progress: Math.round((saved / selected.length) * 100),
        });
      } catch (e) {
        console.error('[batch-save] failed for', v.id, e);
      }
    }

    setMobileSyncState({
      phase: 'done',
      message: `✓ Saved ${saved} of ${selected.length} to disk`,
      progress: 100,
    });
    setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 4000);
    if (saved < selected.length) {
      alert(`Saved ${saved} of ${selected.length}. The rest failed (see console).${dirHandle ? '' : '\n\nTip: your browser does not support a single-folder picker. On Chrome/Edge the batch saves all clips to one folder; on Safari only the first goes where you asked.'}`);
    }
  }, [batchSelected, allVideos, setMobileSyncState]);

  // Batch ↑ Upload compressed — pick N compressed files, match each to a
  // selected clip by filename stem (case-insensitive prefix), then push
  // each to Bunny Stream as the cloud "original". The local IDB blobs
  // stay untouched so HD-local debrief playback still works.
  const handleBatchUploadCompressed = useCallback(async () => {
    if (!batchSelected.size) return;
    const selected = allVideos.filter(v => batchSelected.has(v.id));
    if (!selected.length) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/mp4,video/quicktime,.mp4,.mov,.m4v';
    input.onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      // Match files to clips by filename stem (case-insensitive). Accepts
      // "<stem>.mp4", "<stem>_<anything>.mp4", "<stem>-<anything>.mp4"
      // — e.g. matches "Race1.mp4" → Race1.mp4 / Race1_720p.mp4 / Race1-720.mp4.
      const norm = s => (s || '').replace(/\.[^.]+$/, '').toLowerCase().trim();
      const pairs = [];
      const usedFiles = new Set();
      for (const v of selected) {
        const clipStem = norm(v.title || v.name || v.id);
        if (!clipStem) continue;
        const match = files.find(f => {
          if (usedFiles.has(f)) return false;
          const fs = norm(f.name);
          return fs === clipStem || fs.startsWith(clipStem + '_') || fs.startsWith(clipStem + '-');
        });
        if (match) {
          pairs.push({ video: v, file: match });
          usedFiles.add(match);
        }
      }
      if (!pairs.length) {
        alert('No picked files matched the selected clips by name.\n\nThe match looks at filename stem — e.g. a clip titled "Race1" matches Race1.mp4 / Race1_720p.mp4 / Race1-compressed.mp4. Re-export from "Save to disk" if you renamed them.');
        return;
      }
      if (pairs.length < selected.length) {
        if (!confirm(`Matched ${pairs.length} of ${selected.length} clips. Continue with those?`)) return;
      }

      // Upload in DEBRIEF order, not library order. Uploads are serial and each
      // clip becomes watchable as its own bytes land, so this decides what the
      // team sees first. `selected` follows allVideos, which is sorted newest
      // first for display — on 8 Sept that sent the race start LAST, behind ten
      // gybes, undoing the clip script's care in cutting starts first.
      const ordered = sortForUpload(
        pairs.map(p => ({ ...p, tags: p.video.tags, title: p.video.title || p.video.name || p.video.id }))
      );
      pairs.length = 0;
      pairs.push(...ordered);

      try {
        const supabase = getBrowserSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { alert('You need to be signed in.'); return; }

        for (let i = 0; i < pairs.length; i++) {
          const { video, file } = pairs[i];
          const label = video.title || video.name || video.id;
          try {
            const cloudId = await ensureCloudVideoId({
              userId: user.id,
              video,
              sessionDate: video.sessionDate || activeDate,
            });
            if (!cloudId) { console.warn('[batch-upload-compressed] no cloud row for', video.id); continue; }
            setMobileSyncState({ phase: 'pushing', message: `Uploading ${i+1}/${pairs.length} · ${label}`, progress: 0 });
            // STORAGE FIRST, then Bunny fetches it into Stream itself.
            //
            // Uploading straight to Stream left a clip unwatchable for 60-120
            // minutes while it transcoded — longer than the trim and the upload
            // put together, and the actual reason footage reached the team late.
            // Landing it in Storage makes it playable as a progressive 720p MP4
            // the moment the bytes arrive, per clip, and Bunny pulls it into
            // Stream server-side so nothing crosses our uplink twice.
            //
            // KNOWN TRADE: the Storage PUT is a plain XHR and does NOT resume,
            // where the old TUS path did. Clips are 7-80 MB apart from the start,
            // so a retry is cheap, but a dropped connection on a big start clip
            // restarts it. Revisit if that bites on the water.
            const res = await uploadOriginalStorageFirst({
              videoId: cloudId,
              sessionDate: video.sessionDate || activeDate,
              scope: await currentStorageScope(),
              source: file,
              title: label,
              onProgress: (pr) => setMobileSyncState({
                phase: 'pushing',
                message: `Uploading ${i+1}/${pairs.length} · ${label}${pr.message ? ' · ' + pr.message : ''}`,
                progress: Math.round((pr.pct || 0) * 100),
              }),
            });
            if (!res.ok) { console.warn('[batch-upload-compressed] failed for', video.id, res.error); continue; }
            // The ladder is an upgrade, not a precondition — a clip with only the
            // Storage copy still plays, so this is a warning, not a failure.
            if (res.streamError) console.warn('[batch-upload-compressed] adaptive encode not queued for', video.id, res.streamError);
            clearPendingOrigStream(video.id);
            // Persist it too, so a later Push to Cloud of this session skips it.
            await markVideoOriginalUploaded(video.id, { originalPath: res.originalPath || null, originalStreamId: res.streamId || null });
            setAllVideos(p => p.map(v => v.id === video.id
              ? { ...v, hasOriginal: true, originalStreamId: res.streamId || null, streamProcessing: Boolean(res.streamId), cloudId }
              : v));
          } catch (err) {
            console.error('[batch-upload-compressed] failed for', video.id, err);
          }
        }
        setMobileSyncState({ phase: 'done', message: `✓ Uploaded ${pairs.length} compressed clip${pairs.length===1?'':'s'}`, progress: 100 });
        setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 4000);
        clearBatch();
      } catch (err) {
        console.error('[batch-upload-compressed] outer failure', err);
        setMobileSyncState({ phase: 'error', message: err?.message || 'Batch upload failed', progress: 0 });
      }
    };
    input.click();
  }, [batchSelected, allVideos, activeDate, clearBatch, setAllVideos, setMobileSyncState]);

  // Batch sync — admin + coach only. A pending offset (seconds) that can be
  // applied to every clip currently in batchSelected.
  const[batchSyncOffset,setBatchSyncOffset]=useState(0);
  const[batchSyncOpen,setBatchSyncOpen]=useState(false);
  const[batchSyncBusy,setBatchSyncBusy]=useState(false);

  return { batchMode, setBatchMode, batchSelected, setBatchSelected, toggleBatchSelect, clearBatch, handleBatchDelete, clearDayBusy, clearDayArmed, setClearDayArmed, handleClearDay, handleBatchSaveToDisk, handleBatchUploadCompressed, batchSyncOffset, setBatchSyncOffset, batchSyncOpen, setBatchSyncOpen, batchSyncBusy, setBatchSyncBusy };
}
