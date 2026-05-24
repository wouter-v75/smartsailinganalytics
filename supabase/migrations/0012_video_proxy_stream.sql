-- ============================================================================
-- SSA — Genuine ABR: the 720p proxy is uploaded to Bunny Stream.
--
-- Previously the proxy was a single-bitrate MP4 in the Bunny Storage Zone.
-- It is now uploaded to Bunny Stream, which encodes an adaptive-bitrate HLS
-- ladder (240p–720p) so playback degrades gracefully on weak connections
-- instead of stalling.
--
-- bunny_proxy_stream_id — GUID of that Bunny Stream video. It is the
--   proxy-tier equivalent of bunny_original_stream_id.
-- proxy_stream_status   — cached Bunny encoding status (4 = finished), so the
--   playback endpoint can skip a Bunny API round-trip on the hot path.
--
-- Run after 0011. Idempotent.
-- ============================================================================

ALTER TABLE public.videos
    ADD COLUMN IF NOT EXISTS bunny_proxy_stream_id TEXT;

ALTER TABLE public.videos
    ADD COLUMN IF NOT EXISTS proxy_stream_status SMALLINT;

COMMENT ON COLUMN public.videos.bunny_proxy_stream_id IS
    'GUID of the Bunny Stream video holding the 720p proxy (adaptive-bitrate HLS source). NULL until the proxy has been uploaded to Stream.';

COMMENT ON COLUMN public.videos.proxy_stream_status IS
    'Cached Bunny Stream encoding status for the proxy video (4 = finished). NULL = unknown / not yet checked.';
