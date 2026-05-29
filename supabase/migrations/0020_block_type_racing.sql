-- ============================================================================
-- SSA Campaign Engine — 0020 add 'racing' block type
--
-- Widens session_blocks.block_type to include 'racing' (distinct from the
-- practice-oriented 'race-training'). Drop + re-add the column CHECK; the
-- inline constraint from 0018 carries Postgres's default name
-- session_blocks_block_type_check. Idempotent.
-- ============================================================================

ALTER TABLE public.session_blocks
    DROP CONSTRAINT IF EXISTS session_blocks_block_type_check;

ALTER TABLE public.session_blocks
    ADD CONSTRAINT session_blocks_block_type_check
    CHECK (block_type IN (
        'technical-testing',
        'speed-testing',
        'race-training',
        'racing',
        'other'
    ));
