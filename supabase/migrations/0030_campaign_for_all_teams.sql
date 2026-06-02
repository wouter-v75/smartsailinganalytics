-- 0030 — Make the campaign engine generic.
--
-- Until now the campaign tab was gated behind teams.features.campaign_engine,
-- seeded ON for NORTHSTAR only (0014). Every team should be able to use it,
-- so we flip the flag on for everyone. Per-team data isolation is already
-- handled by RLS — teams only see their own boats' sessions, backlog, etc.
--
-- The flag stays in the schema for backward compat with existing reads
-- (admin team page still inspects it). It just defaults to true now.
--
-- Idempotent: a team that already has campaign_engine=true ends up the same.

UPDATE public.teams
   SET features = coalesce(features, '{}'::jsonb) || '{"campaign_engine": true}'::jsonb
 WHERE features IS NULL
    OR (features ->> 'campaign_engine') IS DISTINCT FROM 'true';
