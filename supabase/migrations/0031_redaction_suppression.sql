-- 0031: redaction suppression and the ingestion guard (Phase 2, task 2).
--
-- Decision 2026-11-18: re-imports, historical bulk operations, webhook
-- replays and retried jobs must never restore what a redaction removed.
--
--  - redaction_suppressions records each customer and order a
--    customers/redact named, as an HMAC-SHA256 digest of shop, subject type
--    and Shopify ID under a server key (REDACTION_SUPPRESSION_KEY), so the
--    list holds no usable identifier. It is keyed by the Shopify shop ID,
--    not the shop row, so it outlives a shop/redact and a reinstall: the
--    customer stays erased.
--  - Every ingestion write path (task 4 onward) calls
--    lock_shop_for_ingestion first. It admits only a shop bound to an active
--    workspace and holds a share lock on that workspace until the write
--    commits, so an uninstall, shop/redact or deletion cannot interleave
--    with it. Nothing is written for a shop that is uninstalled, pending
--    deletion or deleted.
--
-- Changes no existing rows.

create table public.redaction_suppressions (
  shopify_shop_id        bigint not null check (shopify_shop_id > 0),
  subject_type           text not null check (subject_type in ('customer', 'order')),
  subject_digest         bytea not null check (octet_length(subject_digest) = 32),
  key_version            smallint not null default 1 check (key_version > 0),
  compliance_request_id  uuid references public.compliance_requests (id),
  created_at             timestamptz not null default now(),
  primary key (shopify_shop_id, subject_type, subject_digest)
);
comment on table public.redaction_suppressions is
  'Customers and orders a customers/redact named, as keyed digests (no identifier). Ingestion never stores a suppressed subject again. Kept indefinitely, across shop/redact and reinstall.';

-- Which of the given digests are suppressed for a shop (the worker filters a batch before writing).
create or replace function public.suppressed_subjects(p_shopify_shop_id bigint, p_subject_type text, p_digests bytea[])
returns bytea[] language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(s.subject_digest), '{}')
    from public.redaction_suppressions s
   where s.shopify_shop_id = p_shopify_shop_id and s.subject_type = p_subject_type and s.subject_digest = any (coalesce(p_digests, '{}'));
$$;

-- Whether the shop may receive ingested data: bound to an active workspace.
create or replace function public.shop_ingestion_open(p_shop_key integer)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.shops s
      join public.shop_bindings b on b.shop_id = s.id and b.released_at is null
      join public.workspaces w on w.id = b.workspace_id and w.status = 'active'
     where s.shop_key = p_shop_key);
$$;

-- Called first by every ingestion write. Holds a share lock on the workspace row
-- until the caller's transaction ends, so lifecycle changes wait for the write.
create or replace function public.lock_shop_for_ingestion(p_shop_key integer)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_workspace uuid;
begin
  select w.id into v_workspace
    from public.shops s
    join public.shop_bindings b on b.shop_id = s.id and b.released_at is null
    join public.workspaces w on w.id = b.workspace_id
   where s.shop_key = p_shop_key and w.status = 'active'
     for share of w;
  if v_workspace is null then raise exception 'shop_not_ingestible' using errcode = 'P0001'; end if;
  return v_workspace;
end;
$$;

-- customers/redact also records suppressions for the customer and the orders it names.
drop function public.record_customer_compliance(text, bigint, text, text, timestamptz, bigint, bigint[]);
create function public.record_customer_compliance(
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
begin
  if p_topic not in ('customers/redact', 'customers/data_request') then raise exception 'unsupported_compliance_topic'; end if;
  insert into public.shop_lifecycle_events (topic, event_key, shopify_shop_id, shop_domain, triggered_at)
  values (p_topic, p_event_key, p_shopify_shop_id, v_domain, p_triggered_at)
  on conflict (topic, event_key) do nothing returning id into v_event;
  if v_event is null then return jsonb_build_object('outcome', 'duplicate'); end if;

  select shop_key, shopify_shop_id into v_key, v_shopify_shop from public.shops
   where (p_shopify_shop_id is not null and shopify_shop_id = p_shopify_shop_id) or myshopify_domain = public.myshopify_domain_or_null(v_domain)
   order by (shopify_shop_id = p_shopify_shop_id) desc nulls last limit 1;
  v_shopify_shop := coalesce(p_shopify_shop_id, v_shopify_shop);

  if p_topic = 'customers/redact' then
    if v_key is not null then
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
    v_status := 'completed';
    v_resolution := case when v_customers + v_orders + v_inbox > 0 then 'customer_data_redacted' else 'no_customer_data_held' end;
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
    'redacted', jsonb_build_object('customers', v_customers, 'orders', v_orders, 'inbox', v_inbox),
    'suppressed', v_suppressed);
end;
$$;

alter table public.redaction_suppressions enable row level security;
revoke all on table public.redaction_suppressions from public, anon, authenticated, service_role;
grant select on table public.redaction_suppressions to service_role;

revoke all on function public.suppressed_subjects(bigint, text, bytea[]), public.shop_ingestion_open(integer),
  public.lock_shop_for_ingestion(integer),
  public.record_customer_compliance(text, bigint, text, text, timestamptz, bigint, bigint[], bytea, bytea[], smallint)
  from public, anon, authenticated;
grant execute on function public.suppressed_subjects(bigint, text, bytea[]), public.shop_ingestion_open(integer),
  public.record_customer_compliance(text, bigint, text, text, timestamptz, bigint, bigint[], bytea, bytea[], smallint)
  to service_role;
-- lock_shop_for_ingestion is internal: only the ingestion write functions call it.
revoke all on function public.lock_shop_for_ingestion(integer) from service_role;
