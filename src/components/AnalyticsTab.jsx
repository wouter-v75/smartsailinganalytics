'use client'
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getActiveMembership } from '../lib/active-membership';
import { fetchDayTags } from '../lib/dayTags';
import { hasOpenableData } from '../lib/hasOpenableData';
import { venueTodayIso as TODAY } from '../lib/localStore';
import { nearestRow } from '../lib/logRowLookup';
import { loadPolarFromLS, polarVMGTarget } from '../lib/polarCalc';
import { effectiveGuns, finishNote, finishesFromTags, raceOptions, saveFinishTag } from '../lib/raceSelect';
import { extractBoatLengthM } from '../lib/sailMath';
import { getUidFast } from '../lib/supabase/browser';
import { addSection, inSections, removeSection, sectionLabel, sectionsSpan } from '../lib/trackSections';
import { GPSTrackMap } from './GPSTrackMap';
import { loadSquadTracks } from '../lib/squadTracks';
import PerfChartsSection from './analytics/PerfChartsSection';
import { LineChart } from './charts/LineChart';
import { ManoeuvreChart } from './charts/ManoeuvreChart';
import { PerfChart } from './charts/PerfChart';
import { useTz } from './ssa/TzContext';
import { EMPTY, TACK_COLORS } from './ssa/constants';
import { R, hmLocal, hmsLocal } from './ssa/format';

// ─── ANALYTICS TAB ────────────────────────────────────────────────────────────
function AnalyticsTab({logData,xmlData,allVideos,sessions,selectedVideo,onSelectVideo,setActiveTab,activeDate,onSelectDate,playUtc=null,visible=true,photos=[],canUseAI=true,canSeeAnalyticsData=true,onPlayClip=null}){
  const tz=useTz();
  // `logData?.rows||[]` handed every memo below a brand-new [] on the renders where
  // there is no log, so each one recomputed on every render. EMPTY is one array.
  const rows=logData?.rows||EMPTY;
  const noData=!rows.length;
  const step=Math.max(1,Math.floor(rows.length/400));
  // The three series used to be three unmemoised filter+map pairs — six full passes
  // over the log on EVERY render, and playUtc ticks this component through a render
  // per frame while a clip plays. A 10 Hz lidar day is ~200k rows. One walk, memoised
  // on the log, decimated by `step` to the ~400 points the charts can actually draw.
  const {twsPts,sogPts,heelPts}=useMemo(()=>{
    const tws=[],sog=[],heel=[];
    for(let i=0;i<rows.length;i+=step){
      const r=rows[i];
      tws.push({x:r.utc,y:r.tws});
      sog.push({x:r.utc,y:r.sog});
      heel.push({x:r.utc,y:Math.abs(r.heel)});
    }
    return {twsPts:tws,sogPts:sog,heelPts:heel};
  },[rows,step]);

  // Shared pan/zoom state for all timeseries — null = show full session
  const [viewRange, setViewRange] = useState(null);
  // A stretch picked on the GPS track ([utc0, utc1]); null = whole session. The cards,
  // time series, performance charts and tack sections below all follow it.
  // Several stretches at once: "which of these was better" is the question people
  // bring to a track, and one selection cannot answer it.
  const [sections, setSections] = useState([]);
  const selectSection = r => {
    const next = addSection(sections, r);
    setSections(next);
    setViewRange(sectionsSpan(next));
  };
  const dropSection = id => {
    const next = removeSection(sections, id);
    setSections(next);
    setViewRange(sectionsSpan(next));
  };
  const clearSections = () => { setSections([]); setViewRange(null); };

  // ── The day's tags, mirrored from the Tagger tab ───────────────────────────
  // Same source, same labels, same colours: two names for one moment is two
  // moments as far as a reader is concerned.
  const [tagBoat, setTagBoat] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const uid = await getUidFast();
        const m = uid ? getActiveMembership(uid) : null;
        if (alive && m?.team_id && m?.boat_id) setTagBoat({ teamId: m.team_id, boatId: m.boat_id, role: m.role || null });
      } catch { /* not signed in */ }
    })();
    return () => { alive = false; };
  }, []);
  const [dayTagEvents, setDayTagEvents] = useState([]);
  const [finishTags, setFinishTags] = useState([]);
  const loadDayTags = useCallback(async () => {
    if (!tagBoat || !activeDate) { setDayTagEvents([]); setFinishTags([]); return; }
    const events = await fetchDayTags(tagBoat.teamId, tagBoat.boatId, activeDate);
    setDayTagEvents(events);
    setFinishTags(finishesFromTags(events));
  }, [tagBoat, activeDate]);
  useEffect(() => { loadDayTags(); }, [loadDayTags]);
  // Coming back from the Tagger tab: a start deleted there changes which races this day
  // has, and the charts should not keep showing a race somebody has just said was not
  // one. Re-reading on the way in is cheap and needs nobody to remember a refresh.
  useEffect(() => { if (visible) loadDayTags(); }, [visible, loadDayTags]);

  // ── Races, and whether their finishes are known or guessed ─────────────────
  // The starts come from the tagger when it has any: somebody deleting a start there —
  // a general recall, another class's gun the file recorded anyway — must remove that
  // race from the charts and the map too, not just from the tagger.
  const dayGuns = useMemo(() => effectiveGuns(xmlData, dayTagEvents), [xmlData, dayTagEvents]);
  const xmlForRaces = useMemo(
    () => (xmlData ? { ...xmlData, raceGuns: dayGuns } : xmlData), [xmlData, dayGuns]);

  const races = useMemo(() => raceOptions({
    guns: dayGuns, markRoundings: xmlData?.markRoundings,
    dayStartUtc: xmlData?.dayStartUtc, dayStopUtc: xmlData?.dayStopUtc,
    dataT0: rows[0]?.utc ?? null, dataT1: rows[rows.length - 1]?.utc ?? null,
  }, finishTags), [xmlData, dayGuns, rows, finishTags]);
  const [raceKey, setRaceKey] = useState('');
  const race = races.find(r => r.key === raceKey) || null;
  const [finishDraft, setFinishDraft] = useState(null);   // where the finish marker sits
  const [finishMsg, setFinishMsg] = useState(null);

  // Called when the map's race filter changes. Choosing a race does not narrow the
  // charts on its own — the map offers a button for that — but it does decide whose
  // finish we are talking about.
  const pickRace = useCallback(key => {
    const r = races.find(x => x.key === key) || null;
    setRaceKey(r ? key : '');
    setFinishMsg(null);
    // A race whose finish nobody has tagged opens with the marker on the best guess.
    setFinishDraft(r && !r.hasFinish ? r.suggestedFinish : null);
  }, [races]);

  const saveFinish = async () => {
    if (!tagBoat || !activeDate || finishDraft == null) return;
    setFinishMsg({ state: 'busy', text: 'Saving the finish…' });
    const res = await saveFinishTag(tagBoat.teamId, tagBoat.boatId, activeDate, finishDraft);
    if (!res.ok) { setFinishMsg({ state: 'error', text: res.error }); return; }
    setFinishMsg({ state: 'ok', text: 'Finish tag saved — every screen now ends this race there' });
    setFinishDraft(null);
    await loadDayTags();
  };
  // Tacking analysis — highlighted tack index (null = none selected)
  const [selectedTackIdx, setSelectedTackIdx] = useState(null);
  // Performance charts → jump to a phase: open the clip that covers it (as the GPS
  // track does), otherwise zoom the time series onto the phase and scroll to it.
  const timeseriesRef = useRef(null);
  const jumpToUtc = utc => {
    const clip=(allVideos||[]).find(v=>v.startUtc&&v.duration&&utc>=v.startUtc&&utc<=v.startUtc+v.duration*1000);
    if(clip){ if(onPlayClip){ onPlayClip(clip); return; } onSelectVideo(clip); setActiveTab("library"); return; }
    if(!rows.length) return;
    setViewRange([Math.max(rows[0].utc,utc-120000),Math.min(rows[rows.length-1].utc,utc+150000)]);
    timeseriesRef.current?.scrollIntoView({behavior:"smooth",block:"start"});
  };
  // Reset view when the session changes
  useEffect(()=>{ setViewRange(null); setSections([]); }, [activeDate]);

  // ── The rest of the squad on the same day ────────────────────────────────
  // A dinghy squad trains together and nearly every question is comparative, so
  // the other boats' tracks are loaded beside the active one. RLS decides what
  // comes back, and a boat with no session that day is simply absent.
  const [squadTracks,setSquadTracks]=useState([]);
  useEffect(()=>{
    if(!tagBoat?.teamId||!activeDate){ setSquadTracks([]); return; }
    let alive=true;
    loadSquadTracks({ teamId:tagBoat.teamId, date:activeDate, excludeBoatId:tagBoat.boatId })
      .then(t=>{ if(alive) setSquadTracks(t); })
      .catch(()=>{ if(alive) setSquadTracks([]); });
    return()=>{ alive=false; };
  }, [tagBoat?.teamId, tagBoat?.boatId, activeDate]);
  // Auto-zoom to video clip range when video is selected and has a start time.
  // Depends on both selectedVideo?.id AND activeDate so it re-fires when a new
  // session is loaded (rows might have been empty on the previous render).
  useEffect(()=>{
    if(selectedVideo?.startUtc && selectedVideo?.duration && rows.length){
      const padMs = selectedVideo.duration * 1000 * 0.15; // 15% padding either side
      const nx0 = selectedVideo.startUtc - padMs;
      const nx1 = selectedVideo.startUtc + selectedVideo.duration * 1000 + padMs;
      const allX0 = rows[0].utc, allX1 = rows[rows.length-1].utc;
      // Only zoom if the clip is narrower than the full session
      if(nx0 > allX0 || nx1 < allX1){
        setViewRange([Math.max(allX0, nx0), Math.min(allX1, nx1)]);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVideo?.id, activeDate]);
  const chartEvents = useMemo(()=>xmlData ? [
    ...(xmlData.markRoundings||[]).filter(m=>m.isValid!==false).map(m=>({utc:m.utc,label:m.isTop?"⬆ top":"⬇ gate",color:m.isTop?"#EF4444":"#8B5CF6"})),
    ...(xmlData.raceGuns||[]).map(g=>({utc:g.utc,label:"🚩 start",color:"#EF4444"})),
    ...(xmlData.tackJibes||[]).filter(t=>t.isValid!==false).map(t=>({utc:t.utc,label:t.isTack?"T":"G",color:t.isTack?"#1D9E75":"#7F77DD"})),
  ] : EMPTY, [xmlData]);
  // Cards and tack/mark counts follow the track selection. Memoised: without it this
  // walked the whole log on every render — including the playback renders driven by
  // playUtc, which cannot change the answer.
  const sr=useMemo(()=>sections.length?rows.filter(r=>inSections(r.utc,sections)):rows,[rows,sections]);
  const selTJ=(xmlData?.tackJibes||[]).filter(t=>inSections(t.utc,sections));
  const selMarks=(xmlData?.markRoundings||[]).filter(m=>inSections(m.utc,sections));
  // Only rows that carry the channel: one row without TWS/SOG (a logger dropout, or a
  // column the cloud copy left out) used to turn the sum and the max into NaN → "--".
  // Loops, not Math.max(...arr): a 4 h log at 1 Hz is past the spread-argument limit.
  const statOf=k=>{let s=0,n=0,mx=-Infinity;for(const r of sr){const v=r[k];if(typeof v==="number"&&Number.isFinite(v)){s+=v;n++;if(v>mx)mx=v;}}return n?{avg:s/n,max:mx}:{avg:null,max:null};};
  const twsStat=statOf("tws"), sogStat=statOf("sog");
  const twsAvg=twsStat.avg, twsMax=twsStat.max, sogAvg=sogStat.avg, sogMax=sogStat.max;
  const vsTargRows=sr.filter(r=>r.vsTargPct>5&&r.vsTargPct<200);
  const vsTargAvg=vsTargRows.length?vsTargRows.reduce((s,r)=>s+r.vsTargPct,0)/vsTargRows.length:null;
  const vsPerfRows=sr.filter(r=>r.vsPerfPct>5&&r.vsPerfPct<200);
  const vsPerfAvg=vsPerfRows.length?vsPerfRows.reduce((s,r)=>s+r.vsPerfPct,0)/vsPerfRows.length:null;
  const tacks=selTJ.filter(t=>t.isTack&&t.isValid!==false).length;
  const gybes=selTJ.filter(t=>!t.isTack&&t.isValid!==false).length;
  const marks=selMarks.filter(m=>m.isValid!==false).length;
  const topMarks=selMarks.filter(m=>m.isTop&&m.isValid!==false).length;
  const durationH=rows.length?(rows[rows.length-1].utc-rows[0].utc)/3600000:0;

  // Live row at current playback position
  const liveRow = playUtc && rows.length ? nearestRow(rows, playUtc) : null;
  const liveActive = liveRow && Math.abs(liveRow.utc - (playUtc||0)) < 60000;

  const card=(label,val,unit,color)=>(<div style={{background:"#0A1929",border:`1px solid ${color}25`,borderRadius:8,padding:"10px 12px",minWidth:0,overflow:"hidden"}}><div style={{fontSize:9,color:"#334155",letterSpacing:1,textTransform:"uppercase",marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{label}</div><div style={{fontSize:20,fontWeight:700,color,fontFamily:"monospace",whiteSpace:"nowrap"}}>{val}<span style={{fontSize:11,color:"#475569",marginLeft:3}}>{unit}</span></div></div>);
  const section=(title,children)=>(<div style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:"14px 16px",marginBottom:14}}><div style={{fontSize:11,fontWeight:600,color:"#64748B",letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>{title}</div>{children}</div>);
  // ── Prominent session date header ────────────────────────────────────────────
  // Analytics previously buried the session date inside a dense status pill,
  // which on mobile wrapped awkwardly and left users unsure which day they
  // were looking at. We surface the date, day-of-week and location/boat (from
  // event XML meta) in a clear banner at the top of the tab.
  const sessionDateLabel=(()=>{
    if(!activeDate) return "No session loaded";
    const [y,m,d]=activeDate.split("-").map(Number);
    if(!y||!m||!d) return activeDate;
    const dt=new Date(Date.UTC(y,m-1,d));
    const today=TODAY();
    const yesterday=(()=>{const t=new Date();t.setDate(t.getDate()-1);return t.toISOString().slice(0,10);})();
    const dayNames=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const monthNames=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const rel=activeDate===today?"Today":activeDate===yesterday?"Yesterday":null;
    const long=`${dayNames[dt.getUTCDay()]} ${d} ${monthNames[m-1]} ${y}`;
    return rel?`${rel} · ${long}`:long;
  })();
  const sessionMeta=xmlData?.meta||{};
  // Days that can be opened from the banner, oldest first (◀ = earlier day).
  const openable=(sessions||[]).filter(s=>hasOpenableData(s)&&s.date<=TODAY()).sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
  const dateIdx=openable.findIndex(s=>s.date===activeDate);
  // Nearest day with data either side — also when the open day isn't in the list (a future
  // plan day, or one with nothing loaded yet).
  const prevDate=activeDate?[...openable].reverse().find(s=>s.date<activeDate)?.date:openable[openable.length-1]?.date;
  const nextDate=activeDate?openable.find(s=>s.date>activeDate)?.date:null;
  const dateNavBtn=on=>({background:"#071624",border:"1px solid #1E3A5A",borderRadius:6,padding:"6px 9px",minHeight:32,fontSize:11,
    color:on?"#06B6D4":"#334155",cursor:on?"pointer":"default"});

  return(
    <div style={{flex:1,overflowY:"auto",padding:16}}>
      <div style={{maxWidth:900,margin:"0 auto"}}>
        {/* ── Session banner: clear, always-visible date indicator ─────── */}
        <div style={{background:"linear-gradient(90deg,#0A1929 0%,#0F2A45 100%)",
          border:"1px solid #06B6D440",borderRadius:10,padding:"10px 14px",marginBottom:12,
          display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div style={{fontSize:18,lineHeight:1}}>📅</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:10,color:"#64748B",letterSpacing:1.5,textTransform:"uppercase",fontWeight:600}}>Session</div>
            <div style={{fontSize:15,fontWeight:700,color:"#E2E8F0",marginTop:1,
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {sessionDateLabel}
            </div>
            {(sessionMeta.location||sessionMeta.boat||sessionMeta.dayType)&&(
              <div style={{fontSize:11,color:"#7DD3FC",marginTop:2,
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {[sessionMeta.location,sessionMeta.boat,sessionMeta.dayType].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
          {onSelectDate&&openable.length>0?(
            // Open another day right here — previous / next session, or pick from the list.
            <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0,maxWidth:"100%"}}>
              <button aria-label="Previous session" title={prevDate||""} disabled={!prevDate} onClick={()=>prevDate&&onSelectDate(prevDate)} style={dateNavBtn(!!prevDate)}>◀</button>
              <select aria-label="Open session date" value={dateIdx<0?"":activeDate} onChange={e=>e.target.value&&onSelectDate(e.target.value)}
                style={{background:"#06B6D420",border:"1px solid #06B6D460",borderRadius:6,padding:"6px 8px",color:"#E2E8F0",
                  fontSize:12,fontWeight:600,cursor:"pointer",minHeight:32,minWidth:0,maxWidth:"60vw"}}>
                {dateIdx<0&&<option value="">Open a date…</option>}
                {[...openable].reverse().map(s=>(
                  <option key={s.date} value={s.date}>
                    {s.date===TODAY()?"Today · ":""}{s.date}{s.hasLog?" · log":""}{s.hasXml?" · events":""}{s.videoCount?` · ${s.videoCount} clips`:""}
                  </option>
                ))}
              </select>
              <button aria-label="Next session" title={nextDate||""} disabled={!nextDate} onClick={()=>nextDate&&onSelectDate(nextDate)} style={dateNavBtn(!!nextDate)}>▶</button>
            </div>
          ):(
            <button onClick={()=>setActiveTab(onPlayClip?"upload":"library")}
              style={{background:"#06B6D420",border:"1px solid #06B6D460",borderRadius:6,
                padding:"6px 12px",color:"#06B6D4",cursor:"pointer",fontSize:11,fontWeight:600,
                flexShrink:0,minHeight:32}}>
              Change
            </button>
          )}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
          <div style={{fontSize:15,fontWeight:600,color:"#E2E8F0"}}>Analytics</div>
          {logData&&<span style={{fontSize:10,color:logData.source==="local"?"#1D9E75":"#8B5CF6",background:logData.source==="local"?"#1D9E7510":"#8B5CF610",border:`1px solid ${logData.source==="local"?"#1D9E7530":"#8B5CF630"}`,borderRadius:3,padding:"2px 7px"}}>{logData.source==="local"?"● Local":"● Cloud"} · {rows.length.toLocaleString()} rows · {durationH.toFixed(1)}h</span>}
          {xmlData ? (
            <span style={{fontSize:10,color:"#8B5CF6",background:"#8B5CF610",border:"1px solid #8B5CF630",borderRadius:3,padding:"2px 7px"}}>
              ● Events · {(xmlData.tackJibes||[]).length} T/G · {(xmlData.markRoundings||[]).length} marks · {(xmlData.raceGuns||[]).length} guns · {(xmlData.sailsUpEvents||[]).length} sail chg
            </span>
          ) : (
            <span style={{fontSize:10,color:"#F59E0B",background:"#F59E0B10",border:"1px solid #F59E0B30",borderRadius:3,padding:"2px 7px"}}>
              ⚠ No event file — {onPlayClip?"pick another day above, or re-import the XML in Upload":"select session in Videos or re-import XML"}
            </span>
          )}
          {!logData&&<span style={{fontSize:10,color:"#EF4444"}}>No log data loaded — pick a date above</span>}
        </div>

        {/* ── Now Playing bar — live instrument data from video ── */}
        {liveActive&&(
          <div style={{background:"#0A1929",border:"1px solid #F59E0B40",borderRadius:10,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <span style={{fontSize:9,color:"#F59E0B",fontWeight:700,letterSpacing:1,textTransform:"uppercase",flexShrink:0}}>▶ Now playing</span>
            <span style={{fontSize:11,fontFamily:"monospace",color:"#94A3B8"}}>{hmsLocal(playUtc,tz)}</span>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {[["TWS",liveRow.tws,"kn","#7DD3FC"],["TWA",liveRow.twa,"°","#7DD3FC"],["BSP",liveRow.bsp,"kn","#10B981"],["SOG",liveRow.sog,"kn","#FBBF24"],["VMG",liveRow.vmg,"kn","#22C55E"],["Heel",liveRow.heel,"°","#F97316"]].map(([l,v,u,c])=>(
                <div key={l} style={{display:"flex",alignItems:"baseline",gap:3}}>
                  <span style={{fontSize:9,color:"#334155"}}>{l}</span>
                  <span style={{fontSize:13,fontWeight:700,fontFamily:"monospace",color:c}}>{R(v,l==="TWA"||l==="Heel"?0:1)}</span>
                  <span style={{fontSize:9,color:"#475569"}}>{u}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {noData ? (
          <div style={{textAlign:"center",padding:"50px 20px",color:"#334155"}}>
            <div style={{fontSize:32,marginBottom:12,opacity:0.3}}>📊</div>
            <div style={{fontSize:13,color:"#475569",marginBottom:6}}>No log data loaded</div>
            <div style={{fontSize:11,color:"#334155",marginBottom:16}}>{openable.length?"Pick a date in the session bar above (◀ ▶ or the list) to load its log and event data.":(onPlayClip?"Import a session in the Upload tab — its log and event data load from there.":"Select a session in the Library sidebar — click any date to load its log and event data.")}</div>
            <div style={{display:"flex",gap:8,justifyContent:"center"}}>
              <button onClick={()=>setActiveTab(onPlayClip?"timeline":"library")} style={{background:"#06B6D4",border:"none",borderRadius:8,padding:"8px 20px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>{onPlayClip?"Go to Timeline":"Go to Videos"}</button>
              <button onClick={()=>setActiveTab("upload")} style={{background:"#1E3A5A",border:"none",borderRadius:8,padding:"8px 20px",color:"#94A3B8",fontWeight:700,cursor:"pointer",fontSize:12}}>Re-import CSV</button>
            </div>
          </div>
        ) : (
          <>
            {canSeeAnalyticsData && (
              <>
                {sections.length>0&&(
                  <div style={{fontSize:10,color:"#94A3B8",marginBottom:6,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <span>Cards, charts and tacks below show {sections.length===1?"this stretch":"these stretches"}:</span>
                    {sections.map(sec=>(
                      <span key={sec.id} style={{display:"inline-flex",alignItems:"center",gap:6,border:`1px solid ${sec.color}66`,
                        background:`${sec.color}14`,borderRadius:999,padding:"2px 4px 2px 8px",color:"#E2E8F0"}}>
                        <span style={{width:9,height:9,borderRadius:2,background:sec.color,display:"inline-block"}} aria-hidden />
                        {sectionLabel(sec)} · {hmLocal(sec.range[0],tz)}–{hmLocal(sec.range[1],tz)}
                        <button onClick={()=>dropSection(sec.id)} aria-label={`Remove ${sectionLabel(sec)}`}
                          style={{background:"none",border:"none",color:"#94A3B8",cursor:"pointer",fontSize:12,lineHeight:1,padding:"0 3px"}}>×</button>
                      </span>
                    ))}
                    <button onClick={clearSections} style={{background:"none",border:"1px solid #06B6D440",borderRadius:4,padding:"2px 8px",color:"#06B6D4",cursor:"pointer",fontSize:10}}>↩ Whole session</button>
                  </div>
                )}
                {/* auto-fit, not repeat(4,1fr). A `1fr` track will not shrink
                    below its content's min-content width, so on a phone the
                    four cards demanded ~100px each, the row grew past the
                    screen and the fourth card was cut off mid-number. auto-fit
                    with a 132px floor drops to two columns when the screen is
                    narrow and — because each row holds exactly four cards —
                    still lays out four across wherever there is room, so the
                    desktop is unchanged. */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(132px,1fr))",gap:10,marginBottom:14}}>
                  {card("Avg TWS",R(twsAvg),"kn","#7DD3FC")}
                  {card("Max TWS",R(twsMax),"kn","#7DD3FC")}
                  {card("Avg SOG",R(sogAvg),"kn","#FBBF24")}
                  {card("Max SOG",R(sogMax),"kn","#FBBF24")}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(132px,1fr))",gap:10,marginBottom:14}}>
                  {card("Tacks",tacks,"","#1D9E75")}
                  {card("Gybes",gybes,"","#7F77DD")}
                  {card("Polar %",vsPerfAvg?R(vsPerfAvg)+"%":"--","","#F59E0B")}
                  {card("Target %",vsTargAvg?R(vsTargAvg)+"%":"--","","#EF4444")}
                </div>
              </>
            )}
            {section("GPS track",(
              rows.length > 0 ? (
                <GPSTrackMap rows={rows} videoStartUtc={selectedVideo?.startUtc||null} videoDurationSec={selectedVideo?.duration||0} xmlData={xmlForRaces} syncOffset={0} playUtc={playUtc} visible={visible} allVideos={allVideos} onSelectVideo={onSelectVideo} onSwitchTab={setActiveTab} onPlayClip={onPlayClip} photos={photos} sections={sections} onSelection={selectSection} onRemoveSection={dropSection} onClearSections={clearSections}
                  dayTags={dayTagEvents} onRaceChosen={pickRace} squadTracks={squadTracks}
                  finishDraft={finishDraft} onFinishDraft={setFinishDraft} onSaveFinish={saveFinish}
                  finishNote={finishNote(race)} finishMsg={finishMsg} canTagFinish={!!tagBoat}/>
              ) : (
                <div style={{padding:12,background:"#071624",borderRadius:8,color:"#F59E0B",fontSize:10}}>Load a session with GPS data — {onPlayClip?"pick a date in the session bar above":"select a date in the Library first"}.</div>
              )
            ))}
            {canSeeAnalyticsData && <div ref={timeseriesRef} style={{scrollMarginTop:12}}/>}
            {canSeeAnalyticsData && section("Wind & boat speed · heel · performance",(
              <>
                {/* ── Zoom / pan control bar ─────────────────────────────── */}
                {rows.length>0&&(()=>{
                  const allX0=rows[0].utc, allX1=rows[rows.length-1].utc;
                  const fullSpan=allX1-allX0||1;
                  const [vx0,vx1]=viewRange??[allX0,allX1];
                  const span=vx1-vx0;
                  const fmtUTC=u=>hmLocal(u,tz);
                  const fmtSpan=ms=>{const m=Math.round(ms/60000);return m>=60?`${Math.floor(m/60)}h ${m%60}m`:`${m}m`;};
                  const zoom=(factor,center)=>{
                    const [cvx0,cvx1]=viewRange??[allX0,allX1];
                    const s=cvx1-cvx0;
                    const pivot=center??((cvx0+cvx1)/2);
                    const frac=(pivot-cvx0)/s;
                    const newSpan=Math.max(60000,Math.min(fullSpan,s*factor));
                    let nx0=pivot-frac*newSpan, nx1=nx0+newSpan;
                    if(nx0<allX0){nx0=allX0;nx1=allX0+newSpan;}
                    if(nx1>allX1){nx1=allX1;nx0=allX1-newSpan;}
                    setViewRange(newSpan>=fullSpan*0.999?null:[nx0,nx1]);
                  };
                  const pan=dir=>{
                    const [cvx0,cvx1]=viewRange??[allX0,allX1];
                    const s=cvx1-cvx0;
                    const shift=s*0.25*dir;
                    let nx0=cvx0+shift, nx1=cvx1+shift;
                    if(nx0<allX0){nx0=allX0;nx1=allX0+s;}
                    if(nx1>allX1){nx1=allX1;nx0=allX1-s;}
                    setViewRange([nx0,nx1]);
                  };
                  const btnStyle={background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:5,padding:"3px 9px",color:"#94A3B8",cursor:"pointer",fontSize:11,fontFamily:"monospace",lineHeight:1.4};
                  const clipStart=selectedVideo?.startUtc;
                  const clipEnd=clipStart?(clipStart+(selectedVideo?.duration||0)*1000):null;
                  return(
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12,flexWrap:"wrap"}}>
                      <button style={btnStyle} onClick={()=>pan(-1)} title="Pan left 25%">◀</button>
                      <button style={btnStyle} onClick={()=>zoom(1/2)} title="Zoom in 2×">＋</button>
                      <button style={btnStyle} onClick={()=>zoom(2)} title="Zoom out 2×">－</button>
                      <button style={btnStyle} onClick={()=>pan(1)} title="Pan right 25%">▶</button>
                      {viewRange&&<button onClick={()=>setViewRange(null)} style={{...btnStyle,color:"#06B6D4",borderColor:"#06B6D440"}}>↩ Full session</button>}
                      {clipStart&&clipEnd&&<button onClick={()=>{ const pad=(clipEnd-clipStart)*0.15; setViewRange([Math.max(allX0,clipStart-pad),Math.min(allX1,clipEnd+pad)]); }} style={{...btnStyle,color:"#F59E0B",borderColor:"#F59E0B40"}}>▶ Clip window</button>}
                      <div style={{flex:1}}/>
                      <span style={{fontSize:9,color:"#475569",fontFamily:"monospace"}}>
                        {viewRange?`${fmtUTC(vx0)} – ${fmtUTC(vx1)} UTC · ${fmtSpan(span)}`:`Full session · ${fmtSpan(fullSpan)}`}
                      </span>
                      <span style={{fontSize:9,color:"#334155"}}>scroll to zoom · drag to pan</span>
                    </div>
                  );
                })()}
                {/* ── Charts row 1: TWS + SOG ─────────────────────────────── */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                  <div>
                    <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>TRUE WIND SPEED (kn)</div>
                    <LineChart sections={sections} points={twsPts} color="#7DD3FC" height={110} yLabel="TWS kn" showTrend events={chartEvents} playUtc={playUtc} viewRange={viewRange} onViewRange={setViewRange}/>
                  </div>
                  <div>
                    <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>SPEED OVER GROUND (kn)</div>
                    <LineChart sections={sections} points={sogPts} color="#FBBF24" height={110} yLabel="SOG kn" showTrend events={chartEvents} playUtc={playUtc} viewRange={viewRange} onViewRange={setViewRange}/>
                  </div>
                </div>
                {/* ── Charts row 2: Heel + Polar % ─────────────────────────── */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <div>
                    <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>HEEL ANGLE (°)</div>
                    <LineChart sections={sections} points={heelPts} color="#F97316" height={110} yLabel="Heel °" showTrend events={chartEvents} playUtc={playUtc} viewRange={viewRange} onViewRange={setViewRange}/>
                  </div>
                  <div>
                    <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>POLAR % &amp; TARGET %</div>
                    <PerfChart rows={rows} sections={sections} height={110} viewRange={viewRange} onViewRange={setViewRange} playUtc={playUtc}/>
                  </div>
                </div>
              </>
            ))}
            {canSeeAnalyticsData && rows.length>50&&section("Performance charts — 30 s phases",(
              <PerfChartsSection sections={sections} trackRaceNum={race?.raceNum ?? null} rows={rows} xmlData={xmlForRaces} tzOffsetMin={tz} playUtc={playUtc} onJump={jumpToUtc} activeDate={activeDate} canUseAI={canUseAI}/>
            ))}
            {canSeeAnalyticsData && selTJ.length>0&&section(`Manoeuvre analysis — ${selTJ.length} total${sections.length?(sections.length>1?" in the selected sections":" in the selection"):""}`,(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div><div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>MANOEUVRES BY WIND STRENGTH</div><ManoeuvreChart tackJibes={selTJ} logRows={rows} width={360} height={130}/></div>
                <div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:10,letterSpacing:1}}>MANOEUVRE BREAKDOWN</div>
                  {[["Valid tacks",tacks,"#1D9E75"],["Valid gybes",gybes,"#7F77DD"],["Top mark roundings",topMarks,"#EF4444"],["Leeward gates",marks-topMarks,"#8B5CF6"],["Invalid / flagged",(selTJ.length-tacks-gybes),"#475569"]].map(([label,val,color])=>(<div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid #0F2030"}}><span style={{fontSize:11,color:"#94A3B8"}}>{label}</span><span style={{fontSize:13,fontWeight:700,fontFamily:"monospace",color}}>{val}</span></div>))}
                </div>
              </div>
            ))}

            {/* ── Tacking analysis ──────────────────────────────────────────────── */}
            {(()=>{
              const validTacks=selTJ.filter(t=>t.isTack&&t.isValid!==false);
              if(!validTacks.length||!rows.length) return null;
              const PRE=30, POST=60; // seconds before/after tack

              // Build tack-aligned series: for each valid tack, extract a window of log rows
              // Returns [{relSec, value}] arrays — one per tack
              const buildSeries=(field,transform=(v)=>v)=>{
                return validTacks.map(tk=>{
                  // Binary-search nearest log row to tack UTC
                  let lo=0,hi=rows.length-1;
                  while(lo<hi){const mid=(lo+hi+1)>>1;if(rows[mid].utc<=tk.utc)lo=mid;else hi=mid-1;}
                  const centre=lo;
                  const window=[];
                  // Walk backwards PRE seconds
                  let i=centre;
                  while(i>=0&&(rows[centre].utc-rows[i].utc)<PRE*1000) i--;
                  i++;
                  // Walk forwards POST seconds
                  let j=centre;
                  while(j<rows.length&&(rows[j].utc-rows[centre].utc)<POST*1000) j++;
                  for(let k=i;k<j;k++){
                    const relSec=(rows[k].utc-tk.utc)/1000;
                    const v=transform(rows[k][field]);
                    if(v!=null&&!isNaN(v)) window.push({x:relSec,y:v});
                  }
                  return window;
                });
              };

              const tackPolar = loadPolarFromLS();
              const tackSeries={
                bsp:   buildSeries('bsp'),
                rudder:buildSeries('rudder',v=>v!=null?Math.abs(v):null),
                yawR:  buildSeries('yawR'),
                twa:   buildSeries('twa',v=>v!=null?Math.abs(v):null),
                vmgPct:buildSeries('vmg',v=>{
                  // placeholder — overwritten per-row below with polar context
                  return v;
                }),
              };
              // Rebuild vmgPct with polar context (needs tws per row, can't use buildSeries directly)
              tackSeries.vmgPct = validTacks.map(tk=>{
                let lo=0,hi=rows.length-1;
                while(lo<hi){const mid=(lo+hi+1)>>1;if(rows[mid].utc<=tk.utc)lo=mid;else hi=mid-1;}
                const centre=lo;
                const window=[];
                let i=centre; while(i>=0&&(rows[centre].utc-rows[i].utc)<PRE*1000) i--; i++;
                let j=centre; while(j<rows.length&&(rows[j].utc-rows[centre].utc)<POST*1000) j++;
                for(let k=i;k<j;k++){
                  const r=rows[k];
                  if(!tackPolar||!r.vmg||!r.tws) continue;
                  const tgt=polarVMGTarget(tackPolar,r.tws);
                  const optVMG=Math.abs(r.twa||0)<90?tgt.upVMG:tgt.downVMG;
                  if(!optVMG||optVMG<0.01) continue;
                  const pct=(r.vmg/optVMG)*100;
                  if(pct>10&&pct<200) window.push({x:(r.utc-tk.utc)/1000, y:pct});
                }
                return window;
              });

              // ── Cumulative VMG loss series ─────────────────────────────────────
              // Baseline VMG = mean of log rows from -60s to -20s before each tack.
              // Accumulated loss from t=-20s:
              //   cumLoss(t) = Σ (baseline_vmg − actual_vmg) × Δt  [knot·s]
              // Convert to boat lengths: cumLoss_m / boatLenM
              // Negative = boat briefly exceeded baseline (e.g. pumping into tack).
              // Positive = boat lost distance vs steady-state upwind sailing.
              const boatLenM = extractBoatLengthM(xmlData?.meta?.boat);
              const BASELINE_START=-60, BASELINE_END=-20;
              const LOSS_START=-20;

              const vmgLossSeries = validTacks.map(tk=>{
                // Binary-search tack centre
                let lo=0,hi=rows.length-1;
                while(lo<hi){const mid=(lo+hi+1)>>1;if(rows[mid].utc<=tk.utc)lo=mid;else hi=mid-1;}
                const centre=lo;

                // Walk back to BASELINE_START
                let bStart=centre;
                while(bStart>0&&(rows[centre].utc-rows[bStart].utc)<Math.abs(BASELINE_START)*1000) bStart--;
                // Walk back to BASELINE_END
                let bEnd=centre;
                while(bEnd>0&&(rows[centre].utc-rows[bEnd].utc)<Math.abs(BASELINE_END)*1000) bEnd--;

                // Baseline: mean VMG in [BASELINE_START, BASELINE_END]
                let bSum=0, bCount=0;
                for(let k=bStart;k<=bEnd;k++){
                  const v=rows[k].vmg;
                  if(v!=null&&!isNaN(v)&&v>0){bSum+=v;bCount++;}
                }
                if(!bCount) return []; // no baseline data → skip tack
                const baseVMG=bSum/bCount;

                // Walk to LOSS_START index
                let lStart=centre;
                while(lStart>0&&(rows[centre].utc-rows[lStart].utc)<Math.abs(LOSS_START)*1000) lStart--;

                // Walk to +POST seconds
                let lEnd=centre;
                while(lEnd<rows.length-1&&(rows[lEnd].utc-rows[centre].utc)<POST*1000) lEnd++;

                // Integrate (baseVMG - vmg) × dt from LOSS_START → POST
                let cumLossKnotSec=0;
                const pts=[{x:LOSS_START, y:0, baseVMG}];
                for(let k=lStart+1;k<=lEnd;k++){
                  const dt=(rows[k].utc-rows[k-1].utc)/1000; // seconds
                  if(dt<=0||dt>10) continue; // skip gaps > 10s
                  const vmg=rows[k].vmg??0;
                  cumLossKnotSec+=(baseVMG-vmg)*dt;
                  const cumLossBL=-(cumLossKnotSec*0.5144)/boatLenM; // negative = loss
                  const relSec=(rows[k].utc-tk.utc)/1000;
                  pts.push({x:relSec, y:cumLossBL, baseVMG});
                }
                // Final loss at +POST
                const finalBL=pts[pts.length-1]?.y??0;
                return Object.assign(pts, {baseVMG, finalBL});
              }).filter(s=>s.length>1);

              // TackChart — interactive linked chart
              // selectedTack: index of highlighted tack (null = all equal)
              // onTackClick(i): called when a tack line is clicked; null = deselect
              function TackChart({series,yLabel,color='#1D9E75',height=130,yLines=[],
                                  yMax:forcedYMax,yMin:forcedYMin,xMin:xMinProp,xMax:xMaxProp,
                                  selectedTack=null,onTackClick=null}){
                if(!series?.length||series.every(s=>!s.length)) return(
                  <div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#334155",fontSize:10}}>No data</div>
                );
                const VB_W=400;
                const pad={t:10,r:8,b:28,l:42};
                const W=VB_W-pad.l-pad.r, H=height-pad.t-pad.b;
                const xMin=xMinProp??-PRE, xMax=xMaxProp??POST;
                // Finite-only domain — one NaN sample makes Math.min/max NaN, which
                // turns every yTick <line> and series <path> into NaN coordinates.
                const allPts=series.flat().filter(p=>Number.isFinite(p.y));
                const rawYMin=allPts.length?Math.min(...allPts.map(p=>p.y)):0;
                const rawYMax=(allPts.length?Math.max(...allPts.map(p=>p.y)):1)||1;
                const yMin=forcedYMin!==undefined?forcedYMin:Math.min(0,rawYMin);
                const yMax=forcedYMax!==undefined?forcedYMax:Math.max(0,rawYMax)||1;
                const ySpan=yMax-yMin||1;
                const px=x=>pad.l+((x-xMin)/(xMax-xMin))*W;
                const py=y=>pad.t+H-((y-yMin)/ySpan)*H;
                const xTicks=[-60,-50,-40,-30,-20,-10,0,10,20,30,40,50,60].filter(x=>x>=xMin&&x<=xMax);
                const yRange=yMax-yMin;
                const yStep=yRange>20?5:yRange>8?2:yRange>4?1:yRange>1?0.5:0.2;
                const yTickMin=Math.ceil(yMin/yStep)*yStep;
                const yTicks=Array.from({length:Math.ceil((yMax-yTickMin)/yStep)+1},(_,i)=>yTickMin+i*yStep).filter(y=>y>=yMin&&y<=yMax);
                const hasSelection=selectedTack!=null;

                // Render order: unselected first, selected on top
                const renderOrder=[...series.keys()].filter(i=>i!==selectedTack);
                if(selectedTack!=null&&selectedTack<series.length) renderOrder.push(selectedTack);

                return(
                  <svg width="100%" viewBox={`0 0 ${VB_W} ${height}`} style={{overflow:"visible",display:"block",cursor:onTackClick?"pointer":"default"}}>
                    {/* Grid */}
                    {yTicks.map((y,i)=><line key={i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke={y===0?"#1E3A5A":"#0F2030"} strokeWidth={y===0?1.5:1}/>)}
                    {yLines.map((y,i)=><line key={'yl'+i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke={color} strokeWidth="0.5" strokeDasharray="4,3" opacity="0.6"/>)}
                    <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
                    <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
                    {/* Tack moment line */}
                    <line x1={px(0)} x2={px(0)} y1={pad.t} y2={pad.t+H} stroke="#EF4444" strokeWidth="1.5" strokeDasharray="4,2" opacity="0.8"/>
                    <text x={px(0)+3} y={pad.t+9} fontSize="8" fill="#EF4444">tack</text>
                    {xMin<=-20&&<line x1={px(-20)} x2={px(-20)} y1={pad.t} y2={pad.t+H} stroke="#475569" strokeWidth="0.8" strokeDasharray="3,3" opacity="0.5"/>}

                    {/* Lines rendered in order (selected last = on top) */}
                    {renderOrder.map(ti=>{
                      const pts=(series[ti]||[]).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
                      if(pts.length<2) return null;
                      const isSel=ti===selectedTack;
                      const c=TACK_COLORS[ti%TACK_COLORS.length];
                      const opacity=hasSelection?(isSel?1:0.15):0.75;
                      const sw=isSel?2.5:1.2;
                      const d=pts.map((p,i)=>`${i===0?'M':'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
                      return(
                        <g key={ti}>
                          {/* Visible line */}
                          <path d={d} fill="none" stroke={c} strokeWidth={sw} strokeLinejoin="round" opacity={opacity}/>
                          {/* Dot at endpoint for the loss chart (xMin=LOSS_START) */}
                          {xMin===LOSS_START&&pts.length>0&&(()=>{
                            const last=pts[pts.length-1];
                            return<circle cx={px(last.x)} cy={py(last.y)} r={isSel?5:3} fill={c} opacity={hasSelection?(isSel?1:0.2):0.8}/>;
                          })()}
                          {/* Invisible wide hit-zone for easy clicking */}
                          {onTackClick&&<path d={d} fill="none" stroke="transparent" strokeWidth="14"
                            style={{cursor:"pointer"}}
                            onClick={()=>onTackClick(isSel?null:ti)}/>}
                        </g>
                      );
                    })}

                    {/* Axes */}
                    {yTicks.map((y,i)=><text key={i} x={pad.l-4} y={py(y)+3} textAnchor="end" fontSize="8" fill={y===0?"#94A3B8":"#475569"}>{Number.isInteger(y)?y:y.toFixed(1)}</text>)}
                    {xTicks.map((x,i)=><text key={i} x={px(x)} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill={x===0?"#EF4444":"#475569"}>{x}s</text>)}
                    {yLabel&&<text x={8} y={pad.t+H/2} textAnchor="middle" fontSize="8" fill="#475569" transform={`rotate(-90,8,${pad.t+H/2})`}>{yLabel}</text>}
                  </svg>
                );
              }

              return canSeeAnalyticsData && section(`Tacking analysis — ${validTacks.length} valid tacks  (−${PRE}s → +${POST}s)`,(
                <>
                  <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap",alignItems:"center"}}>
                    {validTacks.map((tk,i)=>(
                      <span key={i}
                        onClick={()=>setSelectedTackIdx(selectedTackIdx===i?null:i)}
                        style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:9,fontFamily:"monospace",
                          color:TACK_COLORS[i%TACK_COLORS.length],cursor:"pointer",
                          padding:"2px 6px",borderRadius:4,
                          background:selectedTackIdx===i?`${TACK_COLORS[i%TACK_COLORS.length]}25`:"transparent",
                          border:`1px solid ${selectedTackIdx===i?TACK_COLORS[i%TACK_COLORS.length]:"transparent"}`}}>
                        <span style={{display:"inline-block",width:10,height:3,background:TACK_COLORS[i%TACK_COLORS.length],borderRadius:1}}/>
                        T{i+1} {hmLocal(tk.utc,tz)}
                      </span>
                    ))}
                    {selectedTackIdx!=null&&(
                      <button onClick={()=>setSelectedTackIdx(null)}
                        style={{background:"none",border:"1px solid #1E3A5A",borderRadius:4,padding:"2px 8px",color:"#475569",cursor:"pointer",fontSize:9}}>
                        ✕ clear
                      </button>
                    )}
                    <span style={{fontSize:9,color:"#334155",marginLeft:4}}>Click line or legend to highlight · Red = tack moment</span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>a) BOAT SPEED (BSP kn)</div>
                      <TackChart series={tackSeries.bsp} yLabel="BSP kn" color="#10B981" height={130}
                        selectedTack={selectedTackIdx} onTackClick={setSelectedTackIdx}/>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>b) RUDDER ANGLE (|°|)</div>
                      <TackChart series={tackSeries.rudder} yLabel="Rudder |°|" color="#FBBF24" height={130}
                        selectedTack={selectedTackIdx} onTackClick={setSelectedTackIdx}/>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>c) RATE OF TURN (°/s  YawR)</div>
                      <TackChart series={tackSeries.yawR} yLabel="YawR °/s" color="#8B5CF6" height={130}
                        selectedTack={selectedTackIdx} onTackClick={setSelectedTackIdx}/>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>d) TRUE WIND ANGLE (|°|)</div>
                      <TackChart series={tackSeries.twa} yLabel="TWA |°|" color="#7DD3FC" height={130}
                        selectedTack={selectedTackIdx} onTackClick={setSelectedTackIdx}/>
                    </div>
                    {tackPolar&&tackSeries.vmgPct.some(s=>s.length>1)&&(
                      <div style={{gridColumn:"1/-1"}}>
                        <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>e) POLAR VMG % — relative to tack moment</div>
                        <TackChart series={tackSeries.vmgPct} yLabel="VMG %" color="#22C55E" height={130}
                          yLines={[100]} yMin={0}
                          selectedTack={selectedTackIdx} onTackClick={setSelectedTackIdx}/>
                      </div>
                    )}
                    {!tackPolar&&<div style={{gridColumn:"1/-1",fontSize:9,color:"#475569",padding:"8px 0"}}>
                      ⚠ Upload polar file to enable VMG % chart
                    </div>}
                  </div>

                  {/* ── Cumulative VMG loss ──────────────────────────────────────── */}
                  {vmgLossSeries.length>0&&<>
                    <div style={{height:1,background:"#0F2030",margin:"16px 0 12px"}}/>
                    <div style={{fontSize:9,color:"#475569",marginBottom:4,letterSpacing:1}}>
                      e) ACCUMULATED VMG LOSS (boat lengths) — baseline: avg VMG {BASELINE_START}s → {BASELINE_END}s before tack
                    </div>
                    <div style={{fontSize:9,color:"#334155",marginBottom:8}}>
                      Negative = lost distance vs baseline upwind VMG · Positive = briefly faster than baseline ·
                      Final value at +{POST}s = total tack cost (boat lengths below zero)
                    </div>
                    <TackChart
                      series={vmgLossSeries}
                      yLabel="BL loss"
                      color="#EF4444"
                      height={160}
                      xMin={LOSS_START}
                      xMax={POST}
                      yLines={[0]}
                      selectedTack={selectedTackIdx}
                      onTackClick={setSelectedTackIdx}
                    />
                    {/* Summary table */}
                    <div style={{marginTop:12,overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                        <thead>
                          <tr style={{color:"#475569",letterSpacing:1}}>
                            <th style={{textAlign:"left",padding:"4px 8px",borderBottom:"1px solid #1E3A5A",fontWeight:600,fontSize:9}}>TACK</th>
                            <th style={{textAlign:"right",padding:"4px 8px",borderBottom:"1px solid #1E3A5A",fontWeight:600,fontSize:9}}>TIME (UTC)</th>
                            <th style={{textAlign:"right",padding:"4px 8px",borderBottom:"1px solid #1E3A5A",fontWeight:600,fontSize:9}}>BASELINE VMG</th>
                            <th style={{textAlign:"right",padding:"4px 8px",borderBottom:"1px solid #1E3A5A",fontWeight:600,fontSize:9}}>LOSS (BL)</th>
                            <th style={{textAlign:"right",padding:"4px 8px",borderBottom:"1px solid #1E3A5A",fontWeight:600,fontSize:9}}>RATING</th>
                          </tr>
                        </thead>
                        <tbody>
                          {vmgLossSeries.map((pts,i)=>{
                            const finalBL=pts[pts.length-1]?.y??0;
                            const lossBL=Math.abs(finalBL);
                            const baseVMG=pts[0]?.baseVMG??0;
                            const color=TACK_COLORS[i%TACK_COLORS.length];
                            const rating=lossBL<3?"★★★ excellent":lossBL<5?"★★ good":lossBL<8?"★ average":"slow";
                            const rColor=lossBL<3?"#10B981":lossBL<5?"#22C55E":lossBL<8?"#F59E0B":"#EF4444";
                            const tk=validTacks[i];
                            const isSel=selectedTackIdx===i;
                            return(
                              <tr key={i}
                                onClick={()=>setSelectedTackIdx(isSel?null:i)}
                                style={{borderBottom:"1px solid #0F2030",cursor:"pointer",
                                  background:isSel?`${color}15`:"transparent",
                                  outline:isSel?`1px solid ${color}40`:"none"}}>
                                <td style={{padding:"5px 8px",color}}>
                                  <span style={{display:"inline-block",width:10,height:3,background:color,borderRadius:1,marginRight:6,verticalAlign:"middle"}}/>
                                  T{i+1}
                                </td>
                                <td style={{padding:"5px 8px",textAlign:"right",color:"#94A3B8",fontFamily:"monospace"}}>
                                  {tk?hmLocal(tk.utc,tz):"--"}
                                </td>
                                <td style={{padding:"5px 8px",textAlign:"right",color:"#06B6D4",fontFamily:"monospace"}}>
                                  {R(baseVMG)} kn
                                </td>
                                <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontWeight:700,color:rColor}}>
                                  {lossBL.toFixed(1)} BL
                                </td>
                                <td style={{padding:"5px 8px",textAlign:"right",color:rColor,fontSize:9}}>
                                  {rating}
                                </td>
                              </tr>
                            );
                          })}
                          {vmgLossSeries.length>1&&(()=>{
                            const avg=vmgLossSeries.reduce((s,pts)=>s+Math.abs(pts[pts.length-1]?.y??0),0)/vmgLossSeries.length;
                            const rColor=avg<3?"#10B981":avg<5?"#22C55E":avg<8?"#F59E0B":"#EF4444";
                            return(
                              <tr style={{borderTop:"2px solid #1E3A5A",background:"#071624"}}>
                                <td colSpan={3} style={{padding:"5px 8px",color:"#64748B",fontSize:9,letterSpacing:1}}>SESSION AVERAGE</td>
                                <td style={{padding:"5px 8px",textAlign:"right",fontFamily:"monospace",fontWeight:700,color:rColor,fontSize:12}}>{avg.toFixed(1)} BL</td>
                                <td style={{padding:"5px 8px",textAlign:"right",color:rColor,fontSize:9}}>{avg<3?"★★★":avg<5?"★★":avg<8?"★":""}</td>
                              </tr>
                            );
                          })()}
                        </tbody>
                      </table>
                    </div>
                  </>}
                </>
              ));
            })()}
            {canSeeAnalyticsData && allVideos.filter(v=>v.twsAvg!=null).length>0&&section("Clips with instrument data",(
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {allVideos.filter(v=>v.twsAvg!=null).map(v=>(
                  <div key={v.id} onClick={()=>{ if(onPlayClip){onPlayClip(v);return;} onSelectVideo(v);setActiveTab("library"); }} style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",background:"#071624",borderRadius:6,padding:"7px 10px",cursor:"pointer",border:"1px solid #1E3A5A"}}>
                    <div style={{fontSize:10,color:"#E2E8F0",flex:"1 1 120px",minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.title}</div>
                    <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",minWidth:0}}>
                    {[["TWS",v.twsAvg,"kt","#7DD3FC"],["TWA",v.twaAvg,"°","#7DD3FC"],["VMG",v.vmgAvg,"kt","#22C55E"],["Pol",v.polpercAvg,"%",v.polpercAvg==null?"#22C55E":v.polpercAvg>=110?"#166534":v.polpercAvg>=90?"#22C55E":"#EF4444"],["Tgt",v.vsTargPercAvg,"%",v.vsTargPercAvg==null?"#22C55E":v.vsTargPercAvg>=110?"#166534":v.vsTargPercAvg>=90?"#22C55E":"#EF4444"]].map(([l,val,u,c])=>(<div key={l} style={{textAlign:"center",minWidth:42}}><div style={{fontSize:8,color:"#334155"}}>{l}</div><div style={{fontSize:11,fontWeight:700,color:c,fontFamily:"monospace"}}>{val!=null?R(val):"--"}{u}</div></div>))}
                    <div style={{fontSize:9,color:"#334155"}}>→</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export { AnalyticsTab };