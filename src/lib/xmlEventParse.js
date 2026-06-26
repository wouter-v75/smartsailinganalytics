// src/lib/xmlEventParse.js
// ─────────────────────────────────────────────────────────────────────────────
// Expedition event-file (.ev.xml) parser. Extracted verbatim from the app so the
// live event upload and the N72 backfill CLI share one source of truth. Pure /
// regex-based (no DOMParser, no browser deps).
// ─────────────────────────────────────────────────────────────────────────────

export function isoUtc(s, offsetMin = 0) {
  return new Date(s.trim().replace(" ", "T") + "Z").getTime() - offsetMin * 60000;
}

export function parseXmlEvents(text, offsetMin = 0) {
  const t = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  const getAttr = (str, attr) => {
    const m = str.match(new RegExp(`\\b${attr}="([^"]*)"`, 'i'));
    return m ? m[1] : '';
  };
  const findTags = name => {
    const rx = new RegExp(`<${name}\\b[^>]*?/?>`, 'gi');
    return t.match(rx) || [];
  };
  const getMeta = tag => {
    const m = t.match(new RegExp(`<${tag}\\b[^>]*?\\bval="([^"]*)"`, 'i'));
    return m ? m[1] : '';
  };

  const meta = {
    boat: getMeta('boat'),
    location: getMeta('location'),
    date: getMeta('date'),
    dayType: getMeta('daytypestr'),
    sailsUsed: getMeta('sailsused').split(';').map(s => s.trim()).filter(Boolean),
  };

  const sailsUpEvents = [], raceGuns = [];
  let dayStartUtc = null, dayStopUtc = null;
  for (const tag of findTags('event')) {
    const utc = isoUtc(`${getAttr(tag, 'date')} ${getAttr(tag, 'time')}`, offsetMin);
    const type = getAttr(tag, 'type'), attr = getAttr(tag, 'attribute');
    if (type === 'SailsUp') {
      const sails = attr.split(';').map(s => s.trim()).filter(Boolean);
      sailsUpEvents.push({ utc, sails, label: sails.join(' + ') || 'Sails changed' });
    } else if (type === 'RaceStartGun') {
      raceGuns.push({ utc, raceNum: parseInt(attr) || 0, label: `Race ${attr || '?'} start`, color: '#EF4444' });
    } else if (type === 'DayStart') { dayStartUtc = utc; }
    else if (type === 'DayStop') { dayStopUtc = utc; }
  }

  const markRoundings = findTags('markrounding').map(tag => ({
    utc: isoUtc(getAttr(tag, 'datetime'), offsetMin),
    isTop: getAttr(tag, 'istopmark') === 'true',
    isValid: getAttr(tag, 'isvalid') !== 'false',
    label: getAttr(tag, 'istopmark') === 'true' ? 'Top mark' : 'Leeward gate',
    color: getAttr(tag, 'istopmark') === 'true' ? '#EF4444' : '#8B5CF6',
  }));

  const tackJibes = findTags('tackjibe').map(tag => ({
    utc: isoUtc(getAttr(tag, 'datetime'), offsetMin),
    isTack: getAttr(tag, 'istack') === 'true',
    isValid: getAttr(tag, 'isvalidperf') === 'true',
    label: getAttr(tag, 'istack') === 'true' ? 'Tack' : 'Gybe',
    color: getAttr(tag, 'istack') === 'true' ? '#1D9E75' : '#7F77DD',
  }));

  const phases = [];
  const phaseBlocks = t.match(/<phase\b[^>]*>[\s\S]*?<\/phase>/gi) || [];
  for (const pb of phaseBlocks) {
    const dt = getAttr(pb.match(/<startdatetime\b[^>]*/i)?.[0] || '', 'val');
    const dur = getAttr(pb.match(/<duration\b[^>]*/i)?.[0] || '', 'val');
    const sm = getAttr(pb.match(/<sailingmode\b[^>]*/i)?.[0] || '', 'val');
    if (!dt || !dur || !sm) continue;
    const utc = isoUtc(dt, offsetMin);
    if (utc) phases.push({ utc, endUtc: utc + parseInt(dur) * 1000, mode: parseInt(sm) });
  }

  const startLinesMap = {};
  for (const tag of findTags('mark')) {
    const mtype = getAttr(tag, 'marktype');
    if (mtype !== 'StartBoat' && mtype !== 'StartPin') continue;
    const name = getAttr(tag, 'name');
    const lat = parseFloat(getAttr(tag, 'lat')); const lon = parseFloat(getAttr(tag, 'lon'));
    if (isNaN(lat) || isNaN(lon)) continue;
    const nm = name.match(/(\d+)$/); const rn = nm ? parseInt(nm[1]) : 0;
    if (!startLinesMap[rn]) startLinesMap[rn] = {};
    if (mtype === 'StartPin') startLinesMap[rn].pin = { lat, lon, name };
    if (mtype === 'StartBoat') startLinesMap[rn].boat = { lat, lon, name };
  }
  const startLines = Object.entries(startLinesMap)
    .map(([rn, { pin, boat }]) => ({ raceNum: parseInt(rn), pin, boat }))
    .filter(sl => sl.pin && sl.boat);

  return { meta, sailsUpEvents, raceGuns, markRoundings, tackJibes, dayStartUtc, dayStopUtc, startLines, phases };
}
