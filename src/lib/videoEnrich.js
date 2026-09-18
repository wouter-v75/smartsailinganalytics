import { computeAutoTags } from './localStore';

// Strings that computeAutoTags writes verbatim (excluding the dynamic ones
// — sail names, boat/location/dayType — which are handled separately).
const AUTO_TAG_EXACT = new Set([
  'upwind', 'reach', 'downwind',
  'topmark', 'mark',
  'race-start', 'tack', 'gybe',
  'race', 'training',
]);

// Bucketed auto-tag patterns: TWS bands like "tws-12-16kn" / "tws-25+kn",
// and manoeuvre count multipliers like "3x-tack" / "5x-gybe".
const AUTO_TAG_REGEX = /^(tws-\d+(-\d+)?\+?kn|\d+x-(tack|gybe))$/;

// Precise auto-tag detector. The previous prefix-match version stripped
// manual tags like "race1", "tack9", "markings", "training-day" because
// they happened to start with an auto-tag word; every enrichVideo pass
// quietly wiped them, so tag edits never persisted across refreshes.
function isAutoTag(t){
  return AUTO_TAG_EXACT.has(t) || AUTO_TAG_REGEX.test(t);
}

function enrichVideo(v,log,xml,syncOffsets){
  const out = {...v};

  // ── Instrument averages from log ──────────────────────────────────────────
  if(log?.rows?.length&&v.startUtc){
    const offset = (syncOffsets && syncOffsets[v.id]) || 0;
    const start  = v.startUtc + offset * 1000;
    const w=log.rows.filter(r=>r.utc>=start&&r.utc<=start+(v.duration||0)*1000);
    if(w.length){
      const avg=f=>w.reduce((s,r)=>s+(r[f]||0),0)/w.length;
      const avgFiltered=(f,lo,hi)=>{const valid=w.filter(r=>r[f]>lo&&r[f]<hi);return valid.length?valid.reduce((s,r)=>s+r[f],0)/valid.length:null;};
      const max=f=>w.reduce((mx,r)=>Math.max(mx,r[f]||0),0);
      out.twsAvg   = avg("tws");
      out.twaAvg   = avg("twa");
      out.vmgAvg   = avg("vmg");
      out.polpercAvg = avgFiltered("vsPerfPct",5,200);
      out.vsTargPercAvg = avgFiltered("vsTargPct",5,200);
      out.sogAvg   = avg("sog");
      out.sogMax   = max("sog");
      out.twsMax   = max("tws");
      out.heelAvg  = avg("heel");
      out.bspAvg   = avg("bsp");
      out.logRows  = w;
    }
  }

  // ── Auto-tags from log + xml (race events, sails, position) ───────────────
  // Re-derive on every enrich so tags update when xml/log loads after the
  // video was first imported. Preserves manually-added tags.
  if(v.startUtc && (log || xml)){
    const offset = (syncOffsets && syncOffsets[v.id]) || 0;
    const autoTags = computeAutoTags(v.startUtc, v.duration, log, xml, offset);
    const manualTags = (v.tags||[]).filter(t => {
      if(isAutoTag(t)) return false;
      const meta = xml?.meta;
      if(meta?.location && t === meta.location.toLowerCase().replace(/\s+/g,"-")) return false;
      if(meta?.boat && t === meta.boat.toLowerCase().replace(/\s+/g,"-")) return false;
      if(meta?.dayType && t === meta.dayType.toLowerCase().replace(/\s+/g,"-")) return false;
      return true;
    });
    out.tags = [...new Set([...autoTags, ...manualTags])];
  }

  return out;
}

export { AUTO_TAG_EXACT, AUTO_TAG_REGEX, isAutoTag, enrichVideo };