'use client'
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { HLS_CONFIG, loadHls } from '../../lib/hlsLoader';
import { getVideoBlob } from '../../lib/localStore';
import { interpRow } from '../../lib/logRowLookup';
import { fallbackMagVar } from '../../lib/magVar';
import { STAGE_TEXT, isMp4Url, playerStage } from '../../lib/playerStage';
import { loadPolarFromLS, polarInterp, polarPerf, polarVMGTarget } from '../../lib/polarCalc';
import { createQoe, platformOf, sendQoe } from '../../lib/qoe';
import { bearingDeg, calcAWA, getVideoMode } from '../../lib/sailMath';
import { Gauge } from '../ssa/Gauge';
import { R, fmtT } from '../ssa/format';
import { useIsMobile } from '../ssa/useIsMobile';
import { ShareSheet } from './ShareSheet';
import { rotStyle } from '../ssa/format';

// Log variables the user can ADD to the video overlay from the dropdown (on top
// of each mode's fixed default gauges). key = the canonical row field.
const OVERLAY_VARS = [
  {key:'tws',label:'TWS',unit:'kn',dec:1},{key:'twa',label:'TWA',unit:'°',dec:0},
  {key:'aws',label:'AWS',unit:'kn',dec:1},{key:'awa',label:'AWA',unit:'°',dec:0},
  {key:'twd',label:'TWD',unit:'°',dec:0},{key:'bsp',label:'BSP',unit:'kn',dec:1},
  {key:'sog',label:'SOG',unit:'kn',dec:1},{key:'vmg',label:'VMG',unit:'kn',dec:2},
  {key:'heel',label:'Heel',unit:'°',dec:0},{key:'trim',label:'Trim',unit:'°',dec:1},
  {key:'forestay',label:'Forestay',unit:'',dec:1},{key:'keelAng',label:'Keel',unit:'°',dec:1},
  {key:'rudder',label:'Rudder',unit:'',dec:1},{key:'mastAng',label:'Mast ang',unit:'',dec:0},
  {key:'vsPerfPct',label:'Polar %',unit:'%',dec:0},{key:'vsTarget',label:'Tgt BSP',unit:'kn',dec:1},
  {key:'twaTarg',label:'Tgt TWA',unit:'°',dec:0},{key:'leeway',label:'Leeway',unit:'°',dec:1},
  {key:'vang',label:'Vang',unit:'',dec:1},{key:'outhaul',label:'Outhaul',unit:'',dec:1},
  {key:'cunninghamLoad',label:'Cunno',unit:'',dec:1},{key:'jibTackLoad',label:'Jib tack',unit:'',dec:1},
  {key:'gsTackLoad',label:'GS tack',unit:'',dec:1},{key:'upDflctPct',label:'Up defl',unit:'%',dec:0},
  {key:'lwDflctPct',label:'Low defl',unit:'%',dec:0},{key:'travPct',label:'Traveller',unit:'%',dec:0},
  {key:'yawR',label:'Rot',unit:'°/s',dec:1},{key:'acc',label:'Acc',unit:'kn/min',dec:1},
  {key:'pBurn',label:'P burn',unit:'',dec:0,fmt:'burn'},{key:'sBurn',label:'S burn',unit:'',dec:0,fmt:'burn'},
];

function VideoPlayer({video,logData,xmlData,syncOffset,sessionTzOffset=0,onPlayUtc,autoPlay=false,onRotate=null,onRecheckStream=null,canShare=false,
                      // Phase B crop UX — three callbacks + the current
                      // cut points + busy flag. All optional; toolbar
                      // crop UI only renders when the setters are provided.
                      pendingCrop,onDeleteUpTo,onDeleteFromHere,onSaveCrop,cropBusy=false,cropProgress=null,
                      // When true (coach/admin), the player offers a toggle
                      // to switch to the local IndexedDB blob for HD debrief
                      // playback — overriding the default cloud-HLS path.
                      canPlayLocalHD=false,
                      // Native-pipeline helpers (desktop only): download the
                      // local clip blob to disk for external compression,
                      // and push the compressed file straight to Bunny as
                      // the cloud "original". The IDB blob is deliberately
                      // NOT replaced — the HD-local debrief toggle still
                      // plays the full-fidelity local file. Both optional;
                      // the toolbar buttons only appear when wired.
                      onExportToDisk,onUploadCompressed}){
  const vidRef=useRef(null),hlsRef=useRef(null);
  const[curTime,setCurTime]=useState(0);
  const[playing,setPlaying]=useState(false);
  const[dur,setDur]=useState(video.duration||0);
  const[vidQuality,setVidQuality]=useState(null); // live rendition label
  const[useLocalHD,setUseLocalHD]=useState(false);
  const seekOnLoadRef=useRef(null); // preserve playback position across source swaps
  const lastUtcEmit=useRef(0);
  const isMobile=useIsMobile();
  const stageRef=useRef(null);
  // Pseudo-fullscreen (mobile). Native <video> fullscreen on iOS hands off
  // to the OS player, which can't show our HTML instrument overlay, so on
  // mobile we cover the viewport with a position:fixed stage instead. That
  // keeps the overlay on top. Desktop uses the real Fullscreen API on the
  // stage container (handled in the button below).
  const[mobileFs,setMobileFs]=useState(false);
  const[shareOpen,setShareOpen]=useState(false);
  // ── PLAYBACK STATE ──────────────────────────────────────────────────────────
  // Having a URL is not the same as having a playable video. The element renders
  // as soon as objectUrl exists, so an expired signed URL, an HLS stream Bunny has
  // not finished encoding, or a stalled phone connection all showed the same thing:
  // a black rectangle that never plays and never says why. Track what the element
  // is actually doing and say it out loud.
  //   loading — fetching/buffering, keep waiting
  //   ready   — metadata in, it will play
  //   error   — the browser gave up; nothing more will happen
  //   retrying — failed once; fetching a fresh link before saying anything
  const[playState,setPlayState]=useState("loading");
  const[playErr,setPlayErr]=useState(null);
  const playStateRef=useRef("loading"); playStateRef.current=playState;
  // One automatic retry per CLIP (a fresh link, or a reload in place) before the
  // viewer is told it is unavailable. Not per URL: a refreshed signed URL is a new
  // URL, and resetting on that would retry forever.
  const retryRef=useRef(0);
  useEffect(()=>{ retryRef.current=0; },[video.id]);
  const slowTimerRef=useRef(null);
  const[slow,setSlow]=useState(false);
  // A new source starts the cycle again — otherwise switching clips inherits the
  // previous one's verdict and a good video reads as broken.
  useEffect(()=>{
    setPlayState("loading"); setPlayErr(null); setSlow(false);
    if(slowTimerRef.current) clearTimeout(slowTimerRef.current);
    if(video.objectUrl) slowTimerRef.current=setTimeout(()=>setSlow(true),12000);
    return ()=>{ if(slowTimerRef.current) clearTimeout(slowTimerRef.current); };
  },[video.objectUrl]);
  // Has the viewer (or autoplay) asked this clip to play? Until then the stage
  // shows the poster and a play button — NOT "loading". An iPhone fetches nothing
  // before a tap, so a loading message there never went away, and it sat on top
  // of the video catching the very tap that would have started it.
  const[started,setStarted]=useState(!!autoPlay);
  useEffect(()=>{ setStarted(!!autoPlay); },[video.id,autoPlay]);
  // Playback quality, measured the way Mux defines it — time to first frame,
  // rebuffering, failures, exits before the first frame — one beacon per clip
  // viewed (lib/qoe → /api/qoe). Numbers per platform instead of anecdotes.
  const qoeRef=useRef(null);
  const videoNowRef=useRef(video); videoNowRef.current=video;
  useEffect(()=>{
    const q=createQoe({
      clip:String(video.cloudId||video.id), autoplay:!!autoPlay,
      platform:platformOf(navigator.userAgent||"",navigator.maxTouchPoints||0),
      net:navigator.connection?.effectiveType||null,
    });
    qoeRef.current=q;
    const flush=()=>{
      const v=videoNowRef.current;
      const p=q.take({ served:v?.servedRendition||null, guid:(String(v?.objectUrl||"").match(/\/([0-9a-f-]{36})\//i)||[])[1]||null });
      if(p) sendQoe(p);
    };
    const onHide=()=>{ if(document.visibilityState==="hidden") flush(); };
    window.addEventListener("pagehide",flush);
    document.addEventListener("visibilitychange",onHide);
    return ()=>{ window.removeEventListener("pagehide",flush); document.removeEventListener("visibilitychange",onHide); flush(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[video.id]);
  const startPlay=()=>{
    qoeRef.current?.tap();
    setStarted(true); setSlow(false);
    if(slowTimerRef.current) clearTimeout(slowTimerRef.current);
    slowTimerRef.current=setTimeout(()=>setSlow(true),12000);
    const el=vidRef.current; if(el) el.play().catch(()=>{});
  };
  // MediaError codes are the only detail the browser gives, and they separate "the
  // network died" from "this device cannot decode it" — which need different answers.
  const mediaErrText=(el)=>{
    const c=el?.error?.code;
    if(c===1) return "loading was aborted";
    if(c===2) return "network error — check the connection and try again";
    if(c===3) return "the video data is damaged and cannot be decoded";
    if(c===4) return "this device's browser cannot play this file";
    return "the video could not be loaded";
  };
  // Reload the current source without changing it — for an HLS playlist (not
  // signed, so a "fresh" link is the same link) or a connection that came back.
  const reloadInPlace=()=>{
    if(hlsRef.current){ try{hlsRef.current.startLoad();}catch{} return; }
    const el=vidRef.current; if(el){ try{el.load();}catch{} }
  };
  // The browser (or hls.js) gave up. Most of these are a link that expired —
  // signed Storage URLs live an hour — or a phone that dropped off the network
  // for a moment, and both recover with a fresh link. So try once, quietly,
  // before telling anyone the video is unavailable.
  const onMediaFail=(detail)=>{
    if(retryRef.current<1 && String(video.objectUrl||"").startsWith("http")){
      retryRef.current+=1;
      setPlayState("retrying"); setPlayErr(null);
      onRecheckStream?.(video.id,{force:true});
      // A link that comes back unchanged re-attaches nothing by itself.
      setTimeout(()=>{ if(playStateRef.current==="retrying"){ setPlayState("loading"); reloadInPlace(); } },2500);
      return;
    }
    setPlayState("error"); setPlayErr(detail);
    qoeRef.current?.fail(detail);
  };
  const onMediaFailRef=useRef(onMediaFail); onMediaFailRef.current=onMediaFail;
  // True when the active source is HLS (cloud adaptive). Flips to false when
  // a coach/admin has toggled HD-local, because the IndexedDB blob is always
  // a progressive MP4/MOV. Consumed by the toolbar indicator below. A signed
  // Storage MP4 is never HLS, even on a cloud clip — hls.js cannot play one.
  const isHls=!useLocalHD && !isMp4Url(video.objectUrl) && (video.source==="cloud" || video.objectUrl?.includes(".m3u8"));
  // Which of the three messages (or none) the viewer should see right now.
  const stage=playerStage(video,playState);
  // A clip that cannot be played without ever producing a media error (no link,
  // encode failed, signed out) is a failure too — record why.
  useEffect(()=>{
    if(stage==="unavailable"&&!video.objectUrl) qoeRef.current?.fail(
      video.urlFailReason==="auth"?"signed-out":video.streamFailed?"encode-failed"
      :video.streamStalled?"encode-stalled":video.urlFailed?"no-link":"no-copy");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[stage,video.objectUrl]);

  // Always start a fresh clip on the default (cloud) source.
  useEffect(()=>{ setUseLocalHD(false); },[video.id]);

  // Mobile: rotate to landscape → enter pseudo-fullscreen (video + overlay);
  // rotate back to portrait → exit. Lets the coach just turn the phone to get
  // a full-frame replay with the instruments on top, and put it upright to
  // return to the library.
  useEffect(()=>{
    if(!isMobile) return;
    const mq = window.matchMedia('(orientation: landscape)');
    const onChange = e => {
      if(e.matches){ if(video.objectUrl) setMobileFs(true); }
      else setMobileFs(false);
    };
    // Sync once on mount in case we're already landscape.
    if(mq.matches && video.objectUrl) setMobileFs(true);
    mq.addEventListener?.('change', onChange);
    return ()=>mq.removeEventListener?.('change', onChange);
  },[isMobile, video.objectUrl]);

  // Lock body scroll, autoplay, and (where supported) request real
  // element-fullscreen so the browser hides its address/menu bars and the
  // video gets the whole screen. We fullscreen the STAGE container, not the
  // bare <video>, so the instrument overlay stays on top. Android Chrome
  // and iPad honour this; iPhone Safari ignores element-fullscreen, so the
  // position:fixed + 100dvh stage is the fallback (covers the layout
  // viewport; Safari's bars auto-collapse on most devices).
  useEffect(()=>{
    if(!mobileFs) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    vidRef.current?.play?.().catch(()=>{});
    const el = stageRef.current;
    if(el && !document.fullscreenElement){
      try { (el.requestFullscreen?.() || el.webkitRequestFullscreen?.())?.catch?.(()=>{}); } catch {}
    }
    return ()=>{
      document.body.style.overflow = prev;
      try { if(document.fullscreenElement) (document.exitFullscreen?.() || document.webkitExitFullscreen?.())?.catch?.(()=>{}); } catch {}
    };
  },[mobileFs]);

  // Keep mobileFs in sync if the user leaves native fullscreen via the
  // browser's own gesture (Esc / swipe / back). Only fires where native FS
  // exists; on iPhone there's no fullscreenElement so this is a no-op.
  useEffect(()=>{
    if(!isMobile) return;
    const onFsChange = ()=>{ if(!document.fullscreenElement) setMobileFs(false); };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return ()=>{
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  },[isMobile]);

  // Coach/admin one-click toggle: cache the current scrub position so the
  // swapped source picks up exactly where we left off, then flip the mode.
  const toggleLocalHD=()=>{
    seekOnLoadRef.current=vidRef.current?.currentTime??0;
    setUseLocalHD(v=>!v);
  };

  // Polar file — fallback only. Target BSP, Polar % and VMG % now come
  // straight from the Expedition log columns (see the derived values below).
  const polar=useMemo(()=>loadPolarFromLS(),[]);

  useEffect(()=>{
    if(!vidRef.current||!video.objectUrl)return;
    setVidQuality(null);
    // videoHeight reflects the rendition currently being decoded — works for
    // native HLS (iOS) and progressive MP4 alike. The element fires `resize`
    // on every rendition switch. Falls through to the hls.js LEVEL_SWITCHED
    // handler below which adds the bitrate.
    const vEl=vidRef.current;
    const onResize=()=>{ if(vEl.videoHeight){ qoeRef.current?.height(vEl.videoHeight); setVidQuality(q=>(q&&q.includes('Mbps'))?q:`${vEl.videoHeight}p`); } };
    vEl.addEventListener('resize',onResize);

    let cancelled=false;
    let createdBlobUrl=null;
    (async()=>{
      let srcUrl=video.objectUrl;
      // Coach/admin opt-in: pull the original from IndexedDB and feed the
      // <video> a Blob URL. This is the highest-fidelity playback path
      // (uncompressed source, no streaming) — used for debriefs.
      if(useLocalHD && video.hasLocalBlob){
        try{
          const blob=await getVideoBlob(video.id);
          if(cancelled||!blob) return;
          createdBlobUrl=URL.createObjectURL(blob);
          srcUrl=createdBlobUrl;
        }catch{ /* fall through to cloud */ }
      }
      if(cancelled||!vidRef.current) return;
      // HLS only when we're NOT on the local blob: local is always a
      // progressive MP4/MOV that the <video> element decodes natively.
      const useHls = !useLocalHD && !isMp4Url(srcUrl) && (video.source==="cloud" || srcUrl?.includes(".m3u8"));
      // iPhone Safari plays HLS itself and has no MediaSource for hls.js anyway —
      // it used to download the ~400 KB library from cdnjs first and only then
      // fall back to native. Go native straight away: that fetch was pure delay on
      // the first load of every clip.
      const nativeHlsOnly = useHls && !window.MediaSource && !!vidRef.current.canPlayType("application/vnd.apple.mpegurl");
      if(nativeHlsOnly){
        if(hlsRef.current){hlsRef.current.destroy();hlsRef.current=null;}
        // The start-light copy of the playlist when we have one: AVPlayer starts on
        // the first rung listed, and Bunny lists 720p first (lib/hlsMaster).
        vidRef.current.src=video.hlsStartUrl||srcUrl;
        qoeRef.current?.setEngine("native",!!video.hlsStartUrl);
      }else if(useHls){
        const init=(Hls)=>{
          if(cancelled||!vidRef.current) return;
          if(hlsRef.current){hlsRef.current.destroy();hlsRef.current=null;}
          if(Hls?.isSupported()){
            qoeRef.current?.setEngine("hlsjs");
            // Tuned for weak field wifi: start on the lowest rendition so
            // playback begins immediately (then adapt up only if bandwidth
            // allows), cap quality to the on-screen video size, and buffer
            // far ahead (up to ~10 min / the whole clip) so wifi dropouts —
            // even long ones — don't stall the video.
            // Settings and the reasons for each: lib/hlsLoader.js.
            const hls=new Hls(HLS_CONFIG);
            // Surface the actually-playing rendition (resolution + bitrate)
            // so the bottom-left badge can prove what ABR settled on.
            hls.on(Hls.Events.LEVEL_SWITCHED,(_e,d)=>{
              const lvl=hls.levels?.[d.level];
              if(lvl?.height) qoeRef.current?.height(lvl.height);
              if(lvl) setVidQuality(`${lvl.height}p · ${(lvl.bitrate/1e6).toFixed(2)} Mbps`);
            });
            // Fatal hls.js errors never reach the <video> element, so they left the
            // player on "loading" for good. Recover the two kinds hls.js can recover
            // (a dropped request, a decode hiccup) twice, then hand over.
            let recovered=0;
            hls.on(Hls.Events.ERROR,(_e,d)=>{
              if(!d?.fatal) return;
              if(recovered<2 && d.type===Hls.ErrorTypes.NETWORK_ERROR){ recovered++; hls.startLoad(); return; }
              if(recovered<2 && d.type===Hls.ErrorTypes.MEDIA_ERROR){ recovered++; hls.recoverMediaError(); return; }
              onMediaFailRef.current?.(d.type===Hls.ErrorTypes.NETWORK_ERROR?"network error — check the connection and try again":"the video could not be loaded");
            });
            hls.loadSource(srcUrl);hls.attachMedia(vidRef.current);hlsRef.current=hls;
          }
          else if(vidRef.current.canPlayType("application/vnd.apple.mpegurl")){ qoeRef.current?.setEngine("native"); vidRef.current.src=srcUrl; }
          else onMediaFailRef.current?.("this device's browser cannot play this stream");
        };
        // hls.js is bundled with the app (lib/hlsLoader) — no third-party script on
        // the play path any more. If the chunk cannot load (offline at just the
        // wrong moment), use the browser's own HLS where it has one; else say so.
        loadHls().then(Hls=>init(Hls)).catch(()=>{
          if(cancelled||!vidRef.current) return;
          if(vidRef.current.canPlayType("application/vnd.apple.mpegurl")){ qoeRef.current?.setEngine("native"); vidRef.current.src=srcUrl; }
          else onMediaFailRef.current?.("the video player could not be loaded — check the connection and try again");
        });
      }else{
        if(hlsRef.current){hlsRef.current.destroy();hlsRef.current=null;}
        qoeRef.current?.setEngine(useLocalHD?"local":String(srcUrl||"").startsWith("blob:")?"local":"mp4");
        vidRef.current.src=srcUrl;
      }
    })();

    return()=>{
      cancelled=true;
      vEl.removeEventListener('resize',onResize);
      if(hlsRef.current){hlsRef.current.destroy();hlsRef.current=null;}
      // Detaching hls.js does NOT clear the element's own src, and a leftover src
      // blocks the next MediaSource from attaching — which is why a clip would sit
      // black until you opened another one and came back, re-running this attach on
      // an element that had meanwhile been cleared. removeAttribute + load() is the
      // documented way to release a media element; without the load() the browser
      // keeps buffering a stream nobody is watching, which on a phone costs both
      // data and battery.
      try{ vEl.removeAttribute('src'); vEl.load(); }catch{ /* element already gone */ }
      if(createdBlobUrl){ try{URL.revokeObjectURL(createdBlobUrl);}catch{} }
    };
  },[video.id,video.objectUrl,video.hlsStartUrl,video.source,video.hasLocalBlob,useLocalHD]);

  // Reset playback state only on clip change; toggling source within a
  // clip should NOT zero the scrub position (the seek ref handles that).
  useEffect(()=>{
    setCurTime(0); setPlaying(false);
  },[video.id]);

  const emitUtc=useCallback((t)=>{
    if(!onPlayUtc||!video.startUtc)return;
    const now=performance.now();
    if(now-lastUtcEmit.current<80)return;
    lastUtcEmit.current=now;
    onPlayUtc(video.startUtc+(t+(syncOffset||0))*1000);
  },[onPlayUtc,video.startUtc,syncOffset]);

  // Drive the instrument overlay at a steady 5 Hz while playing. The HTML
  // <video> `timeupdate` event fires irregularly, so a fixed 200 ms tick
  // keeps the gauges refreshing smoothly (paired with interpRow above).
  useEffect(()=>{
    if(!playing)return;
    const id=setInterval(()=>{
      const v=vidRef.current;
      if(v&&!v.paused){ setCurTime(v.currentTime); emitUtc(v.currentTime); }
    },200);
    return ()=>clearInterval(id);
  },[playing,emitUtc]);

  const logUtc=video.startUtc?video.startUtc+(curTime+(syncOffset||0))*1000:0;
  const row=logData&&logUtc?interpRow(logData.rows,logUtc):null;
  const markers=xmlData&&video.startUtc?[...(xmlData.tackJibes||[]),...(xmlData.markRoundings||[]),...(xmlData.sailsUpEvents||[]).map(s=>({...s,color:"#F59E0B"}))].map(m=>({...m,vidSec:(m.utc-video.startUtc)/1000-(syncOffset||0)})).filter(m=>m.vidSec>=0&&m.vidSec<=dur):[];
  const upcoming=markers.filter(m=>m.vidSec>curTime&&m.vidSec<curTime+30).slice(0,2);
  const pct=dur>0?(curTime/dur)*100:0;
  const onUpdate=()=>{
    if(vidRef.current){
      const t=vidRef.current.currentTime;
      setCurTime(t);setPlaying(!vidRef.current.paused);emitUtc(t);
    }
  };
  const seek=e=>{
    const r=e.currentTarget.getBoundingClientRect();
    if(vidRef.current){
      const t=((e.clientX-r.left)/r.width)*dur;
      vidRef.current.currentTime=t;
      if(onPlayUtc&&video.startUtc)onPlayUtc(video.startUtc+(t+(syncOffset||0))*1000);
    }
  };

  // ── Mode-specific overlay ───────────────────────────────────────────────────
  const mode=getVideoMode(video.tags);

  // Pre-compute derived values. Target BSP and Polar % come straight from
  // the Expedition log columns (Vs_targ, Vs_perf%); the uploaded polar
  // file is only a fallback for older logs that lack those columns.
  //
  // logTargBsp — target boat speed from the log alone. Prefer the absolute
  // Vs_targ column; when an export keeps only Vs_targ% (boat speed as a %
  // of target speed) recover it as  Vs_targ = BSP ÷ (Vs_targ% / 100).
  const logTargBsp = (row?.vsTarget != null && row.vsTarget > 0)
    ? row.vsTarget
    : (row && row.vsTargPct > 0 && row.bsp > 0)
      ? row.bsp * 100 / row.vsTargPct
      : null;
  const targBsp  = logTargBsp
    ?? ((polar && row) ? polarInterp(polar, row.tws, Math.abs(row.twa||0)) : null);
  const polPct   = (row?.vsPerfPct != null && row.vsPerfPct > 0)
    ? row.vsPerfPct
    : ((polar && row) ? polarPerf(polar, row.bsp, row.twa, row.tws)?.pct : null);

  // AWA: use log col 5 (AW_angle) directly; fall back to computed if 0/missing
  const awaRaw = row?.awa;
  const awa = (awaRaw && Math.abs(awaRaw) > 0.5)
    ? awaRaw
    : calcAWA(row?.twa, row?.tws, row?.bsp);

  // VMG% — optimal VMG is the log's target boat speed projected onto the
  // wind axis at the target TWA (Vs_targ × cos(TWA_targ)). logTargBsp also
  // covers the Vs_targ%-recovered case above; fall back to the polar curve
  // when the log carries no target data at all.
  const absA = Math.abs(row?.twa||0);
  const isUpwindAngle = absA < 90;
  const logOptVMG = (logTargBsp != null && row?.twaTarg != null)
    ? logTargBsp * Math.abs(Math.cos(row.twaTarg * Math.PI / 180))
    : null;
  const vmgTarget = (polar && row) ? polarVMGTarget(polar, row.tws) : null;
  const optVMG = (logOptVMG && logOptVMG > 0.01)
    ? logOptVMG
    : (vmgTarget ? (isUpwindAngle ? vmgTarget.upVMG : vmgTarget.downVMG) : null);
  const vmgPct = (optVMG && optVMG > 0.01 && row?.vmg != null)
    ? Math.max(0, Math.min(200, (Math.abs(row.vmg) / optVMG) * 100))
    : null;

  // ── Starting instruments ────────────────────────────────────────────────────
  const guns       = xmlData?.raceGuns||[];
  const startLines = xmlData?.startLines||[];

  // GUN — prefer Timer-1 (col 55), fall back to event UTC diff
  const timerFromLog = row?.timer1;
  const nearestGun = guns.length&&logUtc
    ? guns.filter(g=>Math.abs(g.utc-logUtc)<600000)
          .sort((a,b)=>Math.abs(a.utc-logUtc)-Math.abs(b.utc-logUtc))[0]||null
    : null;
  const secToGunFallback = nearestGun ? Math.round((nearestGun.utc-logUtc)/1000) : null;
  const secToGun = timerFromLog ?? secToGunFallback;
  const gunActive = secToGun!=null;
  const afterGun  = secToGun!=null && secToGun <= 0;  // gun has fired

  // DISTANCE TO LINE — read straight from the Expedition log's DST_LINE
  // column, which the user's instrument config writes in boat lengths (the
  // "m" suffix in the CSV is Expedition's display formatting, not a unit).
  // The previous build had a GPS-geometry fallback off the event-file
  // start-line marks, but that was fragile: the sign depended on pin/
  // committee ordering and the magnitude could go off the rails when the
  // marks weren't pinged accurately. If DST_LINE is empty we now show "--"
  // rather than guessing.
  const distBL = (row?.dstLine!=null && isFinite(row.dstLine)) ? row.dstLine : null;

  // TIME TO BURN — how much excess time before the gun fires.
  //   positive = early, you need to burn some time before crossing
  //   negative = late, you'll cross after the gun
  //
  // All shown DIRECTLY as burns — the Expedition start channels already encode the
  // burn on the current heading (+early / -late), so no gun-timer subtraction:
  //   BurnLine ← tmLine  (Burn;       falls back to TmToLn − TmToGun on older exports)
  //   BurnPin  ← ttbPin  (BurnToPin;  falls back to StBsToP on Expedition exports)
  //   BurnBoat ← ttbCB   (BurnToCb;   falls back to StBsToS)
  //
  // The pin is the PORT end of the line and the committee boat the STARBOARD end,
  // so the fallbacks name the same water as the primary channel.
  //
  // These read the BURN columns, not TmPort/TmStbd. Those are the TIME to reach
  // each end, which is a different quantity: five minutes before the gun on
  // 8 Sept, BurnToPin was 115 s while TmPort was 79.7. Aliasing them into these
  // fields put a time-to-end under a burn label.
  const num = (v) => (v != null && isFinite(v)) ? v : null;
  const burnLine = num(row?.tmLine);
  const burnPin  = num(row?.ttbPin) ?? num(row?.ttbPort);
  const burnBoat = num(row?.ttbCB)  ?? num(row?.ttbStbd);

  // LINE SQUARE — the wind direction at which the start line is perpendicular
  // to the wind, in MAGNETIC degrees. There are two perpendiculars to any
  // line; pick the one closer to the current TWD so pin/committee ordering
  // doesn't flip the value. Convert true → magnetic via the log's MagVar
  // column (signed: positive east → magnetic = true − magvar).
  //
  // The navigator's export has no MagVar column, and this used to fall back to
  // 0 — which is not "unknown", it asserts that true and magnetic are the same.
  // The panel was showing a TRUE bearing under a magnetic label, out by the
  // local variation. Fall back to the venue's measured value, keyed on the
  // boat's own position (see src/lib/magVar.ts).
  const activeLine = nearestGun
    ? startLines.find(sl=>sl.raceNum===nearestGun.raceNum)||startLines[0]||null
    : startLines[0]||null;
  let lineSqrMag = null;
  if(activeLine?.pin&&activeLine?.boat){
    const lineBearing = bearingDeg(activeLine.pin, activeLine.boat);
    if(lineBearing!=null){
      const a = (lineBearing + 90) % 360;
      const b = (lineBearing + 270) % 360;
      const ref = (row?.twd!=null && isFinite(row.twd) && row.twd!==0) ? row.twd : a;
      const angDist = (x,y)=>{const d=Math.abs(x-y)%360;return d>180?360-d:d;};
      const lineSqrTrue = angDist(a,ref) <= angDist(b,ref) ? a : b;
      const magvar = (row?.magvar!=null && isFinite(row.magvar))
        ? row.magvar
        : (fallbackMagVar(row?.lat, row?.lon)?.varDeg ?? 0);
      lineSqrMag = (lineSqrTrue - magvar + 360) % 360;
    }
  }

  // Formatters
  const fmtGun = s=>{
    if(s==null) return "--:--";
    const abs=Math.abs(s);
    return`${s>0?"-":"+"}${String(Math.floor(abs/60)).padStart(2,"0")}:${String(Math.floor(abs)%60).padStart(2,"0")}`;
  };
  const fmtBurn = s=>{
    if(s==null) return "--:--";
    const abs=Math.abs(s);
    return`${s>0?"+":"-"}${String(Math.floor(abs/60)).padStart(2,"0")}:${String(Math.floor(abs)%60).padStart(2,"0")}`;
  };
  const fmtDist = d=>{
    if(d==null) return "--";
    return`${d<0?"OCS ":""}${Math.abs(d).toFixed(1)}`;
  };

  // User-added overlay variables — SESSION ONLY (resets on reload; defaults for
  // every mode stay exactly as-is). Appended below the fixed gauges.
  const [extraGauges,setExtraGauges]=useState([]);
  const extraOverlay = row && extraGauges.length>0 && (
    <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:5}}>
      {extraGauges.map(k=>{
        const o=OVERLAY_VARS.find(x=>x.key===k); if(!o) return null;
        const v=row[k];
        const val=v!=null?(o.fmt==='burn'?fmtBurn(v):(o.unit==='°'?`${R(v,o.dec)}°`:R(v,o.dec))):"--";
        return <Gauge key={k} label={o.label} value={val} unit={o.unit==='°'?'':o.unit} color="#A78BFA" size="sm"/>;
      })}
    </div>
  );

  const overlay=row&&(()=>{
    if(mode==="start") return(
      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
        {/* GUN: red counting down, green after gun fires */}
        <Gauge label="GUN"
               value={gunActive?fmtGun(secToGun):"--:--"}
               unit={secToGun==null?"":secToGun>0?"to start":"after gun"}
               color={afterGun?"#10B981":"#EF4444"} size="lg"
               highlight={gunActive&&!afterGun&&secToGun<=60}/>
        {/* DIST TO LINE — straight from the log's DST_LINE column */}
        <Gauge label="LINE"
               value={fmtDist(distBL)}
               unit="BL"
               color={distBL==null?"#F59E0B":distBL<0?"#EF4444":"#10B981"} size="lg"
               highlight={distBL!=null&&distBL<0}/>
        {/* Burn to the LINE — the Burn column, already a burn */}
        <Gauge label="BurnLine"
               value={burnLine!=null?fmtBurn(burnLine):"--:--"}
               unit={burnLine==null?"":burnLine>0?"early":"late"}
               color={burnLine!=null&&burnLine<0?"#EF4444":"#10B981"} size="lg"
               highlight={burnLine!=null&&burnLine<-10}/>
        {/* Burn to the PIN (port end) */}
        <Gauge label="BurnPin"
               value={burnPin!=null?fmtBurn(burnPin):"--:--"}
               unit={burnPin==null?"":burnPin>0?"early":"late"}
               color={burnPin!=null&&burnPin<0?"#EF4444":"#10B981"} size="lg"
               highlight={burnPin!=null&&burnPin<-10}/>
        {/* Burn to the COMMITTEE BOAT (starboard end) */}
        <Gauge label="BurnBoat"
               value={burnBoat!=null?fmtBurn(burnBoat):"--:--"}
               unit={burnBoat==null?"":burnBoat>0?"early":"late"}
               color={burnBoat!=null&&burnBoat<0?"#EF4444":"#10B981"} size="lg"
               highlight={burnBoat!=null&&burnBoat<-10}/>
        <Gauge label="BSP"  value={R(row.bsp)}         unit="kn"   color="#10B981" size="sm"/>
        <Gauge label="Tgt %" value={row?.vsTargPct>0?`${R(row.vsTargPct,0)}%`:"--"} unit="vs target"
               color={!row?.vsTargPct||row.vsTargPct<=0?"#22C55E":row.vsTargPct>=110?"#166534":row.vsTargPct>=90?"#22C55E":"#EF4444"} size="sm"/>
        <Gauge label="TWS"  value={R(row.tws)}         unit="kn"   color="#7DD3FC" size="sm"/>
        <Gauge label="TWA"  value={`${R(row.twa,0)}°`} unit="true" color="#7DD3FC" size="sm"/>
        <Gauge label="TWD"  value={row?.twd!=null?`${R(row.twd,0)}°`:"--"}  unit="°"   color="#7DD3FC" size="sm"/>
        <Gauge label="Line Sqr" value={lineSqrMag!=null?`${R(lineSqrMag,0)}°`:"--"} unit="mag" color="#A78BFA" size="sm"/>
        <Gauge label="Keel" value={row?.keelAng!=null?`${R(row.keelAng,1)}°`:"--"} unit="°" color="#F59E0B" size="sm"/>
      </div>
    );
    if(mode==="reach") return(
      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
        <Gauge label="BSP"     value={R(row.bsp)}                          unit="kn"       color="#10B981"/>
        <Gauge label="Polar %" value={polPct!=null?R(polPct,0)+"%":"--"}   unit="vs polar" color={polPct==null?"#22C55E":polPct>=110?"#166534":polPct>=90?"#22C55E":"#EF4444"}/>
        <Gauge label="Tgt BSP" value={targBsp!=null?R(targBsp):"--"}       unit="kn"       color="#10B981" size="sm"/>
        <Gauge label="TWA"     value={`${R(row.twa,0)}°`}                  unit="true"     color="#7DD3FC" size="sm"/>
        <Gauge label="TWS"     value={R(row.tws)}                          unit="kn"       color="#7DD3FC" size="sm"/>
        <Gauge label="AWA"     value={awa!=null?`${R(awa,0)}°`:"--"}       unit="app"      color="#7DD3FC" size="sm"/>
        <Gauge label="Heel"    value={`${R(row.heel,0)}°`}                 unit="°"        color="#F97316" size="sm"/>
        <Gauge label="Keel"    value={row?.keelAng!=null?`${R(row.keelAng,1)}°`:"--"} unit="°" color="#F59E0B" size="sm"/>
      </div>
    );
    // upwind / downwind — VMG as % of polar optimal
    const vmgColor = vmgPct==null?"#22C55E":vmgPct>=110?"#166534":vmgPct>=90?"#22C55E":"#EF4444";
    return(
      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
        <Gauge label="BSP"     value={R(row.bsp)}                          unit="kn"   color="#10B981"/>
        <Gauge label="VMG %"   value={vmgPct!=null?R(vmgPct,0)+"%":"--"}   unit={isUpwindAngle?"↑ opt":"↓ opt"} color={vmgColor}/>
        <Gauge label="Tgt BSP" value={targBsp!=null?R(targBsp):"--"}       unit="kn"   color="#10B981" size="sm"/>
        <Gauge label="TWA"     value={`${R(row.twa,0)}°`}                  unit="true" color="#7DD3FC" size="sm"/>
        <Gauge label="TWS"     value={R(row.tws)}                          unit="kn"   color="#7DD3FC" size="sm"/>
        <Gauge label="AWA"     value={awa!=null?`${R(awa,0)}°`:"--"}       unit="app"  color="#7DD3FC" size="sm"/>
        <Gauge label="Heel"    value={`${R(row.heel,0)}°`}                 unit="°"    color="#F97316" size="sm"/>
        <Gauge label="Keel"    value={row?.keelAng!=null?`${R(row.keelAng,1)}°`:"--"} unit="°" color="#F59E0B" size="sm"/>
      </div>
    );
  })();

  // Mode label badge
  const modeBadge=row&&(
    <div style={{position:"absolute",top:10,right:upcoming.length>0?10:10,display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
      <div style={{background:"rgba(0,0,0,0.7)",border:`1px solid ${mode==="start"?"#EF4444":mode==="reach"?"#8B5CF6":"#06B6D4"}40`,borderRadius:4,padding:"2px 7px",fontSize:8,color:mode==="start"?"#EF4444":mode==="reach"?"#A78BFA":"#06B6D4",fontWeight:700,letterSpacing:1}}>
        {mode==="start"?"⚑ START":mode==="reach"?"↗ REACH":"⬆ UPWIND/DWN"}
      </div>
      {upcoming.map((m,i)=><div key={i} style={{background:"rgba(0,0,0,0.8)",borderRadius:5,padding:"3px 7px",fontSize:10,color:m.color,border:`1px solid ${m.color}40`}}>{m.label} in {Math.round(m.vidSec-curTime)}s</div>)}
    </div>
  );

  return(
    <div style={{background:"#030F1A",borderRadius:12,overflow:"hidden",border:"1px solid #1E3A5A"}}>
      <div ref={stageRef} style={mobileFs
          ? {position:"fixed",top:0,left:0,width:"100vw",height:"100dvh",zIndex:9999,background:"#000",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}
          : {position:"relative",background:"#000",aspectRatio:"16/9",width:"100%",overflow:"hidden",borderRadius:"12px 12px 0 0"}}>
        {/* Exit button — only while in mobile pseudo-fullscreen. */}
        {mobileFs&&(
          <button onClick={(e)=>{e.stopPropagation();setMobileFs(false);}}
            style={{position:"absolute",top:10,right:10,zIndex:4,background:"rgba(0,0,0,0.6)",border:"1px solid #ffffff30",borderRadius:8,width:36,height:36,color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        )}
        {video.objectUrl?<video key={`${video.id}:${useLocalHD?'hd':'std'}`} ref={vidRef} poster={video.thumbnailUrl||undefined} playsInline autoPlay={autoPlay} {...{'webkit-playsinline':'true','x5-playsinline':'true'}} style={{width:"100%",height:"100%",objectFit:"contain",cursor:"pointer",transition:"transform .18s ease",...rotStyle(video.rotation,16,9)}} onClick={()=>{const v=vidRef.current; if(!v)return; if(v.paused) v.play().catch(()=>{}); else v.pause();}} onTimeUpdate={onUpdate} onPlay={e=>{setStarted(true);onUpdate(e);}} onPause={e=>{qoeRef.current?.pause();onUpdate(e);}}
          onPlaying={()=>qoeRef.current?.playing()} onSeeking={()=>qoeRef.current?.seeking(true)} onSeeked={()=>qoeRef.current?.seeking(false)} onEnded={()=>qoeRef.current?.pause()}
          onWaiting={()=>{qoeRef.current?.waiting();setPlayState(st=>st==="error"?st:"loading");}}
          onStalled={()=>setPlayState(st=>st==="error"?st:"loading")}
          onCanPlay={()=>{setPlayState("ready");setSlow(false);}}
          onError={e=>{
            // Released on purpose (clip change, source swap) — not a failure.
            if(!e.target.currentSrc&&!hlsRef.current) return;
            onMediaFail(mediaErrText(e.target));
          }}
          onLoadedMetadata={e=>{setPlayState("ready");setSlow(false);setDur(e.target.duration); if(seekOnLoadRef.current!=null){try{e.target.currentTime=seekOnLoadRef.current;}catch{} seekOnLoadRef.current=null;} if(autoPlay){e.target.play().catch(()=>setStarted(false));}}}/>:
         <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center",padding:16}}>
           {stage==="unavailable"?(
             <>
               <div style={{fontSize:26,marginBottom:8}}>⚠</div>
               <div style={{fontSize:13,color:"#FCA5A5",fontWeight:600,maxWidth:300,lineHeight:1.4}}>{STAGE_TEXT.unavailable}</div>
               <div style={{fontSize:10,color:"#94A3B8",marginTop:6,maxWidth:300,lineHeight:1.45}}>
                 {video.streamFailed?"Bunny could not encode this clip — it needs uploading again."
                   :video.streamBytes===0?"The upload did not complete — it needs uploading again."
                   :video.streamStalled?"The encode has been queued a long time without starting."
                   :video.urlFailReason==="auth"?"Your sign-in has expired — reload the page and sign in again."
                   :video.urlFailed?"We could not reach it just now — the connection may have dropped."
                   :"There is no copy of this clip in the cloud yet."}
               </div>
               {(video.urlFailed||video.streamStalled)&&onRecheckStream&&(
                 <button onClick={e=>{e.stopPropagation();onRecheckStream(video.id,{force:true});}}
                   style={{marginTop:10,background:"#1E3A5A",border:"none",borderRadius:6,padding:"6px 14px",color:"#7DD3FC",fontSize:11,fontWeight:700,cursor:"pointer"}}>Try again</button>
               )}
             </>
           ):(
             <>
               <div style={{fontSize:26,marginBottom:8}}>⏳</div>
               <div style={{fontSize:13,color:"#7DD3FC",fontWeight:600,maxWidth:300,lineHeight:1.4}}>{STAGE_TEXT.finding}</div>
               {/* Which phase, when Bunny has told us — "encoding, 40%" and "queued"
                   need different patience — but as the small print, not the headline. */}
               {(video.streamPct>0||video.streamPhase==="queued")&&(
                 <div style={{fontSize:10,color:"#94A3B8",marginTop:6}}>
                   {video.streamPct>0?`Encoding — ${Math.round(video.streamPct)}%`:"Waiting in the encoding queue"}
                 </div>
               )}
               {video.streamPct>0&&(
                 <div style={{width:170,height:4,background:"#0A1929",borderRadius:2,overflow:"hidden",marginTop:7}}>
                   <div style={{height:"100%",width:`${Math.min(100,video.streamPct)}%`,background:"#7DD3FC",transition:"width .4s"}}/>
                 </div>
               )}
             </>
           )}
         </div>}
        {/* Say what the player is doing. The element stays mounted underneath, so a
            stream that recovers still plays without the user touching anything. */}
        {/* Before the first play, "loading" means nothing yet — the ▶ below is the
            state. After it, a tap on "Video loading" still nudges play (a user
            gesture is what an iPhone waits for). */}
        {video.objectUrl&&stage!=="ready"&&(stage!=="loading"||started)&&(
          <div role={stage==="unavailable"?"alert":"status"} aria-live={stage==="unavailable"?"assertive":"polite"}
            onClick={stage==="loading"?startPlay:undefined}
            style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"rgba(3,15,26,0.82)",textAlign:"center",padding:16,zIndex:3,cursor:stage==="loading"?"pointer":"default"}}>
            {stage==="unavailable"?(
              <>
                <div style={{fontSize:26,marginBottom:8}}>⚠</div>
                <div style={{fontSize:13,color:"#FCA5A5",fontWeight:600,maxWidth:300,lineHeight:1.4}}>{STAGE_TEXT.unavailable}</div>
                {playErr&&<div style={{fontSize:10,color:"#94A3B8",marginTop:6,maxWidth:280,lineHeight:1.45}}>Detail: {playErr}</div>}
                <button onClick={e=>{e.stopPropagation();setPlayState("loading");setPlayErr(null);onRecheckStream?.(video.id,{force:true});reloadInPlace();}}
                  style={{marginTop:10,background:"#1E3A5A",border:"none",borderRadius:6,padding:"6px 14px",color:"#7DD3FC",fontSize:11,fontWeight:700,cursor:"pointer"}}>Try again</button>
              </>
            ):stage==="finding"?(
              <>
                <div style={{fontSize:24,marginBottom:8}}>⏳</div>
                <div style={{fontSize:13,color:"#7DD3FC",fontWeight:600,maxWidth:300,lineHeight:1.4}}>{STAGE_TEXT.finding}</div>
              </>
            ):(
              <>
                <div style={{fontSize:24,marginBottom:8}}>⏳</div>
                <div style={{fontSize:13,color:"#7DD3FC",fontWeight:600}}>{STAGE_TEXT.loading}</div>
                {slow&&(
                  <>
                    <div style={{fontSize:10,color:"#94A3B8",marginTop:6,maxWidth:280,lineHeight:1.45}}>Still loading — on a slow connection this can take a while.</div>
                    <button onClick={e=>{e.stopPropagation();setPlayErr(null);onRecheckStream?.(video.id,{force:true});reloadInPlace();startPlay();}}
                      style={{marginTop:10,background:"#1E3A5A",border:"none",borderRadius:6,padding:"6px 14px",color:"#7DD3FC",fontSize:11,fontWeight:700,cursor:"pointer"}}>Try again</button>
                  </>
                )}
              </>
            )}
          </div>
        )}
        {!playing&&video.objectUrl&&(playState==="ready"||(!started&&stage==="loading"))&&<div role="button" aria-label="Play video" onClick={startPlay} style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:64,height:64,background:"rgba(6,182,212,0.9)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:22,zIndex:2}}>▶</div>}
        {/* On mobile, pin to all-but-bottom so tiles wrap within the
            frame width instead of overflowing off the right edge. */}
        {overlay&&<div style={{position:"absolute",top:isMobile?6:10,left:isMobile?6:10,right:mobileFs?52:(isMobile?6:undefined)}}>{overlay}{extraOverlay}</div>}
        {modeBadge}
        {/* Rotate — TL3+ only (the parent supplies onRotate). Stores an ANGLE; the file
            is never re-encoded, so its capture metadata (Apple Keys:CreationDate) is
            preserved. Rotating in QuickTime Player transcodes and destroys it, which is
            what left clips carrying the edit time instead of the recording time. */}
        {onRotate&&(
          <button
            onClick={(e)=>{e.stopPropagation(); onRotate((((video.rotation||0)+90)%360));}}
            title={`Rotate 90° (now ${video.rotation||0}°) — display only, the file is not re-encoded`}
            style={{position:"absolute",top:8,right:8,zIndex:4,width:32,height:32,borderRadius:8,
              border:"1px solid #1E3A5A",background:"rgba(3,15,26,0.72)",color:"#7DD3FC",
              cursor:"pointer",fontSize:15,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>
            ⟳
          </button>
        )}
        {/* Share — TL2+ and the boat owner. Mints a footage-only link (no numbers). */}
        {canShare&&(
          <button
            onClick={(e)=>{e.stopPropagation(); setShareOpen(true);}}
            title="Share this clip — footage only, no instrument data"
            aria-label="Share this clip"
            style={{position:"absolute",top:8,right:onRotate?44:8,zIndex:4,width:32,height:32,borderRadius:8,
              border:"1px solid #1E3A5A",background:"rgba(3,15,26,0.72)",color:"#7DD3FC",
              cursor:"pointer",fontSize:15,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>
            ↗
          </button>
        )}
        {shareOpen&&<ShareSheet video={video} onClose={()=>setShareOpen(false)}/>}
        <div style={{position:"absolute",bottom:8,left:8,display:"flex",alignItems:"center",gap:6}}>
          {vidQuality&&<div style={{background:"rgba(0,0,0,0.7)",borderRadius:4,padding:"2px 6px",fontSize:9,color:"#7DD3FC",fontFamily:"monospace",letterSpacing:0.3}}>▾ {vidQuality}</div>}
          {/* Coach/admin only: opt into local HD playback from the IndexedDB
              blob. Useful for debriefs where bandwidth-independent, max-
              fidelity playback matters more than smooth ABR. */}
          {canPlayLocalHD && video.hasLocalBlob && (
            <button onClick={toggleLocalHD}
              title={useLocalHD?"Switch back to the adaptive cloud stream":"Play the original from local storage (HD, no streaming)"}
              style={{background:useLocalHD?"rgba(245,158,11,0.9)":"rgba(0,0,0,0.7)",border:"none",borderRadius:4,padding:"2px 6px",fontSize:9,color:useLocalHD?"#000":"#F59E0B",fontFamily:"monospace",letterSpacing:0.3,cursor:"pointer",fontWeight:useLocalHD?700:500}}>
              {useLocalHD?"◆ HD local":"◇ HD local"}
            </button>
          )}
        </div>
        <div style={{position:"absolute",bottom:8,right:8,background:"rgba(0,0,0,0.7)",borderRadius:4,padding:"2px 7px",fontSize:10,color:"#64748B",fontFamily:"monospace"}}>{fmtT(curTime)} / {fmtT(dur)}{logUtc&&row?`  ${(()=>{const d=new Date(logUtc+sessionTzOffset*60000);return String(d.getUTCHours()).padStart(2,"0")+":"+String(d.getUTCMinutes()).padStart(2,"0")+":"+String(d.getUTCSeconds()).padStart(2,"0");})()} local`:""}</div>
      </div>
      <div style={{padding:"8px 12px 0"}}>
        {/* Overlay variables — add extra gauges for this session only. */}
        {logData?.rows?.length>0 && (
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:8}}>
            <span style={{fontSize:9,color:"#475569",letterSpacing:1,textTransform:"uppercase"}}>Overlay +</span>
            {extraGauges.map(k=>{const o=OVERLAY_VARS.find(x=>x.key===k);return(
              <span key={k} style={{display:"inline-flex",alignItems:"center",gap:4,background:"#8B5CF615",border:"1px solid #8B5CF640",borderRadius:4,padding:"1px 4px 1px 7px",fontSize:9,color:"#A78BFA"}}>
                {o?.label||k}
                <button onClick={()=>setExtraGauges(p=>p.filter(x=>x!==k))} style={{background:"none",border:"none",color:"#A78BFA",cursor:"pointer",fontSize:11,lineHeight:1,padding:0}}>×</button>
              </span>);})}
            <select value="" onChange={e=>{const v=e.target.value; if(v) setExtraGauges(p=>p.includes(v)?p:[...p,v]);}}
              style={{background:"#071624",border:"1px solid #1E3A5A",borderRadius:4,padding:"3px 6px",color:"#7DD3FC",fontSize:10,cursor:"pointer"}}>
              <option value="">+ add variable…</option>
              {OVERLAY_VARS.filter(o=>!extraGauges.includes(o.key)).map(o=><option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
        )}
        <div style={{position:"relative",height:26,background:"#071624",borderRadius:4,cursor:"pointer",overflow:"hidden"}} onClick={seek}>
          <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pct}%`,background:"#06B6D430",transition:"width 0.5s linear"}}/>
          <div style={{position:"absolute",left:`${pct}%`,top:0,bottom:0,width:2,background:"#06B6D4",transform:"translateX(-50%)"}}/>
          {/* Phase B — shaded "will be deleted" zones + red cut lines
              at the user's chosen trim points. The shading visualises
              what disappears on Save without scaring the user with a
              modal. */}
          {pendingCrop?.deleteUpTo != null && dur > 0 && (
            <>
              <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${Math.min(100,(pendingCrop.deleteUpTo/dur)*100)}%`,background:"rgba(239,68,68,0.20)",pointerEvents:"none"}}/>
              <div style={{position:"absolute",left:`${Math.min(100,(pendingCrop.deleteUpTo/dur)*100)}%`,top:0,bottom:0,width:2,background:"#EF4444",transform:"translateX(-50%)",pointerEvents:"none"}}/>
            </>
          )}
          {pendingCrop?.deleteFrom != null && dur > 0 && (
            <>
              <div style={{position:"absolute",left:`${Math.min(100,(pendingCrop.deleteFrom/dur)*100)}%`,top:0,right:0,bottom:0,background:"rgba(239,68,68,0.20)",pointerEvents:"none"}}/>
              <div style={{position:"absolute",left:`${Math.min(100,(pendingCrop.deleteFrom/dur)*100)}%`,top:0,bottom:0,width:2,background:"#EF4444",transform:"translateX(-50%)",pointerEvents:"none"}}/>
            </>
          )}
          {markers.map((m,i)=><div key={i} onClick={e=>{e.stopPropagation();if(vidRef.current)vidRef.current.currentTime=m.vidSec;}} title={`${m.label} +${fmtT(m.vidSec)}`} style={{position:"absolute",left:`${(m.vidSec/Math.max(dur,1))*100}%`,top:0,bottom:0,width:2,background:m.color,opacity:m.isValid===false?0.3:1,cursor:"pointer"}}/>)}
          <span style={{position:"absolute",left:6,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#334155",pointerEvents:"none",fontFamily:"monospace"}}>{markers.length>0?`${markers.length} events`:row?"● live data":"click to seek"}</span>
        </div>
      </div>
      <div style={{padding:"7px 12px 11px",display:"flex",gap:7,alignItems:"center"}}>
        <button onClick={()=>playing?vidRef.current?.pause():vidRef.current?.play()} style={{background:"#06B6D4",border:"none",borderRadius:6,padding:"6px 14px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>{playing?"⏸ Pause":"▶ Play"}</button>
        <button onClick={()=>{if(vidRef.current)vidRef.current.currentTime=0;}} style={{background:"#1E3A5A",border:"none",borderRadius:6,padding:"6px 9px",color:"#94A3B8",cursor:"pointer"}}>⏹</button>
        <button
          title="Fullscreen (with data overlay)"
          onClick={()=>{
            if(isMobile){
              // CSS pseudo-fullscreen keeps the instrument overlay on top —
              // native iOS video fullscreen would hide it.
              setMobileFs(f=>!f);
              return;
            }
            // Desktop: fullscreen the STAGE container (video + overlay), not
            // the bare <video>, so the gauges render over the picture.
            const el=stageRef.current;
            if(!el)return;
            if(document.fullscreenElement) document.exitFullscreen?.();
            else if(el.requestFullscreen) el.requestFullscreen();
            else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
          }}
          style={{background:"#1E3A5A",border:"none",borderRadius:6,padding:"6px 9px",color:"#94A3B8",cursor:"pointer"}}
        >⛶</button>
        <button
          title="Picture-in-Picture (drag + resize a floating window)"
          onClick={async ()=>{
            const el=vidRef.current;
            if(!el)return;
            try {
              if(document.pictureInPictureElement) await document.exitPictureInPicture?.();
              else if(el.requestPictureInPicture) await el.requestPictureInPicture();
            } catch (err) {
              console.warn('Picture-in-picture unavailable:', err);
            }
          }}
          style={{background:"#1E3A5A",border:"none",borderRadius:6,padding:"6px 9px",color:"#94A3B8",cursor:"pointer"}}
        >⧉</button>
        {/* Phase B — three-button crop UX:
            1. "Delete UPTO here"  — marks the head cut (keeps [t, end])
            2. "Delete FROM here"  — marks the tail cut (keeps [0, t])
            3. "Save cropped video" — appears once any cut is marked;
               runs ffmpeg to commit. Both 1 and 2 can be re-clicked at
               any time to move their marker; the timeline shows the
               shaded delete zones live. */}
        {onDeleteUpTo && (
          <button
            title="Delete everything from start UP TO the current playback position"
            onClick={()=>onDeleteUpTo(curTime)}
            disabled={cropBusy}
            style={{background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"6px 9px",color:"#EF4444",cursor:cropBusy?"not-allowed":"pointer",fontSize:11,fontWeight:600,opacity:cropBusy?0.5:1}}
          >⏴⌫ Delete UPTO here</button>
        )}
        {onDeleteFromHere && (
          <button
            title="Delete everything FROM the current playback position to the end"
            onClick={()=>onDeleteFromHere(curTime)}
            disabled={cropBusy}
            style={{background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"6px 9px",color:"#EF4444",cursor:cropBusy?"not-allowed":"pointer",fontSize:11,fontWeight:600,opacity:cropBusy?0.5:1}}
          >⌫⏵ Delete FROM here</button>
        )}
        {onSaveCrop && (pendingCrop?.deleteUpTo != null || pendingCrop?.deleteFrom != null) && (
          <button
            title="Apply the marked cuts — ffmpeg trims, the result replaces the local original"
            onClick={onSaveCrop}
            disabled={cropBusy}
            style={{background:cropBusy?"#1E3A5A":"#1D9E75",border:"none",borderRadius:6,padding:"6px 12px",color:cropBusy?"#94A3B8":"#fff",cursor:cropBusy?"not-allowed":"pointer",fontSize:11,fontWeight:700}}
          >
            {cropBusy
              ? `Saving ${Math.round((cropProgress?.pct||0)*100)}%`
              : "💾 Save cropped video"}
          </button>
        )}
        {/* Native-pipeline shortcuts — for the "crop in-app → ffmpeg compress
            on disk → re-import" workflow on slow-upload connections. */}
        {onExportToDisk && (
          <button
            title="Save the local clip to disk as MP4 — for external compression with ffmpeg, then bring it back via Replace"
            onClick={onExportToDisk}
            disabled={cropBusy}
            style={{background:"#06B6D420",border:"1px solid #06B6D450",borderRadius:6,padding:"6px 9px",color:"#06B6D4",cursor:cropBusy?"not-allowed":"pointer",fontSize:11,fontWeight:600,opacity:cropBusy?0.5:1}}
          >↓ Save to disk</button>
        )}
        {onUploadCompressed && (
          <button
            title="Upload a compressed copy (from disk) to Bunny — local HD stays untouched for debriefs"
            onClick={onUploadCompressed}
            disabled={cropBusy}
            style={{background:"#06B6D420",border:"1px solid #06B6D450",borderRadius:6,padding:"6px 9px",color:"#06B6D4",cursor:cropBusy?"not-allowed":"pointer",fontSize:11,fontWeight:600,opacity:cropBusy?0.5:1}}
          >↑ Upload compressed</button>
        )}
        <div style={{flex:1}}/>
        {row&&<span style={{fontSize:10,color:"#1D9E75"}}>● live instruments</span>}
        {!polar&&row&&row.vsTarget==null&&<span style={{fontSize:9,color:"#475569"}}>· upload polar for target BSP</span>}
        {isHls&&<span style={{fontSize:9,color:"#8B5CF6"}}>HLS · Stream</span>}
      </div>
    </div>
  );
}

export { OVERLAY_VARS, VideoPlayer };