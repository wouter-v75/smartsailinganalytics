// src/lib/polarCalc.js
// ─────────────────────────────────────────────────────────────────────────────
// Polar file parsing, spline interpolation, VMG target calculation and
// performance colouring — all pure functions, no React dependency.
// ─────────────────────────────────────────────────────────────────────────────

export const POLAR_KEY = "ssa:polar";

export function savePolarToLS(filename, data) {
  try { localStorage.setItem(POLAR_KEY, JSON.stringify({filename, entries:data.entries, tws:data.tws})); } catch{}
}
export function loadPolarFromLS() {
  try { const v=localStorage.getItem(POLAR_KEY); return v?preparePolar(JSON.parse(v)):null; } catch{return null;}
}

// ── Parse Expedition polar format ─────────────────────────────────────────────
// First line may start with ! (comment). Each data line:
//   TWS  TWA1 BSP1  TWA2 BSP2 ...  (tab or space separated pairs)
export function parsePolarFile(text) {
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('!')&&!l.startsWith('#'));
  if(lines.length < 2) throw new Error('Polar file too short');
  const entries = [];
  for(const line of lines){
    const vals = line.split(/[\t ,;]+/).map(Number);
    if(vals.length < 4 || isNaN(vals[0]) || vals[0] <= 0) continue;
    const tws = vals[0];
    const points = [];
    for(let i=1; i+1<vals.length; i+=2){
      const twa=vals[i], bsp=vals[i+1];
      if(!isNaN(twa)&&!isNaN(bsp)&&twa>=0&&twa<=180&&bsp>=0) points.push({twa,bsp});
    }
    if(points.length >= 2) entries.push({tws, points});
  }
  if(entries.length < 2) throw new Error('Need ≥2 TWS rows with (TWA,BSP) pairs');
  entries.sort((a,b)=>a.tws-b.tws);
  return preparePolar({entries, tws:entries.map(e=>e.tws)});
}

// ── Natural cubic spline ───────────────────────────────────────────────────────
export function buildSpline(pts) {
  const n=pts.length;
  if(n<2) return null;
  const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
  if(n===2){
    const b=(ys[1]-ys[0])/(xs[1]-xs[0]||1);
    return [{x0:xs[0],a:ys[0],b,c:0,d:0}];
  }
  const h=Array.from({length:n-1},(_,i)=>xs[i+1]-xs[i]);
  const alpha=Array(n).fill(0);
  for(let i=1;i<n-1;i++)
    alpha[i]=(3/h[i])*(ys[i+1]-ys[i])-(3/h[i-1])*(ys[i]-ys[i-1]);
  const l=Array(n).fill(1), mu=Array(n).fill(0), z=Array(n).fill(0);
  for(let i=1;i<n-1;i++){
    l[i]=2*(xs[i+1]-xs[i-1])-h[i-1]*mu[i-1];
    mu[i]=h[i]/l[i];
    z[i]=(alpha[i]-h[i-1]*z[i-1])/l[i];
  }
  const c=Array(n).fill(0), b=Array(n-1).fill(0), d=Array(n-1).fill(0);
  for(let j=n-2;j>=0;j--){
    c[j]=z[j]-mu[j]*c[j+1];
    b[j]=(ys[j+1]-ys[j])/h[j]-h[j]*(c[j+1]+2*c[j])/3;
    d[j]=(c[j+1]-c[j])/(3*h[j]);
  }
  return xs.slice(0,n-1).map((x0,i)=>({x0,a:ys[i],b:b[i],c:c[i],d:d[i]}));
}

export function evalSpline(segs, xMin, xMax, x) {
  x=Math.max(xMin,Math.min(xMax,x));
  let lo=0, hi=segs.length-1;
  while(lo<hi){const mid=(lo+hi+1)>>1; if(segs[mid].x0<=x)lo=mid; else hi=mid-1;}
  const {x0,a,b,c,d}=segs[lo]; const dx=x-x0;
  return Math.max(0, a+b*dx+c*dx*dx+d*dx*dx*dx);
}

// Golden-section maximisation of f over [lo, hi]
export function goldenMax(f, lo, hi, tol=0.1) {
  const phi=(Math.sqrt(5)-1)/2;
  let a=lo, b=hi;
  let x1=b-phi*(b-a), x2=a+phi*(b-a);
  let f1=f(x1), f2=f(x2);
  for(let i=0; i<80 && b-a>tol; i++){
    if(f1<f2){a=x1; x1=x2; f1=f2; x2=a+phi*(b-a); f2=f(x2);}
    else      {b=x2; x2=x1; f2=f1; x1=b-phi*(b-a); f1=f(x1);}
  }
  return (a+b)/2;
}

// Pre-compute splines and VMG targets for every TWS entry
export function preparePolar(raw) {
  if(!raw?.entries?.length) return raw;
  const enriched = raw.entries.map(entry=>{
    const pts = entry.points.map(p=>({x:p.twa, y:p.bsp}));
    const segs = buildSpline(pts);
    const xMin = pts[0].x, xMax = pts[pts.length-1].x;
    const bspAt = twa => segs ? evalSpline(segs, xMin, xMax, Math.abs(twa)) : 0;
    const twUp0 = pts.find(p=>p.x>0)?.x ?? 20;
    const upTwa   = goldenMax(twa => bspAt(twa)*Math.cos(twa*Math.PI/180), twUp0, Math.min(90,xMax));
    const twDn1   = Math.max(90, xMin);
    const downTwa = goldenMax(twa => bspAt(twa)*Math.cos((180-twa)*Math.PI/180), twDn1, xMax);
    const upVMG   = bspAt(upTwa)   * Math.cos(upTwa*Math.PI/180);
    const downVMG = bspAt(downTwa) * Math.cos((180-downTwa)*Math.PI/180);
    return {...entry, segs, pts, xMin, xMax, bspAt, upTwa, downTwa, upVMG, downVMG};
  });
  return {...raw, entries:enriched};
}

// BSP at (twsKt, twaDeg) — spline within TWS entry, linear blend between entries
export function polarInterp(polar, twsKt, twaDeg) {
  if(!polar?.entries?.length) return null;
  const {entries}=polar;
  let hi=entries.findIndex(e=>e.tws>=twsKt);
  if(hi<0) hi=entries.length-1;
  if(hi===0) hi=1;
  const lo=hi-1;
  const ft=Math.max(0,Math.min(1,(twsKt-entries[lo].tws)/((entries[hi].tws-entries[lo].tws)||1)));
  const bLo=entries[lo].bspAt?.(twaDeg)??0;
  const bHi=entries[hi].bspAt?.(twaDeg)??0;
  return Math.max(0, bLo+ft*(bHi-bLo));
}

// Optimal VMG angles — interpolated between bracketing TWS entries
export function polarVMGTarget(polar, twsKt) {
  if(!polar?.entries?.length) return {up:45, down:145, upVMG:0, downVMG:0};
  const {entries}=polar;
  let hi=entries.findIndex(e=>e.tws>=twsKt);
  if(hi<0) hi=entries.length-1;
  if(hi===0) hi=1;
  const lo=hi-1;
  const ft=Math.max(0,Math.min(1,(twsKt-entries[lo].tws)/((entries[hi].tws-entries[lo].tws)||1)));
  const lerp=(a,b)=>a+ft*(b-a);
  return {
    up:     lerp(entries[lo].upTwa,   entries[hi].upTwa),
    down:   lerp(entries[lo].downTwa, entries[hi].downTwa),
    upVMG:  lerp(entries[lo].upVMG,   entries[hi].upVMG),
    downVMG:lerp(entries[lo].downVMG, entries[hi].downVMG),
  };
}

// Performance % vs polar + mode (vmg or reach)
export function polarPerf(polar, bsp, twa, tws) {
  if(!polar||bsp==null||twa==null||tws==null||bsp<0.3) return null;
  const absA=Math.abs(twa);
  const target=polarVMGTarget(polar,tws);
  const {up,down,upVMG,downVMG}=target;
  const VMG_ZONE=20;
  const nearUp=Math.abs(absA-up)<=VMG_ZONE;
  const nearDn=Math.abs(absA-down)<=VMG_ZONE;
  if(nearUp||nearDn){
    const targVMG=nearUp?upVMG:downVMG;
    const actVMG=bsp*Math.cos((nearUp?absA:180-absA)*Math.PI/180);
    const pct=targVMG>0.001?(actVMG/targVMG)*100:100;
    return {mode:'vmg', pct:Math.max(0,Math.min(150,pct))};
  }
  const targBSP=polarInterp(polar,tws,absA)||0.01;
  return {mode:'reach', pct:Math.max(0,Math.min(150,(bsp/targBSP)*100))};
}

// 3-stop colour scale: red(90%) → lightgreen(100%) → darkgreen(110%)
export function perfColor(pct) {
  if(pct==null) return '#1E4080';
  const stops=[
    {p:70, r:127,g:0,  b:0  },
    {p:90, r:239,g:68, b:68 },
    {p:100,r:134,g:239,b:172},
    {p:110,r:21, g:128,b:61 },
    {p:130,r:21, g:128,b:61 },
  ];
  const c=Math.max(stops[0].p,Math.min(stops[stops.length-1].p,pct));
  for(let i=1;i<stops.length;i++){
    if(c<=stops[i].p){
      const t=(c-stops[i-1].p)/(stops[i].p-stops[i-1].p);
      const lr=(a,b)=>Math.round(a+(b-a)*t);
      return `rgb(${lr(stops[i-1].r,stops[i].r)},${lr(stops[i-1].g,stops[i].g)},${lr(stops[i-1].b,stops[i].b)})`;
    }
  }
  const s=stops[stops.length-1]; return `rgb(${s.r},${s.g},${s.b})`;
}
