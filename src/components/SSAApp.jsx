'use client'
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getActiveMembership } from '../lib/active-membership';
import { prefetchBoatConfig } from '../lib/boatConfigPrefetch';
import { checkCloudStatus, createStreamUpload, fetchCloudSession, listR2Sessions, syncSessionToCloud, updateCloudSessionMetadata, uploadFileToStream } from '../lib/bunny';
import { upsertPhotoCloud } from '../lib/cloud-photos';
import { getSessionCloud, listSessionsCloud } from '../lib/cloud-sessions';
import { fetchTagList as cloudFetchTagList, saveTagListCloud } from '../lib/cloud-tag-list';
import { ensureCloudVideoId, listVideosCloud, makeVideoMirrorCallback, toLegacyVideoShape } from '../lib/cloud-videos';
import { onWifi } from '../lib/connection';
import { hasOpenableData } from '../lib/hasOpenableData';
import { computeAutoTags, dedupeVideos, getAllVideos, getAllVideosForMembership, getLogData, getSessions, getSessionsForMembership, getSyncOffsets, getTagList, getUnsyncedCount, getVideoBlob, getVideosForDate, getXmlData, markCloudSynced, pruneInertVideos, saveSyncOffset, saveTagList, updateVideoBlobAndDuration, updateVideoStartUtc, updateVideoTags, venueTodayIso as TODAY } from '../lib/localStore';
import { nearestRow } from '../lib/logRowLookup';
import { clearPendingOrigStream, getPendingOrigStream, setPendingOrigStream } from '../lib/pendingOrigStreams';
import { startAutoFlush as startPhotoAutoFlush, syncPending as syncPendingPhotos } from '../lib/photoStore';
import { canShareVideos } from '../lib/shareRoles';
import { requestPersistentStorage } from '../lib/storagePersist';
import { currentStorageScope, scopeOfMembership } from '../lib/storageScope';
import { getBrowserSupabase, getUidFast } from '../lib/supabase/browser';
import { daySyncRefusal } from '../lib/syncBoatGuard';
import { reconcileSessionSyncState } from '../lib/syncReconcile';
import { buildDayTimeline } from '../lib/timeline/buildNodes';
import { cropVideo } from '../lib/video-crop';
import { videoBadgeSrc } from '../lib/videoBadge';
import { enrichVideo, isAutoTag } from '../lib/videoEnrich';
import { AnalyticsTab } from './AnalyticsTab';
import SailListDiffModal from './SailListDiffModal';
import { UploadTab } from './UploadTab';
import { MobileShell } from './mobile/MobileShell';
import { AdminTab, BoatConfigTab, CampaignTab, PhotosTab, TaggerTab, TimelineTab, ToolsTabs, WeatherTab } from './ssa/LazyTabs';
import { SrcBadge } from './ssa/SrcBadge';
import { TzCtx } from './ssa/TzContext';
import { DEFAULT_TZ, ROLES } from './ssa/constants';
import { fmtDate, fmtT } from './ssa/format';
import { useIsMobile } from './ssa/useIsMobile';
import { BatchSyncPanel } from './sync/BatchSyncPanel';
import { RenditionSyncPanel } from './sync/RenditionSyncPanel';
import { SyncControl } from './sync/SyncControl';
import { SyncProgressPanel } from './sync/SyncProgressPanel';
import { ErrorBoundary } from './ui';
import { DeleteButton } from './video/DeleteButton';
import { ShareButton } from './video/ShareButton';
import { StartTimeEditor } from './video/StartTimeEditor';
import { TagEditor } from './video/TagEditor';
import { VideoCard } from './video/VideoCard';
import { VideoCropStatusBanner } from './video/VideoCropStatusBanner';
import { VideoPlayer } from './video/VideoPlayer';
import { useCloudSync } from './ssa/useCloudSync';
import { rolePermissions } from '../lib/rolePermissions';
import { useBatchActions } from './ssa/useBatchActions';
import { useClipMetadata } from './ssa/useClipMetadata';
import { useClipPlayback } from './ssa/useClipPlayback';
import { useWorkspaceIdentity } from './ssa/useWorkspaceIdentity';

function SSAApp(){
  const isMobile = useIsMobile();
  const[role,setRole]=useState("coach");
  const[activeTab,setActiveTab]=useState("timeline");
  // See above: the watcher lives in UploadTab, so the tab must stay mounted.
  const [uploadWatching, setUploadWatching] = useState(false);
  const[allVideos,setAllVideos]=useState([]);
  const[logData,setLogData]=useState(null);
  const[sessionTzOffset,setSessionTzOffset]=useState(DEFAULT_TZ);
  const[sessionTagList,setSessionTagList]=useState([]);
  const[xmlData,setXmlData]=useState(null);
  const[selectedVideo,setSelectedVideo]=useState(null);
  // Timeline clip playback: open the real overlay player in a modal ON TOP of
  // the current view (usually the Timeline) instead of switching to the Videos
  // tab — so you never leave the timeline.
  const[videoModalOpen,setVideoModalOpen]=useState(false);
  // Phase B — crop state. The two cut markers are set by the player
  // toolbar buttons ("Delete UPTO here" / "Delete FROM here") and shown
  // as red lines on the timeline. The Save button commits via ffmpeg.
  //   pendingCrop : { deleteUpTo: secs|null, deleteFrom: secs|null } | null
  //   cropBusy    : true while the save is running
  //   cropProgress: { pct, message } during the save
  //   cropError   : last error string, surfaced as a small banner
  const[pendingCrop, setPendingCrop]   = useState(null);
  const[cropBusy,    setCropBusy]      = useState(false);
  const[cropProgress,setCropProgress]  = useState(null);
  const[cropError,   setCropError]     = useState(null);
  // Clear any pending crop when the selected video changes so cut marks
  // can't leak across clips.
  useEffect(()=>{
    setPendingCrop(null); setCropProgress(null); setCropError(null); setCropBusy(false);
  },[selectedVideo?.id]);
  const[syncOffsets,setSyncOffsets]=useState(()=>getSyncOffsets());
  const[selectedTags,setSelectedTags]=useState([]);
  const[searchQuery,setSearchQuery]=useState("");
  const[sortBy,setSortBy]=useState("date");
  // Sail inventory (BoatConfig) → sail-name filter dropdown in Videos + Photos.
  const[sailInventory,setSailInventory]=useState([]);
  const[sailFilter,setSailFilter]=useState(""); // selected sail id, "" = all
  const[sessions,setSessions]=useState([]);
  const[activeDate,setActiveDate]=useState(TODAY());
  // Effective "TAP TO ADD" suggestion list: union of the curated session tag
  // list (what gets persisted via saveTagListCloud) and the actual MANUAL
  // tags applied to every clip in the active session. This way a tag that
  // someone added directly to a clip on another device (or before we wired
  // tag-list cloud sync) still appears as a suggestion next time anyone
  // opens that session's TagEditor. Auto-computed tags (tws-/race-/upwind/
  // tack etc.) are deliberately excluded — they'd just clutter the picker.
  // Must come AFTER activeDate's useState — referencing it before throws a
  // TDZ "Cannot access 'P' before initialization" in the Vercel production
  // build (caught Mar 2026 prerender).
  const tagSuggestionList = useMemo(() => {
    const set = new Set(sessionTagList);
    for (const v of allVideos) {
      if (v.sessionDate !== activeDate) continue;
      for (const t of (v.tags || [])) {
        if (!t || isAutoTag(t)) continue;
        set.add(t);
      }
    }
    return [...set].sort();
  }, [sessionTagList, allVideos, activeDate]);
  const[cloudStatus,setCloudStatus]=useState(null);
  const[unsyncedCount,setUnsyncedCount]=useState(0);
  // Effective auth role — either 'admin' (from users.global_role) or the
  // active membership's role. Used to gate UI features. Null until the
  // identity check resolves.
  const[effectiveRole,setEffectiveRole]=useState(null);
  // Campaign engine config (null = off / unavailable). See the fetch effect below.
  const[campaignCfg,setCampaignCfg]=useState(null);
  // Resolved active workspace (team+boat) — a fallback so the Timeline works even
  // when the campaign feature flag is off (campaignCfg would be null then).
  const[activeMem,setActiveMem]=useState(null);
  // Who is signed in — the tagger marks personal tags as mine/not-mine with it.
  const[myUid,setMyUid]=useState(null);
  useEffect(()=>{
    let alive=true;
    const read=async()=>{ try{ const uid=await getUidFast(); if(uid&&alive){ setMyUid(uid); setActiveMem(getActiveMembership(uid)); } }catch{} };
    read();
    const on=()=>read();
    window.addEventListener('ssa:active-membership-changed',on);
    return ()=>{ alive=false; window.removeEventListener('ssa:active-membership-changed',on); };
  },[]);
  // Fetch the boat's sail inventory for the Videos/Photos sail-name filter and
  // the event-file saillist reconciliation.
  const refetchSails=()=>{
    const tId=campaignCfg?.teamId, bId=campaignCfg?.boatId;
    if(!tId||!bId){setSailInventory([]);return;}
    fetch(`/api/teams/${tId}/sails?boat_id=${bId}`).then(r=>r.json())
      .then(j=>setSailInventory(Array.isArray(j?.sails)?j.sails:[])).catch(()=>{});
  };
  useEffect(()=>{refetchSails();},[campaignCfg?.teamId,campaignCfg?.boatId]); // eslint-disable-line react-hooks/exhaustive-deps
  const[sailDiff,setSailDiff]=useState(null); // {names:[]} when an event file's sails differ from inventory
  const[loaded,setLoaded]=useState(false);
  const[playUtc,setPlayUtc]=useState(null);
  const[photos,setPhotos]=useState([]);
  const[hasMountedAnalytics,setHasMountedAnalytics]=useState(false);
  const[streamPollTick,setStreamPollTick]=useState(0); // re-arms the Bunny Stream encoding poll
  const playUtcThrottle=useRef(0);
  const[libSyncProgress,setLibSyncProgress]=useState(null);
  const[libSyncPhase,setLibSyncPhase]=useState(null);
  const libSyncAbortRef=useRef(false);
  const libSyncTimerRef=useRef(null);
  // Mobile-specific sync state — phase: null | "pulling" | "pushing" | "done" | "error"
  const[mobileSyncState,setMobileSyncState]=useState({phase:null,message:"",progress:0});

  // ── Logger ────────────────────────────────────────────────────────────────
  // SSAApp has NO upload console — `addLog` belongs to UploadTab and is not in this
  // scope. Calling it from here threw `ReferenceError: addLog is not defined`, and
  // because several of those calls sit BEFORE the work they announce, they killed it:
  //
  //     addLog('📶 Wi-Fi — uploading N held clips…')   ← threw
  //     enqueueAutoSync(held, activeDate)               ← never ran
  //
  // …which is exactly why clips never uploaded on Wi-Fi. Give SSAApp its own logger
  // so every call site resolves. Anything the USER must act on goes to the sync-error
  // panel / mobileSyncState, which are visible on mobile; this is the trace channel.
  const addLog = useCallback((msg) => { try { console.log('[ssa]', msg); } catch { /* */ } }, []);

  // Upload failures, surfaced IN THE UI. addLog() only writes to the console —
  // on mobile you're in the Videos tab and would never see it, so a failing
  // upload looked like a no-op. These are shown in the sync panel itself.
  // Ref mirror — the sync queues need the current clip list while draining, WITHOUT
  // calling getAllVideos(), which mints a brand-new blob: URL for every video on every
  // call. Called once per queued item, that leaked N object URLs per clip and pinned
  // every source Blob in memory.
  const allVideosRef = useRef([]);
  useEffect(()=>{ allVideosRef.current = allVideos; },[allVideos]);

  // Cache the authenticated user for the lifetime of the page. auth.getUser() is a
  // ~0.3-0.7s round-trip and the boot path was calling it ~6x (3 of them inside
  // loadDate alone). The auth user can't change without a full reload, so caching
  // is safe; an onAuthStateChange clears it if a session ever swaps in place.
  const authUserRef = useRef(undefined); // undefined = not yet fetched; null = signed out
  const getUserCached = useCallback(async () => {
    if (authUserRef.current !== undefined) return authUserRef.current;
    try { const { data:{ session } } = await getBrowserSupabase().auth.getSession(); authUserRef.current = session?.user || null; }
    catch { authUserRef.current = null; }
    return authUserRef.current;
  }, []);
  useEffect(() => {
    const { data } = getBrowserSupabase().auth.onAuthStateChange((_e, session) => { authUserRef.current = session?.user || null; });
    return () => { try { data?.subscription?.unsubscribe(); } catch { /* */ } };
  }, []);
  // Monotonic token so a superseded loadDate (rapid date switch, or the two
  // overlapping boot-time calls) can't apply its late background cloud data on
  // top of a newer date. Latest loadDate wins.
  const loadDateSeqRef = useRef(0);
  // The current loadDate, for the listeners that register once on mount and would
  // otherwise hold the first render's closure forever. Assigned after loadDate is
  // defined, below.
  const loadDateRef = useRef(null);
  // Cloud sync — the proxy/originals queues, the batch buttons, the phone
  // handler and the triggers that drive them. See ssa/useCloudSync.js.
  const {
    syncErrors, enqueueAutoSync, handleBatchSyncProxies,
    handleBatchUploadOriginals, handleMobileCloudSync,
  } = useCloudSync({
    isMobile, role, effectiveRole, allVideos, setAllVideos, allVideosRef, setSessions,
    activeDate, syncOffsets, addLog, loadDate, cloudStatus, setUnsyncedCount,
    mobileSyncState, setMobileSyncState,
  });


  const {
    batchMode, setBatchMode, batchSelected, setBatchSelected, toggleBatchSelect, clearBatch, handleBatchDelete, clearDayBusy, clearDayArmed, setClearDayArmed, handleClearDay, handleBatchSaveToDisk, handleBatchUploadCompressed, batchSyncOffset, setBatchSyncOffset, batchSyncOpen, setBatchSyncOpen, batchSyncBusy, setBatchSyncBusy,
  } = useBatchActions({
    allVideos, setAllVideos, selectedVideo, setSelectedVideo, activeDate,
    setMobileSyncState, addLog,
  });

  const {
    canRotate, rotateVideo, saveSyncForVideos, pushVideoMetadataToCloud, saveTagsForVideo,
  } = useClipMetadata({
    setAllVideos, logData, xmlData, selectedVideo, setSelectedVideo,
    syncOffsets, setSyncOffsets, activeDate, effectiveRole,
  });

  // Video thumbnail load tracking — mirrors the PhotosTab pattern
  const[videoThumbsLoading,setVideoThumbsLoading]=useState(false);
  const[videoLoadedIds,setVideoLoadedIds]=useState(()=>new Set());
  const[videoTotalThumbs,setVideoTotalThumbs]=useState(0);
  const markVideoThumbLoaded=useCallback(id=>{
    setVideoLoadedIds(prev=>{
      if(prev.has(id))return prev;
      const n=new Set(prev);n.add(id);return n;
    });
  },[]);
  const perms=ROLES[role];

  // Mount analytics pane on first visit OR as soon as log data arrives
  // (whichever comes first — avoids blank tab after upload without visiting first)
  useEffect(()=>{
    if(activeTab==="analytics"||logData) setHasMountedAnalytics(true);
  },[activeTab, logData]);

  // Safety: if user switches to Analytics or Tags and logData is missing, reload
  // from IDB. The tagger needs the day's rows to detect anything and the event
  // file to split the day into races — without them every tag lands in one
  // undifferentiated pile and the "pull them in" bar never appears.
  useEffect(()=>{
    if((activeTab==="analytics"||activeTab==="tagger") && !logData && activeDate){
      loadDate(activeDate);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[activeTab]);

  const {
    recheckStream, handlePlayUtc,
  } = useClipPlayback({
    isMobile, allVideos, setAllVideos, selectedVideo, setSelectedVideo,
    setPlayUtc, streamPollTick, setStreamPollTick, playUtcThrottle, allVideosRef,
  });
  // Who the viewer is and which workspace they are in: resolves the effective
  // role, loads the campaign config, and re-scopes the day when the active
  // membership changes. Drives state in SSAApp and returns nothing.
  useWorkspaceIdentity({
    setAllVideos, setLogData, setXmlData, setSelectedVideo, setSessions,
    setActiveDate, setEffectiveRole, setCampaignCfg, loadDateRef,
  });

  // Role-gated convenience flags — the whole matrix lives in one place now,
  // see src/lib/rolePermissions.js. They decide what the UI OFFERS; RLS and
  // the API routes are the actual boundary.
  const {
    canSeeSailScanTab, canSeeSquashShotsTab, canSeeToolsTab, canSeeBoatConfig,
    canSeeAnalyticsData, canSeeSailScanPhotos, canUseAI, showOnlyLatestDay,
    canSeeAnalytics,
  } = rolePermissions(effectiveRole);

  // Durability + background sync (Phase 4): ask for persistent storage so
  // unsynced captures survive eviction, and register an app-level pending-photo
  // flush that fires when the link improves / the app resumes (the iOS fallback
  // for the missing Background Sync API). Runs once for the app's lifetime.
  useEffect(()=>{
    requestPersistentStorage().catch(()=>{});
    const stop = startPhotoAutoFlush({});
    return stop;
  },[]);

  // Windweight MOS producer: when a session's log with on-board air-temp/sea-temp
  // /RH loads, store the hourly forecast-vs-observed windweight + Δheel samples
  // into windweight_samples for calculated-vs-observed analysis. Fire-and-forget,
  // idempotent per (boat, hour), guarded to logs that actually carry the sensors.
  useEffect(()=>{
    if(!logData?.rows?.length || !activeDate) return;
    let cancelled=false;
    (async()=>{
      let uid=null;
      try{ const {data:{user}}=await getBrowserSupabase().auth.getUser(); uid=user?.id||null; }catch{}
      if(cancelled||!uid) return;
      const am = getActiveMembership(uid);
      if(!am?.team_id || !am?.boat_id) return;
      const { storeWindweightSamples } = await import('../lib/windweightSamples');
      if(cancelled) return;
      storeWindweightSamples({ logData, sessionDate: activeDate, teamId: am.team_id, boatId: am.boat_id,
        tzOffsetMin: sessionTzOffset||0, mastHeight: 34 }).catch(()=>{});
    })();
    return ()=>{ cancelled=true; };
  },[logData, activeDate]); // eslint-disable-line react-hooks/exhaustive-deps
  // Campaign tab available only when the active team has the engine on.
  const campaignOn = !!campaignCfg;
  // Open a clip referenced from a debrief note: switch to the Library tab,
  // load that date if needed, and select the clip. loadDate honours the
  // pending-clip ref at its first paint (see below).
  const campaignPendingClipRef = React.useRef(null);
  const openCampaignVideo = async (date, clipId) => {
    campaignPendingClipRef.current = clipId || null;
    setActiveTab("library");
    if (date && date !== activeDate) {
      await loadDate(date);
    } else {
      setSelectedVideo(prev => {
        const m = allVideos.find(v => v.id === clipId || v.cloudId === clipId || v.externalId === clipId);
        return m || prev;
      });
      campaignPendingClipRef.current = null;
    }
  };

  // Timeline → play a clip in a modal overlay with the full instrument data
  // overlay, WITHOUT leaving the timeline. Loads that day's log/telemetry so
  // the overlay has data, resolves the clip into selectedVideo (loadDate does
  // this via campaignPendingClipRef), then opens the modal.
  const openVideoModal = async (date, clipId) => {
    campaignPendingClipRef.current = clipId || null;
    if (date && date !== activeDate) {
      await loadDate(date);
    } else {
      setSelectedVideo(prev => {
        const m = allVideos.find(v => v.id === clipId || v.cloudId === clipId || v.externalId === clipId);
        return m || prev;
      });
      campaignPendingClipRef.current = null;
    }
    setVideoModalOpen(true);
  };

  // Play a clip we already hold, without leaving the tab we are on. The Videos
  // tab is gone on a phone, so the Analytics track, the performance charts and
  // the clip list all open the modal player instead of navigating away. The day
  // is already loaded — we are looking at its track — so there is nothing to
  // fetch; openVideoModal's date/clipId round-trip would be wasted work here.
  const playClipInModal = useCallback((clip) => {
    if (!clip) return;
    setSelectedVideo(clip);
    setVideoModalOpen(true);
  }, []);

  // Sessions visible in the sidebar — guests see only the latest day.
  const visibleSessions = useMemo(
    () => showOnlyLatestDay && sessions.length ? [sessions[0]] : sessions,
    [sessions, showOnlyLatestDay]
  );

  // When SailScan (or SquashShots) saves a new photo + creates a session,
  // they emit a CustomEvent so the sessions sidebar and PhotosTab can pick
  // up the new date without requiring a full page reload. We also use this
  // hook to mirror the photo's metadata into Supabase (active membership
  // scope) so teammates see it without re-importing.
  useEffect(()=>{
    const refresh=async (e)=>{
      try{
        const sx=getSessions().sort((a,b)=>b.date.localeCompare(a.date));
        setSessions(sx);
      }catch(err){console.warn("[ssa:photo-saved] refresh failed",err);}

      // Mirror the saved photo to Supabase. The CustomEvent detail carries
      // {id, date, source}; the full metadata lives in localStorage.
      try {
        const detail = e?.detail || {};
        if(!detail.id || !detail.date) return;
        const supabase=getBrowserSupabase();
        const {data:{user}}=await supabase.auth.getUser();
        if(!user) return;
        const list = JSON.parse(localStorage.getItem(`ssa:photos-meta:${detail.date}`) || "[]");
        const photo = list.find(p => p.id === detail.id);
        if(!photo) return;
        await upsertPhotoCloud({
          userId: user.id,
          sessionDate: detail.date,
          takenUtc: photo.utc,
          exif: photo.exif,
          thumbnailUrl: photo.thumbnailUrl,
          bunnyStoragePath: photo.bunnyPath || photo.url || null,
          bytes: photo.size,
          analysis: photo.analysis,
        });
      } catch(err) { /* non-fatal */ }
    };
    window.addEventListener("ssa:photo-saved",refresh);
    return ()=>window.removeEventListener("ssa:photo-saved",refresh);
  },[]);

  // Seamless photo sync (like videos): on app open / tab refocus / coming back
  // online, push any pending photo THUMBNAILS (with their tags) immediately and
  // full ORIGINALS when on a good (WiFi) connection. No user action required.
  useEffect(()=>{
    if(!cloudStatus?.available) return;
    const flush=()=>{ if(cloudStatus?.available) syncPendingPhotos({}).catch(()=>{}); };
    flush(); // on open / when cloud becomes available
    const onVis=()=>{ if(typeof document!=="undefined" && document.visibilityState==="visible") flush(); };
    if(typeof document!=="undefined") document.addEventListener("visibilitychange",onVis);
    if(typeof window!=="undefined") window.addEventListener("online",flush);
    return ()=>{
      if(typeof document!=="undefined") document.removeEventListener("visibilitychange",onVis);
      if(typeof window!=="undefined") window.removeEventListener("online",flush);
    };
  },[cloudStatus?.available]);

  useEffect(()=>{
    async function boot(){
      const today=TODAY();
      // ── STARTUP PROFILING ────────────────────────────────────────────────
      // Cheap phase timing so a single cold load reveals the bottleneck. Open the
      // browser console and filter for "[boot]". Each line is ms since boot start;
      // the big jumps are your slow steps. Remove once the culprit is found.
      const _pt0=performance.now();
      const _pm=(label)=>{ try{ console.info(`[boot] ${label}: +${Math.round(performance.now()-_pt0)}ms`); }catch{ /* */ } };
      // Read the active membership BEFORE pulling local data so we only show
      // sessions/videos belonging to the current workspace. Untagged legacy
      // entries are visible only when there is no active membership.
      const supaForBoot = getBrowserSupabase();
      // Fast path: read the user from the STORED session (cookie), not the
      // /auth/v1/user endpoint. getUser() is a ~0.9s round-trip that was gating
      // FIRST PAINT; getSession() is local. Safe here because (a) every cloud
      // read is RLS-gated — the JWT sent with each request is what the server
      // validates, so a stale/tampered session yields empty results, never
      // another tenant's data — and (b) the admin gate is resolved separately by
      // a verified getUser + users.global_role lookup (see effectiveRole effect).
      const { data: { session: bootSession } } = await supaForBoot.auth.getSession();
      const bootUser = bootSession?.user || null;
      authUserRef.current = bootUser;   // seed cache; onAuthStateChange keeps it fresh
      const bootMembership = bootUser ? getActiveMembership(bootUser.id) : null;
      _pm('auth.getSession + membership (local, no round-trip)');
      // Revalidate the session in the background — does not block paint. Prefer
      // getClaims(): with the project's asymmetric signing key it verifies the JWT
      // locally against the cached JWKS (no /auth/v1/user round-trip). Only when
      // the signature/subject can't be confirmed do we fall back to the
      // authoritative getUser(), so a transient JWKS fetch failure can't wrongly
      // drop the cached user. Corrects the cache if the server disagrees.
      (async()=>{
        try {
          if(typeof supaForBoot.auth.getClaims==='function'){
            const { data:cl } = await supaForBoot.auth.getClaims();
            const c = cl?.claims;
            const fresh = !!c?.sub && typeof c.exp==='number' && c.exp > Math.floor(Date.now()/1000)+30;
            // only "confirm" the seeded user when the token is still valid; an
            // expired-but-signed token must NOT short-circuit the refresh, or an
            // infrequent user is left holding a dead session (looks like lost access)
            if(fresh && authUserRef.current && authUserRef.current.id===c.sub) return;
            const { data:{ user:v } } = await supaForBoot.auth.getUser(); // revalidates + refreshes
            authUserRef.current = v || null;
            return;
          }
        } catch { /* fall through to getUser */ }
        try { const { data:{ user:v } } = await supaForBoot.auth.getUser(); authUserRef.current = v || null; } catch { /* */ }
      })();
      const localSessions=getSessionsForMembership(bootMembership).sort((a,b)=>b.date.localeCompare(a.date));setSessions(localSessions);
      _pm(`local sessions (${localSessions.length})`);

      // Drop clips that have neither a local blob nor a cloud copy — they can't be
      // played, thumbnailed or uploaded, so they're pure noise in the library. These
      // are the leftovers of the Android "skip blob on mobile" bug; crew (TL3) can't
      // delete clips themselves, so the app clears them out on load.
      try {
        const nDead = await pruneInertVideos();
        if (nDead) addLog(`🧹 Removed ${nDead} unusable clip${nDead === 1 ? '' : 's'} (no video data, never reached the cloud) — re-import to upload them.`);
        // Collapse duplicate rows left by retried imports — each copy was separately
        // queued to sync, so the same footage would upload several times over.
        const nDupe = await dedupeVideos();
        if (nDupe) addLog(`🧹 Merged ${nDupe} duplicate clip entr${nDupe === 1 ? 'y' : 'ies'} from repeated imports.`);
      } catch { /* non-fatal */ }
      _pm('prune + dedupe');

      // ── Mobile progressive load ───────────────────────────────────────────
      // On mobile we only fetch full video blobs + log data for the latest session.
      // Older sessions show thumbnail/metadata only — full data loads on-demand.
      const vids=await getAllVideosForMembership(bootMembership);
      _pm(`getAllVideos (${vids.length} clips, blob URLs minted)`);
      // Open the most recent day that has ANY data — video, log, events or photos.
      // This used to prefer VIDEO footage and only fall back when there was no
      // video anywhere, which meant a day with just a logfile was never opened:
      // upload a log to a boat that already has clips and the app still landed on
      // the last day someone filmed. Empty sessions are still skipped.
      const videoDates=vids.map(v=>v.sessionDate).filter(Boolean).sort();
      const latestVideoDate=videoDates.length?videoDates[videoDates.length-1]:null;
      const latestDataDate=localSessions
        .filter(s=>hasOpenableData(s) && s.date<=today)
        .map(s=>s.date).sort().reverse()[0] || null;
      const latestDate=[latestDataDate,latestVideoDate].filter(Boolean).sort().reverse()[0]
        ||localSessions[0]?.date||today;
      const isRecent=(date)=>date===today||date===latestDate;
      // On mobile: skip expensive enrichVideo (requires full log read) for old sessions.
      // Clips share dates (e.g. 10 sessions ⇒ ~10 unique days but ~100 clips), so read
      // each day's log+xml ONCE and reuse. Reading them per-clip re-deserialised the same
      // big day-logs from IndexedDB ~N times and was the dominant first-paint cost
      // (~6s for 97 clips). Cache the PROMISE so concurrent map() calls dedupe too.
      const _lxCache=new Map();
      const _getLX=(d)=>{ let p=_lxCache.get(d); if(!p){ p=(async()=>({log:await getLogData(d),xml:await getXmlData(d)}))(); _lxCache.set(d,p); } return p; };
      const enriched=await Promise.all(vids.map(async v=>{
        const d=v.sessionDate||today;
        if(!isRecent(d)) return v; // fast first paint: only enrich recent clips (old clips enrich after paint on desktop / on demand on mobile)
        const {log,xml}=await _getLX(d);
        return enrichVideo(v,log,xml);
      }));
      setAllVideos(enriched);
      _pm('enrich videos (log+xml reads)');
      if(enriched.length>0)setSelectedVideo(enriched[0]);

      // Reuse the per-date cache — latestDate was almost always already read above.
      const {log:latestLog,xml:latestXml}=await _getLX(latestDate);
      if(latestLog){setLogData({...latestLog,source:"local"});setSessionTzOffset(latestLog.tzOffset??DEFAULT_TZ);}
      if(latestXml)setXmlData({...latestXml,source:"local"});
      setActiveDate(latestDate);
      // Tag list — paint from the LOCAL list immediately, then refresh from the
      // cloud in the background. cloudFetchTagList is a network round-trip that was
      // sitting in the pre-paint path (~1.3s of first paint on a real load).
      setSessionTagList(getTagList(latestDate));
      if(bootUser){
        cloudFetchTagList({userId:bootUser.id,date:latestDate})
          .then(tl=>{ if(tl) setSessionTagList(tl); })
          .catch(()=>{});
      }
      const latestSession=localSessions.find(s=>s.date===latestDate);
      if(latestSession?.tzOffset!=null)setSessionTzOffset(latestSession.tzOffset);
      setUnsyncedCount(getUnsyncedCount());setLoaded(true);
      _pm('★ FIRST PAINT (loaded=true)');

      // Desktop: finish enriching the OLDER clips in the background now that
      // first paint is done (mobile keeps them fully on-demand). This is what
      // used to make desktop boot slow — it enriched every clip's log BEFORE paint.
      if(!isMobile){
        (async()=>{
          const oldClips=vids.filter(v=>!isRecent(v.sessionDate||today));
          if(!oldClips.length) return;
          const more=await Promise.all(oldClips.map(async v=>{ const d=v.sessionDate||today; const {log,xml}=await _getLX(d); return enrichVideo(v,log,xml); }));
          const byId=new Map(more.map(v=>[v.id,v]));
          setAllVideos(p=>p.map(v=>byId.get(v.id)||v));
        })().catch(()=>{});
      }

      // Cloud check — on mobile defer until after paint
      const doCloud=async()=>{
        _pm('cloud: start');
        const cs=await checkCloudStatus();setCloudStatus(cs);
        _pm('cloud: checkCloudStatus');
        // Bunny R2 session listing is GLOBAL — every date in the zone, every
        // team. Historically only admins saw it; now we skip it entirely when
        // a workspace is active (per-team isolation wins). The Supabase
        // session list below is the team-scoped source of truth.
        if(cs?.available && effectiveRole==='admin' && !bootMembership){
          const remote=await listR2Sessions();
          const localDates=new Set(localSessions.map(s=>s.date));
          const newR=remote.filter(s=>!localDates.has(s.date));
          if(newR.length>0)setSessions(p=>[...p,...newR].sort((a,b)=>b.date.localeCompare(a.date)));
        }
        // Supabase sessions list (active membership scope) — merge into UI.
        try {
          const user=bootUser;   // reuse — no third auth.getUser round-trip
          if(user){
            // <UserPill> resolves the active membership and writes it to
            // localStorage asynchronously. On a first login — especially
            // mobile on slow wifi — that can land well after this boot step,
            // which would make the cloud session list come back empty and
            // leave the app blank until a manual Sync. Wait for it (up to
            // ~20s; the loop exits the instant the membership appears).
            const _wl=performance.now(); let _wi=0;
            for(;_wi<80 && !getActiveMembership(user.id);_wi++){
              await new Promise(r=>setTimeout(r,250));
            }
            _pm(`cloud: membership-wait (${Math.round(performance.now()-_wl)}ms, ${_wi} polls)`);
            // Eagerly warm the Boat Config tab (sails/scans/polar/rig) so it's
            // ready before the user opens it. Fire-and-forget.
            { const am=getActiveMembership(user.id); if(am?.team_id&&am?.boat_id) prefetchBoatConfig(am.team_id,am.boat_id); }
            const cloudSessions=await listSessionsCloud({userId:user.id});
            _pm(`cloud: listSessionsCloud (${cloudSessions.length} sessions)`);
            if(cloudSessions.length>0){
              setSessions(p=>{
                const merged=[...p];
                for(const s of cloudSessions){
                  const existing=merged.find(m=>m.date===s.date);
                  if(existing){
                    // Fill in the cloud video/photo counts if the local entry lacks them.
                    if(!existing.videoCount && s.video_count) existing.videoCount=s.video_count;
                    if(!existing.photoCount && s.photo_count) existing.photoCount=s.photo_count;
                    // Campaign event name (regatta) — cloud is the source of truth.
                    if(s.event!==undefined) existing.event=s.event;
                  }else{
                    merged.push({date:s.date, source:'supabase', videoCount:s.video_count||0, photoCount:s.photo_count||0, event:s.event||null});
                  }
                }
                return merged.sort((a,b)=>b.date.localeCompare(a.date));
              });
              // Pick the freshest session of either tier and jump there.
              // Previously we only jumped to the newest cloud date when
              // the user had ZERO local clips on the local-latest date —
              // which meant someone with stale May-20 clips on their
              // phone stayed on May 20 even though the cloud had a May-27
              // session ready. Now we always land on max(latest local,
              // newest cloud), so a refresh after a coach's desktop sync
              // takes mobile straight to the new session and auto-fills
              // its thumbnails via loadDate.
              //
              // Uses `latestDate` (the date boot() actually set active)
              // rather than the `activeDate` state var — that one's a
              // stale closure, frozen at TODAY() from the initial render.
              // Newest day with ANY data across local + cloud — same rule as boot
              // above, so the cloud step cannot drag the view back to the last
              // day someone filmed after boot correctly opened a log-only day.
              // A cloud row carries no hasLog flag, so treat any cloud session as
              // having data (it would not exist otherwise).
              const newestCloudDate = cloudSessions.map(s => s.date).sort().reverse()[0];
              const bestDate = [latestDate, newestCloudDate].filter(Boolean).sort().reverse()[0];
              if (bestDate && bestDate !== latestDate) {
                await loadDate(bestDate);
                _pm(`cloud: loadDate(${bestDate})`);
              }
            }
          }
        } catch { /* non-fatal */ }
        _pm('cloud: done');
      };
      if(isMobile) setTimeout(doCloud,1500); else doCloud();
    }
    boot();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // Mirrored into a ref just below, for the listeners registered once on mount.
  async function loadDate(date){
    const _lt0=performance.now(); const _lm=(l)=>{ try{ console.info(`[loadDate] ${l}: +${Math.round(performance.now()-_lt0)}ms`); }catch{ /* */ } };
    const loadSeq = ++loadDateSeqRef.current;   // this call's turn; latest wins
    setActiveDate(date);
    // Reset video thumbnail load tracking for the new date
    setVideoThumbsLoading(true);
    setVideoLoadedIds(new Set());
    setVideoTotalThumbs(0);
    setStreamPollTick(0); // fresh encoding-poll budget for the new session

    // ── Load log + xml — LOCAL ONLY here. The cloud download (getSessionCloud,
    // ~2.4s cold) is deferred to a background pass AFTER the video grid paints
    // (see end of function). The grid's thumbnails come from the inline Bunny
    // poster, not the day-log, so there's no reason to block clips-visible on it.
    let log = await getLogData(date);
    let xml = await getXmlData(date);
    _lm('local log+xml');

    // Reflect local state immediately — and clear the previous date's overlay.
    // Null when this is a cloud-only day; the background pass fills it in when
    // the download lands.
    setLogData(log?{...log,source:log.source||"local"}:null);
    if(log)setSessionTzOffset(log.tzOffset??DEFAULT_TZ);
    setXmlData(xml?{...xml,source:xml.source||"local"}:null);

    // Self-heal sync state against the cloud manifest, then refresh the unsynced
    // badge — so a log/xml already in the cloud (from another device or a lost
    // local flag) is recognised as synced and never re-uploaded (Phase 2).
    reconcileSessionSyncState(date).then(()=>setUnsyncedCount(getUnsyncedCount())).catch(()=>{});
    // ── Load videos ─────────────────────────────────────────────────────────
    let vids=await getVideosForDate(date);
    if(!vids.length){const all=await getAllVideos();vids=all.filter(v=>v.sessionDate===date);}
    _lm('local video rows');
    // Merge Supabase rows in. A clip can exist BOTH on this device (local
    // IDB, has the blob) and in Supabase (a cloud row). They must collapse
    // to ONE entry, or the library shows duplicates and batch-sync tries to
    // sync the blob-less cloud copy. The link is external_id (the cloud row
    // stores the local IDB id it was mirrored from); legacy rows fall back
    // to a bunny_stream_id match. When a match is found we keep the LOCAL
    // entry (its id + blob drive transcode/upload/crop) and copy the cloud
    // rendition state onto it; the cloud UUID is stashed as `cloudId` for
    // rendition PATCH + playback-URL resolution.
    try {
      const user=await getUserCached();
      _lm('getUser #3 (cached)');
      if(user){
        const cloudVids=await listVideosCloud({userId:user.id,date});
        _lm(`listVideosCloud (${cloudVids.length} clips)`);
        if(cloudVids.length){
          const localById=new Map(vids.map(v=>[v.id,v]));
          const localByStream=new Map(vids.filter(v=>v.streamId).map(v=>[v.streamId,v]));
          for(const cv of cloudVids){
            const shaped=toLegacyVideoShape(cv);
            const local=(shaped.externalId && localById.get(shaped.externalId))
                      || (cv.bunny_stream_id && localByStream.get(cv.bunny_stream_id))
                      || null;
            if(local){
              // Always link the cloud row so a later resync targets the
              // same Supabase entry. Only adopt the cloud's rendition
              // flags (hasProxy / hasOriginal / streamId) when the local
              // blob is in sync with what's actually uploaded — measured
              // by comparing localBlobModifiedAt (stamped on every crop)
              // against the cloud's proxy_uploaded_at. Without a stamp on
              // the local entry the cloud is assumed fresh, so legacy
              // already-uploaded clips don't get re-queued for sync.
              local.cloudId=shaped.id;
              // Tags are CLOUD-AUTHORITATIVE: every editor path now pushes
              // the tag set to the videos row, so adopting the cloud's
              // tags on every load propagates desktop edits to mobile (and
              // vice versa). Without this the merge kept the device's
              // stale IDB tags forever.
              if(Array.isArray(shaped.tags)) local.tags=shaped.tags;
              // startUtc is CLOUD-AUTHORITATIVE too — same reasoning as tags, and
              // for a bug that was live on 2026-07-11: the TIMELINE reads
              // videos.start_utc straight from the API, while the library, the
              // player and Analytics read this merged LOCAL entry. With no adoption
              // here the two stores drift and the SAME clip renders at two different
              // times (timeline 14:32, player 12:32). Take the cloud's start time and
              // write it back into IDB so both stores converge instead of arguing.
              if(shaped.startUtc!=null && shaped.startUtc!==local.startUtc){
                local.startUtc=shaped.startUtc;
                updateVideoStartUtc(local.id,shaped.startUtc).catch(()=>{});
              }
              const localMtime = local.localBlobModifiedAt || 0;
              const proxyMtime = shaped.proxyUploadedAt ? new Date(shaped.proxyUploadedAt).getTime() : 0;
              const origMtime  = shaped.originalUploadedAt ? new Date(shaped.originalUploadedAt).getTime() : 0;
              const cloudMtime = Math.max(proxyMtime, origMtime);
              const cloudFresh = localMtime === 0 || cloudMtime >= localMtime;
              if(cloudFresh){
                local.hasProxy=shaped.hasProxy;
                local.hasOriginal=shaped.hasOriginal;
                local.originalStreamId=shaped.originalStreamId;
                if(shaped.streamId && !local.streamId) local.streamId=shaped.streamId;
              }
            } else {
              vids.push(shaped); // cloud-only clip (uploaded from another device)
            }
          }
        }
      }
    } catch { /* non-fatal */ }

    // Admin fallback — if the boat-scoped query found nothing, try the
    // legacy single-tenant cloud session. Done BEFORE the first paint so
    // those clips are part of the early render.
    if(!vids.length&&cloudStatus?.available&&effectiveRole==='admin'){const r2=await fetchCloudSession(date, await currentStorageScope());if(r2?.videos?.length)vids=r2.videos;}

    // Re-enrich the current vids array with log + xml + sync offsets.
    const enrichAll=()=>vids.map(v=>enrichVideo(v,log,xml,syncOffsets));

    // EARLY PAINT — render the cards now. The videos GET route attaches each
    // clip's Bunny poster thumbnail inline, so the library can show an image
    // immediately instead of waiting on a per-clip signed-URL round-trip.
    // Playback URLs are resolved below in the background; that triggers a
    // second, cheap re-render once they land.
    _lm('video cloud-merge done → early paint');
    {
      const early=enrichAll();
      setAllVideos(early);
      setVideoTotalThumbs(early.filter(v => v.thumbnailUrl || (v.objectUrl && v.source!=="cloud")).length);
      setVideoThumbsLoading(false);
      const pend=campaignPendingClipRef.current;
      const match=pend?early.find(v=>v.id===pend||v.cloudId===pend||v.externalId===pend):null;
      setSelectedVideo(match||early[0]||null);
      if(pend) campaignPendingClipRef.current=null;
    }

    // ── Background: cloud day-log/xml + tag list + timeline ──────────────────
    // The grid is already on screen. The day-log is only needed for the on-clip
    // instrument overlay and auto-tags, so download it now (this is the ~2.4s
    // getSessionCloud that used to gate the grid) and re-enrich when it lands.
    // Guarded by loadSeq so a fast date switch can't clobber the newer date.
    (async()=>{
      try {
        let logChanged=false, xmlChanged=false;
        if(!log || !xml){
          const user=await getUserCached();
          if(user){
            const cs=await getSessionCloud({userId:user.id,date});
            _lm('getSessionCloud (log_data+xml_data download)');
            if(cs){
              if(!log && cs.log_data){ log={...cs.log_data,source:'supabase'}; logChanged=true; }
              if(!xml && cs.xml_data){ xml={...cs.xml_data,source:'supabase'}; xmlChanged=true; }
            }
          }
        }
        // Admin-only GLOBAL Bunny R2 fallback for a day with no team-scoped
        // log/xml. Everyone else stays inside their team's RLS-protected data.
        if((!log || !xml) && cloudStatus?.available && effectiveRole==='admin'){
          const r2=await fetchCloudSession(date, await currentStorageScope());
          if(!log && r2?.logData){ log={...r2.logData,source:'cloud'}; logChanged=true; }
          if(!xml && r2?.xmlData){ xml={...r2.xmlData,source:'cloud'}; xmlChanged=true; }
        }
        if(loadDateSeqRef.current!==loadSeq) return; // superseded by a newer loadDate

        if(logChanged && log){ setLogData({...log,source:log.source||"cloud"}); setSessionTzOffset(log.tzOffset??DEFAULT_TZ); }
        if(xmlChanged && xml){ setXmlData({...xml,source:xml.source||"cloud"}); }

        // Auto-build this day's Timeline Tree (needs xml) — best-effort, persists
        // to timeline_nodes. Backfills days uploaded before the producer existed.
        try {
          if(xml && campaignCfg?.teamId && campaignCfg?.boatId){
            const tlNodes=buildDayTimeline({ xml, boatId: campaignCfg.boatId, date });
            if(tlNodes.length){
              fetch(`/api/teams/${campaignCfg.teamId}/timeline`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ boat_id: campaignCfg.boatId, session_date: date, nodes: tlNodes })}).catch(()=>{});
            }
          }
        } catch {}
        _lm('xml + timeline build');

        // Re-enrich the grid now that the day-log/xml is in — overlay averages
        // and auto-tags populate. Keep the current selection, refreshed.
        if(logChanged || xmlChanged){
          // Re-enrich what is on screen NOW, not the `vids` snapshot taken before
          // the clip links were resolved. Replacing the list with that snapshot
          // wiped the selected clip's playback link a couple of seconds after it
          // arrived — on a phone without the day's log (i.e. most crew), the
          // player then waited on "bear with us" for good.
          const ids=new Set(vids.map(v=>v.id));
          setAllVideos(prev=>prev.map(v=>ids.has(v.id)?enrichVideo(v,log,xml,syncOffsets):v));
          setSelectedVideo(prev=> prev&&ids.has(prev.id) ? enrichVideo(prev,log,xml,syncOffsets) : prev);
        }
      } catch { /* non-fatal */ }

      // Tag list (cloud-backed when signed in) — also off the paint path.
      try {
        const user=await getUserCached();
        if(loadDateSeqRef.current!==loadSeq) return;
        if(user) setSessionTagList(await cloudFetchTagList({userId:user.id,date}));
        else setSessionTagList(getTagList(date));
      } catch { setSessionTagList(getTagList(date)); }
      _lm('tag list');
    })();

    // Playback URLs are NOT resolved here any more. Fetching a signed URL for every
    // clip on the day was ~one request per clip and the dominant cold-start cost
    // (boot profiling showed loadDate at ~4.7s for a 30-clip day). The grid cards
    // render from the inline Bunny poster attached by the videos GET route; a clip's
    // signed playback URL is resolved lazily by ensureClipUrl the moment it becomes
    // the selected clip (see the resolve-on-select effect above). A clip with a local
    // blob still plays from that immediately. The encoding poller keeps refreshing
    // any clip still transcoding.
  }
  loadDateRef.current = loadDate;

  async function handleImported({date,videos,logData:ld,xmlData:xd,keepTab=false}){
    if(ld)setLogData({...ld,source:"local"});if(xd)setXmlData({...xd,source:"local"});
    // Read local sessions filtered to the active workspace so imports into
    // workspace A don't appear when later viewing workspace B.
    const supaForReload = getBrowserSupabase();
    const { data: { user: reloadUser } } = await supaForReload.auth.getUser();
    const reloadMembership = reloadUser ? getActiveMembership(reloadUser.id) : null;
    setSessions(getSessionsForMembership(reloadMembership));setUnsyncedCount(getUnsyncedCount());
    // Load from IDB to ensure state matches storage (catches second import race)
    await loadDate(date);
    // DON'T jump to Videos. Importing used to switch tabs automatically, which
    // threw the user off the very log that says what is happening — the upload
    // messages, the per-clip progress bar, and any failure all live on the
    // Upload tab. The tab bar is always visible, so getting to Videos is one
    // click whenever they actually want it.
    //
    // keepTab is still accepted so the watcher can be explicit about it, but the
    // default is now to stay either way: the switch was wrong for a manual
    // import too, which is what the request was about.
    void keepTab;

    // ── Phase B auto-sync (mobile only) ────────────────────────────────────
    // Mobile users (especially TL1/crew/etc.) need their imports to reach
    // the cloud without having to find a button, so mobile imports auto-sync
    // their proxies in the background. Desktop is deliberately NOT auto-synced:
    // coaches crop clips first and then push everything with the batch
    // "Sync proxies" button (see BatchSyncPanel / handleBatchSyncProxies).
    if (isMobile && videos?.length && cloudStatus?.available) {
      // WI-FI ONLY. Phone clips are smaller than a GoPro's, but a session is still
      // hundreds of MB — never spend a crew member's cellular data without asking.
      // On mobile data we hold the clips; `flushOnWifi` below picks them up the
      // moment a Wi-Fi link appears, and the Upload button is always there to
      // override. See onWifi() for why an unknown link counts as "not Wi-Fi".
      if (onWifi()) {
        enqueueAutoSync(videos, date);
      } else {
        addLog(`📶 ${videos.length} clip${videos.length === 1 ? '' : 's'} held — will upload automatically on Wi-Fi (or tap Upload now).`);
      }
    }

    // ── Re-enrich & update cloud metadata ──────────────────────────────────
    // When log/event files are uploaded after videos were already synced,
    // update the cloud metadata so other devices get enriched data.
    if((ld||xd)&&cloudStatus?.available){
      // loadDate already enriched allVideos in state — use the freshly enriched data
      // Small delay to let loadDate's setState propagate
      setTimeout(async()=>{
        try{
          const log=await getLogData(date);
          const xml=await getXmlData(date);
          const vids=await getVideosForDate(date);
          const enrichedVids=vids.map(v=>enrichVideo(v,log,xml,syncOffsets));
          // Get photos from localStorage for this date
          const photoMeta=JSON.parse(localStorage.getItem(`ssa:photos-meta:${date}`)||"[]");
          const enrichedPhotos=photoMeta.length&&(log||xml)
            ? photoMeta.map(p=>{
                const e={...p};
                if(log?.rows?.length&&p.utc){
                  // nearestRow is the same "closest sample within 5 minutes" rule
                  // written as a binary search — this was a full scan of the log
                  // for every photo in the day.
                  const nearRow=nearestRow(log.rows,p.utc);
                  if(nearRow){e.tws=nearRow.tws;e.twa=nearRow.twa;e.awa=nearRow.awa;e.bsp=nearRow.bsp;e.heel=nearRow.heel;e.vmg=nearRow.vmg;}
                }
                if(xml){
                  const sailEvts=xml.sailsUpEvents||[];
                  const before=sailEvts.filter(s=>s.utc<=p.utc).sort((a,b)=>b.utc-a.utc)[0];
                  e.sails=before?.sails||[];
                  e.boat=xml.meta?.boat||null;e.location=xml.meta?.location||null;
                }
                return e;
              })
            : photoMeta;
          // Save enriched photos back to localStorage
          if(enrichedPhotos.length&&(log||xml)){
            localStorage.setItem(`ssa:photos-meta:${date}`,JSON.stringify(enrichedPhotos.map(({objectUrl,...p})=>p)));
          }
          await updateCloudSessionMetadata(date,{
            videos:enrichedVids,logData:log,xmlData:xml,
            photos:enrichedPhotos.length?enrichedPhotos:undefined,
            scope: await currentStorageScope(),
          });
        }catch(err){console.error("[SSA] Cloud metadata update failed:",err);}
      },500);
    }
  }


  const selectedSail=sailFilter?sailInventory.find(s=>s.id===sailFilter):null;
  const sailTokens=selectedSail?[selectedSail.name,selectedSail.category,selectedSail.design_code,...(Array.isArray(selectedSail.specs?.aliases)?selectedSail.specs.aliases:[])].filter(Boolean).map(s=>String(s).trim().toLowerCase()):null;
  const matchesSail=tags=>!sailTokens||(tags||[]).some(t=>sailTokens.includes(String(t).trim().toLowerCase()));
  const displayed=allVideos
    .filter(v=>{const ok=selectedTags.length===0||selectedTags.every(t=>(v.tags||[]).includes(t));const q=searchQuery.toLowerCase();return ok&&matchesSail(v.tags)&&(!q||v.title?.toLowerCase().includes(q)||(v.tags||[]).some(t=>t.includes(q)));})
    // "Date" means WHEN THE CLIP WAS SHOT, not when it was imported. It used to sort by
    // addedAt, so uploading a day's footage in three batches interleaved them and the
    // library read out of order. Sort by startUtc — the clip's place on the water —
    // ASCENDING, so the session reads first-to-last like the day did. Clips with no
    // start time yet sink to the bottom rather than jumping to the top.
    .sort((a,b)=>{
      if(sortBy==="tws")   return (b.twsAvg||0)-(a.twsAvg||0);
      if(sortBy==="twa")   return (Math.abs(a.twaAvg||0))-(Math.abs(b.twaAvg||0));
      if(sortBy==="vmg")   return (b.vmgAvg||0)-(a.vmgAvg||0);
      if(sortBy==="polar") return (b.polpercAvg||0)-(a.polpercAvg||0);
      const ta=a.startUtc??null, tb=b.startUtc??null;
      if(ta==null && tb==null) return (b.addedAt||0)-(a.addedAt||0); // neither timed: newest import first
      if(ta==null) return 1;                                          // untimed clips last
      if(tb==null) return -1;
      return ta-tb;                                                   // chronological, as sailed
    });

  const allTags=[...new Set(allVideos.flatMap(v=>v.tags||[]))].sort();
  const isManTag=t=>["tack","gybe","topmark","mark","race-start","upwind","reach","downwind"].includes(t);
  const toggleTag=t=>setSelectedTags(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t]);

  if(!loaded)return<div style={{minHeight:"100vh",background:"#030F1A",display:"flex",alignItems:"center",justifyContent:"center",color:"#334155",fontSize:13}}>Loading Shared Sailing Analytics…</div>;

  // Event-file saillist reconciliation modal (rendered over both layouts).
  const sailDiffModal = sailDiff && campaignCfg?.teamId && campaignCfg?.boatId ? (
    <SailListDiffModal
      teamId={campaignCfg.teamId} boatId={campaignCfg.boatId}
      canEdit={['admin','team_manager','coach'].includes(effectiveRole)}
      inventory={sailInventory} names={sailDiff.names}
      onClose={()=>setSailDiff(null)} onResolved={refetchSails}
    />
  ) : null;

  // Timeline clip playback — the real overlay player in a modal over everything
  // (incl. the Timeline). Minimal props: no crop / sync / HD-toggle toolbar
  // buttons, but the base "Fullscreen (with data overlay)" control stays.
  const videoModal = (videoModalOpen && selectedVideo) ? (
    <div onClick={()=>setVideoModalOpen(false)} style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(3,15,26,0.55)",display:"flex",alignItems:"stretch",justifyContent:"flex-end",overflow:"hidden"}}>
      {/* Left spacer keeps the narrow timeline visible; the drawer FLEXES to fill
          the rest — no 100vw (which would include the scrollbar and cause a
          document-wide horizontal scroll). Full screen on mobile. */}
      {!isMobile && <div style={{width:320,flexShrink:0}} aria-hidden/>}
      <div onClick={e=>e.stopPropagation()} style={{position:"relative",flex:"1 1 auto",minWidth:0,height:"100%",overflowY:"auto",background:"#050E1C",borderLeft:"1px solid #1E3A5A",boxShadow:"-12px 0 40px rgba(0,0,0,0.5)",padding:isMobile?"40px 10px 12px":"44px 16px 16px"}}>
        <button onClick={()=>setVideoModalOpen(false)} aria-label="Close" style={{position:"absolute",top:8,left:"50%",transform:"translateX(-50%)",zIndex:3,width:38,height:34,borderRadius:8,border:"1px solid #1E3A5A",background:"#0A1929",color:"#E2E8F0",fontSize:18,lineHeight:"1",cursor:"pointer"}}>✕</button>
        {/* Cap the width so the 16:9 stage + controls fit the viewport height —
            the BOX fills the screen, the video sizes to fit inside it. */}
        <div style={{width:"100%",maxWidth:isMobile?"none":"calc((100vh - 190px) * 16 / 9)",margin:"0 auto"}}>
          <VideoPlayer onRecheckStream={recheckStream}
            video={selectedVideo}
            logData={logData}
            xmlData={xmlData}
            syncOffset={syncOffsets[selectedVideo.id]||0}
            sessionTzOffset={sessionTzOffset}
            onPlayUtc={handlePlayUtc}
            onRotate={canRotate ? (deg)=>rotateVideo(selectedVideo, deg) : null}
            canShare={canShareVideos(effectiveRole)}
            autoPlay
          />
        </div>
      </div>
    </div>
  ) : null;

  // ── Mobile render ────────────────────────────────────────────────────────────
  if(isMobile) return(
    <TzCtx.Provider value={sessionTzOffset||0}>
    <>{sailDiffModal}{videoModal}<MobileShell
      onRecheckStream={recheckStream}
      activeTab={activeTab} setActiveTab={setActiveTab}
      role={role} perms={perms}
      allVideos={allVideos} setAllVideos={setAllVideos}
      sessions={visibleSessions} setSessions={setSessions}
      activeDate={activeDate} setActiveDate={setActiveDate}
      selectedVideo={selectedVideo} setSelectedVideo={setSelectedVideo}
      logData={logData} setLogData={setLogData}
      xmlData={xmlData} setXmlData={setXmlData}
      sessionTzOffset={sessionTzOffset}
      sessionTagList={sessionTagList} setSessionTagList={setSessionTagList}
      syncOffsets={syncOffsets} setSyncOffsets={setSyncOffsets}
      saveSyncForVideos={saveSyncForVideos}
      saveTagsForVideo={saveTagsForVideo}
      tagSuggestionList={tagSuggestionList}
      cloudStatus={cloudStatus} unsyncedCount={unsyncedCount}
      searchQuery={searchQuery} setSearchQuery={setSearchQuery}
      sortBy={sortBy} setSortBy={setSortBy}
      selectedTags={selectedTags} setSelectedTags={setSelectedTags}
      allTags={allTags} isManTag={isManTag} toggleTag={toggleTag}
      displayed={displayed}
      loadDate={loadDate} onSelectDate={loadDate} handleImported={handleImported}
      handlePlayUtc={handlePlayUtc} playUtc={playUtc}
      canSeeAnalytics={canSeeAnalytics} canUseAI={canUseAI}
      canSeeSailScanTab={canSeeSailScanTab} canSeeSquashShotsTab={canSeeSquashShotsTab} canSeeToolsTab={canSeeToolsTab} canSeeBoatConfig={canSeeBoatConfig}
      canSeeAnalyticsData={canSeeAnalyticsData} canSeeSailScanPhotos={canSeeSailScanPhotos}
      showOnlyLatestDay={showOnlyLatestDay} effectiveRole={effectiveRole}
      campaignOn={campaignOn} campaignCfg={campaignCfg} activeMem={activeMem} openCampaignVideo={openCampaignVideo} openVideoModal={openVideoModal}
      playClipInModal={playClipInModal} myUid={myUid}
      sailInventory={sailInventory} setSailDiff={setSailDiff}
      onRotateVideo={canRotate ? rotateVideo : null}
      hasMountedAnalytics={hasMountedAnalytics}
      updateVideoTagsFn={updateVideoTags}
      computeAutoTagsFn={computeAutoTags}
      photos={photos} setPhotos={setPhotos}
      onMobileSync={handleMobileCloudSync}
      onSyncProxies={handleBatchSyncProxies}
      onUploadOriginals={handleBatchUploadOriginals}
      syncErrors={syncErrors}
      mobileSyncState={mobileSyncState}
      setMobileSyncState={setMobileSyncState}
      onThumbLoad={markVideoThumbLoaded}
      videoThumbsLoading={videoThumbsLoading}
      videoLoadedIds={videoLoadedIds}
      videoTotalThumbs={videoTotalThumbs}
    /></>
    </TzCtx.Provider>
  );

  return(
    <TzCtx.Provider value={sessionTzOffset||0}>
    <>{sailDiffModal}{videoModal}
    <div style={{minHeight:"100vh",width:"100%",maxWidth:"100%",overflowX:"hidden",background:"#030F1A",color:"#E2E8F0",fontFamily:"'Segoe UI',system-ui,sans-serif",display:"flex",flexDirection:"column"}}>
      <header style={{background:"#050E1C",borderBottom:"1px solid #1E3A5A",padding:"0 18px",display:"flex",alignItems:"center",height:52,gap:14,position:"sticky",top:0,zIndex:100,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:15,fontWeight:700,color:"#E2E8F0"}}>Shared</span><span style={{fontSize:15,fontWeight:700,color:"#06B6D4"}}>Sailing Analytics</span></div>
        <nav style={{marginLeft:10}}>
          <select value={activeTab} onChange={e=>setActiveTab(e.target.value)} title="Menu"
            style={{background:"#071624",border:"1px solid #1E3A5A",borderRadius:7,padding:"6px 12px",color:"#E2E8F0",fontSize:12,fontWeight:600,cursor:"pointer",outline:"none",minWidth:130}}>
            {["timeline","campaign","boatconfig","weather","library","photos","tagger","analytics","upload","tools","admin"].filter(tab => {
              if (tab === "campaign" && (!campaignOn || effectiveRole === 'guest')) return false;
              if (tab === "boatconfig" && (!campaignOn || !canSeeBoatConfig)) return false;
              if (tab === "tools" && !canSeeToolsTab) return false;
              if (tab === "admin" && effectiveRole !== 'admin') return false;
              if (tab === "tagger" && effectiveRole === 'guest') return false;
              return true;
            }).map(tab=>{
              const label = tab==="timeline"?"Timeline":tab==="library"?"Videos":tab==="weather"?"Weather":tab==="boatconfig"?"Boat":tab==="tools"?"Tools":tab==="tagger"?"Tags":tab.charAt(0).toUpperCase()+tab.slice(1);
              return <option key={tab} value={tab} style={{background:"#0A1929"}}>{label}{tab==="upload"&&unsyncedCount>0?` (${unsyncedCount})`:""}</option>;
            })}
          </select>
        </nav>
        <div style={{flex:1}}/>
        <div style={{display:"flex",alignItems:"center",gap:5,background:"#071624",border:"1px solid #1E3A5A",borderRadius:7,padding:"4px 8px"}}>
          <span style={{fontSize:8,color:"#334155",letterSpacing:1}}>ROLE</span>
          <select value={role} onChange={e=>setRole(e.target.value)} style={{background:"transparent",border:"none",color:"#94A3B8",fontSize:11,cursor:"pointer",outline:"none"}}>
            {Object.entries(ROLES).map(([k,v])=><option key={k} value={k} style={{background:"#0A1929"}}>{v.label}</option>)}
          </select>
        </div>
      </header>

      {/* ── Tab panes ────────────────────────────────────────────────────────────
          Library and Analytics stay mounted after first visit (visibility:hidden
          rather than display:none) so the video element keeps playing and
          Leaflet retains its map dimensions when switching between tabs.
          Upload and Admin are cheap to remount on demand.
      ─────────────────────────────────────────────────────────────────────── */}
      <div style={{display:"flex",flex:1,overflow:"hidden",position:"relative"}}>

        {/* ── LIBRARY PANE — always mounted ──────────────────────────────────── */}
        <div style={{
          position:"absolute",inset:0,display:"flex",overflow:"hidden",
          visibility:activeTab==="library"?"visible":"hidden",
          pointerEvents:activeTab==="library"?"auto":"none",
          zIndex:activeTab==="library"?2:1,
        }}>
          {/* Sidebar */}
          <aside style={{width:160,background:"#050E1C",borderRight:"1px solid #1E3A5A",display:"flex",flexDirection:"column",overflowY:"auto",flexShrink:0}}>
            <div style={{padding:"12px 11px 6px"}}>
              <div style={{fontSize:9,color:"#1E3A5A",letterSpacing:2,textTransform:"uppercase",marginBottom:7}}>Sessions</div>
              {visibleSessions.length===0&&<div style={{fontSize:10,color:"#1E3A5A",padding:"4px 3px"}}>No sessions yet</div>}
              {(()=>{
                // Compute Day N per regatta: group all known sessions by
                // event, sort each group by date, assign 1..N. Built once
                // over the full session list so day numbering survives
                // photo-only or no-video days within the regatta.
                const evMap=new Map(); // date → {event, dayN}
                const g=new Map();
                for(const s of visibleSessions){ if(s.event){ if(!g.has(s.event)) g.set(s.event,[]); g.get(s.event).push(s.date); } }
                for(const [ev,ds] of g){ ds.slice().sort().forEach((d,i)=>evMap.set(d,{event:ev,dayN:i+1})); }
                return visibleSessions.filter(s=>hasOpenableData(s) && s.date<=TODAY()).map(s=>{
                  const isLocal=!(s.cloudSynced||s.source==="cloud"||s.source==="supabase");const isActive=activeDate===s.date;
                  const ev=evMap.get(s.date);
                  return(<div key={s.date} onClick={()=>loadDate(s.date)} style={{padding:"5px 6px",borderRadius:5,cursor:"pointer",marginBottom:2,background:isActive?"#1E3A5A":"transparent",border:`1px solid ${isActive?"#06B6D430":"transparent"}`}}>
                    <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}><span style={{fontSize:11,color:isActive?"#06B6D4":"#64748B",fontFamily:"monospace"}}>{s.date===TODAY()?"Today":fmtDate(s.date)}</span><SrcBadge source={isLocal?"local":"cloud"}/></div>
                    {ev&&<div style={{fontSize:9,color:"#EF4444",fontWeight:700,marginBottom:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={`${ev.event} Day ${ev.dayN}`}>🏁 {ev.event} Day {ev.dayN}</div>}
                    <div style={{fontSize:9,color:"#1E3A5A"}}>{s.videoCount||0}v{s.hasLog?" ·log":""}{s.hasXml?" ·ev":""}{s.location?` · ${s.location}`:""}</div>
                  </div>);
                });
              })()}
            </div>
            <div style={{height:1,background:"#0F2030",margin:"4px 11px 6px"}}/>
            <div style={{padding:"0 11px 8px"}}>
              <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search clips…" style={{width:"100%",background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 8px",color:"#E2E8F0",fontSize:11,outline:"none",boxSizing:"border-box",marginBottom:7}}/>
              {sailInventory.length>0&&<select value={sailFilter} onChange={e=>setSailFilter(e.target.value)} style={{width:"100%",background:"#071624",border:`1px solid ${sailFilter?"#06B6D4":"#1E3A5A"}`,borderRadius:5,padding:"5px 8px",color:sailFilter?"#06B6D4":"#E2E8F0",fontSize:11,outline:"none",boxSizing:"border-box",marginBottom:7,cursor:"pointer"}}>
                <option value="">All sails</option>
                {sailInventory.filter(s=>!s.retired).map(s=><option key={s.id} value={s.id}>{s.category?`${s.category} · ${s.name}`:s.name}</option>)}
              </select>}
              {["date","tws","twa","vmg","polar"].map(s=><button key={s} onClick={()=>setSortBy(s)} style={{display:"block",width:"100%",textAlign:"left",background:sortBy===s?"#1E3A5A":"none",border:"none",borderRadius:4,padding:"3px 6px",color:sortBy===s?"#06B6D4":"#334155",cursor:"pointer",fontSize:10,marginBottom:1}}>{sortBy===s?"▸ ":"  "}{s==="date"?"Time (as sailed)":s==="tws"?"Wind (TWS)":s==="twa"?"Wind angle":s==="vmg"?"VMG":"Polar %"}</button>)}
            </div>
            {allTags.length>0&&<div style={{padding:"0 11px",flex:1}}>
              <div style={{fontSize:8,color:"#1E3A5A",letterSpacing:2,textTransform:"uppercase",marginBottom:5}}>Filter</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
                {allTags.filter(isManTag).map(t=><button key={t} onClick={()=>toggleTag(t)} style={{background:selectedTags.includes(t)?"#06B6D4":"#0A1929",border:`1px solid ${selectedTags.includes(t)?"#06B6D4":"#1E3A5A"}`,borderRadius:3,padding:"1px 5px",color:selectedTags.includes(t)?"#000":"#7DD3FC",fontSize:9,cursor:"pointer",fontFamily:"monospace"}}>{t}</button>)}
              </div>
              {selectedTags.length>0&&<button onClick={()=>setSelectedTags([])} style={{background:"none",border:"1px solid #EF444440",borderRadius:4,padding:"2px 8px",color:"#EF4444",fontSize:9,cursor:"pointer",width:"100%",marginTop:6}}>Clear</button>}
            </div>}
          </aside>

          {/* Library main content */}
          <main style={{flex:1,display:"flex",overflow:"hidden",position:"relative"}}>

            {/* ── Sync modal overlay ──────────────────────────────────────── */}
            {libSyncProgress&&(
              <div style={{position:"absolute",inset:0,background:"rgba(3,15,26,0.88)",
                zIndex:50,display:"flex",flexDirection:"column",justifyContent:"center",
                alignItems:"center",padding:24}}>
                <div style={{width:"100%",maxWidth:480}}>
                  <SyncProgressPanel progress={libSyncProgress} phase={libSyncPhase||"syncing"}
                    onCancel={()=>{
                      libSyncAbortRef.current=true;
                      clearInterval(libSyncTimerRef.current);
                      setLibSyncProgress(null);setLibSyncPhase(null);
                    }}/>
                  {libSyncPhase==="done"&&(
                    <button onClick={()=>{setLibSyncProgress(null);setLibSyncPhase(null);setUnsyncedCount(getUnsyncedCount());}}
                      style={{marginTop:12,width:"100%",background:"#1D9E75",border:"none",
                        borderRadius:8,padding:"10px",color:"#fff",fontWeight:700,
                        fontSize:13,cursor:"pointer"}}>
                      ✓ Done
                    </button>
                  )}
                </div>
              </div>
            )}

            <div style={{width:280,minWidth:280,overflowY:"auto",padding:"10px 8px",flexShrink:0,borderRight:"1px solid #0F2030"}}>
              {(logData||xmlData)&&<div style={{display:"flex",gap:7,marginBottom:10,flexWrap:"wrap",alignItems:"center"}}>
                {logData&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:3,background:logData.source==="local"?"#1D9E7510":"#8B5CF610",border:`1px solid ${logData.source==="local"?"#1D9E7530":"#8B5CF630"}`,color:logData.source==="local"?"#1D9E75":"#8B5CF6"}}>{logData.source==="local"?"● Local":"● Cloud"} log · {logData.rows?.length?.toLocaleString()} rows</span>}
                {xmlData&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:3,background:"#8B5CF610",border:"1px solid #8B5CF630",color:"#8B5CF6"}}>{xmlData.source==="local"?"● Local":"● Cloud"} events · {xmlData.tackJibes?.length} manoeuvres</span>}
                <span style={{fontSize:10,color:"#1E3A5A"}}>{displayed.length} clip{displayed.length!==1?"s":""}</span>
                <div style={{flex:1}}/>
                {/* ── Sync ↑ button — visible when session has unsynced local data ── */}
                {cloudStatus?.available&&perms.canSync&&(logData||xmlData||allVideos.length>0)&&(
                  <button onClick={async()=>{
                    // Boat guard, before anything is read or any progress shown:
                    // activeDate may belong to another boat, and the push would
                    // file it under this one. See src/lib/syncBoatGuard.ts.
                    const libScope = scopeOfMembership(activeMem);
                    const libRefusal = daySyncRefusal(activeDate, getSessionsForMembership(activeMem), activeMem, fmtDate);
                    if(libRefusal){
                      addLog(libRefusal);
                      setLibSyncProgress({items:[],overall:0,elapsed:0,error:libRefusal});
                      setLibSyncPhase("syncing");
                      return;
                    }
                    const vids=await getVideosForDate(activeDate);
                    const logD=await getLogData(activeDate);
                    const xmlD=await getXmlData(activeDate);
                    const items=[
                      {id:"log",label:"Log & Events",state:"pending",pct:0},
                      ...vids.map(v=>({id:v.id,label:v.name||v.title,state:"pending",pct:0}))
                    ];
                    libSyncAbortRef.current=false;
                    const startMs=Date.now();
                    libSyncTimerRef.current=setInterval(()=>
                      setLibSyncProgress(p=>p?{...p,elapsed:Math.round((Date.now()-startMs)/1000)}:p),1000);
                    setLibSyncProgress({items,overall:0,elapsed:0,error:null});
                    setLibSyncPhase("syncing");
                    const setItem=(id,patch)=>setLibSyncProgress(p=>p?{...p,items:p.items.map(it=>it.id===id?{...it,...patch}:it)}:p);
                    try{
                      let curVid=null;
                      // Resolve user once so the mirror callback below can
                      // push each clip to Supabase as soon as it lands.
                      let libUser=null;
                      try{const sb=getBrowserSupabase();const {data:{user}}=await sb.auth.getUser();libUser=user||null;}catch{}
                      await syncSessionToCloud(activeDate,logD,xmlD,
                        vids,
                        msg=>{
                          if(libSyncAbortRef.current)return;
                          if(msg.includes("log")&&msg.includes("✓")) setItem("log",{state:"done",pct:100});
                          const vMatch=vids.find(v=>msg.includes(v.name||v.title||"")&&msg.includes("✓"));
                          if(vMatch) setItem(vMatch.id,{state:"done",pct:100});
                          else if(vids.find(v=>msg.includes(v.name||v.title||""))){
                            const vf=vids.find(v=>msg.includes(v.name||v.title||""));
                            if(vf&&!curVid){curVid=vf.id;setItem(curVid,{state:"active",pct:50});}
                          }
                          // recalc overall
                          setLibSyncProgress(p=>{
                            if(!p)return p;
                            const avg=p.items.reduce((s,it)=>s+(it.pct||0),0)/p.items.length;
                            return{...p,overall:Math.round(avg)};
                          });
                        },
                        {
                          scope: libScope,
                          // Per-video Supabase mirror — clips appear for
                          // teammates as each finishes, not after the batch.
                          onVideoSynced: makeVideoMirrorCallback({
                            userId: libUser?.id || null,
                            sessionDate: activeDate,
                            syncOffsets,
                          }),
                        });
                      setLibSyncPhase("done");
                      setLibSyncProgress(p=>p?{...p,overall:100}:p);
                      markCloudSynced(activeDate);
                      setUnsyncedCount(getUnsyncedCount());
                    }catch(e){
                      setLibSyncProgress(p=>p?{...p,error:String(e)}:p);
                    }finally{clearInterval(libSyncTimerRef.current);}
                  }}
                  style={{background:"#8B5CF6",border:"none",borderRadius:5,padding:"3px 10px",
                    color:"#fff",cursor:"pointer",fontSize:10,fontWeight:700,display:"flex",
                    alignItems:"center",gap:4}}>
                    ↑ {unsyncedCount>0?"Sync":"Re-sync"}{unsyncedCount>0?` (${unsyncedCount})`:""}
                  </button>
                )}
                {xmlData&&allVideos.length>0&&perms.canImport&&(
                  <button onClick={async()=>{
                    let count=0;
                    const updated=await Promise.all(allVideos.map(async v=>{
                      if(!v.startUtc)return v;
                      const newTags=computeAutoTags(v.startUtc,v.duration,logData,xmlData,syncOffsets[v.id]||0);
                      const manualTags=(v.tags||[]).filter(t=>{if(isAutoTag(t))return false;const meta=xmlData?.meta;if(meta?.location&&t===meta.location.toLowerCase().replace(/\s+/g,"-"))return false;if(meta?.boat&&t===meta.boat.toLowerCase().replace(/\s+/g,"-"))return false;if(meta?.dayType&&t===meta.dayType.toLowerCase().replace(/\s+/g,"-"))return false;return true;});
                      const merged=[...new Set([...newTags,...manualTags])];
                      await updateVideoTags(v.id,merged);
                      // Push to cloud so other devices pick up the re-tag.
                      pushVideoMetadataToCloud(v,{tags:merged});
                      count++;return{...v,tags:merged};
                    }));
                    setAllVideos(updated);
                    if(selectedVideo){const u=updated.find(v=>v.id===selectedVideo.id);if(u)setSelectedVideo(u);}
                    alert(`Re-tagged ${count} clip${count!==1?"s":""} using event data.`);
                  }} style={{background:"#8B5CF620",border:"1px solid #8B5CF640",borderRadius:5,padding:"3px 10px",color:"#8B5CF6",cursor:"pointer",fontSize:10,fontWeight:600}}>
                    ⚡ Re-tag {allVideos.filter(v=>v.startUtc).length} clips
                  </button>
                )}
              </div>}
              {/* ── Batch cloud sync — coach/admin, Phase B.3 ──────────────── */}
              {cloudStatus?.available && perms.canSync && allVideos.length>0 && (
                <BatchSyncPanel
                  videos={allVideos}
                  syncState={mobileSyncState}
                  onSyncProxies={handleBatchSyncProxies}
                  onUploadOriginals={handleBatchUploadOriginals}
                  syncErrors={syncErrors}
                />
              )}
              {allVideos.length===0&&<div style={{textAlign:"center",padding:"50px 20px",color:"#1E3A5A"}}><div style={{fontSize:32,marginBottom:14,opacity:0.4}}>📹</div><div style={{fontSize:13,fontWeight:600,color:"#334155",marginBottom:6}}>No videos for this session</div><div style={{fontSize:11,marginBottom:16}}>{perms.canImport?"Import in the Upload tab.":"Session not yet uploaded to cloud."}</div>{perms.canImport&&<button onClick={()=>setActiveTab("upload")} style={{background:"#06B6D4",border:"none",borderRadius:8,padding:"8px 20px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>Go to Upload</button>}</div>}
              {/* ── Clear-day nuke (admin/coach). Shown even with 0 local clips,
                     because ORPHAN cloud rows are exactly what needs clearing. ── */}
              {perms.canDelete && (
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  {clearDayBusy ? (
                    <span style={{fontSize:11,color:"#EF4444"}}>Clearing {activeDate}…</span>
                  ) : clearDayArmed ? (
                    <>
                      <span style={{fontSize:11,color:"#EF4444",fontWeight:600}}>Delete ALL clips for {fmtDate(activeDate)} — local, Bunny and cloud?</span>
                      <button onClick={handleClearDay} style={{background:"#EF4444",border:"none",borderRadius:6,padding:"5px 12px",color:"#fff",cursor:"pointer",fontSize:11,fontWeight:700}}>Delete all</button>
                      <button onClick={()=>setClearDayArmed(false)} style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,padding:"5px 10px",color:"#64748B",cursor:"pointer",fontSize:11}}>Cancel</button>
                    </>
                  ) : (
                    <button onClick={()=>setClearDayArmed(true)} style={{background:"none",border:"1px solid #EF444430",borderRadius:6,padding:"5px 12px",color:"#EF4444",cursor:"pointer",fontSize:11,opacity:0.75}}>🗑 Clear all clips for this day</button>
                  )}
                </div>
              )}
              {/* ── Batch select toolbar (admin/coach only) ── */}
              {perms.canDelete && allVideos.length > 0 && (
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  <button onClick={()=>batchMode?clearBatch():setBatchMode(true)}
                    style={{background:batchMode?"#EF444420":"#0A1929",border:`1px solid ${batchMode?"#EF444440":"#1E3A5A"}`,
                      borderRadius:6,padding:"5px 12px",color:batchMode?"#EF4444":"#64748B",cursor:"pointer",fontSize:11,fontWeight:600}}>
                    {batchMode?"✕ Cancel":"☑ Select"}
                  </button>
                  {batchMode&&(
                    <>
                      <button onClick={()=>{const allIds=new Set(displayed.map(v=>v.id));setBatchSelected(allIds);}}
                        style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,padding:"5px 10px",color:"#64748B",cursor:"pointer",fontSize:10}}>All</button>
                      <button onClick={()=>setBatchSelected(new Set())}
                        style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,padding:"5px 10px",color:"#64748B",cursor:"pointer",fontSize:10}}>None</button>
                      <span style={{fontSize:11,color:"#475569",fontFamily:"monospace"}}>{batchSelected.size} selected</span>
                      {batchSelected.size>0&&(
                        <>
                          <button onClick={()=>setBatchSyncOpen(o=>!o)}
                            style={{marginLeft:"auto",background:batchSyncOpen?"#06B6D420":"#0A1929",border:`1px solid ${batchSyncOpen?"#06B6D450":"#1E3A5A"}`,borderRadius:6,padding:"5px 12px",color:"#06B6D4",cursor:"pointer",fontSize:11,fontWeight:700}}>
                            ⟲ Sync {batchSelected.size}
                          </button>
                          <button onClick={handleBatchSaveToDisk}
                            title="Download each selected clip's local file to disk for external ffmpeg compression"
                            style={{background:"#06B6D420",border:"1px solid #06B6D450",borderRadius:6,padding:"5px 12px",color:"#06B6D4",cursor:"pointer",fontSize:11,fontWeight:700}}>
                            ↓ Save {batchSelected.size} to disk
                          </button>
                          <button onClick={handleBatchUploadCompressed}
                            title="Upload compressed copies (from disk) for each selected clip — matched by filename stem. Local HD blobs are left untouched."
                            style={{background:"#8B5CF620",border:"1px solid #8B5CF650",borderRadius:6,padding:"5px 12px",color:"#A78BFA",cursor:"pointer",fontSize:11,fontWeight:700}}>
                            ↑ Upload {batchSelected.size} compressed
                          </button>
                          <button onClick={()=>{if(confirm(`Delete ${batchSelected.size} video${batchSelected.size>1?"s":""}? This cannot be undone.`))handleBatchDelete();}}
                            style={{background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"5px 14px",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700}}>
                            🗑 Delete {batchSelected.size}
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
              {/* ── Batch sync offset panel — apply the same shift to every
                  selected clip in one go. Bakes into startUtc (local + cloud)
                  and recomputes auto-tags from the shifted window. ── */}
              {batchMode && batchSelected.size>0 && batchSyncOpen && (
                <div style={{marginBottom:10,maxWidth:420}}>
                  <SyncControl
                    offset={batchSyncOffset}
                    onChange={setBatchSyncOffset}
                    saving={batchSyncBusy}
                    saveLabel={`💾 Apply to ${batchSelected.size}`}
                    onSave={async(secs)=>{
                      setBatchSyncBusy(true);
                      try {
                        const sel = allVideos.filter(v => batchSelected.has(v.id));
                        const n = await saveSyncForVideos(sel, secs);
                        if (n === 0) {
                          alert('Nothing to update — none of the selected clips have a start time set.');
                        }
                      } finally {
                        setBatchSyncBusy(false);
                        setBatchSyncOffset(0);
                        setBatchSyncOpen(false);
                        setBatchSelected(new Set());
                      }
                    }}/>
                </div>
              )}
              {/* ── Loading thumbnails banner ── */}
              {(() => {
                const loadedCount = Math.min(videoLoadedIds.size, videoTotalThumbs);
                const isLoading = videoThumbsLoading || (videoTotalThumbs > 0 && loadedCount < videoTotalThumbs);
                if(!isLoading) return null;
                const pct = videoTotalThumbs > 0 ? Math.round((loadedCount/videoTotalThumbs)*100) : 0;
                return (
                  <div style={{background:"#06B6D410",border:"1px solid #06B6D430",borderRadius:6,padding:"7px 10px",marginBottom:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:10,color:"#06B6D4",fontFamily:"monospace",marginBottom:5}}>
                      <span>⟳ Loading thumbnails…</span>
                      <span>{videoThumbsLoading ? "…" : `${loadedCount} / ${videoTotalThumbs}`}</span>
                    </div>
                    <div style={{height:4,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
                      <div style={{
                        height:"100%",
                        width: videoThumbsLoading ? "15%" : `${pct}%`,
                        background:"#06B6D4",
                        transition:"width 0.2s ease-out",
                        animation: videoThumbsLoading ? "ssa-thumb-pulse 1.2s ease-in-out infinite" : "none",
                      }}/>
                    </div>
                    <style>{`@keyframes ssa-thumb-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }`}</style>
                  </div>
                );
              })()}
              {(()=>{
                const groups=[]; const seen=new Map();
                for(const v of displayed){const d=v.sessionDate||"unknown";if(!seen.has(d)){seen.set(d,[]);groups.push(d);}seen.get(d).push(v);}
                const SKIP_HDR=new Set(["race-start","topmark","mark","upwind","reach","downwind","tack","gybe","race","training"]);
                return groups.map(date=>{
                  const vids=seen.get(date);
                  const location=(vids[0]?.tags||[]).find(t=>!SKIP_HDR.has(t)&&t.includes("-")&&!t.startsWith("tws-")&&!/-20\d{2}$/.test(t)&&t.length>3&&!/^\d/.test(t))||null;
                  const boat=(vids[0]?.tags||[]).find(t=>!SKIP_HDR.has(t)&&!t.startsWith("tws-")&&!t.includes("-")&&t.length>2&&!/^\d/.test(t))||null;
                  return(<div key={date} style={{marginBottom:18}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,paddingBottom:5,borderBottom:"1px solid #0F2030"}}>
                      <div style={{fontSize:11,fontWeight:700,color:"#64748B",fontFamily:"monospace"}}>{date===TODAY()?"Today":fmtDate(date)}</div>
                      {location&&<span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:"#06B6D420",border:"1px solid #06B6D440",color:"#06B6D4",fontWeight:600}}>{location}</span>}
                      {boat&&<span style={{fontSize:9,color:"#334155",fontFamily:"monospace"}}>{boat}</span>}
                      <span style={{fontSize:9,color:"#1E3A5A",marginLeft:"auto"}}>{vids.length} clip{vids.length!==1?"s":""}</span>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:8}}>
                      {vids.map(v=><VideoCard key={v.id} video={v} selected={selectedVideo?.id===v.id} onClick={()=>setSelectedVideo(v)} onThumbLoad={markVideoThumbLoaded} batchMode={batchMode} batchSelected={batchSelected} onBatchToggle={toggleBatchSelect} sessionTzOffset={sessionTzOffset}/>)}
                    </div>
                  </div>);
                });
              })()}
            </div>
            {selectedVideo&&(
              <div style={{flex:1,background:"#050E1C",borderLeft:"1px solid #1E3A5A",overflowY:"auto",padding:16,minWidth:400}}>
                {/* onPlayUtc wires VideoPlayer → shared playUtc state → Analytics */}
                <VideoPlayer onRecheckStream={recheckStream}
                  video={selectedVideo}
                  logData={logData}
                  xmlData={xmlData}
                  syncOffset={syncOffsets[selectedVideo.id]||0}
                  sessionTzOffset={sessionTzOffset}
                  onPlayUtc={handlePlayUtc}
                  onRotate={canRotate ? (deg)=>rotateVideo(selectedVideo, deg) : null}
                  canShare={canShareVideos(effectiveRole)}
                  canPlayLocalHD={['admin','coach'].includes(effectiveRole)}
                  // Phase B crop UX: three toolbar buttons + timeline
                  // markers. Gated on perms.canSync + local original
                  // present. Re-clicking a button moves that marker.
                  pendingCrop={pendingCrop}
                  cropBusy={cropBusy}
                  cropProgress={cropProgress}
                  onDeleteUpTo={
                    perms.canSync && selectedVideo.hasLocalBlob
                      ? (t)=>{
                          const clamped = Math.max(0, Math.min(t, (selectedVideo.duration||0)));
                          setPendingCrop(p => ({ ...(p||{deleteFrom:null}), deleteUpTo: clamped }));
                          setCropError(null);
                        }
                      : undefined
                  }
                  onDeleteFromHere={
                    perms.canSync && selectedVideo.hasLocalBlob
                      ? (t)=>{
                          const clamped = Math.max(0, Math.min(t, (selectedVideo.duration||0)));
                          setPendingCrop(p => ({ ...(p||{deleteUpTo:null}), deleteFrom: clamped }));
                          setCropError(null);
                        }
                      : undefined
                  }
                  onSaveCrop={
                    perms.canSync && selectedVideo.hasLocalBlob
                      ? async ()=>{
                          // Compute the keep range from the two markers,
                          // clamped to the clip's actual duration.
                          const fullDur = selectedVideo.duration || 0;
                          const startSec = pendingCrop?.deleteUpTo ?? 0;
                          const endSec   = pendingCrop?.deleteFrom ?? fullDur;
                          if (endSec - startSec < 0.5) {
                            setCropError("Nothing to keep — markers overlap.");
                            return;
                          }
                          setCropBusy(true);
                          setCropError(null);
                          setCropProgress({ pct: 0, message: "Loading original…" });
                          try {
                            const blob = await getVideoBlob(selectedVideo.id);
                            if (!blob) {
                              setCropError("Original not on this device.");
                              setCropBusy(false); setCropProgress(null); return;
                            }
                            const result = await cropVideo({
                              source: blob,
                              startSec, endSec,
                              inputStem: `v_${selectedVideo.id}`,
                              onProgress: ({progress, message}) => setCropProgress({ pct: progress, message }),
                            });
                            setCropProgress({ pct: 0.95, message: "Saving…" });
                            const newStartUtc = (typeof selectedVideo.startUtc === "number")
                              ? selectedVideo.startUtc + Math.round(startSec * 1000)
                              : null;
                            const ok = await updateVideoBlobAndDuration(
                              selectedVideo.id, result.blob, result.durationSec, newStartUtc
                            );
                            if (!ok) {
                              setCropError("Failed to save cropped video.");
                              setCropBusy(false); setCropProgress(null); return;
                            }
                            // Recompute auto-tags for the new time window.
                            const cur = (allVideos.find(v=>v.id===selectedVideo.id) || selectedVideo) || {};
                            const startUtcForTags = (typeof newStartUtc === 'number') ? newStartUtc : cur.startUtc;
                            let mergedTags = cur.tags || [];
                            if (typeof startUtcForTags === 'number') {
                              const autoTags = new Set(computeAutoTags(startUtcForTags, result.durationSec, logData, xmlData, syncOffsets[selectedVideo.id]||0));
                              const manualTags = (cur.tags||[]).filter(t => !isAutoTag(t));
                              mergedTags = [...new Set([...autoTags, ...manualTags])];
                              await updateVideoTags(selectedVideo.id, mergedTags);
                            }
                            const patch = {
                              duration: result.durationSec,
                              size: result.bytes,
                              tags: mergedTags,
                              hasProxy: false,
                              proxyPath: null,
                              proxyUploadedAt: null,
                              objectUrl: null,
                            };
                            if (typeof newStartUtc === 'number') patch.startUtc = newStartUtc;
                            setAllVideos(p => p.map(v => v.id === selectedVideo.id ? {...v, ...patch} : v));
                            setSelectedVideo(p => p && p.id === selectedVideo.id ? {...p, ...patch} : p);
                            // Push the post-crop metadata (new tags, startUtc,
                            // duration) to the cloud row so teammates pick
                            // them up on next library load.
                            pushVideoMetadataToCloud(selectedVideo, {
                              tags: mergedTags,
                              ...(typeof newStartUtc === 'number' ? { startUtc: newStartUtc } : {}),
                              durationSec: result.durationSec,
                              bytes: result.bytes,
                            });
                            setPendingCrop(null);
                            setCropProgress(null);
                            setCropBusy(false);
                            // Reload the date so the player picks up the new blob.
                            loadDate(activeDate);
                          } catch (e) {
                            setCropError(e?.message || String(e));
                            setCropBusy(false); setCropProgress(null);
                          }
                        }
                      : undefined
                  }
                  // ↓ Save to disk — download the local blob as MP4 so the
                  // user can run native ffmpeg + VideoToolbox compression on
                  // it (much faster than ffmpeg.wasm for multi-GB sources).
                  onExportToDisk={
                    perms.canSync && selectedVideo.hasLocalBlob
                      ? async () => {
                          try {
                            const blob = await getVideoBlob(selectedVideo.id);
                            if (!blob) { alert('No local file to export.'); return; }
                            // Strip any extension from the title (camera files
                            // often end in .MP4) and tack on .mp4 so the
                            // downloaded file is unambiguous.
                            const stem = (selectedVideo.title || selectedVideo.name || 'clip').replace(/\.[^.]+$/, '');
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `${stem}.mp4`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            // Browsers need the URL alive for the duration of
                            // the streaming download. 60s is generous for any
                            // realistic SSD write speed.
                            setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60_000);
                          } catch (e) {
                            alert(`Export failed: ${e?.message || e}`);
                          }
                        }
                      : undefined
                  }
                  // ↑ Upload compressed — file picker that pushes the
                  // chosen file STRAIGHT to Bunny Stream as the cloud's
                  // "original" rendition. The IDB blob is deliberately
                  // not touched, so the coach can keep playing the full
                  // HD locally (HD-local toggle) while teammates stream
                  // the smaller compressed version's adaptive ladder.
                  onUploadCompressed={
                    perms.canSync && selectedVideo.hasLocalBlob
                      ? () => {
                          const input = document.createElement('input');
                          input.type = 'file';
                          input.accept = 'video/mp4,video/quicktime,.mp4,.mov,.m4v';
                          input.onchange = async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            try {
                              const supabase = getBrowserSupabase();
                              const { data: { user } } = await supabase.auth.getUser();
                              if (!user) { alert('You need to be signed in.'); return; }
                              const cloudId = await ensureCloudVideoId({
                                userId: user.id,
                                video: selectedVideo,
                                sessionDate: selectedVideo.sessionDate || activeDate,
                              });
                              if (!cloudId) {
                                alert('No cloud row available — check your team membership.');
                                return;
                              }
                              const label = selectedVideo.title || selectedVideo.name || cloudId;
                              setMobileSyncState({ phase: 'pushing', message: `Uploading compressed · ${label}`, progress: 0 });
                              // Reuse a pending Stream video object from a
                              // half-finished attempt so the TUS client
                              // resumes; otherwise create a fresh one.
                              let streamId = getPendingOrigStream(selectedVideo.id);
                              if (!streamId) {
                                const created = await createStreamUpload(label, file.size);
                                streamId = created?.streamId || null;
                                if (streamId) setPendingOrigStream(selectedVideo.id, streamId);
                              }
                              if (!streamId) {
                                setMobileSyncState({ phase: 'error', message: 'Stream create failed', progress: 0 });
                                alert('Could not create a Stream video.');
                                return;
                              }
                              const uploaded = await uploadFileToStream(
                                { streamId },
                                file,
                                (pct) => setMobileSyncState({
                                  phase: 'pushing',
                                  message: `Uploading compressed · ${label}`,
                                  progress: pct,
                                }),
                              );
                              if (!uploaded) {
                                setMobileSyncState({ phase: 'error', message: 'Upload interrupted', progress: 0 });
                                alert('Upload was interrupted — retry to resume.');
                                return;
                              }
                              // Flip has_original=true + record the Stream GUID.
                              await fetch(
                                `/api/videos/${encodeURIComponent(cloudId)}/renditions`,
                                {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ original: { streamId } }),
                                },
                              ).catch(()=>{});
                              clearPendingOrigStream(selectedVideo.id);
                              setAllVideos(p => p.map(v => v.id === selectedVideo.id
                                ? { ...v, hasOriginal: true, originalStreamId: streamId, streamProcessing: true, cloudId }
                                : v));
                              setSelectedVideo(p => p && p.id === selectedVideo.id
                                ? { ...p, hasOriginal: true, originalStreamId: streamId, streamProcessing: true, cloudId }
                                : p);
                              setMobileSyncState({ phase: 'done', message: `✓ Compressed uploaded · ${label}`, progress: 100 });
                              setTimeout(() => setMobileSyncState({ phase: null, message: '', progress: 0 }), 3000);
                            } catch (err) {
                              console.error('[upload-compressed] failed', err);
                              setMobileSyncState({ phase: 'error', message: err?.message || 'Upload failed', progress: 0 });
                              alert(`Upload failed: ${err?.message || err}`);
                            }
                          };
                          input.click();
                        }
                      : undefined
                  }
                />
                <div style={{marginTop:12}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:2}}>
                    <div title={selectedVideo.title||""} style={{fontSize:13,fontWeight:600,color:"#E2E8F0",flex:1,marginRight:8,fontFamily:"monospace"}}>{(()=>{
                      if(selectedVideo.startUtc==null) return "—";
                      const d=new Date(selectedVideo.startUtc + (sessionTzOffset||0)*60000);
                      return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
                    })()}</div>
                    <SrcBadge source={videoBadgeSrc(selectedVideo)}/>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
                    <div style={{fontSize:10,color:"#334155"}}>{fmtDate(selectedVideo.sessionDate)} · {selectedVideo.camera}{selectedVideo.duration?` · ${fmtT(selectedVideo.duration)}`:""}</div>
                    {selectedVideo.tsSource&&(<span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:selectedVideo.tsSource==="mp4-meta"?"#1D9E7515":"#F59E0B15",border:`1px solid ${selectedVideo.tsSource==="mp4-meta"?"#1D9E7530":"#F59E0B30"}`,color:selectedVideo.tsSource==="mp4-meta"?"#1D9E75":"#F59E0B"}}>{selectedVideo.tsSource==="mp4-meta"?"📷 camera metadata":"⚠ file modified time"}</span>)}
                  </div>
                  {['admin','coach'].includes(effectiveRole) && <div style={{marginBottom:12}}><SyncControl offset={syncOffsets[selectedVideo.id]||0} onChange={v=>{saveSyncOffset(selectedVideo.id,v);setSyncOffsets(p=>({...p,[selectedVideo.id]:v}));}} onSave={async(secs)=>{ await saveSyncForVideos([selectedVideo], secs); }}/></div>}
                  <div style={{marginBottom:12}}>
                    {/* Where the start time CAME FROM. The import log lives in the
                        Upload tab, which the app leaves the moment an import finishes —
                        so this rode along on the clip instead. It states the two
                        timestamps the file carries and how they relate to its duration,
                        which is what decides whether a stamp marks the start or the end
                        of the recording. */}
                    {(selectedVideo.tsHow||selectedVideo.tsDiag)&&(
                      <div style={{background:selectedVideo.tsSuspect?"#F59E0B12":"#071624",
                        border:`1px solid ${selectedVideo.tsSuspect?"#F59E0B40":"#1E3A5A"}`,
                        borderRadius:7,padding:"7px 9px",marginBottom:8}}>
                        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                          <span style={{fontSize:10,fontWeight:700,color:selectedVideo.tsSuspect?"#F59E0B":"#7DD3FC",letterSpacing:0.5}}>
                            TIMESTAMP{selectedVideo.cameraVendor?` · ${selectedVideo.cameraVendor}`:""}
                          </span>
                          <button onClick={()=>{
                            const txt=[selectedVideo.name,selectedVideo.tsHow,selectedVideo.tsDiag].filter(Boolean).join('\n');
                            try{navigator.clipboard?.writeText(txt);}catch{}
                          }} style={{marginLeft:"auto",background:"none",border:"1px solid #1E3A5A",borderRadius:4,
                            color:"#64748B",fontSize:9,padding:"1px 6px",cursor:"pointer"}}>Copy</button>
                        </div>
                        {selectedVideo.tsHow&&<div style={{fontSize:10,color:"#94A3B8",lineHeight:1.4}}>{selectedVideo.tsHow}</div>}
                        {selectedVideo.tsDiag&&<div style={{fontSize:9,color:"#64748B",fontFamily:"monospace",marginTop:3,wordBreak:"break-word",lineHeight:1.45}}>{selectedVideo.tsDiag}</div>}
                      </div>
                    )}
                    <StartTimeEditor video={selectedVideo} logData={logData} sessionTzOffset={sessionTzOffset} onSave={async(id,startUtc)=>{
                      // The clip's DAY = the venue-local date of the new start time.
                      // Recompute it so the clip moves to the right folder (not just
                      // its displayed time).
                      const newDate=new Date(startUtc+(sessionTzOffset||0)*60000).toISOString().slice(0,10);
                      const oldDate=selectedVideo.sessionDate||activeDate;
                      await updateVideoStartUtc(id,startUtc,newDate);
                      const updatedVideo={...selectedVideo,startUtc,sessionDate:newDate};
                      const autoTags=computeAutoTags(startUtc,selectedVideo.duration,logData,xmlData,syncOffsets[id]||0);
                      const autoTags2=new Set(computeAutoTags(startUtc,selectedVideo.duration,logData,xmlData,syncOffsets[id]||0));const manualTags=(selectedVideo.tags||[]).filter(t=>!autoTags2.has(t));
                      const mergedTags=[...new Set([...autoTags,...manualTags])];
                      await updateVideoTags(id,mergedTags);
                      // Push to cloud so teammates / other devices pick up the new
                      // start time, folder date + recomputed tag set.
                      pushVideoMetadataToCloud(selectedVideo,{startUtc,tags:mergedTags,sessionDate:newDate});
                      const enriched=enrichVideo({...updatedVideo,tags:mergedTags},logData,xmlData,syncOffsets);
                      setAllVideos(p=>p.map(v=>v.id===id?enriched:v));
                      setSelectedVideo(enriched);
                      // Day changed → open the corrected folder (and load its log)
                      // so the clip doesn't appear to vanish from the old one.
                      if(newDate!==oldDate) loadDate(newDate);
                    }}/>
                  </div>
                  {/* Crop status banner — only renders when there's an
                      error to surface or the user marked a cut but the
                      original blob isn't on this device. The whole crop
                      UI is otherwise inside the video player toolbar. */}
                  {perms.canSync && (
                    <VideoCropStatusBanner
                      video={selectedVideo}
                      pendingCrop={pendingCrop}
                      cropError={cropError}
                      onDismissError={()=>setCropError(null)}
                    />
                  )}
                  {/* Manual proxy sync — any role that can import sees
                      this. Auto-sync runs in the background after each
                      import (see enqueueAutoSync), but the manual button
                      stays useful for re-syncing after a crop or for
                      retrying a previously-failed upload. */}
                  {perms.canImport && (
                    <RenditionSyncPanel
                      video={selectedVideo}
                      activeDate={activeDate}
                      onSynced={(id, {proxyStreamId, proxyBytes, cloudId}) => {
                        // Proxy is now on Bunny Stream and encoding — flag it
                        // processing so the poll effect swaps in the adaptive
                        // URL once Bunny finishes, with no manual reload.
                        const patch = { hasProxy: true, proxyStreamId, cloudId, streamProcessing: true, proxyUploadedAt: new Date().toISOString() };
                        if (typeof proxyBytes === 'number') patch.proxyBytes = proxyBytes;
                        setAllVideos(p => p.map(v => v.id === id ? {...v, ...patch} : v));
                        setSelectedVideo(p => p && p.id === id ? {...p, ...patch} : p);
                      }}
                    />
                  )}
                  {['admin','coach','tl2'].includes(effectiveRole)&&<TagEditor video={selectedVideo} tagList={sessionTagList} suggestionList={tagSuggestionList} sessionDate={activeDate} onTagListChange={async updated=>{
                    setSessionTagList(updated);
                    try {
                      const supabase=getBrowserSupabase();
                      const {data:{user}}=await supabase.auth.getUser();
                      if(user) await saveTagListCloud({userId:user.id,date:activeDate,tags:updated});
                      else saveTagList(activeDate,updated);
                    } catch { saveTagList(activeDate,updated); }
                  }} onSave={async (id,tags)=>{ const vid=allVideos.find(v=>v.id===id)||selectedVideo; await saveTagsForVideo(vid, tags); }}/>}
                  <ShareButton video={selectedVideo} canShare={canShareVideos(effectiveRole)}/>
                  {perms.canDelete&&(<DeleteButton video={selectedVideo} cloudStatus={cloudStatus} onDeleted={id=>{setAllVideos(p=>p.filter(v=>v.id!==id));setSelectedVideo(null);saveSyncOffset(id,0);}}/>)}
                </div>
              </div>
            )}
          </main>
        </div>

        {/* ── ANALYTICS PANE — lazy-mounted on first visit, then kept alive ─── */}
        {hasMountedAnalytics&&(
          <div style={{
            position:"absolute",inset:0,display:"flex",overflow:"hidden",
            visibility:activeTab==="analytics"?"visible":"hidden",
            pointerEvents:activeTab==="analytics"?"auto":"none",
            zIndex:activeTab==="analytics"?2:1,
          }}>
            <ErrorBoundary label="Analytics"><AnalyticsTab
              logData={logData} xmlData={xmlData} allVideos={allVideos}
              sessions={sessions} selectedVideo={selectedVideo}
              onSelectVideo={setSelectedVideo} setActiveTab={setActiveTab}
              activeDate={activeDate}
              onSelectDate={loadDate}
              playUtc={playUtc}
              visible={activeTab==="analytics"} photos={photos}
              canUseAI={canUseAI} canSeeAnalyticsData={canSeeAnalyticsData}
            /></ErrorBoundary>
          </div>
        )}

        {/* ── UPLOAD & ADMIN — standard conditional render ─────────────────── */}
        {activeTab==="photos"&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Photos"><PhotosTab role={role} logData={logData} xmlData={xmlData} activeDate={activeDate} sessions={visibleSessions} loadDate={loadDate} cloudStatus={cloudStatus} onPhotosChange={setPhotos} canSeeSailScanPhotos={canSeeSailScanPhotos} sessionTzOffset={sessionTzOffset} sailInventory={sailInventory} canClearDay={['admin','team_manager','coach'].includes(effectiveRole)}/></ErrorBoundary>
          </div>
        )}
        {(activeTab==="upload"||uploadWatching)&&(
          <div style={{position:"absolute",inset:0,display:activeTab==="upload"?"flex":"none",overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Upload"><UploadTab onWatchingChange={setUploadWatching} role={role} cloudStatus={cloudStatus} onImported={handleImported} sailInventory={sailInventory} campaignCfg={campaignCfg} setSailDiff={setSailDiff} syncOffsets={syncOffsets}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="tools"&&(
          <ToolsTabs teamId={campaignCfg?.teamId} boatId={campaignCfg?.boatId}/>
        )}
        {activeTab==="admin"&&(
          <div style={{position:"absolute",inset:0,overflowY:"auto",padding:20,zIndex:2}}>
            <ErrorBoundary label="Admin"><AdminTab
              unsyncedCount={unsyncedCount}
              cloudStatus={cloudStatus}
              sessions={sessions}
              setSessions={setSessions}
              setLogData={setLogData}
              setXmlData={setXmlData}
            /></ErrorBoundary>
          </div>
        )}
        {activeTab==="campaign"&&campaignOn&&effectiveRole!=='guest'&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Campaign"><CampaignTab teamId={campaignCfg.teamId} boatId={campaignCfg.boatId} role={effectiveRole} config={campaignCfg} isMobile={false} onOpenVideo={openCampaignVideo}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="boatconfig"&&campaignOn&&canSeeBoatConfig&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Boat config"><BoatConfigTab teamId={campaignCfg.teamId} boatId={campaignCfg.boatId} role={effectiveRole} config={campaignCfg} isMobile={false} sessionTzOffset={sessionTzOffset}/></ErrorBoundary>
          </div>
        )}
        {/* Weather — wind-analysis tool, available to all roles (sub-features gated by role inside). */}
        {activeTab==="weather"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Weather"><WeatherTab isMobile={false} effectiveRole={effectiveRole} boatName={campaignCfg?.boatName || activeMem?.boat_name} eventName={campaignCfg?.event} logData={logData} teamId={campaignCfg?.teamId} boatId={campaignCfg?.boatId} targetDate={campaignCfg?.targetDate}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="timeline"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Timeline"><TimelineTab teamId={campaignCfg?.teamId||activeMem?.team_id} boatId={campaignCfg?.boatId||activeMem?.boat_id} tzOffset={sessionTzOffset} onOpenVideo={openVideoModal}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="tagger"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Tagging"><TaggerTab
              teamId={campaignCfg?.teamId||activeMem?.team_id}
              boatId={campaignCfg?.boatId||activeMem?.boat_id}
              date={activeDate}
              userId={myUid}
              tzOffsetMin={sessionTzOffset}
              logRows={logData?.rows}
              xml={xmlData}
              playheadUtc={playUtc}
              sessions={visibleSessions}
              onSelectDate={loadDate}
              onEditSailList={()=>setActiveTab("campaign")}
            /></ErrorBoundary>
          </div>
        )}
      </div>
    </div>
    </>
    </TzCtx.Provider>
  );
}

export default SSAApp;

export { SSAApp };