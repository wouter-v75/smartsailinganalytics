-- ============================================================================
-- SSA — 0099 boats.specs
--
-- The log profile has been documented as living on `boats.specs.log_profile`
-- since the profile was designed, and /api/boats now selects it. The column was
-- never created: `specs` exists on `sails` (0035), and 0090 says in as many
-- words that "the `boats` table has carried no specs at all until now", adding
-- only `rig_model`.
--
-- The consequence was not a missing log profile. PostgREST refuses the whole
-- SELECT over one unknown column, so /api/boats answered 500, fetchBoats()
-- returned [], and EVERY boat disappeared from SailTrim's picker and the Upload
-- tab — which reads as "my boat is not there" rather than as an outage.
--
-- JSONB with a default of '{}' so every existing row is immediately valid and
-- `specs->'log_profile'` is simply absent until a boat is given one.
-- ============================================================================

ALTER TABLE public.boats
    ADD COLUMN IF NOT EXISTS specs JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.boats.specs IS
    'Per-boat settings that are not rig geometry. Today: log_profile — the '
    'Expedition channel-label aliases for this boat, read by /api/boats and the '
    'Upload tab so a boat with differently labelled channels does not need every '
    'laptop set up by hand. rig_model stays its own column.';
