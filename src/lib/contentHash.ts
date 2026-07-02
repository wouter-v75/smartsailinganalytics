// Fast, stable content hashing for change-detection (NOT cryptographic).
//
// We only need "did these bytes change vs what the cloud already has?" — a cheap
// 53-bit hash over the JSON/string payload is plenty and runs instantly even on
// a phone. This replaces trusting a local "synced" boolean (which drifts after
// failed uploads / reinstalls / multi-device use) with a content fingerprint the
// client and cloud can both compute. See docs/sync-caching-architecture-research.md.

// cyrb53 — a well-known fast non-cryptographic string hash. Returns a stable
// hex string. Deterministic across sessions and devices for identical input.
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return n.toString(16).padStart(14, '0')
}

// Hash a JSON-serialisable value. We hash the exact string we would upload, so
// the fingerprint matches the stored payload byte-for-byte (per build).
export function hashJson(value: unknown): string {
  try {
    return hashString(JSON.stringify(value))
  } catch {
    return hashString(String(value))
  }
}

// Convenience: hash of the meaningful log payload (rows + start/end), ignoring
// volatile fields like uploadedAt so re-uploading identical rows is a no-op.
export function hashLogPayload(logData: {
  rows?: unknown[]
  startUtc?: unknown
  endUtc?: unknown
} | null | undefined): string | null {
  if (!logData?.rows?.length) return null
  return hashJson({ rows: logData.rows, startUtc: logData.startUtc ?? null, endUtc: logData.endUtc ?? null })
}

// Hash of the meaningful XML/event payload, ignoring volatile fields.
export function hashXmlPayload(xmlData: Record<string, unknown> | null | undefined): string | null {
  if (!xmlData) return null
  // Strip volatile / transport-only keys before hashing.
  const { uploadedAt: _u, source: _s, ...stable } = xmlData as Record<string, unknown>
  return hashJson(stable)
}
