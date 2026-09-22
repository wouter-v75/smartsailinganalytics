'use client'
import React from "react";
import { EVENT_FILE_SLUG, isTagged, trackTags } from '../lib/dayTags';
import { MEDIA_COLOURS, isDroneClip } from '../lib/mediaDecks';
import { loadPolarFromLS } from '../lib/polarCalc';
import { racesOf, segmentDay } from '../lib/tagging/segments';
import { TRACK_COLOUR_MODES, colourFor, legendStops, modeDef, needsPolar, scaleForRows, toMode, trackValue } from '../lib/trackColour';
import { sectionLabel, selectButtonLabel } from '../lib/trackSections';
import { inRange, nearestTrackIndex, orderedRange } from '../lib/trackSelection';
import { useTz } from './ssa/TzContext';
import { EMPTY } from './ssa/constants';
import { hmLocal } from './ssa/format';

// Where the track's colour mode is remembered. Per browser, like the polar
// itself: it is a way of looking, not a property of the day.
const TRACK_COLOUR_KEY = 'ssa:trackColour';

// 16px on the control itself would be right for a phone (smaller text makes iOS
// zoom the page on focus), but this sits in a dense analytics header; the map
// below is the thing being read, so the control stays quiet.
const selectStyle = {
  background:'#071624', color:'#E2E8F0', border:'1px solid #1E3A5A',
  borderRadius:5, padding:'4px 8px', fontSize:11, fontWeight:600,
  minHeight:30, cursor:'pointer',
};

// The array defaults are the shared EMPTY, not fresh literals. `dayTags=[]` was a
// new array on every render, and dayTags is a dep of the map-init effect, whose last
// act is setMapGen(g=>g+1) — so any caller that left dayTags out (the /dev/track
// harness, and anything else omitting it) put the map in an endless
// render → effect → setState → render loop, rebuilding Leaflet each time.
export function GPSTrackMap({rows, videoStartUtc, videoDurationSec, xmlData, syncOffset=0, playUtc=null, visible=true, allVideos=EMPTY, onSelectVideo=null, onSwitchTab=null, onPlayClip=null, photos=EMPTY, sections=EMPTY, onSelection=null, onRemoveSection=null, onClearSections=null,
  dayTags=EMPTY, onRaceChosen=null, squadTracks=EMPTY,
  finishDraft=null, onFinishDraft=null, onSaveFinish=null, finishNote=null, finishMsg=null, canTagFinish=false}){
  const tz=useTz();
  const containerRef = React.useRef(null);
  const mapRef       = React.useRef(null);
  const boatMarkerRef= React.useRef(null); // Leaflet marker for live boat position
  // Section selection: drag along the track → a time range for the charts below.
  // mapGen bumps each time Leaflet builds the map, so the selection layer and the drag
  // handlers re-attach to the new map instead of the one that was torn down.
  // What the track's colour MEANS. Auto is what it has always been — VMG near a
  // VMG angle, boat speed elsewhere — and stays the default; the three explicit
  // modes let one question be asked the whole way up a beat, which is what makes
  // two beats comparable. See lib/trackColour.ts.
  const [colourMode,setColourMode] = React.useState(()=>{
    try{ return toMode(localStorage.getItem(TRACK_COLOUR_KEY)); }catch{ return 'auto'; }
  });
  React.useEffect(()=>{ try{ localStorage.setItem(TRACK_COLOUR_KEY, colourMode); }catch{} },[colourMode]);
  // Which race, or the whole day. A day zoomed to fit is a scribble and the two
  // beats worth comparing are on top of each other; one race is a course. Same
  // helper the tagger's track filter uses, so the two screens cut the day at the
  // same places.
  const [raceKey,setRaceKey] = React.useState('all');
  const [selecting,setSelecting] = React.useState(false);
  const [draft,setDraft]         = React.useState(null);   // [utcA, utcB] while dragging
  const [mapGen,setMapGen]       = React.useState(0);
  // The squad's other boats, drawn beside the active one. Hidden rather than
  // removed, so toggling is instant and the colour stays with the boat.
  const [hiddenBoats,setHiddenBoats] = React.useState(()=>new Set());
  const shownSquad = React.useMemo(
    ()=>squadTracks.filter(t=>!hiddenBoats.has(t.boatId)),
    [squadTracks,hiddenBoats]);
  // Leaflet is rebuilt wholesale by the map effect, so it needs a dep that
  // changes when the VISIBLE set does — not the array identity.
  const squadSig = React.useMemo(
    ()=>shownSquad.map(t=>`${t.boatId}:${t.rows.length}:${t.detail||'track'}`).join('|'),
    [shownSquad]);
  const selLayerRef              = React.useRef(null);

  const dayStart = xmlData?.dayStartUtc || null;
  const dayStop  = xmlData?.dayStopUtc  || null;

  // Every valid GPS row in the day's window, before the race filter. The races
  // are derived from THIS, so picking a race cannot change what races exist.
  const dayRows = React.useMemo(()=>{
    if(!rows?.length) return [];
    let r = rows.filter(row=>
      row.lat && row.lon &&
      Math.abs(row.lat)>0.01 && Math.abs(row.lat)<90 &&
      Math.abs(row.lon)>0.01 && Math.abs(row.lon)<180
    );
    if(dayStart) r = r.filter(row=>row.utc>=dayStart);
    if(dayStop)  r = r.filter(row=>row.utc<=dayStop);
    return r;
  },[rows, dayStart, dayStop]);

  const races = React.useMemo(()=>racesOf(segmentDay({
    guns: xmlData?.raceGuns,
    markRoundings: xmlData?.markRoundings,
    dayStartUtc: dayStart,
    dayStopUtc: dayStop,
    dataT0: dayRows.length ? dayRows[0].utc : null,
    dataT1: dayRows.length ? dayRows[dayRows.length-1].utc : null,
  })),[xmlData, dayStart, dayStop, dayRows]);

  // A race that disappears — another day opened, the event file reloaded — must
  // not leave the map filtered to a window that no longer exists, showing an
  // empty box and no way to understand why.
  React.useEffect(()=>{
    if(raceKey!=='all' && !races.some(r=>r.key===raceKey)) setRaceKey('all');
  },[races, raceKey]);

  const race = raceKey==='all' ? null : races.find(r=>r.key===raceKey) || null;

  // The parent knows which finishes are TAGGED; the map only knows which race is on
  // screen. Telling it which one lets it say whether that race's end is a guess.
  const onRaceChosenRef = React.useRef(onRaceChosen);
  React.useEffect(()=>{ onRaceChosenRef.current=onRaceChosen; },[onRaceChosen]);
  React.useEffect(()=>{ onRaceChosenRef.current?.(raceKey==='all'?'':raceKey); },[raceKey]);

  const filteredRows = React.useMemo(()=>
    race ? dayRows.filter(r=>r.utc>=race.t0 && r.utc<=race.t1) : dayRows
  ,[dayRows, race]);


  const winStart = videoStartUtc ? videoStartUtc+(syncOffset||0)*1000 : null;
  const winEnd   = winStart ? winStart+(videoDurationSec||0)*1000 : null;
  const hlRows   = React.useMemo(()=>
    winStart ? filteredRows.filter(r=>r.utc>=winStart&&r.utc<=winEnd) : []
  ,[filteredRows, winStart, winEnd]);

  const polar = React.useMemo(()=>loadPolarFromLS(),[]);
  // The colour scale comes from the day being shown, not from a fixed band: a whole
  // afternoon inside one colour tells you nothing, which is what a fixed band does to
  // a steady day.
  const colourScale = React.useMemo(
    ()=>scaleForRows(polar, filteredRows, colourMode), [polar, filteredRows, colourMode]);

  // The ramp a SQUAD PARTNER's track is drawn with, when its team shares
  // `logdata` and the route therefore sent sog.
  //
  // Built from the ACTIVE boat's own speed, not the partner's, so the same
  // colour means the same speed on every boat on the map — which is the
  // comparison the whole feature exists to make. Null in the colour modes a
  // partner cannot satisfy (no polar, no wind of their own), and then they keep
  // their identity colour rather than being painted with an invented number.
  const speedScale = React.useMemo(()=>{
    if(colourMode!=='bsp') return null;
    return scaleForRows(polar, filteredRows, 'bsp');
  },[polar, filteredRows, colourMode]);

  // Keep callbacks in refs so Leaflet click closures always have the latest values
  const onSelectVideoRef = React.useRef(onSelectVideo);
  const onSwitchTabRef   = React.useRef(onSwitchTab);
  const onPlayClipRef    = React.useRef(onPlayClip);
  React.useEffect(()=>{ onSelectVideoRef.current=onSelectVideo; },[onSelectVideo]);
  React.useEffect(()=>{ onSwitchTabRef.current=onSwitchTab; },  [onSwitchTab]);
  React.useEffect(()=>{ onPlayClipRef.current=onPlayClip; },    [onPlayClip]);
  const playUtcRef = React.useRef(playUtc);
  React.useEffect(()=>{ playUtcRef.current = playUtc; },[playUtc]);
  const onSelectionRef = React.useRef(onSelection);
  React.useEffect(()=>{ onSelectionRef.current=onSelection; },[onSelection]);

  // Only the video MARKERS matter to the map — id + position in time. `allVideos`
  // itself churns constantly (thumbnail loads, proxy/original flags, sync state), and
  // it used to be a dep of the map effect, so the whole Leaflet map was destroyed and
  // rebuilt on every one of those updates. Tearing a map down mid fitBounds/zoom
  // animation is what threw `Cannot read properties of undefined (reading '_leaflet_pos')`
  // — the animation frame lands on a pane that no longer exists.
  const videoMarkerSig = React.useMemo(
    // duration is included: it loads asynchronously after import, and the markers
    // filter on it — leave it out and a clip never gets its marker.
    () => (allVideos||[]).map(v=>`${v.id}:${v.startUtc||0}:${v.duration||0}`).join('|'),
    [allVideos]
  );
  const allVideosMapRef = React.useRef(allVideos);
  allVideosMapRef.current = allVideos;

  // Photos get the same treatment as clips, and for the same reason. The map
  // effect DRAWS photo markers but `photos` was not a dep, so a day's photos —
  // which load asynchronously, after the track — never got markers until
  // something else in the dep list happened to change. Adding `photos` itself
  // would rebuild Leaflet on every photo state change (thumbnail loads, sync
  // flags, objectUrl churn), which is the churn videoMarkerSig exists to avoid.
  // Only id and position in time and space can move a marker.
  const photoMarkerSig = React.useMemo(
    () => (photos || []).map(p => `${p.id}:${p.utc || 0}:${p.lat ?? ''}:${p.lon ?? ''}`).join('|'),
    [photos]
  );
  const photosMapRef = React.useRef(photos);
  photosMapRef.current = photos;

  // ── Map init ─────────────────────────────────────────────────────────────────
  React.useEffect(()=>{
    if(!containerRef.current || filteredRows.length < 2) return;
    let cancelled = false;   // the Leaflet <script> can finish loading AFTER unmount
    let sizeObs = null;      // waits for the container to have real dimensions

    const initMap = () => {
      const L = window.L;
      if(!L) return;
      // Don't build a map into a container React has already thrown away.
      if(cancelled || !containerRef.current) return;
      if(mapRef.current){ mapRef.current.remove(); mapRef.current=null; boatMarkerRef.current=null; }

      const centre = [
        filteredRows.reduce((s,r)=>s+r.lat,0)/filteredRows.length,
        filteredRows.reduce((s,r)=>s+r.lon,0)/filteredRows.length,
      ];
      const map = L.map(containerRef.current, {center:centre, zoom:12, zoomControl:true, attributionControl:true});
      mapRef.current = map;

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
        attribution:'© OpenStreetMap contributors', maxZoom:18,
      }).addTo(map);

      // ── Coloured performance track ──────────────────────────────────────────
      const step = Math.max(1, Math.floor(filteredRows.length/1200));
      const sampled = filteredRows.filter((_,i)=>i%step===0);
      const segments = [];
      let seg = {color:null, pts:[]};
      for(let i=0;i<sampled.length;i++){
        const row = sampled[i];
        const color = colourFor(trackValue(polar, row, colourMode), colourScale);
        const pt = [row.lat, row.lon];
        if(!seg.color){ seg={color,pts:[pt]}; }
        else if(color!==seg.color){ seg.pts.push(pt); if(seg.pts.length>1) segments.push({...seg,pts:[...seg.pts]}); seg={color,pts:[pt]}; }
        else { seg.pts.push(pt); }
      }
      if(seg.pts.length>1) segments.push(seg);
      let allLatLngs = [];

      // ── The rest of the squad ──────────────────────────────────────────────
      // Drawn FIRST so the active boat sits on top, thinner and dimmer so the
      // colour ramp on the active track stays readable. Their points are NOT
      // added to allLatLngs: a boat that sailed somewhere else entirely would
      // otherwise zoom the map out and hide the day being looked at.
      for(const t of shownSquad){
        const pts=t.rows.map(r=>[r.lat,r.lon]);
        if(pts.length<2) continue;

        // SPEED-COLOURED when that team shares its log. The route only sends
        // sog if the owning team ticked `logdata`, so a coloured partner track
        // IS the permission, visible — and an identity-coloured one is a team
        // that chose not to, not a boat with no speed.
        //
        // The scale is the ACTIVE boat's, deliberately: the whole point is to
        // read two boats against each other, and a partner normalised to its
        // own range would paint its slowest moment the same red as the active
        // boat's, which is the exact comparison this is meant to make. Same
        // colour, same speed, every boat.
        //
        // Only for speed. A partner has no polar and no wind, so VMG% or TWA
        // cannot be honoured for them; those modes keep the identity colour
        // rather than inventing a number.
        const canSpeed = speedScale && t.rows.some(r=>Number.isFinite(r.sog));
        if(canSpeed){
          const segs=[]; let sg={color:null,pts:[]};
          for(const r of t.rows){
            const c = Number.isFinite(r.sog) ? colourFor(r.sog, speedScale) : t.colour;
            const pt=[r.lat,r.lon];
            if(!sg.color){ sg={color:c,pts:[pt]}; }
            else if(c!==sg.color){ sg.pts.push(pt); if(sg.pts.length>1) segs.push({...sg,pts:[...sg.pts]}); sg={color:c,pts:[pt]}; }
            else { sg.pts.push(pt); }
          }
          if(sg.pts.length>1) segs.push(sg);
          for(const g of segs){
            L.polyline(g.pts,{color:g.color,weight:3,opacity:0.7,smoothFactor:1}).addTo(map);
          }
          // A thin identity-coloured line under it, so WHOSE track it is stays
          // readable once the ramp has taken the colour away.
          L.polyline(pts,{color:t.colour,weight:6,opacity:0.18,smoothFactor:1})
            .bindTooltip(t.sailNumber?`${t.boatName} · ${t.sailNumber} — speed`:`${t.boatName} — speed`,{sticky:true})
            .addTo(map);
        } else {
          L.polyline(pts,{color:t.colour,weight:2,opacity:0.55,smoothFactor:1,dashArray:'4 3'})
            .bindTooltip(t.sailNumber?`${t.boatName} · ${t.sailNumber}`:t.boatName,{sticky:true})
            .addTo(map);
        }
        const end=pts[pts.length-1];
        L.marker(end,{icon:L.divIcon({className:'',iconSize:[0,0],iconAnchor:[-4,6],
          html:`<span style="font-size:9px;font-weight:700;color:${t.colour};text-shadow:0 0 3px #000;white-space:nowrap">${t.boatName}</span>`})}).addTo(map);
      }

      for(const s of segments){
        L.polyline(s.pts,{color:s.color,weight:3,opacity:0.92,smoothFactor:1}).addTo(map);
        allLatLngs=allLatLngs.concat(s.pts);
      }

      // ── Clip highlight (selected video) ────────────────────────────────────
      if(hlRows.length>1){
        const hlStep=Math.max(1,Math.floor(hlRows.length/500));
        const hlPts=hlRows.filter((_,i)=>i%hlStep===0).map(r=>[r.lat,r.lon]);
        L.polyline(hlPts,{color:'#06B6D4',weight:6,opacity:0.85}).addTo(map);
        const cOpts={radius:8,fillOpacity:1,weight:2,color:'#030F1A'};
        L.circleMarker([hlRows[0].lat,hlRows[0].lon],{...cOpts,fillColor:'#06B6D4'}).bindTooltip('Clip start').addTo(map);
        L.circleMarker([hlRows[hlRows.length-1].lat,hlRows[hlRows.length-1].lon],{...cOpts,fillColor:'#1D9E75'}).bindTooltip('Clip end').addTo(map);
      }

      // ── Where a clip starts ────────────────────────────────────────────────
      // The white coverage BANDS are gone (see below), but they carried the one
      // way to open a clip from this map, and losing that silently would be
      // worse than the bands were. So each clip keeps a dot at the point it
      // starts, in the timeline's own video and drone colours — small enough to
      // read as an annotation rather than as a finding, and still clickable.
      const covVideos=(allVideosMapRef.current||[]).filter(v=>v.startUtc);
      for(const vid of covVideos){
        // The selected clip already has its own bright highlight; a second
        // marker on top of it is noise.
        if(winStart&&Math.abs(vid.startUtc-winStart)<2000) continue;
        const nr=filteredRows.reduce((a,b)=>Math.abs(b.utc-vid.startUtc)<Math.abs(a.utc-vid.startUtc)?b:a,filteredRows[0]);
        if(!nr||Math.abs(nr.utc-vid.startUtc)>120000) continue;
        const c=isDroneClip({title:vid.title,tags:vid.tags})?MEDIA_COLOURS.drone:MEDIA_COLOURS.video;
        const mk=L.circleMarker([nr.lat,nr.lon],{radius:5,fillColor:c,color:'#030F1A',weight:1.5,fillOpacity:0.95})
          .bindTooltip(`📹 ${vid.title||'Video'}${vid.duration?` · ${Math.round(vid.duration/60)}min`:''}<br><span style="font-size:10px;color:#94A3B8">${onPlayClipRef.current?'Click to play':'Click to open in Videos'}</span>`,{allowHTML:true})
          .addTo(map);
        mk.on('click',()=>{
          // A player, not a tab. Where onPlayClip is supplied (the phone, which
          // has no Videos tab) the clip opens over the track it was clicked on;
          // elsewhere the old behaviour stands.
          if(onPlayClipRef.current){ onPlayClipRef.current(vid); return; }
          if(onSelectVideoRef.current) onSelectVideoRef.current(vid);
          if(onSwitchTabRef.current)   onSwitchTabRef.current('library');
        });
      }

      // ── Phase sections ─────────────────────────────────────────────────────
      // The event file's steady-state phases — the 30-second windows the
      // performance charts are built from. Shading them says which water the
      // numbers below actually came from, which is the question anybody reading
      // a phase table asks first.
      //
      // Grey, and underneath everything: a phase is not a finding, it is the
      // sample. Colour would compete with the performance track, which is the
      // one thing on this map that IS a finding.
      //
      // This replaces the video-coverage bands that used to be drawn here in
      // white. They answered "was this filmed", which is a question the tagger's
      // own track now answers in the video deck's own colour — and in white,
      // over a coloured performance track, they mostly just washed it out.
      for(const ph of (xmlData?.phases||[])){
        const phRows=filteredRows.filter(r=>r.utc>=ph.utc&&r.utc<=ph.endUtc);
        if(phRows.length<2) continue;
        const phStep=Math.max(1,Math.floor(phRows.length/200));
        const phPts=phRows.filter((_,i)=>i%phStep===0||i===phRows.length-1).map(r=>[r.lat,r.lon]);
        L.polyline(phPts,{
          color:'#94A3B8',
          weight:11,
          opacity:0.22,
          smoothFactor:1,
          interactive:false,   // the track underneath stays draggable for a selection
        }).addTo(map);
      }

      // ── Day start / end markers ─────────────────────────────────────────────
      const fmtU=utc=>{try{return isNaN(new Date(utc))?'--:--':hmLocal(utc,tz);}catch{return'--:--';}};
      const first=filteredRows[0],last=filteredRows[filteredRows.length-1];
      L.circleMarker([first.lat,first.lon],{radius:9,fillColor:'#22C55E',color:'#fff',weight:2,fillOpacity:1}).bindTooltip(`Day start ${fmtU(first.utc)} UTC`).addTo(map);
      L.circleMarker([last.lat,last.lon],{radius:9,fillColor:'#94A3B8',color:'#fff',weight:2,fillOpacity:1}).bindTooltip(`Day end ${fmtU(last.utc)} UTC`).addTo(map);

      // ── Event markers ───────────────────────────────────────────────────────
      // Both sources are drawn. Where the tagger already has the same moment the
      // event file's dot is skipped — the tag is the version the team named and
      // coloured — but everything the tags do not cover is still shown here.
      if(xmlData){
        const nearest=utc=>filteredRows.reduce((a,b)=>Math.abs(b.utc-utc)<Math.abs(a.utc-utc)?b:a,filteredRows[0]);
        for(const m of (xmlData.markRoundings||[])){
          if(isTagged(dayTags,m.utc,[EVENT_FILE_SLUG.mark])) continue;
          try{const nr=nearest(m.utc);if(Math.abs(nr.utc-m.utc)>120000)continue;
            L.circleMarker([nr.lat,nr.lon],{radius:10,fillColor:m.isTop?"#EF4444":"#8B5CF6",color:'#030F1A',weight:2,fillOpacity:m.isValid===false?0.3:1}).bindTooltip(`${m.label||'Mark'} · ${fmtU(m.utc)}`).addTo(map);
            L.marker([nr.lat,nr.lon],{icon:L.divIcon({className:'',iconSize:[0,0],iconAnchor:[-5,-12],html:`<span style="font-size:9px;font-weight:700;color:#fff;text-shadow:0 0 3px #000">${m.isTop?'▲':'▽'}</span>`})}).addTo(map);
          }catch(e){console.warn('mark err',e);}
        }
        for(const g of (xmlData.raceGuns||[])){
          if(isTagged(dayTags,g.utc,[EVENT_FILE_SLUG.gun])) continue;
          try{const nr=nearest(g.utc);if(Math.abs(nr.utc-g.utc)>120000)continue;
            L.circleMarker([nr.lat,nr.lon],{radius:10,fillColor:'#EF4444',color:'#fff',weight:2,fillOpacity:1}).bindTooltip(`${g.label||'Gun'} · ${fmtU(g.utc)}`).addTo(map);
          }catch(e){}
        }
        for(const tj of (xmlData.tackJibes||[])){
          if(isTagged(dayTags,tj.utc,[tj.isTack?EVENT_FILE_SLUG.tack:EVENT_FILE_SLUG.gybe])) continue;
          try{const nr=nearest(tj.utc);if(Math.abs(nr.utc-tj.utc)>60000)continue;
            // Small, as on the tagger's track and for the same reason: a day
            // has two sail changes and a hundred and forty tacks, and drawn the
            // same size as a mark rounding they are the same news — the map
            // becomes a bead necklace and the moments worth navigating to are
            // hidden among the routine.
            L.circleMarker([nr.lat,nr.lon],{radius:tj.isValid===false?2:3,fillColor:tj.isTack?'#1D9E75':'#7F77DD',color:'transparent',fillOpacity:tj.isValid===false?0.25:0.85}).bindTooltip(`${tj.label||'T/G'} · ${fmtU(tj.utc)}`).addTo(map);
          }catch(e){}
        }
        for(const se of (xmlData.sailsUpEvents||[])){
          if(isTagged(dayTags,se.utc,[EVENT_FILE_SLUG.sails])) continue;
          try{const nr=nearest(se.utc);if(Math.abs(nr.utc-se.utc)>120000)continue;
            L.marker([nr.lat,nr.lon],{icon:L.divIcon({className:'',iconSize:[0,0],iconAnchor:[0,0],html:`<div style="background:#F59E0B;border:1.5px solid #030F1A;border-radius:3px;padding:1px 4px;font-size:8px;font-weight:700;color:#000;white-space:nowrap;max-width:100px;overflow:hidden;text-overflow:ellipsis">${(se.sails||[]).slice(0,2).join('·')||'Sail'}</div>`})}).bindTooltip(`${se.label||'Sail'} · ${fmtU(se.utc)}`).addTo(map);
          }catch(e){}
        }
      }

      // ── Boat position marker (for video sync) ───────────────────────────────
      const boatMarker = L.marker(centre, {
        icon: L.divIcon({
          className: 'ssa-boat',
          iconSize: [20, 26],
          iconAnchor: [10, 13],
          html: `<div class="boat-inner" style="opacity:0;transition:opacity 0.15s;width:20px;height:26px">
            <svg width="20" height="26" viewBox="0 0 20 26" fill="none">
              <path d="M10 2 L18 22 L10 17 L2 22 Z" fill="#F59E0B" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
              <circle cx="10" cy="13" r="3" fill="#fff" fill-opacity="0.9"/>
            </svg>
          </div>`,
        }),
        zIndexOffset: 2000,
        interactive: false,
      }).addTo(map);
      boatMarkerRef.current = boatMarker;

      // Immediately position boat from current playUtc — avoids waiting for
      // next [playUtc] effect which won't fire again just because the ref changed.
      // Use requestAnimationFrame so Leaflet has had a tick to add the element to DOM.
      requestAnimationFrame(()=>{
        const inner = boatMarker.getElement()?.querySelector('.boat-inner');
        const curUtc = playUtcRef.current;
        if(!inner || !curUtc) return;
        let lo=0, hi=filteredRows.length-1;
        while(lo<hi){const mid=(lo+hi+1)>>1; if(filteredRows[mid].utc<=curUtc)lo=mid; else hi=mid-1;}
        const row=filteredRows[lo];
        if(!row||Math.abs(row.utc-curUtc)>60000)return;
        boatMarker.setLatLng([row.lat,row.lon]);
        const nxt=filteredRows[Math.min(lo+3,filteredRows.length-1)];
        let hdg=0;
        if(nxt&&nxt!==row){const dLon=(nxt.lon-row.lon)*Math.PI/180;const y=Math.sin(dLon)*Math.cos(nxt.lat*Math.PI/180);const x=Math.cos(row.lat*Math.PI/180)*Math.sin(nxt.lat*Math.PI/180)-Math.sin(row.lat*Math.PI/180)*Math.cos(nxt.lat*Math.PI/180)*Math.cos(dLon);hdg=(Math.atan2(y,x)*180/Math.PI+360)%360;}
        inner.style.opacity='1';
        inner.style.transform=`rotate(${hdg}deg)`;
      });

      // ── Legends ─────────────────────────────────────────────────────────────
      if(colourScale){
        const stops=legendStops(colourScale);
        const def=modeDef(colourMode);
        const head=def.kind==='pct' ? `⬡ ${polar?.filename||'Polar'} · ${def.label}` : def.label;
        const leg=L.control({position:'bottomright'});
        leg.onAdd=()=>{
          const d=L.DomUtil.create('div','');
          d.style.cssText='background:rgba(3,15,26,0.92);border:1px solid #1E3A5A;border-radius:7px;padding:8px 11px;font-size:9px;color:#94A3B8;line-height:1.8';
          const swatches=stops.map(st=>`<span style="display:inline-block;width:22px;height:7px;background:${st.color}"></span>`).join('');
          const labels=stops.map(st=>`<span style="display:inline-block;width:22px;text-align:center;font-size:8px;color:#64748B">${st.label}</span>`).join('');
          d.innerHTML=`<div style="font-weight:700;color:#E2E8F0;margin-bottom:4px;font-size:10px">${head}</div>`
            +`<div style="display:flex;gap:2px">${swatches}</div><div style="display:flex;gap:2px;margin-top:2px">${labels}</div>`
            +`<div style="margin-top:4px;color:#475569;font-size:8px">${def.hint}</div>`;
          return d;
        };
        leg.addTo(map);
      }
      const evLeg=L.control({position:'bottomleft'});
      evLeg.onAdd=()=>{const d=L.DomUtil.create('div','');d.style.cssText='background:rgba(3,15,26,0.92);border:1px solid #1E3A5A;border-radius:7px;padding:8px 11px;font-size:9px;color:#94A3B8;line-height:1.9';d.innerHTML=`<div><span style="display:inline-block;width:8px;height:8px;background:#22C55E;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Day start</div><div><span style="display:inline-block;width:8px;height:8px;background:#94A3B8;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Day end</div><div><span style="display:inline-block;width:8px;height:8px;background:#EF4444;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Top mark / gun</div><div><span style="display:inline-block;width:8px;height:8px;background:#8B5CF6;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Gate</div><div><span style="display:inline-block;width:8px;height:8px;background:#1D9E75;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Tack</div><div><span style="display:inline-block;width:8px;height:8px;background:#7F77DD;border-radius:50%;margin-right:5px;vertical-align:middle"></span>Gybe</div><div><span style="display:inline-block;width:8px;height:8px;background:#F59E0B;border-radius:2px;margin-right:5px;vertical-align:middle"></span>Sail change</div><div><span style="display:inline-block;width:14px;height:4px;background:#F59E0B;border-radius:2px;margin-right:5px;vertical-align:middle"></span>Boat position</div><div><span style="display:inline-block;width:14px;height:6px;background:rgba(148,163,184,0.35);border-radius:2px;margin-right:5px;vertical-align:middle"></span>Phase</div><div><span style="display:inline-block;width:8px;height:8px;background:#06B6D4;border-radius:50%;margin-right:5px;vertical-align:middle"></span>📹 Clip starts here</div>`;return d;};
      evLeg.addTo(map);

      // ── Photo markers ──────────────────────────────────────────────────────
      for(const photo of (photosMapRef.current||[])){
        if(!photo.lat||!photo.lon)continue;
        try{
          const marker=L.marker([photo.lat,photo.lon],{
            icon:L.divIcon({className:"",iconSize:[24,24],iconAnchor:[12,12],
              html:`<div style="background:#8B5CF6;border:2px solid #fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.5)">📷</div>`})
          });
          const dt=photo.utc?new Date(photo.utc).toISOString().slice(0,16).replace("T"," ")+" UTC":"";
          marker.bindTooltip(`📷 ${photo.name||"Photo"}<br><span style="font-size:10px;color:#94A3B8">${dt}</span>`,{allowHTML:true});
          if(photo.objectUrl){
            marker.on("click",()=>{
              const img=document.createElement("img");
              img.src=photo.objectUrl;
              img.style.cssText="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);max-width:80vw;max-height:80vh;z-index:9999;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.8);cursor:pointer";
              img.onclick=()=>document.body.removeChild(img);
              document.body.appendChild(img);
            });
          }
          marker.addTo(map);
        }catch(e){console.warn("photo marker err",e);}
      }

      // animate:false — an animated fitBounds schedules a zoom via requestAnimationFrame;
      // if the map is torn down before that fires (re-render churn on data load) the
      // callback throws `Cannot read properties of undefined (reading '_leaflet_pos')`,
      // which the sync try/catch can't catch. Jumping avoids the deferred animation.
      if(allLatLngs.length>0){try{map.fitBounds(L.latLngBounds(allLatLngs),{padding:[24,24],animate:false});}catch{}}
      selLayerRef.current = null;
      setMapGen(g=>g+1);
    };

    // ── Don't build into a zero-size container ──────────────────────────────
    // A tab that isn't showing has a 0x0 box. Leaflet fixes the map's pixel
    // origin at construction, and that arithmetic on a zero-size box produces
    // undefined points — which surfaced as `Cannot read properties of undefined
    // (reading 'x')` taking out the whole Analytics pane through its
    // ErrorBoundary. It is reachable on an ordinary page load, because
    // AnalyticsTab mounts as soon as the day's log arrives even while another
    // tab is in front (see hasMountedAnalytics in SSAApp). Same family as the
    // `_leaflet_pos` crash noted above fitBounds.
    //
    // So wait for real dimensions. The observer fires when the tab is first
    // shown, and the existing `visible` effect below still handles the
    // invalidateSize for a map that was built while already on screen.
    const hasSize = () => {
      const el = containerRef.current;
      if(!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const stopObserving = () => { try{ sizeObs?.disconnect(); }catch{} sizeObs = null; };
    const build = () => {
      if(cancelled) return;
      // No ResizeObserver (very old browser): keep the previous behaviour
      // rather than never drawing a map at all.
      if(typeof ResizeObserver === 'undefined'){ initMap(); return; }
      if(!hasSize()){
        if(!sizeObs && containerRef.current){
          sizeObs = new ResizeObserver(()=>{ if(hasSize()){ stopObserving(); build(); } });
          sizeObs.observe(containerRef.current);
        }
        return;
      }
      stopObserving();
      initMap();
    };

    if(!window.L){
      if(!document.getElementById('leaflet-css')){const css=document.createElement('link');css.id='leaflet-css';css.rel='stylesheet';css.href='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';document.head.appendChild(css);}
      const js=document.createElement('script');js.src='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';js.onload=build;document.head.appendChild(js);
    } else { build(); }
    return()=>{
      cancelled = true;
      stopObserving();
      if(mapRef.current){ mapRef.current.remove(); mapRef.current=null; boatMarkerRef.current=null; }
    };
    // `tz` is read when labelling markers; winStart reaches this through hlRows,
    // which is memoised on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[filteredRows, hlRows, xmlData, polar, videoMarkerSig, photoMarkerSig, colourMode, colourScale, speedScale, dayTags, tz, squadSig]);

  // ── Resize when tab becomes visible ──────────────────────────────────────────
  React.useEffect(()=>{
    if(visible && mapRef.current){
      setTimeout(()=>{try{mapRef.current?.invalidateSize();}catch{}}, 60);
    }
  },[visible]);

  // ── Section selection: highlight ───────────────────────────────────────────────
  React.useEffect(()=>{
    const map=mapRef.current, L=window.L;
    if(!map||!L) return;
    if(selLayerRef.current){ try{ selLayerRef.current.remove(); }catch{} selLayerRef.current=null; }
    // Each saved section in its own colour — the same colour its chip and its average
    // beside the charts use, which is the whole point of giving them colours. The drag
    // in progress is drawn in the selecting yellow until it becomes a section.
    const drawn=[
      ...sections.map(sec=>({range:sec.range,color:sec.color,label:sectionLabel(sec)})),
      ...(draft?[{range:orderedRange(draft[0],draft[1]),color:'#FDE047',label:'Selecting'}]:[]),
    ];
    if(!drawn.length) return;
    const g=L.layerGroup();
    const dot={radius:7,weight:2,color:'#030F1A',fillOpacity:1,interactive:false};
    for(const d of drawn){
      const [a,b]=d.range;
      const pts=filteredRows.filter(x=>x.utc>=a&&x.utc<=b);
      if(pts.length<2) continue;
      const step=Math.max(1,Math.floor(pts.length/800));
      L.polyline(pts.filter((_,i)=>i%step===0||i===pts.length-1).map(x=>[x.lat,x.lon]),
        {color:d.color,weight:7,opacity:0.9,interactive:false}).addTo(g);
      L.circleMarker([pts[0].lat,pts[0].lon],{...dot,fillColor:d.color}).bindTooltip(`${d.label} · start`).addTo(g);
      L.circleMarker([pts[pts.length-1].lat,pts[pts.length-1].lon],{...dot,fillColor:d.color,fillOpacity:0.55}).bindTooltip(`${d.label} · end`).addTo(g);
    }
    g.addTo(map);
    selLayerRef.current=g;
  },[sections,draft,filteredRows,mapGen]);

  // ── Section selection: a button on the map itself ───────────────────────────────
  // ── Tags mirrored from the Tagger tab ────────────────────────────────────
  // Drawn with the TAGGER's own style helpers — its labels, its colours, its size
  // hierarchy (a turn small, a moment full size) — so the two screens cannot drift
  // into naming the same moment two different things. When a day has tags they
  // REPLACE the event file's own dots below, rather than doubling up on them.
  const tagLayerRef = React.useRef(null);
  React.useEffect(()=>{
    const map=mapRef.current, L=window.L;
    if(!map||!L) return;
    if(tagLayerRef.current){ try{map.removeLayer(tagLayerRef.current);}catch{} tagLayerRef.current=null; }
    const drawn=trackTags(dayTags, tz);
    if(!drawn.length||!filteredRows.length) return;
    const nearest=utc=>filteredRows.reduce((a,b)=>Math.abs(b.utc-utc)<Math.abs(a.utc-utc)?b:a,filteredRows[0]);
    const layer=L.layerGroup();
    for(const t of drawn){
      try{
        const nr=nearest(t.t0);
        if(Math.abs(nr.utc-t.t0)>120000) continue;   // a tag with no track under it
        const tip=[`${t.label} · ${t.clock}`, t.sails, t.aboard].filter(Boolean).join('<br>');
        L.circleMarker([nr.lat,nr.lon],{
          radius:t.r, fillColor:t.color, color:t.isManoeuvre?'transparent':'#030F1A',
          weight:t.isManoeuvre?0:t.strokeWidth, fillOpacity:t.isManoeuvre?0.85:1,
        }).bindTooltip(tip).addTo(layer);
      }catch{}
    }
    layer.addTo(map);
    tagLayerRef.current=layer;
  },[dayTags,filteredRows,tz,mapGen]);

  // ── The finish nobody has tagged ─────────────────────────────────────────
  // A flashing marker on the best guess, draggable along the track. It is a draft
  // until somebody saves it: the event file has no finish, so this is a judgement
  // and it should look like one.
  const finishMarkerRef = React.useRef(null);
  React.useEffect(()=>{
    const map=mapRef.current, L=window.L;
    if(!map||!L) return;
    if(finishMarkerRef.current){ try{map.removeLayer(finishMarkerRef.current);}catch{} finishMarkerRef.current=null; }
    if(finishDraft==null||!filteredRows.length) return;
    const nearest=utc=>filteredRows.reduce((a,b)=>Math.abs(b.utc-utc)<Math.abs(a.utc-utc)?b:a,filteredRows[0]);
    const at=nearest(finishDraft);
    const mk=L.marker([at.lat,at.lon],{
      draggable:!!onFinishDraft, zIndexOffset:1500,
      icon:L.divIcon({className:'',iconSize:[0,0],iconAnchor:[0,0],
        html:`<div class="ssa-finish-flash" style="transform:translate(-50%,-50%);display:flex;align-items:center;gap:4px">
          <span style="width:14px;height:14px;border-radius:50%;background:#FDE047;border:2px solid #030F1A;display:block"></span>
          <span style="background:#FDE047;color:#030F1A;border-radius:3px;padding:1px 5px;font-size:9px;font-weight:800;white-space:nowrap">FINISH?</span>
        </div>`}),
    }).bindTooltip('Drag me to the finish').addTo(map);
    // Dropped anywhere, it snaps to the nearest point of the track: a finish that is
    // not on the boat's own path is not a time.
    mk.on('dragend',()=>{
      try{
        const p=mk.getLatLng();
        const best=filteredRows.reduce((a,b)=>{
          const da=(a.lat-p.lat)**2+(a.lon-p.lng)**2, db=(b.lat-p.lat)**2+(b.lon-p.lng)**2;
          return db<da?b:a;
        },filteredRows[0]);
        onFinishDraft?.(best.utc);
      }catch{}
    });
    finishMarkerRef.current=mk;
  },[finishDraft,filteredRows,onFinishDraft,mapGen]);

  React.useEffect(()=>{
    const map=mapRef.current, L=window.L;
    if(!map||!L||!onSelectionRef.current) return;
    const ctl=L.control({position:'topright'});
    ctl.onAdd=()=>{
      const b=L.DomUtil.create('button','');
      b.type='button';
      b.textContent=selecting?'✕ Cancel':'✂ Select section';
      b.title='Drag along the track to show only that stretch in the charts below';
      b.style.cssText=`font:600 12px system-ui,sans-serif;padding:7px 11px;border-radius:7px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.4);`+
        (selecting?'background:#FDE047;color:#030F1A;border:1px solid #030F1A;':'background:rgba(3,15,26,.92);color:#FDE047;border:1px solid #FDE04780;');
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b,'click',ev=>{ L.DomEvent.stop(ev); setSelecting(s=>!s); });
      return b;
    };
    ctl.addTo(map);
    return()=>{ try{ ctl.remove(); }catch{} };
  },[selecting,mapGen]);

  // ── Section selection: drag along the track ────────────────────────────────────
  // Pointer events on the container (mouse, pen and touch alike); the map stops panning
  // while selecting. The pick follows the leg the drag is on where legs cross (see
  // nearestTrackIndex). Under 30 s is taken as a slip and selects nothing.
  React.useEffect(()=>{
    const map=mapRef.current, el=containerRef.current;
    if(!map||!el||!selecting) return;
    const step=Math.max(1,Math.floor(filteredRows.length/3000));
    const track=filteredRows.filter((_,i)=>i%step===0);
    let screen=null, anchor=null, last=null;
    const at=e=>map.mouseEventToContainerPoint(e);
    const down=e=>{
      if(e.target?.closest?.('.leaflet-control')) return;   // the map's own buttons stay clickable
      screen=track.map(r=>map.latLngToContainerPoint([r.lat,r.lon]));
      const i=nearestTrackIndex(screen,at(e),24);
      if(i==null) return;
      anchor=last=i;
      try{ el.setPointerCapture(e.pointerId); }catch{}
      setDraft([track[i].utc,track[i].utc]);
      e.preventDefault(); e.stopPropagation();
    };
    const move=e=>{
      if(anchor==null) return;
      const i=nearestTrackIndex(screen,at(e),24,last);
      if(i==null||i===last) return;
      last=i;
      setDraft([track[anchor].utc,track[i].utc]);
    };
    const up=()=>{
      if(anchor==null) return;
      const a=track[anchor].utc, b=track[last].utc;
      anchor=null; setDraft(null);
      if(Math.abs(b-a)>=30000){ onSelectionRef.current?.(orderedRange(a,b)); setSelecting(false); }
    };
    map.dragging.disable();
    el.style.cursor='crosshair'; el.style.touchAction='none';
    el.addEventListener('pointerdown',down,true);
    el.addEventListener('pointermove',move);
    el.addEventListener('pointerup',up);
    el.addEventListener('pointercancel',up);
    return()=>{
      el.removeEventListener('pointerdown',down,true);
      el.removeEventListener('pointermove',move);
      el.removeEventListener('pointerup',up);
      el.removeEventListener('pointercancel',up);
      el.style.cursor=''; el.style.touchAction='';
      try{ map.dragging.enable(); }catch{}
      setDraft(null);
    };
  },[selecting,filteredRows,mapGen]);

  // ── Live boat position from video playback ────────────────────────────────────
  // Direct Leaflet API — no React re-render for position updates
  React.useEffect(()=>{
    const marker = boatMarkerRef.current;
    if(!marker || !filteredRows?.length) return;
    const inner = marker.getElement()?.querySelector('.boat-inner');
    if(!playUtc){ if(inner) inner.style.opacity='0'; return; }

    // Binary search for nearest row
    let lo=0, hi=filteredRows.length-1;
    while(lo<hi){const mid=(lo+hi+1)>>1; if(filteredRows[mid].utc<=playUtc)lo=mid; else hi=mid-1;}
    const row=filteredRows[lo];
    if(!row||Math.abs(row.utc-playUtc)>60000){ if(inner) inner.style.opacity='0'; return; }

    // Update position
    marker.setLatLng([row.lat,row.lon]);

    // Compute bearing from next few rows
    const nextRow=filteredRows[Math.min(lo+3,filteredRows.length-1)];
    let hdg=0;
    if(nextRow&&nextRow!==row){
      const dLon=(nextRow.lon-row.lon)*Math.PI/180;
      const y=Math.sin(dLon)*Math.cos(nextRow.lat*Math.PI/180);
      const x=Math.cos(row.lat*Math.PI/180)*Math.sin(nextRow.lat*Math.PI/180)-Math.sin(row.lat*Math.PI/180)*Math.cos(nextRow.lat*Math.PI/180)*Math.cos(dLon);
      hdg=(Math.atan2(y,x)*180/Math.PI+360)%360;
    }
    if(inner){
      inner.style.opacity='1';
      inner.style.transform=`rotate(${hdg}deg)`;
    }
  },[playUtc, filteredRows]);

  if(!rows?.length) return(<div style={{padding:12,background:"#071624",borderRadius:8,color:"#EF4444",fontSize:10}}>No log data</div>);
  if(filteredRows.length<2) return(<div style={{padding:12,background:"#071624",borderRadius:8,color:"#F59E0B",fontSize:10}}>No valid GPS rows. DayStart={dayStart?new Date(dayStart).toISOString().slice(11,19):"none"}. First row: lat={rows[0]?.lat?.toFixed?.(4)} lon={rows[0]?.lon?.toFixed?.(4)}</div>);

  const haversine=(a,b)=>{const R=6371,dl=(b.lat-a.lat)*Math.PI/180,dn=(b.lon-a.lon)*Math.PI/180,x=Math.sin(dl/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dn/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
  let distKm=0; for(let i=1;i<filteredRows.length;i++) distKm+=haversine(filteredRows[i-1],filteredRows[i]);
  const distNm=(distKm/1.852).toFixed(1);
  // Per section: how long it is and how far the boat went in it.
  const sectionStats=sections.map(sec=>{
    const sp=filteredRows.filter(r=>inRange(r.utc,sec.range));
    let km=0; for(let i=1;i<sp.length;i++) km+=haversine(sp[i-1],sp[i]);
    return { ...sec, min:Math.round((sec.range[1]-sec.range[0])/60000), nm:(km/1.852).toFixed(1) };
  });
  const selBtn={background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"3px 9px",color:"#94A3B8",cursor:"pointer",fontSize:10};

  return(
    <div>
      {onSelection&&(
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,flexWrap:"wrap",fontSize:10}}>
          <button onClick={()=>setSelecting(s=>!s)} aria-pressed={selecting}
            style={{...selBtn,fontSize:12,fontWeight:600,padding:"6px 12px",color:selecting?"#030F1A":"#FDE047",
              background:selecting?"#FDE047":"#FDE04712",borderColor:"#FDE04780"}}>
            {selecting?"✕ Cancel selecting":selectButtonLabel(sections)}
          </button>
          {race&&!selecting&&(
            <button onClick={()=>onSelection(orderedRange(race.t0,race.t1))}
              title="Show only this race in the cards and charts below"
              style={{...selBtn,color:"#06B6D4",borderColor:"#06B6D440"}}>
              ⇲ Use {race.label} as the selection
            </button>
          )}
          {selecting&&<span style={{color:"#FDE047"}}>Now drag along the track on the map, from the start of the stretch to its end</span>}
          {!selecting&&!sections.length&&<span style={{color:"#64748B"}}>Pick a stretch (a leg, a start, a race) to see only that part in the cards and charts below. Pick more than one to compare them.</span>}
          {finishNote&&(
            <span style={{color:"#FDE047",fontSize:11,flex:"1 1 260px"}}>
              ⚑ {finishNote}
              {canTagFinish&&onSaveFinish&&finishDraft!=null&&(
                <button onClick={onSaveFinish} disabled={finishMsg?.state==="busy"}
                  style={{...selBtn,marginLeft:8,color:"#030F1A",background:"#FDE047",borderColor:"#FDE047"}}>
                  {finishMsg?.state==="busy"?"Saving…":"✓ Save finish tag"}
                </button>
              )}
            </span>
          )}
          {finishMsg&&finishMsg.state!=="busy"&&(
            <span style={{fontSize:11,color:finishMsg.state==="ok"?"#10B981":"#F59E0B"}}>
              {finishMsg.state==="ok"?"✓ ":"⚠ "}{finishMsg.text}
            </span>
          )}
          {sectionStats.length>0&&!selecting&&(
            <>
              {sectionStats.map(sec=>(
                <span key={sec.id} data-track-section={sec.n}
                  style={{display:"inline-flex",alignItems:"center",gap:6,fontFamily:"monospace",color:"#E2E8F0",
                    border:`1px solid ${sec.color}66`,background:`${sec.color}14`,borderRadius:999,padding:"2px 4px 2px 8px"}}>
                  <span style={{width:9,height:9,borderRadius:2,background:sec.color,display:"inline-block"}} aria-hidden />
                  {sec.n} · {hmLocal(sec.range[0],tz)}–{hmLocal(sec.range[1],tz)} · {sec.min} min · {sec.nm} nm
                  {onRemoveSection&&(
                    <button onClick={()=>onRemoveSection(sec.id)} aria-label={`Remove ${sectionLabel(sec)}`}
                      style={{background:"none",border:"none",color:"#94A3B8",cursor:"pointer",fontSize:12,lineHeight:1,padding:"0 3px"}}>×</button>
                  )}
                </span>
              ))}
              {onClearSections&&(
                <button onClick={onClearSections} style={{...selBtn,color:"#06B6D4",borderColor:"#06B6D440"}}>↩ Whole session</button>
              )}
            </>
          )}
        </div>
      )}
      {/* ── Which part of the day, and what the colour means ─────────────────
          Under the selection row, because both scope what the map shows and a
          control you have to hunt for is a control nobody uses. The colour
          dropdown renders whether or not a polar is loaded: hiding it when
          there is no polar is why it could not be found at all — the absence
          explained nothing, where a disabled control says exactly what is
          missing. */}
      <div style={{marginBottom:6,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",fontSize:10}}>
        {races.length>0&&(
          <label style={{display:"flex",alignItems:"center",gap:6,color:"#94A3B8"}}>
            Show
            <select
              value={raceKey}
              onChange={e=>setRaceKey(e.target.value)}
              style={selectStyle}
            >
              <option value="all">Whole track</option>
              {races.map(r=><option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </label>
        )}

        {squadTracks.length>0&&(
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            <span style={{color:"#94A3B8"}}>Squad</span>
            {squadTracks.map(t=>{
              const on=!hiddenBoats.has(t.boatId);
              return (
                <button
                  key={t.boatId}
                  type="button"
                  onClick={()=>setHiddenBoats(prev=>{
                    const next=new Set(prev);
                    if(next.has(t.boatId)) next.delete(t.boatId); else next.add(t.boatId);
                    return next;
                  })}
                  title={
                    `${on?'Hide':'Show'} ${t.boatName}${t.sailNumber?` · ${t.sailNumber}`:''}` +
                    // Says WHY a track is a plain line, which is otherwise
                    // indistinguishable from a boat that logged no speed.
                    (t.rows.some(r=>Number.isFinite(r.sog))
                      ? (speedScale ? ' — coloured by speed, same scale as yours'
                                    : ' — shares its log; switch Colour by to BSP to see its speed')
                      : ' — position only; this team has not shared its log')
                  }
                  aria-pressed={on}
                  style={{
                    display:"flex",alignItems:"center",gap:5,
                    background:on?'#0B2136':'#071624',
                    color:on?'#E2E8F0':'#64748B',
                    border:`1px solid ${on?t.colour:'#1E3A5A'}`,
                    borderRadius:5,padding:'3px 8px',fontSize:11,fontWeight:600,
                    minHeight:30,cursor:'pointer',
                  }}
                >
                  <span style={{
                    width:9,height:9,borderRadius:2,flex:'0 0 auto',
                    background:on?t.colour:'transparent',
                    border:`1.5px solid ${t.colour}`,opacity:on?1:0.5,
                  }}/>
                  {t.boatName}
                  {t.rows.some(r=>Number.isFinite(r.sog))&&(
                    <span
                      aria-hidden
                      style={{fontSize:9,opacity:on?0.85:0.4,letterSpacing:-1}}
                    >▞</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <label style={{display:"flex",alignItems:"center",gap:6,color:"#94A3B8"}}>
          Colour by
          <select
            value={colourMode}
            onChange={e=>setColourMode(e.target.value)}
            title={modeDef(colourMode).hint}
            style={selectStyle}
          >
            {Array.from(new Set(TRACK_COLOUR_MODES.map(m=>m.group))).map(group=>(
              <optgroup key={group} label={group}>
                {TRACK_COLOUR_MODES.filter(m=>m.group===group).map(m=>(
                  // Only the polar modes need a polar; a channel off the log is
                  // colourable on any day.
                  <option key={m.key} value={m.key} disabled={!polar&&needsPolar(m.key)}>
                    {m.label}{!polar&&needsPolar(m.key)?' · needs a polar':''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {/* Which question the colour is answering. The three disagree with each
            other routinely — a boat two degrees low and quick is over 100% on
            boat speed and under on VMG — and that disagreement is the
            information, so the measure has to be a choice rather than something
            the map decides halfway up the beat. */}
        {colourScale
          ? <span style={{color:"#475569"}}>{modeDef(colourMode).hint}</span>
          : <span style={{color:"#475569"}}>
              {needsPolar(colourMode)
                ? "No polar loaded — colour by a channel off the log instead, or upload one in the Uploads tab."
                : `This log has no ${modeDef(colourMode).label} readings — track in uniform blue.`}
            </span>}

        {race&&(
          <span style={{color:"#7DD3FC",fontFamily:"monospace"}}>
            {hmLocal(race.t0,tz)}–{hmLocal(race.t1,tz)}
          </span>
        )}
        {polar&&(
          <span style={{marginLeft:"auto",background:"#F59E0B12",border:"1px solid #F59E0B30",borderRadius:3,padding:"2px 7px",fontWeight:600,fontSize:9,color:"#F59E0B"}}>
            ⬡ {polar.filename} · TWS {polar.tws?.[0]}–{polar.tws?.[polar.tws.length-1]} kn
          </span>
        )}
      </div>
      <div ref={containerRef} style={{width:"100%",height:460,borderRadius:10,overflow:"hidden",border:"1px solid #1E3A5A",background:"#071624"}}/>
      <div style={{display:"flex",gap:16,marginTop:6,flexWrap:"wrap",fontSize:10,color:"#475569",alignItems:"center"}}>
        {/* Say which window every figure on this row is for. A distance that
            silently means "race 2 only" is a distance somebody quotes wrongly. */}
        <span>{filteredRows.length.toLocaleString()} GPS pts · {race?race.label:(dayStart?"DayStart–DayStop window":"whole track")}</span>
        <span>Distance: <strong style={{color:"#06B6D4"}}>{distNm} nm</strong></span>
        {dayStart&&<span>Start: <strong style={{color:"#22C55E"}}>{hmLocal(dayStart,tz)}</strong></span>}
        {dayStop&&<span>End: <strong style={{color:"#F59E0B"}}>{hmLocal(dayStop,tz)}</strong></span>}
        {hlRows.length>0&&<span style={{color:"#06B6D4",marginLeft:"auto"}}>● Clip: {hlRows.length} pts</span>}
        {playUtc&&<span style={{color:"#F59E0B",marginLeft:"auto"}}>▲ Live: {hmLocal(playUtc,tz)}</span>}
      </div>
    </div>
  );
}

export { TRACK_COLOUR_KEY, selectStyle };