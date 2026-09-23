-- access_requests — the "Request access" form on the public marketing site.
--
-- SSA has no free tier and no self-serve signup (see
-- docs/commercialisation-plan-2026-27.md §2): every account starts as a
-- conversation. This table is where that conversation starts, and it doubles as
-- the pipeline number the plan wants counted for investors — requests per month,
-- and how many of them name a referrer, which is the only direct measure of
-- whether word of mouth is working.
--
-- Written by an ANONYMOUS visitor through /api/access-request, which uses the
-- service role. There is deliberately no client-facing INSERT policy: the route
-- rate-limits, validates and normalises first. RLS is on with no policies at
-- all, so anon and authenticated alike read nothing and write nothing directly;
-- only the service role (which bypasses RLS) touches it.

CREATE TABLE IF NOT EXISTS public.access_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Veo's move: ask what they want before asking who they are. It qualifies
    -- the lead before a human reads it, and it routes the reply.
    intent       TEXT NOT NULL
                 CHECK (intent IN ('programme', 'squad', 'coach', 'partner', 'other')),

    name         TEXT NOT NULL,
    email        TEXT NOT NULL,
    organisation TEXT,                 -- team, programme, federation or club
    boat_class   TEXT,                 -- 'Northstar 76', 'ILCA 7', '49er' …
    country      TEXT,

    -- Free text: what they sail, what they are trying to solve.
    message      TEXT,

    -- WHO SENT THEM. The whole distribution strategy is word of mouth, so this
    -- is the single most valuable column in the table.
    referrer     TEXT,

    -- Where the form was submitted from, for the rare case of a second entry
    -- point later. Not a tracking parameter; no analytics cookie exists.
    source_path  TEXT,

    status       TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'contacted', 'qualified', 'won', 'declined')),
    notes        TEXT,                 -- your own notes after the conversation

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_requests_created_idx ON public.access_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS access_requests_status_idx  ON public.access_requests (status, created_at DESC);

-- Someone submitting twice in a day (a double-click, a second thought) should
-- not become two rows to chase. Same email, same day, one row.
--
-- The day has to be pinned to a fixed zone: `created_at::date` depends on the
-- session's TimeZone, which makes it STABLE rather than IMMUTABLE, and Postgres
-- refuses it in an index expression ("functions in index expression must be
-- marked IMMUTABLE"). `AT TIME ZONE 'UTC'` with a literal zone is immutable, so
-- "same day" means the same UTC day. For a form that collapses duplicate
-- submissions that is the right reading anyway — it does not depend on where
-- the sender happened to be.
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_email_day_idx
    ON public.access_requests (lower(email), ((created_at AT TIME ZONE 'UTC')::date));

ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;

-- No policies on purpose — see the header. Service role only.

DROP TRIGGER IF EXISTS access_requests_touch ON public.access_requests;
CREATE TRIGGER access_requests_touch BEFORE UPDATE ON public.access_requests
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.access_requests IS
    'Public "Request access" submissions. Written by /api/access-request via the service role; RLS on with no policies.';
COMMENT ON COLUMN public.access_requests.referrer IS
    'Who sent them. Word of mouth is the distribution strategy, so this is the column that says whether it works.';
