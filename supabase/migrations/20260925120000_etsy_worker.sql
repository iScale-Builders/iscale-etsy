-- Optional backend queue for iScale Etsy worker lanes.
--
-- Apply this file yourself in a Postgres / Supabase SQL editor. Nothing in this
-- repository connects to a database or ships a project URL or key.
--
-- The grants at the bottom of this file allow anon. Migration
-- 20260925160000_etsy_worker_auth.sql replaces them with operator checks.
-- Do not run this file again after that migration: it aborts if
-- etsy_worker.operators already exists.
--
-- Realtime: when the supabase_realtime publication exists, etsy_worker.jobs is
-- added so an idle lane can wake on a new pending term. Polling still works
-- without it.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- CREATE ROLE cannot run inside a transaction. Everything after it can, so a
-- partial apply under psql -f or the Supabase SQL endpoint rolls back.
begin;

do $$
begin
  if to_regclass('etsy_worker.operators') is not null then
    raise exception 'Refusing to re-apply 20260925120000_etsy_worker.sql because etsy_worker.operators already exists. Re-running it would grant anon and replace the auth wrappers.';
  end if;
end $$;

create schema if not exists etsy_worker;

create table if not exists etsy_worker.jobs (
  id uuid primary key default gen_random_uuid(),
  term text not null,
  term_norm text not null,
  priority integer not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'blocked')),
  pages integer not null default 1 check (pages between 1 and 50),
  sort text not null default 'most_relevant',
  claimed_by text,
  lease_expires_at timestamptz,
  attempt integer not null default 0,
  max_attempts integer not null default 3,
  pages_done integer not null default 0,
  listings_uploaded integer not null default 0,
  total_results integer,
  last_page integer,
  last_error text,
  progress jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create unique index if not exists etsy_worker_jobs_one_open_term
  on etsy_worker.jobs (term_norm)
  where status in ('pending', 'processing');

create index if not exists etsy_worker_jobs_pending_order
  on etsy_worker.jobs (priority desc, created_at asc)
  where status = 'pending';

create table if not exists etsy_worker.listings (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references etsy_worker.jobs (id) on delete cascade,
  term text not null,
  page integer not null,
  position integer not null,
  listing_id text not null,
  title text,
  shop_name text,
  price text,
  price_numeric numeric,
  currency text,
  favorites integer,
  review_count integer,
  rating numeric,
  sales_signal text,
  is_bestseller boolean not null default false,
  is_popular boolean not null default false,
  is_ad boolean not null default false,
  tags text[] not null default '{}',
  image_url text,
  listing_url text,
  total_results integer,
  scraped_at timestamptz not null default now(),
  unique (job_id, listing_id, page)
);

create index if not exists etsy_worker_listings_job_page
  on etsy_worker.listings (job_id, page, position);

create table if not exists etsy_worker.workers (
  lane_name text primary key,
  status text not null default 'idle',
  current_job_id uuid,
  current_term text,
  progress jsonb not null default '{}'::jsonb,
  last_error text,
  last_heartbeat timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table etsy_worker.jobs replica identity full;

alter table etsy_worker.jobs enable row level security;
alter table etsy_worker.listings enable row level security;
alter table etsy_worker.workers enable row level security;

revoke all on schema etsy_worker from public;
grant usage on schema etsy_worker to anon, authenticated, service_role;

revoke all on all tables in schema etsy_worker from public, anon, authenticated;
-- Realtime postgres_changes checks SELECT under RLS. Listings stay RPC-only.
grant select on etsy_worker.jobs to anon, authenticated;

drop policy if exists jobs_select_for_realtime on etsy_worker.jobs;
create policy jobs_select_for_realtime
  on etsy_worker.jobs
  for select
  to anon, authenticated
  using (true);

-- Helpers stay in etsy_worker and are not granted to the anon API role.

create or replace function etsy_worker.norm_term(p_term text)
returns text
language sql
immutable
as $fn$
  select lower(regexp_replace(btrim(coalesce(p_term, '')), '\s+', ' ', 'g'));
$fn$;

create or replace function etsy_worker.valid_lane(p_lane text)
returns text
language sql
immutable
as $fn$
  select case
    when btrim(coalesce(p_lane, '')) ~ '^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$' then btrim(p_lane)
    else null
  end;
$fn$;

create or replace function etsy_worker.to_int(p_value text)
returns integer
language plpgsql
immutable
as $fn$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  return btrim(p_value)::integer;
exception
  when others then
    return null;
end;
$fn$;

create or replace function etsy_worker.to_num(p_value text)
returns numeric
language plpgsql
immutable
as $fn$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  return btrim(p_value)::numeric;
exception
  when others then
    return null;
end;
$fn$;

create or replace function etsy_worker.touch_worker(
  p_lane text,
  p_status text,
  p_job_id uuid,
  p_term text,
  p_progress jsonb,
  p_error text
) returns void
language plpgsql
as $fn$
begin
  insert into etsy_worker.workers (
    lane_name, status, current_job_id, current_term, progress, last_error, last_heartbeat, updated_at
  ) values (
    p_lane,
    p_status,
    p_job_id,
    p_term,
    coalesce(p_progress, '{}'::jsonb),
    nullif(p_error, ''),
    now(),
    now()
  )
  on conflict (lane_name) do update set
    status = excluded.status,
    current_job_id = excluded.current_job_id,
    current_term = excluded.current_term,
    progress = case
      when p_progress is null then etsy_worker.workers.progress
      else etsy_worker.workers.progress || excluded.progress
    end,
    -- null keeps the previous error, '' clears it, any other string records it.
    last_error = case
      when p_error is null then etsy_worker.workers.last_error
      when p_error = '' then null
      else p_error
    end,
    last_heartbeat = now(),
    updated_at = now();
end;
$fn$;

-- Move processing rows whose lease has expired back to pending, or fail them
-- once max_attempts is exhausted. Safe to call repeatedly: a second call finds
-- nothing left in processing with an expired lease. Attempt counts increase
-- only when a lane claims, never here.
create or replace function public.etsy_worker_requeue_expired()
returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  r record;
  v_requeued integer := 0;
  v_failed integer := 0;
begin
  for r in
    select id, attempt, max_attempts
    from etsy_worker.jobs
    where status = 'processing'
      and lease_expires_at is not null
      and lease_expires_at <= now()
    for update skip locked
  loop
    if r.attempt >= r.max_attempts then
      update etsy_worker.jobs
      set status = 'failed',
          last_error = 'lease_expired',
          lease_expires_at = null,
          completed_at = now(),
          updated_at = now()
      where id = r.id
        and status = 'processing';
      v_failed := v_failed + 1;
    else
      update etsy_worker.jobs
      set status = 'pending',
          claimed_by = null,
          lease_expires_at = null,
          last_error = 'lease_expired',
          updated_at = now()
      where id = r.id
        and status = 'processing';
      v_requeued := v_requeued + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'requeued', v_requeued, 'failed', v_failed);
end;
$fn$;

create or replace function public.etsy_worker_add_terms(
  p_terms jsonb,
  p_priority integer default 0,
  p_pages integer default 1,
  p_sort text default 'most_relevant'
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_item jsonb;
  v_term text;
  v_norm text;
  v_priority integer;
  v_pages integer;
  v_sort text;
  v_existing etsy_worker.jobs%rowtype;
  v_id uuid;
  v_action text;
  v_results jsonb := '[]'::jsonb;
begin
  if p_terms is null or jsonb_typeof(p_terms) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'p_terms must be a json array');
  end if;

  for v_item in select value from jsonb_array_elements(p_terms)
  loop
    if jsonb_typeof(v_item) = 'string' then
      v_term := v_item #>> '{}';
      v_priority := greatest(0, least(coalesce(p_priority, 0), 1000000));
      v_pages := greatest(1, least(coalesce(p_pages, 1), 50));
      v_sort := coalesce(nullif(btrim(p_sort), ''), 'most_relevant');
    elsif jsonb_typeof(v_item) = 'object' then
      v_term := v_item ->> 'term';
      v_priority := greatest(0, least(coalesce(etsy_worker.to_int(v_item ->> 'priority'), p_priority, 0), 1000000));
      v_pages := greatest(1, least(coalesce(etsy_worker.to_int(v_item ->> 'pages'), p_pages, 1), 50));
      v_sort := coalesce(nullif(btrim(coalesce(v_item ->> 'sort', p_sort)), ''), 'most_relevant');
    else
      continue;
    end if;

    v_term := regexp_replace(btrim(coalesce(v_term, '')), '\s+', ' ', 'g');
    v_norm := etsy_worker.norm_term(v_term);
    if v_sort !~ '^[a-z0-9_]{1,40}$' then
      v_sort := 'most_relevant';
    end if;
    if char_length(v_term) < 2 or char_length(v_term) > 100 then
      v_results := v_results || jsonb_build_array(jsonb_build_object('term', v_term, 'action', 'rejected'));
      continue;
    end if;

    perform pg_advisory_xact_lock(hashtext('etsy-worker:' || v_norm));

    select * into v_existing
    from etsy_worker.jobs
    where term_norm = v_norm
      and status in ('pending', 'processing')
    order by created_at desc
    limit 1
    for update;

    if not found then
      insert into etsy_worker.jobs (term, term_norm, priority, pages, sort)
      values (v_term, v_norm, v_priority, v_pages, v_sort)
      returning id into v_id;
      v_action := 'inserted';
    elsif v_existing.status = 'pending' then
      update etsy_worker.jobs
      set priority = greatest(priority, v_priority),
          pages = greatest(pages, v_pages),
          sort = v_sort,
          updated_at = now()
      where id = v_existing.id
      returning id, priority into v_id, v_priority;
      v_action := 'updated';
    else
      v_id := v_existing.id;
      v_priority := v_existing.priority;
      v_action := 'already_running';
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'id', v_id,
      'term', v_term,
      'action', v_action,
      'priority', v_priority
    ));
  end loop;

  return jsonb_build_object('ok', true, 'jobs', v_results);
end;
$fn$;

-- Insert, or raise, a term above every other open job so the next claim takes it.
create or replace function public.etsy_worker_search_now(
  p_term text,
  p_pages integer default 1,
  p_sort text default 'most_relevant'
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_term text := regexp_replace(btrim(coalesce(p_term, '')), '\s+', ' ', 'g');
  v_norm text := etsy_worker.norm_term(v_term);
  v_pages integer := greatest(1, least(coalesce(p_pages, 1), 50));
  v_sort text := coalesce(nullif(btrim(p_sort), ''), 'most_relevant');
  v_priority integer;
  v_existing etsy_worker.jobs%rowtype;
  v_id uuid;
  v_action text;
begin
  if v_sort !~ '^[a-z0-9_]{1,40}$' then
    v_sort := 'most_relevant';
  end if;
  if char_length(v_term) < 2 or char_length(v_term) > 100 then
    return jsonb_build_object('ok', false, 'error', 'invalid_term');
  end if;

  perform pg_advisory_xact_lock(hashtext('etsy-worker-priority'));
  perform pg_advisory_xact_lock(hashtext('etsy-worker:' || v_norm));

  select coalesce(max(priority), 0) + 1 into v_priority
  from etsy_worker.jobs
  where status in ('pending', 'processing');
  v_priority := least(v_priority, 1000000);

  select * into v_existing
  from etsy_worker.jobs
  where term_norm = v_norm
    and status in ('pending', 'processing')
  limit 1
  for update;

  if not found then
    insert into etsy_worker.jobs (term, term_norm, priority, pages, sort)
    values (v_term, v_norm, v_priority, v_pages, v_sort)
    returning id into v_id;
    v_action := 'inserted';
  elsif v_existing.status = 'pending' then
    update etsy_worker.jobs
    set priority = greatest(priority, v_priority),
        pages = greatest(pages, v_pages),
        sort = v_sort,
        updated_at = now()
    where id = v_existing.id
    returning id, priority into v_id, v_priority;
    v_action := 'updated';
  else
    v_id := v_existing.id;
    v_priority := v_existing.priority;
    v_action := 'already_running';
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'term', v_term,
    'action', v_action,
    'priority', v_priority,
    'pages', case when v_action = 'already_running' then v_existing.pages else v_pages end
  );
end;
$fn$;

create or replace function public.etsy_worker_claim_job(
  p_lane_name text,
  p_lease_seconds integer default 180
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_lane text := etsy_worker.valid_lane(p_lane_name);
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 180), 3600));
  v_job etsy_worker.jobs%rowtype;
  v_requeue jsonb;
begin
  if v_lane is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_lane_name');
  end if;

  v_requeue := public.etsy_worker_requeue_expired();

  select * into v_job
  from etsy_worker.jobs
  where status = 'pending'
  order by priority desc, created_at asc
  for update skip locked
  limit 1;

  if not found then
    perform etsy_worker.touch_worker(v_lane, 'idle', null, null, null, null);
    return jsonb_build_object('ok', true, 'job', null, 'requeue', v_requeue);
  end if;

  update etsy_worker.jobs
  set status = 'processing',
      claimed_by = v_lane,
      lease_expires_at = now() + make_interval(secs => v_lease),
      attempt = attempt + 1,
      started_at = coalesce(started_at, now()),
      last_error = null,
      updated_at = now()
  where id = v_job.id
  returning * into v_job;

  perform etsy_worker.touch_worker(v_lane, 'running', v_job.id, v_job.term, '{}'::jsonb, '');

  return jsonb_build_object(
    'ok', true,
    'requeue', v_requeue,
    'job', jsonb_build_object(
      'id', v_job.id,
      'term', v_job.term,
      'priority', v_job.priority,
      'pages', v_job.pages,
      'sort', v_job.sort,
      'attempt', v_job.attempt,
      'max_attempts', v_job.max_attempts,
      'pages_done', v_job.pages_done,
      'lease_expires_at', v_job.lease_expires_at
    )
  );
end;
$fn$;

create or replace function public.etsy_worker_heartbeat(
  p_lane_name text,
  p_job_id uuid default null,
  p_progress jsonb default null,
  p_lease_seconds integer default 180
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_lane text := etsy_worker.valid_lane(p_lane_name);
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 180), 3600));
  r etsy_worker.jobs%rowtype;
begin
  if v_lane is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_lane_name');
  end if;

  if p_job_id is null then
    perform etsy_worker.touch_worker(v_lane, 'idle', null, null, p_progress, null);
    return jsonb_build_object('ok', true, 'extended', false);
  end if;

  select * into r from etsy_worker.jobs where id = p_job_id for update;
  if not found then
    perform etsy_worker.touch_worker(v_lane, 'error', null, null, p_progress, 'job_not_found');
    return jsonb_build_object('ok', false, 'error', 'job_not_found');
  end if;

  if r.status = 'processing'
     and r.claimed_by = v_lane
     and r.lease_expires_at is not null
     and r.lease_expires_at > now() then
    update etsy_worker.jobs
    set lease_expires_at = now() + make_interval(secs => v_lease),
        progress = progress || coalesce(p_progress, '{}'::jsonb),
        updated_at = now()
    where id = r.id;
    perform etsy_worker.touch_worker(v_lane, 'running', r.id, r.term, p_progress, '');
    return jsonb_build_object('ok', true, 'extended', true);
  end if;

  perform etsy_worker.touch_worker(v_lane, 'error', r.id, r.term, p_progress, 'lease_lost');
  return jsonb_build_object('ok', false, 'error', 'lease_lost', 'status', r.status);
end;
$fn$;

create or replace function public.etsy_worker_upload_results(
  p_job_id uuid,
  p_lane_name text,
  p_listings jsonb,
  p_page integer,
  p_total_results integer default null,
  p_lease_seconds integer default 180
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_lane text := etsy_worker.valid_lane(p_lane_name);
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 180), 3600));
  r etsy_worker.jobs%rowtype;
  l jsonb;
  v_listing_id text;
  v_position integer;
  v_page integer;
  v_tags text[];
  v_stored integer := 0;
  v_skipped integer := 0;
  v_uploaded integer;
  v_seen integer := 0;
begin
  if v_lane is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_lane_name');
  end if;
  if p_listings is null or jsonb_typeof(p_listings) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'p_listings must be a json array');
  end if;

  select * into r from etsy_worker.jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'job_not_found');
  end if;
  if r.status = 'completed' then
    return jsonb_build_object('ok', false, 'error', 'already_completed', 'status', r.status);
  end if;
  if r.status <> 'processing'
     or r.claimed_by is distinct from v_lane
     or r.lease_expires_at is null
     or r.lease_expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'lease_lost', 'status', r.status);
  end if;

  for l in select value from jsonb_array_elements(p_listings)
  loop
    v_seen := v_seen + 1;
    exit when v_seen > 300;
    v_listing_id := l ->> 'listing_id';
    v_position := etsy_worker.to_int(l ->> 'position');
    v_page := coalesce(etsy_worker.to_int(l ->> 'page'), p_page);
    if v_listing_id is null or v_listing_id !~ '^\d{7,12}$' or v_position is null or v_position < 1 or v_page is null or v_page < 1 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_tags := '{}'::text[];
    if jsonb_typeof(l -> 'tags') = 'array' then
      select coalesce(array_agg(left(btrim(value), 40)), '{}'::text[])
      into v_tags
      from jsonb_array_elements_text(l -> 'tags') as t(value)
      where length(btrim(value)) > 0;
    end if;

    insert into etsy_worker.listings (
      job_id, term, page, position, listing_id, title, shop_name, price, price_numeric,
      currency, favorites, review_count, rating, sales_signal, is_bestseller, is_popular,
      is_ad, tags, image_url, listing_url, total_results, scraped_at
    ) values (
      r.id,
      r.term,
      v_page,
      v_position,
      v_listing_id,
      left(coalesce(l ->> 'title', ''), 500),
      left(coalesce(l ->> 'shop_name', ''), 200),
      left(coalesce(l ->> 'price', ''), 40),
      etsy_worker.to_num(l ->> 'price_numeric'),
      left(coalesce(l ->> 'currency', ''), 8),
      etsy_worker.to_int(l ->> 'favorites'),
      etsy_worker.to_int(l ->> 'review_count'),
      etsy_worker.to_num(l ->> 'rating'),
      left(coalesce(l ->> 'sales_signal', ''), 200),
      coalesce((l ->> 'is_bestseller')::boolean, false),
      coalesce((l ->> 'is_popular')::boolean, false),
      coalesce((l ->> 'is_ad')::boolean, false),
      coalesce(v_tags, '{}'::text[]),
      left(coalesce(l ->> 'image_url', ''), 1000),
      left(coalesce(l ->> 'listing_url', ''), 500),
      coalesce(p_total_results, r.total_results),
      coalesce((l ->> 'scraped_at')::timestamptz, now())
    )
    on conflict (job_id, listing_id, page) do update set
      position = excluded.position,
      title = excluded.title,
      shop_name = excluded.shop_name,
      price = excluded.price,
      price_numeric = excluded.price_numeric,
      currency = excluded.currency,
      favorites = excluded.favorites,
      review_count = excluded.review_count,
      rating = excluded.rating,
      sales_signal = excluded.sales_signal,
      is_bestseller = excluded.is_bestseller,
      is_popular = excluded.is_popular,
      is_ad = excluded.is_ad,
      tags = excluded.tags,
      image_url = excluded.image_url,
      listing_url = excluded.listing_url,
      total_results = excluded.total_results,
      scraped_at = excluded.scraped_at;
    v_stored := v_stored + 1;
  end loop;

  select count(*) into v_uploaded from etsy_worker.listings where job_id = r.id;

  update etsy_worker.jobs
  set pages_done = greatest(pages_done, greatest(1, coalesce(p_page, 1))),
      last_page = greatest(1, coalesce(p_page, 1)),
      total_results = case when p_total_results is null then total_results else p_total_results end,
      listings_uploaded = v_uploaded,
      lease_expires_at = now() + make_interval(secs => v_lease),
      progress = progress || jsonb_build_object(
        'page', greatest(1, coalesce(p_page, 1)),
        'listings_uploaded', v_uploaded,
        'total_results', case when p_total_results is null then total_results else p_total_results end
      ),
      updated_at = now()
  where id = r.id;

  perform etsy_worker.touch_worker(
    v_lane,
    'running',
    r.id,
    r.term,
    jsonb_build_object('page', p_page, 'listings_uploaded', v_uploaded, 'total_results', p_total_results),
    ''
  );

  return jsonb_build_object(
    'ok', true,
    'stored', v_stored,
    'skipped', v_skipped,
    'listings_uploaded', v_uploaded,
    'page', greatest(1, coalesce(p_page, 1)),
    'total_results', case when p_total_results is null then r.total_results else p_total_results end
  );
end;
$fn$;

create or replace function public.etsy_worker_complete_job(
  p_job_id uuid,
  p_lane_name text,
  p_progress jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_lane text := etsy_worker.valid_lane(p_lane_name);
  r etsy_worker.jobs%rowtype;
begin
  if v_lane is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_lane_name');
  end if;

  select * into r from etsy_worker.jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'job_not_found');
  end if;
  if r.status = 'completed' then
    return jsonb_build_object('ok', true, 'already', true, 'id', r.id, 'status', 'completed');
  end if;
  if r.status <> 'processing'
     or r.claimed_by is distinct from v_lane
     or r.lease_expires_at is null
     or r.lease_expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'lease_lost', 'status', r.status);
  end if;

  update etsy_worker.jobs
  set status = 'completed',
      lease_expires_at = null,
      completed_at = now(),
      updated_at = now(),
      last_error = null,
      progress = progress || coalesce(p_progress, '{}'::jsonb) || jsonb_build_object('phase', 'done')
  where id = r.id;

  perform etsy_worker.touch_worker(v_lane, 'idle', null, null, coalesce(p_progress, '{}'::jsonb), '');
  return jsonb_build_object('ok', true, 'already', false, 'id', r.id, 'status', 'completed');
end;
$fn$;

create or replace function public.etsy_worker_fail_job(
  p_job_id uuid,
  p_lane_name text,
  p_error text,
  p_blocked boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_lane text := etsy_worker.valid_lane(p_lane_name);
  r etsy_worker.jobs%rowtype;
  v_status text;
  v_error text := left(coalesce(nullif(btrim(p_error), ''), 'failed'), 300);
begin
  if v_lane is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_lane_name');
  end if;

  select * into r from etsy_worker.jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'job_not_found');
  end if;
  if r.status in ('completed', 'failed', 'blocked') then
    return jsonb_build_object('ok', true, 'already', true, 'id', r.id, 'status', r.status);
  end if;
  if r.status <> 'processing'
     or r.claimed_by is distinct from v_lane
     or r.lease_expires_at is null
     or r.lease_expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'lease_lost', 'status', r.status);
  end if;

  v_status := case when coalesce(p_blocked, false) then 'blocked' else 'failed' end;
  update etsy_worker.jobs
  set status = v_status,
      last_error = v_error,
      lease_expires_at = null,
      completed_at = now(),
      updated_at = now()
  where id = r.id;

  perform etsy_worker.touch_worker(v_lane, v_status, r.id, r.term, null, v_error);
  return jsonb_build_object('ok', true, 'already', false, 'id', r.id, 'status', v_status, 'error', v_error);
end;
$fn$;

create or replace function public.etsy_worker_health()
returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_jobs jsonb;
  v_workers jsonb;
  v_expired integer;
begin
  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
  into v_jobs
  from (
    select status, count(*)::integer as n
    from etsy_worker.jobs
    group by status
  ) s;

  select count(*)::integer into v_expired
  from etsy_worker.jobs
  where status = 'processing'
    and lease_expires_at is not null
    and lease_expires_at <= now();

  select coalesce(jsonb_agg(row_to_json(w)::jsonb order by w.lane_name), '[]'::jsonb)
  into v_workers
  from (
    select
      lane_name,
      status,
      current_term,
      current_job_id,
      last_error,
      last_heartbeat,
      (last_heartbeat < now() - interval '90 seconds') as stale
    from etsy_worker.workers
  ) w;

  return jsonb_build_object(
    'ok', true,
    'generated_at', now(),
    'jobs', v_jobs || jsonb_build_object('expired_leases', v_expired),
    'workers', v_workers
  );
end;
$fn$;

create or replace function etsy_worker.pick_job(p_term text)
returns etsy_worker.jobs
language plpgsql
stable
as $fn$
declare
  r etsy_worker.jobs%rowtype;
  v_norm text := etsy_worker.norm_term(p_term);
begin
  select * into r
  from etsy_worker.jobs
  where term_norm = v_norm
  order by
    case
      when status in ('pending', 'processing') then 0
      when status = 'completed' then 1
      when status = 'blocked' then 2
      else 3
    end,
    created_at desc
  limit 1;
  if not found then
    return null;
  end if;
  return r;
end;
$fn$;

create or replace function public.etsy_worker_term_status(p_term text)
returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  r etsy_worker.jobs%rowtype;
  v_term text := regexp_replace(btrim(coalesce(p_term, '')), '\s+', ' ', 'g');
begin
  if char_length(v_term) < 2 then
    return jsonb_build_object('ok', false, 'error', 'invalid_term');
  end if;
  r := etsy_worker.pick_job(v_term);
  if r is null then
    return jsonb_build_object('ok', false, 'error', 'not_found', 'term', v_term);
  end if;
  return jsonb_build_object(
    'ok', true,
    'id', r.id,
    'term', r.term,
    'state', r.status,
    'lane', r.claimed_by,
    'priority', r.priority,
    'pages', r.pages,
    'pages_done', r.pages_done,
    'rows', r.listings_uploaded,
    'total_results', r.total_results,
    'last_error', r.last_error,
    'attempt', r.attempt,
    'max_attempts', r.max_attempts,
    'sort', r.sort,
    'lease_expires_at', r.lease_expires_at,
    'search_path', r.progress ->> 'search_path',
    'updated_at', r.updated_at,
    'created_at', r.created_at
  );
end;
$fn$;

create or replace function public.etsy_worker_results(
  p_term text,
  p_limit integer default 500,
  p_offset integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  r etsy_worker.jobs%rowtype;
  v_term text := regexp_replace(btrim(coalesce(p_term, '')), '\s+', ' ', 'g');
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 2000));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_rows jsonb;
  v_count integer;
begin
  if char_length(v_term) < 2 then
    return jsonb_build_object('ok', false, 'error', 'invalid_term');
  end if;
  r := etsy_worker.pick_job(v_term);
  if r is null then
    return jsonb_build_object('ok', false, 'error', 'not_found', 'term', v_term);
  end if;

  select count(*)::integer into v_count from etsy_worker.listings where job_id = r.id;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.page, x.position), '[]'::jsonb)
  into v_rows
  from (
    select
      listing_id, title, shop_name, price, price_numeric, currency, favorites,
      review_count, rating, sales_signal, is_bestseller, is_popular, is_ad, tags,
      image_url, listing_url, page, position, total_results, scraped_at, term
    from etsy_worker.listings
    where job_id = r.id
    order by page, position
    limit v_limit
    offset v_offset
  ) x;

  return jsonb_build_object(
    'ok', true,
    'job', jsonb_build_object(
      'id', r.id,
      'term', r.term,
      'state', r.status,
      'lane', r.claimed_by,
      'pages', r.pages,
      'pages_done', r.pages_done,
      'rows', r.listings_uploaded,
      'total_results', r.total_results,
      'last_error', r.last_error,
      'priority', r.priority
    ),
    'listing_count', v_count,
    'returned', jsonb_array_length(v_rows),
    'offset', v_offset,
    'listings', v_rows
  );
end;
$fn$;

create or replace function public.etsy_worker_fleet_status()
returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_health jsonb;
  v_recent jsonb;
begin
  v_health := public.etsy_worker_health();
  select coalesce(jsonb_agg(j order by u desc), '[]'::jsonb)
  into v_recent
  from (
    select
      updated_at as u,
      jsonb_build_object(
        'id', id,
        'term', term,
        'state', status,
        'lane', claimed_by,
        'priority', priority,
        'pages_done', pages_done,
        'pages', pages,
        'rows', listings_uploaded,
        'total_results', total_results,
        'last_error', last_error,
        'updated_at', updated_at
      ) as j
    from etsy_worker.jobs
    order by updated_at desc
    limit 20
  ) s;
  return v_health || jsonb_build_object('recent_jobs', v_recent);
end;
$fn$;

revoke all on function etsy_worker.norm_term(text) from public, anon, authenticated;
revoke all on function etsy_worker.valid_lane(text) from public, anon, authenticated;
revoke all on function etsy_worker.to_int(text) from public, anon, authenticated;
revoke all on function etsy_worker.to_num(text) from public, anon, authenticated;
revoke all on function etsy_worker.touch_worker(text, text, uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function etsy_worker.pick_job(text) from public, anon, authenticated;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'etsy_worker_requeue_expired()',
    'etsy_worker_add_terms(jsonb, integer, integer, text)',
    'etsy_worker_search_now(text, integer, text)',
    'etsy_worker_claim_job(text, integer)',
    'etsy_worker_heartbeat(text, uuid, jsonb, integer)',
    'etsy_worker_upload_results(uuid, text, jsonb, integer, integer, integer)',
    'etsy_worker_complete_job(uuid, text, jsonb)',
    'etsy_worker_fail_job(uuid, text, text, boolean)',
    'etsy_worker_health()',
    'etsy_worker_term_status(text)',
    'etsy_worker_results(text, integer, integer)',
    'etsy_worker_fleet_status()'
  ]
  loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', fn);
  end loop;
end $$;

-- Best-effort. Fresh Postgres has no supabase_realtime publication; Supabase does.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table etsy_worker.jobs;
    exception
      when duplicate_object then
        null;
      when others then
        null;
    end;
  end if;
exception
  when undefined_table then
    null;
end $$;

commit;
