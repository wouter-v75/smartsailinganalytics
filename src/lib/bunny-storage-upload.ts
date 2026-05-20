// Direct browser → Bunny Storage uploads with progress.
//
// PhotosTab and bunny.js already do PUT-with-AccessKey straight from the
// browser using credentials fetched from /api/storage/credentials. This
// helper centralises that pattern and adds upload-progress reporting so
// the proxy/original sync UI can show a meaningful per-clip bar.
//
// We use XHR rather than fetch because fetch() still has no portable
// progress API for upload streams (May 2026 — the Streams-based proposal
// is shipped in Chrome/Edge but not yet in Safari iOS, which is where
// most field-side users live).
//
// Security note: /api/storage/credentials hands out the write key to any
// fetch from the browser. Pre-existing behaviour for photo uploads.
// Tightening that endpoint to require an authed user is a separate
// concern — flagged in memory, not done here.

interface StorageCreds {
  accessKey: string
  zone: string
  host: string
}

let credsCache: { creds: StorageCreds; at: number } | null = null
const CRED_TTL_MS = 5 * 60 * 1000 // 5 min — cheap, no real freshness need

async function getCreds(): Promise<StorageCreds> {
  if (credsCache && Date.now() - credsCache.at < CRED_TTL_MS) {
    return credsCache.creds
  }
  const res = await fetch('/api/storage/credentials')
  if (!res.ok) throw new Error(`storage credentials: HTTP ${res.status}`)
  const j = (await res.json()) as StorageCreds
  if (!j.accessKey || !j.zone || !j.host) {
    throw new Error('storage credentials: missing fields')
  }
  credsCache = { creds: j, at: Date.now() }
  return j
}

function safeKey(k: string): string {
  return k.replace(/\.\./g, '').replace(/^\/+/, '')
}

export interface UploadProgress {
  /** 0..1 bytes uploaded over total. */
  fraction: number
  bytesUploaded: number
  bytesTotal: number
}

export interface UploadOpts {
  /** Path inside the Storage Zone, e.g. `sessions/2026-04-16/proxies/v_abc.mp4`. */
  key: string
  /** The blob to upload. */
  blob: Blob
  /** MIME type. Default: blob.type, or `application/octet-stream`. */
  contentType?: string
  /** Progress callback. */
  onProgress?: (p: UploadProgress) => void
  /** AbortSignal for cancellation. */
  signal?: AbortSignal
}

export interface UploadResult {
  /** The key relative to the Storage Zone (same as input `key`). */
  key: string
  bytes: number
}

/**
 * PUT a blob to Bunny Storage at the given key. Returns when the upload
 * completes (Bunny returns 201).
 *
 * @throws on HTTP failure, network error, or abort.
 */
export async function uploadBlobToStorage({
  key,
  blob,
  contentType,
  onProgress,
  signal,
}: UploadOpts): Promise<UploadResult> {
  const { accessKey, zone, host } = await getCreds()
  const cleanKey = safeKey(key)
  const url = `${host}/${zone}/${cleanKey}`

  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('AccessKey', accessKey)
    xhr.setRequestHeader(
      'Content-Type',
      contentType || blob.type || 'application/octet-stream'
    )

    if (onProgress) {
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return
        onProgress({
          fraction: ev.total ? ev.loaded / ev.total : 0,
          bytesUploaded: ev.loaded,
          bytesTotal: ev.total,
        })
      }
    }

    if (signal) {
      if (signal.aborted) {
        xhr.abort()
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    xhr.onerror = () => reject(new Error('network error during upload'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ key: cleanKey, bytes: blob.size })
      } else {
        reject(
          new Error(`upload failed: HTTP ${xhr.status} ${xhr.statusText}`)
        )
      }
    }

    xhr.send(blob)
  })
}
