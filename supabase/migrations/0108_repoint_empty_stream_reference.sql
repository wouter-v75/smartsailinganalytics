-- 0108_repoint_empty_stream_reference.sql
--
-- One clip's row points at an EMPTY Bunny Stream video while the real encode
-- sits beside it, unreferenced.
--
--   title                 20260728 112202
--   referenced (empty)    eb072599-7e3d-4d9e-8d61-9309bc9665a0   0 MB, status 'created'
--   the actual encode     c8d8d6f6-431b-47f4-83d8-c56ca21c6b7a   139 MB, 720p, ready
--
-- So the clip is unplayable: url/route.ts resolves from bunny_original_stream_id,
-- which names a video that has no bytes. A Stream video object was created, the
-- TUS upload was abandoned, and a later attempt completed under a second object
-- that nothing was ever pointed at.
--
-- This repoints the row at the copy that has the footage. Both GUIDs are named
-- explicitly rather than matched by title, so what it does is auditable and it
-- cannot touch another row.
--
-- Found by scripts/stream-dedupe.ts, which refuses to delete either copy while
-- the row points at the empty one — deleting the empty one would leave the row
-- dangling, and deleting the full one would lose the clip.
--
-- RUN THIS BEFORE scripts/stream-dedupe.ts --write. Afterwards the empty stub
-- becomes an ordinary unreferenced orphan and the script will clear it.
--
-- Idempotent: the WHERE clause stops matching once the repoint has happened.
-- Follows 0107_clear_superseded_stream_ids.sql.

begin;

do $$
declare n integer;
begin
  select count(*) into n
  from videos
  where bunny_original_stream_id = 'eb072599-7e3d-4d9e-8d61-9309bc9665a0';
  raise notice 'repointing % row(s) from the empty stub to the 139 MB encode', n;
end $$;

update videos
   set bunny_original_stream_id = 'c8d8d6f6-431b-47f4-83d8-c56ca21c6b7a'
 where bunny_original_stream_id = 'eb072599-7e3d-4d9e-8d61-9309bc9665a0';

commit;
