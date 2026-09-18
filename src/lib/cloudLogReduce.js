// Shrinking a day's log to the copy that goes in the cloud.
//
// The full log is tens of MB — far over the upload route's limit — so the cloud copy is
// trimmed to the on-water window, downsampled, stripped of columns that carry nothing,
// rounded, and finally capped to a hard byte budget. The full-resolution log stays on
// the device that imported it.
//
// Lifted out of SmartSailingAnalytics_UI.jsx unchanged. It has to live here because the
// backfill script (scripts/cloud-log-reupload.ts) must produce EXACTLY what the app
// produces — a second implementation would drift, and the difference would be silent
// and in the data. It was also a hundred lines of untestable logic inside a
// nine-thousand-line component.

import { isLidarKey } from './flatLogParse'
import { slimRowForCloud } from './cloudLogRound'

export function reduceLogForCloud(logData,xmlData){
  const TARGET_MAX_ROWS=7000;
  const MARGIN_MS=30*60*1000;
  if(!logData?.rows?.length) return logData;
  let rows=logData.rows;

  // 1. Trim away dock time so only the on-water window is kept.
  let trimmed=null;

  // 1a. Preferred — bound the window by the event file's timestamps.
  if(xmlData){
    const utcs=[];
    for(const k of ['tackJibes','markRoundings','sailsUpEvents','raceGuns']){
      for(const e of (xmlData[k]||[])){
        if(typeof e?.utc==='number'&&isFinite(e.utc)) utcs.push(e.utc);
      }
    }
    if(utcs.length>=2){
      const lo=Math.min(...utcs)-MARGIN_MS, hi=Math.max(...utcs)+MARGIN_MS;
      const t=rows.filter(r=>r.utc>=lo&&r.utc<=hi);
      if(t.length) trimmed=t;
    }
  }

  // 1b. Fallback (no event file — not every team runs an onboard assistant):
  //     derive the window from boat movement. A boat on the dock with the
  //     logger still running reads BSP≈0 and SOG≈0; find the first and last
  //     rows where it is actually moving and keep a 30-min margin on each
  //     side, dropping the long dock stretches before and after sailing.
  if(!trimmed){
    const moving=r=>(r.bsp||0)>0.5||(r.sog||0)>1.0;
    let first=-1,last=-1;
    for(let i=0;i<rows.length;i++){ if(moving(rows[i])){ first=i; break; } }
    for(let i=rows.length-1;i>=0;i--){ if(moving(rows[i])){ last=i; break; } }
    if(first>=0&&last>=first){
      const lo=rows[first].utc-MARGIN_MS, hi=rows[last].utc+MARGIN_MS;
      const t=rows.filter(r=>r.utc>=lo&&r.utc<=hi);
      if(t.length) trimmed=t;
    }
  }

  if(trimmed) rows=trimmed;

  // 2. Downsample — ≥1s between rows, and never more than TARGET_MAX_ROWS
  //    (the interval widens for very long sessions so the cap always holds).
  const span=rows.length>1?rows[rows.length-1].utc-rows[0].utc:0;
  const interval=Math.max(1000,Math.ceil(span/TARGET_MAX_ROWS));
  let out=[];
  let lastUtc=-Infinity;
  for(const r of rows){
    if(r.utc-lastUtc>=interval){ out.push(r); lastUtc=r.utc; }
  }

  // 3. Shrink the ROW SCHEMA. Capping the row COUNT alone was never enough: the
  //    payload size is rows × columns, and the column set grows every time a boat's
  //    export gains channels. At 71 fields, 7000 rows serialises to ~7 MB — over the
  //    4.5 MB request-body limit — so the session PUT 413s and the log silently ends
  //    up "saved on this device only". That is the bug this fixes; it had already
  //    been failing at ~5.7 MB before the 2026-07 export added 16 more columns.
  //
  //    3a. Drop columns that are null in EVERY row. A given boat only populates a
  //        subset of the union schema (no MastAng/Rake/Vang in the N76 export, etc.),
  //        so this is free — it removes keys that carry no information at all.
  //        Lidar sail-shape keys (up to 57 per row on the 2026-09 4 Hz export) are left out
  //        too: they would halve the rows everyone else gets. The importing device stores
  //        full-log phase stats with the lidar means, which is how other devices see them.
  const keep=new Set(['utc']);
  for(const r of out){
    for(const k in r){ if(r[k]!=null && !keep.has(k) && !isLidarKey(k)) keep.add(k); }
  }
  //    3b. Round floats. Instrument data is meaningless past 2 dp, and a raw
  //        parseFloat can serialise as 9.100000000000001 — 18 chars for one number.
  //        POSITION is the exception and keeps five (see lib/cloudLogRound): 0.01° of
  //        latitude is 1.1 km, and a day rounded to that is a staircase, not a track.
  out=out.map(r=>slimRowForCloud(r, keep));

  //    3c. Hard byte budget. Whatever the schema, the payload must fit — so if it
  //        still doesn't, halve the row count until it does rather than let the PUT
  //        fail. Time resolution degrades gracefully; the full log stays on-device.
  //        4 MB (inside the 4.5 MB limit) rather than something more timid: the cloud
  //        log is what drives the video overlay on OTHER devices, so row spacing is
  //        worth paying for — 4 MB holds a 4 h session at 3 s, 3.5 MB would halve it
  //        again to 6 s and make the overlay visibly steppy.
  const BUDGET=4_000_000;
  const bytes=rs=>JSON.stringify(rs).length;
  while(out.length>500 && bytes(out)>BUDGET){
    out=out.filter((_,i)=>i%2===0);
  }

  return{
    ...logData,
    rows:out,
    startUtc:out[0]?.utc??logData.startUtc,
    endUtc:out[out.length-1]?.utc??logData.endUtc,
  };
}
