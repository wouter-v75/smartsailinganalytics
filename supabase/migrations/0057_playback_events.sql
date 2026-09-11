-- ─────────────────────────────────────────────────────────────────────────────
-- playback_events — one playback-quality (QoE) summary per clip viewed.
--
-- WHY. "Videos are often not available on the phone" was an anecdote with no
-- numbers behind it: nobody could say how often, on which phones, or whether a
-- fix helped. Each row is what the player measured for one clip, the way Mux
-- Data defines it — time to first frame, rebuffering, and whether it played,
-- failed or was abandoned before the first frame (src/lib/qoe.ts).
--
-- Written by /api/qoe with the service role; read by admins through the service
-- role (scripts/qoe-report.mjs). RLS is on with NO policies, so browsers can
-- neither read nor write it directly. Stored in the EU project like the rest.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.playback_events (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id         UUID,                 -- who watched (no FK: telemetry must never fail an insert)
    video_id        TEXT NOT NULL,        -- cloud row id, or the local id for a clip not yet uploaded
    stream_guid     TEXT,
    served          TEXT,                 -- original | proxy | legacy
    outcome         TEXT NOT NULL CHECK (outcome IN ('played', 'failed', 'exited_before_start')),
    ttff_ms         INTEGER,              -- tap → first frame
    watch_ms        INTEGER NOT NULL DEFAULT 0,
    rebuffer_count  INTEGER NOT NULL DEFAULT 0,
    rebuffer_ms     INTEGER NOT NULL DEFAULT 0,
    engine          TEXT,                 -- native | hlsjs | mp4 | local
    start_light     BOOLEAN NOT NULL DEFAULT false,  -- iPhone start-light playlist used
    first_height    INTEGER,
    max_height      INTEGER,
    platform        TEXT,                 -- iphone | ipad | android | desktop
    net             TEXT,                 -- navigator.connection.effectiveType (Android only)
    error           TEXT,
    autoplay        BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS playback_events_created_at_idx ON public.playback_events (created_at DESC);
CREATE INDEX IF NOT EXISTS playback_events_video_idx      ON public.playback_events (video_id);

ALTER TABLE public.playback_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.playback_events IS
    'Playback QoE per clip viewed (TTFF, rebuffering, outcome). Written by /api/qoe (service role); no client policies.';
