-- ============================================================================
-- SSA Boat Config — 0036 sail inventory fields + write-access alignment
--
-- The sail inventory is SSA-owned master data (sail tags that scans link to,
-- plus certificates). Add the inventory columns the Boat Config "Sail inventory"
-- sub-tab edits, and align sails' WRITE RLS with the tab's TL3+ gate (admin /
-- team_manager / coach / tl3) — the previous 0035 policy allowed coach/tl1/tl2,
-- which mismatched the UI gate.
--
-- Additive, idempotent. Run after 0035.
-- ============================================================================

ALTER TABLE public.sails
    ADD COLUMN IF NOT EXISTS build_date       DATE,
    ADD COLUMN IF NOT EXISTS certificate_key  TEXT,   -- Bunny storage key
    ADD COLUMN IF NOT EXISTS certificate_name TEXT;   -- original filename

-- Realign sails write policies to the TL3+ leadership set.
DROP POLICY IF EXISTS sails_insert ON public.sails;
DROP POLICY IF EXISTS sails_update ON public.sails;
DROP POLICY IF EXISTS sails_delete ON public.sails;

CREATE POLICY sails_insert ON public.sails FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
CREATE POLICY sails_update ON public.sails FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
CREATE POLICY sails_delete ON public.sails FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
