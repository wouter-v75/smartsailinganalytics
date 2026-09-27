-- ============================================================================
-- SSA — 0091 which boats are OURS
--
-- SailTrim measures rivals from the coach boat, and a rival's rig model comes
-- off its public IRC certificate, so 0090's boats.rig_model was enough to make
-- one measurable. It is not enough to measure one CORRECTLY.
--
-- THE HEEL. Every instrument reading SSA holds is from our own boat: the log's
-- heel at 12:25 is Northstar's heel, not Capricorno's. Feeding it to a
-- measurement of Capricorno's rig is simply a different boat's number, and it
-- is wrong by however much the two differ — which upwind in a breeze is plenty,
-- and is exactly the condition where the measurement matters. A rival's heel
-- can only come from the photograph: the mast against the sea horizon, which
-- the detector already reads to about 1.5 deg.
--
-- Nothing in the schema could say which boats are ours, because the rivals were
-- filed under the team that photographs them — they have to be somewhere a
-- coach can see, and a team is the only scope there is. So the flag is explicit
-- rather than inferred from the team.
--
-- Additive and idempotent. Existing rows default to false, which is right: the
-- boats already in the table when this runs are the customers' own.
-- ============================================================================

ALTER TABLE public.boats
    ADD COLUMN IF NOT EXISTS is_competitor BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.boats.is_competitor IS
    'True for a rival measured from the coach boat. Its rig model comes off a '
    'public IRC certificate, and NONE of our instrument data describes it — '
    'heel above all must come from the horizon in the photograph, never the log.';

-- Reads and writes ride on the existing boats policies: a competitor is a boat
-- row like any other, visible to the team that photographs it and editable by
-- that team's coach. No new policy, deliberately — a second idea about who may
-- see a boat is how a gate ends up open on one route and shut on another.
