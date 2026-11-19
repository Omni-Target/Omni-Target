-- 0037: customer data requests (Phase 2, task 9; decisions 4 and 5).
--
--  - customers/data_request with data held opens a compliance_exports row
--    naming the customer and the orders Shopify listed. The workflow claims
--    it, reads the customer's data page by page, writes an encrypted file to
--    private object storage, records it here and notifies the workspace owner,
--    which completes the compliance request. The owner downloads it from the
--    app for 30 days; then the file is deleted and the row keeps no identity.
--  - customers/redact (record_customer_compliance, redefined from 0031) also
--    deletes the Meta send logs for the customer's orders and withdraws any
--    export of their data: the subject is cleared at once and the file is
--    deleted by the workflow. A run that recorded nothing before the
--    withdrawal cannot record afterwards.
--  - compliance_exports_due tells the maintenance task what to do: dispatch
--    unclaimed or stalled exports, notify, expire, withdraw exports of a shop
--    or workspace being deleted, delete closed files, and escalate requests
--    approaching Shopify's 30-day deadline (10 days, 3 days, overdue).
--
-- Changes no existing rows.

create table public.compliance_exports (
  request_id           uuid primary key references public.compliance_requests (id),
  shop_domain          text not null,
  workspace_id         uuid references public.workspaces (id),
  customer_shopify_id  bigint check (customer_shopify_id > 0),
  order_ids            bigint[] not null default '{}' check (cardinality(order_ids) <= 1000),
  status               text not null default 'pending' check (status in ('pending', 'exporting', 'ready', 'expired', 'withdrawn')),
  dispatch_attempts    integer not null default 0 check (dispatch_attempts >= 0),
  dispatched_at        timestamptz,
  trigger_run_id       text check (char_length(trigger_run_id) <= 128),
  claimed_at           timestamptz,
  last_error           text check (char_length(last_error) <= 1000),
  object_key           text check (object_key ~ '^compliance-exports/[0-9a-f-]{36}\.bin$'),
  bytes                bigint check (bytes >= 0),
  sha256               text check (sha256 ~ '^[0-9a-f]{64}$'),
  key_version          smallint check (key_version > 0),
  record_counts        jsonb not null default '{}' check (jsonb_typeof(record_counts) = 'object' and pg_column_size(record_counts) <= 2048),
  created_at           timestamptz not null default now(),
  exported_at          timestamptz,
  expires_at           timestamptz,
  notified_at          timestamptz,
  first_downloaded_at  timestamptz,
  download_count       integer not null default 0 check (download_count >= 0),
  closed_at            timestamptz,
  close_reason         text check (close_reason in ('expired', 'customer_redacted', 'shop_redacted', 'workspace_deleted')),
  escalation_level     smallint not null default 0 check (escalation_level between 0 and 3),
  check ((status in ('expired', 'withdrawn')) = (closed_at is not null and close_reason is not null)),
  -- A closed export names no customer; only its file may remain until deleted.
  check (status not in ('expired', 'withdrawn') or (customer_shopify_id is null and order_ids = '{}')),
  check (status <> 'ready' or (object_key is not null and exported_at is not null and expires_at is not null))
);
create index compliance_exports_open_idx on public.compliance_exports (status) where status in ('pending', 'exporting', 'ready');
create index compliance_exports_files_idx on public.compliance_exports (closed_at) where object_key is not null and status in ('expired', 'withdrawn');
create index compliance_exports_shop_idx on public.compliance_exports (shop_domain);

-- The export a run works on: claimed by it, still exporting. Internal.
create or replace function public.compliance_export_for_run(p_request uuid, p_run_id text)
returns public.compliance_exports language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.compliance_exports where request_id = p_request and status = 'exporting' and trigger_run_id = p_run_id;
$$;

create or replace function public.mark_compliance_export_dispatched(p_request uuid, p_run_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.compliance_exports
     set dispatch_attempts = dispatch_attempts + 1, dispatched_at = now(), trigger_run_id = coalesce(trigger_run_id, p_run_id)
   where request_id = p_request and status in ('pending', 'exporting');
  return jsonb_build_object('outcome', case when found then 'dispatched' else 'closed' end);
end;
$$;

-- A run claims the export before reading anything. A finished or withdrawn export is never exported again; a
-- live run is not doubled; a run that went quiet for p_stale_seconds can be taken over.
create or replace function public.claim_compliance_export(p_request uuid, p_run_id text, p_stale_seconds integer default 900)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.compliance_exports;
  v_request public.compliance_requests;
  v_shop public.shops;
begin
  select * into v_row from public.compliance_exports where request_id = p_request for update;
  if not found then return jsonb_build_object('outcome', 'missing'); end if;
  if v_row.status in ('ready', 'expired', 'withdrawn') then return jsonb_build_object('outcome', v_row.status); end if;
  if v_row.status = 'exporting' and v_row.trigger_run_id is distinct from p_run_id
     and v_row.claimed_at > now() - make_interval(secs => p_stale_seconds) then
    return jsonb_build_object('outcome', 'busy');
  end if;
  select * into v_shop from public.shops where myshopify_domain = v_row.shop_domain;
  if v_shop.id is null then return jsonb_build_object('outcome', 'shop_missing'); end if;
  select * into v_request from public.compliance_requests where id = p_request;
  update public.compliance_exports set status = 'exporting', trigger_run_id = p_run_id, claimed_at = now(), last_error = null
   where request_id = p_request;
  return jsonb_build_object('outcome', 'claimed', 'shop_key', v_shop.shop_key, 'shop_domain', v_shop.myshopify_domain,
    'shopify_shop_id', v_shop.shopify_shop_id, 'customer_id', v_row.customer_shopify_id, 'order_ids', to_jsonb(v_row.order_ids),
    'received_at', v_request.received_at, 'due_at', v_request.due_at);
end;
$$;

-- The customer's facts, for the run holding the export.
create or replace function public.compliance_export_customer(p_request uuid, p_run_id text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_row public.compliance_exports := public.compliance_export_for_run(p_request, p_run_id);
  v_key integer;
begin
  if v_row.request_id is null then raise exception 'export_not_claimed'; end if;
  select shop_key into v_key from public.shops where myshopify_domain = v_row.shop_domain;
  return (select to_jsonb(c) - 'shop_key' - 'synced_at' from public.customers c
           where c.shop_key = v_key and c.shopify_id = v_row.customer_shopify_id);
end;
$$;

-- The customer's orders (theirs, and those Shopify named) with lines, refunds and returns, a page at a time.
create or replace function public.compliance_export_orders(p_request uuid, p_run_id text, p_after bigint default 0, p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_row public.compliance_exports := public.compliance_export_for_run(p_request, p_run_id);
  v_key integer;
  v_page jsonb;
  v_last bigint;
  v_count integer;
begin
  if v_row.request_id is null then raise exception 'export_not_claimed'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'export_page_invalid'; end if;
  select shop_key into v_key from public.shops where myshopify_domain = v_row.shop_domain;

  with page as (
    select o.* from public.orders o
     where o.shop_key = v_key and o.shopify_id > coalesce(p_after, 0)
       and ((v_row.customer_shopify_id is not null and o.customer_shopify_id = v_row.customer_shopify_id) or o.shopify_id = any(v_row.order_ids))
     order by o.shopify_id limit p_limit
  )
  select coalesce(jsonb_agg(
           (to_jsonb(p) - 'shop_key' - 'synced_at') || jsonb_build_object(
             'line_items', coalesce((select jsonb_agg(to_jsonb(li) - 'shop_key' order by li.shopify_id) from public.order_line_items li
                                      where li.shop_key = v_key and li.order_shopify_id = p.shopify_id), '[]'),
             'refunds', coalesce((select jsonb_agg(to_jsonb(r) - 'shop_key' - 'synced_at' order by r.shopify_id) from public.refunds r
                                   where r.shop_key = v_key and r.order_shopify_id = p.shopify_id), '[]'),
             'returns', coalesce((select jsonb_agg((to_jsonb(rt) - 'shop_key' - 'synced_at') || jsonb_build_object(
                                     'line_items', coalesce((select jsonb_agg(to_jsonb(rl) - 'shop_key' order by rl.shopify_id) from public.return_line_items rl
                                                              where rl.shop_key = v_key and rl.return_shopify_id = rt.shopify_id), '[]'))
                                     order by rt.shopify_id)
                                   from public.returns rt where rt.shop_key = v_key and rt.order_shopify_id = p.shopify_id), '[]'))
           order by p.shopify_id), '[]'),
         max(p.shopify_id), count(*)
    into v_page, v_last, v_count
    from page p;

  return jsonb_build_object('orders', v_page, 'next_after', case when v_count < p_limit then null else v_last end);
end;
$$;

-- Records held about the customer's orders outside the commerce mirror: Meta send logs, and webhook payloads
-- still waiting in the inbox. Bounded.
create or replace function public.compliance_export_related(p_request uuid, p_run_id text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_row public.compliance_exports := public.compliance_export_for_run(p_request, p_run_id);
  v_key integer;
  v_orders text[];
begin
  if v_row.request_id is null then raise exception 'export_not_claimed'; end if;
  select shop_key into v_key from public.shops where myshopify_domain = v_row.shop_domain;
  select coalesce(array_agg(distinct x::text), '{}') into v_orders
    from (select o.shopify_id as x from public.orders o
           where o.shop_key = v_key and v_row.customer_shopify_id is not null and o.customer_shopify_id = v_row.customer_shopify_id
          union select unnest(v_row.order_ids)) s;

  return jsonb_build_object(
    'meta_conversion_events', coalesce((
      select jsonb_agg(jsonb_build_object('order_id', e.shopify_order_id, 'event_type', e.event_type, 'sent_at', e.event_sent_at,
                                          'value', e.order_value, 'currency', e.currency, 'status', e.status) order by e.event_sent_at)
        from (select * from public.capi_events where shop_domain = v_row.shop_domain and shopify_order_id = any(v_orders) limit 1000) e), '[]'),
    'pending_webhook_payloads', coalesce((
      select jsonb_agg(jsonb_build_object('topic', w.topic, 'received_at', w.received_at, 'payload', w.payload) order by w.received_at)
        from (select * from public.webhook_events
               where shop_domain = v_row.shop_domain and payload is not null
                 and ((v_row.customer_shopify_id is not null
                       and (payload -> 'customer' ->> 'id' = v_row.customer_shopify_id::text
                            or (topic like 'customers/%' and payload ->> 'id' = v_row.customer_shopify_id::text)))
                      or (topic like 'orders/%' and payload ->> 'id' = any(v_orders)))
               limit 200) w), '[]'));
end;
$$;

-- The file is written: the export is ready for 30 days. Refused (and the caller deletes its file) when the
-- export was withdrawn or taken over meanwhile.
create or replace function public.record_compliance_export(p_request uuid, p_run_id text, p_object_key text, p_bytes bigint,
  p_sha256 text, p_key_version smallint, p_counts jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.compliance_exports;
  v_owner text;
begin
  select * into v_row from public.compliance_exports where request_id = p_request for update;
  if not found then return jsonb_build_object('outcome', 'missing'); end if;
  if v_row.status <> 'exporting' or v_row.trigger_run_id is distinct from p_run_id then
    return jsonb_build_object('outcome', case when v_row.status = 'exporting' then 'lost' else v_row.status end);
  end if;
  update public.compliance_exports
     set status = 'ready', object_key = p_object_key, bytes = p_bytes, sha256 = p_sha256, key_version = p_key_version,
         record_counts = coalesce(p_counts, '{}'), exported_at = now(), expires_at = now() + interval '30 days'
   where request_id = p_request
  returning * into v_row;
  select w.owner_clerk_user_id into v_owner from public.workspaces w where w.id = v_row.workspace_id and w.deleted_at is null;
  return jsonb_build_object('outcome', 'ready', 'owner_clerk_user_id', v_owner, 'shop_domain', v_row.shop_domain, 'expires_at', v_row.expires_at);
end;
$$;

-- An export run failed: back to pending for the next dispatch (only by the run holding it).
create or replace function public.fail_compliance_export(p_request uuid, p_run_id text, p_error text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.compliance_exports set status = 'pending', last_error = left(p_error, 1000), claimed_at = null
   where request_id = p_request and status = 'exporting' and trigger_run_id = p_run_id;
  return jsonb_build_object('outcome', case when found then 'pending' else 'not_owned' end);
end;
$$;

-- The owner has been told the export is ready: the data has been provided, and the request is complete.
create or replace function public.mark_compliance_export_notified(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.compliance_exports set notified_at = coalesce(notified_at, now()) where request_id = p_request and status = 'ready';
  if not found then return jsonb_build_object('outcome', 'not_ready'); end if;
  update public.compliance_requests set status = 'completed', resolution = 'customer_data_provided', completed_at = now()
   where id = p_request and status <> 'completed';
  update public.shop_lifecycle_events e set outcome = 'customer_data_provided'
    from public.compliance_requests r where r.id = p_request and e.id = r.lifecycle_event_id;
  return jsonb_build_object('outcome', 'notified');
end;
$$;

-- Whom to tell that a ready export is waiting: the owner of its workspace.
create or replace function public.compliance_export_owner(p_request uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('status', e.status, 'shop_domain', e.shop_domain, 'expires_at', e.expires_at,
                            'owner_clerk_user_id', w.owner_clerk_user_id)
    from public.compliance_exports e left join public.workspaces w on w.id = e.workspace_id and w.deleted_at is null
   where e.request_id = p_request;
$$;

-- Who may receive an export: the owner of the export's workspace. Returns what the download needs and counts
-- the download; anything else looks like a missing export.
create or replace function public.authorize_compliance_download(p_request uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.compliance_exports;
begin
  select e.* into v_row from public.compliance_exports e join public.workspaces w on w.id = e.workspace_id
   where e.request_id = p_request and e.status = 'ready' and e.expires_at > now()
     and w.owner_clerk_user_id = p_actor and w.deleted_at is null and w.deletion_requested_at is null
     for update of e;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  update public.compliance_exports set download_count = download_count + 1, first_downloaded_at = coalesce(first_downloaded_at, now())
   where request_id = p_request;
  return jsonb_build_object('outcome', 'authorized', 'object_key', v_row.object_key, 'key_version', v_row.key_version,
    'sha256', v_row.sha256, 'bytes', v_row.bytes, 'customer_id', v_row.customer_shopify_id, 'shop_domain', v_row.shop_domain);
end;
$$;

-- A workspace's data requests, for its owner.
create or replace function public.compliance_exports_for_owner(p_actor text, p_workspace uuid)
returns table (request_id uuid, status text, customer_shopify_id bigint, order_count integer, received_at timestamptz,
               due_at timestamptz, exported_at timestamptz, expires_at timestamptz, download_count integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.request_id, e.status, e.customer_shopify_id, cardinality(e.order_ids), r.received_at, r.due_at, e.exported_at, e.expires_at,
         e.download_count
    from public.compliance_exports e
    join public.compliance_requests r on r.id = e.request_id
    join public.workspaces w on w.id = e.workspace_id
   where e.workspace_id = p_workspace and w.owner_clerk_user_id = p_actor and w.deleted_at is null
   order by r.received_at desc
   limit 50;
$$;

-- Closes an export: expired after 30 days, or withdrawn when its shop or workspace is being deleted. The subject
-- is cleared at once; the file, if any, stays named until compliance_export_file_deleted.
create or replace function public.close_compliance_export(p_request uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_reason is null or p_reason not in ('expired', 'shop_redacted', 'workspace_deleted', 'customer_redacted') then
    raise exception 'close_reason_invalid';
  end if;
  update public.compliance_exports
     set status = case when p_reason = 'expired' then 'expired' else 'withdrawn' end, close_reason = p_reason, closed_at = now(),
         customer_shopify_id = null, order_ids = '{}'
   where request_id = p_request and status in ('pending', 'exporting', 'ready')
     and (p_reason <> 'expired' or (status = 'ready' and expires_at <= now()));
  return jsonb_build_object('outcome', case when found then 'closed' else 'unchanged' end);
end;
$$;

create or replace function public.compliance_export_file_deleted(p_request uuid, p_object_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.compliance_exports set object_key = null
   where request_id = p_request and object_key = p_object_key and status in ('expired', 'withdrawn');
  return jsonb_build_object('outcome', case when found then 'deleted' else 'unchanged' end);
end;
$$;

-- Escalation only ever rises (1: 10 days left, 2: 3 days left, 3: overdue).
create or replace function public.mark_compliance_escalated(p_request uuid, p_level smallint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.compliance_exports set escalation_level = p_level where request_id = p_request and escalation_level < p_level;
  return jsonb_build_object('outcome', case when found then 'escalated' else 'unchanged' end);
end;
$$;

-- What the maintenance task does next, one row per action: withdrawals first, then file deletions,
-- escalations, expiries, notifications and dispatches.
create or replace function public.compliance_exports_due(p_stale_seconds integer default 900, p_max_dispatches integer default 10,
  p_limit integer default 200)
returns table (request_id uuid, shop_domain text, action text, reason text, object_key text, due_at timestamptz, level smallint)
language sql stable security definer set search_path = public, pg_temp as $$
  with open_exports as (
    select e.*, r.due_at as request_due_at, r.status as request_status, w.deleted_at, w.deletion_requested_at,
           exists (select 1 from public.compliance_requests s where s.topic = 'shop/redact' and s.shop_domain = e.shop_domain
                    and s.received_at >= e.created_at) as shop_redacted
      from public.compliance_exports e
      join public.compliance_requests r on r.id = e.request_id
      left join public.workspaces w on w.id = e.workspace_id
  ), actions as (
    select request_id, shop_domain, 'withdraw' as action,
           case when shop_redacted then 'shop_redacted' else 'workspace_deleted' end as reason,
           null::text as object_key, request_due_at, null::smallint as level
      from open_exports
     where status in ('pending', 'exporting', 'ready') and (shop_redacted or deleted_at is not null or deletion_requested_at is not null)
    union all
    select request_id, shop_domain, 'delete_file', close_reason, object_key, request_due_at, null
      from open_exports where status in ('expired', 'withdrawn') and object_key is not null
    union all
    select request_id, shop_domain, 'escalate', null, null, request_due_at,
           (case when request_due_at <= now() then 3 when request_due_at <= now() + interval '3 days' then 2 else 1 end)::smallint
      from open_exports
     where request_status <> 'completed' and status in ('pending', 'exporting', 'ready')
       and request_due_at <= now() + interval '10 days'
       and escalation_level < case when request_due_at <= now() then 3 when request_due_at <= now() + interval '3 days' then 2 else 1 end
    union all
    select request_id, shop_domain, 'expire', 'expired', object_key, request_due_at, null
      from open_exports where status = 'ready' and expires_at <= now()
    union all
    select request_id, shop_domain, 'notify', null, null, request_due_at, null
      from open_exports where status = 'ready' and notified_at is null and expires_at > now()
       and not shop_redacted and deleted_at is null and deletion_requested_at is null
    union all
    select request_id, shop_domain, 'dispatch', null, null, request_due_at, null
      from open_exports
     where not shop_redacted and deleted_at is null and deletion_requested_at is null and dispatch_attempts < p_max_dispatches
       and ((status = 'pending' and (dispatched_at is null or dispatched_at < now() - make_interval(secs => p_stale_seconds)))
            or (status = 'exporting' and claimed_at < now() - make_interval(secs => p_stale_seconds)))
  )
  select request_id, shop_domain, action, reason, object_key, request_due_at, level from actions
   order by case action when 'withdraw' then 0 when 'delete_file' then 1 when 'escalate' then 2 when 'expire' then 3
                        when 'notify' then 4 else 5 end, request_due_at
   limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

-- 0031's record_customer_compliance, with the Meta logs, exports and export requests above.
create or replace function public.record_customer_compliance(
  p_topic text, p_shopify_shop_id bigint, p_domain text, p_event_key text, p_triggered_at timestamptz,
  p_customer_shopify_id bigint default null, p_order_ids bigint[] default null,
  p_customer_digest bytea default null, p_order_digests bytea[] default null, p_key_version smallint default 1
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := lower(btrim(coalesce(p_domain, '')));
  v_orders_named bigint[] := coalesce(p_order_ids, '{}');
  v_event bigint;
  v_request uuid;
  v_key integer;
  v_shopify_shop bigint := p_shopify_shop_id;
  v_customers integer := 0;
  v_orders integer := 0;
  v_inbox integer := 0;
  v_suppressed integer := 0;
  v_held boolean := false;
  v_status text;
  v_resolution text;
  v_shop_id uuid;
  v_customer_orders bigint[] := '{}';
  v_meta integer := 0;
  v_withdrawn integer := 0;
begin
  if p_topic not in ('customers/redact', 'customers/data_request') then raise exception 'unsupported_compliance_topic'; end if;
  insert into public.shop_lifecycle_events (topic, event_key, shopify_shop_id, shop_domain, triggered_at)
  values (p_topic, p_event_key, p_shopify_shop_id, v_domain, p_triggered_at)
  on conflict (topic, event_key) do nothing returning id into v_event;
  if v_event is null then return jsonb_build_object('outcome', 'duplicate'); end if;

  select id, shop_key, shopify_shop_id into v_shop_id, v_key, v_shopify_shop from public.shops
   where (p_shopify_shop_id is not null and shopify_shop_id = p_shopify_shop_id) or myshopify_domain = public.myshopify_domain_or_null(v_domain)
   order by (shopify_shop_id = p_shopify_shop_id) desc nulls last limit 1;
  v_shopify_shop := coalesce(p_shopify_shop_id, v_shopify_shop);

  if p_topic = 'customers/redact' then
    if v_key is not null then
      v_customer_orders := array(select shopify_id from public.orders where shop_key = v_key and customer_shopify_id = p_customer_shopify_id);
      delete from public.customers where shop_key = v_key and shopify_id = p_customer_shopify_id;
      get diagnostics v_customers = row_count;
      update public.orders
         set customer_shopify_id = null, ship_city = null, ship_city_raw = null, ship_province_code = null
       where shop_key = v_key and (customer_shopify_id = p_customer_shopify_id or shopify_id = any(v_orders_named))
         and (customer_shopify_id is not null or ship_city is not null or ship_city_raw is not null or ship_province_code is not null);
      get diagnostics v_orders = row_count;
    end if;
    -- Inbox payloads about the customer, or carrying one of the named orders, are dropped unprocessed.
    update public.webhook_events
       set payload = null, status = 'ignored', processed_at = now(), last_error = 'customer_redacted'
     where shop_domain = v_domain and payload is not null
       and ((p_customer_shopify_id is not null and (payload -> 'customer' ->> 'id' = p_customer_shopify_id::text
                                                    or (topic like 'customers/%' and payload ->> 'id' = p_customer_shopify_id::text)))
            or (topic like 'orders/%' and payload ->> 'id' = any (v_orders_named::text[])));
    get diagnostics v_inbox = row_count;
    -- Meta send logs for the customer's orders, and any export of their data (0037): its file is deleted by the workflow.
    delete from public.capi_events where shop_domain = v_domain and shopify_order_id = any ((v_customer_orders || v_orders_named)::text[]);
    get diagnostics v_meta = row_count;
    update public.compliance_exports
       set status = 'withdrawn', close_reason = 'customer_redacted', closed_at = now(), customer_shopify_id = null, order_ids = '{}'
     where shop_domain = v_domain and status in ('pending', 'exporting', 'ready')
       and ((p_customer_shopify_id is not null and customer_shopify_id = p_customer_shopify_id) or order_ids && v_orders_named);
    get diagnostics v_withdrawn = row_count;
    v_status := 'completed';
    v_resolution := case when v_customers + v_orders + v_inbox + v_meta + v_withdrawn > 0 then 'customer_data_redacted' else 'no_customer_data_held' end;
  else
    v_held := v_key is not null and (
      exists (select 1 from public.customers where shop_key = v_key and shopify_id = p_customer_shopify_id)
      or exists (select 1 from public.orders where shop_key = v_key
                  and (customer_shopify_id = p_customer_shopify_id or (shopify_id = any(v_orders_named) and customer_shopify_id is not null))));
    v_status := case when v_held then 'open' else 'completed' end;
    v_resolution := case when v_held then null else 'no_customer_data_held' end;
  end if;

  update public.shop_lifecycle_events set outcome = coalesce(v_resolution, 'customer_data_held') where id = v_event;
  insert into public.compliance_requests (lifecycle_event_id, topic, shopify_shop_id, shop_domain, received_at, due_at, status, resolution, completed_at)
  values (v_event, p_topic, p_shopify_shop_id, v_domain, now(), now() + interval '30 days', v_status, v_resolution,
          case when v_status = 'completed' then now() end)
  returning id into v_request;

  -- Data held: the export the workflow fulfils, for the shop's current workspace (0037).
  if p_topic = 'customers/data_request' and v_held then
    insert into public.compliance_exports (request_id, shop_domain, workspace_id, customer_shopify_id, order_ids)
    values (v_request, v_domain,
            (select b.workspace_id from public.shop_bindings b where b.shop_id = v_shop_id and b.released_at is null order by b.bound_at desc limit 1),
            p_customer_shopify_id, v_orders_named[1:1000]);
  end if;

  -- Suppressions are recorded whether or not any data was held: a later import must not bring it in.
  if p_topic = 'customers/redact' and v_shopify_shop is not null then
    insert into public.redaction_suppressions (shopify_shop_id, subject_type, subject_digest, key_version, compliance_request_id)
    select v_shopify_shop, d.subject_type, d.digest, coalesce(p_key_version, 1), v_request
      from (select 'customer' as subject_type, p_customer_digest as digest
            union all select 'order', unnest(coalesce(p_order_digests, '{}'))) d
     where d.digest is not null
    on conflict do nothing;
    get diagnostics v_suppressed = row_count;
  end if;

  return jsonb_build_object('outcome', v_status, 'compliance_request_id', v_request, 'resolution', v_resolution,
    'redacted', jsonb_build_object('customers', v_customers, 'orders', v_orders, 'inbox', v_inbox, 'meta_events', v_meta, 'exports_withdrawn', v_withdrawn),
    'suppressed', v_suppressed);
end;
$$;

alter table public.compliance_exports enable row level security;
revoke all on table public.compliance_exports from public, anon, authenticated, service_role;
grant select on table public.compliance_exports to service_role;

revoke all on function public.compliance_export_for_run(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.mark_compliance_export_dispatched(uuid, text), public.claim_compliance_export(uuid, text, integer),
  public.compliance_export_customer(uuid, text), public.compliance_export_orders(uuid, text, bigint, integer),
  public.compliance_export_related(uuid, text),
  public.record_compliance_export(uuid, text, text, bigint, text, smallint, jsonb), public.fail_compliance_export(uuid, text, text),
  public.mark_compliance_export_notified(uuid), public.compliance_export_owner(uuid), public.authorize_compliance_download(uuid, text),
  public.compliance_exports_for_owner(text, uuid), public.close_compliance_export(uuid, text),
  public.compliance_export_file_deleted(uuid, text), public.mark_compliance_escalated(uuid, smallint),
  public.compliance_exports_due(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.mark_compliance_export_dispatched(uuid, text), public.claim_compliance_export(uuid, text, integer),
  public.compliance_export_customer(uuid, text), public.compliance_export_orders(uuid, text, bigint, integer),
  public.compliance_export_related(uuid, text),
  public.record_compliance_export(uuid, text, text, bigint, text, smallint, jsonb), public.fail_compliance_export(uuid, text, text),
  public.mark_compliance_export_notified(uuid), public.compliance_export_owner(uuid), public.authorize_compliance_download(uuid, text),
  public.compliance_exports_for_owner(text, uuid), public.close_compliance_export(uuid, text),
  public.compliance_export_file_deleted(uuid, text), public.mark_compliance_escalated(uuid, smallint),
  public.compliance_exports_due(integer, integer, integer)
  to service_role;
