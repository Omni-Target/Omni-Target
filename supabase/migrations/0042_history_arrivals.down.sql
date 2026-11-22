-- Reverts 0042: the functions as 0035 and 0036 left them, then the arrivals.
drop function public.apply_history_arrivals(integer, jsonb, jsonb, jsonb, jsonb, integer);
drop function public.history_month_closed_at(integer, date, timestamptz, integer);

create or replace function public.summarise_history_month(p_import uuid, p_run_id text, p_month date, p_calc_version integer default 1)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop_key integer;
  v_start timestamptz;
  v_from timestamptz := date_trunc('month', p_month);
  v_to timestamptz := date_trunc('month', p_month) + interval '1 month';
  v_products integer := 0;
  v_store integer := 0;
begin
  select s.shop_key, coalesce(i.window_start, public.retention_window_start()) into v_shop_key, v_start
    from public.shop_imports i join public.shops s on s.id = i.shop_id
   where i.id = p_import and i.status = 'running' and i.trigger_run_id = p_run_id
     for key share of i;
  if v_shop_key is null then raise exception 'import_not_running'; end if;
  if v_to > v_start then raise exception 'month_inside_retained_window'; end if;
  perform public.lock_shop_for_ingestion(v_shop_key);

  with firsts as (
    select customer_digest, min(processed_at) as first_at from public.history_stage_orders
     where import_id = p_import and customer_digest is not null and not is_test and not cancelled group by 1
  ), orders as (
    select o.*, (o.customer_digest is not null and f.first_at = o.processed_at) as first_order
      from public.history_stage_orders o left join firsts f on f.customer_digest = o.customer_digest
     where o.import_id = p_import and o.processed_at >= v_from and o.processed_at < v_to and not o.is_test and not o.cancelled
  )
  insert into public.product_monthly_metrics (shop_key, product_shopify_id, month, calc_version, currency, orders, units, gross_sales, discounts,
    refunded_units, returned_units, customers, first_time_customers, finalized_at)
  select v_shop_key, l.product_shopify_id, v_from::date, p_calc_version, max(o.currency), count(distinct o.order_shopify_id), sum(l.quantity),
         sum(l.gross), sum(l.discount), sum(l.refunded), 0, count(distinct o.customer_digest),
         count(distinct o.customer_digest) filter (where o.first_order), now()
    from public.history_stage_lines l join orders o on o.order_shopify_id = l.order_shopify_id
   where l.import_id = p_import and l.product_shopify_id is not null
   group by l.product_shopify_id
  having count(distinct o.order_shopify_id) > 0 or sum(l.quantity) > 0 or sum(l.refunded) > 0
  on conflict do nothing;
  get diagnostics v_products = row_count;

  with firsts as (
    select customer_digest, min(processed_at) as first_at from public.history_stage_orders
     where import_id = p_import and customer_digest is not null and not is_test and not cancelled group by 1
  ), orders as (
    select o.*, (o.customer_digest is not null and f.first_at = o.processed_at) as first_order
      from public.history_stage_orders o left join firsts f on f.customer_digest = o.customer_digest
     where o.import_id = p_import and o.processed_at >= v_from and o.processed_at < v_to and not o.is_test and not o.cancelled
  )
  insert into public.store_monthly_metrics (shop_key, month, calc_version, currency, orders, units, subtotal, total_discounts, total_tax,
    total_shipping, total_price, total_refunded, customers, new_customers, finalized_at)
  select v_shop_key, v_from::date, p_calc_version, max(o.currency), count(*),
         coalesce((select sum(l.quantity) from public.history_stage_lines l where l.import_id = p_import
                    and l.order_shopify_id in (select order_shopify_id from orders)), 0),
         sum(o.subtotal), sum(o.total_discounts), sum(o.total_tax), sum(o.total_shipping), sum(o.total_price), sum(o.total_refunded),
         count(distinct o.customer_digest), count(distinct o.customer_digest) filter (where o.first_order), now()
    from orders o
  having count(*) > 0
  on conflict do nothing;
  get diagnostics v_store = row_count;

  return jsonb_build_object('product_months', v_products, 'store_months', v_store);
end;
$$;

create or replace function public.store_months_effective(p_shop_key integer, p_from date, p_to date, p_calc_version integer default 1)
returns table (month date, currency text, orders integer, units integer, subtotal numeric, total_discounts numeric, total_tax numeric,
               total_shipping numeric, total_price numeric, total_refunded numeric, customers integer, new_customers integer,
               final boolean, adjustments integer)
language sql stable security definer set search_path = public, pg_temp as $$
  with adjusted as (
    select month, max(currency) as currency, sum(orders) as orders, sum(units) as units, sum(subtotal) as subtotal,
           sum(total_discounts) as total_discounts, sum(total_tax) as total_tax, sum(total_shipping) as total_shipping,
           sum(total_price) as total_price, sum(total_refunded) as total_refunded, count(*) as n
      from public.store_monthly_adjustments
     where shop_key = p_shop_key and calc_version = p_calc_version and month between date_trunc('month', p_from)::date and p_to
     group by 1
  )
  select m.month, m.currency, (m.orders + coalesce(a.orders, 0))::integer, (m.units + coalesce(a.units, 0))::integer,
         m.subtotal + coalesce(a.subtotal, 0), m.total_discounts + coalesce(a.total_discounts, 0), m.total_tax + coalesce(a.total_tax, 0),
         m.total_shipping + coalesce(a.total_shipping, 0), m.total_price + coalesce(a.total_price, 0),
         m.total_refunded + coalesce(a.total_refunded, 0), m.customers, m.new_customers, m.finalized_at is not null, coalesce(a.n, 0)::integer
    from public.store_monthly_metrics m
    left join adjusted a on a.month = m.month
   where m.shop_key = p_shop_key and m.calc_version = p_calc_version and m.month between date_trunc('month', p_from)::date and p_to
   order by m.month;
$$;

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
  delete from public.product_monthly_metrics where shop_key = v_key;
  delete from public.store_monthly_metrics where shop_key = v_key;
  delete from public.cohort_monthly_outcomes where shop_key = v_key;
  delete from public.product_monthly_adjustments where shop_key = v_key;
  delete from public.store_monthly_adjustments where shop_key = v_key;
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
  -- Last: deleting orders and return lines above marks their months again.
  delete from public.summary_dirty_months where shop_key = v_key;
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
       + (select count(*) from public.product_monthly_metrics where shop_key = v_key)
       + (select count(*) from public.store_monthly_metrics where shop_key = v_key)
       + (select count(*) from public.cohort_monthly_outcomes where shop_key = v_key)
       + (select count(*) from public.product_monthly_adjustments where shop_key = v_key)
       + (select count(*) from public.store_monthly_adjustments where shop_key = v_key)
       + (select count(*) from public.summary_dirty_months where shop_key = v_key)
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

drop table public.history_arrivals;
