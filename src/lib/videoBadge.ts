// Is this clip in the cloud, for the LOCAL/CLOUD badge?
//
// `source` alone never answered it: a clip imported on this machine keeps
// source==='local' for ever, including after it has been uploaded — so the
// player panel showed LOCAL for clips that were safely in the cloud.
//
// The flags that DO answer it arrive by three different routes, hence the list:
//   - cloudSynced + streamId     — the legacy direct-to-Stream upload
//   - hasProxy / hasOriginal     — adopted from the cloud row when the day loads
//   - originalUploadedAt / originalStreamId — the storage-first upload's own mark
//     on the local record (watch folder, Videos tab). Without this a clip read
//     LOCAL from the moment it finished uploading until the next day-load merge,
//     and stayed LOCAL offline.

export type BadgeSource = 'local' | 'cloud' | 'processing'

export interface BadgeVideo {
  source?: string | null
  streamProcessing?: boolean
  streamId?: string | null
  hasProxy?: boolean
  hasOriginal?: boolean
  cloudSynced?: boolean
  originalUploadedAt?: number | string | null
  originalStreamId?: string | null
}

export function videoBadgeSrc(v?: BadgeVideo | null): BadgeSource {
  if (!v) return 'local'
  if (v.source === 'processing' || v.streamProcessing) return 'processing'
  if (
    v.streamId || v.hasProxy || v.hasOriginal || v.cloudSynced ||
    v.originalUploadedAt || v.originalStreamId ||
    v.source === 'cloud' || v.source === 'supabase'
  ) return 'cloud'
  return 'local'
}
