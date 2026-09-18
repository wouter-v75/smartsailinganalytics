'use client'
import { useEffect, useRef, useCallback } from "react";
import { prefetchHls } from '../../lib/hlsLoader';
import { clipUrlIsFresh } from '../../lib/playerStage';

export function useClipPlayback({
  isMobile, allVideos, setAllVideos, selectedVideo, setSelectedVideo,
  setPlayUtc, streamPollTick, setStreamPollTick, playUtcThrottle, allVideosRef,
}) {
  // Resolve ONE clip's signed playback URL, on demand. loadDate no longer resolves
  // every clip on the day (that was ~one /url request per clip and the startup
  // bottleneck — see the boot profiling). The grid cards render from the inline
  // Bunny poster; a clip only needs a playback URL when it's actually selected to
  // play, which is what the effect below drives. Idempotent: a clip that already
  // has a resolved https URL is skipped.
  // Clips whose URL is being resolved right now — so the selection effect, the
  // player's quiet retry and "Try again" cannot start three fetches for one clip.
  const clipUrlInflightRef = useRef(new Set());
  const ensureClipUrl = useCallback(async (videoId, { force = false } = {}) => {
    if (!videoId) return;
    const v = allVideosRef.current.find(x => x.id === videoId);
    if (!v) return;
    // Resolved AND not about to expire. A signed Storage URL lives one hour, and
    // any https URL used to count as resolved forever — so a clip first opened an
    // hour earlier replayed a dead link and the phone said "not available".
    if (!force && clipUrlIsFresh(v)) return;
    if (!(v.hasProxy || v.hasOriginal || v.streamId)) return;            // nothing in the cloud to resolve
    if (clipUrlInflightRef.current.has(videoId)) return;
    clipUrlInflightRef.current.add(videoId);
    const patch = (p) => {
      setAllVideos(prev => prev.map(x => x.id === videoId ? { ...x, ...p } : x));
      setSelectedVideo(prev => (prev && prev.id === videoId) ? { ...prev, ...p } : prev);
    };
    patch({ urlResolving: true, urlFailed: false });
    let upd = null, gone = false, encodeFailed = false, signedOut = false;
    // A hung request on marina wifi used to hold "bear with us" up indefinitely
    // (and, via the in-flight guard, block every retry). Bound each attempt.
    const bounded = () => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(10_000) : undefined;
    try {
      // A phone waking up, a cold server, one dropped request — none of those mean
      // the clip is gone. Three tries, a little apart, before saying so.
      for (let attempt = 0; attempt < 3 && !upd && !gone; attempt++) {
        if (attempt) await new Promise(r => setTimeout(r, attempt === 1 ? 800 : 2500));
        try {
          if (v.hasProxy || v.hasOriginal) {
            const res = await fetch(`/api/videos/${encodeURIComponent(v.cloudId || v.id)}/url?prefer=${isMobile ? 'proxy' : 'auto'}`, { cache: 'no-store', signal: bounded() });
            if (res.ok) {
              const j = await res.json();
              // start_url: the iPhone's start-light playlist (see lib/hlsMaster); its
              // link expires too, so it counts toward re-resolving.
              const exp = j?.expires_at || j?.start_expires_at || null;
              if (j?.url) upd = { objectUrl: j.url, servedRendition: j.served || null, urlExpiresAt: exp ? exp * 1000 : null, hlsStartUrl: j.start_url || null, thumbnailUrl: v.thumbnailUrl || j.thumbnail || null };
              else if (j?.kind === 'processing') upd = { streamProcessing: true, thumbnailUrl: v.thumbnailUrl || j.thumbnail || null };
            } else if (res.status === 404 && !v.streamId) gone = true;   // no rendition anywhere — retrying will not change that
            else if (res.status === 401) { gone = true; signedOut = true; }  // not a network problem — say so
          }
          if (!upd && !gone && v.streamId) {
            const res = await fetch(`/api/stream/status/${v.streamId}`, { cache: 'no-store', signal: bounded() });
            if (res.ok) {
              const s = await res.json();
              if (s.playbackUrl) upd = { objectUrl: s.playbackUrl, urlExpiresAt: null, thumbnailUrl: v.thumbnailUrl || s.thumbnailUrl || null };
              else if (s.failed) { gone = true; encodeFailed = true; }
              else upd = { streamProcessing: true, thumbnailUrl: v.thumbnailUrl || s.thumbnailUrl || null };   // the poller takes it from here
            }
          }
        } catch { /* offline / transient — the next attempt */ }
      }
    } finally {
      clipUrlInflightRef.current.delete(videoId);
    }
    if (!upd) { patch({ urlResolving: false, urlFailed: true, urlFailReason: signedOut ? 'auth' : null, ...(encodeFailed ? { streamFailed: true } : {}) }); return; }
    // Defer revoking the old blob: URL — a live <video> may still be reading it
    // (see the note in loadDate); revoking synchronously spams ERR_FILE_NOT_FOUND.
    const old = v.objectUrl;
    if (old && String(old).startsWith('blob:')) setTimeout(() => { try { URL.revokeObjectURL(old); } catch { /* */ } }, 15_000);
    patch({ ...upd, urlResolving: false, urlFailed: false, urlFailReason: null });
  }, [isMobile, allVideosRef, setAllVideos, setSelectedVideo]);

  // When a clip becomes selected, make sure its playback URL is resolved (it plays
  // the instant the fetch returns; a clip with a local blob already plays from that).
  useEffect(()=>{
    setPlayUtc(selectedVideo?.startUtc||null);
    if(selectedVideo?.id) ensureClipUrl(selectedVideo.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[selectedVideo?.id]);

  // Self-heal. loadDate, the log re-enrich and mobile sync all rebuild the clip
  // list, and any of them can drop the selected clip's link after it was
  // resolved; the effect above only runs when the selection CHANGES, so nothing
  // fetched it again. Whenever the selected clip has no link (and has not already
  // failed), get one — ensureClipUrl skips fresh links and dedupes in-flight ones.
  useEffect(()=>{
    if(selectedVideo?.id && !selectedVideo.objectUrl && !selectedVideo.urlFailed) ensureClipUrl(selectedVideo.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[selectedVideo?.id, selectedVideo?.objectUrl]);

  // Warm the bundled hls.js a few seconds after start-up (off the boot path), so
  // the first play on Android does not wait for the chunk. iPhones play HLS
  // natively and have no MediaSource — they skip it.
  useEffect(()=>{
    const t=setTimeout(()=>{ if(typeof window!=="undefined"&&window.MediaSource) prefetchHls(); },3000);
    return ()=>clearTimeout(t);
  },[]);

  // Poll Bunny Stream for clips still encoding their adaptive HLS ladder.
  // Once a clip is ready, swap its playback URL in with no manual reload.
  // Self-terminating: stops as soon as no clip is left processing, and is
  // capped (~10 min) so a genuinely stuck encode can't poll forever.
  // The cap is PER BATCH, not per session. streamPollTick only ever incremented, so
  // once it maxed out the poller was dead for everything uploaded afterwards too —
  // those clips sat "processing" with no one asking whether they were done. Reset
  // the budget whenever a clip starts processing that wasn't already being watched.
  const pollingIdsRef=useRef(new Set());
  const procKey=allVideos.filter(v=>v.streamProcessing).map(v=>v.id).sort().join(',');
  useEffect(()=>{
    const now=new Set(allVideos.filter(v=>v.streamProcessing).map(v=>v.id));
    let fresh=false;
    for(const id of now) if(!pollingIdsRef.current.has(id)) { fresh=true; break; }
    pollingIdsRef.current=now;
    if(fresh) setStreamPollTick(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[procKey]);

  useEffect(()=>{
    if(!allVideos.some(v=>v.streamProcessing&&!v.streamStalled)) return;
    // 4K originals take Bunny well past the old ten-minute ceiling, so back off
    // rather than giving up: 20 s while it is plausibly nearly done, then a minute.
    // ~35 min of patience in total, after which the clip is marked stalled and the
    // UI says so instead of repeating "1-3 min" indefinitely.
    const MAX_TICKS=40;
    const delay=streamPollTick<10?20000:60000;
    if(streamPollTick>MAX_TICKS){
      const ids=allVideos.filter(v=>v.streamProcessing&&!v.streamStalled).map(v=>v.id);
      if(ids.length) setAllVideos(prev=>prev.map(v=>ids.includes(v.id)?{...v,streamStalled:true}:v));
      return;
    }
    const t=setTimeout(async()=>{
      const procs=allVideos.filter(v=>v.streamProcessing);
      const updates={};
      await Promise.all(procs.map(async v=>{
        try{
          const res=await fetch(`/api/videos/${encodeURIComponent(v.cloudId||v.id)}/url?prefer=${isMobile?'proxy':'auto'}`);
          if(res.ok){
            const j=await res.json();
            const exp=j?.expires_at||j?.start_expires_at||null;
            if(j?.url){ updates[v.id]={objectUrl:j.url,servedRendition:j.served||null,urlExpiresAt:exp?exp*1000:null,hlsStartUrl:j.start_url||null,streamProcessing:false,streamStalled:false,thumbnailUrl:v.thumbnailUrl||j.thumbnail||null}; return; }
            // A poster can arrive well before the renditions do — take it, so the
            // card stops being a black rectangle while the encode finishes.
            if(j?.thumbnail&&!v.thumbnailUrl) updates[v.id]={thumbnailUrl:j.thumbnail};
          }
          // Ask Bunny directly as well. /url answers from OUR row; the encode's real
          // state lives at Stream, and a row that never got refreshed would otherwise
          // keep reporting "processing" long after the encode finished.
          if(!updates[v.id]?.objectUrl&&v.streamId){
            const sr=await fetch(`/api/stream/status/${v.streamId}`);
            if(sr.ok){ const st=await sr.json();
              if(st?.playbackUrl) updates[v.id]={objectUrl:st.playbackUrl,streamProcessing:false,streamStalled:false,thumbnailUrl:v.thumbnailUrl||st.thumbnailUrl||null};
              // Not ready — but carry BACK what Bunny said, so the UI can show the
              // difference between "encoding, 40% done" and "queued, nothing has
              // happened for an hour". Those need opposite responses from the crew
              // and looked identical all afternoon on 7 Sept.
              else updates[v.id]={...(updates[v.id]||{}),
                streamPhase:st?.phase||null,
                streamPct:typeof st?.encodeProgress==='number'?st.encodeProgress:null,
                streamBytes:typeof st?.storageSize==='number'?st.storageSize:null,
                streamFailed:!!st?.failed,
                streamSeenAt:Date.now()};
            }
          }
        }catch{}
      }));
      if(Object.keys(updates).length){
        setAllVideos(prev=>prev.map(v=>updates[v.id]?{...v,...updates[v.id]}:v));
        setSelectedVideo(prev=>(prev&&updates[prev.id])?{...prev,...updates[prev.id]}:prev);
      }
      setStreamPollTick(n=>n+1); // re-arm until no clip is processing
    },delay);
    return ()=>clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[allVideos,streamPollTick,isMobile]);

  // "Check again" on a stalled encode: clear the flag, re-arm the poll budget and
  // ask now. A clip Bunny finished after we stopped watching comes good without a
  // page reload — which was the only way out before.
  // opts.force re-resolves even a link that looks fresh — the player's quiet
  // retry and "Try again" use it after a failed load.
  const recheckStream=useCallback((videoId, opts)=>{
    setAllVideos(prev=>prev.map(v=>v.id===videoId?{...v,streamStalled:false}:v));
    setSelectedVideo(prev=>(prev&&prev.id===videoId)?{...prev,streamStalled:false}:prev);
    setStreamPollTick(0);
    ensureClipUrl(videoId, opts);
  },[ensureClipUrl, setAllVideos, setSelectedVideo, setStreamPollTick]);

  // Throttled callback passed to VideoPlayer — ~12 fps max to keep renders light
  const handlePlayUtc=useCallback(utc=>{
    const now=performance.now();
    if(now-playUtcThrottle.current<80) return;
    playUtcThrottle.current=now;
    setPlayUtc(utc);
  },[playUtcThrottle, setPlayUtc]);


  // ensureClipUrl stays inside: the selection effects and recheckStream above
  // are its only callers. SSAApp only names it in a comment.
  return { recheckStream, handlePlayUtc };
}
