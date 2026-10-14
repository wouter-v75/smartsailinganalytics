-- ============================================================================
-- SSA — 0100 sail_scans.source accepts 'sailvision'
--
-- Baraka's analyst exports a third report format, "Sail Vision analysis report"
-- — one A4 page per scan, nothing in common with North's layout or
-- thesailcloud's. 0035 wrote the source CHECK as
-- ('north','thesailcloud','ssa','manual','other'), so a Sail Vision scan can
-- only go in as 'other'.
--
-- 'other' would work and would be wrong in the way that costs an afternoon
-- later: `source` is the column that answers "where did this measurement come
-- from", and three vendors sharing one bucket means a future question about
-- Sail Vision's draft numbers has to be answered by reading JSONB. The format
-- is already recorded in conditions.report_format; this makes it queryable.
--
-- Drop-and-recreate because Postgres has no ALTER ... ALTER CONSTRAINT for a
-- CHECK. The name is the one 0035 generated.
-- ============================================================================

ALTER TABLE public.sail_scans
    DROP CONSTRAINT IF EXISTS sail_scans_source_check;

ALTER TABLE public.sail_scans
    ADD CONSTRAINT sail_scans_source_check
    CHECK (source IS NULL OR source IN
        ('north','thesailcloud','sailvision','ssa','manual','other'));

COMMENT ON COLUMN public.sail_scans.source IS
    'Which analyser produced the scan: north | thesailcloud | sailvision | ssa '
    '| manual | other. conditions.report_format carries the exact layout within '
    'a vendor (north-app vs north-sailscan).';
