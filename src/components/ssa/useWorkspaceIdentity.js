'use client'
import { useEffect } from "react";
import { getActiveMembership } from '../../lib/active-membership';
import { prefetchBoatConfig } from '../../lib/boatConfigPrefetch';
import { listSessionsCloud } from '../../lib/cloud-sessions';
import { hasOpenableData } from '../../lib/hasOpenableData';
import { getAllVideosForMembership, getSessionsForMembership, venueTodayIso as TODAY } from '../../lib/localStore';
import { getBrowserSupabase, getUidFast } from '../../lib/supabase/browser';

export function useWorkspaceIdentity({
  setAllVideos, setLogData, setXmlData, setSelectedVideo, setSessions,
  setActiveDate, setEffectiveRole, setCampaignCfg, loadDateRef,
}) {
  // Resolve the effective auth role once on mount and re-resolve when the
  // active membership changes. Admin (global_role='admin') always wins.
  useEffect(()=>{
    let cancelled=false;
    async function resolve(){
      try{
        const supabase=getBrowserSupabase();
        // Verified user id — getClaims() checks the JWT signature locally against
        // the cached JWKS (asymmetric key), skipping the ~0.9s getUser() round-trip.
        // Fall back to getUser() if claims can't be verified. The admin decision
        // stays server-authoritative: the global_role read below is RLS-gated.
        let uid=null;
        try {
          if(typeof supabase.auth.getClaims==='function'){
            const {data:cl}=await supabase.auth.getClaims();
            const c=cl?.claims;
            // trust the local token only while still valid; expired JWT still
            // has a good signature but every query with it 401s -> getUser() below
            if(c?.sub && typeof c.exp==='number' && c.exp > Math.floor(Date.now()/1000)+30){ uid=c.sub; }
          }
        } catch { /* fall through to getUser */ }
        if(!uid){ const {data:{user}}=await supabase.auth.getUser(); uid=user?.id||null; }
        if(!uid||cancelled) return;
        const {data:profile}=await supabase.from('users').select('global_role').eq('id',uid).maybeSingle();
        if(cancelled) return;
        if(profile?.global_role==='admin'){ setEffectiveRole('admin'); return; }
        const m=getActiveMembership(uid);
        setEffectiveRole(m?.role||null);
      } catch { /* non-fatal */ }
    }
    resolve();
    const onChange=()=>resolve();
    window.addEventListener('ssa:active-membership-changed',onChange);
    return ()=>{ cancelled=true; window.removeEventListener('ssa:active-membership-changed',onChange); };
  },[setEffectiveRole]);

  // Campaign engine config for the active team. Null unless the team has
  // features.campaign_engine = true AND the active membership has a boat. When
  // set, it carries {teamId, boatId, members, targetDate, startDate} and
  // the Campaign tab becomes available.
  useEffect(()=>{
    let cancelled=false;
    // Bumped on every run so a SLOW earlier fetch cannot land after a newer one
    // and repaint the previous workspace's boat/event over the current one.
    // `cancelled` alone only covers unmount, not switch-during-flight.
    let runSeq=0;
    async function run(){
      const seq=++runSeq;
      try{
        const uid=await getUidFast();
        if(!uid||cancelled||seq!==runSeq) return;
        const m=getActiveMembership(uid);
        if(!m||!m.team_id||!m.boat_id){ setCampaignCfg(null); return; }
        const res=await fetch(`/api/teams/${m.team_id}/campaign/config?boat_id=${m.boat_id}`);
        if(cancelled||seq!==runSeq) return;
        // A failed fetch must not leave the PREVIOUS workspace's boat/event on
        // screen — that is how a deck generated as Warp came out titled Northstar.
        // Better an obviously-missing placeholder than a confidently wrong name.
        if(!res.ok){ setCampaignCfg(null); return; }
        const j=await res.json();
        if(cancelled||seq!==runSeq) return;
        // Prefer the API's boat name: it is read from `boats` for the ACTIVE
        // boat_id, so it survives a rename and cannot go stale. The membership
        // copy in localStorage is only a fallback.
        setCampaignCfg(j?.campaignOn ? {...j, teamId:m.team_id, boatId:m.boat_id, boatName:(j.boatName||m.boat_name||null)} : null);
      } catch { setCampaignCfg(null); /* non-fatal — campaign tab just stays hidden */ }
    }
    run();
    // Drop the old workspace's config the INSTANT the pill switches, then refetch.
    // Without this the deck kept the previous boat/event for the whole round-trip,
    // and forever if the refetch failed.
    const onChange=()=>{ setCampaignCfg(null); run(); };
    window.addEventListener('ssa:active-membership-changed',onChange);
    return ()=>{ cancelled=true; window.removeEventListener('ssa:active-membership-changed',onChange); };
  },[setCampaignCfg]);

  // Workspace-switch isolation. When the user changes their active
  // membership via UserPill, in-memory `sessions` / `allVideos` still hold
  // the previous workspace's data — including LOCAL entries that belong to
  // another team's boat. Reset both, re-read local (now filtered by the new
  // membership) and re-fetch the cloud session list for the new workspace.
  // Without this, an admin switching teams keeps seeing the previous team's
  // folders in the sidebar.
  useEffect(()=>{
    async function rescope(){
      try{
        const uid=await getUidFast();
        if(!uid) return;
        const m=getActiveMembership(uid);
        // Clear what we may still have from the previous workspace.
        setSessions([]);
        setAllVideos([]);
        setActiveDate(null);
        setSelectedVideo(null);
        setLogData(null);
        setXmlData(null);
        // Re-load filtered local data for the new workspace.
        const localSessions=getSessionsForMembership(m).sort((a,b)=>b.date.localeCompare(a.date));
        setSessions(localSessions);
        const vids=await getAllVideosForMembership(m);
        setAllVideos(vids);
        // Cloud list will be refreshed by the boot effect's
        // listSessionsCloud call when it re-runs; but to make the
        // switch feel instant, also trigger one here.
        const cloudSessions=await listSessionsCloud({userId:uid});
        if(cloudSessions.length>0){
          setSessions(p=>{
            const merged=[...p];
            for(const s of cloudSessions){
              const existing=merged.find(x=>x.date===s.date);
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
        // Open the most recent day that has VIDEO data for the NEW boat, and load
        // it — so the switch lands on a populated folder with thumbnails already
        // loading, instead of a blank date the user has to click into.
        const today2=TODAY();
        const bestDate=[
          ...localSessions.filter(s=>hasOpenableData(s) && s.date<=today2).map(s=>s.date),
          ...cloudSessions.map(s=>s.date),
        ].sort().reverse()[0]
          || [...localSessions.map(s=>s.date),...cloudSessions.map(s=>s.date)].sort().reverse()[0]
          || null;
        if(bestDate) await loadDateRef.current?.(bestDate);
        // Warm the new boat's Boat Config tab too.
        if(m?.team_id&&m?.boat_id) prefetchBoatConfig(m.team_id,m.boat_id);
      }catch{ /* non-fatal — boot will retry */ }
    }
    const onChange=()=>{ rescope(); };
    window.addEventListener('ssa:active-membership-changed',onChange);
    return ()=>{ window.removeEventListener('ssa:active-membership-changed',onChange); };
    // Registered once. rescope() reaches loadDate through loadDateRef (below), so
    // it calls the CURRENT one rather than the one this render closed over — the
    // same reason autoSyncFnRef exists further down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
}
