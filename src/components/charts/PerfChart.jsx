'use client'
import React, { useRef, useMemo } from "react";
import { useTz } from '../ssa/TzContext';
import { EMPTY } from '../ssa/constants';
import { hmLocal } from '../ssa/format';

function PerfChart({rows,width=400,height=110,viewRange=null,onViewRange=null,playUtc=null,sections=[]}){
  const tz=useTz();
  const svgRef=useRef(null);
  const dragRef=useRef(null);
  const clipId=useRef('pc'+Math.random().toString(36).slice(2,8)).current;
  // Two full filters plus two more over the survivors, on every render — and playUtc
  // re-renders this chart continuously during playback. Memoised on the rows, and
  // above the early returns so the hook count stays fixed. `hasPerf` replaces the
  // old length checks on the intermediate arrays, which no longer need to exist.
  const {polPts,tgtPts,hasPerf}=useMemo(()=>{
    const src=rows||EMPTY;
    const step=Math.max(1,Math.floor(src.length/300));
    const pol=[],tgt=[];
    let nPol=0,nTgt=0;
    for(const r of src){
      const okPol=r.vsPerfPct>5&&r.vsPerfPct<200;
      const okTgt=r.vsTargPct>5&&r.vsTargPct<200;
      if(okPol&&nPol++%step===0) pol.push({x:r.utc,y:r.vsPerfPct});
      if(okTgt&&nTgt++%step===0) tgt.push({x:r.utc,y:r.vsTargPct});
    }
    return {polPts:pol,tgtPts:tgt,hasPerf:nPol>0||nTgt>0};
  },[rows]);
  if(!rows?.length)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No data</div>;
  if(!hasPerf)return<div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No performance data in log</div>;
  // Room in the gutter for each section's average, as on the charts above.
  const pad={t:14,r:8,b:28,l:sections.length?86:36};
  const W=width-pad.l-pad.r, H=height-pad.t-pad.b;
  const allPts=[...polPts,...tgtPts];
  if(!allPts.length)return null;
  const allX0=Math.min(...allPts.map(p=>p.x)),allX1=Math.max(...allPts.map(p=>p.x));
  const fullSpan=allX1-allX0||1;
  const [vx0,vx1]=viewRange??[allX0,allX1];
  const span=vx1-vx0||1;
  const buf=span*0.05;
  const visPol=polPts.filter(p=>p.x>=vx0-buf&&p.x<=vx1+buf&&Number.isFinite(p.y));
  const visTgt=tgtPts.filter(p=>p.x>=vx0-buf&&p.x<=vx1+buf&&Number.isFinite(p.y));
  const y0=50,y1=150;
  const px=x=>pad.l+((x-vx0)/span)*W;
  const py=y=>pad.t+H-((y-y0)/(y1-y0))*H;
  const mkLine=pts=>pts.length<2?"":pts.map((p,i)=>`${i===0?"M":"L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const xTicks=Array.from({length:5},(_,i)=>vx0+span*i/4);
  const yTicks=[60,80,100,120,140];
  // vs polar is the figure people compare between two stretches, so that is the one
  // printed beside the chart.
  const sectionAvgs=sections.map(sec=>{
    const ys=polPts.filter(pt=>pt.x>=sec.range[0]&&pt.x<=sec.range[1]&&Number.isFinite(pt.y)).map(pt=>pt.y);
    return {...sec, mean: ys.length? ys.reduce((a,b)=>a+b,0)/ys.length : null};
  });
  const isZoomed=viewRange&&(vx0>allX0||vx1<allX1);
  // Reuse same pan/zoom logic as LineChart
  const VB_W=width;
  const getSvgX=e=>{const rect=svgRef.current?.getBoundingClientRect();if(!rect)return 0;return((e.clientX-rect.left)/rect.width)*VB_W;};
  const onWheel=e=>{if(!onViewRange)return;e.preventDefault();const factor=e.deltaY>0?1.3:1/1.3;const svgX=getSvgX(e);const frac=Math.max(0,Math.min(1,(svgX-pad.l)/W));const pivot=vx0+frac*span;const newSpan=Math.max(60000,Math.min(fullSpan,span*factor));let nx0=pivot-frac*newSpan,nx1=nx0+newSpan;if(nx0<allX0){nx0=allX0;nx1=allX0+newSpan;}if(nx1>allX1){nx1=allX1;nx0=allX1-newSpan;}onViewRange(newSpan>=fullSpan*0.999?null:[nx0,nx1]);};
  const onMouseDown=e=>{if(!onViewRange||e.button!==0)return;dragRef.current={startSvgX:getSvgX(e),startVR:[vx0,vx1]};e.currentTarget.style.cursor="grabbing";};
  const onMouseMove=e=>{if(!dragRef.current||!onViewRange)return;const{startSvgX,startVR}=dragRef.current;const shift=-((getSvgX(e)-startSvgX)/W)*span;const s=startVR[1]-startVR[0];let nx0=startVR[0]+shift,nx1=startVR[1]+shift;if(nx0<allX0){nx0=allX0;nx1=allX0+s;}if(nx1>allX1){nx1=allX1;nx0=allX1-s;}onViewRange([nx0,nx1]);};
  const onMouseUp=e=>{dragRef.current=null;if(e.currentTarget)e.currentTarget.style.cursor="grab";};
  return(
    <div style={{position:"relative",userSelect:"none"}}>
      {isZoomed&&onViewRange&&(<button onClick={()=>onViewRange(null)} style={{position:"absolute",top:2,right:2,zIndex:2,background:"#1E3A5A",border:"1px solid #2D4A6A",borderRadius:4,padding:"2px 7px",color:"#94A3B8",fontSize:9,cursor:"pointer",fontFamily:"monospace"}}>↩ all</button>)}
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${width} ${height}`} style={{overflow:"visible",cursor:onViewRange?"grab":"default",display:"block"}}
        onWheel={onViewRange?onWheel:undefined} onMouseDown={onViewRange?onMouseDown:undefined} onMouseMove={onViewRange?onMouseMove:undefined} onMouseUp={onViewRange?onMouseUp:undefined} onMouseLeave={onViewRange?onMouseUp:undefined}>
        <defs><clipPath id={clipId}><rect x={pad.l} y={pad.t-2} width={W} height={H+4}/></clipPath></defs>
        {sections.map(sec=>{
          const a=Math.max(sec.range[0],vx0), b=Math.min(sec.range[1],vx1);
          if(!(b>a)) return null;
          return <rect key={sec.id} x={px(a)} y={pad.t} width={Math.max(1,px(b)-px(a))} height={H} fill={sec.color} opacity="0.10"/>;
        })}
        {sectionAvgs.map((sec,i)=>(
          <g key={"avg"+sec.id}>
            <rect x={4} y={pad.t+i*16} width={9} height={9} rx={2} fill={sec.color}/>
            <text x={pad.l-8} y={pad.t+i*16+9} textAnchor="end" fontSize="11" fill={sec.color} fontWeight="700">
              {sec.mean==null?"—":`${sec.mean.toFixed(0)}%`}
            </text>
            <text x={17} y={pad.t+i*16+9} textAnchor="start" fontSize="9" fill="#64748B">{sec.n}</text>
          </g>
        ))}
        {yTicks.map(y=><line key={y} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke={y===100?"#475569":"#0F2030"} strokeWidth={y===100?"1":"0.5"} strokeDasharray={y===100?"4,2":"none"}/>)}
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
        <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
        <g clipPath={`url(#${clipId})`}>
          {visPol.length>1&&<path d={mkLine(visPol)} fill="none" stroke="#22C55E" strokeWidth="1.5" strokeLinejoin="round" opacity={sections.length?0.3:0.9}/>}
          {sections.map(sec=>{
            const inside=visPol.filter(pt=>pt.x>=sec.range[0]&&pt.x<=sec.range[1]);
            return inside.length<2?null:<path key={sec.id} d={mkLine(inside)} fill="none" stroke={sec.color} strokeWidth="1.8" strokeLinejoin="round"/>;
          })}
          {visTgt.length>1&&<path d={mkLine(visTgt)} fill="none" stroke="#22C55E" strokeWidth="1.5" strokeLinejoin="round" opacity="0.7"/>}
          {playUtc&&playUtc>=vx0&&playUtc<=vx1&&(()=>{const cx=px(playUtc);return(<g><line x1={cx} x2={cx} y1={pad.t} y2={pad.t+H} stroke="#F59E0B" strokeWidth="1.5" opacity="0.9"/><polygon points={`${cx-4},${pad.t} ${cx+4},${pad.t} ${cx},${pad.t+7}`} fill="#F59E0B" opacity="0.9"/></g>);})()}
          {isZoomed&&(()=>{const bx=pad.l,bw=W,by=pad.t+H+22,bh=3;const hx=bx+((vx0-allX0)/fullSpan)*bw;const hw=((vx1-vx0)/fullSpan)*bw;return(<g><rect x={bx} y={by} width={bw} height={bh} fill="#0F2030" rx="1"/><rect x={hx} y={by} width={Math.max(4,hw)} height={bh} fill="#F59E0B" rx="1" opacity="0.7"/></g>);})()}
        </g>
        {yTicks.map(y=><text key={y} x={pad.l-4} y={py(y)+3} textAnchor="end" fontSize="8" fill="#475569">{y}</text>)}
        {xTicks.map((x,i)=><text key={i} x={Math.max(pad.l+2,Math.min(pad.l+W-2,px(x)))} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill="#475569">{hmLocal(x,tz)}</text>)}
        {polPts.length>0&&<><rect x={pad.l+4} y={4} width="8" height="5" fill="#22C55E" rx="1"/><text x={pad.l+15} y={9} fontSize="8" fill="#22C55E">Polar %</text></>}
        {tgtPts.length>0&&<><rect x={pad.l+60} y={4} width="8" height="5" fill="#22C55E" rx="1"/><text x={pad.l+71} y={9} fontSize="8" fill="#22C55E">Target %</text></>}
      </svg>
    </div>
  );
}

export { PerfChart };