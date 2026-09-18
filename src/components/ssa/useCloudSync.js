'use client'
import { useState, useEffect, useRef, useCallback } from "react";
import { getActiveMembership } from '../../lib/active-membership';
import { createStreamUpload, listR2Sessions, syncSessionToCloud, uploadFileToStream } from '../../lib/bunny';
import { listSessionsCloud } from '../../lib/cloud-sessions';
import { ensureCloudVideoId, makeVideoMirrorCallback } from '../../lib/cloud-videos';
import { connInfo, onWifi } from '../../lib/connection';
import { getLogData, getSessionsForMembership, getUnsyncedCount, getVideoBlob, getVideosForDate, getXmlData, markCloudSynced } from '../../lib/localStore';
import { clearPendingOrigStream, getPendingOrigStream, setPendingOrigStream } from '../../lib/pendingOrigStreams';
import { currentStorageScope, scopeOfMembership } from '../../lib/storageScope';
import { getBrowserSupabase } from '../../lib/supabase/browser';
import { daySyncRefusal } from '../../lib/syncBoatGuard';
import { sortForUpload } from '../../lib/uploadOrder';
import { syncProxyForVideo } from '../../lib/video-rendition-sync';
import { ROLES } from '../ssa/constants';
import { fmtDate } from '../ssa/format';

// ── Cloud sync ───────────────────────────────────────────────────────────────
// Everything that moves a session to and from the cloud: the proxy auto-sync
// queue, the originals queue behind it, the batch buttons, the phone's
// pull-then-push handler, and the visibility/online/cloud-ready triggers that
// drive them.
//
// This was ~520 lines spread through SSAApp, interleaved with the library UI
// and the video modal, sharing six refs and a dozen state values with code
// that had nothing to do with syncing. The bodies below are unchanged from
// that version — only their surroundings are new.
//
// It still takes a wide set of inputs because the sync genuinely coordinates
// the whole day: the clip list, the session list, the active date and the
// connection all decide what to upload. Those are passed in rather than
// re-fetched so the hook never owns a second copy of the app's state.
export function useCloudSync({
  isMobile, role, effectiveRole, allVideos, setAllVideos, allVideosRef, setSessions,
  activeDate, syncOffsets, addLog, loadDate, cloudStatus, setUnsyncedCount,
  mobileSyncState, setMobileSyncState,
}) {
  const perms = ROLES[role];

  const[syncErrors,setSyncErrors]=useState([]);
  const noteSyncError=useCallback((label,message)=>{
    setSyncErrors(p=>[...p.filter(e=>e.label!==label),{label,message:String(message||'upload failed')}]);
  },[]);

  // ── Phase B auto-sync queue ─────────────────────────────────────────────────
  // Background queue that uploads newly-imported videos to Bunny Storage as
  // proxy MP4s without any manual button press. Drives `mobileSyncState` so
  // the existing top-of-screen progress strip shows what's happening.
  //
  // Sequential by design — ffmpeg.wasm is single-instance per page, parallel
  // runs just contend for the same WASM core. One clip at a time keeps memory
  // bounded too.
  //
  // The Ref-based queue avoids stale-closure problems with the processor loop;
  // the React state lives only on the visible progress strip.
  const autoSyncRef = useRef({
    queue: [],          // [{videoId, sessionDate, label}, …]
    running: false,
    activePromise: null,// in-flight drain promise — lets the batch flow await it
    done: 0,
    total: 0,
    failed: 0,          // so the final state can report failure instead of a fake ✓
  });

  // ── Phase B.3 originals queue ───────────────────────────────────────────────
  // Full-resolution originals follow the proxies ("two-tier" sync). They are
  // large, so the queue only drains on an unmetered link unless force-run via
  // the batch button. A connection-change listener resumes a held queue.
  const originalsSyncRef = useRef({
    queue: [],          // [{videoId, sessionDate, label}, …]
    running: false,
    done: 0,
    total: 0,
  });
  // Shared timer that clears the progress strip a few seconds after a queue
  // finishes. Held in a ref so a follow-on phase (proxies → originals) can
  // cancel the pending clear instead of having its progress wiped mid-run.
  const syncClearTimerRef = useRef(null);

  // Run the proxy auto-sync queue until it's empty. Returns the in-flight
  // drain promise so callers (the batch flow) can await completion; repeated
  // calls while running return the same promise rather than starting a
  // second drain.
  function processAutoSyncQueue(){
    if (autoSyncRef.current.activePromise) return autoSyncRef.current.activePromise;
    autoSyncRef.current.activePromise = (async () => {
    if (syncClearTimerRef.current) { clearTimeout(syncClearTimerRef.current); syncClearTimerRef.current = null; }
    autoSyncRef.current.running = true;
    try {
      while (autoSyncRef.current.queue.length > 0) {
        const item = autoSyncRef.current.queue.shift();
        const idx = autoSyncRef.current.done + 1;
        const total = autoSyncRef.current.total;
        const label = item.label || `clip ${idx}`;

        setMobileSyncState({
          phase: 'pushing',
          message: `Preparing ${idx}/${total} · ${label}`,
          progress: 0,
        });

        try {
          // Need an authed user — without it we have no Supabase row to
          // mark the proxy against. Quietly skip; the user can sync
          // manually once they sign in.
          const supabase = getBrowserSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) { addLog(`✕ ${label}: not signed in — cannot upload.`); autoSyncRef.current.failed++; autoSyncRef.current.done = idx; continue; }

          // Source blob from IDB. If it's missing (e.g. mobile-skipped
          // storage on a small device) the user has no way to re-upload
          // from here; flag and move on.
          const blob = await getVideoBlob(item.videoId);
          if (!blob) {
            console.warn('[autoSync] no local blob for', item.videoId);
            addLog(`✕ ${label}: no video data on this device — re-import the clip.`);
            noteSyncError(label,'no video data on this device — re-import the clip');
            autoSyncRef.current.failed++;
            autoSyncRef.current.done = idx; continue;
          }

          // Find the in-memory video record for ensureCloudVideoId to work
          // out title/duration/etc.
          const localVid = allVideosRef.current.find(v => v.id === item.videoId)
                          || { id: item.videoId, sessionDate: item.sessionDate };

          const cloudId = await ensureCloudVideoId({
            userId: user.id,
            video: localVid,
            sessionDate: item.sessionDate,
          });
          if (!cloudId) {
            console.warn('[autoSync] no cloud row for', item.videoId);
            addLog(`✕ ${label}: no active boat workspace — can't create the cloud entry.`);
            noteSyncError(label,"no active boat workspace — can't create the cloud entry");
            autoSyncRef.current.failed++;
            autoSyncRef.current.done = idx; continue;
          }

          await syncProxyForVideo({
            videoId: cloudId,
            sessionDate: item.sessionDate,
            scope: await currentStorageScope(),
            source: blob,
            onProgress: ({phase, pct}) => {
              // Phase leads the message so it stays visible even where the
              // progress line is narrow (the clip name is what gets clipped,
              // not the phase the user needs to see).
              const phaseLabel = phase === 'transcoding' ? 'Compressing'
                               : phase === 'uploading'   ? 'Uploading'
                               : phase === 'marking'     ? 'Finalizing'
                               : phase;
              setMobileSyncState({
                phase: 'pushing',
                message: `${phaseLabel} ${idx}/${total} · ${label}`,
                progress: Math.round((pct||0) * 100),
              });
            },
          });

          // Update the live UI so the clip's "proxy ready" badge shows up
          // without waiting for a manual refresh.
          setAllVideos(p => p.map(v => v.id === item.videoId
            ? {...v, hasProxy: true, cloudId, streamProcessing: true, proxyUploadedAt: new Date().toISOString()}
            : v));
        } catch (e) {
          // Surface it. Silently swallowing this is what made an upload "succeed"
          // in a second while nothing left the phone.
          console.error('[autoSync] failed for', item.videoId, e);
          addLog(`✕ ${label}: ${e?.message || 'upload failed'}`);
          noteSyncError(label, e?.message || 'upload failed');
          autoSyncRef.current.failed++;
        }
        autoSyncRef.current.done = idx;
      }
    } finally {
      autoSyncRef.current.running = false;
      // Report the TRUTH. This used to always say "✓ Synced N" even when every clip
      // had failed — which is precisely why an instant no-op looked like a success.
      const nFailed = autoSyncRef.current.failed || 0;
      const nOk = Math.max(0, autoSyncRef.current.done - nFailed);
      if (nFailed) {
        setMobileSyncState({
          phase: 'error',
          message: `${nFailed} clip${nFailed===1?'':'s'} failed to upload — see the log`,
          progress: 0,
        });
      } else {
        setMobileSyncState({ phase: 'done', message: `✓ Synced ${nOk} clip${nOk===1?'':'s'}`, progress: 100 });
      }
      autoSyncRef.current.done = 0;
      autoSyncRef.current.total = 0;
      autoSyncRef.current.failed = 0;
      // A SUCCESS may fade; a FAILURE must not. It used to auto-clear after a few
      // seconds, so the one thing the user needed to read was the one thing they
      // couldn't. Errors now stay until dismissed (or until the next upload run).
      if (!nFailed) {
        syncClearTimerRef.current = setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 3000);
      }
    }
    })();
    autoSyncRef.current.activePromise.finally(() => { autoSyncRef.current.activePromise = null; });
    return autoSyncRef.current.activePromise;
  }

  // ── Phase B.3 originals queue ───────────────────────────────────────────────
  // Add session clips to the originals upload queue. Skips anything already
  // uploaded or already queued.
  function enqueueOriginals(videos, sessionDate){
    if (!videos?.length) return;
    const queued = new Set(originalsSyncRef.current.queue.map(it => it.videoId));
    // Same debrief-first ordering as the compressed batch: starts, then
    // roundings, then manoeuvres. The queue drains serially, so whatever is
    // queued first is what the team can watch first.
    const items = sortForUpload(videos.filter(v => !v.hasOriginal && !queued.has(v.id)))
      // Each clip keeps its OWN session date — not the batch-wide one — so a
      // May-19 clip can't be filed under a May-20 cloud session.
      .map(v => ({ videoId: v.id, sessionDate: v.sessionDate || sessionDate, label: v.title || v.name || v.id }));
    if (!items.length) return;
    originalsSyncRef.current.queue.push(...items);
    originalsSyncRef.current.total += items.length;
  }

  // Drain the originals queue — uploads the full-resolution source bytes
  // (no transcode). Runs only when the user explicitly presses the
  // "Upload originals" button; originals are multi-GB so they are never
  // uploaded automatically.
  async function processOriginalsQueue(){
    if (originalsSyncRef.current.running) return;
    if (autoSyncRef.current.activePromise) return;        // let proxies finish first
    if (!originalsSyncRef.current.queue.length) return;
    if (syncClearTimerRef.current) { clearTimeout(syncClearTimerRef.current); syncClearTimerRef.current = null; }
    originalsSyncRef.current.running = true;
    try {
      while (originalsSyncRef.current.queue.length > 0) {
        const item = originalsSyncRef.current.queue.shift();
        const idx = originalsSyncRef.current.done + 1;
        const total = originalsSyncRef.current.total;
        const label = item.label || `clip ${idx}`;

        setMobileSyncState({ phase: 'pushing', message: `Uploading HD ${idx}/${total} · ${label}`, progress: 0 });

        try {
          const supabase = getBrowserSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) { originalsSyncRef.current.done = idx; continue; }

          const blob = await getVideoBlob(item.videoId);
          if (!blob) {
            console.warn('[originals] no local blob for', item.videoId);
            addLog(`✕ ${label}: no video data on this device — re-import the clip.`);
            noteSyncError(label,'no video data on this device — re-import the clip');
            originalsSyncRef.current.failed = (originalsSyncRef.current.failed||0) + 1;
            originalsSyncRef.current.done = idx; continue;
          }

          const localVid = allVideosRef.current.find(v => v.id === item.videoId)
                          || { id: item.videoId, sessionDate: item.sessionDate };
          const cloudId = await ensureCloudVideoId({
            userId: user.id,
            video: localVid,
            sessionDate: item.sessionDate,
          });
          if (!cloudId) {
            console.warn('[originals] no cloud row for', item.videoId);
            originalsSyncRef.current.done = idx; continue;
          }

          // Bunny Stream's TUS metadata wants a File (name + type).
          const safeName = `${(label || cloudId)}`.replace(/[^\w.-]+/g, '_');
          const fileForUpload = new File([blob], `${safeName}.mp4`, {
            type: blob.type || 'video/mp4',
          });

          // Reuse a Stream video object from a prior unfinished attempt so the
          // TUS client resumes it; otherwise create a fresh one.
          let streamId = getPendingOrigStream(item.videoId);
          if (!streamId) {
            const created = await createStreamUpload(label || cloudId, blob.size);
            streamId = created?.streamId || null;
            if (streamId) setPendingOrigStream(item.videoId, streamId);
          }
          if (!streamId) {
            console.warn('[originals] could not create Stream video for', item.videoId);
            originalsSyncRef.current.done = idx; continue;
          }

          // Resumable TUS upload to Bunny Stream. uploadFileToStream auto-
          // retries dropped chunks and resumes from localStorage; a hard
          // failure leaves the pending streamId so the next run continues it.
          const uploaded = await uploadFileToStream(
            { streamId },
            fileForUpload,
            (pct) => {
              setMobileSyncState({
                phase: 'pushing',
                message: `Uploading HD ${idx}/${total} · ${label}`,
                progress: pct,
              });
            }
          );
          if (!uploaded) {
            console.warn('[originals] Stream upload interrupted for', item.videoId);
            originalsSyncRef.current.done = idx; continue;
          }

          // Record the original (its Bunny Stream GUID) on the Supabase row.
          try {
            const patchRes = await fetch(
              `/api/videos/${encodeURIComponent(cloudId)}/renditions`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ original: { streamId } }),
              }
            );
            if (!patchRes.ok) {
              const j = await patchRes.json().catch(() => null);
              console.warn('[originals] renditions PATCH failed:', j?.error || patchRes.status);
            }
          } catch (e) {
            console.warn('[originals] renditions PATCH threw:', e);
          }

          clearPendingOrigStream(item.videoId);
          setAllVideos(p => p.map(v => v.id === item.videoId
            ? { ...v, hasOriginal: true, originalStreamId: streamId }
            : v));
        } catch (e) {
          console.error('[originals] failed for', item.videoId, e);
          addLog(`✕ ${label}: ${e?.message || 'original upload failed'}`);
          noteSyncError(label, e?.message || 'original upload failed');
          originalsSyncRef.current.failed = (originalsSyncRef.current.failed||0) + 1;
        }
        originalsSyncRef.current.done = idx;
      }
    } finally {
      originalsSyncRef.current.running = false;
      const nFailed = originalsSyncRef.current.failed || 0;
      const nOk = Math.max(0, originalsSyncRef.current.done - nFailed);
      if (nFailed) {
        setMobileSyncState({ phase: 'error', message: `${nFailed} original${nFailed===1?'':'s'} failed — see the log`, progress: 0 });
      } else {
        setMobileSyncState({ phase: 'done', message: `✓ Uploaded ${nOk} original${nOk===1?'':'s'}`, progress: 100 });
      }
      originalsSyncRef.current.done = 0;
      originalsSyncRef.current.total = 0;
      originalsSyncRef.current.failed = 0;
      if (!nFailed) {
        syncClearTimerRef.current = setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 3500);
      }
    }
  }

  // Batch "Sync proxies" — coach/admin button. Transcodes + uploads every
  // un-proxied clip in the session. Proxies ONLY — the full-resolution
  // originals are a separate, deliberate action (handleBatchUploadOriginals)
  // so a slow link is never hit with a multi-GB upload by surprise.
  async function handleBatchSyncProxies(){
    if (!cloudStatus?.available) return;
    setSyncErrors([]);
    // Only clips whose source file is on THIS device can be transcoded +
    // uploaded from here. Cloud-only clips (uploaded elsewhere) have no
    // local blob — skip them rather than erroring on a missing blob.
    const toSync = allVideos.filter(v => !v.hasProxy && v.hasLocalBlob);
    if (!toSync.length) return;
    enqueueAutoSync(toSync, activeDate);
    await processAutoSyncQueue();
  }

  // Batch "Upload originals" — coach/admin button. Uploads the full-
  // resolution source for every clip in the session that doesn't have one
  // yet. Deliberately manual: originals are multi-GB, so the user triggers
  // this only when on fast wifi.
  function handleBatchUploadOriginals(){
    if (!cloudStatus?.available) return;
    setSyncErrors([]);
    // Only clips with the source file on this device can be uploaded.
    const toUpload = allVideos.filter(v => !v.hasOriginal && v.hasLocalBlob);
    if (!toUpload.length) return;
    enqueueOriginals(toUpload, activeDate);
    processOriginalsQueue();
  }

  // Add clips to the auto-sync queue and kick the processor if idle.
  // Caller passes the local IDB video records (id + title/name for labels).
  function enqueueAutoSync(videos, sessionDate){
    if (!videos?.length) return;
    const items = videos
      // Filter out anything already proxy-uploaded so re-imports don't
      // re-transcode unnecessarily.
      .filter(v => !v.hasProxy)
      .map(v => ({
        videoId: v.id,
        // Each clip keeps its OWN session date — not the batch-wide
        // activeDate — so a May-19 clip can't be filed under May 20.
        sessionDate: v.sessionDate || sessionDate,
        label: v.title || v.name || v.id,
      }));
    if (!items.length) return;
    autoSyncRef.current.queue.push(...items);
    autoSyncRef.current.total += items.length;
    processAutoSyncQueue();
  }


  // ── Mobile cloud sync handler ──────────────────────────────────────────────
  // Two-phase sync tailored for phones:
  //   1. PULL — fetch cloud session for the active date so thumbnails/video URLs
  //      appear even when only local metadata existed before. Merges cloud
  //      videos with any local ones (cloud thumbnails win when local has none).
  //   2. PUSH — if the user has unsynced local data + canSync, upload it.
  // Progress is reported via mobileSyncState so the top-bar button can show
  // a spinner and the content area can show a non-blocking toast.
  async function handleMobileCloudSync(opts){
    // heavy = run the upload PUSH (log/xml/videos). Auto-sync sets heavy=false on
    // a metered/poor link so only the light session-list PULL runs there.
    const heavy = !opts || opts.heavy !== false;
    // pushVideos = also upload the VIDEO BLOBS. Only ever true for a sync the user
    // explicitly pressed. The automatic path must never do it: video originals are
    // multi-GB, and auto-sync fires on mount / foreground / regained link, so it
    // would silently start a huge upload for whatever session happens to be loaded
    // — including an old boat's session — and then pin mobileSyncState to "pushing",
    // which disables the whole BatchSyncPanel (that is the stuck 63% DJI upload).
    // Logs + events still sync automatically; they are small.
    const pushVideos = !!opts?.pushVideos;
    if(!cloudStatus?.available){
      setMobileSyncState({phase:"error",message:"Cloud not configured",progress:0});
      setTimeout(()=>setMobileSyncState({phase:null,message:"",progress:0}),2500);
      return;
    }
    try{
      // ── PULL phase — team-scoped, works for EVERY role ─────────────────
      // Previously this was admin-only and used the global Bunny R2
      // listing. That left TL1/crew/coach unable to see anything but the
      // current local day. Now every role refreshes the Supabase
      // (RLS-protected, team-scoped) session list; admins additionally
      // merge the global R2 listing.
      setMobileSyncState({phase:"pulling",message:"Fetching cloud sessions…",progress:10});

      let supaUser=null;
      try{const sb=getBrowserSupabase();const {data:{user}}=await sb.auth.getUser();supaUser=user||null;}catch{}

      // Supabase team-scoped session list — all roles.
      if(supaUser){
        try{
          const cloudSessions=await listSessionsCloud({userId:supaUser.id});
          if(cloudSessions.length){
            setSessions(prev=>{
              const merged=[...prev];
              for(const s of cloudSessions){
                const existing=merged.find(m=>m.date===s.date);
                if(existing){
                  if(!existing.videoCount && s.video_count) existing.videoCount=s.video_count;
                  if(!existing.photoCount && s.photo_count) existing.photoCount=s.photo_count;
                  if(s.event!==undefined) existing.event=s.event;
                }else{
                  merged.push({date:s.date,source:'supabase',videoCount:s.video_count||0,photoCount:s.photo_count||0,event:s.event||null});
                }
              }
              return merged.sort((a,b)=>b.date.localeCompare(a.date));
            });
          }
        }catch{ /* non-fatal */ }
      }

      // Admin-only extra: merge the global Bunny R2 listing.
      if(effectiveRole==='admin'){
        try{
          const remote=await listR2Sessions();
          if(remote.length){
            setSessions(prev=>{
              const byDate=new Map(prev.map(s=>[s.date,s]));
              for(const s of remote) if(!byDate.has(s.date)) byDate.set(s.date,{...s,source:"cloud"});
              return Array.from(byDate.values()).sort((a,b)=>b.date.localeCompare(a.date));
            });
          }
        }catch{ /* non-fatal */ }
      }

      // Refresh the active date's videos + thumbnails through the standard
      // loader (Supabase-first, resolves proxy/stream URLs + thumbnails).
      setMobileSyncState({phase:"pulling",message:`Loading ${activeDate}…`,progress:45});
      await loadDate(activeDate);
      setMobileSyncState({phase:"pulling",message:"Thumbnails refreshed",progress:70});

      // PUSH phase — only if heavy (good link), user has permission + unsynced local
      const uc=getUnsyncedCount();
      if(heavy && uc>0 && perms.canSync){
        // ── Boat guard ───────────────────────────────────────────────────────
        // See src/lib/syncBoatGuard.ts. Shared with the Upload tab and the
        // desktop library sync, which used to push without it.
        const syncMem = supaUser ? getActiveMembership(supaUser.id) : null;
        const syncScope = scopeOfMembership(syncMem);
        const refusal = daySyncRefusal(activeDate, getSessionsForMembership(syncMem), syncMem, fmtDate);
        if(refusal){
          addLog(refusal);
          setMobileSyncState({phase:"error",message:`${fmtDate(activeDate)} is another boat's session — skipped`,progress:0});
          setTimeout(()=>setMobileSyncState({phase:null,message:"",progress:0}),4000);
          return;
        }
        setMobileSyncState({phase:"pushing",message:`Uploading ${uc} unsynced…`,progress:75});
        const logD=await getLogData(activeDate);
        const xmlD=await getXmlData(activeDate);
        // Videos only when the user asked for it — see `pushVideos` above.
        const vids=pushVideos?await getVideosForDate(activeDate):[];
        await syncSessionToCloud(activeDate,logD,xmlD,vids,msg=>{
          setMobileSyncState(p=>({...p,message:msg.length>48?msg.slice(0,45)+"…":msg}));
        },{
          scope: syncScope,
          // Mirror each clip the moment its Bunny upload finishes so the
          // crew watching from their phones see clips appear progressively.
          // supaUser was resolved up-front in the PULL phase above.
          onVideoSynced: makeVideoMirrorCallback({
            userId: supaUser?.id || null,
            sessionDate: activeDate,
            syncOffsets,
          }),
        });
        markCloudSynced(activeDate);
        setUnsyncedCount(getUnsyncedCount());
      }
      setMobileSyncState({phase:"done",message:"✓ Synced",progress:100});
      setTimeout(()=>setMobileSyncState({phase:null,message:"",progress:0}),2200);
    }catch(e){
      setMobileSyncState({phase:"error",message:"Sync failed: "+(e?.message||e),progress:0});
      setTimeout(()=>setMobileSyncState({phase:null,message:"",progress:0}),3500);
    }
  }

  // ── Wi-Fi flush — push clips that were held on mobile data ────────────────
  // Clips imported on cellular are deliberately NOT auto-uploaded (see handleImported).
  // They'd otherwise sit local forever, so re-check whenever the link changes, the app
  // comes back to the foreground, or connectivity returns — and push the moment we're
  // on Wi-Fi. Proxies only; originals stay manual (multi-GB, user's call).
  const flushOnWifi = useCallback(() => {
    if (!isMobile || !cloudStatus?.available || !perms.canImport) return;
    if (!onWifi()) return;
    const held = allVideos.filter(v => !v.hasProxy && v.hasLocalBlob);
    if (!held.length) return;
    addLog(`📶 Wi-Fi — uploading ${held.length} held clip${held.length === 1 ? '' : 's'}…`);
    enqueueAutoSync(held, activeDate);
  // enqueueAutoSync is left out on purpose: it is a plain function that only pushes
  // onto autoSyncRef and kicks the processor, so its identity carries no information
  // — naming it would rebuild this callback on every render to no effect. addLog IS
  // named, because it is a stable useCallback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, cloudStatus, perms.canImport, allVideos, activeDate, addLog]);

  const flushRef = useRef(flushOnWifi);
  flushRef.current = flushOnWifi;
  useEffect(() => {
    const fire = () => { try { flushRef.current?.(); } catch { /* */ } };
    const onVis = () => { if (document.visibilityState === "visible") fire(); };
    const c = typeof navigator !== "undefined"
      ? (navigator.connection || navigator.mozConnection || navigator.webkitConnection)
      : null;
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", fire);
    c?.addEventListener?.("change", fire);          // wifi ⇄ cellular transitions
    const t = setTimeout(fire, 2500);               // and once after the app settles
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", fire);
      c?.removeEventListener?.("change", fire);
      clearTimeout(t);
    };
  }, []); // register once — the ref keeps the callback fresh

  // ── Automatic cloud sync — event-driven, network-aware ────────────────────
  // No timers: fires on app foreground, when connectivity returns, and once on
  // mount. The light session-list PULL runs on any online link; the heavy upload
  // PUSH (logs/videos) only on a good/unmetered link. Debounced + exponential
  // backoff so a flaky offshore signal never spins or drains the battery. The
  // video transcode/upload queues are NOT touched here.
  const autoSyncMetaRef = useRef({ last: 0, running: false, backoffUntil: 0 });
  async function autoCloudSync(reason){
    const st = autoSyncMetaRef.current;
    if(!cloudStatus?.available) return;
    const ci = connInfo();
    if(!ci.online) return;
    if(st.running) return;
    if(mobileSyncState?.phase==="pulling"||mobileSyncState?.phase==="pushing") return; // a sync is already active
    const now = Date.now();
    if(now < st.backoffUntil) return;
    if(reason!=="online" && now - st.last < 20000) return; // debounce (a regained link bypasses)
    st.running = true;
    try {
      await handleMobileCloudSync({ heavy: ci.good });
      st.last = Date.now(); st.backoffUntil = 0;
    } catch {
      st.backoffUntil = Date.now() + Math.min(Math.max((st.backoffUntil - now) * 2, 15000), 5*60*1000);
    } finally { st.running = false; }
  }
  const autoSyncFnRef = useRef(null);
  autoSyncFnRef.current = autoCloudSync;
  useEffect(() => {
    const fire = (reason) => { try { autoSyncFnRef.current?.(reason); } catch { /* */ } };
    const onVis = () => { if (document.visibilityState === "visible") fire("foreground"); };
    const onOnline = () => fire("online");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onOnline);
    const t = setTimeout(() => fire("mount"), 1500); // let the initial load settle first
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("online", onOnline); clearTimeout(t); };
  }, []); // register once
  // Fire once when cloud status first resolves to available (mount may race it).
  const cloudReadyFiredRef = useRef(false);
  useEffect(() => {
    if (cloudStatus?.available && !cloudReadyFiredRef.current) {
      cloudReadyFiredRef.current = true;
      autoSyncFnRef.current?.("cloud-ready");
    } else if (!cloudStatus?.available) {
      cloudReadyFiredRef.current = false;
    }
  }, [cloudStatus]);

  // flushOnWifi and autoSyncFnRef stay inside: the connection listeners and
  // the visibility/online triggers above are their only callers.
  return {
    syncErrors, enqueueAutoSync, handleBatchSyncProxies,
    handleBatchUploadOriginals, handleMobileCloudSync,
  };
}
