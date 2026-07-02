// Network-aware sync helpers (Phase 3).
//
// Slow-mobile UX: thumbnails/metadata go on any link; heavy originals are held
// until the connection is good (and, if the user asked, until Wi-Fi). We also
// expose a change subscription so held transfers auto-flush when the link
// improves. Network Information API is Chromium-only; on Safari we fall back to
// navigator.onLine + the user's explicit toggle. See
// docs/sync-caching-architecture-research.md (Phase 3).

type Conn = {
  type?: string
  effectiveType?: string
  saveData?: boolean
  addEventListener?: (t: string, cb: () => void) => void
  removeEventListener?: (t: string, cb: () => void) => void
}

function conn(): Conn | null {
  if (typeof navigator === 'undefined') return null
  const n = navigator as unknown as {
    connection?: Conn; mozConnection?: Conn; webkitConnection?: Conn
  }
  return n.connection || n.mozConnection || n.webkitConnection || null
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false
}

export function isSaveData(): boolean {
  return !!conn()?.saveData
}

// True Wi-Fi/ethernet (no metered radio). Unknown on Safari → false.
export function onWifi(): boolean {
  const c = conn()
  if (!c) return false
  return c.type === 'wifi' || c.type === 'ethernet'
}

// A human label for the current link, for status UI.
export function connectionLabel(): string {
  if (!isOnline()) return 'offline'
  const c = conn()
  if (!c) return 'online'
  if (c.type === 'wifi' || c.type === 'ethernet') return 'wifi'
  if (c.saveData) return 'data-saver'
  return c.effectiveType || 'online'
}

// ── "Wi-Fi only for originals" user preference (persisted) ────────────────────
const WIFI_ONLY_KEY = 'ssa:wifiOnlyOriginals'
export function getWifiOnly(): boolean {
  try { return localStorage.getItem(WIFI_ONLY_KEY) === '1' } catch { return false }
}
export function setWifiOnly(on: boolean): void {
  try { localStorage.setItem(WIFI_ONLY_KEY, on ? '1' : '0') } catch { /* ignore */ }
}

// Good enough to push a heavy original right now? Honours Save-Data and the
// user's Wi-Fi-only toggle. `force` (an explicit "upload now" tap) bypasses.
export function goodForOriginals({ force = false } = {}): boolean {
  if (force) return isOnline()
  if (!isOnline() || isSaveData()) return false
  const c = conn()
  if (!c) return true // Safari: no API — trust onLine (user has the toggle + manual button)
  const fast = c.type === 'wifi' || c.type === 'ethernet' || (!c.type && c.effectiveType === '4g') || c.effectiveType === '4g'
  if (!fast) return false
  if (getWifiOnly() && !onWifi()) return false
  return true
}

// Subscribe to link changes (connection change + online/offline). Returns an
// unsubscribe fn. Used to auto-flush deferred originals when Wi-Fi returns.
export function onConnectionChange(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const c = conn()
  c?.addEventListener?.('change', cb)
  window.addEventListener('online', cb)
  return () => {
    c?.removeEventListener?.('change', cb)
    window.removeEventListener('online', cb)
  }
}
