
// Compute mode from video tags — determines which instrument overlay to show
function getVideoMode(tags){
  if(!tags?.length) return "upwind";
  if(tags.includes("race-start")) return "start";
  if(tags.includes("reach"))      return "reach";
  if(tags.includes("upwind")||tags.includes("downwind")) return "upwind";
  return "upwind";
}

// Apparent wind angle from true wind angle, true wind speed, boat speed
function calcAWA(twa,tws,bsp){
  if(twa==null||!tws||!bsp) return null;
  const absA=Math.abs(twa)*Math.PI/180;
  const fwd=bsp+tws*Math.cos(absA);
  const lat=tws*Math.sin(absA);
  const deg=Math.atan2(lat,fwd)*180/Math.PI;
  return twa<0?-deg:deg;
}

// Compass bearing in degrees from one lat/lon point to another (0–360, true).
// Uses a local-flat approximation, which is accurate to well under a degree
// over typical start-line distances (~hundreds of metres).
function bearingDeg(from,to){
  if(!from||!to) return null;
  const dy=to.lat-from.lat;
  const dx=(to.lon-from.lon)*Math.cos(from.lat*Math.PI/180);
  if(dx===0&&dy===0) return null;
  return ((Math.atan2(dx,dy)*180/Math.PI)+360)%360;
}

// Extract boat length in metres from name — e.g. "NORTHSTAR72" → 72 ft → 21.9 m
function extractBoatLengthM(boatName){
  const m=(boatName||"").match(/(\d+)/);
  if(m){const n=parseInt(m[1]);if(n>=20&&n<=150)return n*0.3048;}
  return 12; // fallback ~40 ft
}

// ─── CHART PRIMITIVES ─────────────────────────────────────────────────────────
function linReg(pts){
  const n=pts.length; if(n<2)return null;
  const mx=pts.reduce((s,p)=>s+p.x,0)/n;
  const my=pts.reduce((s,p)=>s+p.y,0)/n;
  const num=pts.reduce((s,p)=>s+(p.x-mx)*(p.y-my),0);
  const den=pts.reduce((s,p)=>s+(p.x-mx)**2,0);
  if(!den)return null;
  const slope=num/den, intercept=my-slope*mx;
  const ssTot=pts.reduce((s,p)=>s+(p.y-my)**2,0);
  const ssRes=pts.reduce((s,p)=>s+(p.y-(slope*p.x+intercept))**2,0);
  return{slope,intercept,r2:ssTot?1-ssRes/ssTot:0};
}

export { getVideoMode, calcAWA, bearingDeg, extractBoatLengthM, linReg };