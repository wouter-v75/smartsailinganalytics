// src/lib/logProfile.ts
// ─────────────────────────────────────────────────────────────────────────────
// Per-boat log profile = the layer that sits ON TOP of content-based format
// auto-detection. The format (Expedition raw / flat-OLE CSV / flat-NMEA CSV) is
// still detected from the file itself (robust to a boat changing its export, as
// the N76 did). What's boat-specific is how that boat's Expedition setup LABELS
// its channels — so the profile is a per-field alias map that EXTENDS the
// built-in defaults consolidated here.
//
// Storage: boat.specs.log_profile = { aliases?: { <field>: string[] } } (JSONB,
// no migration — same pattern as sails.specs). Empty/absent = pure defaults.
// ─────────────────────────────────────────────────────────────────────────────

// Normalise a column/channel label for tolerant matching (shared scheme with
// every parser): lowercase, "%" → "pct", strip all other non-alphanumerics.
export const normLabel = (s: string): string =>
  String(s || '').toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]/g, '')

// Our canonical instrument/rig/target fields (union across all log formats).
export type LogField =
  | 'lat' | 'lon' | 'bsp' | 'awa' | 'aws' | 'twa' | 'tws' | 'twd'
  | 'heel' | 'trim' | 'sog' | 'cog' | 'vmg' | 'rudder'
  | 'vsPerfPct' | 'forestay' | 'rake' | 'keelAng'
  | 'upDflctPct' | 'lwDflctPct' | 'travPct' | 'cunnoPct'
  | 'vang' | 'outhaul'
  // mainsail-only batten/vang positions (port/starboard) — shown on MAIN scans
  | 'v0p' | 'v0s' | 'v1p' | 'v1s'
  // headsail-only trim positions — shown on JIB (headsail) scans
  | 'jibUpDnStbd' | 'jibUpDnPort' | 'jibInOut'
  | 'jibTackLoad' | 'gsTackLoad' | 'cunninghamLoad' | 'mastAng' | 'mastButt' | 'shims'
  // rig loads + control positions added by the 2026-07 N76 export
  | 'fstyPin' | 'fstyJibTk' | 'mainsheetLoad' | 'ruddP' | 'ruddS'
  | 'toeIn' | 'futek' | 'eBarPort' | 'eBarStbd'
  | 'leeway' | 'set' | 'drift' | 'hdg'
  // performance / targets — CANONICAL app-wide names (shared with csvLogParse /
  // the video overlay / dbSync / autotags). New log formats map their own column
  // labels onto THESE keys via the alias table; the keys never change.
  | 'vsTarget' | 'vsTargPct' | 'vsPerf' | 'twaTarg'
  // start-line instruments (canonical names from the legacy parser)
  | 'dstLine' | 'tmLine' | 'ttbPort' | 'ttbStbd' | 'ttbOnStb' | 'ttbPin' | 'ttbCB' | 'timer1' | 'yawR' | 'magvar'
  | 'targHeel' | 'targFsty' | 'targBsty' | 'targKeel'
  | 'targToe' | 'targTrim' | 'targVmg' | 'targAwa'
  // On-board environment sensors — feed the OBSERVED windweight (air-sea ΔT,
  // density) and the MOS join against the model. airTemp/seaTemp °C, rh %, baro hPa.
  | 'airTemp' | 'seaTemp' | 'rh' | 'baro'

// Built-in label aliases per field, consolidated from the raw-log channel names
// (expLogParse) and the flat-CSV column headers (flatLogParse / csvLogParse).
// Values are pre-normalised. A boat's override list is PREPENDED to these.
export const DEFAULT_ALIASES: Record<LogField, string[]> = {
  lat: ['lat'], lon: ['lon'],
  bsp: ['bsp', 'boatspeed'],
  awa: ['awa', 'awangle'],
  aws: ['aws'],
  twa: ['twa', 'twangle'],
  tws: ['tws', 'twspeed'],
  twd: ['twd', 'twdirn'],
  heel: ['heel'],
  trim: ['trim'],
  sog: ['sog', 'extsog'],
  cog: ['cog'],
  vmg: ['vmg'],
  rudder: ['rudder'],
  vsPerfPct: ['vsperfpct', 'polbsppct', 'gunbsppolpct'],
  forestay: ['forestay'],
  rake: ['rake'],
  keelAng: ['keelang'],
  // 2026-06 N76 flat-CSV uses the longer 'UpperDflct%' / 'LowerDflct%' / 'Traveller%' headers.
  upDflctPct: ['updflctpct', 'updfclctpct', 'upperdflctpct'],
  lwDflctPct: ['lwdflctpct', 'lwdfcltpct', 'lowerdflctpct'],
  travPct: ['travpct', 'travellerpct'],
  cunnoPct: ['cunnopct'],
  vang: ['vang'],
  outhaul: ['outhaul'],
  // mainsail batten/vang positions, port & starboard (headers 'V0 P' / 'V0 S' / 'V1 P' / 'V1 S')
  v0p: ['v0p'],
  v0s: ['v0s'],
  v1p: ['v1p'],
  v1s: ['v1s'],
  // headsail trim positions. Older header: 'JibUpDnStbdPos' / 'JibUpDnPortPos' /
  // 'JibInOutPos'. The 2026-07 N76 export shortens them to 'JibUpDnS' / 'JibUpDnP' / 'JibIO'.
  jibUpDnStbd: ['jibupdnstbdpos', 'jibupdns'],
  jibUpDnPort: ['jibupdnportpos', 'jibupdnp'],
  jibInOut: ['jibinoutpos', 'jibio'],
  jibTackLoad: ['jibtkpin', 'jibtackt', 'jibtack'],
  gsTackLoad: ['gstacktfrombar', 'gstackload', 'gstackt'],
  cunninghamLoad: ['cunningham', 'cunno'],
  mastAng: ['mastang'],
  mastButt: ['mastbutt'],
  // mast-base shim stack — 2026-07 N76 export header 'SHIMS'
  shims: ['shims', 'shim'],
  // Rig loads + control positions carried by the 2026-07 N76 export.
  // `fstyPin` is the forestay PIN LOAD — distinct from `forestay` (the length/rake
  // reading). `fstyJibTk` is the boat's own summed forestay + jib-tack load (the
  // same quantity the rig card calls "Comb HS"), logged directly rather than derived.
  fstyPin: ['fstypin', 'forestaypin', 'fstypinload'],
  fstyJibTk: ['fstyjibtk', 'fstyjibtkpin', 'combhs'],
  mainsheetLoad: ['mainsheet', 'mainsheetload', 'mainsht'],
  ruddP: ['ruddp', 'rudderport', 'rudderp'],
  ruddS: ['rudds', 'rudderstbd', 'rudders'],
  toeIn: ['toein'],
  futek: ['futek'],
  eBarPort: ['ebarport', 'ebarp'],
  eBarStbd: ['ebarstbd', 'ebars'],
  leeway: ['leeway', 'dx900lwy'],
  set: ['set'],
  drift: ['drift'],
  hdg: ['hdg'],
  // performance / targets — alias the per-format column labels onto canonical keys
  vsTarget: ['vstarget', 'vstarg', 'targbsp', 'targetbsp'],   // target boat speed (kn)
  vsTargPct: ['vstargpct', 'vstargetpct'],                    // BSP as % of target
  vsPerf: ['vsperf', 'polbsp'],                               // polar boat speed (kn)
  twaTarg: ['twatarg', 'twatarget', 'targtwa', 'targettwa'],  // target TWA
  // start-line instruments
  dstLine: ['dstline', 'distancetostartlineboatlengths'],
  // tmLine is TTB·LINE. Older exports carry a direct 'TmLine' column; the 2026-07
  // Expedition export instead has 'TmToLn' + 'TmToGun', and flatLogParse computes
  // tmLine = TmToLn - TmToGun when no direct column is present.
  tmLine: ['tmline'],
  // TTB·P / TTB·S — 'StBsToP' / 'StBsToS' are the Expedition start-burn channels
  // for the port / starboard line ends (shown directly as a burn: +early / -late).
  ttbPort: ['ttbport', 'stbstop'],
  ttbStbd: ['ttbstbd', 'stbstos'],
  // TTB·on·STB — start burn if committing to the starboard tack ('StBsOnS').
  ttbOnStb: ['stbsons'],
  ttbPin: ['ttbpin'],
  ttbCB: ['ttbcb'],
  timer1: ['timer1', 'racetimerminsec'],
  yawR: ['yawr', 'rot'],
  magvar: ['magvar'],
  targHeel: ['targheel', 'targetheel'],
  targFsty: ['targfsty'],
  targBsty: ['targbsty'],
  targKeel: ['targkeel'],
  targToe: ['targtoe', 'targettoe'],
  targTrim: ['targtrim', 'targettrim'],
  targVmg: ['targvmg', 'targetvmg'],
  targAwa: ['targawa', 'targetawa'],
  // On-board environment sensors (Expedition channels vary by boat).
  airTemp: ['airtemp', 'airtmp', 'temp', 'airtemperature', 'tair'],
  seaTemp: ['seatemp', 'seatmp', 'watertemp', 'seawatertemp', 'sst', 'tsea'],
  rh: ['rh', 'humid', 'humidity', 'relhumidity', 'relativehumidity'],
  baro: ['baro', 'barometer', 'pressure', 'airpressure', 'mslp', 'presssure'],
}

export interface BoatLogProfile {
  aliases?: Partial<Record<LogField, string[]>>
  // optional, advisory only — auto-detect still decides the format:
  expectedFormat?: 'raw' | 'flat-ole' | 'flat-nmea'
  note?: string | null
}

// Read a boat's stored log profile (boat.specs.log_profile), tolerant of shape.
export function getBoatLogProfile(specs: unknown): BoatLogProfile {
  const p = (specs && typeof specs === 'object' ? (specs as any).log_profile : null) || null
  return p && typeof p === 'object' ? (p as BoatLogProfile) : {}
}

// Effective alias map = boat overrides PREPENDED to the defaults (normalised,
// de-duplicated). Boat aliases win on ambiguity because they come first.
export function effectiveAliases(profile?: BoatLogProfile | null): Record<LogField, string[]> {
  const out = {} as Record<LogField, string[]>
  const over = profile?.aliases || {}
  for (const f of Object.keys(DEFAULT_ALIASES) as LogField[]) {
    const boat = (over[f] || []).map(normLabel).filter(Boolean)
    const merged: string[] = []
    for (const a of [...boat, ...DEFAULT_ALIASES[f]]) if (!merged.includes(a)) merged.push(a)
    out[f] = merged
  }
  return out
}

// Resolve a CSV header row (array of raw column names) → { field: columnIndex }.
// Only fields whose alias matched a column are present. First match wins; a
// column already claimed by an earlier field is not reused.
export function resolveHeaderIndices(
  headerCols: string[],
  aliases: Record<LogField, string[]>
): Partial<Record<LogField, number>> {
  const byLabel = new Map<string, number>()
  headerCols.forEach((name, i) => { const k = normLabel(name); if (k && !byLabel.has(k)) byLabel.set(k, i) })
  const used = new Set<number>()
  const out: Partial<Record<LogField, number>> = {}
  for (const f of Object.keys(aliases) as LogField[]) {
    for (const a of aliases[f]) {
      const idx = byLabel.get(a)
      if (idx != null && !used.has(idx)) { out[f] = idx; used.add(idx); break }
    }
  }
  return out
}

// Resolve a raw-log channel map (normalised channel-name → channel number) →
// { field: channelNumber } using the effective aliases.
export function resolveChannelMap(
  channels: Record<string, number>,
  aliases: Record<LogField, string[]>
): Partial<Record<LogField, number>> {
  const out: Partial<Record<LogField, number>> = {}
  for (const f of Object.keys(aliases) as LogField[]) {
    for (const a of aliases[f]) {
      if (a in channels) { out[f] = channels[a]; break }
    }
  }
  return out
}
