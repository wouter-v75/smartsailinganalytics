-- 0033 — Allow session_attachments.kind = 'regatta'.
--
-- The Regattas sub-tab stores NOR / SI / course notice PDFs alongside the
-- existing weather + debrief attachment kinds. Same table, separate kind so
-- the route can list them independently.
--
-- Idempotent.

ALTER TABLE public.session_attachments
    DROP CONSTRAINT IF EXISTS session_attachments_kind_check;
ALTER TABLE public.session_attachments
    ADD CONSTRAINT session_attachments_kind_check
    CHECK (kind IN ('weather', 'debrief', 'regatta', 'other'));
