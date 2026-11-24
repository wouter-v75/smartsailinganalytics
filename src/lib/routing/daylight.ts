// Day and night, for a polar that is sailed less well in the dark.
//
// Offshore, a boat sails a smaller share of its polar at night: the trimmers
// cannot see the sails or the waves, the helm steers to instruments, and the
// watch is half the crew. The usual allowance is a percentage of the polar by
// day and a lower one by night (95 % / 90 % is the standard set-up here). This
// is the switch between them: the sun's altitude at the BOAT's position and
// time, so the night is where the boat is, not at the start line — on a race
// that crosses five time zones westward, darkness comes later every evening.
//
// Darkness is the sun below `darkBelowDeg` (default -0.833 deg: sunset and
// sunrise, the upper limb on the horizon with standard refraction). Civil
// twilight (-6) is the alternative for a crew that still trims by the last of
// the light.
//
// The solar position is the low-precision one from the Astronomical Almanac
// (good to ~0.01 deg in declination and ~0.1 min in time over 1950-2050): far
// below the resolution of a 30 min routing step.

const D2R = Math.PI / 180

/** Sun altitude above the horizon, degrees, without refraction. */
export function sunAltitudeDeg(lat: number, lon: number, tMs: number): number {
  return Math.asin(sinSunAltitude(lat, lon, tMs)) / D2R
}

// Declination and right ascension move ~1 deg a day; the Earth's rotation is
// what changes by the minute. So the slow part is cached per hour and only the
// sidereal time is computed per call — the routers ask tens of millions of times.
let cacheHour = NaN, sinDec = 0, cosDec = 0, raDeg = 0

function sinSunAltitude(lat: number, lon: number, tMs: number): number {
  const d = tMs / 86400e3 - 10957.5 // days since J2000.0 (2000-01-01 12:00 UTC)
  const hour = Math.floor(tMs / 3600e3)
  if (hour !== cacheHour) {
    const dh = (hour + 0.5) * 3600e3 / 86400e3 - 10957.5
    const g = (357.529 + 0.98560028 * dh) * D2R
    const q = 280.459 + 0.98564736 * dh
    const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R
    const e = (23.439 - 0.00000036 * dh) * D2R
    const dec = Math.asin(Math.sin(e) * Math.sin(L))
    sinDec = Math.sin(dec); cosDec = Math.cos(dec)
    raDeg = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / D2R
    cacheHour = hour
  }
  const gmstDeg = 280.46061837 + 360.98564736629 * d
  const H = (gmstDeg + lon - raDeg) * D2R
  const la = lat * D2R
  return Math.sin(la) * sinDec + Math.cos(la) * cosDec * Math.cos(H)
}

export interface DayNight {
  dayFactor: number
  nightFactor: number
  /** Sun altitude (deg) below which it is dark. */
  darkBelowDeg: number
}

/** The share of the polar the boat sails at (lat, lon, t). */
export function makePerf(o: DayNight): ((lat: number, lon: number, tMs: number) => number) | undefined {
  if (o.dayFactor === 1 && o.nightFactor === 1) return undefined
  const s = Math.sin(o.darkBelowDeg * D2R)
  return (lat, lon, tMs) => (sinSunAltitude(lat, lon, tMs) < s ? o.nightFactor : o.dayFactor)
}

/** True when it is dark at (lat, lon, t) by the same rule. */
export function isDark(lat: number, lon: number, tMs: number, darkBelowDeg = -0.833): boolean {
  return sinSunAltitude(lat, lon, tMs) < Math.sin(darkBelowDeg * D2R)
}
