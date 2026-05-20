-- ============================================================================
-- SSA — Two-tier video sync: proxy + original.
--
-- Field-side network (cellular at sailing venues) is too slow to push
-- multi-GB originals during a debrief. We generate a 720p / 2.5 Mbps
-- H.264 proxy locally for each clip and ship that first; originals follow
-- later on hotel wifi. Player serves whichever rendition exists, preferring
-- original. See memory: sailscan_two_tier_sync_design.md.
--
-- Schema change to public.videos:
--   - bunny_proxy_path     TEXT  — `sessions/<date>/proxies/<id>.mp4`
--   - bunny_original_path  TEXT  — `sessions/<date>/originals/<id>.mp4`
--   - has_proxy            BOOL  — set true once proxy uploaded
--   - has_original         BOOL  — set true once original uploaded
--   - proxy_uploaded_at    TIMESTAMPTZ
--   - original_uploaded_at TIMESTAMPTZ
--   - proxy_bytes          BIGINT — size of the proxy (~30 MB for 4K source)
--
-- We KEEP `bunny_storage_path` as the legacy single-path column. New code
-- uses the explicit proxy/original columns; legacy rows still resolve via
-- bunny_storage_path. The signed-URL endpoint reads all three.
--
-- Run after 0008. Idempotent.
-- ============================================================================

ALTER TABLE public.videos
    ADD COLUMN IF NOT EXISTS bunny_proxy_path     TEXT,
    ADD COLUMN IF NOT EXISTS bunny_original_path  TEXT,
    ADD COLUMN IF NOT EXISTS has_proxy             BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS has_original          BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS proxy_uploaded_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS original_uploaded_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS proxy_bytes           BIGINT;

CREATE INDEX IF NOT EXISTS videos_has_proxy_idx
    ON public.videos(team_id, boat_id, has_proxy)
    WHERE has_proxy = true;

CREATE INDEX IF NOT EXISTS videos_pending_original_idx
    ON public.videos(team_id, boat_id, has_original)
    WHERE has_original = false;

COMMENT ON COLUMN public.videos.bunny_proxy_path IS
    '720p H.264 ~2.5 Mbps proxy. Uploaded field-side for fast preview.';
COMMENT ON COLUMN public.videos.bunny_original_path IS
    'Full-resolution source. Uploaded later on faster wifi.';
COMMENT ON COLUMN public.videos.has_proxy IS
    'True once the proxy has been uploaded to bunny_proxy_path.';
COMMENT ON COLUMN public.videos.has_original IS
    'True once the original has been uploaded to bunny_original_path.';
