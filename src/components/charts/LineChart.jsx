'use client'
import React, { useRef } from "react";
import { linReg } from '../../lib/sailMath';
import { useTz } from '../ssa/TzContext';
import { hmLocal } from '../ssa/format';

// ─── INTERACTIVE LINE CHART ───────────────────────────────────────────────────
// viewRange = [utcMs, utcMs] | null (null = show all data)
// onViewRange(newRange | null) — lifted state for cross-chart sync
function LineChart({points,color="#06B6D4",height=120,yLabel="",yMin,yMax,
                   yLines=[],showTrend=false,events=[],playUtc=null,
                   viewRange=null,onViewRange=null,sections=[],unit=""}){
  const tz=useTz();
  const svgRef  = useRef(null);
  const dragRef = useRef(null);   // {startSvgX, startVR:[x0,x1]} while dragging
  const touchRef= useRef(null);   // touch state
  // Stable unique id for clip path — avoids conflicts when multiple instances render
  const clipId  = useRef('lc'+Math.random().toString(36).slice(2,8)).current;

  if(!points?.length) return <div style={{height,display:"flex",alignItems:"center",justifyContent:"center",color:"#1E3A5A",fontSize:10}}>No data</div>;

  const VB_W=400;  // logical viewBox width
  // With sections chosen, the left gutter widens to hold each one's average — the
  // number is the point of picking two stretches, so it belongs beside the picture
  // rather than under it.
  const pad={t:14,r:8,b:28,l:sections.length?86:36};
  const W=VB_W-pad.l-pad.r, H=height-pad.t-pad.b;

  // Full data range
  const allX0=points[0].x, allX1=points[points.length-1].x;
  const fullSpan=allX1-allX0||1;

  // Visible range
  const [vx0,vx1] = viewRange ?? [allX0,allX1];
  const span = vx1-vx0 || 1;

  // Filter to visible + 5% buffer (keeps lines continuous at edges)
  const buf=span*0.05;
  // Number.isFinite(p.y): drop NaN/undefined samples — one poisons Math.min/max
  // for the y-domain, making yTicks (gridline <line>s) and the data path all NaN.
  const visPts = points.filter(p=>p.x>=vx0-buf&&p.x<=vx1+buf&&Number.isFinite(p.y));

  // y scale from visible data
  const visY=visPts.map(p=>p.y);
  const y0=yMin??(visY.length?Math.min(...visY):0);
  const y1=yMax??(visY.length?Math.max(...visY)||1:1);

  const px=x=>pad.l+((x-vx0)/span)*W;
  const py=y=>pad.t+H-((y-y0)/((y1-y0)||1))*H;
  const d=visPts.map((p,i)=>`${i===0?"M":"L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");

  const xTicks=Array.from({length:5},(_,i)=>vx0+span*i/4);
  const yTicks=Array.from({length:4},(_,i)=>y0+(y1-y0)*i/3);

  // Trend line from visible points only
  const reg=showTrend&&visPts.length>1?linReg(visPts.map(p=>({x:(p.x-vx0)/span,y:p.y}))):null;
  const ty=t=>reg?reg.slope*t+reg.intercept:0;

  // One average per section, in the section's own colour. Computed from the points,
  // not the visible window: a section keeps its number when the chart is panned.
  const sectionAvgs=sections.map(sec=>{
    const ys=points.filter(pt=>Number.isFinite(pt.y)&&pt.x>=sec.range[0]&&pt.x<=sec.range[1]).map(pt=>pt.y);
    return {...sec, mean: ys.length? ys.reduce((a,b)=>a+b,0)/ys.length : null, n: sec.n};
  });
  const decimals=Math.abs(y1-y0)>=20?0:1;

  const visEvents=events.filter(e=>e.utc>=vx0&&e.utc<=vx1);
  const isZoomed=viewRange&&(vx0>allX0||vx1<allX1);

  // ── Coordinate helpers ────────────────────────────────────────────────────
  const getSvgX=e=>{
    const rect=svgRef.current?.getBoundingClientRect();
    if(!rect)return 0;
    return ((e.clientX-rect.left)/rect.width)*VB_W;
  };

  // ── Mouse event handlers ──────────────────────────────────────────────────
  const onWheel=e=>{
    if(!onViewRange)return;
    e.preventDefault();
    const factor=e.deltaY>0?1.3:1/1.3;
    const svgX=getSvgX(e);
    const frac=Math.max(0,Math.min(1,(svgX-pad.l)/W));
    const pivot=vx0+frac*span;
    const newSpan=Math.max(60000,Math.min(fullSpan,span*factor));
    let nx0=pivot-frac*newSpan;
    let nx1=nx0+newSpan;
    if(nx0<allX0){nx0=allX0;nx1=allX0+newSpan;}
    if(nx1>allX1){nx1=allX1;nx0=allX1-newSpan;}
    onViewRange(newSpan>=fullSpan*0.999?null:[nx0,nx1]);
  };
  const onMouseDown=e=>{
    if(!onViewRange||e.button!==0)return;
    dragRef.current={startSvgX:getSvgX(e),startVR:[vx0,vx1]};
    e.currentTarget.style.cursor="grabbing";
  };
  const onMouseMove=e=>{
    if(!dragRef.current||!onViewRange)return;
    const {startSvgX,startVR}=dragRef.current;
    const shift=-((getSvgX(e)-startSvgX)/W)*span;
    const s=startVR[1]-startVR[0];
    let nx0=startVR[0]+shift, nx1=startVR[1]+shift;
    if(nx0<allX0){nx0=allX0;nx1=allX0+s;}
    if(nx1>allX1){nx1=allX1;nx0=allX1-s;}
    onViewRange([nx0,nx1]);
  };
  const onMouseUp=e=>{
    dragRef.current=null;
    if(e.currentTarget)e.currentTarget.style.cursor="grab";
  };

  // ── Touch handlers ────────────────────────────────────────────────────────
  const onTouchStart=e=>{
    if(!onViewRange)return;
    if(e.touches.length===1){
      touchRef.current={type:"pan",startX:e.touches[0].clientX,startVR:[vx0,vx1]};
    } else if(e.touches.length===2){
      const dist=Math.abs(e.touches[0].clientX-e.touches[1].clientX);
      const midX=(e.touches[0].clientX+e.touches[1].clientX)/2;
      const rect=svgRef.current?.getBoundingClientRect();
      const svgMid=rect?((midX-rect.left)/rect.width)*VB_W:VB_W/2;
      touchRef.current={type:"pinch",dist,startVR:[vx0,vx1],svgMid};
    }
  };
  const onTouchMove=e=>{
    if(!touchRef.current||!onViewRange)return;
    e.preventDefault();
    const rect=svgRef.current?.getBoundingClientRect();
    if(!rect)return;
    const ratio=VB_W/rect.width;
    const {type,startVR}=touchRef.current;
    const s=startVR[1]-startVR[0];
    if(type==="pan"&&e.touches.length===1){
      const dx=(e.touches[0].clientX-touchRef.current.startX)*ratio;
      const shift=-(dx/W)*s;
      let nx0=startVR[0]+shift, nx1=startVR[1]+shift;
      if(nx0<allX0){nx0=allX0;nx1=allX0+s;}
      if(nx1>allX1){nx1=allX1;nx0=allX1-s;}
      onViewRange([nx0,nx1]);
    } else if(type==="pinch"&&e.touches.length===2){
      const dist=Math.abs(e.touches[0].clientX-e.touches[1].clientX);
      const factor=touchRef.current.dist/(dist||1);
      const newSpan=Math.max(60000,Math.min(fullSpan,s*factor));
      const frac=(touchRef.current.svgMid-pad.l)/W;
      const pivot=startVR[0]+frac*s;
      let nx0=Math.max(allX0,pivot-frac*newSpan);
      let nx1=Math.min(allX1,nx0+newSpan);
      onViewRange(newSpan>=fullSpan*0.999?null:[nx0,nx1]);
    }
  };
  const onTouchEnd=()=>{touchRef.current=null;};

  return(
    <div style={{position:"relative",userSelect:"none"}}>
      {isZoomed&&onViewRange&&(
        <button onClick={()=>onViewRange(null)} style={{
          position:"absolute",top:2,right:2,zIndex:2,
          background:"#1E3A5A",border:"1px solid #2D4A6A",borderRadius:4,
          padding:"2px 7px",color:"#94A3B8",fontSize:9,cursor:"pointer",fontFamily:"monospace"
        }}>↩ all</button>
      )}
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${VB_W} ${height}`}
        style={{overflow:"visible",cursor:onViewRange?"grab":"default",display:"block"}}
        onWheel={onViewRange?onWheel:undefined}
        onMouseDown={onViewRange?onMouseDown:undefined}
        onMouseMove={onViewRange?onMouseMove:undefined}
        onMouseUp={onViewRange?onMouseUp:undefined}
        onMouseLeave={onViewRange?onMouseUp:undefined}
        onTouchStart={onViewRange?onTouchStart:undefined}
        onTouchMove={onViewRange?onTouchMove:undefined}
        onTouchEnd={onViewRange?onTouchEnd:undefined}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={pad.l} y={pad.t-2} width={W} height={H+4}/>
          </clipPath>
        </defs>
        {/* Each chosen section as a band in its own colour, behind the data */}
        {sections.map(sec=>{
          const a=Math.max(sec.range[0],vx0), b=Math.min(sec.range[1],vx1);
          if(!(b>a)) return null;
          return <rect key={sec.id} x={px(a)} y={pad.t} width={Math.max(1,px(b)-px(a))} height={H}
            fill={sec.color} opacity="0.10"/>;
        })}
        {/* Averages, in the gutter, each in its section's colour */}
        {sectionAvgs.map((sec,i)=>(
          <g key={"avg"+sec.id}>
            <rect x={4} y={pad.t+i*16} width={9} height={9} rx={2} fill={sec.color}/>
            <text x={pad.l-8} y={pad.t+i*16+9} textAnchor="end" fontSize="11" fill={sec.color} fontWeight="700">
              {sec.mean==null?"—":sec.mean.toFixed(decimals)}{sec.mean==null?"":unit}
            </text>
            <text x={17} y={pad.t+i*16+9} textAnchor="start" fontSize="9" fill="#64748B">{sec.n}</text>
          </g>
        ))}
        {/* Grid lines */}
        {yTicks.map((y,i)=><line key={i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke="#0F2030" strokeWidth="1"/>)}
        {yLines.map((y,i)=><line key={"r"+i} x1={pad.l} x2={pad.l+W} y1={py(y)} y2={py(y)} stroke={color} strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5"/>)}
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
        <line x1={pad.l} x2={pad.l+W} y1={pad.t+H} y2={pad.t+H} stroke="#1E3A5A" strokeWidth="1"/>
        {/* Data — clipped so it never bleeds outside the plot area */}
        <g clipPath={`url(#${clipId})`}>
          <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" opacity={sections.length?0.35:0.9}/>
          {/* The trace inside each section, in that section's colour, so the picture
              and the figure beside it are obviously the same stretch. */}
          {sections.map(sec=>{
            const inside=visPts.filter(pt=>pt.x>=sec.range[0]&&pt.x<=sec.range[1]);
            if(inside.length<2) return null;
            const dd=inside.map((pt,i)=>`${i===0?"M":"L"}${px(pt.x).toFixed(1)},${py(pt.y).toFixed(1)}`).join(" ");
            return <path key={sec.id} d={dd} fill="none" stroke={sec.color} strokeWidth="1.8" strokeLinejoin="round"/>;
          })}
          {reg&&<line x1={px(vx0)} y1={py(ty(0))} x2={px(vx1)} y2={py(ty(1))} stroke="#fff" strokeWidth="1" strokeDasharray="4,3" opacity="0.5"/>}
          {/* Playback cursor */}
          {playUtc&&playUtc>=vx0&&playUtc<=vx1&&(()=>{
            const cx=px(playUtc);
            return(<g key="cursor">
              <line x1={cx} x2={cx} y1={pad.t} y2={pad.t+H} stroke="#F59E0B" strokeWidth="1.5" opacity="0.9"/>
              <polygon points={`${cx-4},${pad.t} ${cx+4},${pad.t} ${cx},${pad.t+7}`} fill="#F59E0B" opacity="0.9"/>
            </g>);
          })()}
          {/* Event markers */}
          {visEvents.map((e,i)=>{
            const ex=px(e.utc);
            const anchor=ex>pad.l+W*0.7?"end":"start";
            const lw=(e.label||"").length*4.5+4;
            return(<g key={"ev"+i}>
              <line x1={ex} x2={ex} y1={pad.t} y2={pad.t+H} stroke={e.color||"#64748B"} strokeWidth="1" strokeDasharray="3,2" opacity="0.8"/>
              <rect x={anchor==="start"?ex+2:ex-2-lw} y={pad.t+1} width={lw} height="10" rx="2" fill="rgba(3,15,26,0.9)"/>
              <text x={anchor==="start"?ex+4:ex-4} y={pad.t+9} textAnchor={anchor} fontSize="7" fill={e.color||"#94A3B8"} fontFamily="monospace">{e.label}</text>
            </g>);
          })}
        </g>
        {/* Axis labels (outside clip) */}
        {reg&&<text x={pad.l+W-2} y={pad.t+6} textAnchor="end" fontSize="8" fill="#64748B">R²={reg.r2.toFixed(2)}</text>}
        {yTicks.map((y,i)=><text key={i} x={pad.l-4} y={py(y)+3} textAnchor="end" fontSize="8" fill="#475569">{y.toFixed(y<10?1:0)}</text>)}
        {xTicks.map((x,i)=><text key={i} x={Math.max(pad.l+2,Math.min(pad.l+W-2,px(x)))} y={pad.t+H+14} textAnchor="middle" fontSize="8" fill="#475569">{hmLocal(x,tz)}</text>)}
        {yLabel&&<text x={8} y={pad.t+H/2} textAnchor="middle" fontSize="8" fill="#475569" transform={`rotate(-90,8,${pad.t+H/2})`}>{yLabel}</text>}
        {/* Zoom-progress minimap bar at bottom */}
        {isZoomed&&(()=>{
          const bx=pad.l, bw=W, by=pad.t+H+22, bh=3;
          const hx=bx+((vx0-allX0)/fullSpan)*bw;
          const hw=((vx1-vx0)/fullSpan)*bw;
          return(<g>
            <rect x={bx} y={by} width={bw} height={bh} fill="#0F2030" rx="1"/>
            <rect x={hx} y={by} width={Math.max(4,hw)} height={bh} fill={color} rx="1" opacity="0.7"/>
          </g>);
        })()}
      </svg>
    </div>
  );
}

export { LineChart };