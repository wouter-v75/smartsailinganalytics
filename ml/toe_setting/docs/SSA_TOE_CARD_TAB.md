# SSA read-only "Toe card" tab — design sketch (for later)

Status: **design only, not built.** Build this *after* Block A, once the card is
calibrated enough to trust. Until then the notebook's HTML/PDF export
(`export_card.py`) is the coach/helm deliverable. This sketch shows the cheapest
path that reuses everything v3 already has — auth, tenant isolation, the data —
instead of standing up a separate app.

## Principle
Two audiences, two surfaces:
- **Engineer** → the notebook (modeling, calibration). Unchanged.
- **Coach / helm** → a *read-only* view inside SSA. They never touch `config.py`
  or run Python; they open SSA and see the current card for the boat.

The notebook stays the source of truth. When the engineer is happy with a fit, it
**publishes** the card JSON to SSA; the tab just renders the latest published card.

## Where it lives
A boat-scoped reference view, not a per-day artifact — the card is the campaign's
current best setup, not a property of one session. Two reasonable homes:

- **Recommended:** a new top-level tab **"Setups"** (or "Toe") on the boat,
  alongside Campaign. Shows the current card + a small history dropdown by
  `generated_at`.
- Alternatively a panel inside **Campaign → Day** that reads the latest card so
  the helm sees it next to the day plan. Same data, just a different mount point.

Both scope to the active membership's boat, exactly like Videos/Photos in v3.

## Data flow
```
notebook (engineer)                SSA (Supabase + Next.js)            coach/helm
─────────────────────              ────────────────────────           ──────────
fit_conjugate(...)  ──publish──▶   PUT /api/.../toe-card               GET /api/.../toe-card
                                   → upsert row in toe_cards (JSONB)   → render read-only grid
                                   RLS: coach/tl1/tl2 may write        RLS: has_boat_access may read
```
The card payload is the same structure `export_card._grid()` already produces, so
the React grid is a direct port of the HTML exporter — identical cells, colours,
legend.

## Storage — mirror the `mast_settings` pattern
The card is schema-flexible, so store it as JSONB exactly like `mast_settings`
(see `0003_data_schema.sql`). New migration, idempotent, RLS policies copied from
the `sessions` block:

```sql
-- 0034_toe_cards.sql  (SKETCH)
CREATE TABLE IF NOT EXISTS public.toe_cards (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    calibrated         BOOLEAN NOT NULL DEFAULT false,  -- drives the PROVISIONAL banner
    payload            JSONB   NOT NULL,                -- the grid + meta + legend
    notes              TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS toe_cards_boat_idx
    ON public.toe_cards(team_id, boat_id, generated_at DESC);

ALTER TABLE public.toe_cards ENABLE ROW LEVEL SECURITY;

-- SELECT: anyone with boat access (coach, helm, tl*, consultant-in-window).
CREATE POLICY toe_cards_select ON public.toe_cards FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
-- INSERT/UPDATE: coach/tl1/tl2 only (the engineer publishes under their login).
CREATE POLICY toe_cards_insert ON public.toe_cards FOR INSERT TO authenticated
    WITH CHECK (public.is_admin()
                OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY toe_cards_delete ON public.toe_cards FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.toe_cards TO authenticated;
REVOKE ALL ON public.toe_cards FROM anon;
```
This is a pure additive migration — it doesn't touch v3 tables, so it's safe to
ship independently and roll back by dropping the one table.

## API route — copy the sessions route shape
`src/app/api/teams/[teamId]/boats/[boatId]/toe-card/route.ts` (SKETCH):

```ts
// GET  → latest card for this boat (RLS returns only what membership may see).
// PUT  → publish a new card. Body: { payload, calibrated, notes? }.
export async function GET(_req, { params }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })
  const { data, error } = await supabase
    .from('toe_cards')
    .select('id, generated_at, calibrated, payload, notes')
    .eq('team_id', params.teamId).eq('boat_id', params.boatId)
    .order('generated_at', { ascending: false })
    .limit(1).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ card: data })
}

export async function PUT(req, { params }) { /* upsert, same auth gate as sessions PUT */ }
```
Reuses `getServerSupabase()` and the user's session — never the service-role key —
so RLS does the tenant isolation, identical to the existing session routes.

## Publishing from the notebook
A small `publish_card.py` (companion to `export_sessions.py`, write instead of
read): PUT the fit JSON to `/api/teams/{team}/boats/{boat}/toe-card` under a
logged-in coach/tl token. Keeps the same "data stays under team control" stance —
it only ever talks to the team's own Supabase. Add a button later if wanted; the
script is enough to start.

## Component states
The React grid is a port of the HTML card. It must handle:
- **loading** — skeleton grid.
- **empty** — "No card published yet. The engineer publishes from the notebook."
- **provisional** (`calibrated=false`) — the red PROVISIONAL banner, same wording
  as the export.
- **calibrated** — banner gone; show `generated_at` and history selector.
- per-cell colours/legend identical to `export_card` (confident / low / infeasible
  / prior-only), so screen and print match.

Read-only throughout: no edit affordances, matching the coach/helm role.

## Why not a separate web app
A standalone toe app would re-implement auth, deployment, RLS, and data access —
all of which SSA already provides and the 7X data already sits behind. The marginal
cost of the tab above is one additive migration + one route + one read-only
component. The marginal cost of a separate app is all of SSA's plumbing again, for
no benefit, during the tightest three weeks of the work-up.

## Phasing
1. **Now** → notebook + HTML/PDF export (done). Coach/helm get a card from day 1.
2. **After Block A** (card calibrated) → ship the migration + GET route + read
   view; publish from the notebook.
3. **Optional later** → history/diff view, per-day pin in Campaign → Day, a
   "publish" button in the notebook UI.
```
