-- ============================================================================
-- SSA — rename the 2026 boat "Northstar7X" → "Northstar 76".
--
-- The current boat was created as "Northstar7X" by the rollover migrations
-- (0026/0027). The canonical name is "Northstar 76"; this renames the live
-- `boats` row so every label that reads boat.name (workspace switcher, folders,
-- deck, etc.) shows "Northstar 76", and the UserPill default ("Northstar 76")
-- matches by name. Historical migrations/docs that mention "Northstar7X" are
-- left as-is — they describe the rollover event, not the current name.
--
-- Idempotent. The old "Northstar 72" boat is untouched (retired).
-- ============================================================================

DO $$
BEGIN
    UPDATE public.boats
       SET name = 'Northstar 76'
     WHERE name IN ('Northstar7X', 'Northstar 7X');
    IF FOUND THEN
        RAISE NOTICE '0041: renamed Northstar7X -> Northstar 76';
    ELSE
        RAISE NOTICE '0041: no "Northstar7X" boat found (already renamed?).';
    END IF;
END $$;
