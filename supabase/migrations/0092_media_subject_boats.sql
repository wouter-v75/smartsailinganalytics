-- ============================================================================
-- SSA — 0092 which boats are IN the photograph
--
-- `photos.boat_id` and `videos.boat_id` already exist and mean something else:
-- whose SESSION this belongs to — the folder it lives in. Every one of the 354
-- stored photos carries our own boat there, including the frames that are
-- pictures of Capricorno, because the field answers "whose day is this" and not
-- "who is in the frame".
--
-- Those are different questions and the second is the one worth searching on. A
-- line-up is the whole point of a stern shot: "every frame of Bella Mente",
-- "Capricorno in 6 knots", "our jib against theirs". None of that is reachable
-- from a folder.
--
-- AN ARRAY, because a line-up holds more than one boat and the interesting
-- frames hold two. IDS, not names: a name is what somebody typed, it can be
-- misspelt, and renaming a boat would orphan every photo of it — the link has
-- to survive that. It also makes the competitor flag reachable in one join, so
-- "show me the rivals" needs no second idea about what a rival is.
--
-- NOT a foreign key: Postgres cannot declare one on an array element, so the
-- referential integrity is by convention and by the backfill script. The GIN
-- indexes are what make the search cheap.
--
-- Additive and idempotent. Empty everywhere until something fills it, which is
-- correct: we do not know who is in a frame nobody has identified.
-- ============================================================================

ALTER TABLE public.photos
    ADD COLUMN IF NOT EXISTS subject_boat_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE public.videos
    ADD COLUMN IF NOT EXISTS subject_boat_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.photos.subject_boat_ids IS
    'Boats visible IN this frame, by id — NOT boat_id, which is whose session '
    'it belongs to. A line-up carries more than one. Ids rather than names so a '
    'rename cannot orphan the link and the competitor flag is one join away.';
COMMENT ON COLUMN public.videos.subject_boat_ids IS
    'Boats visible in this video, by id. See photos.subject_boat_ids.';

-- Containment queries: `WHERE subject_boat_ids @> ARRAY[<id>]::uuid[]`.
CREATE INDEX IF NOT EXISTS photos_subject_boats_idx ON public.photos USING GIN (subject_boat_ids);
CREATE INDEX IF NOT EXISTS videos_subject_boats_idx ON public.videos USING GIN (subject_boat_ids);

-- Reads and writes ride on the existing photos/videos policies. A subject boat
-- is a property of the frame, not a new thing to be granted separately — and a
-- second idea about who may see a photo is how a gate ends up open on one route
-- and shut on another.
