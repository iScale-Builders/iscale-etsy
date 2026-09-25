-- Command channel on top of the worker queue.
--
-- Apply after 20260925120000_etsy_worker.sql. Nothing in this repository
-- connects to a database or ships a project URL or key.
--
-- A job is a type plus params. search keeps one open job per term. Other
-- types use their own subject key so they cannot collide with a search term.
-- Listings stay RPC-only. Export and stats snapshots live in payloads, also
-- RPC-only.
-- Do not run this file again after 20260925160000_etsy_worker_auth.sql.

begin;

do $$
begin
  if to_regclass('etsy_worker.operators') is not null then
    raise exception 'Refusing to re-apply 20260925140000_etsy_worker_commands.sql because etsy_worker.operators already exists. Re-running it would grant anon and replace the auth wrappers.';
  end if;
end $$;

alter table etsy_worker.jobs
  add column if not exists job_type text not null default 'search',
  add column if not exists params jsonb not null default '{}'::jsonb;

alter table etsy_worker.jobs drop constraint if exists etsy_worker_jobs_job_type_check;
alter table etsy_worker.jobs
  add constraint etsy_worker_jobs_job_type_check
  check (job_type in ('search', 'scrape-listings', 'scrape-shop', 'export', 'collection-stats'));

drop index if exists etsy_worker_jobs_one_open_term;
create unique index if not exists etsy_worker_jobs_one_open_subject
  on etsy_worker.jobs (job_type, term_norm)
  where status in ('pending', 'processing');

create table if not exists etsy_worker.payloads (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references etsy_worker.jobs (id) on delete cascade,
  kind text not null,
  body jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists etsy_worker_payloads_job
  on etsy_worker.payloads (job_id, created_at);

alter table etsy_worker.payloads enable row level security;
revoke all on etsy_worker.payloads from public, anon, authenticated;

create or replace function etsy_worker.stamp_command()
returns trigger
language plpgsql
as $fn$
begin
  if new.job_type is null or btrim(new.job_type) = '' then
    new.job_type := 'search';
  end if;
  if new.params is null then
    new.params := '{}'::jsonb;
  end if;
  if new.job_type = 'search' then
    new.params := coalesce(new.params, '{}'::jsonb) || jsonb_build_object(
      'term', new.term,
      'pages', new.pages,
      'sort', new.sort
    );
  end if;
  return new;
end;
$fn$;

drop trigger if exists etsy_worker_stamp_command on etsy_worker.jobs;
create trigger etsy_worker_stamp_command
  before insert or update on etsy_worker.jobs
  for each row execute function etsy_worker.stamp_command();

create or replace function etsy_worker.shop_name(p_value text)
returns text
language plpgsql
immutable
as $fn$
declare
  v text := btrim(coalesce(p_value, ''));
  v_shop text;
begin
  if v ~* '^https://' then
    if v !~* '^https://([a-z0-9-]+\.)*etsy\.com/shop/[A-Za-z0-9][A-Za-z0-9_-]{0,40}([/?]|$)' then
      return null;
    end if;
    v_shop := substring(v from '/shop/([A-Za-z0-9][A-Za-z0-9_-]{0,40})');
    return v_shop;
  end if;
  if v ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$' then
    return v;
  end if;
  return null;
end;
$fn$;

create or replace function etsy_worker.insert_command(
  p_type text,
  p_term text,
  p_norm text,
  p_priority integer,
  p_pages integer,
  p_sort text,
  p_params jsonb,
  p_reuse boolean
) returns jsonb
language plpgsql
as $fn$
declare
  v_existing etsy_worker.jobs%rowtype;
  v_id uuid;
  v_action text;
  v_priority integer := p_priority;
  v_pages integer := p_pages;
begin
  if p_reuse then
    perform pg_advisory_xact_lock(hashtext('etsy-worker:' || p_type || ':' || p_norm));
    select * into v_existing
    from etsy_worker.jobs
    where job_type = p_type
      and term_norm = p_norm
      and status in ('pending', 'processing')
    order by created_at desc
    limit 1
    for update;
    if not found then
      insert into etsy_worker.jobs (job_type, term, term_norm, priority, pages, sort, params)
      values (p_type, p_term, p_norm, p_priority, p_pages, coalesce(nullif(p_sort, ''), 'most_relevant'), coalesce(p_params, '{}'::jsonb))
      returning id into v_id;
      v_action := 'inserted';
    elsif v_existing.status = 'pending' then
      v_pages := greatest(v_existing.pages, p_pages);
      update etsy_worker.jobs
      set priority = greatest(priority, p_priority),
          pages = v_pages,
          params = coalesce(params, '{}'::jsonb)
            || coalesce(p_params, '{}'::jsonb)
            || jsonb_build_object(
              'pages', v_pages,
              'visitListings',
                coalesce((params ->> 'visitListings') = 'true', false)
                or coalesce((p_params ->> 'visitListings') = 'true', false)
            ),
          updated_at = now()
      where id = v_existing.id
      returning id, priority into v_id, v_priority;
      v_action := 'updated';
    else
      v_id := v_existing.id;
      v_priority := v_existing.priority;
      v_pages := v_existing.pages;
      v_action := 'already_running';
    end if;
  else
    insert into etsy_worker.jobs (job_type, term, term_norm, priority, pages, sort, params)
    values (p_type, p_term, p_norm, p_priority, p_pages, coalesce(nullif(p_sort, ''), 'most_relevant'), coalesce(p_params, '{}'::jsonb))
    returning id into v_id;
    v_action := 'inserted';
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'type', p_type,
    'action', v_action,
    'subject', p_term,
    'priority', v_priority,
    'pages', v_pages
  );
end;
$fn$;

-- Search lookups must ignore other command types that happen to share text.
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
  where job_type = 'search'
    and term_norm = v_norm
    and status in ('pending', 'processing')
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
      'type', v_job.job_type,
      'job_type', v_job.job_type,
      'term', v_job.term,
      'params', coalesce(v_job.params, '{}'::jsonb),
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
  where job_type = 'search'
    and term_norm = v_norm
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
    'type', r.job_type,
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
    'params', coalesce(r.params, '{}'::jsonb),
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
      'type', r.job_type,
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
        'type', job_type,
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

create or replace function public.etsy_worker_enqueue(
  p_type text,
  p_params jsonb default '{}'::jsonb,
  p_priority integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_type text := lower(btrim(coalesce(p_type, '')));
  v_params jsonb := coalesce(p_params, '{}'::jsonb);
  v_priority integer := greatest(0, least(coalesce(p_priority, 0), 1000000));
  v_item jsonb;
  v_url text;
  v_id text;
  v_ids text[] := '{}';
  v_urls jsonb := '[]'::jsonb;
  v_joined text;
  v_shop text;
  v_pages integer;
  v_visit boolean;
  v_source text;
  v_format text;
  v_chip text;
  v_sort text;
  v_dir text;
  v_added jsonb;
  v_one jsonb;
begin
  if jsonb_typeof(v_params) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'params_must_be_object');
  end if;

  if v_type = 'search' then
    v_added := public.etsy_worker_add_terms(
      jsonb_build_array(coalesce(v_params ->> 'term', '')),
      v_priority,
      greatest(1, least(coalesce(etsy_worker.to_int(v_params ->> 'pages'), 1), 50)),
      coalesce(nullif(v_params ->> 'sort', ''), 'most_relevant')
    );
    if coalesce(v_added ->> 'ok', 'false') <> 'true' then
      return v_added;
    end if;
    v_one := v_added -> 'jobs' -> 0;
    if v_one is null or v_one ->> 'action' = 'rejected' or v_one ->> 'id' is null then
      return jsonb_build_object('ok', false, 'error', 'invalid_term');
    end if;
    return jsonb_build_object(
      'ok', true,
      'id', (v_one ->> 'id')::uuid,
      'type', 'search',
      'action', v_one ->> 'action',
      'subject', v_one ->> 'term',
      'priority', (v_one ->> 'priority')::integer
    );
  end if;

  if v_type = 'scrape-listings' then
    if jsonb_typeof(v_params -> 'urls') <> 'array' then
      return jsonb_build_object('ok', false, 'error', 'invalid_listing_url');
    end if;
    for v_item in select value from jsonb_array_elements(v_params -> 'urls')
    loop
      if jsonb_typeof(v_item) <> 'string' then
        return jsonb_build_object('ok', false, 'error', 'invalid_listing_url');
      end if;
      v_url := v_item #>> '{}';
      v_id := substring(v_url from '^https://www\.etsy\.com/listing/([0-9]{7,12})(?:[/?#].*)?$');
      if v_id is null then
        return jsonb_build_object('ok', false, 'error', 'invalid_listing_url');
      end if;
      if v_id = any(v_ids) then
        continue;
      end if;
      if cardinality(v_ids) >= 40 then
        return jsonb_build_object('ok', false, 'error', 'too_many_urls');
      end if;
      v_ids := array_append(v_ids, v_id);
      v_urls := v_urls || jsonb_build_array('https://www.etsy.com/listing/' || v_id);
    end loop;
    if cardinality(v_ids) < 1 then
      return jsonb_build_object('ok', false, 'error', 'invalid_listing_url');
    end if;
    select string_agg(id, ',' order by id) into v_joined from unnest(v_ids) as id;
    return etsy_worker.insert_command(
      'scrape-listings',
      'listings (' || cardinality(v_ids) || ')',
      'listings:' || md5(v_joined),
      v_priority,
      cardinality(v_ids),
      'most_relevant',
      jsonb_build_object('urls', v_urls),
      true
    );
  end if;

  if v_type = 'scrape-shop' then
    v_shop := etsy_worker.shop_name(coalesce(nullif(v_params ->> 'url', ''), v_params ->> 'shop'));
    if v_shop is null then
      return jsonb_build_object('ok', false, 'error', 'invalid_shop');
    end if;
    v_pages := greatest(1, least(coalesce(etsy_worker.to_int(v_params ->> 'pages'), 1), 10));
    v_visit := lower(coalesce(v_params ->> 'visitListings', 'false')) in ('true', 't', '1', 'yes');
    return etsy_worker.insert_command(
      'scrape-shop',
      v_shop,
      'shop:' || lower(v_shop),
      v_priority,
      v_pages,
      'most_relevant',
      jsonb_build_object('shop', v_shop, 'pages', v_pages, 'visitListings', v_visit),
      true
    );
  end if;

  if v_type = 'export' then
    v_source := lower(coalesce(nullif(v_params ->> 'source', ''), 'listings'));
    v_format := lower(coalesce(nullif(v_params ->> 'format', ''), 'csv'));
    if v_source not in ('listings', 'search', 'shop') then
      return jsonb_build_object('ok', false, 'error', 'invalid_source');
    end if;
    if v_format not in ('csv', 'json') then
      return jsonb_build_object('ok', false, 'error', 'invalid_format');
    end if;
    v_chip := lower(coalesce(nullif(v_params ->> 'chip', ''), 'all'));
    if v_chip not in ('all', 'in_carts', 'views', 'selling_fast') then
      v_chip := 'all';
    end if;
    v_sort := lower(coalesce(nullif(v_params ->> 'sort', ''), 'newest'));
    if v_sort not in ('newest', 'demand', 'reviews', 'first_review', 'price', 'favorites') then
      v_sort := 'newest';
    end if;
    v_dir := case when lower(coalesce(v_params ->> 'dir', 'desc')) = 'asc' then 'asc' else 'desc' end;
    return etsy_worker.insert_command(
      'export',
      'export ' || v_source,
      'export:' || gen_random_uuid()::text,
      v_priority,
      1,
      'most_relevant',
      jsonb_build_object(
        'source', v_source,
        'format', v_format,
        'q', left(btrim(coalesce(v_params ->> 'q', '')), 200),
        'demand', left(btrim(coalesce(v_params ->> 'demand', '')), 200),
        'chip', v_chip,
        'sort', v_sort,
        'dir', v_dir
      ),
      false
    );
  end if;

  if v_type = 'collection-stats' then
    return etsy_worker.insert_command(
      'collection-stats',
      'collection stats',
      'stats:' || gen_random_uuid()::text,
      v_priority,
      1,
      'most_relevant',
      '{}'::jsonb,
      false
    );
  end if;

  return jsonb_build_object('ok', false, 'error', 'unknown_job_type');
end;
$fn$;

create or replace function public.etsy_worker_upload_payload(
  p_job_id uuid,
  p_lane_name text,
  p_kind text,
  p_body jsonb,
  p_lease_seconds integer default 180
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_lane text := etsy_worker.valid_lane(p_lane_name);
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 180), 3600));
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  r etsy_worker.jobs%rowtype;
  v_count integer;
begin
  if v_lane is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_lane_name');
  end if;
  if v_kind !~ '^[a-z0-9_-]{1,40}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_kind');
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'payload_must_be_object');
  end if;
  if octet_length(p_body::text) > 1500000 then
    return jsonb_build_object('ok', false, 'error', 'payload_too_large');
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

  insert into etsy_worker.payloads (job_id, kind, body)
  values (r.id, v_kind, p_body);

  v_count := coalesce(etsy_worker.to_int(p_body ->> 'count'), r.listings_uploaded);
  update etsy_worker.jobs
  set listings_uploaded = case when v_kind in ('export', 'stats') then v_count else listings_uploaded end,
      pages_done = greatest(pages_done, 1),
      lease_expires_at = now() + make_interval(secs => v_lease),
      progress = progress || jsonb_build_object('phase', v_kind, 'rows', v_count),
      updated_at = now()
  where id = r.id
  returning listings_uploaded into v_count;

  perform etsy_worker.touch_worker(v_lane, 'running', r.id, r.term, jsonb_build_object('phase', v_kind), '');
  return jsonb_build_object('ok', true, 'kind', v_kind, 'listings_uploaded', v_count);
end;
$fn$;

create or replace function public.etsy_worker_job_status(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  r etsy_worker.jobs%rowtype;
begin
  if p_job_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_job');
  end if;
  select * into r from etsy_worker.jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return jsonb_build_object(
    'ok', true,
    'id', r.id,
    'type', r.job_type,
    'term', r.term,
    'subject', r.term,
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
    'params', coalesce(r.params, '{}'::jsonb),
    'lease_expires_at', r.lease_expires_at,
    'search_path', r.progress ->> 'search_path',
    'updated_at', r.updated_at,
    'created_at', r.created_at
  );
end;
$fn$;

create or replace function public.etsy_worker_job_results(
  p_job_id uuid,
  p_limit integer default 500,
  p_offset integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  r etsy_worker.jobs%rowtype;
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 2000));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_rows jsonb;
  v_payloads jsonb;
  v_count integer;
begin
  if p_job_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_job');
  end if;
  select * into r from etsy_worker.jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
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

  select coalesce(jsonb_agg(item order by created_at), '[]'::jsonb)
  into v_payloads
  from (
    select
      created_at,
      jsonb_build_object('id', id, 'kind', kind, 'body', body, 'created_at', created_at) as item
    from etsy_worker.payloads
    where job_id = r.id
    order by created_at
    limit 100
  ) p;

  return jsonb_build_object(
    'ok', true,
    'job', jsonb_build_object(
      'id', r.id,
      'type', r.job_type,
      'term', r.term,
      'state', r.status,
      'lane', r.claimed_by,
      'pages', r.pages,
      'pages_done', r.pages_done,
      'rows', r.listings_uploaded,
      'total_results', r.total_results,
      'last_error', r.last_error,
      'priority', r.priority,
      'params', coalesce(r.params, '{}'::jsonb)
    ),
    'listing_count', v_count,
    'returned', jsonb_array_length(v_rows),
    'offset', v_offset,
    'listings', v_rows,
    'payloads', v_payloads
  );
end;
$fn$;

create or replace function public.etsy_worker_lookup(
  p_type text,
  p_subject text
) returns jsonb
language plpgsql
security definer
set search_path = etsy_worker, public
as $fn$
declare
  v_type text := lower(btrim(coalesce(p_type, '')));
  v_norm text;
  v_shop text;
  v_id uuid;
begin
  if v_type = 'search' then
    v_norm := etsy_worker.norm_term(p_subject);
    if char_length(v_norm) < 2 then
      return jsonb_build_object('ok', false, 'error', 'invalid_term');
    end if;
  elsif v_type = 'scrape-shop' then
    v_shop := etsy_worker.shop_name(p_subject);
    if v_shop is null then
      return jsonb_build_object('ok', false, 'error', 'invalid_shop');
    end if;
    v_norm := 'shop:' || lower(v_shop);
  else
    return jsonb_build_object('ok', false, 'error', 'lookup_requires_search_or_shop');
  end if;

  select id into v_id
  from etsy_worker.jobs
  where job_type = v_type
    and term_norm = v_norm
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
    return jsonb_build_object('ok', false, 'error', 'not_found', 'type', v_type, 'subject', p_subject);
  end if;
  return public.etsy_worker_job_status(v_id);
end;
$fn$;

revoke all on function etsy_worker.stamp_command() from public, anon, authenticated;
revoke all on function etsy_worker.shop_name(text) from public, anon, authenticated;
revoke all on function etsy_worker.insert_command(text, text, text, integer, integer, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function etsy_worker.pick_job(text) from public, anon, authenticated;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'etsy_worker_add_terms(jsonb, integer, integer, text)',
    'etsy_worker_search_now(text, integer, text)',
    'etsy_worker_claim_job(text, integer)',
    'etsy_worker_term_status(text)',
    'etsy_worker_results(text, integer, integer)',
    'etsy_worker_fleet_status()',
    'etsy_worker_enqueue(text, jsonb, integer)',
    'etsy_worker_upload_payload(uuid, text, text, jsonb, integer)',
    'etsy_worker_job_status(uuid)',
    'etsy_worker_job_results(uuid, integer, integer)',
    'etsy_worker_lookup(text, text)'
  ]
  loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', fn);
  end loop;
end $$;

commit;
