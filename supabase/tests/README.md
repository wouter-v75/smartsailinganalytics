# Schema tests

SQL tests that assert on the *behaviour* of a migration, not just that it applies.
They exist because some of what the schema guarantees cannot be checked by reading
it — a partial index silently refusing to arbitrate `ON CONFLICT`, say, or a CHECK
constraint firing on a half-finished update.

They are not wired into `npm test`, which is vitest and has no database. Run them
against a throwaway PostgreSQL:

```sh
# one-time: a scratch cluster
initdb -D /tmp/ssapg -A trust -U postgres
pg_ctl -D /tmp/ssapg -o "-p 55432 -k /var/run/postgresql" start

createdb -h /var/run/postgresql -p 55432 -U postgres ssa
psql -h /var/run/postgresql -p 55432 -U postgres -d ssa -f supabase/tests/_stubs.sql
for f in supabase/migrations/*.sql; do
  psql -h /var/run/postgresql -p 55432 -U postgres -d ssa -q -v ON_ERROR_STOP=1 -f "$f" || break
done
psql -h /var/run/postgresql -p 55432 -U postgres -d ssa -f supabase/tests/0062_tagger_merge.sql
```

Against a real Supabase project, skip `_stubs.sql` — it only fills in the `auth`
schema and roles the platform provides.

Every test rolls back, so nothing is left behind.
