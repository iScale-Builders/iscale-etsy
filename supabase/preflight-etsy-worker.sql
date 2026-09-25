-- Read-only check before applying the Etsy worker migrations on a shared project.
-- It does not create, change, or drop anything.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/preflight-etsy-worker.sql

select exists (
  select 1 from pg_namespace where nspname = 'etsy_worker'
) as etsy_worker_schema_exists;

select p.proname, pg_get_function_identity_arguments(p.oid) as identity_args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname like 'etsy\_worker\_%' escape e'\\'
order by p.proname, identity_args;

select roles.role_name,
       exists (select 1 from pg_roles where rolname = roles.role_name) as role_exists
from (values ('anon'), ('authenticated'), ('service_role')) as roles(role_name)
order by roles.role_name;

select exists (
  select 1 from pg_publication where pubname = 'supabase_realtime'
) as supabase_realtime_exists;
