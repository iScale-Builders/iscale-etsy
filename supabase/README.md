# Etsy worker schema

`migrations/20260925120000_etsy_worker.sql` is the queue, results store, and
RPCs for optional worker mode. `migrations/20260925140000_etsy_worker_commands.sql`
adds job type, params, and payload snapshots so a lane can run search,
listing visits, shop pages, export, and collection stats.
`migrations/20260925160000_etsy_worker_auth.sql` revokes those RPCs from
`anon` and `public`, grants them to `authenticated`, and requires an
`etsy_worker.operators` row. Apply all three files yourself, in that order.
This repository does not connect to a database.

Check the shared database first, then apply the three files in one `psql`
invocation. Each migration file is its own transaction.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/preflight-etsy-worker.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/apply-etsy-worker.sql
```

The SQL editor does not accept `\ir`. Paste the three migration files there,
in order. Create Auth users in the dashboard. The operators table is the
access gate, so public signups can stay enabled for the other apps on this
project. Insert one operator row per user, with `lane_name` for a lane:

```sql
insert into etsy_worker.operators (user_id, role, lane_name) values
  ('<lane-user-uuid>', 'lane', 'lane-1'),
  ('<agent-user-uuid>', 'agent', null);
```

Do not put the project URL, the publishable key, or passwords in git. Do not
re-run the first or second migration after `etsy_worker.operators` exists.

After they run:

- `etsy_worker.jobs` is the command queue (`job_type`, params, priority, lease, status).
- `etsy_worker.listings` is the row store, written only by
  `etsy_worker_upload_results`.
- `etsy_worker.payloads` holds export snapshots and full listing extracts,
  written only by `etsy_worker_upload_payload`.
- `etsy_worker.workers` is the lane heartbeat table.
- Public functions `etsy_worker_*` are what the extension and
  `scripts/etsy-worker.mjs` call through PostgREST.

If the `supabase_realtime` publication exists, the migration adds
`etsy_worker.jobs` to it so an idle lane can wake when a term is inserted.
Polling still works when Realtime is off.

The publishable or anon key only identifies the project (`apikey`). Calls
also need `Authorization: Bearer <user access token>` from an operator
sign-in. A publishable key is not a bearer token. Do not use a
`service_role` or `sb_secret_` key with the extension or the CLI.

See [the worker runbook](../docs/worker-runbook.md) for lanes, health, and
stuck jobs.
