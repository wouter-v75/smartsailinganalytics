-- ============================================================================
-- SSA Campaign Engine — 0021 backlog item tags
--
-- Backlog items gain a free tag array (same shape as videos.tags). The tag
-- vocabulary is the existing per-(team,boat) tag_lists used by the video
-- tagger, so backlog tags and clip tags share one list. Idempotent.
-- ============================================================================

ALTER TABLE public.backlog_items
    ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
