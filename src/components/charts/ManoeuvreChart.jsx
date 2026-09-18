import React from "react";
import { nearestRow } from '../../lib/logRowLookup';

function ManoeuvreChart({tackJibes,logRows,width=400,height=140}){
  if(!tackJibes?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No manoeuvre data</div>;
  const valid=tackJibes.filter(t=>t.isValid!==false);
  const tacks=valid.filter(t=>t.isTack).length;
  const gybes=valid.filter(t=>!t.isTack).length;
  const invalid=tackJibes.length-valid.length;
  const pad={t:14,r:12,b:30,l:40};
  const W=width-pad.l-pad.r, H=height-pad.t-pad.b;
  const twsBins={"<8":0,"8-12":0,"12-16":0,"16-20":0,"20+":0};
  // nearestRow binary-searches the (time-ordered) log. This used to reduce() over
  // every row for every manoeuvre — 60 tacks against a 200k-row lidar day is 12M
  // comparisons, redone on each render. It also drops a manoeuvre further than 5
  // minutes from any sample, which the old scan happily binned as 0 kt.
  if(logRows?.length){valid.forEach(tj=>{const nearest=nearestRow(logRows,tj.utc);if(!nearest)return;const tws=nearest.tws||0;if(tws<8)twsBins["<8"]++;else if(tws<12)twsBins["8-12"]++;else if(tws<16)twsBins["12-16"]++;else if(tws<20)twsBins["16-20"]++;else twsBins["20+"]++;});}
  const bins=Object.entries(twsBins);
  const maxVal=Math.max(...bins.map(([,v])=>v),1);
  const bw=W/bins.length-4;
  return(
    <svg width="100%" viewBox={`0 0 ${width} ${height}`}>
      <text x={pad.l} y={10} fontSize="9" fill="#06B6D4">{tacks} tacks</text>
      <text x={pad.l+60} y={10} fontSize="9" fill="#8B5CF6">{gybes} gybes</text>
      {invalid>0&&<text x={pad.l+120} y={10} fontSize="9" fill="#EF4444">{invalid} invalid</text>}
      {bins.map(([label,val],i)=>{const x=pad.l+i*(bw+4);const barH=(val/maxVal)*H;return(<g key={label}><rect x={x} y={pad.t+H-barH} width={bw} height={barH} fill="#06B6D4" rx="2" opacity="0.8"/><text x={x+bw/2} y={pad.t+H+10} textAnchor="middle" fontSize="8" fill="#475569">{label}</text>{val>0&&<text x={x+bw/2} y={pad.t+H-barH-3} textAnchor="middle" fontSize="8" fill="#06B6D4">{val}</text>}</g>);})}
      <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
      <text x={pad.l+W/2} y={height-2} textAnchor="middle" fontSize="8" fill="#475569">TWS at manoeuvre (kn)</text>
    </svg>
  );
}

export { ManoeuvreChart };