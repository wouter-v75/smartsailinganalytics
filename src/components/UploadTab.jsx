'use client'
import React, { useState, useEffect, useRef, useCallback } from "react";
import { getActiveMembership } from '../lib/active-membership';
import { setSessionShared, shareLabel, squadsForTeam } from '../lib/squadShare';
import { syncSessionToCloud, waitForStreamReady } from '../lib/bunny';
import { saveLogDataCloud, saveXmlDataCloud } from '../lib/cloud-sessions';
import { mergeTagListCloud } from '../lib/cloud-tag-list';
import { ensureCloudVideoId, makeVideoMirrorCallback } from '../lib/cloud-videos';
import { reduceLogForCloud } from '../lib/cloudLogReduce';
import { computeAutoTags, deleteSsaPhases, getLogData, getSessionsForMembership, getVideoBlob, getVideoCloudFlags, getXmlData, loadSsaPhases, markVideoOriginalUploaded, mergeTagList, saveLogData, saveSsaPhases, saveVideo, saveXmlData, venueTodayIso as TODAY } from '../lib/localStore';
import { parseLog } from '../lib/logParse';
import { isSubSecondLog, lidarSailsIn, logRateHz, thinToOneHz } from '../lib/logResolution';
import { uploadSessionStats } from '../lib/phaseStatsUpload';
import { connectionIsGood as photoConnGood, importFiles as importPhotoFiles, syncPhoto as syncOnePhoto } from '../lib/photoStore';
import { POLAR_KEY, parsePolarFile, savePolarToLS } from '../lib/polarCalc';
import { unmatchedSails } from '../lib/sailResolve';
import { currentStorageScope, scopeOfMembership } from '../lib/storageScope';
import { getBrowserSupabase } from '../lib/supabase/browser';
import { daySyncRefusal } from '../lib/syncBoatGuard';
import { buildDayTimeline } from '../lib/timeline/buildNodes';
import { offsetFromCoords } from '../lib/tzFromCoords';
import { sortForUpload } from '../lib/uploadOrder';
import { uploadOriginalStorageFirst } from '../lib/video-rendition-sync';
import { enrichVideo } from '../lib/videoEnrich';
import { clipTimestampSettled, extractVideoCreationTime, probeVideo, resolveStartUtc } from '../lib/videoProbe';
import { canWatchFolders, collectNewClips } from '../lib/watchFolder';
import { parseXmlEvents } from '../lib/xmlEventParse';
import { SrcBadge } from './ssa/SrcBadge';
import { DEFAULT_TZ, ROLES, TZ_OPTIONS } from './ssa/constants';
import { fmtDate, fmtDateTime, fmtSize, fmtT } from './ssa/format';
import { SyncProgressPanel } from './sync/SyncProgressPanel';

// NOTE: sailInventory / campaignCfg / setSailDiff / syncOffsets are USED in this
// component's save path but were never declared as props — they're SSAApp state. Every
// reference threw `ReferenceError`, and each one sits inside a `try {} catch {}`, so the
// throw was swallowed and the feature silently did nothing: the event-file sail
// reconcile never ran, the day's timeline nodes were never persisted, and the session
// never pushed to the cloud. Declaring them here is the whole fix.
function UploadTab({role,cloudStatus,onImported,sailInventory=[],campaignCfg=null,setSailDiff=()=>{},syncOffsets={},onWatchingChange}){
  const perms=ROLES[role];
  const [phaseClash,setPhaseClash]=useState(null); // {date,eventCount,ssaCount,runCount,resolve}
  // ── Refs ──────────────────────────────────────────────────────────────────
  const vidRef=useRef(null),csvRef=useRef(null),xmlRef=useRef(null),polarRef=useRef(null);
  const[pendingVids,setPendingVids]=useState([]);
  const[pendingPhotos,setPendingPhotos]=useState([]);
  // Photo failures, kept ON SCREEN. Previously every reason went only to addLog (the
  // little console) or a chip truncated to 16 chars — and when the import dropped ALL
  // the files there were no rows at all, so the status just flashed and vanished with
  // no explanation. These persist until dismissed.
  const[photoErrors,setPhotoErrors]=useState([]);
  const[photosDone,setPhotosDone]=useState(0);
  const[photoBusy,setPhotoBusy]=useState(false);
  const[csvParsed,setCsvParsed]=useState(null);
  // Ref mirror — handleVids (deps [vidTz]) needs the log's true-UTC window to
  // decide whether a clip's mvhd clock is UTC or local, without a stale closure.
  const csvParsedRef=useRef(csvParsed); useEffect(()=>{csvParsedRef.current=csvParsed;},[csvParsed]);
  const[xmlParsed,setXmlParsed]=useState(null);
  const[csvFile,setCsvFile]=useState(null);
  // Several logfiles can be chosen at once — a day split across exports, or a
  // device that writes one file per session. They are parsed separately (they
  // may even be different formats) and their rows merged on the clock.
  // NOT a way to import several BOATS: this tab saves to the ACTIVE boat, so a
  // squad day goes through `npm run tracker:import`, which assigns each file a
  // boat of its own.
  const[csvFiles,setCsvFiles]=useState([]);
  // "Share these data with the squad." Only asked when the active boat's team
  // is actually IN a squad — a team of one boat must never see the question.
  const[squads,setSquads]=useState([]);
  const[shareWithSquad,setShareWithSquad]=useState(false);
  useEffect(()=>{
    let alive=true;
    (async()=>{
      try{
        const { data: { user } } = await getBrowserSupabase().auth.getUser();
        const m=user?getActiveMembership(user.id):null;
        if(!m?.team_id){ if(alive) setSquads([]); return; }
        const list=await squadsForTeam(m.team_id);
        if(alive) setSquads(list);
      }catch{ if(alive) setSquads([]); }
    })();
    return()=>{alive=false;};
  },[]);
  const[xmlFile,setXmlFile]=useState(null);
  // ── Polar state ──────────────────────────────────────────────────────────
  const[polarFile,setPolarFile]=useState(null);
  const[polarParsed,setPolarParsed]=useState(null);
  // Load saved polar name from localStorage on mount
  const[savedPolarName,setSavedPolarName]=useState(()=>{
    try{return JSON.parse(localStorage.getItem(POLAR_KEY)||"{}").filename||null;}catch{return null;}
  });
  const[dragOver,setDragOver]=useState(false);
  const[phase,setPhase]=useState("idle");
  const[log,setLog]=useState([]);
  const[savedDate,setSavedDate]=useState(null);
  const[savedVids,setSavedVids]=useState([]);
  const[syncProgress,setSyncProgress]=useState(null);
  const syncTimerRef=useRef(null);
  const syncAbortRef=useRef(false);
  const[csvTz, setCsvTz] =useState(DEFAULT_TZ);
  const[xmlTz, setXmlTz] =useState(DEFAULT_TZ);
  const[vidTz, setVidTz] =useState(DEFAULT_TZ);
  // Ref mirror of vidTz so the log-driven auto-tz can re-base already-queued
  // videos without a stale closure (parseCsvWithTz is a deps-[] callback).
  const vidTzRef=useRef(vidTz); useEffect(()=>{vidTzRef.current=vidTz;},[vidTz]);
  // No log = no GPS to detect the venue zone. Default the upload zones to THIS
  // machine's current zone (a sensible "where I am" guess) until a log auto-detects
  // the real venue zone from its lat/lon. Done on mount to avoid SSR hydration drift.
  useEffect(()=>{ const m=-new Date().getTimezoneOffset(); setCsvTz(m); setXmlTz(m); setVidTz(m); vidTzRef.current=m; },[]);

  // useCallback, not a bare arrow: three useCallbacks and an effect take addLog
  // as a dep, and a fresh identity each render made all of them rebuild on every
  // render. setLog's updater form means it needs nothing from the closure.
  const addLog=useCallback(msg=>setLog(p=>[...p.slice(-30),msg]),[]);

  const TzSelect=({value,onChange,label})=>{
    // Always include the current value (e.g. a viewer in NZ on UTC+12/+13, or a
    // log-derived offset) even if it isn't one of the preset options.
    const opts = TZ_OPTIONS.some(o=>o.offsetMin===value)
      ? TZ_OPTIONS
      : [{offsetMin:value,label:`UTC${value>=0?'+':''}${value/60}  (selected)`},...TZ_OPTIONS];
    return (
      <div style={{marginTop:8}}>
        <div style={{fontSize:9,color:"#475569",letterSpacing:1,marginBottom:3}}>{label}</div>
        <select value={value} onChange={e=>onChange(Number(e.target.value))} style={{width:"100%",background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 7px",color:"#94A3B8",fontSize:10,cursor:"pointer"}}>
          {opts.map(o=>(<option key={o.offsetMin} value={o.offsetMin}>{o.label}</option>))}
        </select>
      </div>
    );
  };

  const handleVids=useCallback(files=>{
    const valid=Array.from(files).filter(f=>f.type.startsWith("video/")||/\.(mp4|mov|mts|avi|mkv|m4v)$/i.test(f.name));
    if(!valid.length){addLog("✕ No video files found. MP4/MOV/MTS/AVI accepted.");return;}
    setPendingVids(p=>[...p,...valid.map(f=>({id:Math.random().toString(36).slice(2),file:f,name:f.name,size:f.size,url:URL.createObjectURL(f),duration:null,startUtc:null,tsSource:null}))]);
    addLog(`✓ ${valid.length} video${valid.length>1?"s":""} queued — reading timestamps…`);
    // ONE pass per file: probe first (decodability + duration), then resolve the
    // timestamp — the duration is needed to tell a start-of-recording stamp from an
    // end-of-recording one, so the probe must come first.
    valid.forEach(async f=>{
      const probe=await probeVideo(f);
      if(!probe.ok){
        // A clip the browser can't decode is black in the card, black on playback, and
        // cannot be transcoded — say so here rather than letting three things fail.
        addLog(`✕ ${f.name}: ${probe.reason}`);
        setPendingVids(p=>p.map(v=>v.file===f?{...v,error:probe.reason,undecodable:true}:v));
      } else {
        addLog(`✓ ${f.name}: ${probe.width}×${probe.height}, ${Math.round(probe.duration||0)}s — decodes OK`);
        setPendingVids(p=>p.map(v=>v.file===f?{...v,duration:probe.duration||v.duration||null}:v));
      }
      const durSec = probe.ok ? (probe.duration||0) : 0;

      const result=await extractVideoCreationTime(f);
      setPendingVids(p=>p.map(v=>{
        if(v.file!==f)return v;
        if(result){
          // mvhd may be true UTC (spec) or camera-local (GoPro/DJI) — decide from
          // evidence rather than subtracting vidTz blindly. `rawUtc`/`localClock`
          // are kept so a later venue-tz change re-bases only the local-clock clips.
          const r=resolveStartUtc(result,vidTz,csvParsedRef.current,durSec);
          const label=result.source==="apple-meta"?"iPhone capture date"
                     :result.source==="filename"?"filename timestamp":"camera timestamp";
          const cam=result.camera||{};
          const camName=cam.vendor?`${cam.vendor}${cam.model&&cam.model!==cam.vendor?` (${cam.model})`:''}`:null;
          addLog(`${r.suspect?'⚠':'✓'} ${f.name}${camName?` [${camName}]`:''}: ${label} ${fmtDateTime(r.utc)} UTC — ${r.how}`);

          // ── TIMESTAMP FORENSICS ────────────────────────────────────────────
          // The file carries TWO independent times. On an untouched clip they mark the
          // SAME instant. If one marks the start and the other the moment the file was
          // finalised, they differ by exactly the DURATION — which is measurable, unlike
          // an eyeballed sync offset. Print both, their gap, and the duration, so the
          // relationship is read off the file instead of inferred.
          const keysUtc = result.source==='apple-meta' ? result.utc : null;
          const mvhdUtc = result.mvhdUtc ?? null;
          let diag = null;
          if (keysUtc!=null && mvhdUtc!=null) {
            const gap = Math.round((keysUtc - mvhdUtc)/1000);
            const dur = Math.round(durSec||0);
            const verdict = !dur ? 'no duration to compare'
              : Math.abs(Math.abs(gap) - dur) <= 3 ? 'GAP == DURATION → one of them is the END of recording'
              : Math.abs(gap) <= 3 ? 'same instant → both mark the same point'
              : 'gap does not match the duration → something else is going on';
            diag = `Keys=${new Date(keysUtc).toISOString().slice(11,19)}Z · mvhd=${new Date(mvhdUtc).toISOString().slice(11,19)}Z · gap=${gap}s · duration=${dur}s → ${verdict}`;
          } else if (mvhdUtc!=null) {
            const dur = Math.round(durSec||0);
            const nameStart = result.nameUtc!=null ? result.nameUtc - vidTz*60000 : null;
            if (nameStart!=null) {
              const gap = Math.round((mvhdUtc - nameStart)/1000);
              const verdict = !dur ? 'no duration to compare'
                : Math.abs(gap - dur) <= 5 ? 'mvhd − filename == DURATION → mvhd is the END of recording; filename is the start'
                : Math.abs(gap) <= 5 ? 'same instant → mvhd and the filename agree'
                : 'gap does not match the duration → neither start nor clean end';
              diag = `filename start=${new Date(nameStart).toISOString().slice(11,19)}Z · mvhd=${new Date(mvhdUtc).toISOString().slice(11,19)}Z · gap=${gap}s · duration=${dur}s → ${verdict}`;
            } else {
              diag = `mvhd=${new Date(mvhdUtc).toISOString().slice(11,19)}Z · duration=${dur}s · no Apple capture date and no filename timestamp`;
            }
          }
          if (diag) addLog(`   ⓘ ${f.name}: ${diag}`);
          return{...v,startUtc:r.utc,tsSource:result.source,rawUtc:result.utc,localClock:r.localClock,
                 tsSuspect:!!r.suspect,tsHow:r.how,tsDiag:diag||null,
                 cameraVendor:cam.vendor||null,cameraModel:cam.model||null,
                 duration:v.duration||durSec||null};
        }
        if(f.lastModified&&durSec){const raw=f.lastModified-durSec*1000;addLog(`✓ ${f.name}: using file modified time (no MP4 metadata)`);return{...v,startUtc:raw-vidTz*60000,tsSource:"lastmodified",rawUtc:raw,localClock:true};}
        addLog(`⚠ ${f.name}: no timestamp — set manually in Videos`);
        return v;
      }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[vidTz]);

  // Photos: import (EXIF-date bucketed + tagged from the day's log/event file if
  // local), upload thumbnail immediately, defer the original to a good (WiFi)
  // connection. Mirrors the video proxy/original tiering.
  const handlePhotos=useCallback(async files=>{
    setPhotoBusy(true);
    setPhotoErrors([]);
    const fails=[];
    const photos=await importPhotoFiles(files,{
      scope: await currentStorageScope(),
      onLog: addLog,
      onError: (name,message)=>fails.push({name,message}),
    });
    if(fails.length) setPhotoErrors(p=>[...p,...fails]);
    if(!photos.length){
      // Used to return silently — the status vanished and the user was told nothing.
      if(!fails.length) setPhotoErrors([{name:'import',message:'no photos were imported (no reason reported)'}]);
      setPhotoBusy(false);
      return;
    }
    setPendingPhotos(p=>[...p,...photos.map(x=>({id:x.id,name:x.name,size:x.size,sessionDate:x.sessionDate,thumbSynced:false,originalSynced:false,error:null}))]);
    if(!cloudStatus?.available){
      const msg="Cloud unavailable — photos saved on this device only. They'll sync when the cloud is reachable.";
      addLog("⚠ "+msg);
      setPhotoErrors(p=>[...p,{name:'cloud',message:msg}]);
      setPhotoBusy(false);
      return;
    }
    let ok=0;
    for(const ph of photos){
      try{
        const u=await syncOnePhoto(ph);
        if(u.thumbSynced) ok++;
        setPendingPhotos(p=>p.map(it=>it.id===ph.id?{...it,thumbSynced:u.thumbSynced,originalSynced:u.originalSynced}:it));
      }catch(e){
        const msg=e?.message||'upload failed';
        addLog(`✕ ${ph.name}: ${msg}`);
        setPendingPhotos(p=>p.map(it=>it.id===ph.id?{...it,error:msg}:it));
        setPhotoErrors(p=>[...p,{name:ph.name,message:msg}]);
      }
    }
    // Done: clear the in-progress list (keep only any that errored) + tally.
    setPendingPhotos(p=>p.filter(it=>it.error));
    setPhotosDone(d=>d+ok);
    setPhotoBusy(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cloudStatus]);

  // One dropzone for both: route each file to the right handler.
  // ── Watch the encoder's output folder ──────────────────────────────────────
  // Trimming and uploading used to be strictly serial: on 8 Sept the encode
  // finished at 15:17Z and the first upload started at 15:40Z, because a person
  // was waiting for one job to end before beginning the next. Pointing this at
  // the output folder overlaps them — the race start uploads while the gybes are
  // still being cut.
  //
  // Safe by construction: compress-videos.sh writes each segment to a hidden
  // .part file and renames it only on a clean ffmpeg exit, so anything visible
  // under its final name is complete. See src/lib/watchFolder.ts.
  const watchDirRef = useRef(null);
  const watchSeenRef = useRef(new Set());
  const watchBusyRef = useRef(false);
  // Only clips THIS watcher imported are eligible for auto-upload. Without
  // this the effect below would happily start pushing the user's whole
  // library the moment they pointed it at a folder.
  const watchImportedRef = useRef(new Set());
  const watchUploadingRef = useRef(false);
  const watchHandledRef = useRef(new Set());
  // Uploads are queued in a REF, not read straight off savedVids: each save
  // batch REPLACES savedVids, so clips still waiting would simply vanish when
  // the next batch landed. The tick state exists only to wake the effect.
  const watchQueueRef = useRef([]);
  const watchQueuedRef = useRef(new Set());
  const [watchQueueTick, setWatchQueueTick] = useState(0);
  // Live progress of the clip currently going up, so the strip shows movement
  // rather than a number that only changes once a whole clip has finished.
  const [watchProgress, setWatchProgress] = useState(null);
  const watchGateWarnedRef = useRef(false);
  // Tell the shell we are watching, so it keeps this tab MOUNTED while we are.
  // Tabs render conditionally, so leaving the tab destroys watchOn, the directory
  // handle and the upload queue — the watcher simply stopped, silently, and both
  // days it looked like "one clip uploads then nothing".
  // Declared BEFORE the effects: their deps array reads watchOn during render,
  // and a const read above its line throws — the whole Upload tab failed to mount.
  const [watchOn, setWatchOn] = useState(false);
  useEffect(() => { onWatchingChange?.(watchOn); }, [watchOn, onWatchingChange]);
  useEffect(() => () => { onWatchingChange?.(false); }, [onWatchingChange]);
  const [watchCount, setWatchCount] = useState(0);
  const [watchAutoUpload, setWatchAutoUpload] = useState(true);
  const [watchUploaded, setWatchUploaded] = useState(0);
  // addLog and handleVids are rebuilt on every render. Depending on them
  // directly tore down and recreated the poll interval each render, so the 5 s
  // timer never survived to fire and the folder was read on every render
  // instead. Read them through a ref that is kept current, and let the effects
  // depend only on what should genuinely restart them.
  const watchFnsRef = useRef({ addLog, handleVids });
  watchFnsRef.current = { addLog, handleVids };

  const startWatching = useCallback(async () => {
    if (!canWatchFolders()) {
      addLog('✕ This browser cannot watch a folder — needs Chrome, Edge or Vivaldi.');
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({ id: 'ssa-encode-out', mode: 'read' });
      watchDirRef.current = dir;
      watchSeenRef.current = new Set();
      watchImportedRef.current = new Set();
      watchHandledRef.current = new Set();
      watchQueueRef.current = [];
      watchQueuedRef.current = new Set();
      setWatchCount(0);
      setWatchUploaded(0);
      setWatchOn(true);
      addLog(`✓ Watching ${dir.name} — clips will import as the encoder finishes them.`);
    } catch {
      // The user dismissed the picker. Not an error worth logging.
    }
  }, [addLog]);

  const stopWatching = useCallback(() => {
    setWatchOn(false);
    watchDirRef.current = null;
    addLog('Stopped watching the encode folder.');
  }, [addLog]);

  useEffect(() => {
    if (!watchOn) return;
    let cancelled = false;
    const tick = async () => {
      // Overlapping polls would hand the same clip over twice while the first
      // read is still in flight.
      if (cancelled || watchBusyRef.current || !watchDirRef.current) return;
      watchBusyRef.current = true;
      try {
        const files = await collectNewClips(
          watchDirRef.current,
          watchSeenRef.current,
          // Surfaced, not swallowed: a permanent read failure otherwise looks
          // exactly like an empty folder, which is how the detached-getFile bug
          // hid as '0 picked up'.
          (name, err) => watchFnsRef.current.addLog(`⚠ ${name}: could not read — ${err?.message || err}`),
        );
        if (files.length && !cancelled) {
          // Import in debrief order so the start is first into the queue.
          const ordered = sortForUpload(files.map(f => ({ file: f, title: f.name })));
          for (const o of ordered) watchImportedRef.current.add(o.file.name);
          watchFnsRef.current.handleVids(ordered.map(o => o.file));
          setWatchCount(c => c + files.length);
        }
      } catch (e) {
        watchFnsRef.current.addLog(`⚠ Watch folder: ${e?.message || e}`);
      } finally {
        watchBusyRef.current = false;
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [watchOn]);

  // Hand each newly-saved watch clip to the upload queue. Separate from the
  // uploader below so that a batch replacing savedVids cannot lose anything.
  useEffect(() => {
    if (!watchOn) return;
    if (!savedVids?.length) return;
    // addLog through the ref, NOT as a dep: addLog is rebuilt every render, so
    // with it in the deps this effect ran after every render — and its own
    // "already queued" line re-rendered, which ran it again, forever.
    const addLog = watchFnsRef.current.addLog;
    let added = 0, alreadyQueued = 0, unmatched = [];
    for (const v of savedVids) {
      if (!watchImportedRef.current.has(v.name)) { unmatched.push(v.name || v.title || v.id); continue; }
      if (watchQueuedRef.current.has(v.id)) { alreadyQueued += 1; continue; }
      watchQueuedRef.current.add(v.id);
      watchQueueRef.current.push({ ...v, sessionDate: v.sessionDate || savedDate });
      added += 1;
    }
    // Say why nothing was queued. Silence here is what made this hard to chase:
    // a queue that stays empty looks exactly like an uploader that never runs.
    if (added) { addLog(`↥ ${added} clip(s) queued for upload`); setWatchQueueTick((t) => t + 1); }
    else if (unmatched.length) {
      addLog(`⚠ watcher: ${savedVids.length} saved, none queued — ${unmatched.length} did not match the watch list`);
      addLog(`   saved as: ${unmatched.slice(0, 2).join(', ')}`);
      addLog(`   watching: ${[...watchImportedRef.current].slice(0, 2).join(', ') || '(empty)'}`);
    } else if (alreadyQueued) {
      addLog(`↥ ${alreadyQueued} clip(s) already queued`);
    }
  }, [watchOn, savedVids, savedDate]);

  // Auto-upload each watched clip once it has been imported and SAVED.
  //
  // Driven off savedVids — the clips this tab has just written locally — because
  // that is what exists in THIS component. An earlier version reached for
  // allVideos/activeDate/setMobileSyncState, which live in SSAApp, and crashed
  // the whole tab on render. Nothing here refers outside UploadTab.
  //
  // One clip at a time: uploads are serial anyway, and since the storage-first
  // change each clip becomes watchable as its own bytes land, so finishing one
  // beats making progress on five.
  //
  // Only files THIS watcher imported are eligible — otherwise pointing it at a
  // folder would start pushing every clip the tab has ever saved. A clip that
  // fails is marked handled rather than retried, so a broken one cannot spin and
  // burn the boat's uplink; it says so in the log and the manual button remains.
  useEffect(() => {
    if (!watchOn || !watchAutoUpload) return;
    if (watchUploadingRef.current) return;
    if (!cloudStatus?.available || !perms.canSync) {
      if (watchQueueRef.current.length && !watchGateWarnedRef.current) {
        watchGateWarnedRef.current = true;
        addLog(`⚠ auto-upload held: cloud ${cloudStatus?.available ? 'ok' : 'unavailable'}, sync permission ${perms.canSync ? 'ok' : 'denied'}`);
      }
      return;
    }

    const next = watchQueueRef.current.find(v => !watchHandledRef.current.has(v.id));
    if (!next) return;

    watchUploadingRef.current = true;
    (async () => {
      const label = next.title || next.name || next.id;
      try {
        const supabase = getBrowserSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('not signed in');
        const sessionDate = next.sessionDate;
        if (!sessionDate) throw new Error('no session date');
        const cloudId = await ensureCloudVideoId({ userId: user.id, video: next, sessionDate });
        if (!cloudId) throw new Error('no cloud row');
        const blob = await getVideoBlob(next.id);
        if (!blob) throw new Error('no video data on this device');

        addLog(`↑ ${label} — uploading…`);
        setWatchProgress({ label, pct: 0, message: 'starting…' });
        const res = await uploadOriginalStorageFirst({
          videoId: cloudId, sessionDate, scope: await currentStorageScope(), source: blob, title: label,
          onProgress: (pr) => setWatchProgress({
            label,
            pct: Math.max(0, Math.min(1, pr.pct || 0)),
            message: pr.message || pr.phase || '',
          }),
        });
        if (!res.ok) throw new Error(res.error || 'upload failed');
        if (res.streamError) addLog(`⚠ ${label}: playable, but the adaptive encode was not queued (${res.streamError})`);
        // Record the upload on this device AND in the saved list: Push to Cloud
        // re-sends anything not marked, so without this it uploaded every
        // watched clip a second time.
        const mark = { originalUploadedAt: Date.now(), originalPath: res.originalPath || null, originalStreamId: res.streamId || null };
        await markVideoOriginalUploaded(next.id, mark);
        setSavedVids(p => p.map(v => v.id === next.id ? { ...v, ...mark } : v));
        addLog(`✓ ${label} uploaded — watchable now`);
        setWatchUploaded(n => n + 1);
      } catch (e) {
        addLog(`✕ ${label}: auto-upload failed — ${e?.message || e}. Upload it by hand when convenient.`);
      } finally {
        watchHandledRef.current.add(next.id);
        watchUploadingRef.current = false;
        setWatchProgress(null);
      }
    })();
    // savedVids is the driver: each finished upload marks one handled, and the
    // next render picks up the following clip.
    // watchQueueTick wakes this when clips are queued; addLog changes every
    // render, which is what drives it on to the NEXT clip after one finishes.
  }, [watchOn, watchAutoUpload, watchQueueTick, cloudStatus?.available, perms.canSync, addLog]);

  const handleMixedDrop=useCallback(fileList=>{
    const files=Array.from(fileList);
    const vids=files.filter(f=>f.type.startsWith("video/")||/\.(mp4|mov|mts|avi|mkv|m4v)$/i.test(f.name));
    const imgs=files.filter(f=>f.type.startsWith("image/")||/\.(jpg|jpeg|png|heic|heif|webp)$/i.test(f.name));
    if(vids.length)handleVids(vids);
    if(imgs.length)handlePhotos(imgs);
    if(!vids.length&&!imgs.length)addLog("✕ No video or photo files found.");
  },[handleVids,handlePhotos,addLog]);

  const parseCsvWithTz=useCallback((fileOrFiles,tz,auto=false)=>{
    const files=Array.isArray(fileOrFiles)?fileOrFiles:(fileOrFiles?[fileOrFiles]:[]);
    if(!files.length)return;
    setCsvFile(files[0]); setCsvFiles(files);
    Promise.all(files.map(f=>new Promise((res,rej)=>{
      const fr=new FileReader();
      fr.onload=ev=>res({name:f.name,text:ev.target.result});
      fr.onerror=()=>rej(new Error(`could not read ${f.name}`));
      fr.readAsText(f);
    }))).then(parts=>{
      const e={target:{result:parts.length===1?parts[0].text:parts}};
      return e;
    }).then(e=>{
      try{
        // One file reads as before. Several are parsed independently and their
        // rows merged, because two exports of the same day are not guaranteed
        // to share a format, a rate, or even a clock convention.
        const multi=Array.isArray(e.target.result);
        const text=multi?e.target.result[0].text:e.target.result;
        // Format is auto-detected from the file (raw / flat-OLE / log-v3 / flat-NMEA);
        // the active boat's stored log profile (channel-label aliases) is applied
        // on top. raw + flat-OLE are already UTC → the tz offset only affects the
        // legacy flat-NMEA CSV.
        let boatProfile=null;
        try{ boatProfile=JSON.parse(localStorage.getItem('ssa:log-profile:active')||'null'); }catch{}
        let effTz=tz;
        let p=parseLog(text,{boatProfile,tzOffsetMin:effTz});
        const mergeIn=()=>{
          if(!multi) return;
          const seen=new Set(p.rows.map(r=>r.utc));
          const extraNames=[];
          for(const part of e.target.result.slice(1)){
            const q=parseLog(part.text,{boatProfile,tzOffsetMin:effTz});
            let added=0;
            for(const row of q.rows){ if(!seen.has(row.utc)){ seen.add(row.utc); p.rows.push(row); added++; } }
            extraNames.push(`${part.name} (${added.toLocaleString()} rows${q.format!==p.format?`, ${q.format}`:''})`);
          }
          p.rows.sort((a,b)=>a.utc-b.utc);
          p.startUtc=p.rows[0]?.utc||p.startUtc; p.endUtc=p.rows[p.rows.length-1]?.utc||p.endUtc;
          p.mergedFrom=[`${e.target.result[0].name} (${(p.rows.length).toLocaleString()} total)`,...extraNames];
        };
        mergeIn();
        // Auto-derive the LOCAL/venue timezone (display) from the log's GPS
        // position, DST-aware — so the user never has to pick it. Manual changes
        // via the dropdown call this with auto=false and are respected.
        if(auto){
          const gp=p.rows.find(rr=>Number.isFinite(rr.lat)&&Number.isFinite(rr.lon));
          const at=p.startUtc||gp?.utc;
          // A format that carries its OWN UTC offset beats a coordinate lookup:
          // it is what the device recorded against the sailor's own clock, it
          // needs no position fix, and it cannot be wrong about DST. The Vakaros
          // export stamps every row `...+0100`. Everything else still falls back
          // to the DST-aware lookup from the log's first GPS position.
          const z=p.tzOffsetMin!=null
            ?{offsetMin:p.tzOffsetMin,zone:'the file\u2019s own timestamps'}
            :(gp&&at?offsetFromCoords(gp.lat,gp.lon,at):null);
          if(z){
            effTz=z.offsetMin;
            setCsvTz(effTz);
            // flat-NMEA timestamps were converted with the old offset → re-parse.
            // Both local-clock formats were converted with the OLD offset → re-parse.
            if(p.format==='flat-nmea'||p.format==='flat-local'){ p=parseLog(text,{boatProfile,tzOffsetMin:effTz}); mergeIn(); }
            // The venue zone (from the LOG's lat/lon) is authoritative for the
            // whole session — drive the VIDEO offset from it too, and re-base any
            // already-queued clips so their camera wall-clock → true-UTC uses the
            // venue offset, never the viewer's machine zone.
            if(vidTzRef.current!==effTz){
              const old=vidTzRef.current;
              setPendingVids(pv=>pv.map(v=>{
                if(v.startUtc==null||!v.tsSource)return v;
                // Clips whose clock was already true UTC (spec-compliant mvhd) never
                // had an offset applied — re-basing them would BREAK them. Only the
                // local-clock clips need the venue offset swapped.
                if(v.localClock===false)return v;
                const raw=v.rawUtc??(v.startUtc+old*60000); // camera wall-clock-as-UTC
                return {...v,startUtc:raw-effTz*60000,rawUtc:raw};
              }));
              setVidTz(effTz); vidTzRef.current=effTz;
            }
            const lbl=TZ_OPTIONS.find(o=>o.offsetMin===effTz)?.label||`UTC${effTz>=0?'+':''}${effTz/60}`;
            const src=p.tzOffsetMin!=null?'Timezone from the log file':'Timezone from log position';
            addLog(`🌍 ${src} (${z.zone}) → ${lbl} · applied to log, video & photos`);
          }
        }
        // Sample rate + lidar sails, for the card and for saveLocal (a 4 Hz lidar export
        // is stored as a 1 Hz copy after its stats are computed from every row).
        p.hz=logRateHz(p.rows); p.lidarSails=lidarSailsIn(p.rows);
        setCsvParsed(p);
        const fmtLabel=[p.format==='raw'?`raw ${p.version||''}`:p.format==='flat-ole'?'flat UTC':p.format==='log-v3'?'log v3':p.format==='flat-local'?'flat local':p.format==='vakaros-csv'?'Vakaros GPS':p.format==='gpx'?'GPX':p.format==='unknown'?'unrecognised':'flat CSV',
          p.hz>=1.5?`${p.hz} Hz`:null, p.lidarSails.length?`lidar ${p.lidarSails.map(s=>s.label.toLowerCase()).join('/')}`:null].filter(Boolean).join(' · ');
        // flat-local carries VENUE wall-clock, like the legacy flat-NMEA export, so
        // the timezone actually decides where its rows land — say which one was used
        // rather than printing "UTC" over a log that is nothing of the kind.
        const localClockFmt=p.format==='flat-nmea'||p.format==='flat-local';
        const tzNote=localClockFmt?(TZ_OPTIONS.find(o=>o.offsetMin===effTz)?.label||`UTC+${effTz/60}`):'UTC';
        // A zero-row parse used to report as a green tick, so an unreadable file
        // looked like a successful upload and only surfaced later as an empty
        // chart in Analytics. Say so at the point the file is read.
        const srcLabel = files.length>1 ? `${files.length} files` : files[0].name;
        if(!p.rows.length){
          addLog(p.format==='unknown'
            ? `⚠ ${srcLabel}: not a logfile SSA recognises — nothing will be saved. Accepted formats are listed under the picker.`
            : `⚠ Log (${fmtLabel.trim()}): 0 rows read from ${srcLabel} — the file parsed as ${p.format} but held no rows. Nothing will be saved.`);
        } else {
          addLog(`✓ Log (${fmtLabel.trim()}): ${p.rows.length.toLocaleString()} rows · ${srcLabel} · ${tzNote}`);
          if(p.mergedFrom) for(const m of p.mergedFrom) addLog(`   · ${m}`);
          if(p.hz>=1.5) addLog(`· ${p.hz} Hz log: performance${p.lidarSails.length?', lidar':''} and tack/gybe stats use every row; this device keeps a 1 Hz copy for charts and video`);
        }
      }
      catch(err){addLog(`✕ Logfile: ${err instanceof Error?err.message:String(err)}`);}
    }).catch(err=>addLog(`✕ Logfile: ${err instanceof Error?err.message:String(err)}`));
  },[addLog]);

  const parseXmlWithTz=useCallback((file,tz)=>{
    if(!file)return;setXmlFile(file);
    const r=new FileReader();
    r.onload=e=>{
      try{const p=parseXmlEvents(e.target.result,tz);setXmlParsed(p);const tzLabel=TZ_OPTIONS.find(o=>o.offsetMin===tz)?.label||`UTC+${tz/60}`;addLog(`✓ Events: ${p.tackJibes.length} T/G · ${p.markRoundings.length} marks · ${file.name} · ${tzLabel}`);}
      catch(err){addLog(`✕ XML: ${err instanceof Error?err.message:String(err)}`);}
    };
    r.readAsText(file);
  },[addLog]);

  const handleCsv=useCallback(files=>{parseCsvWithTz(Array.from(files||[]),csvTz,true);},[csvTz,parseCsvWithTz]);
  const handleXml=useCallback(file=>{parseXmlWithTz(file,xmlTz);},[xmlTz,parseXmlWithTz]);

  // ── Polar upload handler — parses and persists to localStorage ────────────
  const handlePolar=useCallback(file=>{
    if(!file)return;
    const r=new FileReader();
    r.onload=e=>{
      try{
        const p=parsePolarFile(e.target.result);
        setPolarParsed(p);setPolarFile(file);
        savePolarToLS(file.name,p);setSavedPolarName(file.name);
        addLog(`✓ Polar: ${p.entries.length} TWS rows · ${p.entries[0].points.length} TWA pts · TWS ${p.tws[0]}–${p.tws[p.tws.length-1]} kn · ${file.name}`);
      }catch(err){addLog(`✕ Polar: ${err instanceof Error?err.message:String(err)}`);}
    };
    r.readAsText(file);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const onCsvTzChange=tz=>{setCsvTz(tz);if(csvFiles.length)parseCsvWithTz(csvFiles,tz);};
  const onXmlTzChange=tz=>{setXmlTz(tz);if(xmlFile)parseXmlWithTz(xmlFile,tz);};
  const onVidTzChange=tz=>{
    setVidTz(tz);
    setPendingVids(p=>p.map(v=>{
      if(!v.startUtc||!v.tsSource)return v;
      // A clip whose camera clock was already true UTC carries no offset to swap.
      if(v.localClock===false)return v;
      const rawUtc=v.rawUtc??(v.startUtc+vidTz*60000);
      return{...v,startUtc:rawUtc-tz*60000,rawUtc};
    }));
  };

  // An event file carries its own phases. When SSA has already built phases for that
  // day — somebody chose those stretches by hand — the import ASKS instead of
  // overwriting: the built phases live in their own store precisely so this choice
  // exists. Resolves to 'keep' | 'aside' | 'discard'.
  const askPhaseClash = info => new Promise(resolve => setPhaseClash({ ...info, resolve }));

  const saveLocal=async()=>{
    if(!pendingVids.length&&!csvParsed&&!xmlParsed)return;
    setPhase("saving");setLog([]);

    // ── Derive per-file session dates from each file's own timestamp ────────
    // Helper: convert a UTC ms value to YYYY-MM-DD using the video tz offset
    const utcToDate = (ms, tzMin) => new Date(ms + tzMin * 60000).toISOString().slice(0, 10);
    const fallbackDate = TODAY();

    // CSV log → its own date
    const csvDate = csvParsed?.startUtc
      ? new Date(csvParsed.startUtc).toISOString().slice(0, 10)
      : null;

    // XML events → its own date
    const xmlDate = xmlParsed?.meta?.date || null;

    // A parse that produced NO ROWS is not a session. Saving it anyway created
    // a row dated TODAY (no timestamps to derive a date from) holding an empty
    // log, which then became the newest session and hijacked what Analytics
    // opened. The warning at parse time already says the format was not
    // recognised; there is nothing here worth writing.
    if (csvParsed?.rows?.length) {
      const d = csvDate || fallbackDate;
      addLog(`Saving log → session ${fmtDate(d)}…`);
      // Tag the log entry with the active workspace so cross-tenant local
      // data doesn't bleed when an admin switches teams.
      const supaForLog = getBrowserSupabase();
      const { data: { user: logUser } } = await supaForLog.auth.getUser();
      const logMembership = logUser ? getActiveMembership(logUser.id) : null;
      // A 4 Hz lidar export is 4× the rows of any other log (~350 MB in memory for 4 h),
      // and desktop boot, video enrichment and the Bunny archive all read the whole day
      // log. Keep a 1 Hz copy; the stats below still come from csvParsed.rows (every row).
      const thinned = isSubSecondLog(csvParsed.rows);
      const logRows = thinned ? thinToOneHz(csvParsed.rows) : csvParsed.rows;
      const logName = csvFiles.length>1 ? `${csvFiles.length} files · ${csvFile.name}` : csvFile.name;
      await saveLogData(d, logRows, logName, csvParsed.startUtc, csvParsed.endUtc, csvTz, logMembership);
      // Mirror to Supabase if there's an active membership.
      try {
        const supabase = getBrowserSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          // The cloud copy is trimmed + downsampled (see reduceLogForCloud):
          // a full session log is tens of MB, over the upload route's size
          // limit. The full-resolution log stays on this device.
          const cloudLog = reduceLogForCloud(
            { rows: logRows, fileName: csvFiles.length>1?`${csvFiles.length} files · ${csvFile.name}`:csvFile.name, startUtc: csvParsed.startUtc, endUtc: csvParsed.endUtc, tzOffset: csvTz },
            xmlParsed
          );
          const ok = await saveLogDataCloud({
            userId: user.id,
            date: d,
            logData: cloudLog,
            tzOffsetMinutes: csvTz,
          });
          // Sharing is a SEPARATE call carrying only the flag, so it cannot
          // disturb the log that was just written — and so an upload that
          // leaves the box unticked does not silently un-share a session
          // somebody shared earlier from Analytics.
          if (ok && squads.length && shareWithSquad) {
            const mem = getActiveMembership(user.id);
            if (mem?.team_id && mem?.boat_id) {
              const r = await setSessionShared(mem.team_id, mem.boat_id, d, true);
              addLog(r.ok
                ? `🤝 Shared with ${squads.map(q=>q.name).join(', ')} → ${d}`
                : `⚠ Could not share with the squad: ${r.error}`);
            }
          }
          const mb = (JSON.stringify(cloudLog).length / 1048576).toFixed(2);
          if (ok) addLog(`☁ Log synced to cloud → ${d} · ${cloudLog.rows.length.toLocaleString()} of ${csvParsed.rows.length.toLocaleString()} rows · ${mb} MB`);
          else addLog(`⚠ Log NOT synced (${mb} MB payload) — saved on this device only. Check the console for the HTTP status; an active boat workspace must be selected.`);
        }
      } catch (e) { addLog(`⚠ Log cloud sync failed — saved on this device only`); }
      addLog(`✓ Log saved (${logRows.length.toLocaleString()} rows${thinned?` · 1 Hz copy of ${csvParsed.rows.length.toLocaleString()}`:''}) → ${d}`);
    }
    if (xmlParsed) {
      const d = xmlDate || csvDate || fallbackDate;
      addLog(`Saving events → session ${fmtDate(d)}…`);
      const supaForXml = getBrowserSupabase();
      const { data: { user: xmlUser } } = await supaForXml.auth.getUser();
      const xmlMembership = xmlUser ? getActiveMembership(xmlUser.id) : null;
      // Built phases for this day? Ask before the event file's own phases arrive.
      const builtDoc = await loadSsaPhases(d);
      const builtCount = builtDoc?.phases?.length || 0;
      if (builtCount && !builtDoc?.setAside) {
        const choice = await askPhaseClash({
          date: d, eventCount: xmlParsed.phases?.length || 0,
          ssaCount: builtCount, runCount: builtDoc?.runs?.length || 0,
        });
        if (choice === 'discard') {
          await deleteSsaPhases(d);
          addLog(`✓ ${builtCount} SSA phases deleted — the event file's phases are the day's phases`);
        } else if (choice === 'aside') {
          await saveSsaPhases(d, { ...builtDoc, setAside: true }, xmlMembership);
          addLog(`✓ ${builtCount} SSA phases set aside (kept, not charted) — the event file's phases win`);
        } else {
          addLog(`✓ ${builtCount} SSA phases kept alongside the event file's ${xmlParsed.phases?.length || 0}`);
        }
      }
      await saveXmlData(d, xmlParsed, xmlFile.name, xmlMembership);
      // Mirror to Supabase.
      try {
        const supabase = getBrowserSupabase();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const ok = await saveXmlDataCloud({
            userId: user.id,
            date: d,
            xmlData: { ...xmlParsed, fileName: xmlFile.name },
          });
          if (ok) addLog(`☁ Events synced to cloud → ${d}`);
          else addLog(`⚠ Events saved on this device only — could not reach the cloud (is an active boat workspace selected?)`);
        }
      } catch (e) { addLog(`⚠ Events cloud sync failed — saved on this device only`); }
      if (xmlParsed.meta?.sailsUsed?.length) {
        const newTags = xmlParsed.meta.sailsUsed.map(s => s.toLowerCase());
        try {
          const supabase = getBrowserSupabase();
          const { data: { user } } = await supabase.auth.getUser();
          if (user) await mergeTagListCloud({ userId: user.id, date: d, newTags });
          else mergeTagList(d, newTags);
        } catch { mergeTagList(d, newTags); }
        addLog(`✓ Events saved · ${xmlParsed.meta.sailsUsed.length} sails → ${d}`);
      } else { addLog(`✓ Events saved → ${d}`); }
      // Reconcile the event file's sail names against the SSA inventory.
      try {
        const rawSails=[...(xmlParsed.meta?.sailsUsed||[]),...((xmlParsed.sailsUpEvents||[]).flatMap(e=>e.sails||[]))];
        const missing=unmatchedSails(rawSails, sailInventory);
        if(missing.length && campaignCfg?.teamId && campaignCfg?.boatId){
          setSailDiff({names:missing});
          addLog(`⚠ ${missing.length} sail name${missing.length>1?'s':''} not in inventory — reconcile prompted`);
        }
      } catch {}
      // Build the day's Timeline Tree (day → races → events) and persist it.
      try {
        if(campaignCfg?.teamId && campaignCfg?.boatId){
          const nodes=buildDayTimeline({ xml: xmlParsed, boatId: campaignCfg.boatId, date: d });
          if(nodes.length){
            fetch(`/api/teams/${campaignCfg.teamId}/timeline`,{
              method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({ boat_id: campaignCfg.boatId, session_date: d, nodes }),
            }).then(r=>{ if(r.ok) addLog(`✓ Timeline built · ${nodes.length} nodes → ${d}`); }).catch(()=>{});
          }
        }
      } catch {}
    }

    // ── Performance stats from the FULL-resolution log ───────────────────────
    // The cloud copy keeps a row every ~6 s; this device has every row. Stored after
    // the log + event file are in the cloud, so the stats are newer than the session
    // and are not recomputed later from the coarse copy. Non-fatal: Analytics also
    // stores them when the day is opened on this device.
    if (csvParsed || xmlParsed) {
      try {
        const d = csvDate || xmlDate || fallbackDate;
        const statsRows = csvParsed ? csvParsed.rows : (await getLogData(d))?.rows;
        const statsXml = xmlParsed || await getXmlData(d);
        const supaForStats = getBrowserSupabase();
        const { data: { user: statsUser } } = await supaForStats.auth.getUser();
        const statsMem = statsUser ? getActiveMembership(statsUser.id) : null;
        if (statsMem?.team_id && statsMem?.boat_id && statsRows?.length && statsXml?.phases?.length) {
          const r = await uploadSessionStats({ teamId: statsMem.team_id, boatId: statsMem.boat_id, date: d, rows: statsRows, xml: statsXml });
          if (r.stored) addLog(`✓ Performance stats stored · ${r.phases} phases · ${r.manoeuvres} tacks/gybes · from the ${r.resolution} s log → ${d}`);
          else if (r.reason) addLog(`· Performance stats not stored: ${r.reason}`);
        }
      } catch { /* non-fatal */ }
    }

    // ── Save each video to the date from its own timestamp ──────────────────
    const saved = [];
    const touchedDates = new Set();
    if (csvDate) touchedDates.add(csvDate);
    if (xmlDate) touchedDates.add(xmlDate);

    for (const pv of pendingVids) {
      // Per-video date: own timestamp → CSV date → XML date → today
      let vidDate;
      if (pv.startUtc && (pv.tsSource === "mp4-meta" || pv.tsSource === "filename"))
        vidDate = utcToDate(pv.startUtc, vidTz);
      else if (pv.startUtc && pv.tsSource === "lastmodified")
        vidDate = utcToDate(pv.startUtc, vidTz);
      else
        vidDate = csvDate || xmlDate || fallbackDate;

      touchedDates.add(vidDate);
      const tags = computeAutoTags(pv.startUtc, pv.duration, csvParsed, xmlParsed);
      const tsLabel = pv.tsSource === "mp4-meta" ? "📷 camera meta"
        : pv.tsSource === "filename" ? "📝 filename"
        : pv.tsSource === "lastmodified" ? "⚠ file mtime" : "❌ no timestamp";
      try {
        // Tag the saved video + session with the current workspace so
        // membership-scoped readers can isolate per-tenant.
        const supaForSave = getBrowserSupabase();
        const { data: { user: saveUser } } = await supaForSave.auth.getUser();
        const saveMembership = saveUser ? getActiveMembership(saveUser.id) : null;
        const s = await saveVideo(pv.file, {
          duration: pv.duration, startUtc: pv.startUtc, tsSource: pv.tsSource,
          tsDiag: pv.tsDiag || null, tsHow: pv.tsHow || null,
          cameraVendor: pv.cameraVendor || null, cameraModel: pv.cameraModel || null,
          tags, title: pv.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
          sessionDate: vidDate,
        }, saveMembership);
        saved.push({ ...s, file: pv.file });
        addLog(`✓ ${pv.name} · ${tsLabel}${pv.startUtc ? ` · ${new Date(pv.startUtc).toISOString().slice(11, 19)} UTC` : ""} → ${vidDate}`);
      } catch (e) { addLog(`✕ ${pv.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // Summary
    const dateList = [...touchedDates].sort();
    if (dateList.length > 1) addLog(`Files filed across ${dateList.length} sessions: ${dateList.join(", ")}`);

    // Navigate to the most relevant date: CSV > XML > earliest video > today
    const primaryDate = csvDate || xmlDate || (dateList.length ? dateList[0] : fallbackDate);
    setSavedDate(primaryDate); setSavedVids(saved);
    addLog(cloudStatus?.available && perms.canSync ? "Saved. Click Push to Cloud to upload." : "Saved to local storage. Ready in Videos.");
    setPhase("saved");
    // keepTab: while the watcher is running, clips arrive in batches and the
    // user is reading the log here. Yanking them to the Videos tab on the first
    // batch hides everything that follows.
    onImported({ date: primaryDate, videos: saved, logData: csvParsed, xmlData: xmlParsed, keepTab: watchOn });
  };

  // Auto-SAVE videos LOCALLY as soon as the queued clips finish processing
  // (duration read) — no "Save locally" click. The cloud upload is NOT automatic:
  // the user pushes originals later from the Videos tab ("Upload originals").
  // Fires once per batch; the "New import" reset re-arms it for the next batch.
  // Which pending clips have already been through saveLocal. This used to be a
  // single "done" flag re-armed when pendingVids emptied — but saveLocal does NOT
  // clear pendingVids, so it never emptied, the flag stayed set, and NO BATCH
  // AFTER THE FIRST WAS EVER SAVED. With the folder watcher that is the whole
  // job: clips arrive one at a time as the encoder finishes them, so clip 1
  // saved and uploaded while 2..20 piled up unsaved and invisible.
  //
  // Tracking ids instead re-arms on genuinely new clips and cannot re-fire on
  // ones already handled. Re-saving is harmless anyway — saveVideo dedupes on
  // (date, name, size) and returns the existing row.
  const autoVidSavedRef = useRef(new Set());
  useEffect(() => {
    if (!pendingVids.length) { autoVidSavedRef.current = new Set(); return; }
    const fresh = pendingVids.filter((v) => !autoVidSavedRef.current.has(v.id));
    if (!fresh.length) return;
    // In watch mode clips keep arriving AFTER the first batch is saved, so the
    // 'saved' phase must not lock further saves out.
    if (!(phase === 'idle' || (watchOn && phase === 'saved'))) return;
    // Both the duration AND the timestamp — see clipTimestampSettled.
    if (!fresh.every(v => v.duration != null && clipTimestampSettled(v))) return;
    for (const v of fresh) autoVidSavedRef.current.add(v.id);
    saveLocal();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVids, phase]);

  const pushCloud=async()=>{
    if(!cloudStatus?.available||!perms.canSync||!savedDate)return;
    setPhase("syncing");
    syncAbortRef.current=false;

    // Build one item per upload action with exact labels for matching
    const items=[
      {id:"log",   label:"Log & Events",  state:"pending", pct:0},
      ...savedVids.map(v=>({id:v.id, label:v.name||v.title, state:"pending", pct:0}))
    ];
    // Helpers — use a local ref so setItem can be called from the sync callback
    // without stale-closure issues
    const progressRef={items:[...items], overall:0, elapsed:0, error:null};
    const pushProgress=()=>setSyncProgress({...progressRef});
    const setItem=(id,patch)=>{
      const idx=progressRef.items.findIndex(it=>it.id===id);
      if(idx===-1)return;
      progressRef.items[idx]={...progressRef.items[idx],...patch};
      const total=progressRef.items.length;
      progressRef.overall=Math.round(progressRef.items.reduce((s,it)=>s+(it.pct||0),0)/total);
      pushProgress();
    };

    const startMs=Date.now();
    syncTimerRef.current=setInterval(()=>{
      progressRef.elapsed=Math.round((Date.now()-startMs)/1000);
      pushProgress();
    },1000);
    setSyncProgress({...progressRef});

    setItem("log",{state:"active",pct:5});
    addLog("Starting Bunny Storage + Stream upload…");

    try{
      let currentVidId=null;
      // Filled by the boat guard just below, which resolves the same membership.
      let uploadScope = null;

      // ── Boat guard ─────────────────────────────────────────────────────────
      // Same refusal the mobile sync makes: savedDate can belong to another
      // boat, and syncSessionToCloud would file it under the active one without
      // saying so. See src/lib/syncBoatGuard.ts.
      {
        const guardUser = await (async()=>{ try{ const {data:{user}} = await getBrowserSupabase().auth.getUser(); return user||null; }catch{ return null; } })();
        const guardMem = guardUser ? getActiveMembership(guardUser.id) : null;
        uploadScope = scopeOfMembership(guardMem);
        const refusal = daySyncRefusal(savedDate, getSessionsForMembership(guardMem), guardMem, fmtDate);
        if(refusal){
          addLog(refusal);
          setItem("log",{state:"error",pct:0});
          progressRef.error = refusal;
          pushProgress();
          setPhase("saved");   // back to the saved view, clips intact, nothing sent
          return;              // the finally below stops the elapsed timer
        }
      }

      // Enrich videos with latest log/xml before uploading so cloud gets full metadata
      const _syncLog = await getLogData(savedDate);
      const _syncXml = await getXmlData(savedDate);
      // Fresh upload marks from this device: the watch folder or the Videos tab
      // may have uploaded some of these since they were saved, and the list in
      // memory can lag. Anything already up is then skipped, not sent again.
      const _flags = await getVideoCloudFlags(savedVids.map(v => v.id));
      const _syncVids = savedVids.map(v => enrichVideo({ ...v, ...(_flags.get(v.id) || {}) }, _syncLog, _syncXml, syncOffsets));

      // Resolve the authed user up-front so the per-video Supabase mirror
      // callback (below) doesn't have to re-auth on every clip.
      let _syncUser = null;
      try {
        const sb = getBrowserSupabase();
        const { data:{ user } } = await sb.auth.getUser();
        _syncUser = user || null;
      } catch {}
      const _syncVidsById = new Map(_syncVids.map(v => [v.id, v]));

      const result=await syncSessionToCloud(
        savedDate,
        _syncLog,
        _syncXml,
        _syncVids,
        msg=>{
          if(syncAbortRef.current)return;
          addLog(msg);

          // ── Log & Events item ──────────────────────────────────────────────
          // "Uploading log data to Bunny Storage…"
          if(msg.includes("Uploading log data")) setItem("log",{state:"active",pct:20});
          // "✓ Log data uploaded to Bunny Storage"
          if(msg.includes("✓ Log data uploaded")) setItem("log",{state:"active",pct:50});
          // "Uploading event data to Bunny Storage…"
          if(msg.includes("Uploading event data")) setItem("log",{state:"active",pct:70});
          // "✓ Event data uploaded to Bunny Storage"
          if(msg.includes("✓ Event data uploaded")) setItem("log",{state:"done",pct:100});
          // also mark done if log upload fails but we continue (no XML)
          if(msg.includes("✓ Log data uploaded")&&!savedVids.length) setItem("log",{state:"done",pct:100});

          // ── Per-video items ────────────────────────────────────────────────
          // "Creating Bunny Stream video for {name}…"
          if(msg.includes("Creating Bunny Stream video for ")){
            const name=msg.replace("Creating Bunny Stream video for ","").replace("…","").trim();
            const vid=savedVids.find(v=>(v.name||v.title)===name);
            if(vid){currentVidId=vid.id;setItem(currentVidId,{state:"active",pct:5});}
          }
          // "Uploading {name} to Bunny Stream (X MB)…"
          if(msg.includes("to Bunny Stream")&&!msg.startsWith("✓")){
            if(currentVidId) setItem(currentVidId,{state:"active",pct:10});
          }
          // "Uploading {name}… {pct}%"  — live TUS progress
          const progMatch=msg.match(/Uploading (.+?)… (\d+)%$/);
          if(progMatch){
            const name=progMatch[1].trim();
            const pct=parseInt(progMatch[2]);
            const vid=savedVids.find(v=>(v.name||v.title)===name);
            const id=vid?.id||currentVidId;
            if(id) setItem(id,{state:"active",pct:Math.max(10,Math.min(95,pct))});
          }
          // "✓ {name} uploaded to Stream (ID: {id}…)"
          if(msg.startsWith("✓")&&msg.includes("uploaded to Stream")){
            const name=msg.replace("✓ ","").split(" uploaded to Stream")[0].trim();
            const vid=savedVids.find(v=>(v.name||v.title)===name);
            const id=vid?.id||currentVidId;
            if(id){
              const sidMatch=msg.match(/ID: ([a-f0-9-]+)/i);
              setItem(id,{state:"processing",pct:98,streamId:sidMatch?.[1]});
            }
            currentVidId=null;
          }
          // Upload failure
          if(msg.includes("upload failed")||msg.includes("failed for")){
            if(currentVidId) setItem(currentVidId,{state:"error",pct:0});
          }
        },
        {
          // Mirror each clip into Supabase the moment its Bunny upload
          // finishes, so teammates see videos appear one-by-one during a
          // long session sync — they no longer wait for the entire batch.
          scope: uploadScope,
          onVideoSynced: makeVideoMirrorCallback({
            userId: _syncUser?.id || null,
            sessionDate: savedDate,
            syncOffsets,
            onMirrored: (label) => addLog(`☁ ${label} mirrored to Supabase`),
          }),
        }
      );

      // Mark all successful videos as done using returned streamIds
      Object.entries(result.streamIds||{}).forEach(([vidId,streamId])=>{
        setItem(vidId,{state:"done",pct:100,streamId});
      });
      // Clips skipped because their original was already up (watch folder or
      // Videos tab) have no new streamId — close their rows too.
      (result.skipped||[]).forEach(vidId=>setItem(vidId,{state:"done",pct:100}));
      // Mark log done if not already (handles the case with no XML)
      setItem("log",{state:"done",pct:100});

      setPhase("done");
      addLog("Bunny sync complete. Stream videos processing in background…");
      progressRef.overall=100;pushProgress();

      // Poll for HLS readiness
      Object.entries(result.streamIds||{}).forEach(async([vidId,streamId])=>{
        const ready=await waitForStreamReady(streamId,300000);
        const vid=savedVids.find(v=>v.id===vidId);
        setItem(vidId,{state:ready?"done":"error",pct:100});
        addLog(ready?`✓ ${vid?.name} ready — HLS available`:`⚠ ${vid?.name} stream timeout`);
      });

    }catch(e){
      setSyncProgress(p=>p?{...p,error:e instanceof Error?e.message:String(e)}:p);
      addLog(`✕ Sync error: ${e instanceof Error?e.message:String(e)}`);
      setPhase("saved");
    }finally{
      clearInterval(syncTimerRef.current);
    }
  };

  const reset=()=>{
    autoVidSavedRef.current = new Set();
    setPendingVids([]);setCsvParsed(null);setXmlParsed(null);setCsvFile(null);setXmlFile(null);
    setPolarParsed(null);setPolarFile(null);
    setPhase("idle");setLog([]);setSavedDate(null);setSavedVids([]);
    setCsvTz(DEFAULT_TZ);setXmlTz(DEFAULT_TZ);setVidTz(DEFAULT_TZ);
  };

  // The watch strip, drawn in BOTH views. It used to live inside the import view
  // only, so the first save (phase → "saved") hid it — progress, the uploaded
  // count and the Stop button all vanished while the watcher kept running.
  const watchPanel = canWatchFolders() && (
    <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:10,padding:"7px 9px",background:watchOn?"#062A22":"#071624",border:`1px solid ${watchOn?"#10B981":"#1E3A5A"}`,borderRadius:7}}>
      <div style={{flex:1,fontSize:10,color:watchOn?"#6EE7B7":"#64748B",lineHeight:1.4}}>
        {watchOn
          ? `Watching ${watchDirRef.current?.name || "folder"} · ${watchCount} picked up · ${watchUploaded} uploaded`
          : "Watch the encode folder — clips import and upload as the script finishes each one"}
      </div>
      {watchProgress && (
        <div style={{flexBasis:"100%",order:9,marginTop:6}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#6EE7B7",marginBottom:3}}>
            <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"70%"}}>↑ {watchProgress.label}</span>
            <span>{Math.round(watchProgress.pct*100)}% · {watchProgress.message}</span>
          </div>
          <div style={{height:4,background:"#0B2A20",borderRadius:2,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${Math.round(watchProgress.pct*100)}%`,background:"#10B981",transition:"width 0.2s"}}/>
          </div>
        </div>
      )}
      <label title="Upload each clip as soon as it is imported, rather than waiting for the whole card" style={{display:"flex",alignItems:"center",gap:4,fontSize:9,color:"#64748B",cursor:"pointer",whiteSpace:"nowrap"}}>
        <input type="checkbox" checked={watchAutoUpload} onChange={e=>setWatchAutoUpload(e.target.checked)} style={{cursor:"pointer"}} />
        upload as they arrive
      </label>
      <button onClick={watchOn ? stopWatching : startWatching} style={{background:watchOn?"#7F1D1D":"#0E7490",border:"none",borderRadius:5,color:"#fff",fontSize:10,fontWeight:700,padding:"5px 10px",cursor:"pointer",whiteSpace:"nowrap"}}>
        {watchOn ? "Stop" : "Watch folder…"}
      </button>
    </div>
  );

  if(!perms.canImport)return(
    <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",padding:40}}>
      <div style={{textAlign:"center",color:"#334155"}}><div style={{fontSize:32,marginBottom:12,opacity:0.3}}>🔒</div><div style={{fontSize:13,color:"#475569",marginBottom:4}}>Import requires Coach or Admin role</div><div style={{fontSize:11}}>Switch role in the header to test</div></div>
    </div>
  );

  const phaseClashModal = phaseClash ? (
    <div role="dialog" aria-label="Phases already built for this day"
      style={{position:"fixed",inset:0,background:"#000A",display:"flex",alignItems:"center",justifyContent:"center",zIndex:60,padding:20}}>
      <div style={{background:"#071624",border:"1px solid #1E3A5A",borderRadius:12,padding:18,maxWidth:520,width:"100%"}}>
        <div style={{fontSize:14,fontWeight:700,color:"#E2E8F0",marginBottom:6}}>
          Phases already built for {phaseClash.date}
        </div>
        <div style={{fontSize:12,color:"#94A3B8",lineHeight:1.6,marginBottom:14}}>
          This event file has <b style={{color:"#E2E8F0"}}>{phaseClash.eventCount}</b> phases.
          SSA already holds <b style={{color:"#E2E8F0"}}>{phaseClash.ssaCount}</b> built here
          {phaseClash.runCount ? <> from <b style={{color:"#E2E8F0"}}>{phaseClash.runCount}</b> run{phaseClash.runCount===1?"":"s"}</> : null}.
          Only “Delete” loses anything.
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
          {[["keep","Keep both","#06B6D4"],["aside","Event file wins · keep mine aside","#0F2A45"],["discard","Delete my phases","#7F1D1D"]].map(([v,text,bg])=>(
            <button key={v} onClick={()=>{const r=phaseClash.resolve;setPhaseClash(null);r(v);}}
              style={{background:bg,border:"none",borderRadius:7,padding:"7px 12px",color:v==="keep"?"#001018":"#E2E8F0",fontSize:12,fontWeight:700,cursor:"pointer"}}>
              {text}
            </button>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  return(
    <div style={{flex:1,overflowY:"auto",padding:24}}>
      {phaseClashModal}
      <div style={{maxWidth:660,margin:"0 auto",display:"flex",flexDirection:"column",gap:14}}>
        {/* Tier explanation */}
        <div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:"12px 14px",display:"flex",gap:16}}>
          <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}><SrcBadge source="local"/><span style={{fontSize:11,fontWeight:600,color:"#06B6D4"}}>① Local — instant</span></div><div style={{fontSize:10,color:"#475569"}}>Saved to browser IndexedDB + localStorage. Available in Videos immediately. Coach/Admin only.</div></div>
          <div style={{width:1,background:"#1E3A5A"}}/>
          <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}><SrcBadge source="cloud"/><span style={{fontSize:11,fontWeight:600,color:"#8B5CF6"}}>② Cloud — background</span></div><div style={{fontSize:10,color:"#475569"}}>Log + events → Bunny Storage. Videos → Bunny Stream (HLS). Accessible to all team roles.</div></div>
        </div>

        {phase==="idle"||phase==="saving"?(
          <>
            {/* Combined video + photo drop zone */}
            <div style={{background:"#0A1929",border:`1px solid ${(pendingVids.length||pendingPhotos.length)?"#06B6D4":"#1E3A5A"}`,borderRadius:12,padding:16}}>
              <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:11}}>Video &amp; photo files</div>
              <input ref={vidRef} type="file" accept="video/*,image/*,.mov,.mp4,.mts,.avi,.mkv,.m4v,.heic,.heif" multiple style={{display:"none"}} onChange={e=>handleMixedDrop(e.target.files)}/>
              {/* Watch the encoder's output folder — import clips as they are cut,
                  so trimming and uploading overlap instead of running back to back. */}
              {watchPanel}
              <div onClick={()=>vidRef.current?.click()} onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);handleMixedDrop(e.dataTransfer.files);}} style={{border:`2px dashed ${dragOver?"#06B6D4":"#1E3A5A"}`,borderRadius:8,padding:"24px 16px",textAlign:"center",cursor:"pointer",background:dragOver?"#071E30":"transparent",marginBottom:(pendingVids.length||pendingPhotos.length)?11:0,transition:"all 0.12s"}}>
                <div style={{fontSize:20,marginBottom:7}}>📹 📷</div>
                <div style={{fontSize:12,color:"#64748B"}}>Drop videos &amp; photos, or click to browse</div>
                <div style={{fontSize:10,color:"#334155",marginTop:3}}>MP4 · MOV · MTS · JPEG · HEIC — mix freely, multiple files</div>
                <div style={{fontSize:10,color:photoConnGood()?"#10B981":"#F59E0B",marginTop:4}}>{photoConnGood()?"WiFi — photo originals upload now":"Cellular — photo thumbnails now, originals on WiFi"}</div>
              </div>
              {/* Photo status: in-progress count while uploading, then a done summary */}
              {(photoBusy||photosDone>0)&&(
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",fontSize:11,color:photoBusy?"#06B6D4":"#10B981",borderBottom:"1px solid #0F2030"}}>
                  <span style={{fontSize:14}}>📷</span>
                  <span style={{fontWeight:700}}>{photoBusy?`Uploading photos… (${pendingPhotos.filter(p=>!p.thumbSynced&&!p.error).length} left)`:`✓ ${photosDone} photo${photosDone===1?"":"s"} uploaded`}</span>
                  {!photoBusy&&photosDone>0&&<span style={{fontSize:10,color:"#475569"}}>· thumbnails + tags now, originals on WiFi</span>}
                  {!photoBusy&&photosDone>0&&<button onClick={()=>setPhotosDone(0)} style={{marginLeft:"auto",background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:14}}>×</button>}
                </div>
              )}
              {/* WHY a photo import failed. Stays until dismissed — the status line
                  above auto-clears, and when the import drops every file there are no
                  rows at all, so this was previously invisible on a phone. */}
              {photoErrors.length>0&&(
                <div style={{background:"#EF444412",border:"1px solid #EF444440",borderRadius:8,padding:"8px 10px",margin:"8px 0"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                    <span style={{fontSize:11,fontWeight:700,color:"#EF4444",flex:1}}>
                      {photoErrors.length} photo problem{photoErrors.length===1?"":"s"}
                    </span>
                    <button onClick={()=>{
                      const txt=photoErrors.map(e=>`${e.name}: ${e.message}`).join('\n');
                      try{navigator.clipboard?.writeText(txt);}catch{}
                    }} style={{background:"none",border:"1px solid #EF444440",borderRadius:4,color:"#FCA5A5",fontSize:10,padding:"2px 7px",cursor:"pointer"}}>Copy</button>
                    <button onClick={()=>setPhotoErrors([])} style={{background:"none",border:"1px solid #EF444440",borderRadius:4,color:"#FCA5A5",fontSize:10,padding:"2px 7px",cursor:"pointer"}}>✕</button>
                  </div>
                  {photoErrors.slice(0,6).map((e,i)=>(
                    <div key={i} style={{fontSize:10,color:"#FCA5A5",lineHeight:1.45,marginBottom:2,wordBreak:"break-word"}}>
                      <span style={{color:"#F87171",fontWeight:600}}>{e.name}</span>: {e.message}
                    </div>
                  ))}
                </div>
              )}
              {/* Only show individual rows while uploading or for any that errored */}
              {pendingPhotos.map(ph=>(
                <div key={ph.id} style={{display:"flex",alignItems:"center",gap:9,padding:"4px 0",borderBottom:"1px solid #0F2030",fontSize:11}}>
                  <span style={{fontSize:14,flexShrink:0}}>📷</span>
                  <div style={{flex:1,minWidth:0}}><div style={{color:"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ph.name}</div><div style={{fontSize:10,color:"#475569"}}>{fmtSize(ph.size)} · {ph.sessionDate}</div></div>
                  {ph.error?<span style={{color:"#EF4444",fontSize:10,maxWidth:180,wordBreak:"break-word"}}>✕ {ph.error}</span>
                    :<span style={{fontSize:10,color:ph.originalSynced?"#10B981":ph.thumbSynced?"#F59E0B":"#475569"}}>{ph.originalSynced?"✓ original":ph.thumbSynced?"thumb ✓ · original ⏳":"…"}</span>}
                </div>
              ))}
              {pendingVids.map(v=>(
                <div key={v.id} style={{display:"flex",alignItems:"center",gap:9,padding:"5px 0",borderBottom:"1px solid #0F2030"}}>
                  <video src={v.url} style={{width:52,height:33,borderRadius:3,objectFit:"cover",background:"#071624",flexShrink:0}} muted preload="metadata" onLoadedMetadata={e=>{
                    const dur=Math.round(e.target.duration);
                    // DURATION ONLY. This handler used to also set startUtc/tsSource
                    // from the file's mtime, which raced the async timestamp
                    // extraction in handleVids: whenever the preview's metadata
                    // arrived first, the clip was stamped "lastmodified" — silently,
                    // because unlike the fallback in handleVids this path logs
                    // nothing — and a clip whose filename carried a perfectly good
                    // capture time was filed under the day it was COPIED instead.
                    // That is how 25 segments named 20260903… landed on 2026-09-04,
                    // and why 123 clips in the local store sit on file-mtime.
                    //
                    // The fallback is not lost: handleVids already applies mtime when
                    // extraction finds nothing, using the probe's duration, and says
                    // so in the log. One owner for the timestamp, one for the duration.
                    setPendingVids(p=>p.map(x=>x.id===v.id?{...x,duration:dur}:x));
                  }}/>
                  <div style={{flex:1,minWidth:0}}><div style={{fontSize:11,fontWeight:500,color:"#CBD5E1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.name}</div><div style={{fontSize:10,color:"#475569"}}>{fmtSize(v.size)}{v.duration?` · ${fmtT(v.duration)}`:""}</div></div>
                  <button onClick={()=>setPendingVids(p=>p.filter(x=>x.id!==v.id))} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:15}}>×</button>
                </div>
              ))}
            </div>

            {/* CSV + XML with per-source timezone selectors */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              {/* Log file */}
              <div style={{background:"#0A1929",border:`1px solid ${csvParsed?"#1D9E75":"#1E3A5A"}`,borderRadius:10,padding:14}}>
                <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Logfile</div>
                {/* The format is detected from the file itself, so the label no
                    longer names one system. It said "Expedition log (CSV)"
                    while happily reading Vakaros and GPX too, which told a
                    dinghy sailor their file was not welcome. */}
                <input ref={csvRef} type="file" multiple accept=".csv,.gpx,text/csv,application/gpx+xml" style={{display:"none"}} onChange={e=>handleCsv(e.target.files)}/>
                <button onClick={()=>csvRef.current?.click()} style={{width:"100%",background:csvParsed?"#1D9E7512":"#071624",border:`1px solid ${csvParsed?"#1D9E75":"#1E3A5A"}`,borderRadius:6,padding:"9px 0",color:csvParsed?"#1D9E75":"#7DD3FC",cursor:"pointer",fontSize:11}}>
                  {csvParsed?(csvFiles.length>1?`✓ ${csvFiles.length} files`:`✓ ${csvFile.name}`):"Choose file(s)"}
                </button>
                {csvParsed&&<div style={{marginTop:6,fontSize:10,color:"#475569"}}>{csvParsed.rows.length.toLocaleString()} rows{csvParsed.hz>=1.5?` · ${csvParsed.hz} Hz`:""}{csvParsed.lidarSails?.length?` · lidar: ${csvParsed.lidarSails.map(s=>s.label).join(", ")}`:""}</div>}
                {csvParsed&&csvFiles.length>1&&(
                  <div style={{marginTop:4,fontSize:9,color:"#334155",lineHeight:1.5}}>
                    Merged on the clock, duplicates dropped:{" "}
                    {csvFiles.map(f=>f.name).join(" · ")}
                  </div>
                )}
                {squads.length>0&&(
                  <label style={{
                    display:"flex",alignItems:"flex-start",gap:8,marginTop:8,padding:"8px 10px",
                    background:shareWithSquad?"#0B2136":"#071624",
                    border:`1px solid ${shareWithSquad?"#1D9E75":"#1E3A5A"}`,
                    borderRadius:6,cursor:"pointer",fontSize:10,lineHeight:1.5,
                    color:shareWithSquad?"#7DD3FC":"#94A3B8",
                  }}>
                    <input type="checkbox" checked={shareWithSquad}
                      onChange={e=>setShareWithSquad(e.target.checked)}
                      style={{marginTop:2,cursor:"pointer"}}/>
                    <span>
                      {shareLabel(squads)}
                      <br/>
                      <span style={{color:"#475569",fontSize:9}}>
                        The track and its derived analysis only — not video, photos or debriefs.
                        You can change this later on the session in Analytics.
                      </span>
                    </span>
                  </label>
                )}
                <div style={{fontSize:9,color:"#334155",marginTop:6,lineHeight:1.5}}>
                  <strong style={{color:"#475569"}}>Accepted:</strong> Expedition CSV (1 Hz / 4 Hz, incl. lidar),
                  Expedition <code>!log=v3</code>, flat CSV with a <code>Utc</code> or local <code>Datetime</code> column,
                  legacy NMEA CSV, <strong style={{color:"#475569"}}>Vakaros Atlas CSV</strong> and <strong style={{color:"#475569"}}>GPX</strong>
                  {" "}(phones, watches, Velocitek exports). The format is detected from the file — nothing to choose.
                  <br/>
                  <strong style={{color:"#475569"}}>Several files</strong> are merged into one session on their timestamps.
                  To import a whole squad, one file per boat, use <code>npm run tracker:import</code> — this tab saves to the boat you have open.
                </div>
                <TzSelect value={csvTz} onChange={onCsvTzChange} label="Local / venue timezone (display)"/>
                <div style={{fontSize:9,color:"#334155",marginTop:5}}>
                  <strong style={{color:"#475569"}}>Auto-detected from the log's GPS position</strong> (DST-aware) when you choose a file — change it only to override.
                  It sets the timezone everything is <strong style={{color:"#475569"}}>displayed</strong> in; for local-clock logs it also converts to UTC, while true-UTC logs (e.g. N76 <code>Utc</code>) keep their timestamps either way.
                </div>
                <div style={{fontSize:9,color:"#334155",marginTop:5}}>
                  1 Hz and 4 Hz exports both work. A <strong style={{color:"#475569"}}>4 Hz lidar log</strong>: performance, lidar and tack/gybe stats use every row (import it with or after the event file); a 1 Hz copy is kept for charts and video.
                </div>
              </div>
              {/* Event file */}
              <div style={{background:"#0A1929",border:`1px solid ${xmlParsed?"#8B5CF6":"#1E3A5A"}`,borderRadius:10,padding:14}}>
                <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Event file (XML)</div>
                <input ref={xmlRef} type="file" accept=".xml,text/xml" style={{display:"none"}} onChange={e=>handleXml(e.target.files[0])}/>
                <button onClick={()=>xmlRef.current?.click()} style={{width:"100%",background:xmlParsed?"#8B5CF612":"#071624",border:`1px solid ${xmlParsed?"#8B5CF6":"#1E3A5A"}`,borderRadius:6,padding:"9px 0",color:xmlParsed?"#8B5CF6":"#7DD3FC",cursor:"pointer",fontSize:11}}>
                  {xmlParsed?`✓ ${xmlFile.name}`:"Choose file"}
                </button>
                {xmlParsed&&<div style={{marginTop:6,fontSize:10,color:"#475569"}}>{xmlParsed.tackJibes.length} T/G · {xmlParsed.markRoundings.length} marks</div>}
                <TzSelect value={xmlTz} onChange={onXmlTzChange} label="Event file timezone (times are local)"/>
              </div>
            </div>

            {/* Polar file — persists across sessions via localStorage */}
            <div style={{background:"#0A1929",border:`1px solid ${polarParsed?"#F59E0B":savedPolarName?"#F59E0B40":"#1E3A5A"}`,borderRadius:10,padding:14}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase"}}>Polar file (CSV / TXT)</div>
                {savedPolarName&&!polarParsed&&(
                  <span style={{fontSize:9,color:"#F59E0B",background:"#F59E0B12",border:"1px solid #F59E0B30",borderRadius:3,padding:"1px 6px",marginLeft:"auto"}}>
                    ⬡ Active: {savedPolarName}
                  </span>
                )}
              </div>
              <input ref={polarRef} type="file" accept=".csv,.txt,.pol,text/plain,text/csv" style={{display:"none"}} onChange={e=>handlePolar(e.target.files[0])}/>
              <button onClick={()=>polarRef.current?.click()} style={{width:"100%",background:polarParsed?"#F59E0B12":"#071624",border:`1px solid ${polarParsed?"#F59E0B":savedPolarName?"#F59E0B40":"#1E3A5A"}`,borderRadius:6,padding:"9px 0",color:polarParsed?"#F59E0B":savedPolarName?"#F59E0B80":"#7DD3FC",cursor:"pointer",fontSize:11}}>
                {polarParsed?`✓ ${polarFile.name}`:savedPolarName?`Replace — currently ${savedPolarName}`:"Choose polar file"}
              </button>
              {polarParsed&&<div style={{marginTop:6,fontSize:10,color:"#475569"}}>{polarParsed.entries.length} TWS rows · {polarParsed.entries[0].points.length} TWA pts · TWS {polarParsed.tws[0]}–{polarParsed.tws[polarParsed.tws.length-1]} kn · saved to browser storage</div>}
              {!polarParsed&&savedPolarName&&<div style={{marginTop:6,fontSize:10,color:"#F59E0B80"}}>Loaded from last session — used for GPS track colour coding</div>}
              <div style={{marginTop:6,fontSize:9,color:"#334155"}}>
                Tab/comma CSV: row 1 = TWS values, col 1 = TWA (0–180°). Persists between sessions. Used to colour the GPS track by VMG% (within 20° of target TWA) or BSP% (reaching).
              </div>
            </div>

            {/* No-log timezone confirmation — when there's no log to pin the venue
                zone from GPS, footage times can't be auto-placed. Ask the user to
                confirm the zone (default = this machine's), adjustable. */}
            {!csvParsed && pendingVids.length>0 && (
              <div style={{background:"#3A2A0A",border:"1px solid #F59E0B55",borderRadius:10,padding:"12px 14px"}}>
                <div style={{fontSize:11,color:"#F59E0B",fontWeight:700,marginBottom:4}}>⚠ No log uploaded — confirm the footage timezone</div>
                <div style={{fontSize:9,color:"#B8A06A",marginBottom:2}}>
                  Without a log there's no GPS to detect the venue zone. Footage times are assumed to be in
                  <strong style={{color:"#F59E0B"}}> this computer's timezone ({TZ_OPTIONS.find(o=>o.offsetMin===vidTz)?.label||`UTC${vidTz>=0?'+':''}${vidTz/60}`})</strong>.
                  Change it below if the footage was recorded in another zone. (Uploading a log auto-detects the venue zone and overrides this.)
                </div>
                <TzSelect value={vidTz} onChange={onVidTzChange} label="Footage timezone (where it was recorded)"/>
              </div>
            )}

            {/* Video timezone */}
            {pendingVids.length>0&&csvParsed&&(
              <div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:"12px 14px"}}>
                <TzSelect value={vidTz} onChange={onVidTzChange} label="Video timestamp timezone"/>
                <div style={{fontSize:9,color:"#334155",marginTop:5}}>
                  Most cameras (GoPro, Garmin, older iPhones) write <strong style={{color:"#475569"}}>local time</strong> in the video file.
                  <strong style={{color:"#475569"}}> Auto-set from the log's GPS position</strong> (the footage was shot at the same place) — change only to override.
                </div>
              </div>
            )}
            {(pendingVids.length>0||csvParsed||xmlParsed)&&(()=>{
              // Reading a clip's capture time is ASYNCHRONOUS — probeVideo (up to 15 s
              // per file) then the metadata scan. Saving before that finishes stores
              // startUtc=null, and the clip is then filed under TODAY with no time and
              // no tags, because computeAutoTags has no window to work with. Nothing
              // said so: the log still read "reading timestamps…" while Save sat
              // enabled. That is how 25 clips named 20260903… landed on 2026-09-04.
              // A clip that failed to probe is NOT pending — it has had its answer.
              const tsPending = pendingVids.filter(v=>!clipTimestampSettled(v)).length;
              const busy = phase==="saving"||tsPending>0;
              return (
              <button onClick={saveLocal} disabled={busy} style={{background:busy?"#1E3A5A":"#06B6D4",border:"none",borderRadius:10,padding:"13px",color:busy?"#64748B":"#000",fontWeight:700,fontSize:14,cursor:busy?"default":"pointer",width:"100%"}}>
                {phase==="saving"?"Saving to local storage…"
                  :tsPending>0?`Reading timestamps — ${tsPending} clip${tsPending>1?"s":""} to go…`
                  :`① Save locally — ${pendingVids.length>0?`${pendingVids.length} video${pendingVids.length>1?"s":""}`:""} ${csvParsed?"+ log":""} ${xmlParsed?"+ events":""}`}
              </button>
              )})()}
          </>
        ):(
          <div style={{background:"#0A1929",border:"1px solid #1D9E7540",borderRadius:12,padding:18}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <SrcBadge source="local"/><span style={{fontSize:12,fontWeight:600,color:"#1D9E75"}}>Session {fmtDate(savedDate)} saved locally</span>
              <span style={{flex:1}}/><button onClick={reset} style={{background:"none",border:"1px solid #1E3A5A",borderRadius:5,padding:"2px 8px",color:"#475569",cursor:"pointer",fontSize:10}}>New import</button>
            </div>
            {watchOn && watchPanel}
            <div style={{borderTop:"1px solid #1E3A5A",paddingTop:14}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                <SrcBadge source={phase==="done"?"cloud":"processing"}/>
                <span style={{fontSize:11,fontWeight:600,color:phase==="done"?"#8B5CF6":"#F59E0B"}}>Bunny Storage + Stream</span>
                {!cloudStatus?.available&&<span style={{fontSize:9,color:"#EF4444",background:"#EF444415",border:"1px solid #EF444430",borderRadius:3,padding:"1px 5px"}}>Not configured</span>}
                {!perms.canSync&&<span style={{fontSize:9,color:"#F59E0B",background:"#F59E0B15",border:"1px solid #F59E0B30",borderRadius:3,padding:"1px 5px"}}>Coach required</span>}
              </div>
              {/* While watching, the watcher is already uploading these clips — and
                  Push to Cloud does not know that (it skips only clips marked
                  cloudSynced locally), so it would send every one a second time. */}
              {phase==="saved"&&watchOn&&<div style={{fontSize:10,color:"#6EE7B7",marginBottom:12}}>Clips from the watched folder upload by themselves — nothing to press. Push to Cloud is hidden while watching because it would send them a second time.</div>}
              {phase==="saved"&&!watchOn&&cloudStatus?.available&&perms.canSync&&(
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:10,color:"#475569",marginBottom:10}}>Uploads log + events to R2 and transcodes videos in Stream. All team roles can view once processing completes (~1–3 min per video).</div>
                  <button onClick={pushCloud} style={{background:"#8B5CF6",border:"none",borderRadius:8,padding:"11px 0",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",width:"100%"}}>② Push to Cloud — {savedVids.length} video{savedVids.length!==1?"s":""} + log + events</button>
                </div>
              )}
              {phase==="saved"&&!cloudStatus?.available&&<div style={{fontSize:10,color:"#334155",background:"#071624",borderRadius:6,padding:"8px 10px"}}>Cloud not configured. Set Bunny env vars in Vercel to enable sync. Session is fully usable from local storage.</div>}
              {(phase==="syncing"||phase==="done")&&syncProgress&&(
                <SyncProgressPanel progress={syncProgress} phase={phase}
                  onCancel={()=>{syncAbortRef.current=true;clearInterval(syncTimerRef.current);setPhase("saved");setSyncProgress(null);}}/>
              )}
            </div>
          </div>
        )}
        {log.length>0&&<div style={{background:"#050E1C",border:"1px solid #1E3A5A",borderRadius:7,padding:"8px 11px",maxHeight:150,overflowY:"auto"}}>
          {log.map((line,i)=><div key={i} style={{fontSize:10,color:line.startsWith("✕")?"#EF4444":line.startsWith("✓")?"#1D9E75":line.startsWith("⚠")?"#F59E0B":"#475569",marginBottom:2,fontFamily:"monospace"}}>{line}</div>)}
        </div>}
      </div>
    </div>
  );
}

export { UploadTab };