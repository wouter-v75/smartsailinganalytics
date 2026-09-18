'use client'
import React, { useState } from "react";
import { AnalyticsTab } from '../AnalyticsTab';
import { UploadTab } from '../UploadTab';
import { BoatConfigTab, CampaignTab, PhotosTab, TaggerTab, TimelineTab, ToolsTabs, WeatherTab } from '../ssa/LazyTabs';
import { injectMobileCSS } from '../ssa/mobileCSS';
import { BatchSyncPanel } from '../sync/BatchSyncPanel';
import { ErrorBoundary } from '../ui';
import { MobileLibrary } from './MobileLibrary';

export function MobileShell(props){
  const {activeTab, setActiveTab, ...rest} = props;
  // Keep the Upload tab mounted while its folder watcher runs — tabs render
  // conditionally, so leaving the tab would destroy the watcher mid-card.
  const [uploadWatching, setUploadWatching] = useState(false);
  React.useEffect(()=>{ injectMobileCSS(); },[]);
  const tabDefs=[
    {id:"timeline", icon:"🧭", label:"Timeline"},
    {id:"campaign", icon:"🗓", label:"Plan"},
    {id:"boatconfig", icon:"⛵", label:"Boat"},
    {id:"weather",  icon:"🌦", label:"Weather"},
    // No Videos / Photos tab on a phone. Media is browsed from the Timeline's
    // day decks, clips play in the modal player wherever they are clicked
    // (track, charts, timeline), and importing both kinds of file is the
    // Upload tab's job. See the Upload pane below for the cloud-push panel
    // that used to live in the Videos tab.
    {id:"tagger",   icon:"🏷", label:"Tags"},
    {id:"analytics",icon:"📊", label:"Analytics"},
    {id:"upload",   icon:"⬆", label:"Upload"},
    {id:"tools",    icon:"🧰", label:"Tools"},
    {id:"admin",    icon:"⚙",  label:"Admin"},
  ].filter(t => {
    if (t.id === "campaign" && (!props.campaignOn || props.effectiveRole === 'guest')) return false;
    if (t.id === "boatconfig" && (!props.campaignOn || !props.canSeeBoatConfig)) return false;
    // Weather tab is available to all roles (tl1, consultant, guest included).
    // Tools (Squash + SailScan): TL2+ and consultant-in-period.
    if (t.id === "tools" && props.canSeeToolsTab === false) return false;
    // Tagging is contributing, and a guest does not contribute.
    if (t.id === "tagger" && props.effectiveRole === 'guest') return false;
    if (t.id === "admin" && props.effectiveRole !== 'admin') return false;
    return true;
  });
  return(
    <div className="ssa-mobile" style={{display:"flex",flexDirection:"column",
      height:"100dvh",background:"#030F1A",color:"#E2E8F0",
      fontFamily:"'Segoe UI',system-ui,sans-serif",overflow:"hidden"}}>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      {/* All header controls sit on the LEFT. The UserPill avatar is fixed
          at the top-right (position:fixed, z-index:9999); keeping the sync
          button + status left-aligned means they can never end up hidden
          underneath it, on any screen width. */}
      <header style={{background:"#050E1C",borderBottom:"1px solid #1E3A5A",
        padding:"0 12px",height:34,display:"flex",alignItems:"center",
        gap:7,flexShrink:0,position:"relative",zIndex:50}}>
        <span style={{fontSize:13,fontWeight:700,color:"#E2E8F0"}}>Shared</span>
        <span style={{fontSize:13,fontWeight:700,color:"#06B6D4",marginLeft:-3}}>Sailing Analytics</span>
        {/* ── Passive sync status pill (auto-syncs; tap to force a sync now) ── */}
        {/* The dot reflects the connection; the label auto-updates with sync   */}
        {/* state. No manual sync needed — it fires on foreground / reconnect.  */}
        {(()=>{
          const ph=props.mobileSyncState?.phase;
          const uc=props.unsyncedCount||0;
          const avail=props.cloudStatus?.available;
          const busy=ph==="pulling"||ph==="pushing";
          const dot=!avail?(props.cloudStatus===null?"#334155":"#F59E0B"):(busy?"#06B6D4":uc>0?"#F59E0B":"#1D9E75");
          let label="Cloud", color="#475569";
          if(!avail){label="Local";}
          else if(busy){label="syncing…";color="#06B6D4";}
          else if(ph==="done"){label="synced";color="#1D9E75";}
          else if(ph==="error"){label="sync failed";color="#F59E0B";}
          else if(uc>0){label=`${uc} pending`;color="#F59E0B";}
          return (
            <div onClick={()=>{ /* user-pressed sync: the ONLY path allowed to push video blobs */ if(avail&&!busy) props.onMobileSync?.({heavy:true,pushVideos:true}); }}
              title="Cloud sync is automatic — tap to sync now"
              style={{display:"flex",alignItems:"center",gap:5,fontSize:10,fontWeight:600,
                cursor:avail&&!busy?"pointer":"default",userSelect:"none"}}>
              {busy
                ? <span style={{fontSize:12,display:"inline-block",animation:"ssa-spin 1s linear infinite"}}>⟳</span>
                : <span style={{width:7,height:7,borderRadius:"50%",background:dot,display:"inline-block"}}/>}
              <span style={{color}}>{label}</span>
            </div>
          );
        })()}
        <div style={{flex:1}}/>
      </header>
      {/* ── Sync progress toast — slides in below header ─────────────────── */}
      {props.mobileSyncState?.phase&&(
        <div style={{background:props.mobileSyncState.phase==="error"?"#EF444415":props.mobileSyncState.phase==="done"?"#1D9E7515":"#06B6D415",
          borderBottom:`1px solid ${props.mobileSyncState.phase==="error"?"#EF444440":props.mobileSyncState.phase==="done"?"#1D9E7540":"#06B6D440"}`,
          padding:"6px 14px",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <div style={{flex:1,display:"flex",flexDirection:"column",gap:3}}>
            <div style={{fontSize:11,fontWeight:600,
              color:props.mobileSyncState.phase==="error"?"#EF4444":props.mobileSyncState.phase==="done"?"#1D9E75":"#06B6D4"}}>
              {props.mobileSyncState.message||"Working…"}
            </div>
            {(props.mobileSyncState.phase==="pulling"||props.mobileSyncState.phase==="pushing")&&(
              <div style={{height:2,background:"#1E3A5A",borderRadius:1,overflow:"hidden"}}>
                <div style={{height:"100%",background:"#06B6D4",
                  width:`${props.mobileSyncState.progress||0}%`,transition:"width .3s"}}/>
              </div>
            )}
          </div>
          {/* An error stays put until dismissed — it used to fade after a few seconds,
              which meant the message you actually needed was the one you couldn't read.
              Tapping it also reveals the per-clip reasons in the Videos tab panel. */}
          {props.mobileSyncState.phase==="error"&&(
            <button onClick={()=>props.setMobileSyncState?.({phase:null,message:"",progress:0})}
              aria-label="Dismiss"
              style={{background:"none",border:"1px solid #EF444440",borderRadius:5,color:"#EF4444",
                fontSize:11,padding:"3px 8px",cursor:"pointer",flexShrink:0}}>✕</button>
          )}
        </div>
      )}

      {/* ── Content area ─────────────────────────────────────────────────── */}
      <div style={{flex:1,overflow:"hidden",position:"relative"}}>

        {/* Library */}
        <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",
          visibility:activeTab==="library"?"visible":"hidden",
          pointerEvents:activeTab==="library"?"auto":"none",zIndex:activeTab==="library"?2:1}}>
          <MobileLibrary {...rest} setActiveTab={setActiveTab}/>
        </div>

        {/* Analytics — lazy mount */}
        {props.hasMountedAnalytics&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",
            visibility:activeTab==="analytics"?"visible":"hidden",
            pointerEvents:activeTab==="analytics"?"auto":"none",zIndex:activeTab==="analytics"?2:1}}>
            <ErrorBoundary label="Analytics"><AnalyticsTab logData={props.logData} xmlData={props.xmlData}
              allVideos={props.allVideos} sessions={props.sessions}
              selectedVideo={props.selectedVideo} onSelectVideo={props.setSelectedVideo}
              setActiveTab={setActiveTab} activeDate={props.activeDate}
              onSelectDate={props.onSelectDate} onPlayClip={props.playClipInModal}
              playUtc={props.playUtc} visible={activeTab==="analytics"} photos={props.photos}
              canUseAI={props.canUseAI} canSeeAnalyticsData={props.canSeeAnalyticsData}/></ErrorBoundary>
          </div>
        )}

        {/* Photos */}
        {activeTab==="photos"&&(
          <div style={{position:"absolute",inset:0,display:"flex",overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Photos"><PhotosTab role={props.role} logData={props.logData} xmlData={props.xmlData}
              activeDate={props.activeDate} sessions={props.sessions} loadDate={props.loadDate}
              cloudStatus={props.cloudStatus} onPhotosChange={props.setPhotos} sessionTzOffset={props.sessionTzOffset}
              canClearDay={['admin','team_manager','coach'].includes(props.effectiveRole)}/></ErrorBoundary>
          </div>
        )}
        {(activeTab==="upload"||uploadWatching)&&(
          <div style={{position:"absolute",inset:0,display:activeTab==="upload"?"flex":"none",flexDirection:"column",overflow:"hidden",zIndex:2}}>
            {/* Getting footage OFF the phone. This panel used to live in the
                mobile Videos tab, which a crew member reached after importing;
                with that tab gone it belongs here, one screen after the import
                that created the clips. Same gate as before: if you are trusted
                to import footage you are trusted to push what you imported. */}
            {props.perms?.canImport && props.cloudStatus?.available && (props.allVideos||[]).some(v=>v.hasLocalBlob) && (
              <div style={{padding:"8px 14px",borderBottom:"1px solid #0F2030",flexShrink:0}}>
                <BatchSyncPanel
                  videos={props.allVideos}
                  syncState={props.mobileSyncState}
                  onSyncProxies={props.onSyncProxies}
                  onUploadOriginals={props.onUploadOriginals}
                  syncErrors={props.syncErrors}
                />
              </div>
            )}
            <div style={{flex:1,minHeight:0,display:"flex",overflow:"hidden"}}>
              <ErrorBoundary label="Upload"><UploadTab onWatchingChange={setUploadWatching} role={props.role} cloudStatus={props.cloudStatus} onImported={props.handleImported} sailInventory={props.sailInventory} campaignCfg={props.campaignCfg} setSailDiff={props.setSailDiff} syncOffsets={props.syncOffsets}/></ErrorBoundary>
            </div>
          </div>
        )}
        {activeTab==="tools"&&(
          <ToolsTabs teamId={props.campaignCfg?.teamId} boatId={props.campaignCfg?.boatId}/>
        )}

        {/* Campaign */}
        {activeTab==="campaign"&&props.campaignOn&&props.campaignCfg&&props.effectiveRole!=='guest'&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Campaign"><CampaignTab teamId={props.campaignCfg.teamId} boatId={props.campaignCfg.boatId} role={props.effectiveRole} config={props.campaignCfg} isMobile={true} onOpenVideo={props.openVideoModal}/></ErrorBoundary>
          </div>
        )}

        {/* Boat config (read-only viewer) */}
        {activeTab==="boatconfig"&&props.campaignOn&&props.campaignCfg&&props.canSeeBoatConfig&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Boat config"><BoatConfigTab teamId={props.campaignCfg.teamId} boatId={props.campaignCfg.boatId} role={props.effectiveRole} config={props.campaignCfg} isMobile={true} sessionTzOffset={props.sessionTzOffset}/></ErrorBoundary>
          </div>
        )}

        {/* Weather — wind-analysis tool, available to all roles (sub-features gated by role inside). */}
        {activeTab==="weather"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Weather"><WeatherTab isMobile={true} effectiveRole={props.effectiveRole} boatName={props.campaignCfg?.boatName || props.activeMem?.boat_name} eventName={props.campaignCfg?.event} logData={props.logData} teamId={props.campaignCfg?.teamId} boatId={props.campaignCfg?.boatId} targetDate={props.campaignCfg?.targetDate}/></ErrorBoundary>
          </div>
        )}
        {activeTab==="timeline"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Timeline"><TimelineTab teamId={props.campaignCfg?.teamId||props.activeMem?.team_id} boatId={props.campaignCfg?.boatId||props.activeMem?.boat_id} tzOffset={props.sessionTzOffset} onOpenVideo={props.openVideoModal}/></ErrorBoundary>
          </div>
        )}

        {/* Tagging */}
        {activeTab==="tagger"&&(
          <div style={{position:"absolute",inset:0,overflow:"hidden",zIndex:2}}>
            <ErrorBoundary label="Tagging"><TaggerTab
              teamId={props.campaignCfg?.teamId||props.activeMem?.team_id}
              boatId={props.campaignCfg?.boatId||props.activeMem?.boat_id}
              date={props.activeDate}
              userId={props.myUid}
              tzOffsetMin={props.sessionTzOffset}
              logRows={props.logData?.rows}
              xml={props.xmlData}
              playheadUtc={props.playUtc}
              sessions={props.sessions}
              onSelectDate={props.onSelectDate}
              onEditSailList={()=>setActiveTab("campaign")}
            /></ErrorBoundary>
          </div>
        )}

        {/* Admin */}
        {activeTab==="admin"&&(
          <div style={{position:"absolute",inset:0,overflowY:"auto",padding:"16px 14px",zIndex:2}}>
            <div style={{fontSize:15,fontWeight:600,marginBottom:16}}>Admin</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {[
                {title:"Data tiers",items:["Tier 1: IndexedDB (local)","Tier 2: Bunny Cloud (R2+Stream)",`Unsynced: ${props.unsyncedCount}`]},
                {title:"Cloud",items:[`Storage: ${props.cloudStatus?.storage?"✓":"—"}`,`Stream: ${props.cloudStatus?.stream?"✓":"—"}`]},
              ].map(c=>(
                <div key={c.title} style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:14}}>
                  <div style={{fontSize:12,fontWeight:600,color:"#64748B",marginBottom:8}}>{c.title}</div>
                  {c.items.map((item,i)=><div key={i} style={{fontSize:12,color:"#334155",padding:"4px 0",borderBottom:"1px solid #0F2030"}}>{item}</div>)}
                </div>
              ))}
              {/* Storage management */}
              <div style={{background:"#0A1929",border:"1px solid #EF444430",borderRadius:10,padding:14}}>
                <div style={{fontSize:12,fontWeight:600,color:"#EF4444",marginBottom:10}}>Storage</div>
                <button onClick={()=>{
                  const all=JSON.parse(localStorage.getItem("ssa:sessions")||"[]");
                  const valid=all.filter(s=>{const y=parseInt((s.date||"").slice(0,4));return y>=2000&&y<=2100;});
                  localStorage.setItem("ssa:sessions",JSON.stringify(valid));
                  props.setSessions(valid);
                  alert(`Removed ${all.length-valid.length} bad sessions.`);
                }} style={{width:"100%",background:"#EF444415",border:"1px solid #EF444440",
                  borderRadius:8,padding:"12px",color:"#EF4444",fontSize:14,cursor:"pointer",marginBottom:8}}>
                  🗑 Remove bad-date sessions
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom tab bar ────────────────────────────────────────────────── */}
      <nav className="ssa-mob-bottom-nav" style={{background:"#050E1C",
        borderTop:"1px solid #1E3A5A",display:"flex",flexShrink:0,zIndex:50}}>
        {tabDefs.map(({id,icon,label})=>{
          const active=activeTab===id;
          const badge=id==="upload"&&props.unsyncedCount>0?props.unsyncedCount:null;
          return(
            <button key={id} onClick={()=>setActiveTab(id)}
              style={{flex:1,minWidth:0,background:"none",border:"none",cursor:"pointer",
                padding:"8px 2px 6px",display:"flex",flexDirection:"column",
                alignItems:"center",gap:2,color:active?"#06B6D4":"#475569",
                position:"relative",minHeight:52,overflow:"hidden"}}>
              <span style={{fontSize:20,lineHeight:1}}>{icon}</span>
              <span style={{fontSize:10,fontWeight:active?700:400,maxWidth:"100%",
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>
              {badge&&<span style={{position:"absolute",top:4,right:"calc(50% - 16px)",
                background:"#F59E0B",color:"#000",borderRadius:8,
                padding:"0 5px",fontSize:9,fontWeight:800}}>{badge}</span>}
              {active&&<div style={{position:"absolute",bottom:0,left:"20%",right:"20%",
                height:2,background:"#06B6D4",borderRadius:1}}/>}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
