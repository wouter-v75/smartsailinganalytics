-- 0102 — when a venue's observation network runs DENSE.
--
-- WHY THIS EXISTS. The dense network is worth having while a regatta is on and
-- close to worthless the rest of the year. Saint-Tropez graded out to 50 nm is
-- about sixty Davis stations; twelve venues like that, every half hour, for
-- ever, is tens of thousands of requests a day off other people's public
-- endpoints to answer questions nobody is asking in February.
--
-- So the poller reads this table. A venue with a window covering "now" is
-- polled to its full graded radius; every other venue is polled to its inner
-- circle only. src/lib/obsActivation.ts has the rule.
--
-- WHY A WINDOW AND NOT A BOOLEAN. A regatta's dates are known weeks ahead, so
-- they get set once and the density turns itself on AND OFF. A flag has to be
-- remembered twice and the second time is the one that gets forgotten, which
-- leaves the dense set running all winter — the exact thing this is for.
--
-- Times are TIMESTAMPTZ, so an entry is unambiguous whatever zone it was typed
-- in. That matters more here than it looks: every other clock in this project
-- is venue-local even when it is called UTC.
--
--   insert into obs_venue_activation (venue_key, starts_at, ends_at, reason)
--   values ('st-tropez', '2027-09-25 00:00+02', '2027-10-04 23:59+02',
--           'Les Voiles de Saint-Tropez');
--
-- venue_key is the `key` in VENUES (src/lib/obsSources.ts), NOT the display
-- name: 'st-tropez', 'solent', 'porto-cervo'. It is deliberately not a foreign
-- key — the venue list lives in code, where the positions and the graded
-- options are — so a typo here is caught by the poller instead, which reports
-- `unknownDomains` in its response. Checking that is worth doing after adding
-- a row, because a mistyped key means the regatta is simply not covered and
-- nothing else complains.
--
-- "When I say so" does not need a row at all: ?domains=st-tropez on the poll
-- URL forces a venue dense for that run, and the NWP box can emit it straight
-- from its own NESTS config so the observations follow the model.
--
-- Additive and idempotent. Run after 0101.

create table if not exists public.obs_venue_activation (
    id          uuid        primary key default gen_random_uuid(),
    venue_key   text        not null,
    starts_at   timestamptz not null,
    ends_at     timestamptz not null,
    reason      text,
    created_at  timestamptz not null default now(),
    created_by  uuid        references auth.users (id) on delete set null,
    -- A window that ends before it starts would never match, which is a silent
    -- way to lose a regatta's coverage. Refuse it at the door.
    constraint obs_venue_activation_order check (ends_at > starts_at)
);

-- The poller's only query: rows covering now, by key.
create index if not exists obs_venue_activation_window_idx
    on public.obs_venue_activation (venue_key, starts_at, ends_at);

alter table public.obs_venue_activation enable row level security;

-- Readable by any signed-in user: this says where the app is watching the
-- weather, which is not anybody's competitive information. Writes are the
-- service key only, like wind_observations — the poller and a migration.
drop policy if exists obs_venue_activation_read on public.obs_venue_activation;
create policy obs_venue_activation_read
    on public.obs_venue_activation for select
    to authenticated
    using (true);

comment on table public.obs_venue_activation is
    'Windows during which a venue''s observation network is polled densely. venue_key matches VENUES[].key in src/lib/obsSources.ts.';
