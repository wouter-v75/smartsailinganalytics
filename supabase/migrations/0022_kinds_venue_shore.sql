-- ============================================================================
-- SSA Campaign Engine — 0022 kinds + venue + shore block
--
--   • backlog_items.kind   — add 'test' and 'training' (keep existing values).
--   • session_blocks.block_type — add 'shore' (dock/shed work).
--   • venue (on-water | dock | shed) on BOTH backlog_items and session_blocks.
--
-- CHECK constraints are dropped + re-added (default inline names from earlier
-- migrations: backlog_items_kind_check, session_blocks_block_type_check).
-- Idempotent. Run after 0021.
-- ============================================================================

-- ── backlog_items.kind: + test, training ─────────────────────────────────────
ALTER TABLE public.backlog_items
    DROP CONSTRAINT IF EXISTS backlog_items_kind_check;
ALTER TABLE public.backlog_items
    ADD CONSTRAINT backlog_items_kind_check
    CHECK (kind IN ('action', 'task', 'test', 'training', 'fmea', 'deliverable', 'milestone'));

-- ── session_blocks.block_type: + shore ───────────────────────────────────────
ALTER TABLE public.session_blocks
    DROP CONSTRAINT IF EXISTS session_blocks_block_type_check;
ALTER TABLE public.session_blocks
    ADD CONSTRAINT session_blocks_block_type_check
    CHECK (block_type IN (
        'technical-testing', 'speed-testing', 'race-training',
        'racing', 'shore', 'other'
    ));

-- ── venue (where the work happens) on items + plan blocks ─────────────────────
ALTER TABLE public.backlog_items  ADD COLUMN IF NOT EXISTS venue TEXT;
ALTER TABLE public.session_blocks ADD COLUMN IF NOT EXISTS venue TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backlog_items_venue_check') THEN
        ALTER TABLE public.backlog_items
            ADD CONSTRAINT backlog_items_venue_check
            CHECK (venue IS NULL OR venue IN ('on-water', 'dock', 'shed'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_blocks_venue_check') THEN
        ALTER TABLE public.session_blocks
            ADD CONSTRAINT session_blocks_venue_check
            CHECK (venue IS NULL OR venue IN ('on-water', 'dock', 'shed'));
    END IF;
END $$;
