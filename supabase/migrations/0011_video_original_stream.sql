-- ============================================================================
-- SSA — Phase 2: full-resolution originals move to Bunny Stream.
--
-- The two-tier sync uploads a small proxy (Bunny Storage) for instant preview
-- and the full-resolution original separately. Phase 2 routes that original
-- upload through Bunny Stream's TUS resumable endpoint — uploads survive
-- dropped connections on slow wifi, and Bunny produces an adaptive-bitrate
-- HLS ladder for playback.
--
-- bunny_original_stream_id holds the GUID of that Bunny Stream video. It is
-- distinct from bunny_stream_id, which is the legacy "the whole clip is a
-- Stream video" identifier from the pre-two-tier flow.
--
-- Run after 0010. Idempotent.
-- ============================================================================

ALTER TABLE public.videos
    ADD COLUMN IF NOT EXISTS bunny_original_stream_id TEXT;

COMMENT ON COLUMN public.videos.bunny_original_stream_id IS
    'GUID of the Bunny Stream video holding the full-resolution original (Phase 2 two-tier sync). NULL until the original has been uploaded. Distinct from bunny_stream_id (legacy whole-clip Stream id).';
