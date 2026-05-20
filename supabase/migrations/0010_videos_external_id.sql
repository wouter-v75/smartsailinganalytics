-- ============================================================================
-- SSA — Link cloud video rows to the local IndexedDB id.
--
-- The browser-side IDB stores each imported clip with an id like
-- `v_<epoch>_<rand>`. The Supabase `videos.id` is a UUID. Until Phase B,
-- the cloud row was only created during Stream upload and dedupe ran off
-- `bunny_stream_id`. Phase B's proxy-first flow uploads to Bunny Storage
-- without ever touching Stream, so we need a stable handle for the
-- proxy-sync code to find / create the right row.
--
-- `external_id` is that handle. Unique per boat so two boats in the same
-- team can independently import a clip with the same local id (unlikely
-- but harmless if it ever happens).
--
-- Idempotent. Safe to re-run.
-- ============================================================================

ALTER TABLE public.videos
    ADD COLUMN IF NOT EXISTS external_id TEXT;

-- Partial unique index — NULLs allowed (every pre-Phase-B row has NULL
-- here), exactly one row per (boat_id, external_id) when set.
CREATE UNIQUE INDEX IF NOT EXISTS videos_boat_external_id_uq
    ON public.videos(boat_id, external_id)
    WHERE external_id IS NOT NULL;

COMMENT ON COLUMN public.videos.external_id IS
    'Local IndexedDB id of the source clip on the importing device.
     Used by the Phase B proxy-sync flow to dedupe / find the row
     without requiring a bunny_stream_id.';
