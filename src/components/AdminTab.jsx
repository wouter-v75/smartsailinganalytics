'use client'

// Admin tab — extracted from SmartSailingAnalytics_UI so it ships as its own
// lazy-loaded chunk (see the next/dynamic import there). The Admin tab is
// only visible to admins, so with this split a non-admin's browser never
// downloads this code at all.
//
// Props are threaded from the parent: status values to display, and the
// state setters the storage-management tools need.

const TODAY = () => new Date().toISOString().slice(0, 10)
const fmtDate = d => {
  if (!d) return ''
  const p = d.split('-')
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d
}

export default function AdminTab({
  unsyncedCount,
  cloudStatus,
  sessions = [],
  setSessions,
  setLogData,
  setXmlData,
}) {
  return (
    <>
      <div style={{fontSize:15,fontWeight:600,color:"#E2E8F0",marginBottom:18}}>Admin</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        {[
          {title:"Data tiers",items:["Tier 1 · Local: IndexedDB (videos + logs + events)","Tier 2 · Cloud: Bunny Storage (JSON) + Bunny Stream (HLS)","Today = always local  ·  Older = local → cloud fallback",`Unsynced items: ${unsyncedCount}`]},
          {title:"Cloud status (Bunny.net)",items:[`Storage: ${cloudStatus?.storage?"Connected ✓":"Not configured"}`,`Stream: ${cloudStatus?.stream?"Connected ✓":"Not configured"}`,`Zone: ${cloudStatus?.zone||"—"} · Region: ${cloudStatus?.region||"de"}`,"Env vars: BUNNY_STORAGE_API_KEY, BUNNY_STORAGE_ZONE, BUNNY_STORAGE_REGION, BUNNY_STREAM_API_KEY, BUNNY_STREAM_LIBRARY_ID, BUNNY_CDN_HOSTNAME"]},
          {title:"Roles (testing — NextAuth in Phase 2)",items:["Admin/Coach → local import + cloud sync + older sessions","Crew → local import today + cloud older (read-only)","Viewer/Consultant → cloud only, no import","Switch roles with the header dropdown"]},
          {title:"Sessions",items:sessions.length>0?sessions.map(s=>`${s.date===TODAY()?"Today":fmtDate(s.date)} · ${s.source||"local"} · ${s.videoCount||0}v${s.hasLog?" + log":""}${s.hasXml?" + events":""}${s.location?` · ${s.location}`:""}`):[" No sessions yet — import in Upload tab"]},
        ].map(c=>(<div key={c.title} style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:10,padding:14}}><div style={{fontSize:11,fontWeight:600,color:"#64748B",marginBottom:8}}>{c.title}</div>{c.items.map((item,i)=><div key={i} style={{fontSize:10,color:"#334155",padding:"3px 0",borderBottom:"1px solid #0F2030"}}>{item}</div>)}</div>))}
      </div>

      {/* ── Storage management ───────────────────────────────────────── */}
      <div style={{background:"#0A1929",border:"1px solid #EF444430",borderRadius:10,padding:14}}>
        <div style={{fontSize:11,fontWeight:600,color:"#EF4444",marginBottom:8}}>Storage management</div>
        <div style={{fontSize:10,color:"#475569",marginBottom:12}}>
          Use these tools if sessions show wrong dates (e.g. year 3925) or stale data after a parser fix.
          Videos in IndexedDB are NOT affected — only the session index and log/event metadata.
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={()=>{
            if(!confirm("Remove sessions with obviously wrong dates (year < 2000 or > 2100) from the index? Video blobs are untouched."))return;
            const all=JSON.parse(localStorage.getItem("ssa:sessions")||"[]");
            const valid=all.filter(s=>{const y=parseInt((s.date||"").slice(0,4));return y>=2000&&y<=2100;});
            const removed=all.length-valid.length;
            localStorage.setItem("ssa:sessions",JSON.stringify(valid));
            setSessions(valid);
            alert(`Removed ${removed} bad session(s). Reload the page then re-import your log files.`);
          }} style={{background:"#EF444420",border:"1px solid #EF444450",borderRadius:6,padding:"7px 14px",color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:600}}>
            🗑 Remove bad-date sessions
          </button>
          <button onClick={()=>{
            if(!confirm("Clear ALL local session metadata (log/event data)? Video blobs are untouched. You will need to re-import CSV and XML files."))return;
            // Remove all ssa:* keys except ssa:polar and ssa:syncOffsets
            const keep=new Set(["ssa:polar","ssa:syncOffsets"]);
            Object.keys(localStorage).filter(k=>k.startsWith("ssa:")&&!keep.has(k)).forEach(k=>localStorage.removeItem(k));
            // Clear IDB log_data and xml_data (but not videos)
            const req=indexedDB.open("ssa-db");
            req.onsuccess=e=>{
              const db=e.target.result;
              ["log_data","xml_data"].forEach(store=>{
                if(db.objectStoreNames.contains(store)){
                  db.transaction(store,"readwrite").objectStore(store).clear();
                }
              });
            };
            setSessions([]);setLogData(null);setXmlData(null);
            alert("Session metadata cleared. Reload the page then re-import your files.");
          }} style={{background:"#EF444410",border:"1px solid #EF444430",borderRadius:6,padding:"7px 14px",color:"#EF4444",cursor:"pointer",fontSize:11}}>
            🧹 Clear all session metadata
          </button>
          <button onClick={()=>{
            const lsKeys=Object.keys(localStorage).filter(k=>k.startsWith("ssa:"));
            const lsSize=lsKeys.reduce((s,k)=>s+(localStorage.getItem(k)||"").length,0);
            alert(`localStorage: ${lsKeys.length} keys, ~${(lsSize/1024).toFixed(1)} KB\nSessions: ${sessions.length}\nVideos: in IndexedDB (blobs not counted)`);
          }} style={{background:"#0F2030",border:"1px solid #1E3A5A",borderRadius:6,padding:"7px 14px",color:"#64748B",cursor:"pointer",fontSize:11}}>
            📊 Storage info
          </button>
        </div>
      </div>
    </>
  )
}
