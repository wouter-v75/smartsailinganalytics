-- 0110 — clear the `bunny_storage_path` values that never named a real object.
--
-- Additive and idempotent. Follows 0109. Nothing in the app reads these any
-- more (see 0110's companion commit: /api/videos/:id/url now tries the row's
-- own `bunny_stream_id` as Stream HLS before it reaches the storage path), so
-- this is tidy-up, not a fix — the fix shipped in the code.
--
-- WHAT THEY ARE. The session-sync upload flow, removed Nov 2026, uploaded a
-- clip to Bunny STREAM and then wrote `bunny_storage_path` as
--
--     sessions/<date>/videos/<local idb id>/original
--
-- which is where the file WOULD have gone had that flow used Storage. It did
-- not. Nothing ever PUT that key. The admin backfill minted the same string
-- from meta.json for the same reason and no longer does.
--
-- MEASURED on the live zone, 26 Nov 2026: 79 rows carry a path of this shape;
-- every one probed through the Storage API answered 404. 37 of them have no
-- proxy and no original, which is why `resolveLegacy()` was reaching them and
-- serving a signed URL to nothing.
--
-- WHY THE SHAPE MATTERS, and why this does not just null the column: a REAL
-- storage path is the only playback source some pre-proxy rows have. The two
-- layouts are distinguishable — a real one ends `.mp4` and sits under
-- `proxies/` or `originals/` (or a team-scoped prefix); the invented one is
-- `sessions/<date>/videos/<id>/original`, with no extension. Only that exact
-- shape is cleared, and only where the row still has SOMETHING to play from, so
-- a row whose sole locator is an invented path keeps it rather than becoming
-- unreachable by every route at once.
--
-- Run it twice and the second run reports 0.

do $$
declare
  n_total   int;
  n_cleared int;
begin
  select count(*) into n_total
    from public.videos
   where bunny_storage_path ~ '^sessions/[0-9]{4}-[0-9]{2}-[0-9]{2}/videos/[^/]+/original$';

  raise notice 'rows carrying an invented storage path: %', n_total;

  with cleared as (
    update public.videos
       set bunny_storage_path = null
     where bunny_storage_path ~ '^sessions/[0-9]{4}-[0-9]{2}-[0-9]{2}/videos/[^/]+/original$'
       -- never leave a row with no locator at all
       and (
            bunny_stream_id is not null
         or bunny_proxy_stream_id is not null
         or bunny_original_stream_id is not null
         or bunny_proxy_path is not null
         or bunny_original_path is not null
       )
    returning 1
  )
  select count(*) into n_cleared from cleared;

  raise notice 'cleared: %  (left alone, no other locator: %)', n_cleared, n_total - n_cleared;
end $$;

-- What should be left: no row anywhere still naming the invented layout while
-- having something else to play from.
select count(*) as still_invented_with_another_locator
  from public.videos
 where bunny_storage_path ~ '^sessions/[0-9]{4}-[0-9]{2}-[0-9]{2}/videos/[^/]+/original$'
   and (
        bunny_stream_id is not null
     or bunny_proxy_stream_id is not null
     or bunny_original_stream_id is not null
     or bunny_proxy_path is not null
     or bunny_original_path is not null
   );
