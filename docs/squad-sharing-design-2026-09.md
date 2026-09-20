# Sharing between teams — how a squad works when every boat is its own team

The design question: an Olympic squad trains together, but each boat is a
separate team in SSA with its own data, its own coach relationship and its own
privacy. They need to see each other's tracks. How?

**The short answer: a SQUAD that teams join by consent, sharing is scoped to
what a squad is actually for (days trained together), and reciprocity is
enforceable. Reads are squad-wide by default; WRITES stay with the owning team
unless it says otherwise.**

---

## 1. Why this is not the problem the other tools solved

Every comparable tool assumes **one owner**. Njord's sharing is "invite
teammates to the boat so they can access all data" — per user, whole boat, no
scope, no expiry. Kinetix, SailViewer, Vantage and SailSync are all
single-coach: the coach holds everything and shows it in a joint debrief.

That model breaks the moment the boats are peers rather than possessions:

- A 49er crew's data belongs to **that crew**, not to whoever is coaching this
  week. Coaches change; the data should not change hands.
- Two boats in the same national squad are **selection rivals**. They will share
  a training block and absolutely not a season.
- The person who collects the files after sailing is often a coach who works
  with several of the boats but owns none of them.

So the primitive is not "invite a user to my boat". It is **"our two teams
agree to train together, on these terms, for this period"**.

### The one good precedent: Hudl

Not sailing — American high-school sport, where rival schools exchange game
film. Three modes worth stealing from:

| Hudl | what it is | worth taking? |
|---|---|---|
| **Direct exchange** | team admin picks another school, selects up to 5 videos | yes — the handshake and the explicit, finite selection |
| **Focus Exchange Network** | video shared automatically when two schedules match | the idea: sharing keyed on a SHARED EVENT, not on a standing grant |
| **League pool** | contribute to the pool and you get access to what others contributed — *you cannot download a game unless you have uploaded one* | **yes.** Enforced reciprocity is exactly right for rivals |

That last one is the best idea in the space and nobody in sailing has it.

### What SSA already has, and should not reinvent

- **`video_shares`** — a capability token with `expires_at`, `revoked_at`,
  `include_overlay` (*what* is shared, not just whether), `view_count` and
  `last_viewed_at`. Time-bounded, revocable, content-scoped, audited. The
  instincts here are already right; this design reuses them.
- **`invitations`** — a handshake with a role, an optional boat, a validity
  window, `max_uses`, `auto_approve`, expiry and revocation.
- **`subteams`** — grouping *within* a team. Not this problem, and worth saying
  so plainly: a squad is not a subteam.

---

## 2. The shape

```
      squads                    a named training relationship
        │                       "NED 49er squad", "Palma winter block"
        ├── squad_members       one row per TEAM that joined, with its terms
        │     ├─ team_id            who joined
        │     ├─ boat_id            which boat they are contributing
        │     ├─ status             invited | active | left
        │     ├─ shares[]           what they contribute (see §3)
        │     ├─ allow_coach_upload can squad coaches upload FOR this boat?
        │     └─ valid_from / to    the block, not for ever
        └── training_days.squad_id  the day several boats sailed together
```

A team joining a squad is a **negotiated act by that team's manager or coach**,
recorded with its own terms, revocable, and time-bounded. It is not a
permission an admin hands out.

### Why the day, not the boat, is the unit of sharing

The obvious design is "Team A shares boat X with Team B". It is also the wrong
one, for a reason that only shows up in this sport: **the teams are rivals**. A
standing boat-level grant means "you can watch everything I ever do", which no
selection rival will agree to, so the feature goes unused and everyone goes back
to WhatsApp.

What they *will* agree to is "we sailed together on these days, let's compare
those days". That is bounded, obviously fair, and exactly what happened.

So: `training_days` gains a `squad_id`. A session is visible across the squad
**when its training day is a squad day and both teams were active members that
day**. Leave the squad and future days stop being shared; the days you were
there for stay, because they were shared at the time and pretending otherwise
would be a lie about what other people already have.

---

## 3. What "shared" means — per category, not one switch

A track is a fact about where a boat sailed. A debrief recording is a crew
talking about their own mistakes. Treating those the same is the mistake that
makes teams refuse to share anything at all.

| category | default | why |
|---|---|---|
| **track + derived analysis** (positions, speed, TWA, phases) | **on** | this is the thing a squad is for |
| **manoeuvre and speed-test results** | **on** | the comparison itself |
| **photos** | off | usually fine, occasionally not — let them choose |
| **video** | off | crew audio. Share a clip deliberately (`video_shares` already does this well) |
| **debriefs, notes, tags** | **off, and not offerable at first** | a team's own words about its own performance |
| **rig settings / tuning numbers** | off | the crown jewels. Some squads share, most do not |

Per-category, per-member, stored on `squad_members.shares`. The default is the
narrow one; opening up is a decision each team makes for itself.

### Reciprocity

`squads.reciprocal` (default **true**), the Hudl pool rule: **you see a day's
other boats only if you contributed your own track for that day.** It is
self-enforcing, it needs no arbitration, and it answers the objection every
rival raises first — "what stops them taking and never giving?"

---

## 4. Writes: the delicate half

Reads are the easy case. The request — *"each team can both upload and view
other boats' logs, including multiple-boat logfile drops"* — needs one person to
write into several teams' boats. That is a much stronger grant than reading, and
it should not ride in on the back of a read agreement.

Two routes, and the first is already built:

1. **The coach holds a membership in each team.** Memberships are per team and
   already support this; a coach working with three boats has three
   memberships. Nothing new is needed, and the audit trail is honest: the coach
   uploaded, as themselves, to a team that admitted them.
2. **`squad_members.allow_coach_upload`** — a team opts in to letting the
   squad's coaches upload on its behalf. Off by default. This is the convenience
   the multi-file drop wants, and it stays a decision of the team being written
   to.

Either way the file is routed to the **owning** boat and the session belongs to
the owning team. A squad never owns data; it is an agreement about visibility,
not a container. That single rule keeps leaving a squad clean: nothing has to
be untangled or handed back.

`tracker-import` then grows a per-file `--team`, and the coach's own
memberships (or the flag) decide whether each write is allowed. The route it
uses already runs as the user, so RLS is the authority — which is the property
to preserve.

---

## 5. What this looks like on the water

The morning brief: five 49ers and a RIB. Each crew owns its own team; the squad
coach is a member of all five, or three of them, or none.

- **After sailing**, whoever has the files runs one import. Each file is routed
  to its own boat, in its own team. Boats that did not share stay private and
  their file simply is not there.
- **Wind is pooled** across everyone who contributed that day — which is the
  accuracy argument, not a nicety: 3–5° from one boat, ~1° from five.
- **Each crew opens their own session** and sees the squad's other tracks on
  the map, toggleable, exactly as the current multi-boat map already draws
  them. They see tracks and speed; they do not see anyone's debrief.
- **A crew that left the squad in March** still has the January days. Their
  April days were never shared.

---

## 6. Schema sketch

```sql
CREATE TABLE squads (
  id UUID PRIMARY KEY, name TEXT NOT NULL, note TEXT,
  reciprocal BOOLEAN NOT NULL DEFAULT TRUE,     -- the Hudl pool rule
  created_by_user_id UUID, created_at TIMESTAMPTZ
);

CREATE TABLE squad_members (
  id UUID PRIMARY KEY,
  squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  team_id  UUID NOT NULL REFERENCES teams(id)  ON DELETE CASCADE,
  boat_id  UUID NOT NULL REFERENCES boats(id)  ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('invited','active','left')),
  -- what this team contributes. Narrow by default; each team decides.
  shares JSONB NOT NULL DEFAULT '{"track":true,"manoeuvres":true,
    "photos":false,"video":false,"debriefs":false,"rig":false}',
  allow_coach_upload BOOLEAN NOT NULL DEFAULT FALSE,
  valid_from DATE, valid_to DATE,
  invited_by_user_id UUID, decided_by_user_id UUID, decided_at TIMESTAMPTZ,
  UNIQUE (squad_id, team_id, boat_id)
);

ALTER TABLE training_days ADD COLUMN squad_id UUID REFERENCES squads(id);
```

Visibility, as one predicate — a session is readable across a squad when:

```
its training_day.squad_id = S
AND the reader's team is an ACTIVE member of S, within its validity window
AND the owning team is an ACTIVE member of S, within its window, on that date
AND the owning member's shares allow the category being read
AND (NOT S.reciprocal OR the reader's own boat also contributed that day)
```

That is one RLS helper, `has_squad_access(session_id, category)`, alongside the
existing `has_boat_access`. Everything else in the app keeps working unchanged
because it already asks the same question through RLS.

---

## 7. What NOT to build

- **A squad that owns boats or sessions.** It is an agreement about visibility,
  nothing more. The moment a squad owns data, leaving one becomes a migration.
- **One global "share everything" switch.** §3 is the whole point.
- **Silent sharing.** Every member sees who else is in the squad, what each
  contributes, and when the window ends — before joining, not after.
- **Cross-team writes by default.** §4.
- **Pretending revocation is retroactive.** Say plainly that leaving stops
  future days and that what was shared has been seen.

---

## 8. Open questions, worth deciding before building

- **Does a squad need its own coach role**, or is "a user with a membership in
  several member teams" enough? The second needs no new concept and I lean to
  it; the first would let a squad hand over coaching without touching five
  teams' memberships.
- **Who creates a squad?** Any team manager, or only on invitation from one?
  The first is simpler and matches how people actually organise.
- **Is `boat_id` on `squad_members` right**, or should a team contribute
  several boats to one squad? A national squad with two 49ers in one team is
  real. The unique key allows it; the UI should too.
- **Regattas.** A squad day is training. Does the same machinery cover "we all
  sailed the same regatta, pool it"? Probably — a regatta is a day with a
  shared venue and an event tracker — but the tracker's own roster may make
  squad consent redundant there.
- **Does reciprocity count a day where a boat sailed but its file is late?**
  A grace period is kinder than a hard rule, and a hard rule is easier to
  explain. I would start hard and soften it if it bites.

---

## Sources

- [Hudl — exchange video with a Hudl team](https://www.hudl.com/support/v3/review-and-share-video/share-video/exchange-video-with-a-hudl-team) · [League pool (contribute to access)](https://support.hudl.com/s/article/use-a-league-pool-hudl-classic) · [Focus Exchange Network](https://www.hudl.com/products/focus/exchange-network)
- [Njord user guide — overview, incl. Sharing Boat Access](https://app.sailnjord.com/help/analytics/index.html)
- SSA's own precedents: `video_shares` (0053), `invitations`, `subteams` (0031), and `training_days` / `trackers` (0070).
