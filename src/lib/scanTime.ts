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
