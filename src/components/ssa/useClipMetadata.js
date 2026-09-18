'use client'
import { useCallback } from "react";
import { isCloudVideoId, upsertVideoCloud } from '../../lib/cloud-videos';
import { computeAutoTags, saveSyncOffset, updateVideoRotation, updateVideoStartUtc, updateVideoTags } from '../../lib/localStore';
import { getBrowserSupabase } from '../../lib/supabase/browser';
import { enrichVideo, isAutoTag } from '../../lib/videoEnrich';

export function useClipMetadata({
  setAllVideos, logData, xmlData, selectedVideo, setSelectedVideo,
  syncOffsets, setSyncOffsets, activeDate, effectiveRole,
}) {
  // Rotate a clip — TL3 and above (the senior ladder, same as Boat Config). Writes the
  // ANGLE to IndexedDB and to the cloud row; the source file is never re-encoded, which
  // is the entire point: QuickTime Player's rotate transcodes and strips the capture
  // metadata, so clips arrived carrying their edit time instead of their recording time.
  const canRotate = ['admin','team_manager','coach','tl3'].includes(effectiveRole);
  const rotateVideo = useCallback(async (video, deg) => {
    if (!canRotate || !video?.id) return;
    setAllVideos(p => p.map(v => v.id === video.id ? { ...v, rotation: deg } : v));
    setSelectedVideo(v => (v && v.id === video.id ? { ...v, rotation: deg } : v));
    try { await updateVideoRotation(video.id, deg); } catch { /* local only */ }
    const cloudId = video.cloudId || (isCloudVideoId(video.id) ? video.id : null);
    if (cloudId) {
      try {
        await fetch(`/api/videos/${encodeURIComponent(cloudId)}/rotation`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rotation: deg }),
        });
      } catch { /* stays local until the next sync */ }
    }
  }, [canRotate, setAllVideos, setSelectedVideo]);

  // Bake a sync offset into one or more clips' startUtc — local IDB + cloud
  // row + auto-tag recomputation in one shot. Used by both the per-clip Save
  // button in the SyncControl and the batch Sync apply path. Returns the
  // number of clips actually updated (clips with no startUtc are skipped).
  const saveSyncForVideos = useCallback(async (videos, offsetSecs) => {
    if (!offsetSecs || !videos?.length) return 0;
    let supabaseUser = null;
    try {
      const supabase = getBrowserSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      supabaseUser = user;
    } catch {}
    const enriched = {};
    const newOffsetMap = { ...syncOffsets };
    for (const v of videos) {
      if (v.startUtc == null) continue;
      const newStartUtc = v.startUtc + offsetSecs * 1000;
      // Recompute auto-tags from the new startUtc (window shifts).
      const autoTags = computeAutoTags(newStartUtc, v.duration, logData, xmlData, 0);
      const manualTags = (v.tags || []).filter(t => !isAutoTag(t));
      const mergedTags = [...new Set([...autoTags, ...manualTags])];
      // 1. Local IDB (no-op for cloud-only entries).
      try { await updateVideoStartUtc(v.id, newStartUtc); } catch {}
      try { await updateVideoTags(v.id, mergedTags); } catch {}
      // 2. Cloud row — propagate startUtc + tags + reset stored offset.
      if (supabaseUser) {
        try {
          await upsertVideoCloud({
            userId: supabaseUser.id,
            sessionDate: v.sessionDate || activeDate,
            title: v.title || v.name || null,
            startUtc: newStartUtc,
            durationSec: v.duration ?? null,
            tags: mergedTags,
            syncOffsetSecs: 0,                // baked in
            thumbnailUrl: v.thumbnailUrl ?? null,
            bunnyStreamId: v.streamId ?? null,
            bunnyStoragePath: v.bunny_storage_path ?? null,
            bytes: v.size ?? null,
            externalId: v.externalId || v.id,
          });
        } catch { /* non-fatal — local copy is updated */ }
      }
      // 3. Local sync-offset preference → 0.
      saveSyncOffset(v.id, 0);
      delete newOffsetMap[v.id];
      enriched[v.id] = enrichVideo({ ...v, startUtc: newStartUtc, tags: mergedTags }, logData, xmlData, newOffsetMap);
    }
    const updatedCount = Object.keys(enriched).length;
    if (updatedCount) {
      setSyncOffsets(newOffsetMap);
      setAllVideos(p => p.map(v => enriched[v.id] || v));
      if (selectedVideo && enriched[selectedVideo.id]) setSelectedVideo(enriched[selectedVideo.id]);
    }
    return updatedCount;
  }, [activeDate, syncOffsets, logData, xmlData, selectedVideo, setAllVideos, setSelectedVideo, setSyncOffsets]);

  // Fire-and-forget cloud upsert for a single clip's metadata. Used by
  // every code path that mutates a clip's tags / startUtc / duration on
  // disk — crop, StartTimeEditor, Re-tag-all — so that the videos row
  // reflects the change and other users / devices pick it up via the
  // cloud-authoritative tags merge in loadDate. `overrides` lets the
  // caller send the post-mutation values (e.g. newStartUtc after a crop)
  // even when the in-memory `video` shape hasn't been re-rendered yet.
  const pushVideoMetadataToCloud = useCallback(async (video, overrides = {}) => {
    if (!video) return false;
    try {
      const supabase = getBrowserSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return false;
      await upsertVideoCloud({
        userId: user.id,
        sessionDate: video.sessionDate || activeDate,
        title: video.title || video.name || null,
        startUtc: video.startUtc ?? null,
        durationSec: video.duration ?? null,
        tags: video.tags ?? [],
        syncOffsetSecs: syncOffsets[video.id] ?? 0,
        thumbnailUrl: video.thumbnailUrl ?? null,
        bunnyStreamId: video.streamId ?? null,
        bunnyStoragePath: video.bunny_storage_path ?? null,
        bytes: video.size ?? null,
        externalId: video.externalId || video.id,
        ...overrides,
      });
      return true;
    } catch (e) { console.warn('[cloud] meta push failed', e); return false; }
  }, [activeDate, syncOffsets]);

  // Persist tag edits to BOTH local IDB and the Supabase row. Without the
  // cloud upsert, tag edits on cloud-only clips (uploaded from another
  // device, no local IDB entry) silently revert on the next library reload
  // — updateVideoTags is a no-op for missing IDB entries. On desktop the
  // earlier wiring didn't even hit IDB, only React state, so every tag
  // edit reverted there too. Used by both TagEditor onSave handlers.
  const saveTagsForVideo = useCallback(async (video, newTags) => {
    if (!video) return;
    // 1. Local IDB (no-op for cloud-only entries).
    try { await updateVideoTags(video.id, newTags); } catch (e) { console.warn('[tags] IDB write failed', e); }
    // 2. Cloud row — preserves the edit across tab close + other devices.
    //    Surface failures: silent returns from upsertVideoCloud (no active
    //    membership, RLS denial, network) were hiding real cloud-sync
    //    breakage and making "tags don't propagate" hard to diagnose.
    try {
      const supabase = getBrowserSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        console.warn('[tags] cloud sync skipped — not signed in');
      } else {
        const res = await upsertVideoCloud({
          userId: user.id,
          sessionDate: video.sessionDate || activeDate,
          title: video.title || video.name || null,
          startUtc: video.startUtc ?? null,
          durationSec: video.duration ?? null,
          tags: newTags,
          syncOffsetSecs: syncOffsets[video.id] ?? 0,
          thumbnailUrl: video.thumbnailUrl ?? null,
          bunnyStreamId: video.streamId ?? null,
          bunnyStoragePath: video.bunny_storage_path ?? null,
          bytes: video.size ?? null,
          externalId: video.externalId || video.id,
        });
        if (!res.ok) {
          console.warn('[tags] cloud upsert FAILED', {
            videoId: video.id,
            externalId: video.externalId || video.id,
            sessionDate: video.sessionDate || activeDate,
            error: res.error,
            noMembership: res.noMembership,
          });
        } else {
          // Action=updated means the dedupe found the existing row and
          // applied tags. action=created means the server didn't find a
          // matching row (external_id / bunny_stream_id mismatch) and
          // inserted a NEW row — symptom of a duplicate-clip problem
          // where the original cloud row still has the old tags.
          console.log('[tags] cloud upsert OK', {
            videoId: video.id,
            externalId: video.externalId || video.id,
            cloudRowId: res.videoId,
            action: res.action,
            tags: newTags,
          });
          if (res.action === 'created') {
            console.warn('[tags] ⚠ INSERTED a new cloud row instead of updating — likely a duplicate. mobile will keep reading the original row.', {
              externalIdSent: video.externalId || video.id,
              newRowId: res.videoId,
            });
          }
        }
      }
    } catch (e) { console.warn('[tags] cloud upsert threw', e); }
    // 3. Update React state so the UI reflects immediately.
    setAllVideos(p => p.map(v => v.id === video.id ? { ...v, tags: newTags } : v));
    setSelectedVideo(p => p && p.id === video.id ? { ...p, tags: newTags } : p);
  }, [activeDate, syncOffsets, setAllVideos, setSelectedVideo]);

  return { canRotate, rotateVideo, saveSyncForVideos, pushVideoMetadataToCloud, saveTagsForVideo };
}
