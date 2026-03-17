/**
 * SmartSailingAnalytics — Data Parsers
 * Expedition CSV Log + SailingPerformance (Expedition) XML Event File
 *
 * Based on real file analysis:
 *   NS72_perf1_20240904.csv
 *   NORTHSTAR72_240904_1_ev.xml
 */

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface LogEntry {
  /** UTC timestamp (ms since epoch) */
  utc: number;
  /** ISO datetime string e.g. "2024-09-04T12:04:07Z" */
  datetime: string;
  lat: number;           // decimal degrees N+
  lon: number;           // decimal degrees E+
  heel: number;          // degrees, positive = stbd
  bsp: number;           // boat speed (kn)
  awa: number;           // apparent wind angle (deg, signed: negative = port)
  aws: number;           // apparent wind speed (kn)
  leeway: number;        // degrees
  cog: number;           // course over ground (deg magnetic)
  hdg: number;           // heading (deg magnetic)
  twd: number;           // true wind direction (deg magnetic)
  twa: number;           // true wind angle (deg, signed)
  tws: number;           // true wind speed (kn)
  vmg: number;           // VMG (kn)
  sog: number;           // speed over ground (kn)
  vsTarget: number;      // polar target speed (kn)
  vsTargPct: number;     // % of polar target
  vsPerf: number;        // performance vs target (kn)
  vsPerfPct: number;     // performance % (100 = on target)
  rudder: number;        // rudder angle (deg)
  trim: number;          // mast/sail trim indicator
  pitchRate: number;     // deg/s
  rollRate: number;      // deg/s
  yawRate: number;       // deg/s
}

export interface DayMeta {
  boat: string;
  date: string;           // "YYYY-MM-DD"
  location: string;
  dayType: string;        // e.g. "Training; WinLee; Other; Coastal"
  sailsUsed: string[];    // all sails used on the day
}

export interface SailsUpEvent {
  utc: number;
  datetime: string;
  mainsail: string;       // e.g. "MAIN_Ins 2024"
  headsail: string;       // e.g. "J1.5-2023"  (empty string if none)
  staysail: string;       // e.g. "GS-2024"    (empty string if none)
  kite: string;           // e.g. "A2-2022"    (empty string if none)
  /** Array of all currently hoisted sails (empty strings removed) */
  sails: string[];
}

export interface RaceGun {
  utc: number;
  datetime: string;
  raceNumber: number;
}

export interface TechnicalProblem {
  utc: number;
  datetime: string;
  system: string;         // e.g. "Electronics"
  comment: string;        // e.g. "stbd p"
}

export interface MarkRounding {
  utc: number;
  datetime: string;
  isTopMark: boolean;
  isValid: boolean;
  errorMessage: string;
  timeBefore: number;     // seconds of data before rounding
  timeAfter: number;      // seconds of data after rounding
}

export interface TackJibe {
  utc: number;
  datetime: string;
  isTack: boolean;        // true = tack, false = gybe
  isValidCalib: boolean;
  isValidPerf: boolean;
  errorMessage: string;
}

export interface Phase {
  startUtc: number;
  startDatetime: string;
  sailsUp: string[];      // e.g. ["MAIN_Ins 2024", "J1.5-2023", "GS-2024"]
  durationSec: number;
  /** 1=upwind, 2=tacking, 4=reaching/run, 8=downwind/gybing */
  sailingMode: number;
  sailingModeLabel: string;
  raceNum: number;        // -1 = training
  raceLegNum: number;     // -1 = training
  isRace: boolean;
  isOnboardPhase: boolean;
  testSubject: string;    // e.g. "Testing Sail Setup"
}

export interface CourseMark {
  name: string;
  type: string;           // "StartBoat" | "StartPin" | other
  lat: number;
  lon: number;
  comment: string;
}

export interface ParsedEventFile {
  meta: DayMeta;
  sailsUpEvents: SailsUpEvent[];
  raceGuns: RaceGun[];
  technicalProblems: TechnicalProblem[];
  dayStart: { utc: number; datetime: string } | null;
  dayStop: { utc: number; datetime: string } | null;
  markRoundings: MarkRounding[];
  tackJibes: TackJibe[];
  phases: Phase[];
  marks: CourseMark[];
}

export interface ParsedLogFile {
  entries: LogEntry[];
  /** First UTC timestamp in the file (ms) */
  startUtc: number;
  /** Last UTC timestamp in the file (ms) */
  endUtc: number;
  /** Duration in seconds */
  durationSec: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert Expedition NMEA position string to decimal degrees.
 * Input format: "4313.6350N 00641.9650E"
 *   Lat part: ddmm.mmmmN  (2 digit degrees, then minutes)
 *   Lon part: dddmm.mmmmE (3 digit degrees, then minutes)
 */
function parseNmeaPos(posStr: string): { lat: number; lon: number } | null {
  const clean = posStr.trim();
  // split on whitespace
  const parts = clean.split(/\s+/);
  if (parts.length < 2) return null;

  const parsePart = (s: string, degDigits: number): number => {
    const hemi = s.slice(-1); // N/S/E/W
    const numeric = s.slice(0, -1);
    const deg = parseFloat(numeric.slice(0, degDigits));
    const min = parseFloat(numeric.slice(degDigits));
    const decimal = deg + min / 60;
    return (hemi === "S" || hemi === "W") ? -decimal : decimal;
  };

  try {
    const lat = parsePart(parts[0], 2);
    const lon = parsePart(parts[1], 3);
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

/**
 * Parse Expedition date (dd/mm/yy) + time (HH:MM:SS) → UTC timestamp (ms).
 * NOTE: Expedition uses dd/mm/yy European format.
 */
function parseExpeditionDateTime(dateStr: string, timeStr: string): number {
  const [dd, mm, yy] = dateStr.trim().split("/").map(Number);
  const year = yy < 50 ? 2000 + yy : 1900 + yy;
  const [hh, min, ss] = timeStr.trim().split(":").map(Number);
  return Date.UTC(year, mm - 1, dd, hh, min, ss);
}

/** Parse ISO datetime "YYYY-MM-DD HH:MM:SS" → UTC ms */
function parseIsoDateTime(s: string): number {
  // e.g. "2024-09-04 12:04:07"
  const clean = s.trim().replace(" ", "T") + "Z";
  return new Date(clean).getTime();
}

/** Format UTC ms → ISO string */
function toIso(utc: number): string {
  return new Date(utc).toISOString().replace(".000Z", "Z");
}

function sailingModeLabel(mode: number): string {
  switch (mode) {
    case 1: return "upwind";
    case 2: return "tacking";
    case 4: return "reaching";
    case 8: return "downwind";
    default: return `mode-${mode}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPEDITION CSV LOG PARSER
// ─────────────────────────────────────────────────────────────────────────────
//
// Column layout (0-indexed, confirmed from header row):
//   0  Pos[dddmm.mm]   — "4313.6350N 00641.9650E"
//   1  dd/mm/yy
//   2  hhmmss           — actually "HH:MM:SS" with colons
//   3  Heel
//   4  Boatspeed (BSP)
//   5  AW_angle (AWA)
//   6  AW_speed (AWS)
//   7  Leeway
//   8  Course (COG)
//   9  Heading
//  10  TW_Dirn (TWD)
//  11  TW_angle (TWA)
//  12  TW_speed (TWS)
//  13  GW_Dirn
//  14  GW_speed
//  15  Orig_TWS
//  16  Orig_TWA
//  17  Orig_TWD
//  18  TWD_Off
//  19  VMG
//  20  Ext_SOG (SOG)
//  21  Ext_COG
//  22  Vs_target
//  23  Vs_targ%
//  24  TWA_targ
//  25  Vs_perf
//  26  Vs_perf%
//  27  MCur_Rate
//  28  MCur_Dir
//  29..33  line/course indicators (skip)
//  43  YawR
//  44  PitchR
//  45  RollR
//  46  TWS_Cor
//  47  TWA_Cor
//  52  Rudder
//  53  Trim
//
// Notable: blank lines between each data row — must skip.
// Notable: all numeric fields are space-padded — trim before parsing.
//

/**
 * Parse Expedition performance CSV log.
 * @param csvText raw file contents (UTF-8 string)
 * @param skipInvalidPositions skip rows where lat/lon are all zeros (pre-sail)
 */
export function parseExpeditionCsv(
  csvText: string,
  skipInvalidPositions = true
): ParsedLogFile {
  const lines = csvText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0); // drop blank lines

  const entries: LogEntry[] = [];
  let headerSkipped = false;

  for (const line of lines) {
    if (!headerSkipped) {
      // First non-blank line is the header
      headerSkipped = true;
      continue;
    }

    const cols = line.split(",");
    if (cols.length < 27) continue;

    const posStr = cols[0];
    const dateStr = cols[1].trim();
    const timeStr = cols[2].trim();

    // Skip rows with clearly invalid date/time
    if (!dateStr || !timeStr) continue;

    const posResult = parseNmeaPos(posStr);
    if (!posResult) continue;
    const { lat, lon } = posResult;

    // Skip pre-start rows where boat hasn't moved (lat/lon identical to zero-state)
    if (skipInvalidPositions && lat === 0 && lon === 0) continue;

    const bsp = parseFloat(cols[4]) || 0;
    // Skip fully dead rows (no boat speed, no wind, early file)
    const tws = parseFloat(cols[12]) || 0;
    if (skipInvalidPositions && bsp === 0 && tws < 0.5) continue;

    const utc = parseExpeditionDateTime(dateStr, timeStr);
    if (isNaN(utc)) continue;

    const entry: LogEntry = {
      utc,
      datetime: toIso(utc),
      lat,
      lon,
      heel:       parseFloat(cols[3])  || 0,
      bsp,
      awa:        parseFloat(cols[5])  || 0,
      aws:        parseFloat(cols[6])  || 0,
      leeway:     parseFloat(cols[7])  || 0,
      cog:        parseFloat(cols[8])  || 0,
      hdg:        parseFloat(cols[9])  || 0,
      twd:        parseFloat(cols[10]) || 0,
      twa:        parseFloat(cols[11]) || 0,
      tws,
      vmg:        parseFloat(cols[19]) || 0,
      sog:        parseFloat(cols[20]) || 0,
      vsTarget:   parseFloat(cols[22]) || 0,
      vsTargPct:  parseFloat(cols[23]) || 0,
      vsPerf:     parseFloat(cols[25]) || 0,
      vsPerfPct:  parseFloat(cols[26]) || 0,
      // Sensor rates — confirmed column indices from header:
      // MHU_R[38] MHU_G[39] MHU_B[40] YawR[41] PitchR[42] RollR[43]
      // TWS_Cor[44] TWA_Cor[45] TTB_Port[46] TTB_Stbd[47] TTB_Pin[48]
      // TTB_CB[49] Bs2Line[50] Timer-1[51] Rudder[52] Trim[53]
      yawRate:    cols[41] ? (parseFloat(cols[41]) || 0) : 0,
      pitchRate:  cols[42] ? (parseFloat(cols[42]) || 0) : 0,
      rollRate:   cols[43] ? (parseFloat(cols[43]) || 0) : 0,
      rudder:     cols[52] ? (parseFloat(cols[52]) || 0) : 0,
      trim:       cols[53] ? (parseFloat(cols[53]) || 0) : 0,
    };

    entries.push(entry);
  }

  if (entries.length === 0) {
    return { entries: [], startUtc: 0, endUtc: 0, durationSec: 0 };
  }

  const startUtc = entries[0].utc;
  const endUtc = entries[entries.length - 1].utc;

  return {
    entries,
    startUtc,
    endUtc,
    durationSec: Math.round((endUtc - startUtc) / 1000),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPEDITION XML EVENT FILE PARSER (SailingPerformance format)
// ─────────────────────────────────────────────────────────────────────────────
//
// Root element: <daysail>
//
// Key child elements parsed:
//   <boat val="..." />
//   <date val="YYYY-MM-DD" />
//   <location val="..." />
//   <daytypestr val="..." />
//   <dailycomments>
//     <sailsused val="A2-2022; GS-2024; J1.5-2023; ..." />
//   </dailycomments>
//
//   <events>
//     <event date="YYYY-MM-DD" time="HH:MM:SS"
//            type="DayStart|DayStop|SailsUp|RaceStartGun|TechnicalProblem"
//            attribute="..." />
//     SailsUp attribute format: "Mainsail;Headsail;Staysail;Kite"
//       e.g. "MAIN_Ins 2024;J1.5-2024;;"   (empty = not set)
//   </events>
//
//   <markroundings>
//     <markrounding datetime="YYYY-MM-DD HH:MM:SS"
//                   istopmark="true|false"
//                   isvalid="true|false"
//                   errmsg="..." />
//   </markroundings>
//
//   <tackjibes>
//     <tackjibe datetime="YYYY-MM-DD HH:MM:SS"
//               istack="true|false"        true=tack, false=jibe
//               isvalidcalib="true|false"
//               isvalidperf="true|false"
//               errmsg="..." />
//   </tackjibes>
//
//   <phases>
//     <phase name="NORTHSTAR72_NormedPhase_20240904_120959">
//       <startdatetime val="YYYY-MM-DD HH:MM:SS" />
//       <sailsup val="MAIN_Ins 2024/J1.5-2024" />   slash-separated
//       <duration val="30" />
//       <sailingmode val="1|2|4|8" />   1=upwind 2=tacking 4=reach 8=downwind
//       <racenum val="-1|1|2..." />     -1 = training
//       <racelegnum val="-1|0|1..." />
//       <phasemadeonboard val="True|False" />
//       <testsubject val="..." />
//     </phase>
//   </phases>
//
//   <marks>
//     <mark name="..." marktype="StartBoat|StartPin"
//           lat="41.098937" lon="9.583372" />
//   </marks>
//
// NOTE: This is a DOM-based parser using the browser's DOMParser or
//       Node.js fast-xml-parser / @xmldom/xmldom for server-side use.
//       The function accepts a pre-parsed Document (works in both environments).
//

/**
 * Parse a SailingPerformance / Expedition event XML file.
 * @param xmlText raw XML string
 * @param domParser optional DOMParser instance (browser). If omitted, uses
 *                  @xmldom/xmldom in Node.js environments.
 */
export function parseExpeditionEventXml(
  xmlText: string,
  domParser?: DOMParser
): ParsedEventFile {
  let doc: Document;

  if (domParser) {
    doc = domParser.parseFromString(xmlText, "text/xml");
  } else {
    // Node.js: require @xmldom/xmldom
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DOMParser: NodeDOMParser } = require("@xmldom/xmldom");
    doc = new NodeDOMParser().parseFromString(xmlText, "text/xml");
  }

  const val = (el: Element | null, fallback = "") =>
    el?.getAttribute("val") ?? fallback;

  const getEl = (parent: Document | Element, tag: string): Element | null =>
    (parent as Element).querySelector
      ? (parent as Element).querySelector(tag)
      : (parent as Document).getElementsByTagName(tag)[0] ?? null;

  const getEls = (parent: Document | Element, tag: string): Element[] =>
    Array.from(
      (parent as Document).getElementsByTagName
        ? (parent as Document).getElementsByTagName(tag)
        : (parent as Element).getElementsByTagName(tag)
    );

  // ── Meta ────────────────────────────────────────────────────────────────
  const meta: DayMeta = {
    boat: val(getEl(doc, "boat")),
    date: val(getEl(doc, "date")),
    location: val(getEl(doc, "location")),
    dayType: val(getEl(doc, "daytypestr")),
    sailsUsed: val(getEl(doc, "sailsused"))
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
  };

  // ── Events ───────────────────────────────────────────────────────────────
  const sailsUpEvents: SailsUpEvent[] = [];
  const raceGuns: RaceGun[] = [];
  const technicalProblems: TechnicalProblem[] = [];
  let dayStart: { utc: number; datetime: string } | null = null;
  let dayStop: { utc: number; datetime: string } | null = null;

  for (const ev of getEls(doc, "event")) {
    const date = ev.getAttribute("date") ?? "";
    const time = ev.getAttribute("time") ?? "";
    const type = ev.getAttribute("type") ?? "";
    const attribute = ev.getAttribute("attribute") ?? "";

    // Combined ISO datetime "YYYY-MM-DD HH:MM:SS"
    const isoStr = `${date} ${time}`;
    const utc = parseIsoDateTime(isoStr);

    switch (type) {
      case "DayStart":
        dayStart = { utc, datetime: toIso(utc) };
        break;

      case "DayStop":
        dayStop = { utc, datetime: toIso(utc) };
        break;

      case "SailsUp": {
        // attribute = "Mainsail;Headsail;Staysail;Kite"
        // Any position can be empty string ""
        const parts = attribute.split(";");
        const mainsail = (parts[0] ?? "").trim();
        const headsail = (parts[1] ?? "").trim();
        const staysail = (parts[2] ?? "").trim();
        const kite     = (parts[3] ?? "").trim();
        const sails = [mainsail, headsail, staysail, kite].filter(Boolean);

        sailsUpEvents.push({
          utc,
          datetime: toIso(utc),
          mainsail,
          headsail,
          staysail,
          kite,
          sails,
        });
        break;
      }

      case "RaceStartGun":
        raceGuns.push({
          utc,
          datetime: toIso(utc),
          raceNumber: parseInt(attribute, 10) || 0,
        });
        break;

      case "TechnicalProblem":
        technicalProblems.push({
          utc,
          datetime: toIso(utc),
          system: attribute,
          comment: ev.getAttribute("comments") ?? "",
        });
        break;
    }
  }

  // ── Mark Roundings ───────────────────────────────────────────────────────
  const markRoundings: MarkRounding[] = getEls(doc, "markrounding").map(
    (mr) => {
      const utc = parseIsoDateTime(mr.getAttribute("datetime") ?? "");
      return {
        utc,
        datetime: toIso(utc),
        isTopMark: mr.getAttribute("istopmark") === "true",
        isValid: mr.getAttribute("isvalid") === "true",
        errorMessage: mr.getAttribute("errmsg") ?? "",
        timeBefore: parseInt(mr.getAttribute("timebefore") ?? "0", 10),
        timeAfter: parseInt(mr.getAttribute("timeafter") ?? "0", 10),
      };
    }
  );

  // ── Tack / Gybes ─────────────────────────────────────────────────────────
  const tackJibes: TackJibe[] = getEls(doc, "tackjibe").map((tj) => {
    const utc = parseIsoDateTime(tj.getAttribute("datetime") ?? "");
    return {
      utc,
      datetime: toIso(utc),
      isTack: tj.getAttribute("istack") === "true",
      isValidCalib: tj.getAttribute("isvalidcalib") === "true",
      isValidPerf: tj.getAttribute("isvalidperf") === "true",
      errorMessage: tj.getAttribute("errmsg") ?? "",
    };
  });

  // ── Phases ───────────────────────────────────────────────────────────────
  const phases: Phase[] = getEls(doc, "phase").map((ph) => {
    const startStr = val(ph.querySelector?.("startdatetime") ??
      ph.getElementsByTagName("startdatetime")[0] ?? null);
    const startUtc = parseIsoDateTime(startStr);

    const sailsUpStr = val(ph.querySelector?.("sailsup") ??
      ph.getElementsByTagName("sailsup")[0] ?? null);
    // sailsup uses "/" separator: "MAIN_Ins 2024/J1.5-2023/GS-2024"
    const sailsUp = sailsUpStr.split("/").map((s) => s.trim()).filter(Boolean);

    const duration = parseInt(
      val(ph.querySelector?.("duration") ??
        ph.getElementsByTagName("duration")[0] ?? null, "30"),
      10
    );
    const mode = parseInt(
      val(ph.querySelector?.("sailingmode") ??
        ph.getElementsByTagName("sailingmode")[0] ?? null, "0"),
      10
    );
    const raceNum = parseInt(
      val(ph.querySelector?.("racenum") ??
        ph.getElementsByTagName("racenum")[0] ?? null, "-1"),
      10
    );
    const raceLegNum = parseInt(
      val(ph.querySelector?.("racelegnum") ??
        ph.getElementsByTagName("racelegnum")[0] ?? null, "-1"),
      10
    );
    const onboard = val(ph.querySelector?.("phasemadeonboard") ??
      ph.getElementsByTagName("phasemadeonboard")[0] ?? null, "False");
    const testSubject = val(ph.querySelector?.("testsubject") ??
      ph.getElementsByTagName("testsubject")[0] ?? null);

    return {
      startUtc,
      startDatetime: toIso(startUtc),
      sailsUp,
      durationSec: duration,
      sailingMode: mode,
      sailingModeLabel: sailingModeLabel(mode),
      raceNum,
      raceLegNum,
      isRace: raceNum >= 1,
      isOnboardPhase: onboard.toLowerCase() === "true",
      testSubject,
    };
  });

  // ── Course Marks ─────────────────────────────────────────────────────────
  const marks: CourseMark[] = getEls(doc, "mark").map((m) => ({
    name: m.getAttribute("name") ?? "",
    type: m.getAttribute("marktype") ?? "",
    lat: parseFloat(m.getAttribute("lat") ?? "0"),
    lon: parseFloat(m.getAttribute("lon") ?? "0"),
    comment: m.getAttribute("comments") ?? "",
  }));

  return {
    meta,
    sailsUpEvents,
    raceGuns,
    technicalProblems,
    dayStart,
    dayStop,
    markRoundings,
    tackJibes,
    phases,
    marks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-SYNC HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the offset (seconds) to apply to a video's local timestamp
 * to align it with the parsed log data's UTC timeline.
 *
 * Strategy:
 *   1. The video's recording start time is extracted from EXIF/quicktime
 *      metadata (passed as `videoStartUtc`).
 *   2. The log file's first valid data point is `log.startUtc`.
 *   3. The raw offset is simply: log.startUtc - videoStartUtc (in seconds).
 *
 * If the video start time is unknown (0), fall back to the event file's
 * DayStart event time.
 *
 * Returns a sync offset in seconds (positive = video is behind log;
 * negative = video is ahead of log). Store this in `sync_offsets` table.
 */
export function computeAutoSyncOffset(
  videoStartUtc: number,
  log: ParsedLogFile,
  eventFile?: ParsedEventFile
): { offsetSeconds: number; confidence: "high" | "low" } {
  if (videoStartUtc && videoStartUtc > 0) {
    const offsetSeconds = Math.round((log.startUtc - videoStartUtc) / 1000);
    return { offsetSeconds, confidence: "high" };
  }

  // Fallback: align to DayStart event
  if (eventFile?.dayStart) {
    const offsetSeconds = Math.round(
      (eventFile.dayStart.utc - log.startUtc) / 1000
    );
    return { offsetSeconds, confidence: "low" };
  }

  return { offsetSeconds: 0, confidence: "low" };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-TAG GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoGeneratedTag {
  tag_key: string;
  tag_value: string;
  source: "event" | "instrument" | "sail";
}

/**
 * Generate automatic tags for a video segment from parsed data.
 *
 * @param videoStartUtc  UTC ms when this video starts
 * @param videoEndUtc    UTC ms when this video ends
 * @param log            parsed log file
 * @param events         parsed event file
 * @param syncOffsetSec  manual sync adjustment (from sync_offsets table)
 */
export function generateAutoTags(
  videoStartUtc: number,
  videoEndUtc: number,
  log: ParsedLogFile,
  events: ParsedEventFile,
  syncOffsetSec = 0
): AutoGeneratedTag[] {
  const tags: AutoGeneratedTag[] = [];
  const syncMs = syncOffsetSec * 1000;

  // Adjusted video window in log-UTC space
  const winStart = videoStartUtc + syncMs;
  const winEnd   = videoEndUtc   + syncMs;

  // ── Instrument averages over video window ─────────────────────────────
  const windowEntries = log.entries.filter(
    (e) => e.utc >= winStart && e.utc <= winEnd
  );

  if (windowEntries.length > 0) {
    const avg = (field: keyof LogEntry) =>
      windowEntries.reduce((s, e) => s + (e[field] as number), 0) /
      windowEntries.length;

    const roundTo1 = (n: number) => Math.round(n * 10) / 10;

    tags.push({ tag_key: "tws_avg",    tag_value: String(roundTo1(avg("tws"))),  source: "instrument" });
    tags.push({ tag_key: "twa_avg",    tag_value: String(roundTo1(avg("twa"))),  source: "instrument" });
    tags.push({ tag_key: "bsp_avg",    tag_value: String(roundTo1(avg("bsp"))),  source: "instrument" });
    tags.push({ tag_key: "sog_avg",    tag_value: String(roundTo1(avg("sog"))),  source: "instrument" });
    tags.push({ tag_key: "heel_avg",   tag_value: String(roundTo1(avg("heel"))), source: "instrument" });
    tags.push({ tag_key: "vmg_avg",    tag_value: String(roundTo1(avg("vmg"))),  source: "instrument" });
    tags.push({ tag_key: "perf_avg",   tag_value: String(roundTo1(avg("vsPerfPct"))), source: "instrument" });

    // TWS bracket tag (useful for filtering)
    const twsAvg = avg("tws");
    const twsBracket =
      twsAvg < 8  ? "0-8" :
      twsAvg < 12 ? "8-12" :
      twsAvg < 16 ? "12-16" :
      twsAvg < 20 ? "16-20" :
      twsAvg < 25 ? "20-25" : "25+";
    tags.push({ tag_key: "tws_bracket", tag_value: twsBracket, source: "instrument" });

    // Point of sail from average TWA
    const twaAvg = Math.abs(avg("twa"));
    const pos =
      twaAvg < 60  ? "upwind" :
      twaAvg < 100 ? "reaching" : "downwind";
    tags.push({ tag_key: "point_of_sail", tag_value: pos, source: "instrument" });
  }

  // ── Sails in use during window ─────────────────────────────────────────
  // Find most recent SailsUp event before or during the window
  const sailsAtWindow = [...events.sailsUpEvents]
    .filter((s) => s.utc <= winEnd)
    .sort((a, b) => b.utc - a.utc)[0];

  if (sailsAtWindow) {
    sailsAtWindow.sails.forEach((sail) => {
      tags.push({ tag_key: "sail", tag_value: sail, source: "sail" });
    });
  }

  // ── Event-based tags (tacks, gybes, mark roundings in window) ─────────
  const tacksInWindow = events.tackJibes.filter(
    (tj) => tj.utc >= winStart && tj.utc <= winEnd && tj.isTack
  );
  const gybesInWindow = events.tackJibes.filter(
    (tj) => tj.utc >= winStart && tj.utc <= winEnd && !tj.isTack
  );
  const marksInWindow = events.markRoundings.filter(
    (mr) => mr.utc >= winStart && mr.utc <= winEnd
  );

  if (tacksInWindow.length > 0) {
    tags.push({ tag_key: "manoeuvre", tag_value: "tack", source: "event" });
    tags.push({ tag_key: "tack_count", tag_value: String(tacksInWindow.length), source: "event" });
  }
  if (gybesInWindow.length > 0) {
    tags.push({ tag_key: "manoeuvre", tag_value: "gybe", source: "event" });
    tags.push({ tag_key: "gybe_count", tag_value: String(gybesInWindow.length), source: "event" });
  }
  marksInWindow.forEach((mr) => {
    tags.push({
      tag_key: "mark_rounding",
      tag_value: mr.isTopMark ? "top_mark" : "leeward_gate",
      source: "event",
    });
  });

  // Race vs training
  const phaseInWindow = events.phases.find(
    (p) => p.startUtc >= winStart && p.startUtc <= winEnd
  );
  if (phaseInWindow) {
    tags.push({
      tag_key: "session_type",
      tag_value: phaseInWindow.isRace ? `race_${phaseInWindow.raceNum}` : "training",
      source: "event",
    });
    if (phaseInWindow.testSubject) {
      tags.push({
        tag_key: "test_subject",
        tag_value: phaseInWindow.testSubject,
        source: "event",
      });
    }
  }

  // Location from meta
  if (events.meta.location) {
    tags.push({ tag_key: "location", tag_value: events.meta.location, source: "event" });
  }

  return tags;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE INSERTION HELPERS (Prisma-compatible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a window of log entries to the `log_entries` Prisma insert format.
 * Call this after auto-sync to populate the database.
 *
 * @param videoId        UUID of the video in the `videos` table
 * @param videoStartUtc  UTC ms of the video's first frame
 * @param log            parsed log file
 * @param syncOffsetSec  sync offset from `sync_offsets` table
 * @param sampleEveryN   downsample: insert 1 row every N log entries (default 1 = all)
 */
export function logEntriesToDbRows(
  videoId: string,
  videoStartUtc: number,
  log: ParsedLogFile,
  syncOffsetSec = 0,
  sampleEveryN = 1
) {
  const syncMs = syncOffsetSec * 1000;
  return log.entries
    .filter((_, i) => i % sampleEveryN === 0)
    .map((e) => ({
      video_id:    videoId,
      // offset_ms is the number of ms from video start to this data point
      offset_ms:   Math.round(e.utc - videoStartUtc - syncMs),
      utc_ms:      e.utc,
      lat:         e.lat,
      lon:         e.lon,
      tws:         e.tws,
      twa:         e.twa,
      twd:         e.twd,
      bsp:         e.bsp,
      sog:         e.sog,
      cog:         e.cog,
      vmg:         e.vmg,
      heel:        e.heel,
      awa:         e.awa,
      aws:         e.aws,
      leeway:      e.leeway,
      vs_perf_pct: e.vsPerfPct,
      rudder:      e.rudder,
    }));
}

/**
 * Convert parsed event marks to the `event_marks` Prisma insert format.
 */
export function eventMarksToDbRows(
  videoId: string,
  videoStartUtc: number,
  events: ParsedEventFile,
  syncOffsetSec = 0
) {
  const syncMs = syncOffsetSec * 1000;
  const rows: object[] = [];

  events.tackJibes.forEach((tj) => {
    rows.push({
      video_id:    videoId,
      offset_ms:   Math.round(tj.utc - videoStartUtc - syncMs),
      utc_ms:      tj.utc,
      mark_type:   tj.isTack ? "tack" : "gybe",
      is_valid:    tj.isValidPerf,
      description: tj.errorMessage || null,
    });
  });

  events.markRoundings.forEach((mr) => {
    rows.push({
      video_id:    videoId,
      offset_ms:   Math.round(mr.utc - videoStartUtc - syncMs),
      utc_ms:      mr.utc,
      mark_type:   mr.isTopMark ? "top_mark" : "leeward_gate",
      is_valid:    mr.isValid,
      description: mr.errorMessage || null,
    });
  });

  events.sailsUpEvents.forEach((su) => {
    rows.push({
      video_id:    videoId,
      offset_ms:   Math.round(su.utc - videoStartUtc - syncMs),
      utc_ms:      su.utc,
      mark_type:   "sail_change",
      is_valid:    true,
      description: `Sails: ${su.sails.join(", ")}`,
    });
  });

  events.raceGuns.forEach((rg) => {
    rows.push({
      video_id:    videoId,
      offset_ms:   Math.round(rg.utc - videoStartUtc - syncMs),
      utc_ms:      rg.utc,
      mark_type:   "race_start_gun",
      is_valid:    true,
      description: `Race ${rg.raceNumber}`,
    });
  });

  return rows;
}
