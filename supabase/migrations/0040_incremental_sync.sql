-- 0040: incremental sync (Phase 2, task 10).
--
--  - The webhook inbox (webhook_events, 0025) takes thin events only: an
--    identifier and a change time (or status), never a customer's data. The
--    subscriptions ask Shopify for those fields alone (includeFields), the
--    recording function keeps only them, and a constraint refuses anything else.
--  - A delivery is recorded once per shop and webhook ID; a repeat is a no-op.
--  - The sync worker claims a shop's events (run-bound, with a lease), fetches
--    each resource's current state from Shopify by ID and writes it through the
--    ingestion functions, so out-of-order deliveries converge on Shopify's state
--    and redaction suppression applies. Failures back off exponentially; after
--    eight attempts an event is dead, kept (thin) for inspection.
--  - The daily reconcile finds resources updated since a watermark and records
--    them as events, which repairs a missed webhook through the same path.
--  - A resource deleted in Shopify is deleted here (orders with their lines,
--    refunds and returns; products with their variants, metafields and
--    inventory levels; customers).
--
-- Changes no existing rows (the inbox is empty on staging).

alter table public.webhook_events
  add column claimed_by text check (char_length(claimed_by) <= 128),
  add column claimed_at timestamptz,
  add column next_attempt_at timestamptz;
create index webhook_events_claimable_idx on public.webhook_events (shop_key, received_at)
  where status in ('received', 'failed', 'processing');

-- Thin event payloads: these keys only, scalar values only.
create or replace function public.is_thin_event_payload(p jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select jsonb_typeof(p) = 'object'
     and not exists (select 1 from jsonb_each(p) e
                      where e.key not in ('id', 'updated_at', 'created_at', 'order_id', 'inventory_item_id', 'location_id', 'admin_graphql_api_id', 'status')
                         or jsonb_typeof(e.value) not in ('string', 'number', 'null'));
$$;

create or replace function public.thin_event_payload(p jsonb)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e
   where e.key in ('id', 'updated_at', 'created_at', 'order_id', 'inventory_item_id', 'location_id', 'admin_graphql_api_id', 'status')
     and jsonb_typeof(e.value) in ('string', 'number', 'null');
$$;

alter table public.webhook_events add constraint webhook_events_thin_payload
  check (payload is null or public.is_thin_event_payload(payload));

-- Records webhook deliveries (or reconcile findings) as thin events, once each. A shop that is not open for
-- ingestion records nothing.
create or replace function public.record_sync_events(p_shop_domain text, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := public.myshopify_domain_or_null(lower(btrim(coalesce(p_shop_domain, ''))));
  v_key integer;
  v_recorded integer := 0;
begin
  if v_domain is null then raise exception 'shop_domain_invalid'; end if;
  if jsonb_typeof(coalesce(p_events, '[]')) <> 'array' or jsonb_array_length(coalesce(p_events, '[]')) > 2000 then
    raise exception 'sync_events_invalid';
  end if;
  select shop_key into v_key from public.shops where myshopify_domain = v_domain;
  if v_key is null or not public.shop_ingestion_open(v_key) then return jsonb_build_object('outcome', 'ignored', 'recorded', 0); end if;

  insert into public.webhook_events (shop_domain, shop_key, webhook_id, event_id, topic, triggered_at, payload)
  select v_domain, v_key, e.webhook_id, left(e.event_id, 255), e.topic, e.triggered_at, public.thin_event_payload(e.payload)
    from jsonb_to_recordset(coalesce(p_events, '[]')) as e(webhook_id text, event_id text, topic text, triggered_at timestamptz, payload jsonb)
   where e.webhook_id is not null and char_length(e.webhook_id) between 1 and 255
     and e.topic in ('orders/create', 'orders/updated', 'orders/cancelled', 'orders/delete', 'refunds/create',
                     'products/create', 'products/update', 'products/delete', 'customers/create', 'customers/update', 'customers/delete',
                     'inventory_levels/update', 'returns/request', 'returns/approve', 'returns/decline', 'returns/cancel',
                     'returns/close', 'returns/reopen', 'returns/process', 'returns/update')
  on conflict (shop_domain, webhook_id) do nothing;
  get diagnostics v_recorded = row_count;
  return jsonb_build_object('outcome', 'recorded', 'recorded', v_recorded, 'shop_key', v_key);
end;
$$;

-- Claims a shop's due events for one run: received, failed and due again, or held by a run that went quiet.
create or replace function public.claim_sync_events(p_shop_key integer, p_run_id text, p_limit integer default 100, p_stale_seconds integer default 900)
returns table (id uuid, topic text, payload jsonb, triggered_at timestamptz, attempts integer)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'claim_limit_invalid'; end if;
  if p_run_id is null or char_length(p_run_id) > 128 then raise exception 'run_id_invalid'; end if;
  return query
  with due as (
    select w.id as event_id from public.webhook_events w
     where w.shop_key = p_shop_key
       and ((w.status in ('received', 'failed') and coalesce(w.next_attempt_at, w.received_at) <= now())
            or (w.status = 'processing' and w.claimed_at < now() - make_interval(secs => p_stale_seconds)))
     order by w.received_at
     limit p_limit
     for update skip locked
  )
  update public.webhook_events w
     set status = 'processing', attempts = w.attempts + 1, claimed_by = p_run_id, claimed_at = now()
    from due
   where w.id = due.event_id
  returning w.id, w.topic, w.payload, w.triggered_at, w.attempts;
end;
$$;

-- Ends a run's events: processed ones drop their payload; failed ones back off (30 s doubling, at most an hour)
-- and are dead after p_max_attempts. Only the run holding an event can end it.
create or replace function public.finish_sync_events(p_run_id text, p_processed uuid[], p_failed jsonb, p_max_attempts integer default 8)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_processed integer := 0;
  v_failed integer := 0;
  v_dead integer := 0;
begin
  update public.webhook_events
     set status = 'processed', processed_at = now(), payload = null, last_error = null, claimed_by = null, claimed_at = null
   where id = any(coalesce(p_processed, '{}')) and status = 'processing' and claimed_by = p_run_id;
  get diagnostics v_processed = row_count;

  with failed as (
    select x.id, left(coalesce(x.error, 'unknown'), 2000) as error from jsonb_to_recordset(coalesce(p_failed, '[]')) as x(id uuid, error text)
  ), ended as (
    update public.webhook_events w
       set status = case when w.attempts >= p_max_attempts then 'dead' else 'failed' end,
           last_error = failed.error, claimed_by = null, claimed_at = null,
           next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, greatest(w.attempts - 1, 0)))::integer)
      from failed
     where w.id = failed.id and w.status = 'processing' and w.claimed_by = p_run_id
    returning w.status
  )
  select count(*), count(*) filter (where status = 'dead') into v_failed, v_dead from ended;
  return jsonb_build_object('processed', v_processed, 'failed', v_failed - v_dead, 'dead', v_dead);
end;
$$;

-- Shops with events to process, oldest first (for the sweep that dispatches the worker).
create or replace function public.sync_shops_due(p_limit integer default 100)
returns table (shop_key integer, shop_domain text, due integer, oldest timestamptz, dead integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select w.shop_key, s.myshopify_domain,
         (count(*) filter (where (w.status in ('received', 'failed') and coalesce(w.next_attempt_at, w.received_at) <= now())
                             or (w.status = 'processing' and w.claimed_at < now() - interval '15 minutes')))::integer,
         min(w.received_at) filter (where w.status in ('received', 'failed', 'processing')),
         (count(*) filter (where w.status = 'dead'))::integer
    from public.webhook_events w join public.shops s on s.shop_key = w.shop_key
   where w.status in ('received', 'failed', 'processing', 'dead')
   group by w.shop_key, s.myshopify_domain
  having count(*) filter (where (w.status in ('received', 'failed') and coalesce(w.next_attempt_at, w.received_at) <= now())
                            or (w.status = 'processing' and w.claimed_at < now() - interval '15 minutes')) > 0
   order by 4
   limit least(greatest(coalesce(p_limit, 100), 1), 1000);
$$;

-- Deletes resources Shopify no longer has, with what hangs off them.
create or replace function public.delete_synced_records(p_shop_key integer, p_kind text, p_ids bigint[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids bigint[] := coalesce(p_ids, '{}');
  v_deleted integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if cardinality(v_ids) > 2000 then raise exception 'ingest_batch_too_large'; end if;
  if p_kind = 'order' then
    delete from public.return_line_items rl using public.returns r
     where rl.shop_key = p_shop_key and r.shop_key = p_shop_key and rl.return_shopify_id = r.shopify_id and r.order_shopify_id = any(v_ids);
    delete from public.returns where shop_key = p_shop_key and order_shopify_id = any(v_ids);
    delete from public.orders where shop_key = p_shop_key and shopify_id = any(v_ids);
    get diagnostics v_deleted = row_count;
  elsif p_kind = 'product' then
    delete from public.inventory_levels l using public.product_variants v
     where l.shop_key = p_shop_key and v.shop_key = p_shop_key and l.inventory_item_id = v.inventory_item_id and v.product_shopify_id = any(v_ids);
    delete from public.metafields where shop_key = p_shop_key and owner_type = 'product' and owner_shopify_id = any(v_ids);
    delete from public.products where shop_key = p_shop_key and shopify_id = any(v_ids);
    get diagnostics v_deleted = row_count;
  elsif p_kind = 'customer' then
    delete from public.customers where shop_key = p_shop_key and shopify_id = any(v_ids);
    get diagnostics v_deleted = row_count;
  else
    raise exception 'record_kind_invalid';
  end if;
  return jsonb_build_object('deleted', v_deleted);
end;
$$;

-- The reconcile watermark of a domain: only ever moves forward. It leaves the checkpoint's updated_at alone,
-- which says when an import last wrote its resume point (resumableCheckpoint).
create or replace function public.save_sync_watermark(p_shop_key integer, p_domain text, p_watermark timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if p_watermark is null then raise exception 'watermark_invalid'; end if;
  insert into public.sync_checkpoints as c (shop_key, domain, watermark, updated_at)
  values (p_shop_key, p_domain, p_watermark, '-infinity')
  on conflict (shop_key, domain) do update set watermark = greatest(coalesce(c.watermark, excluded.watermark), excluded.watermark);
  return jsonb_build_object('watermark', (select watermark from public.sync_checkpoints where shop_key = p_shop_key and domain = p_domain));
end;
$$;

revoke all on function public.is_thin_event_payload(jsonb), public.thin_event_payload(jsonb),
  public.record_sync_events(text, jsonb), public.claim_sync_events(integer, text, integer, integer),
  public.finish_sync_events(text, uuid[], jsonb, integer), public.sync_shops_due(integer),
  public.delete_synced_records(integer, text, bigint[]), public.save_sync_watermark(integer, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.is_thin_event_payload(jsonb), public.thin_event_payload(jsonb),
  public.record_sync_events(text, jsonb), public.claim_sync_events(integer, text, integer, integer),
  public.finish_sync_events(text, uuid[], jsonb, integer), public.sync_shops_due(integer),
  public.delete_synced_records(integer, text, bigint[]), public.save_sync_watermark(integer, text, timestamptz)
  to service_role;
