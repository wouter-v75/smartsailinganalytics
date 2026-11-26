-- 0107_clear_superseded_stream_ids.sql
--
-- Null the legacy bunny_stream_id on rows that also carry a proxy or an
-- original Stream copy.
--
-- WHY. A clip can exist in Bunny Stream three times:
--
--   bunny_stream_id           the old syncSessionToCloud TUS upload
--   bunny_proxy_stream_id     the proxy, via /api/stream/fetch
--   bunny_original_stream_id  the original, via /api/stream/fetch
--
-- 104 rows carry all three, distinct. The legacy copy is a full-resolution
-- duplicate holding 69.7 GB, and nothing ever serves it: resolveLegacy() is the
-- LAST fallback in both branches of src/app/api/videos/[videoId]/url/route.ts
-- (lines 191 and 194), so a row with a proxy or an original never reaches it.
--
-- RUN THIS AFTER scripts/stream-dedupe.ts --write has deleted those Stream
-- videos. Order matters only for tidiness, not correctness — the column would
-- otherwise point at a video that no longer exists, which is harmless for
-- playback but misleading to read.
--
-- Rows whose ONLY copy is the legacy one are left alone: that copy is the clip,
-- and the script does not delete it either.
--
-- Additive and idempotent: re-running changes nothing, because the WHERE clause
-- no longer matches once the column is null. Follows 0106_boat_sailcharts.sql.

begin;

-- What it will touch, for the record. Read this before committing.
do $$
declare n integer;
begin
  select count(*) into n
  from videos
  where bunny_stream_id is not null
    and bunny_stream_id is distinct from bunny_proxy_stream_id
    and bunny_stream_id is distinct from bunny_original_stream_id
    and (bunny_proxy_stream_id is not null or bunny_original_stream_id is not null);
  raise notice 'clearing superseded bunny_stream_id on % rows', n;
end $$;

update videos
   set bunny_stream_id = null
 where bunny_stream_id is not null
   and bunny_stream_id is distinct from bunny_proxy_stream_id
   and bunny_stream_id is distinct from bunny_original_stream_id
   and (bunny_proxy_stream_id is not null or bunny_original_stream_id is not null);

commit;
