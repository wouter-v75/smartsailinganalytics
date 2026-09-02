// src/lib/scanTime.ts
// ─────────────────────────────────────────────────────────────────────────────
// Display a sail scan's capture time in VENUE-LOCAL time — never the viewer's
// machine zone. A North/thesailcloud report writes the capture time as a local
// wall-clock string (no zone); that string (`conditions.captured_local`) IS the
// venue-local time, so we render it verbatim. When only the true-UTC `captured_at`
// is present, we fall back to it + the session's venue offset (sessionTzOffset).
// ─────────────────────────────────────────────────────────────────────────────

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n: number) => String(n).padStart(2, '0')
export const tzShortOf = (off: number) =>
  off === 120 ? 'CEST' : off === 60 ? 'UTC+1' : off === 0 ? 'UTC' : `UTC${off >= 0 ? '+' : ''}${off / 60}`

interface Parts { y: number; mo: number; d: number; h: number; mi: number; zone: string }

// Returns the venue-local date/time parts for a scan, or null.
export function scanLocalParts(scan: any, sessionTzOffset = 0): Parts | null {
  const cl: string | undefined = scan?.conditions?.captured_local
  if (cl) {
    const m = cl.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
    if (m) return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], zone: tzShortOf(sessionTzOffset) }
  }
  const at: string | null = scan?.captured_at || null
  if (at) {
    const ms = new Date(at).getTime()
    if (Number.isFinite(ms)) {
      const dt = new Date(ms + sessionTzOffset * 60000)
      return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), h: dt.getUTCHours(), mi: dt.getUTCMinutes(), zone: tzShortOf(sessionTzOffset) }
    }
  }
  return null
}

export const scanLocalDateTime = (scan: any, off = 0) => {
  const p = scanLocalParts(scan, off)
  return p ? `${p2(p.d)} ${MON[p.mo - 1]} ${p.y}, ${p2(p.h)}:${p2(p.mi)} ${p.zone}` : '—'
}
export const scanLocalDateISO = (scan: any, off = 0) => {
  const p = scanLocalParts(scan, off)
  return p ? `${p.y}-${p2(p.mo)}-${p2(p.d)}` : null
}
export const scanLocalHM = (scan: any, off = 0) => {
  const p = scanLocalParts(scan, off)
  return p ? `${p2(p.h)}:${p2(p.mi)} ${p.zone}` : ''
}

// ── editing a scan's capture time ────────────────────────────────────────────
// The inverse of scanLocalParts. A scan carries the capture time TWICE: the
// literal venue-local wall clock in `conditions.captured_local` (what the North
// report wrote, and what scanLocalParts reads FIRST) and the true UTC instant in
// `captured_at`. Writing only one of them silently does nothing visible, because
// captured_local wins the read — so an edit must always produce BOTH, derived
// from the same wall clock, or the two drift apart.
//
// `dateISO` is YYYY-MM-DD and `timeHM` is HH:MM, both as the crew read them at
// the venue; sessionTzOffset is the venue's offset in minutes east of UTC.
export function localToScanStamps(
  dateISO: string,
  timeHM: string,
  sessionTzOffset = 0
): { captured_local: string; captured_at: string } | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateISO || '').trim())
  const t = /^(\d{1,2}):(\d{2})$/.exec((timeHM || '').trim())
  if (!d || !t) return null
  const y = +d[1]; const mo = +d[2]; const day = +d[3]
  const h = +t[1]; const mi = +t[2]
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || mi > 59) return null
  const ms = Date.UTC(y, mo - 1, day, h, mi) - sessionTzOffset * 60000
  if (!Number.isFinite(ms)) return null
  // Guard against a rolled-over date (e.g. 31 Feb becoming 3 Mar): reject rather
  // than silently storing a different day than the one typed.
  const back = new Date(ms + sessionTzOffset * 60000)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== day) return null
  return {
    captured_local: `${d[1]}-${d[2]}-${d[3]} ${p2(h)}:${p2(mi)}`,
    captured_at: new Date(ms).toISOString(),
  }
}
