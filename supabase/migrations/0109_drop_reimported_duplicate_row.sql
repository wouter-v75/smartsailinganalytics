-- 0109_drop_reimported_duplicate_row.sql
--
-- One clip has TWO `videos` rows, from being imported twice.
--
--   title         20260626 154943
--   session_id    60eac270-13ff-4ac7-a1e2-7b8dc5755d50   (same)
--   start_utc     2026-06-26T13:50:36+00:00              (same)
--   duration_ms   52000                                  (same)
--   bytes         316750275                              (same)
--   tags          identical
--
--   row 5266fe66-3cf7-4f1e-a6ba-5625d59764d7  created 27 Jun  -> stream c956d377…  KEEP
--   row c7dfb6be-761e-4879-8ece-4c6629f8e504  created 29 Jun  -> stream 2bca7042…  DROP
--
-- WHY IT HAPPENED, and why it will happen again until the import changes.
-- `videos` dedupes on `external_id`, and `external_id` is the per-device random
-- id minted fresh on every import (`v_${Date.now()}_${Math.random()}`,
-- src/lib/localStore.js:270). The two rows carry `v_1782542725860_94yul1jsk4`
-- and `v_1782741517710_33oparqpy3a` — the same clip, imported two days apart,
-- so nothing could match them. Nothing anywhere compares the bytes.
--
-- This is the case that argues for a content fingerprint as the identity:
-- SHA-256(size ‖ first 1 MiB ‖ last 2 MiB), which `extractVideoCreationTime`
-- already reads off the drive for every clip (src/lib/videoProbe.js:283). With
-- it, a re-import finds the existing row instead of inserting beside it.
--
-- Dropping the row leaves Bunny Stream video 2bca7042… unreferenced, and
-- scripts/stream-dedupe.ts then clears it with the two copies that were already
-- unreferenced — 3 × 537 MB, about 1.6 GB. Run the script after this.
--
-- The rows are identical in every field that carries meaning, so neither copy
-- holds anything the other lacks. The EARLIER row is kept, as the original
-- import.
--
-- Idempotent: the row is addressed by its own id, so a second run finds nothing.
-- Follows 0108_repoint_empty_stream_reference.sql.

begin;

do $$
declare n integer;
begin
  select count(*) into n from videos
   where id = 'c7dfb6be-761e-4879-8ece-4c6629f8e504';
  raise notice 'dropping % duplicate videos row(s) for 20260626 154943', n;
end $$;

-- Guarded on the facts above: it only deletes while the row it duplicates is
-- still there and still agrees on session, start and size. If either row has
-- been touched since, this does nothing rather than guessing.
delete from videos v
 where v.id = 'c7dfb6be-761e-4879-8ece-4c6629f8e504'
   and exists (
     select 1 from videos k
      where k.id = '5266fe66-3cf7-4f1e-a6ba-5625d59764d7'
        and k.session_id is not distinct from v.session_id
        and k.start_utc  is not distinct from v.start_utc
        and k.bytes      is not distinct from v.bytes
   );

commit;
