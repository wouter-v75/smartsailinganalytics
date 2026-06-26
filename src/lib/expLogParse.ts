// src/lib/expLogParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Parse an Expedition *raw instrument log* (the 2026 Northstar 76 format) into
// the same per-timestamp row shape the app already uses for charts/analysis,
// plus the extra rig/target/rudder channels we now want.
//
// Format (different from the flat exported CSV that parseCsvLog handles):
//
//   !Boat,Utc,BSP,AWA,AWS,TWA,TWS,TWD,RudderFwd,Leeway,Set,…   ← channel NAMES
//   !boat,0,1,2,3,4,5,6,7,10,11,…                              ← channel NUMBERS
//   !v12.7.16                                                  ← version
//   0,46198.396594,1,0.000,2,-61.4,3,9.69,4,-61.4,…           ← data row
//   …
//
// • Header line 1 lists channel names; line 2 lists the channel NUMBER for each
//   name (same column order). We build name→number from these two lines, so the
//   parser is robust to Expedition reordering/adding channels.
// • Each data row is `boatId, ch,val, ch,val, …` — SPARSE: only channels that
//   updated at that timestamp are present. We carry the last value forward so
//   every row is a complete snapshot (rig settings update infrequently).
// • Time is channel 0 "Utc" as an OLE/Excel date serial (days since 1899-12-30,
//   already UTC) → milliseconds.
//
// Pure + dependency-free so it's unit-testable and reusable by the backfill
// tooling. The older flat-CSV parser (parseCsvLog) stays for the N72 backfill.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpLogRow {
  utc: number
  lat: number | null
  lon: number | null
  // core nav/wind (mapped to the same names the flat parser emits)
  bsp: number | null
  awa: number | null
  aws: number | null
  twa: number | null
  tws: number | null
  twd: number | null
  heel: number | null
  trim: number | null
  sog: number | null
  cog: number | null
  vmg: number | null // computed: bsp·cos(twa)
  rudder: number | null
  // for the SailScan 2-min window (best-guess channel names; correct once the
  // 2026 Northstar 76 log field list is confirmed)
  polarBspPct: number | null // boat speed as % of polar
  forestay: number | null // forestay load
  rake: number | null // mast rake
  jibTackLoad: number | null // jib tack load
  cunninghamLoad: number | null // cunningham load
  // requested rig / target / rudder channels
  mastAng: number | null
  mastButt: number | null
  keelAng: number | null
  upDflctPct: number | null
  lwDflctPct: number | null
  travPct: number | null
  cunnoPct: number | null
  fstyPin: number | null
  jibTkPin: number | null
  dx900Lwy: number | null
  targHeel: number | null
  targFsty: number | null
  targBsty: number | null
  targKeel: number | null
  targToe: number | null
  targRunner: number | null
  targTrim: number | null
  fstyJibTk: number | null
  rudderToeIn: number | null
  rudderP: number | null
  rudderS: number | null
  rudderToe: number | null
}

export interface ParsedExpLog {
  rows: ExpLogRow[]
  startUtc: number
  endUtc: number
  version: string | null
  channels: Record<string, number> // normalised name → channel number (debug/extensibility)
}

// Days between the OLE/Excel 1900 epoch (1899-12-30) and the Unix epoch.
const OLE_EPOCH_DAYS = 25569
const MS_PER_DAY = 86400000

// Normalise a header name for tolerant matching (same scheme as parseCsvLog):
// lowercase, "%" → "pct", strip every other non-alphanumeric.
const norm = (s: string): string =>
  String(s || '').toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]/g, '')

// Map our output field → the channel name(s) it can come from.
const FIELD_NAMES: Record<keyof Omit<ExpLogRow, 'utc' | 'vmg'>, string> = {
  lat: 'Lat', lon: 'Lon',
  bsp: 'BSP', awa: 'AWA', aws: 'AWS', twa: 'TWA', tws: 'TWS', twd: 'TWD',
  heel: 'Heel', trim: 'Trim', sog: 'SOG', cog: 'COG', rudder: 'Rudder',
  polarBspPct: 'GunBspPol%', forestay: 'Forestay', rake: 'Rake',
  jibTackLoad: 'JibTk Pin', cunninghamLoad: 'Cunningham',
  mastAng: 'MastAng', mastButt: 'MastButt', keelAng: 'KeelAng',
  upDflctPct: 'UpDFLCT %', lwDflctPct: 'LwDFCLT %', travPct: 'Trav%', cunnoPct: 'Cunno%',
  fstyPin: 'Fsty Pin', jibTkPin: 'JibTk Pin', dx900Lwy: 'Dx900 Lwy',
  targHeel: 'TargHeel', targFsty: 'TargFsty', targBsty: 'TargBsty', targKeel: 'TargKeel',
  targToe: 'TargToe', targRunner: 'TargRunner', targTrim: 'TargTrim', fstyJibTk: 'Fsty+JibTk',
  rudderToeIn: 'RudderToeIn', rudderP: 'RudderP', rudderS: 'RudderS', rudderToe: 'RudderToe',
}

// Heuristic: is this text an Expedition raw instrument log?
export function isExpeditionRawLog(text: string): boolean {
  const head = (text || '').slice(0, 4000)
  // First non-empty line begins with "!Boat," and a channel-number line "!boat,"
  // follows. The flat CSV starts with a plain "Pos…" header, never "!".
  return /^\s*!Boat\s*,/i.test(head) && /^!boat\s*,/im.test(head)
}

export function parseExpeditionLog(text: string): ParsedExpLog {
  const empty: ParsedExpLog = { rows: [], startUtc: 0, endUtc: 0, version: null, channels: {} }
  const lines = (text || '').replace(/\r/g, '').split('\n')
  if (!lines.length) return empty

  // ── header: names line + channel-number line + optional version ──
  let nameLine: string | null = null
  let numLine: string | null = null
  let version: string | null = null
  let firstDataIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) continue
    if (l[0] === '!') {
      // Both header rows start "!boat," (case-insensitively: "!Boat" names,
      // "!boat" numbers). Distinguish by the 2nd field: a pure integer → the
      // channel-number line; otherwise the names line.
      if (/^!boat\s*,/i.test(l)) {
        const second = (l.split(',')[1] || '').trim()
        if (/^\d+$/.test(second)) numLine = l
        else nameLine = l
        continue
      }
      if (/^!v/i.test(l)) { version = l.replace(/^!/, '').trim(); continue }
      continue // any other directive line
    }
    firstDataIdx = i
    break
  }
  if (!nameLine || !numLine || firstDataIdx < 0) return empty

  const names = nameLine.split(',')
  const nums = numLine.split(',')
  const channels: Record<string, number> = {}
  for (let i = 1; i < names.length; i++) {
    const key = norm(names[i])
    const ch = parseInt((nums[i] || '').trim(), 10)
    if (key && Number.isFinite(ch) && !(key in channels)) channels[key] = ch
  }
  if (!('utc' in channels)) channels['utc'] = 0 // Utc is always channel 0

  // Resolve each output field to its channel number (or -1 if absent).
  const fieldCh = {} as Record<keyof typeof FIELD_NAMES, number>
  ;(Object.keys(FIELD_NAMES) as (keyof typeof FIELD_NAMES)[]).forEach((f) => {
    const ch = channels[norm(FIELD_NAMES[f])]
    fieldCh[f] = ch == null ? -1 : ch
  })
  const utcCh = channels['utc']

  // ── data rows: carry-forward sparse channel values ──
  const carry = new Map<number, number>()
  const rows: ExpLogRow[] = []
  for (let i = firstDataIdx; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim() || l[0] === '!') continue
    const t = l.split(',')
    // Row layout: boatId, <Utc value>, ch,val, ch,val, …  — the timestamp is the
    // bare first value (channel 0, no number prefix); the rest are ch,val pairs.
    const utcVal = parseFloat(t[1])
    if (!Number.isNaN(utcVal)) carry.set(utcCh, utcVal)
    for (let j = 2; j + 1 < t.length; j += 2) {
      const ch = parseInt(t[j], 10)
      const v = parseFloat(t[j + 1])
      if (Number.isFinite(ch) && !Number.isNaN(v)) carry.set(ch, v)
    }
    const serial = carry.get(utcCh)
    if (serial == null) continue
    const utc = Math.round((serial - OLE_EPOCH_DAYS) * MS_PER_DAY)
    if (!Number.isFinite(utc)) continue

    const get = (f: keyof typeof FIELD_NAMES): number | null => {
      const ch = fieldCh[f]
      if (ch < 0) return null
      const v = carry.get(ch)
      return v == null ? null : v
    }
    const bsp = get('bsp')
    const twa = get('twa')
    const vmg = bsp != null && twa != null ? bsp * Math.cos((twa * Math.PI) / 180) : null

    rows.push({
      utc,
      lat: get('lat'), lon: get('lon'),
      bsp, awa: get('awa'), aws: get('aws'), twa, tws: get('tws'), twd: get('twd'),
      heel: get('heel'), trim: get('trim'), sog: get('sog'), cog: get('cog'),
      vmg, rudder: get('rudder'),
      polarBspPct: get('polarBspPct'), forestay: get('forestay'), rake: get('rake'),
      jibTackLoad: get('jibTackLoad'), cunninghamLoad: get('cunninghamLoad'),
      mastAng: get('mastAng'), mastButt: get('mastButt'), keelAng: get('keelAng'),
      upDflctPct: get('upDflctPct'), lwDflctPct: get('lwDflctPct'),
      travPct: get('travPct'), cunnoPct: get('cunnoPct'),
      fstyPin: get('fstyPin'), jibTkPin: get('jibTkPin'), dx900Lwy: get('dx900Lwy'),
      targHeel: get('targHeel'), targFsty: get('targFsty'), targBsty: get('targBsty'),
      targKeel: get('targKeel'), targToe: get('targToe'), targRunner: get('targRunner'),
      targTrim: get('targTrim'), fstyJibTk: get('fstyJibTk'),
      rudderToeIn: get('rudderToeIn'), rudderP: get('rudderP'), rudderS: get('rudderS'),
      rudderToe: get('rudderToe'),
    })
  }

  return {
    rows,
    startUtc: rows.length ? rows[0].utc : 0,
    endUtc: rows.length ? rows[rows.length - 1].utc : 0,
    version,
    channels,
  }
}
