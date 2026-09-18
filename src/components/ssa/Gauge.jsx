'use client'
import React from "react";
import { useIsMobile } from './useIsMobile';

function Gauge({label,value,/* unit kept for call-site back-compat — not rendered */ unit:_unit,color="#06B6D4",size="md",highlight=false}){
  // Gauge is only used for the on-video instrument overlay. On phones the
  // desktop sizing covers half the frame, so shrink everything ~40 %. Units
  // (kn / true / vs polar / etc.) are intentionally not rendered — the
  // label already conveys the dimension and the cluster reads cleaner
  // without the secondary line.
  const isMobile = useIsMobile();
  const baseFs = size==="lg"?28:size==="sm"?16:22;
  const fs     = isMobile ? Math.round(baseFs*0.6) : baseFs;
  const labelFs= isMobile ? 7 : 9;
  const minW   = isMobile
    ? (size==="lg"?54:size==="sm"?38:46)
    : (size==="lg"?90:size==="sm"?58:76);
  const pad    = isMobile
    ? (size==="sm"?"2px 5px":"3px 6px")
    : (size==="sm"?"5px 9px":"7px 11px");
  return(
    <div style={{background:highlight?"rgba(239,68,68,0.18)":"rgba(0,0,0,0.75)",border:`1px solid ${highlight?"#EF4444":color}40`,borderRadius:isMobile?5:7,padding:pad,minWidth:minW}}>
      <div style={{fontSize:labelFs,color:"#64748B",letterSpacing:isMobile?1:2,textTransform:"uppercase",marginBottom:isMobile?0:2}}>{label}</div>
      <div style={{fontSize:fs,fontWeight:700,color:highlight?"#EF4444":color,fontFamily:"'Courier New',monospace",lineHeight:1}}>{value}</div>
    </div>
  );
}

export { Gauge };