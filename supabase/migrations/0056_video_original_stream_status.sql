-- ─────────────────────────────────────────────────────────────────────────────
-- videos.original_stream_status — cached Bunny encoding status for the ORIGINAL
-- rendition, mirroring proxy_stream_status (0012) for the proxy tier.
--
-- WHY. Whether a clip is playable lived only in the browser that uploaded it, as
-- a `streamProcessing` flag in React state. It was lost on reload and never
-- existed on any other device, so a clip still encoding showed a CLOUD badge —
-- "it's in the cloud" — on every phone, and only turned out to be unplayable when
-- someone tapped it. On 7 Sept five clips sat encoding for over an hour looking
-- identical to the eleven that were ready.
--
-- Caching Bunny's number (4 = finished) lets every device render the truth from
-- one list query, without a per-clip call to Bunny to find out.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.videos
    ADD COLUMN IF NOT EXISTS original_stream_status SMALLINT;

COMMENT ON COLUMN public.videos.original_stream_status IS
    'Cached Bunny Stream encoding status for the original rendition: 2 queued, 3 encoding, 4 finished, 5 failed. Written by /api/videos/[id]/url when it asks Bunny; NULL means never checked.';
