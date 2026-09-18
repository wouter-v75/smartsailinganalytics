
// Rotation is applied at DISPLAY, never baked into the file. 90/270 swap the aspect,
// so the element is rotated about its centre and scaled to fit the box.
const rotStyle = (deg, boxW, boxH) => {
  const d = ((Number(deg) || 0) % 360 + 360) % 360;
  if (!d) return {};
  const quarter = d === 90 || d === 270;
  const scale = quarter && boxW && boxH ? Math.min(boxW / boxH, boxH / boxW) : 1;
  return { transform: `rotate(${d}deg)${quarter ? ` scale(${scale.toFixed(3)})` : ''}` };
};

const R=(n,d=1)=>(n==null||isNaN(n))?"--":Number(n).toFixed(d);

const fmtT=s=>{const x=Math.max(0,Math.floor(s));return`${String(Math.floor(x/60)).padStart(2,"0")}:${String(x%60).padStart(2,"0")}`;};

const hmLocal  = (u,tz=0)=>u?new Date(u+tz*60000).toISOString().slice(11,16):"--:--";

const hmsLocal = (u,tz=0)=>u?new Date(u+tz*60000).toISOString().slice(11,19):"--:--:--";

const fmtDate=d=>{if(!d)return"";const p=d.split("-");return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:d;};

const fmtDateTime=u=>{if(!u)return"";const dt=new Date(u);const dd=String(dt.getUTCDate()).padStart(2,"0");const mm=String(dt.getUTCMonth()+1).padStart(2,"0");const yyyy=dt.getUTCFullYear();const hh=String(dt.getUTCHours()).padStart(2,"0");const mi=String(dt.getUTCMinutes()).padStart(2,"0");return`${dd}/${mm}/${yyyy} ${hh}:${mi}`;};

const fmtSize=b=>b>1e9?`${(b/1e9).toFixed(1)} GB`:`${(b/1e6).toFixed(0)} MB`;

// Phase B — Crop status banner.
// The UI lives in the video player toolbar now (mark with red lines on
// the timeline via Delete-UPTO/FROM buttons, commit via Save). All this
// component does is surface errors and the "no local blob" warning in
// the sidebar; it renders nothing when the crop is healthy / idle.
function fmtMmSsLong(secs){
  if (secs == null || !isFinite(secs)) return "—";
  const m = Math.floor(secs/60);
  const s = secs - m*60;
  return `${m}:${s.toFixed(s%1?1:0).padStart(s%1?4:2,"0")}`;
}

export { rotStyle, R, fmtT, hmLocal, hmsLocal, fmtDate, fmtDateTime, fmtSize, fmtMmSsLong };