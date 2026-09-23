-- ============================================================================
-- SSA — 0088  ai_query_log: drop the columns the removed AI-query feature left
--
-- 0087 adopted the table 0055 had left on the remote, and kept its column names
-- on the argument that one log should serve every AI surface. That argument was
-- wrong: there is no second surface. The AI-query part of the app was removed in
-- the clean-up the week before, and the table is what it left behind — the code
-- went, the table stayed, empty.
--
-- So four columns are here for a reader that does not exist:
--   route            only ever 'ask' now
--   context_summary  the old route's lean record of what the model saw; the Ask
--                    box stores `steps` instead — the RESOLVED ARGUMENTS, which
--                    is the thing that tells a bad tool call from a bad sentence
--   input_tokens     never written; Scaleway's usage block is not read
--   output_tokens    likewise
--
-- What stays, and why it keeps 0055's names rather than being renamed to mine:
-- `rating` / `correction` / `rated_by` / `rated_at` and `latency_ms` are good
-- names on their own merits, they are already live in 0087's route code, and
-- renaming a column to say the same thing differently is churn, not tidying.
--
-- Safe: the table is empty (verified 2026-09-23 before 0087 and again after).
-- Idempotent. Run after 0087.
-- ============================================================================

ALTER TABLE public.ai_query_log
    DROP COLUMN IF EXISTS route,
    DROP COLUMN IF EXISTS context_summary,
    DROP COLUMN IF EXISTS input_tokens,
    DROP COLUMN IF EXISTS output_tokens;
