# Northstar 72 — structured data for a Mistral text→code analysis tool

**Status:** design proposal for review (2026-06-25). No code yet.
**Goal:** back-fill SSA from a folder of SailScan reports + log files + event files, into a clean structured store that a Mistral-linked tool can query by translating a natural-language question into code/numerical analysis, with an immutable copy on Scaleway Object Storage for GPU-side runs.

---

## 0. TL;DR recommendation

1. **You do not need a new data model.** The campaign spine already is your 0–4: `sessions → runs (phases) → configs (rig) + datasets (phase summaries) + manoeuvre_events + sail_scans + sails/polars`. Re-use it; don't build a parallel "phases/events" schema.
2. **For text→code, the highest-leverage work is data quality + a machine-readable data dictionary**, not fine-tuning. Mistral writes pandas/DuckDB/SQL against a tidy dataset; a sandbox runs it. Fine-tuning is optional and later (to teach it your house query idioms).
3. **Keep two grains, not just phase averages.** Store/export the raw per-second `samples` time series *and* the per-phase rollups. Pre-aggregating only to phase means the model can never answer a finer question. Aggregates are a convenience view over samples, not a replacement.
4. **Add a thin export/feature layer**: versioned, immutable **Parquet** snapshots on Scaleway Object Storage (S3-compatible) + a `data_dictionary.md`/`.json`. This is the artifact the GPU job and the Mistral runner read — never the live Postgres.
5. **Three small gaps to fill**: (a) event kinds for *start / mark rounding / sail up-down* (the existing `manoeuvre_events` only covers tack/gybe/roundup/bearaway); (b) a derived **performance** field per sample (%-of-target, VMG) from the polars; (c) the folder→DB ingestion + DB→Scaleway export jobs.

---

## 1. The reframe: what "Mistral translates text → code" implies

The model's job is **NL question → executable analysis**, e.g.:

> "How much more headstay tension did we carry in >14 kn vs <10 kn upwind, and did J1.5 draft move forward?"
> → generated DuckDB/pandas over `phases`, `configs`, `scan_stripes` → numbers + a short narrative.

Consequences for the data:

- **Tidy/long tables with a stable grain** beat clever nested JSON. One row = one observation; columns are typed and documented. DuckDB/pandas can then group/join freely.
- **A data dictionary is part of the system prompt.** The model can only write correct code if it's told the exact table names, columns, units, enums and join keys. This dictionary is a first-class deliverable, generated from the schema so it never drifts.
- **A handful of golden Q→code examples** (few-shot) do most of the accuracy work. If you later want to fine-tune, *these examples are the training set* — so the JSONL idea from before re-enters here, but as an optimisation, not the foundation.
- **Determinism + safety:** the model emits code; an isolated runner (read-only DuckDB over the Parquet snapshot, no network) executes it. This is RAG-of-a-sort, but over *computation* rather than text passages — which is exactly right for numerical sailing data.

This satisfies all three chosen goals (Q&A, debrief generation, trim/setup recommendation) with one store: debrief and trim-recommendation are just canned questions with richer prompts.

---

## 2. What already exists (map to your 0–4)

| Your item | Existing table | Notes |
|---|---|---|
| 0) "expand DB" | — | Mostly unnecessary; spine exists. |
| day | `sessions` | `log_data` (parsed CSV), `xml_data` (tacks/jibes + meta), `tz_offset_minutes`, `conditions` |
| 1) phases w/ averages | `runs` + `datasets` | `runs.mode ∈ {upwind,reach,downwind,start,manoeuvre,transit}`, `start_utc/end_utc`; `datasets` holds computed `metrics`/`payload` per run/window (`kind = run-summary | polar-observed | mode-map | flying-shape | vpp-correlation`) |
| 2) events | `manoeuvre_events` | `kind ∈ {tack,gybe,roundup,bearaway}`, `utc`, `vmg_loss`, `time_lost_s`, `entry_tws/twa` — **no start / mark / sail-change yet** |
| 3) sailscan | `sail_scans` | `captured_at` (UTC), `sail_id`, `run_id`, `session_id`, `stripes`, `summary`, `conditions.sail_type` |
| 4) other metadata | `configs`, `sails`, `polars`, `boats` | `configs` = per-run rig (`rake_mm`, `forestay_mm`, `settings` JSONB); `polars` = targets; `sails` = inventory |

So your decomposition is correct — it's already the schema. The work is **populating it for Northstar 72** and **exporting it for the GPU**, plus three small additions.

---

## 3. Architecture: three layers

```
 ┌─────────────────────────────────────────────────────────────┐
 │ A. RAW (as captured)                                         │
 │    folder: /sailscan-backfill/N72/<event>/<date>/            │
 │      ├─ *.pdf   SailScan reports (North + thesailcloud)      │
 │      ├─ log_*.csv   Expedition logs                          │
 │      └─ event_*.xml  marks / starts / sail changes           │
 │    + the original files archived to Scaleway (immutable)     │
 └───────────────┬─────────────────────────────────────────────┘
                 │ ingestion job (parse + resolve + upsert)
 ┌───────────────▼─────────────────────────────────────────────┐
 │ B. MODELED (Postgres / Supabase — the spine, operational)    │
 │    sessions · runs · configs · datasets · manoeuvre_events   │
 │    · timeline_markers(new) · sail_scans · sails · polars     │
 │    stable IDs, UTC everywhere, RLS — the app already uses it  │
 └───────────────┬─────────────────────────────────────────────┘
                 │ export job (snapshot → tidy, denormalised)
 ┌───────────────▼─────────────────────────────────────────────┐
 │ C. EXPORT / FEATURE STORE (Scaleway Object Storage, S3)      │
 │    s3://ssa-training/v1/<snapshot-date>/                     │
 │      samples.parquet        (1 Hz long time series + perf)   │
 │      phases.parquet         (run rollups: mean/p50/p90 …)    │
 │      events.parquet         (markers + manoeuvres, unified)  │
 │      scans.parquet          (one row / scan)                 │
 │      scan_stripes.parquet   (one row / scan × stripe)        │
 │      configs.parquet · sails.parquet · sessions.parquet      │
 │      polars.parquet                                          │
 │      data_dictionary.json / .md   ← Mistral system context   │
 │      manifest.json (row counts, hashes, version)            │
 └─────────────────────────────────────────────────────────────┘
```

- **B is the source of truth** the app reads/writes.
- **C is read-only, versioned, reproducible** — what the GPU job and Mistral runner consume. Querying Parquet with DuckDB needs no DB server; it runs anywhere (their GPU box, a laptop, a CI job).
- Re-export is cheap and idempotent; each snapshot is a frozen training/eval set you can cite by version.

---

## 4. Gaps to add (small)

### 4a. Event kinds for start / mark / sail-change
`manoeuvre_events` is perf-shaped (vmg_loss, recovery_s) and enum-locked to tack/gybe/roundup/bearaway. Rather than overload it, add a lightweight **`timeline_markers`** table for discrete, non-manoeuvre moments:

```sql
CREATE TABLE public.timeline_markers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id     UUID REFERENCES runs(id) ON DELETE SET NULL,
  team_id    UUID NOT NULL REFERENCES teams(id),  -- denorm RLS
  boat_id    UUID NOT NULL REFERENCES boats(id),  -- denorm RLS
  utc        TIMESTAMPTZ NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN
              ('race_start','mark_rounding','sail_up','sail_down','line_up','sequence','finish','note')),
  sail_id    UUID REFERENCES sails(id),  -- for sail_up/down
  payload    JSONB NOT NULL DEFAULT '{}', -- mark name, leg #, side, etc.
  source     TEXT NOT NULL DEFAULT 'event-file' CHECK (source IN ('event-file','log-auto','manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

At export, `events.parquet` is the **union** of `manoeuvre_events` + `timeline_markers` (common columns: utc, kind, run_id, payload). The `sail_up/sail_down` markers are exactly what tags each `sail_scan` to the sail that was hoisted at its `captured_at` — the join you flagged earlier.

### 4b. Derived performance per sample
The moat is conditions↔outcome. Add a compute step (export-time, from `polars`) that gives each sample a target and a delta:

`bsp_target`, `vmg`, `vmg_target`, `pct_target_bsp`, `pct_target_vmg`, `point_of_sail`. Stored only in `samples.parquet` (derived, not in Postgres). This lets the model answer "were we fast?" not just "what were the settings?".

### 4c. The two jobs (section 6).

---

## 5. Scaleway specifics

- **Object Storage, S3-compatible.** Use the AWS SDK / `boto3` with the Scaleway endpoint (`s3.fr-par.scw.cloud` or your region) and an API key stored as an env secret. One private bucket, e.g. `ssa-training`.
- **Layout:** `s3://ssa-training/v{N}/{snapshot-YYYY-MM-DD}/…parquet` + `manifest.json`. Keep raw originals under `…/raw/` for provenance.
- **Query path:** DuckDB reads Parquet directly from S3 (`INSTALL httpfs; SET s3_endpoint=…; SELECT … FROM 's3://…/phases.parquet'`). The GPU box pulls the snapshot once (a few hundred MB at most for one boat's history) and queries locally — fast and offline-friendly.
- **Format:** Parquet (columnar, typed, compresses well, native to pandas/DuckDB/Polars). JSONL only for the optional fine-tune example set.
- **Versioning:** immutable snapshots; never overwrite. `manifest.json` carries row counts + a content hash per file so a training run can pin an exact dataset.

---

## 6. The pipeline (folder → DB → Scaleway)

**Folder convention** (you create on the MacBook):
```
sailscan-backfill/
  N72/
    2024-LVSR/
      2024-09-04/
        log_2024-09-04.csv
        event_2024-09-04.xml
        IMN-2024-…main.pdf
        J1.5-2024-…jib.pdf
      2024-09-05/ …
```
Date folder = one `session`. Everything inside is that day.

**Job 1 — ingest (folder → Postgres), idempotent, keyed by (boat, date):**
1. Parse `log_*.csv` → session.log_data (reuse `parseCsvLog`); set `tz_offset_minutes`.
2. Parse `event_*.xml` → `manoeuvre_events` (tacks/gybes) + `timeline_markers` (starts, marks, sail up/down). Sail-change markers resolve `sail_id` from the inventory by the event's sail tag.
3. Derive **runs (phases)**: from marks where a race exists (start→mark→…→finish = legs), else auto-segment by point-of-sail + manoeuvre density. Set `mode`, `start_utc`, `end_utc`.
4. Parse SailScan PDFs with the **existing `parseSailScanReport`** → `sail_scans`; set `captured_at` (UTC), `sail_type`; link `run_id` = phase covering `captured_at`; link `sail_id` = sail active per the `sail_up` timeline.
5. Compute **datasets** (per-run summaries) — mean/p50/p90 of tws/twa/bsp/heel/%target, manoeuvre counts/losses.
6. Capture **configs** (rig) per run — from the report name tags (e.g. `…11.2TForestay_UppDefl95%…`) and/or a per-day setup sheet.

**Job 2 — export (Postgres → Scaleway), idempotent:**
- Resample `log_data` → `samples.parquet` (1 Hz, derived perf columns).
- Flatten spine → `phases/events/scans/scan_stripes/configs/sails/sessions/polars.parquet`.
- Generate `data_dictionary.{json,md}` from the column registry.
- Write `manifest.json`; upload the versioned snapshot.

Both jobs are scripts (Node for parsing reuse, or Python for Parquet/boto3 — likely Python for the export). Run on demand during back-fill; later, Job 2 can be scheduled after new sessions land.

---

## 7. What Mistral gets at query time

1. **System context:** `data_dictionary.md` (tables, columns, units, enums, join keys) + 5–10 **golden Q→code examples**.
2. **User question** in natural language.
3. Model emits **DuckDB SQL or pandas** targeting the Parquet snapshot.
4. **Sandboxed runner** executes read-only (no network, row/time limits), returns the result table.
5. Model writes the short narrative answer / debrief from the returned numbers.

Trim-recommendation and debrief are the same loop with a fuller prompt ("given these conditions, find the closest historical phases and summarise the trim that performed best").

---

## 8. Suggested build order (incremental, each shippable)

1. **Schema delta:** `timeline_markers` migration (+ extend export views). Small.
2. **Ingestion Job 1** for one event folder end-to-end; eyeball the spine in the app.
3. **Derived perf + `datasets`** rollups.
4. **Export Job 2** → first `v1` snapshot on Scaleway + `data_dictionary`.
5. **Golden Q→code set** (10 questions) + a tiny DuckDB runner to validate them.
6. Back-fill the rest of the N72 history; (optional) schedule re-export.
7. (Optional, later) fine-tune Mistral on the golden set if prompt-only accuracy is short.

---

## 9. Open decisions for you

- **Event file format:** what does `event_*.xml` actually contain for starts/marks/sail-changes? Sample one so the parser targets the real shape. (We already read tacks/jibes from `xml_data`.)
- **Rig settings source:** parse from the SailScan filename tags (rich but messy: `UppDefl95%_LowDefl55%_Cunn1.8…`) vs a per-day setup sheet vs both?
- **Sample rate** for `samples.parquet`: 1 Hz vs 0.1 Hz — trade size vs resolution.
- **Markers table vs widening `manoeuvre_events`:** I recommend the separate `timeline_markers` (cleaner enums, no perf columns), but widening the existing enum is viable if you'd rather not add a table.
- **Scaleway region/bucket** + where the API key lives (env on the box that runs Job 2).

---

### Why this beats a from-scratch 0–4 build
Your 0–4 is the right decomposition — it just already exists as the spine, so re-implementing it would fork the model. The actual leverage is (i) back-filling that spine, (ii) keeping raw samples *and* phase rollups, and (iii) the documented, versioned Parquet export + data dictionary that makes a text→code model reliable. That export is the one genuinely new piece, and it's small.
