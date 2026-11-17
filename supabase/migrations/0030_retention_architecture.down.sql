-- Reverses 0030. The monthly summaries, cohort outcomes and product sale dates
-- are discarded; they are derived, and can be rebuilt from the order lines
-- while none has been pruned (no pruning exists). customers/redact goes back
-- to 0018's behaviour, which holds only while the commerce mirror is empty.

drop function public.record_customer_compliance(text, bigint, text, text, timestamptz, bigint, bigint[]);
create or replace function public.record_customer_compliance(p_topic text, p_shopify_shop_id bigint, p_domain text, p_event_key text, p_triggered_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event bigint;
  v_request uuid;
begin
  if p_topic not in ('customers/redact', 'customers/data_request') then raise exception 'unsupported_compliance_topic'; end if;
  insert into public.shop_lifecycle_events (topic, event_key, shopify_shop_id, shop_domain, triggered_at, outcome)
  values (p_topic, p_event_key, p_shopify_shop_id, lower(btrim(coalesce(p_domain, ''))), p_triggered_at, 'no_customer_data_held')
  on conflict (topic, event_key) do nothing returning id into v_event;
  if v_event is null then return jsonb_build_object('outcome', 'duplicate'); end if;
  insert into public.compliance_requests (lifecycle_event_id, topic, shopify_shop_id, shop_domain, received_at, due_at, status, resolution, completed_at)
  values (v_event, p_topic, p_shopify_shop_id, lower(btrim(coalesce(p_domain, ''))), now(), now() + interval '30 days',
          'completed', 'no_customer_data_held', now())
  returning id into v_request;
  return jsonb_build_object('outcome', 'completed', 'compliance_request_id', v_request);
end;
$$;
revoke all on function public.record_customer_compliance(text, bigint, text, text, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.record_customer_compliance(text, bigint, text, text, timestamptz) to service_role;

-- 0029's helpers.
create or replace function public.delete_shop_synced_data(p_domain text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_domain text := public.normalize_shop_host(p_domain);
  v_key integer;
begin
  if v_domain is null then return; end if;
  select shop_key into v_key from public.shops where myshopify_domain = v_domain;
  delete from public.webhook_events where shop_domain = v_domain or (v_key is not null and shop_key = v_key);
  if v_key is null then return; end if;
  delete from public.product_metrics where shop_key = v_key;
  delete from public.store_metrics where shop_key = v_key;
  delete from public.sync_checkpoints where shop_key = v_key;
  delete from public.sync_runs where shop_key = v_key;
  delete from public.return_line_items where shop_key = v_key;
  delete from public.returns where shop_key = v_key;
  delete from public.refunds where shop_key = v_key;
  delete from public.order_line_items where shop_key = v_key;
  delete from public.orders where shop_key = v_key;
  delete from public.customers where shop_key = v_key;
  delete from public.inventory_levels where shop_key = v_key;
  delete from public.inventory_locations where shop_key = v_key;
  delete from public.product_variants where shop_key = v_key;
  delete from public.products where shop_key = v_key;
  delete from public.metafields where shop_key = v_key;
  delete from public.metaobjects where shop_key = v_key;
  delete from public.metaobject_definitions where shop_key = v_key;
  delete from public.shop_settings where shop_key = v_key;
  delete from public.shop_access where shop_key = v_key;
end;
$$;

create or replace function public.shop_synced_row_count(p_domain text)
returns bigint language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_domain text := public.normalize_shop_host(p_domain);
  v_key integer;
  v_inbox bigint;
begin
  if v_domain is null then return 0; end if;
  select shop_key into v_key from public.shops where myshopify_domain = v_domain;
  select count(*) into v_inbox from public.webhook_events where shop_domain = v_domain or (v_key is not null and shop_key = v_key);
  if v_key is null then return v_inbox; end if;
  return v_inbox
       + (select count(*) from public.product_metrics where shop_key = v_key)
       + (select count(*) from public.store_metrics where shop_key = v_key)
       + (select count(*) from public.sync_checkpoints where shop_key = v_key)
       + (select count(*) from public.sync_runs where shop_key = v_key)
       + (select count(*) from public.products where shop_key = v_key)
       + (select count(*) from public.product_variants where shop_key = v_key)
       + (select count(*) from public.inventory_locations where shop_key = v_key)
       + (select count(*) from public.inventory_levels where shop_key = v_key)
       + (select count(*) from public.customers where shop_key = v_key)
       + (select count(*) from public.orders where shop_key = v_key)
       + (select count(*) from public.order_line_items where shop_key = v_key)
       + (select count(*) from public.refunds where shop_key = v_key)
       + (select count(*) from public.returns where shop_key = v_key)
       + (select count(*) from public.return_line_items where shop_key = v_key)
       + (select count(*) from public.metafields where shop_key = v_key)
       + (select count(*) from public.metaobject_definitions where shop_key = v_key)
       + (select count(*) from public.metaobjects where shop_key = v_key)
       + (select count(*) from public.shop_settings where shop_key = v_key)
       + (select count(*) from public.shop_access where shop_key = v_key);
end;
$$;
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;

drop function if exists public.retention_status(integer);
drop function if exists public.refresh_monthly_aggregates(integer, date, date, integer);
drop table if exists public.cohort_monthly_outcomes;
drop table if exists public.store_monthly_metrics;
drop table if exists public.product_monthly_metrics;

comment on table public.customers is null;
alter table public.customers drop column if exists last_order_at;
alter table public.products drop constraint if exists products_sale_dates;
alter table public.products drop column if exists last_sold_at, drop column if exists first_sold_at;
