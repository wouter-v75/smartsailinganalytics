-- 0048 — Re-base video start_utc for the 2026-07-11 session.
--
-- BUG: `_scanMvhd` reads the MP4 `mvhd` atom, which the spec defines as UTC. The
-- upload path treated that clock as CAMERA-LOCAL and subtracted the venue offset
-- from it, so a spec-compliant camera's clips were stored one full venue offset
-- (CEST = +2 h) TOO EARLY. A clip shot at 14:32 local (12:32 UTC) was stored as
-- 10:32 UTC and therefore rendered at 12:32. The log was never affected — it does
-- not go through this code path.
--
-- The parser is fixed in SmartSailingAnalytics_UI.jsx (`resolveStartUtc`), which
-- now decides per file whether mvhd is UTC or local instead of assuming. This
-- migration repairs the rows already written by the buggy path.
--
-- SCOPE: deliberately narrow — only the 2026-07-11 session, and only clips that
-- are currently EARLIER than that session's log window, which is the signature of
-- the double subtraction. Clips already inside the window (e.g. any uploaded from
-- a local-clock camera, or hand-corrected in the start-time editor) are left alone,
-- so re-running this is safe and it cannot double-shift.

UPDATE public.videos v
SET    start_utc = v.start_utc + INTERVAL '2 hours'
FROM   public.sessions s
WHERE  v.session_id = s.id
  AND  s.date = DATE '2026-07-11'
  AND  v.start_utc IS NOT NULL
  -- The log's first row, in true UTC (log_data.startUtc is epoch ms).
  AND  (s.log_data ->> 'startUtc') IS NOT NULL
  -- Only clips sitting BEFORE the log starts — the tell-tale of the 2 h
  -- under-shoot. 15 min of grace allows a camera that rolled before the log did.
  AND  v.start_utc < to_timestamp((s.log_data ->> 'startUtc')::BIGINT / 1000.0)
                     - INTERVAL '15 minutes';
