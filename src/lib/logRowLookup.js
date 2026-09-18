'use client'
import React from "react";

function nearestRow(rows,utc){if(!rows?.length)return null;let lo=0,hi=rows.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(rows[mid].utc<utc)lo=mid+1;else hi=mid;}if(lo>0&&Math.abs(rows[lo-1].utc-utc)<Math.abs(rows[lo].utc-utc))lo--;return Math.abs(rows[lo].utc-utc)<300000?rows[lo]:null;}

// Like nearestRow, but linearly interpolates between the two bracketing log
// samples instead of snapping to the nearest. The session log is sampled
// every ~1-2s; snapping makes the video overlay hang on one value until the
// next sample. Interpolation gives a smooth, continuously-moving readout.
function interpRow(rows,utc){
  if(!rows?.length)return null;
  const last=rows.length-1;
  if(utc<=rows[0].utc)   return Math.abs(rows[0].utc-utc)<300000?rows[0]:null;
  if(utc>=rows[last].utc)return Math.abs(rows[last].utc-utc)<300000?rows[last]:null;
  // Largest index with rows[lo].utc <= utc (utc is strictly interior here).
  let lo=0,hi=last;
  while(lo<hi){const mid=(lo+hi+1)>>1;if(rows[mid].utc<=utc)lo=mid;else hi=mid-1;}
  const a=rows[lo],b=rows[lo+1];
  if(!b)return a;
  const span=b.utc-a.utc;
  if(span<=0)return a;
  const f=(utc-a.utc)/span;
  // Interpolate every numeric field; snap non-numeric / null fields to the
  // nearer sample.
  const out={};
  for(const k in a){
    const av=a[k],bv=b[k];
    if(typeof av==='number'&&typeof bv==='number'&&isFinite(av)&&isFinite(bv)) out[k]=av+(bv-av)*f;
    else out[k]=f<0.5?av:bv;
  }
  return out;
}

export { nearestRow, interpRow };