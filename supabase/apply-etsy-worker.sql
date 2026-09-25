-- Apply the three Etsy worker migrations in order, and stop on the first error.
-- Each migration file is its own transaction (begin/commit inside the file), so
-- a failure rolls that file back. This script does not open another transaction
-- around them: the first file's commit would commit an outer transaction too.
-- When the operator wrappers are already installed, the script does nothing.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/apply-etsy-worker.sql
--
-- The Supabase SQL editor does not accept psql \ir. Paste the three migration
-- files there, in order, instead of pasting this file.

\set ON_ERROR_STOP on

select case
  when to_regclass('etsy_worker.operators') is not null
   and to_regprocedure('public.etsy_worker_lane_whoami()') is not null
   and exists (
     select 1
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'etsy_worker_claim_job'
       and p.prosrc like '%require_lane%'
   )
  then 1 else 0
end as etsy_worker_applied
\gset

\if :etsy_worker_applied
\echo Etsy worker migrations are already applied.
\else
\ir migrations/20260925120000_etsy_worker.sql
\ir migrations/20260925140000_etsy_worker_commands.sql
\ir migrations/20260925160000_etsy_worker_auth.sql
\endif
