-- 0052 — Rotate clips inside SSA, without re-encoding them.
--
-- WHY: the coach's chain was iPhone → Mac → AirDrop → *rotate in QuickTime Player* →
-- upload. That rotate is the problem: QuickTime TRANSCODES on save, which strips the
-- capture metadata — including Apple's Keys:CreationDate, the only authoritative record
-- of when the clip was shot. The uploaded file then carries the EDIT time, and the
-- instrument overlay drifts against the footage.
--
-- Rotation is a PRESENTATION property, not a reason to rewrite pixels. Store the angle
-- here and let every client apply it on playback: the original file is never re-encoded,
-- so its timestamp survives, and step (iv) disappears from the workflow.
--
-- 0 | 90 | 180 | 270, clockwise. Default 0 = as recorded.

ALTER TABLE public.videos
    ADD COLUMN IF NOT EXISTS rotation_deg SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE public.videos
    DROP CONSTRAINT IF EXISTS videos_rotation_deg_check;
ALTER TABLE public.videos
    ADD CONSTRAINT videos_rotation_deg_check
    CHECK (rotation_deg IN (0, 90, 180, 270));

COMMENT ON COLUMN public.videos.rotation_deg IS
    'Clockwise display rotation in degrees (0/90/180/270). Applied at playback; the source file is never re-encoded, so its capture metadata is preserved.';
