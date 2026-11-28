
const ROLES = {
  admin:      { label:"Admin",      canImport:true,  canSync:true,  seeLocal:true, canDelete:true  },
  coach:      { label:"Coach",      canImport:true,  canSync:true,  seeLocal:true, canDelete:true  },
  crew:       { label:"Crew",       canImport:true,  canSync:false, seeLocal:true, canDelete:false },
  viewer:     { label:"Viewer",     canImport:false, canSync:false, seeLocal:false,canDelete:false },
  consultant: { label:"Consultant", canImport:false, canSync:false, seeLocal:false,canDelete:false },
};

const TZ_OPTIONS = [
  { label:"UTC+0  (UTC / UK winter / Portugal summer)", offsetMin: 0   },
  { label:"UTC+1  (CET / BST / UK summer / W.Europe winter)", offsetMin: 60  },
  { label:"UTC+2  (CEST / Central Europe summer)", offsetMin: 120 },
  { label:"UTC+3  (EEST / Eastern Europe summer)", offsetMin: 180 },
  { label:"UTC-1  (Azores summer)", offsetMin: -60  },
  { label:"UTC-3  (Brazil / Argentina)", offsetMin: -180 },
  { label:"UTC-4  (US Eastern summer / AST)", offsetMin: -240 },
  { label:"UTC-5  (US Eastern winter / EST)", offsetMin: -300 },
];

// DEFAULT_TZ is GONE, deliberately. It was 120 — CEST, the SUMMER offset — and
// being a constant it asserted both a continent and a season. A November day
// therefore displayed every clip an hour late, and a UK November day two.
// `defaultTzOffsetMin(sessionDate)` in src/lib/defaultTzOffset.ts replaces it
// and is DST-correct by construction; a stored session offset still wins.

const TACK_COLORS=['#1D9E75','#06B6D4','#8B5CF6','#F59E0B','#EF4444','#EC4899','#34D399','#60A5FA','#A78BFA','#FCD34D'];

// One shared empty array. `x || []` and `prop = []` mint a NEW array on every
// render, so anything memo'd or effect-gated on them re-runs every time — and if
// that effect also sets state, the component never stops rendering. That is what
// an omitted `dayTags` did to GPSTrackMap (see its signature below). Frozen so a
// caller cannot push into the shared instance.
const EMPTY=Object.freeze([]);

export { ROLES, TZ_OPTIONS, TACK_COLORS, EMPTY };