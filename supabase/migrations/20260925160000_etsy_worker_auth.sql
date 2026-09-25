-- Operator auth for the Etsy worker RPCs.
--
-- Apply after 20260925120000_etsy_worker.sql and
-- 20260925140000_etsy_worker_commands.sql. The publishable key stays in the
-- apikey header. Callers must be signed-in Auth users with a row in
-- etsy_worker.operators. anon and public cannot execute these RPCs.
-- The operators table is the access gate. This file does not change who can
-- sign up for the project. Create Auth users in the dashboard, then:
--   insert into etsy_worker.operators (user_id, role, lane_name) values
--     ('<lane-user-uuid>', 'lane', 'lane-1'),
--     ('<agent-user-uuid>', 'agent', null);
-- Re-running this file is a no-op once the wrappers are in place.

begin;

create table if not exists etsy_worker.operators (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null,
  lane_name text,
  created_at timestamptz not null default now()
);

alter table etsy_worker.operators add column if not exists lane_name text;
alter table etsy_worker.operators drop constraint if exists operators_role_check;
alter table etsy_worker.operators drop constraint if exists operators_role_lane_check;
alter table etsy_worker.operators
  add constraint operators_role_lane_check check (
    role in ('lane', 'agent', 'admin')
    and (role <> 'lane' or lane_name is not null)
    and (lane_name is null or etsy_worker.valid_lane(lane_name) = lane_name)
  );

alter table etsy_worker.operators enable row level security;
revoke all on etsy_worker.operators from public, anon, authenticated;

alter table etsy_worker.jobs add column if not exists total_results_raw text;

create or replace function etsy_worker.is_operator()
returns boolean
language sql
stable
security definer
set search_path = etsy_worker, public
as $fn$
  select exists (
    select 1 from etsy_worker.operators
    where user_id = auth.uid()
  );
$fn$;

revoke all on function etsy_worker.is_operator() from public, anon, authenticated;
grant execute on function etsy_worker.is_operator() to authenticated;

-- Returns null when the caller may proceed, otherwise an error code.
-- There is no session-variable bypass. Wrappers call etsy_worker implementations
-- directly. Those implementations are not executable by anon or authenticated.
create or replace function etsy_worker.require_operator(p_roles text[])
returns text
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_uid uuid;
  v_role text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return 'not_authenticated';
  end if;
  select role into v_role from etsy_worker.operators where user_id = v_uid;
  if v_role is null then
    return 'not_authorized';
  end if;
  if v_role <> 'admin' and not (v_role = any (coalesce(p_roles, '{}'::text[]))) then
    return 'not_authorized';
  end if;
  return null;
end;
$fn$;

revoke all on function etsy_worker.require_operator(text[]) from public, anon, authenticated;

-- Lane RPCs must use the lane_name stored for this user. Admin is exempt.
create or replace function etsy_worker.require_lane(p_lane_name text)
returns text
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_auth text;
  v_role text;
  v_bound text;
  v_lane text;
begin
  v_auth := etsy_worker.require_operator(array['lane']::text[]);
  if v_auth is not null then
    return v_auth;
  end if;
  select role, lane_name into v_role, v_bound
  from etsy_worker.operators
  where user_id = auth.uid();
  if v_role = 'admin' then
    return null;
  end if;
  v_lane := etsy_worker.valid_lane(p_lane_name);
  if v_lane is null or v_bound is distinct from v_lane then
    return 'lane_mismatch';
  end if;
  return null;
end;
$fn$;

revoke all on function etsy_worker.require_lane(text) from public, anon, authenticated;

-- Replace implementations only on the first apply. A second run leaves the
-- public wrappers (and their auth checks) in place.
do $guard$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'etsy_worker_claim_job'
      and (p.prosrc like '%require_lane%' or p.prosrc like '%require_operator%')
  ) then
    return;
  end if;

  execute $body$
-- Lock every accepted term before writing any of them, in sorted order, so two
-- overlapping add_terms calls cannot deadlock on advisory locks.
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
  v_work jsonb := '[]'::jsonb;
  v_row jsonb;
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
      v_work := v_work || jsonb_build_array(jsonb_build_object('term', v_term, 'rejected', true));
      continue;
    end if;
    v_work := v_work || jsonb_build_array(jsonb_build_object(
      'term', v_term,
      'norm', v_norm,
      'priority', v_priority,
      'pages', v_pages,
      'sort', v_sort,
      'rejected', false
    ));
  end loop;

  for v_norm in
    select distinct value ->> 'norm'
    from jsonb_array_elements(v_work) as t(value)
    where coalesce((value ->> 'rejected')::boolean, false) = false
      and coalesce(value ->> 'norm', '') <> ''
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtext('etsy-worker:' || v_norm));
  end loop;

  for v_row in select value from jsonb_array_elements(v_work)
  loop
    if coalesce((v_row ->> 'rejected')::boolean, false) then
      v_results := v_results || jsonb_build_array(jsonb_build_object('term', v_row ->> 'term', 'action', 'rejected'));
      continue;
    end if;

    v_term := v_row ->> 'term';
    v_norm := v_row ->> 'norm';
    v_priority := etsy_worker.to_int(v_row ->> 'priority');
    v_pages := etsy_worker.to_int(v_row ->> 'pages');
    v_sort := v_row ->> 'sort';

    select * into v_existing
    from etsy_worker.jobs
    where job_type = 'search'
      and term_norm = v_norm
      and status in ('pending', 'processing')
    order by created_at desc
    limit 1
    for update;

    if not found then
      insert into etsy_worker.jobs (job_type, term, term_norm, priority, pages, sort)
      values ('search', v_term, v_norm, v_priority, v_pages, v_sort)
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

drop function if exists public.etsy_worker_fail_job(uuid, text, text, boolean);

create function public.etsy_worker_fail_job(
  p_job_id uuid,
  p_lane_name text,
  p_error text,
  p_blocked boolean default false,
  p_retryable boolean default false,
  p_release boolean default false
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

  if coalesce(p_release, false) then
    update etsy_worker.jobs
    set status = 'pending',
        claimed_by = null,
        lease_expires_at = null,
        attempt = greatest(attempt - 1, 0),
        last_error = null,
        updated_at = now()
    where id = r.id;
    perform etsy_worker.touch_worker(v_lane, 'idle', null, null, null, '');
    return jsonb_build_object('ok', true, 'already', false, 'id', r.id, 'status', 'pending', 'released', true);
  end if;

  if coalesce(p_retryable, false) and not coalesce(p_blocked, false) and r.attempt < r.max_attempts then
    update etsy_worker.jobs
    set status = 'pending',
        claimed_by = null,
        lease_expires_at = null,
        last_error = v_error,
        updated_at = now()
    where id = r.id;
    perform etsy_worker.touch_worker(v_lane, 'idle', null, null, null, v_error);
    return jsonb_build_object('ok', true, 'already', false, 'id', r.id, 'status', 'pending', 'retryable', true, 'error', v_error);
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

drop function if exists public.etsy_worker_upload_results(uuid, text, jsonb, integer, integer, integer);

create function public.etsy_worker_upload_results(
  p_job_id uuid,
  p_lane_name text,
  p_listings jsonb,
  p_page integer,
  p_total_results integer default null,
  p_lease_seconds integer default 180,
  p_total_results_raw text default null
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
  v_raw text := left(nullif(btrim(p_total_results_raw), ''), 200);
begin
  if v_lane is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_lane_name');
  end if;
  if p_listings is null or jsonb_typeof(p_listings) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'p_listings must be a json array');
  end if;
  if jsonb_array_length(p_listings) > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_many_rows');
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
    begin
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
    exception
      when others then
        v_skipped := v_skipped + 1;
    end;
  end loop;

  select count(*) into v_uploaded from etsy_worker.listings where job_id = r.id;

  update etsy_worker.jobs
  set pages_done = greatest(pages_done, greatest(1, coalesce(p_page, 1))),
      last_page = greatest(1, coalesce(p_page, 1)),
      total_results = case when p_total_results is null then total_results else p_total_results end,
      total_results_raw = case when v_raw is null then total_results_raw else v_raw end,
      listings_uploaded = v_uploaded,
      lease_expires_at = now() + make_interval(secs => v_lease),
      progress = progress || jsonb_build_object(
        'page', greatest(1, coalesce(p_page, 1)),
        'listings_uploaded', v_uploaded,
        'total_results', case when p_total_results is null then total_results else p_total_results end,
        'total_results_raw', case when v_raw is null then total_results_raw else v_raw end
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
    'total_results', case when p_total_results is null then r.total_results else p_total_results end,
    'total_results_raw', case when v_raw is null then r.total_results_raw else v_raw end
  );
end;
$fn$;
$body$;
end
$guard$;

-- Move each known public RPC into etsy_worker and leave a wrapper that checks
-- the operator role. The list is closed: a LIKE match is not enough, because
-- "_" is a wildcard and this project shares the public schema.
-- Lane calls may claim, heartbeat, upload, complete, and fail, and only for
-- the lane_name on their operator row. Agent calls may enqueue and read.
-- Admin may do both. Re-running replaces the wrappers and does not move them.
do $install$
declare
  r record;
  v_check text;
  v_args text;
  v_defs text;
  v_wrapped integer := 0;
  v_def text;
  v_impl oid;
  v_public oid;
  v_src text;
begin
  for r in
    select allowed.proname, allowed.args
    from (
      values
        ('etsy_worker_add_terms', 'jsonb, integer, integer, text'),
        ('etsy_worker_claim_job', 'text, integer'),
        ('etsy_worker_complete_job', 'uuid, text, jsonb'),
        ('etsy_worker_enqueue', 'text, jsonb, integer'),
        ('etsy_worker_fail_job', 'uuid, text, text, boolean, boolean, boolean'),
        ('etsy_worker_fleet_status', ''),
        ('etsy_worker_health', ''),
        ('etsy_worker_heartbeat', 'text, uuid, jsonb, integer'),
        ('etsy_worker_job_results', 'uuid, integer, integer'),
        ('etsy_worker_job_status', 'uuid'),
        ('etsy_worker_lookup', 'text, text'),
        ('etsy_worker_requeue_expired', ''),
        ('etsy_worker_results', 'text, integer, integer'),
        ('etsy_worker_search_now', 'text, integer, text'),
        ('etsy_worker_term_status', 'text'),
        ('etsy_worker_upload_payload', 'uuid, text, text, jsonb, integer'),
        ('etsy_worker_upload_results', 'uuid, text, jsonb, integer, integer, integer, text')
    ) as allowed(proname, args)
    where allowed.proname like 'etsy\_worker\_%' escape e'\\'
  loop
    v_public := to_regprocedure(format('public.%I(%s)', r.proname, r.args));
    if v_public is null then
      continue;
    end if;
    select prosrc into v_src from pg_proc where oid = v_public;
    if v_src like '%require_lane%' or v_src like '%require_operator%' then
      continue;
    end if;
    execute format('alter function %s set schema etsy_worker', v_public::regprocedure::text);
    execute format(
      'revoke all on function etsy_worker.%I(%s) from public, anon, authenticated, service_role',
      r.proname,
      r.args
    );
  end loop;

  for r in
    select allowed.proname, allowed.args
    from (
      values
        ('etsy_worker_add_terms', 'jsonb, integer, integer, text'),
        ('etsy_worker_claim_job', 'text, integer'),
        ('etsy_worker_complete_job', 'uuid, text, jsonb'),
        ('etsy_worker_enqueue', 'text, jsonb, integer'),
        ('etsy_worker_fail_job', 'uuid, text, text, boolean, boolean, boolean'),
        ('etsy_worker_fleet_status', ''),
        ('etsy_worker_health', ''),
        ('etsy_worker_heartbeat', 'text, uuid, jsonb, integer'),
        ('etsy_worker_job_results', 'uuid, integer, integer'),
        ('etsy_worker_job_status', 'uuid'),
        ('etsy_worker_lookup', 'text, text'),
        ('etsy_worker_requeue_expired', ''),
        ('etsy_worker_results', 'text, integer, integer'),
        ('etsy_worker_search_now', 'text, integer, text'),
        ('etsy_worker_term_status', 'text'),
        ('etsy_worker_upload_payload', 'uuid, text, text, jsonb, integer'),
        ('etsy_worker_upload_results', 'uuid, text, jsonb, integer, integer, integer, text')
    ) as allowed(proname, args)
    where allowed.proname like 'etsy\_worker\_%' escape e'\\'
  loop
    v_impl := to_regprocedure(format('etsy_worker.%I(%s)', r.proname, r.args));
    if v_impl is null then
      raise exception 'Refusing to continue: etsy_worker.% (%) is not an implementation', r.proname, r.args;
    end if;
    select prosrc into v_src from pg_proc where oid = v_impl;
    if v_src like '%require_operator%' or v_src like '%require_lane%' then
      raise exception 'Refusing to continue: etsy_worker.% looks like a wrapper, not an implementation', r.proname;
    end if;

    v_def := pg_get_functiondef(v_impl);
    if position('public.etsy_worker_' in v_def) > 0 then
      execute replace(v_def, 'public.etsy_worker_', 'etsy_worker.etsy_worker_');
      v_impl := to_regprocedure(format('etsy_worker.%I(%s)', r.proname, r.args));
    end if;
    execute format(
      'revoke all on function etsy_worker.%I(%s) from public, anon, authenticated, service_role',
      r.proname,
      r.args
    );

    select
      pg_get_function_arguments(p.oid),
      coalesce(array_to_string(p.proargnames, ', '), '')
    into v_defs, v_args
    from pg_proc p
    where p.oid = v_impl;

    v_check := case r.proname
      when 'etsy_worker_claim_job' then 'etsy_worker.require_lane(p_lane_name)'
      when 'etsy_worker_heartbeat' then 'etsy_worker.require_lane(p_lane_name)'
      when 'etsy_worker_upload_results' then 'etsy_worker.require_lane(p_lane_name)'
      when 'etsy_worker_upload_payload' then 'etsy_worker.require_lane(p_lane_name)'
      when 'etsy_worker_complete_job' then 'etsy_worker.require_lane(p_lane_name)'
      when 'etsy_worker_fail_job' then 'etsy_worker.require_lane(p_lane_name)'
      when 'etsy_worker_requeue_expired' then 'etsy_worker.require_operator(array[''lane'',''agent'']::text[])'
      else 'etsy_worker.require_operator(array[''agent'']::text[])'
    end;

    execute format($sql$
      create or replace function public.%I(%s)
      returns jsonb
      language plpgsql
      security definer
      set search_path = etsy_worker, public
      as $wrap$
      declare
        v_auth text;
      begin
        v_auth := %s;
        if v_auth is not null then
          return jsonb_build_object('ok', false, 'error', v_auth);
        end if;
        return etsy_worker.%I(%s);
      end;
      $wrap$;
    $sql$, r.proname, v_defs, v_check, r.proname, v_args);

    execute format('revoke all on function public.%I(%s) from public, anon, service_role', r.proname, r.args);
    execute format('grant execute on function public.%I(%s) to authenticated', r.proname, r.args);
    v_wrapped := v_wrapped + 1;
  end loop;

  if v_wrapped <> 17 then
    raise exception 'Refusing to continue: expected 17 etsy_worker RPC wrappers, wrote %', v_wrapped;
  end if;
end
$install$;

create or replace function public.etsy_worker_lane_whoami()
returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_auth text;
  v_role text;
  v_lane text;
begin
  v_auth := etsy_worker.require_operator(array['lane', 'agent']::text[]);
  if v_auth is not null then
    return jsonb_build_object('ok', false, 'error', v_auth);
  end if;
  select role, lane_name into v_role, v_lane
  from etsy_worker.operators
  where user_id = auth.uid();
  return jsonb_build_object(
    'ok', true,
    'role', v_role,
    'lane_name', v_lane,
    'server_time', now()
  );
end;
$fn$;

revoke all on function public.etsy_worker_lane_whoami() from public, anon, service_role;
grant execute on function public.etsy_worker_lane_whoami() to authenticated;

revoke select on etsy_worker.jobs from anon;
grant select on etsy_worker.jobs to authenticated;

drop policy if exists jobs_select_for_realtime on etsy_worker.jobs;
create policy jobs_select_for_realtime
  on etsy_worker.jobs
  for select
  to authenticated
  using (etsy_worker.is_operator());

commit;
