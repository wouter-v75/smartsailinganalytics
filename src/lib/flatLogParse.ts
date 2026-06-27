// src/lib/flatLogParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Flat-CSV Expedition export with a HEADER row, an OLE/Excel date serial in the
// `Utc` column, and SEPARATE decimal `Lat`/`Lon` columns. This is the format the
// 2026 Northstar 76 export switched to (header: Boat,Utc,UtcDate,UtcTime,BSP,…).
//
// It is NOT handled by the two existing parsers (both left untouched):
//   • expLogParse.ts  — the Expedition *raw* sparse log (lines prefixed with !).
//   • csvLogParse.ts  — the older flat CSV with a single NMEA `Pos` column and a
//     `dd/mm/yy` + `hh:mm:ss` time (parseCsvLog skips every row here because the
//     time is an OLE serial, not a slash date).
//
// Column NAME → index mapping (so reordering/insertions survive). Row field names
// match expLogParse's output so every downstream consumer (instrument overlay,
// 2-min SailScan window, windweight, dbSync) reads it unchanged. Pure / no deps.
// ─────────────────────────────────────────────────────────────────────────────

const OLE_EPOCH_DAYS = 25569 // days between 1899-12-30 (OLE epoch) and 1970-01-01
const MS_PER_DAY = 86400000

const norm = (s: string): string =>
  String(s || '').toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]/g, '')

export interface FlatLogRow {
  utc: number
  lat: number | null; lon: number | null
  bsp: number | null; awa: number | null; aws: number | null
  twa: number | null; tws: number | null; twd: number | null
  heel: number | null; trim: number | null; forestay: number | null; vmg: number | null
  cog: number | null; sog: number | null
  leeway: number | null; set: number | null; drift: number | null; hdg: number | null
  polBsp: number | null; polarBspPct: number | null; keelAng: number | null
  upDflctPct: number | null; lwDflctPct: number | null
  targVmg: number | null; targTwa: number | null; targBsp: number | null
}

export interface FlatLogResult { rows: FlatLogRow[]; startUtc: number; endUtc: number }

// Detect the header-flat / OLE-serial / separate-lat-lon variant. Distinct from
// the raw log (! prefix) and the old NMEA flat CSV (single `Pos`, dd/mm/yy date).
export function isFlatOleLog(text: string): boolean {
  if (!text) return false
  const first = text.replace(/\r/g, '').split('\n').find((l) => l.trim()) || ''
  if (first.trim().startsWith('!')) return false
  const cols = first.split(',').map(norm)
  const has = (k: string) => cols.includes(k)
  // Separate lat & lon columns + a Utc column + wind/speed columns, and NOT the
  // old NMEA position column (which normalises to include "ddmm").
  return has('utc') && has('lat') && has('lon') && (has('bsp') || has('tws')) && !cols.some((c) => c.includes('ddmm'))
}

export function parseFlatOleLog(text: string): FlatLogResult {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim())
  if (!lines.length) return { rows: [], startUtc: 0, endUtc: 0 }

  const H: Record<string, number> = {}
  lines[0].split(',').forEach((name, i) => { const k = norm(name); if (k && !(k in H)) H[k] = i })
  const ix = (names: string | string[]): number => {
    for (const nm of ([] as string[]).concat(names)) { const k = norm(nm); if (k in H) return H[k] }
    return -1
  }
  const IX = {
    utc: ix('utc'), lat: ix('lat'), lon: ix('lon'),
    bsp: ix('bsp'), awa: ix('awa'), aws: ix('aws'), twa: ix('twa'), tws: ix('tws'), twd: ix('twd'),
    leeway: ix('leeway'), set: ix('set'), drift: ix('drift'), hdg: ix('hdg'),
    heel: ix('heel'), trim: ix('trim'), forestay: ix('forestay'), vmg: ix('vmg'),
    cog: ix('cog'), sog: ix('sog'),
    targVmg: ix(['targvmg', 'targ vmg']), polBsp: ix('polbsp'), polarBspPct: ix(['polbsppct', 'polbsp%']),
    keelAng: ix(['keelang', 'keel ang']),
    upDflctPct: ix(['updflctpct', 'updflct%', 'updfclctpct']),
    lwDflctPct: ix(['lwdflctpct', 'lwdfcltpct', 'lwdfclt%', 'lwdflct%']),
    targTwa: ix(['targtwa', 'targ twa']), targBsp: ix(['targbsp', 'targ bsp']),
  }

  const num = (c: string[], i: number): number | null => {
    if (i < 0 || i >= c.length) return null
    const v = parseFloat(c[i])
    return Number.isNaN(v) ? null : v
  }

  const rows: FlatLogRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    const serial = num(c, IX.utc)
    if (serial == null) continue
    const utc = Math.round((serial - OLE_EPOCH_DAYS) * MS_PER_DAY)
    if (!Number.isFinite(utc)) continue
    rows.push({
      utc, lat: num(c, IX.lat), lon: num(c, IX.lon),
      bsp: num(c, IX.bsp), awa: num(c, IX.awa), aws: num(c, IX.aws),
      twa: num(c, IX.twa), tws: num(c, IX.tws), twd: num(c, IX.twd),
      heel: num(c, IX.heel), trim: num(c, IX.trim), forestay: num(c, IX.forestay), vmg: num(c, IX.vmg),
      cog: num(c, IX.cog), sog: num(c, IX.sog),
      leeway: num(c, IX.leeway), set: num(c, IX.set), drift: num(c, IX.drift), hdg: num(c, IX.hdg),
      polBsp: num(c, IX.polBsp), polarBspPct: num(c, IX.polarBspPct), keelAng: num(c, IX.keelAng),
      upDflctPct: num(c, IX.upDflctPct), lwDflctPct: num(c, IX.lwDflctPct),
      targVmg: num(c, IX.targVmg), targTwa: num(c, IX.targTwa), targBsp: num(c, IX.targBsp),
    })
  }
  return { rows, startUtc: rows[0]?.utc || 0, endUtc: rows[rows.length - 1]?.utc || 0 }
}
