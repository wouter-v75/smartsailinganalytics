'use client'
import React from "react";
import { saveTagListCloud } from '../../lib/cloud-tag-list';
import { saveSyncOffset, saveTagList, venueTodayIso as TODAY } from '../../lib/localStore';
import { canShareVideos } from '../../lib/shareRoles';
import { getBrowserSupabase } from '../../lib/supabase/browser';
import { thumbSrc } from '../../lib/thumbSrc';
import { SrcBadge } from '../ssa/SrcBadge';
import { fmtT } from '../ssa/format';
import { BatchSyncPanel } from '../sync/BatchSyncPanel';
import { SyncControl } from '../sync/SyncControl';
import { TagEditor } from '../video/TagEditor';
import { VideoPlayer } from '../video/VideoPlayer';

function MobileLibrary({allVideos,sessions,activeDate,selectedVideo,setSelectedVideo,
                        onRecheckStream,
                        logData,xmlData,loadDate,syncOffsets,setSyncOffsets,
                        saveSyncForVideos,saveTagsForVideo,
                        sessionTzOffset,searchQuery,setSearchQuery,
                        selectedTags,setSelectedTags,toggleTag,allTags,isManTag,displayed,perms,
                        onSyncProxies,onUploadOriginals,mobileSyncState,syncErrors,onRotateVideo,
                        cloudStatus,sessionTagList,setSessionTagList,tagSuggestionList,
                        handlePlayUtc,effectiveRole,
                        onThumbLoad,videoThumbsLoading,videoLoadedIds,videoTotalThumbs}){
  const [view, setView]   = React.useState("clips"); // "clips" | "player" | "sessions"
  const video = selectedVideo;
  const fmtDate_ = d=>{if(!d)return"";const p=d.split("-");return p.length===3?`${p[2]}/${p[1]}`:d;};

  if(view==="sessions") return(
    <div style={{flex:1,overflowY:"auto",background:"#030F1A"}}>
      <div style={{padding:"12px 14px 6px",display:"flex",alignItems:"center",gap:10}}>
        <button onClick={()=>setView("clips")} style={{background:"none",border:"none",color:"#06B6D4",fontSize:18,cursor:"pointer",padding:"4px 8px 4px 0"}}>←</button>
        <span style={{fontSize:14,fontWeight:700,color:"#E2E8F0"}}>Sessions</span>
      </div>
      {(()=>{
        // Day-N within each regatta (same logic as desktop sidebar).
        const evMap=new Map(); const g=new Map();
        for(const s of sessions){ if(s.event){ if(!g.has(s.event)) g.set(s.event,[]); g.get(s.event).push(s.date); } }
        for(const [ev,ds] of g){ ds.slice().sort().forEach((d,i)=>evMap.set(d,{event:ev,dayN:i+1})); }
        return sessions.filter(s=>(s.videoCount||0)>0 && s.date<=TODAY()).map(s=>{
          const isActive=activeDate===s.date;
          const isLocal=!(s.cloudSynced||s.source==="cloud"||s.source==="supabase");
          const ev=evMap.get(s.date);
          return(
          <div key={s.date} onClick={()=>{loadDate(s.date);setView("clips");}}
            style={{padding:"14px 16px",borderBottom:"1px solid #0F2030",
              background:isActive?"#0F2A45":"transparent",display:"flex",alignItems:"center",gap:12}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:14,color:isActive?"#06B6D4":"#E2E8F0",fontWeight:600}}>
                {s.date===TODAY()?"Today":fmtDate_(s.date)}
              </div>
              {ev&&<div style={{fontSize:11,color:"#EF4444",fontWeight:700,marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>🏁 {ev.event} Day {ev.dayN}</div>}
              <div style={{fontSize:12,color:"#475569",marginTop:2}}>
                {s.videoCount||0} clips{s.hasLog?" · log":""}{s.hasXml?" · events":""}
                {s.location?` · ${s.location}`:""}
              </div>
            </div>
            <SrcBadge source={isLocal?"local":"cloud"}/>
            {isActive&&<span style={{color:"#06B6D4",fontSize:18}}>✓</span>}
          </div>
          );
        });
      })()}
    </div>
  );

  if(view==="player"&&video) return(
    <div style={{flex:1,overflowY:"auto",background:"#030F1A"}}>
      <div style={{display:"flex",alignItems:"center",padding:"10px 14px 6px",gap:10}}>
        <button onClick={()=>setView("clips")} style={{background:"none",border:"none",color:"#06B6D4",fontSize:18,cursor:"pointer",padding:"4px 8px 4px 0"}}>←</button>
        <span title={video.title||""} style={{fontSize:13,fontWeight:600,color:"#E2E8F0",flex:1,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{(()=>{
          if(video.startUtc==null) return "—";
          const d=new Date(video.startUtc + (sessionTzOffset||0)*60000);
          return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
        })()}</span>
      </div>
      <VideoPlayer onRecheckStream={onRecheckStream} video={video} logData={logData} xmlData={xmlData}
        syncOffset={syncOffsets[video.id]||0} sessionTzOffset={sessionTzOffset}
        onPlayUtc={handlePlayUtc}
        onRotate={onRotateVideo ? (deg)=>onRotateVideo(video, deg) : null}
        canShare={canShareVideos(effectiveRole)}
        canPlayLocalHD={['admin','coach'].includes(effectiveRole)}/>
      <div style={{padding:"12px 16px"}}>
        {/* Sync offset — coach + admin only. Gate on effectiveRole (the real
            membership role); perms.canSync follows the legacy `role` selector
            which defaults to "coach", so it leaked this card to TL1/TL2. */}
        {['admin','coach'].includes(effectiveRole) && (
        <div style={{marginBottom:12}}>
          <SyncControl offset={syncOffsets[video.id]||0}
            onChange={v=>{saveSyncOffset(video.id,v);setSyncOffsets(p=>({...p,[video.id]:v}));}}
            onSave={async(secs)=>{ await saveSyncForVideos([video], secs); }}/>
        </div>
        )}
        {/* Tags — admin / coach / TL2 only */}
        {['admin','coach','tl2'].includes(effectiveRole)&&<TagEditor video={video} tagList={sessionTagList} suggestionList={tagSuggestionList} sessionDate={activeDate}
          onTagListChange={async t=>{
            setSessionTagList(t);
            try {
              const supabase=getBrowserSupabase();
              const {data:{user}}=await supabase.auth.getUser();
              if(user) await saveTagListCloud({userId:user.id,date:activeDate,tags:t});
              else saveTagList(activeDate,t);
            } catch { saveTagList(activeDate,t); }
          }}
          onSave={async (id,tags)=>{ const vid=allVideos.find(v=>v.id===id)||video; await saveTagsForVideo(vid, tags); }}/>}
      </div>
    </div>
  );

  // Default: clip grid view
  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:"#030F1A"}}>
      {/* Session selector row */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px 8px",borderBottom:"1px solid #0F2030",flexShrink:0}}>
        <button onClick={()=>setView("sessions")}
          style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:6,
            padding:"6px 12px",color:"#06B6D4",fontSize:12,cursor:"pointer",fontWeight:600}}>
          {activeDate===TODAY()?"Today":fmtDate_(activeDate)} ▾
        </button>
        <input value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
          placeholder="Search…"
          style={{flex:1,background:"#071624",border:"1px solid #1E3A5A",borderRadius:6,
            padding:"8px 10px",color:"#E2E8F0",fontSize:14,outline:"none"}}/>
        {selectedTags.length>0&&<button onClick={()=>setSelectedTags([])}
          style={{background:"none",border:"1px solid #EF444440",borderRadius:5,padding:"6px 8px",
            color:"#EF4444",fontSize:12,cursor:"pointer"}}>✕</button>}
      </div>
      {/* ── Cloud upload — mobile ────────────────────────────────────────────
          The desktop Videos tab has had BatchSyncPanel ("Sync proxies" /
          "Upload originals") all along; mobile had NO upload control at all, so a
          crew member (TL3) who shot the footage on their phone had no way to get it
          off the device — it sat local forever and no coach ever saw it.
          Gated on canImport, not canSync: if you're trusted to import footage you're
          trusted to push the footage you imported. Hidden when there's nothing on
          this device to upload (cloud-only clips have no blob to send). */}
      {perms.canImport && cloudStatus?.available && allVideos.some(v=>v.hasLocalBlob) && (
        <div style={{padding:"8px 14px",borderBottom:"1px solid #0F2030",flexShrink:0}}>
          <BatchSyncPanel
            videos={allVideos}
            syncState={mobileSyncState}
            onSyncProxies={onSyncProxies}
            onUploadOriginals={onUploadOriginals}
            syncErrors={syncErrors}
          />
        </div>
      )}
      {/* Tag filter pills */}
      {allTags.filter(isManTag).length>0&&(
        <div style={{display:"flex",gap:6,padding:"6px 14px",overflowX:"auto",flexShrink:0,borderBottom:"1px solid #0F2030"}}>
          {allTags.filter(isManTag).map(t=>(
            <button key={t} onClick={()=>toggleTag(t)}
              style={{background:selectedTags.includes(t)?"#06B6D4":"#0A1929",
                border:`1px solid ${selectedTags.includes(t)?"#06B6D4":"#1E3A5A"}`,
                borderRadius:16,padding:"5px 12px",color:selectedTags.includes(t)?"#000":"#7DD3FC",
                fontSize:12,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
              {t}
            </button>
          ))}
        </div>
      )}
      {/* Clip grid */}
      <div style={{flex:1,overflowY:"auto",padding:"10px 10px"}}>
        {(() => {
          const loadedCount = Math.min(videoLoadedIds?.size || 0, videoTotalThumbs || 0);
          const isLoading = videoThumbsLoading || ((videoTotalThumbs||0) > 0 && loadedCount < videoTotalThumbs);
          if(!isLoading) return null;
          const pct = (videoTotalThumbs||0) > 0 ? Math.round((loadedCount/videoTotalThumbs)*100) : 0;
          return (
            <div style={{background:"#06B6D410",border:"1px solid #06B6D430",borderRadius:6,padding:"7px 10px",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:10,color:"#06B6D4",fontFamily:"monospace",marginBottom:5}}>
                <span>⟳ Loading thumbnails…</span>
                <span>{videoThumbsLoading ? "…" : `${loadedCount} / ${videoTotalThumbs}`}</span>
              </div>
              <div style={{height:4,background:"#0A1929",borderRadius:2,overflow:"hidden"}}>
                <div style={{height:"100%",width: videoThumbsLoading ? "15%" : `${pct}%`,background:"#06B6D4",transition:"width 0.2s ease-out",animation: videoThumbsLoading ? "ssa-thumb-pulse 1.2s ease-in-out infinite" : "none"}}/>
              </div>
              <style>{`@keyframes ssa-thumb-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }`}</style>
            </div>
          );
        })()}
        {displayed.length===0&&(
          <div style={{textAlign:"center",padding:"60px 20px",color:"#334155"}}>
            <div style={{fontSize:40,marginBottom:12,opacity:0.3}}>📹</div>
            <div style={{fontSize:14,color:"#475569"}}>No clips for this session</div>
          </div>
        )}
        {(()=>{
          const groups=[], seen=new Map();
          for(const v of displayed){const d=v.sessionDate||"unknown";if(!seen.has(d)){seen.set(d,[]);groups.push(d);}seen.get(d).push(v);}
          return groups.map(date=>{
            const vids=seen.get(date);
            return(
              <div key={date} style={{marginBottom:20}}>
                <div style={{fontSize:12,fontWeight:700,color:"#475569",marginBottom:8,padding:"0 4px"}}>
                  {date===TODAY()?"Today":fmtDate_(date)} · {vids.length} clip{vids.length!==1?"s":""}
                </div>
                {/* Mobile: single column list with horizontal thumb */}
                {vids.map(v=>(
                  <div key={v.id} onClick={()=>{setSelectedVideo(v);setView("player");}}
                    style={{display:"flex",gap:10,background:selectedVideo?.id===v.id?"#0F2A45":"#0A1929",
                      border:`1px solid ${selectedVideo?.id===v.id?"#06B6D4":"#1E3A5A"}`,
                      borderRadius:10,overflow:"hidden",marginBottom:8,cursor:"pointer",
                      minHeight:64,alignItems:"stretch"}}>
                    {/* Thumbnail — FIXED 96×64 box. Earlier versions sized the
                        box via flex align-items:stretch and the image via
                        height:100% / inset:0 — both depend on the parent
                        having a "definite" height, which is unreliable across
                        mobile browsers and left thumbnails blank in portrait.
                        Explicit width+height removes every such dependency. */}
                    <div style={{width:96,height:64,flexShrink:0,alignSelf:"center",background:"#071624",position:"relative",overflow:"hidden"}}>
                      {v.thumbnailUrl
                        ? <img src={thumbSrc(v.thumbnailUrl,256)} alt=""
                            /* loading=eager + fetchPriority=high stop the
                               browser parking below-the-fold thumbnails at
                               Low priority — on weak wifi those requests
                               otherwise never start and the loader hangs
                               (e.g. 6/10) until a rotation re-prioritises. */
                            loading="eager" fetchPriority="high" decoding="async"
                            onLoad={()=>onThumbLoad?.(v.id)}
                            onError={e=>{
                              // Optimiser unavailable (plan quota, a hiccup): fall back to the original once.
                              const el=e.currentTarget;
                              if(el.dataset.raw!=="1"&&v.thumbnailUrl&&el.src.includes("/_next/image")){ el.dataset.raw="1"; el.src=v.thumbnailUrl; return; }
                              onThumbLoad?.(v.id);
                            }}
                            style={{display:"block",width:"100%",height:"100%",objectFit:"cover",pointerEvents:"none"}}/>
                        : v.objectUrl&&v.source!=="cloud"&&!String(v.objectUrl).includes(".m3u8")
                          ? <video src={v.objectUrl}
                              onLoadedData={()=>onThumbLoad?.(v.id)}
                              onError={()=>onThumbLoad?.(v.id)}
                              style={{display:"block",width:"100%",height:"100%",objectFit:"cover",pointerEvents:"none"}} muted preload="none"/>
                          : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:18}}>📹</div>}
                      <div style={{position:"absolute",bottom:2,right:4,background:"rgba(0,0,0,0.8)",
                        borderRadius:2,padding:"0 3px",fontSize:9,color:"#64748B",fontFamily:"monospace"}}>
                        {v.duration?fmtT(v.duration):"--:--"}
                      </div>
                    </div>
                    {/* Metadata — declutter for mobile: drop TWS/TWA/Polar%,
                        the boat-name and location auto-tags, and the "tack"
                        manoeuvre tag. Only race + sail tags + local time. */}
                    {(()=>{
                      const EVENT_TAGS = ["race-start","topmark","mark"];
                      const POS_TAGS   = ["upwind","reach","downwind"];
                      const SAIL_SKIP  = /^(main|msail|mainsail|main-)/;
                      const tags = v.tags||[];
                      const boatTag = xmlData?.meta?.boat?.toLowerCase().replace(/\s+/g,"-") || null;
                      const locTag  = xmlData?.meta?.location?.toLowerCase().replace(/\s+/g,"-") || null;
                      // raceTags — events + first position; "gybe" stays, "tack" is hidden.
                      const raceTags = [
                        ...tags.filter(t=>EVENT_TAGS.includes(t)),
                        ...tags.filter(t=>POS_TAGS.includes(t)).slice(0,1),
                        ...tags.filter(t=>t==="gybe"),
                      ];
                      const SKIP_ALL = new Set(["local","cloud","training","race","today","topmark","mark","race-start","upwind","reach","downwind","tack","gybe"]);
                      // Sail tags = everything that ISN'T a race/event/manoeuvre
                      // category, mainsail, a wind/count bucket, the boat-name
                      // auto-tag, or the location auto-tag. We deliberately do
                      // NOT also try to guess "location-like" tags from hyphens
                      // — sail names with descriptors (e.g. "j3-light", "a2-vmg")
                      // were being swept up by that heuristic and disappeared.
                      const sailTags = tags.filter(t=>
                        !SKIP_ALL.has(t) && !SAIL_SKIP.test(t)
                        && !t.startsWith("tws-") && !/^\d+x-/.test(t)
                        && t!==boatTag && t!==locTag
                      );
                      const tagCol = t => {
                        if(EVENT_TAGS.includes(t)) return{bg:"#EF444420",bd:"#EF444440",c:"#EF4444"};
                        if(POS_TAGS.includes(t))   return{bg:"#06B6D420",bd:"#06B6D440",c:"#06B6D4"};
                        if(t==="gybe")             return{bg:"#1D9E7520",bd:"#1D9E7540",c:"#1D9E75"};
                        if(sailTags.includes(t))   return{bg:"#8B5CF620",bd:"#8B5CF640",c:"#A78BFA"};
                        return                          {bg:"#1E3A5A",  bd:"#2D4A6A",  c:"#7DD3FC"};
                      };
                      return(
                        <div style={{flex:1,padding:"8px 8px",display:"flex",flexDirection:"column",justifyContent:"center",minWidth:0}}>
                          {/* 1) Race tags */}
                          {raceTags.length>0&&(
                            <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:3}}>
                              {raceTags.map(t=>{const{bg,bd,c}=tagCol(t);return(<span key={t} style={{background:bg,border:`1px solid ${bd}`,color:c,fontSize:9,borderRadius:3,padding:"1px 5px",fontFamily:"monospace"}}>{t}</span>);})}
                            </div>
                          )}
                          {/* 2) Sail tags */}
                          {sailTags.length>0&&(
                            <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:3}}>
                              {sailTags.map(t=>{const{bg,bd,c}=tagCol(t);return(<span key={t} style={{background:bg,border:`1px solid ${bd}`,color:c,fontSize:9,borderRadius:3,padding:"1px 5px",fontFamily:"monospace"}}>{t}</span>);})}
                            </div>
                          )}
                          {/* 4) Clip start time (session-local) at bottom — replaces filename */}
                          <div title={v.title||""} style={{fontSize:13,fontWeight:600,color:"#E2E8F0",fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{(()=>{
                            if(v.startUtc==null) return "—";
                            const d=new Date(v.startUtc + (sessionTzOffset||0)*60000);
                            return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;
                          })()}</div>
                        </div>
                      );
                    })()}
                    <div style={{display:"flex",alignItems:"center",padding:"0 10px",color:"#334155",fontSize:18}}>›</div>
                  </div>
                ))}
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}

export { MobileLibrary };