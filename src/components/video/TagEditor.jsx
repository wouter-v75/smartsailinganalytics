'use client'
import React, { useState, useEffect } from "react";
import { updateVideoTags } from '../../lib/localStore';

function TagEditor({video, onSave, tagList=[], suggestionList, onTagListChange}){
  const[tags,    setTags]    = useState(video.tags||[]);
  const[input,   setInput]   = useState("");
  const[dirty,   setDirty]   = useState(false);
  const[listMode,setListMode]= useState(false);
  // Keyed on the clip, deliberately: this resets the editor when you move to a
  // different clip. Adding video.tags would also fire when the parent re-renders
  // with the same clip and discard a tag being typed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{setTags(video.tags||[]);setDirty(false);},[video.id]);
  const addTag = tag => {
    const t = tag.trim().toLowerCase();
    if(!t || tags.includes(t)) return;
    const next = [...tags, t];
    setTags(next); setDirty(true);
    if(!tagList.includes(t)) onTagListChange?.([...tagList, t].sort());
  };
  const remTag = t => { setTags(p=>p.filter(x=>x!==t)); setDirty(true); };
  const save = async () => {
    await updateVideoTags(video.id, tags);
    // AWAIT the parent's onSave — that's the path that pushes the new tags
    // to the cloud row. Previously the call was fire-and-forget, so if the
    // user clicked Save then refreshed within a second or two the in-flight
    // POST got cancelled by the navigation and the cloud row never updated.
    try { await Promise.resolve(onSave(video.id, tags)); } catch {}
    setDirty(false);
  };
  const deleteFromList = tag => { onTagListChange?.(tagList.filter(t => t !== tag)); };
  // "TAP TO ADD" pulls from the broader suggestion list when one is provided —
  // sessionTagList only contains tags that were added through this UI (or via
  // the <sailsused> import), so it misses tags applied directly to clips.
  // Fall back to tagList so the editor still works in older call sites.
  const suggestionSource = suggestionList && suggestionList.length ? suggestionList : tagList;
  const suggestions = suggestionSource.filter(t => !tags.includes(t));
  return(
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:"1px solid #1E3A5A"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
        <div style={{fontSize:9,fontWeight:700,color:"#475569",letterSpacing:2,textTransform:"uppercase"}}>Tags</div>
        <div style={{display:"flex",gap:5}}>
          {dirty&&<button onClick={save} style={{background:"#1D9E75",border:"none",borderRadius:4,padding:"2px 9px",color:"#fff",fontSize:10,cursor:"pointer",fontWeight:700}}>Save</button>}
          <button onClick={()=>setListMode(p=>!p)} style={{background:listMode?"#1E3A5A":"none",border:"1px solid #1E3A5A",borderRadius:4,padding:"2px 8px",color:"#64748B",fontSize:9,cursor:"pointer"}}>{listMode?"✕ Close":"☰ Tag list"}</button>
        </div>
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8,minHeight:24}}>
        {tags.map(t=>(<span key={t} onClick={()=>remTag(t)} style={{background:"#1E3A5A",color:"#7DD3FC",fontSize:10,borderRadius:4,padding:"2px 7px",cursor:"pointer",display:"flex",gap:3,alignItems:"center"}}>#{t}<span style={{color:"#EF4444",fontSize:9}}>×</span></span>))}
        {!tags.length&&<span style={{fontSize:10,color:"#334155"}}>No tags — click a suggestion or type below</span>}
      </div>
      {suggestions.length>0&&(
        <div style={{marginBottom:8}}>
          <div style={{fontSize:9,color:"#334155",letterSpacing:1,marginBottom:4}}>TAP TO ADD</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {suggestions.map(t=>(<button key={t} onClick={()=>addTag(t)} style={{background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:4,padding:"2px 7px",color:"#475569",fontSize:10,cursor:"pointer",fontFamily:"monospace"}}>+{t}</button>))}
          </div>
        </div>
      )}
      <div style={{display:"flex",gap:5}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter"){addTag(input);setInput("");} }} placeholder="Type a tag + Enter…" style={{flex:1,background:"#071624",border:"1px solid #1E3A5A",borderRadius:5,padding:"5px 8px",color:"#E2E8F0",fontSize:11,fontFamily:"monospace",outline:"none"}}/>
        <button onClick={()=>{addTag(input);setInput("");}} style={{background:"#06B6D4",border:"none",borderRadius:5,padding:"5px 11px",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12}}>+</button>
      </div>
      {listMode&&(
        <div style={{marginTop:10,borderTop:"1px solid #1E3A5A",paddingTop:10}}>
          <div style={{fontSize:9,color:"#475569",letterSpacing:1,marginBottom:6}}>SESSION TAG LIST — click × to remove from list</div>
          {tagList.length===0&&<div style={{fontSize:10,color:"#334155"}}>Empty — import an event file with &lt;sailsused&gt; to auto-populate, or add tags above.</div>}
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {tagList.map(t=>(<span key={t} style={{display:"flex",alignItems:"center",gap:3,background:"#0A1929",border:"1px solid #1E3A5A",borderRadius:4,padding:"2px 7px",fontSize:10,color:"#94A3B8"}}>{t}<span onClick={()=>deleteFromList(t)} style={{color:"#EF4444",fontSize:9,cursor:"pointer",marginLeft:2}}>×</span></span>))}
          </div>
        </div>
      )}
    </div>
  );
}

export { TagEditor };