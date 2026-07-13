-- 0050 — Repair sail_scans.captured_at for scans imported without a venue offset.
--
-- THE BUG: `captured_at` must be TRUE UTC = (venue-local wall-clock − venue offset).
-- The API does that, but only when the client sends `tz_offset_min`. BoatConfigTab's
-- importer never sent it, and `Number(form.get('tz_offset_min'))` on a MISSING field
-- is Number(null) === 0 — which is finite. So the route "converted" by subtracting
-- zero and stored the venue-local wall-clock as if it were UTC. Rendering then adds
-- the venue offset on top, so a scan taken at 13:39 CEST displayed as 15:39.
-- (SailScanImport always sent the offset; only the BoatConfigTab path is affected.)
-- Fixed forward in the same commit: the client sends the offset, and the route now
-- distinguishes a missing field from a zero one.
--
-- THE SIGNATURE (why this is safe): a row that was never converted has
--     captured_at == captured_local interpreted as UTC
-- exactly. A row that WAS converted differs from it by the venue offset. So we shift
-- only rows matching that equality — correctly-imported scans are provably untouched.
--
-- IDEMPOTENT: after the shift, captured_at no longer equals the wall-clock-as-UTC, so
-- re-running matches nothing. It cannot double-shift.
--
-- OFFSET: every scan to date was captured in CEST (UTC+2) — confirmed with Wouter — so
-- the correction is a flat −2 h. If scans are ever imported from another venue, this
-- migration must NOT be reused; the forward fix means new imports don't need it.

DO $$
DECLARE
  n_candidates INT;
  n_updated    INT;
BEGIN
  SELECT count(*) INTO n_candidates
  FROM public.sail_scans
  WHERE captured_at IS NOT NULL
    AND conditions ->> 'captured_local' IS NOT NULL;
  RAISE NOTICE '0050: % scan(s) carry a captured_local stamp', n_candidates;

  UPDATE public.sail_scans s
  SET    captured_at = s.captured_at - INTERVAL '2 hours',
         updated_at  = now()
  WHERE  s.captured_at IS NOT NULL
    AND  s.conditions ->> 'captured_local' IS NOT NULL
    -- the tell-tale: stored instant IS the local wall-clock, i.e. never converted
    AND  s.captured_at = (
           (replace(s.conditions ->> 'captured_local', 'T', ' '))::timestamp
           AT TIME ZONE 'UTC'
         );

  GET DIAGNOSTICS n_updated = ROW_COUNT;
  RAISE NOTICE '0050: shifted % scan(s) back by 2h (CEST -> true UTC)', n_updated;
  RAISE NOTICE '0050: % scan(s) were already correct and left alone', n_candidates - n_updated;
END $$;
