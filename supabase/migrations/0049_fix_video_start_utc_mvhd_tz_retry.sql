-- 0049 — Re-base video start_utc for 2026-07-11 (supersedes 0048, which no-opped).
--
-- WHY 0048 DID NOTHING: it only shifted clips sitting BEFORE the log's first row,
-- on the theory that that was the signature of the bug. It isn't. The under-shoot
-- moves a clip 2 h earlier WITHIN the sailing day, not off the front of it — a
-- 14:32 clip stored as 10:32Z still lands inside a 09:10–13:00Z log window, so the
-- WHERE matched zero rows. (It also guarded on `log_data ->> 'startUtc'`, which is
-- NULL whenever log_data is stored as a bare array of rows.) Both ideas are dropped.
--
-- BUG BEING REPAIRED: `_scanMvhd` reads the MP4 `mvhd` atom, which the spec defines
-- as UTC. The upload path treated it as CAMERA-LOCAL and subtracted the venue offset,
-- so a spec-compliant camera's clips were stored one offset (CEST = +2 h) TOO EARLY:
-- a clip shot at 14:32 local (12:32Z) was stored 10:32Z and rendered at 12:32. The
-- log never goes through that path, which is why its times looked right.
-- Parser fix: `resolveStartUtc()` in SmartSailingAnalytics_UI.jsx, which now decides
-- per file whether mvhd is UTC or local instead of assuming.
--
-- SCOPE: every clip on the 2026-07-11 session — they were all imported from the same
-- camera through the buggy path, and all show the same 2 h under-shoot. Migrations are
-- applied exactly once and tracked by Supabase, so this cannot double-shift.
-- NOTE: if any clip on that day came from a LOCAL-clock camera (GoPro/DJI), it was
-- already correct and this would over-shift it by 2 h — fix such a clip in the Videos
-- tab's start-time editor. As of writing, that day's clips are all from the one camera.

DO $$
DECLARE
  n_updated INT;
BEGIN
  UPDATE public.videos v
  SET    start_utc = v.start_utc + INTERVAL '2 hours'
  FROM   public.sessions s
  WHERE  v.session_id = s.id
    AND  s.date = DATE '2026-07-11'
    AND  v.start_utc IS NOT NULL;

  GET DIAGNOSTICS n_updated = ROW_COUNT;
  RAISE NOTICE '0049: re-based % video(s) on 2026-07-11 by +2h', n_updated;

  IF n_updated = 0 THEN
    RAISE NOTICE '0049: no videos matched — is the session dated 2026-07-11, and were the clips synced to the cloud (not still local-only in IndexedDB)?';
  END IF;
END $$;
