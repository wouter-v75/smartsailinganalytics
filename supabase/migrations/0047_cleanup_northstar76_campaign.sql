-- 0047_cleanup_northstar76_campaign.sql
-- ---------------------------------------------------------------------------
-- One-off data cleanup: empty the polluted campaign entries for the boat
-- "Northstar 76" while KEEPING the June "Sorrento Maxi Europeans" regatta.
--
-- Background: a date-range entry bug created ~120 phantom placeholder days
-- (June → October) and a stray 1900-dated row, which junked the timeline.
--
-- Safe + idempotent:
--   • "Sorrento" is matched case-insensitively.
--   • Real days that hold logs / videos / photos / manoeuvre events are KEPT
--     (they only lose the wrong event label + any planned block → plain days).
--   • Only genuinely EMPTY phantom days are deleted.
--   • Scoped to the boat named 'Northstar 76'; a no-op anywhere that boat
--     doesn't exist, and a no-op on re-run once the data is already clean.
-- ---------------------------------------------------------------------------

-- Step 1 — drop planned blocks from every non-Sorrento day.
DELETE FROM public.session_blocks sb
WHERE sb.boat_id IN (SELECT id FROM public.boats WHERE name = 'Northstar 76')
  AND sb.session_id IN (
    SELECT s.id FROM public.sessions s
    WHERE s.boat_id IN (SELECT id FROM public.boats WHERE name = 'Northstar 76')
      AND (s.event IS NULL OR s.event NOT ILIKE '%sorrento%')
  );

-- Step 2 — clear the wrong event/location label from non-Sorrento days.
UPDATE public.sessions s
SET event = NULL, location = NULL
WHERE s.boat_id IN (SELECT id FROM public.boats WHERE name = 'Northstar 76')
  AND (s.event IS NOT NULL OR s.location IS NOT NULL)
  AND (s.event IS NULL OR s.event NOT ILIKE '%sorrento%');

-- Step 3 — delete the empty phantom days (no logs / media / events).
DELETE FROM public.sessions s
WHERE s.boat_id IN (SELECT id FROM public.boats WHERE name = 'Northstar 76')
  AND (s.event IS NULL OR s.event NOT ILIKE '%sorrento%')
  AND NOT EXISTS (SELECT 1 FROM public.videos             v WHERE v.session_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM public.photos             p WHERE p.session_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM public.session_attachments a WHERE a.session_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM public.manoeuvre_events    m WHERE m.session_id = s.id);
