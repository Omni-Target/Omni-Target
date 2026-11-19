-- Reverses 0036: maintenance functions, triggers and tables are dropped; refresh_monthly_aggregates and the
-- deletion helpers return to 0030. Adjustments recorded meanwhile are dropped with their tables.
drop trigger orders_mark_summary_insert on public.orders;
drop trigger orders_mark_summary_update on public.orders;
drop trigger orders_mark_summary_delete on public.orders;
drop trigger return_line_items_mark_summary_insert on public.return_line_items;
drop trigger return_line_items_mark_summary_update on public.return_line_items;
drop trigger return_line_items_mark_summary_delete on public.return_line_items;
drop trigger product_monthly_metrics_final on public.product_monthly_metrics;
drop trigger store_monthly_metrics_final on public.store_monthly_metrics;
drop trigger cohort_monthly_outcomes_final on public.cohort_monthly_outcomes;

create or replace function public.refresh_monthly_aggregates(p_shop_key integer, p_from date, p_to date, p_calc_version integer default 1)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_from date := date_trunc('month', p_from)::date;
  v_to date := date_trunc('month', p_to)::date;
  v_final_before date := date_trunc('month', now() - interval '120 days')::date;
  v_cohort_final_before date := date_trunc('month', now() - interval '485 days')::date;
  v_products integer;
  v_store integer;
  v_cohorts integer;
  v_sale_dates integer;
begin
  if p_shop_key is null or v_from is null or v_to is null or v_to < v_from or coalesce(p_calc_version, 0) < 1 then
    raise exception 'aggregate_range_invalid';
  end if;

  delete from public.product_monthly_metrics
   where shop_key = p_shop_key and calc_version = p_calc_version and month between v_from and v_to and finalized_at is null;
  insert into public.product_monthly_metrics (shop_key, product_shopify_id, month, calc_version, currency, orders, units, gross_sales,
    discounts, refunded_units, returned_units, customers, first_time_customers, finalized_at)
  select p_shop_key, li.product_shopify_id, date_trunc('month', o.processed_at)::date, p_calc_version, max(o.currency),
         count(distinct o.shopify_id), sum(li.quantity), sum(li.unit_price * li.quantity), sum(li.total_discount),
         sum(li.refunded_quantity), coalesce(sum(r.returned), 0), count(distinct o.customer_shopify_id),
         count(distinct o.customer_shopify_id) filter (where o.shopify_id = c.first_order_shopify_id),
         case when date_trunc('month', o.processed_at)::date < v_final_before then now() end
    from public.order_line_items li
    join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
    left join (select line_item_shopify_id, sum(quantity) as returned from public.return_line_items
                where shop_key = p_shop_key group by 1) r on r.line_item_shopify_id = li.shopify_id
    left join public.customers c on c.shop_key = o.shop_key and c.shopify_id = o.customer_shopify_id
   where li.shop_key = p_shop_key and li.product_shopify_id is not null and not o.is_test and o.cancelled_at is null
     and o.processed_at >= v_from and o.processed_at < v_to + interval '1 month'
   group by li.product_shopify_id, date_trunc('month', o.processed_at)::date
  on conflict (shop_key, product_shopify_id, month, calc_version) do nothing;
  get diagnostics v_products = row_count;

  delete from public.store_monthly_metrics
   where shop_key = p_shop_key and calc_version = p_calc_version and month between v_from and v_to and finalized_at is null;
  insert into public.store_monthly_metrics (shop_key, month, calc_version, currency, orders, units, subtotal, total_discounts,
    total_tax, total_shipping, total_price, total_refunded, customers, new_customers, finalized_at)
  select p_shop_key, date_trunc('month', o.processed_at)::date, p_calc_version, max(o.currency), count(*), coalesce(sum(u.units), 0),
         sum(o.subtotal), sum(o.total_discounts), sum(o.total_tax), sum(o.total_shipping), sum(o.total_price), sum(o.total_refunded),
         count(distinct o.customer_shopify_id), count(distinct o.customer_shopify_id) filter (where o.shopify_id = c.first_order_shopify_id),
         case when date_trunc('month', o.processed_at)::date < v_final_before then now() end
    from public.orders o
    left join (select li.order_shopify_id, sum(li.quantity) as units
                 from public.order_line_items li
                 join public.orders lo on lo.shop_key = li.shop_key and lo.shopify_id = li.order_shopify_id
                where li.shop_key = p_shop_key and lo.processed_at >= v_from and lo.processed_at < v_to + interval '1 month'
                group by 1) u on u.order_shopify_id = o.shopify_id
    left join public.customers c on c.shop_key = o.shop_key and c.shopify_id = o.customer_shopify_id
   where o.shop_key = p_shop_key and not o.is_test and o.cancelled_at is null
     and o.processed_at >= v_from and o.processed_at < v_to + interval '1 month'
   group by date_trunc('month', o.processed_at)::date
  on conflict (shop_key, month, calc_version) do nothing;
  get diagnostics v_store = row_count;

  delete from public.cohort_monthly_outcomes
   where shop_key = p_shop_key and calc_version = p_calc_version and cohort_month between v_from and v_to and finalized_at is null;
  insert into public.cohort_monthly_outcomes (shop_key, cohort_month, calc_version, currency, first_time_customers, repeat_30d,
    repeat_60d, repeat_90d, repeat_180d, repeat_365d, first_order_revenue, revenue_60d, observed_through, finalized_at)
  select p_shop_key, date_trunc('month', c.first_order_at)::date, p_calc_version, max(f.currency), count(*),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '30 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '60 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '90 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '180 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '365 days'),
         coalesce(sum(f.total_price), 0), coalesce(sum(r60.revenue), 0), now(),
         case when date_trunc('month', c.first_order_at)::date < v_cohort_final_before then now() end
    from public.customers c
    join public.orders f on f.shop_key = c.shop_key and f.shopify_id = c.first_order_shopify_id
    left join lateral (select min(o.processed_at) as next_at from public.orders o
                        where o.shop_key = c.shop_key and o.customer_shopify_id = c.shopify_id and o.processed_at > c.first_order_at
                          and not o.is_test and o.cancelled_at is null) nx on true
    left join lateral (select sum(o.total_price) as revenue from public.orders o
                        where o.shop_key = c.shop_key and o.customer_shopify_id = c.shopify_id
                          and o.processed_at >= c.first_order_at and o.processed_at <= c.first_order_at + interval '60 days'
                          and not o.is_test and o.cancelled_at is null) r60 on true
   where c.shop_key = p_shop_key and c.first_order_at >= v_from and c.first_order_at < v_to + interval '1 month'
   group by date_trunc('month', c.first_order_at)::date
  on conflict (shop_key, cohort_month, calc_version) do nothing;
  get diagnostics v_cohorts = row_count;

  -- Sale dates only ever widen, so they survive the pruning of the orders behind them,
  -- and each refresh need only read its own range of months.
  update public.products p
     set first_sold_at = least(p.first_sold_at, s.first_at), last_sold_at = greatest(p.last_sold_at, s.last_at)
    from (select li.product_shopify_id, min(o.processed_at) as first_at, max(o.processed_at) as last_at
            from public.order_line_items li join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
           where li.shop_key = p_shop_key and li.product_shopify_id is not null and not o.is_test and o.cancelled_at is null
             and o.processed_at >= v_from and o.processed_at < v_to + interval '1 month'
           group by 1) s
   where p.shop_key = p_shop_key and p.shopify_id = s.product_shopify_id
     and (p.first_sold_at is distinct from least(p.first_sold_at, s.first_at) or p.last_sold_at is distinct from greatest(p.last_sold_at, s.last_at));
  get diagnostics v_sale_dates = row_count;

  return jsonb_build_object('product_months', v_products, 'store_months', v_store, 'cohort_months', v_cohorts, 'products_dated', v_sale_dates);
end;
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
       + (select count(*) from public.product_monthly_metrics where shop_key = v_key)
       + (select count(*) from public.store_monthly_metrics where shop_key = v_key)
       + (select count(*) from public.cohort_monthly_outcomes where shop_key = v_key)
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

drop function public.refresh_summary_month(integer, date, integer);
drop function public.summary_months_due(integer);
drop function public.maintain_summary_month(integer, date, integer);
drop function public.summary_maintenance_ready(integer);
drop function public.product_months_effective(integer, date, date, integer);
drop function public.store_months_effective(integer, date, date, integer);
drop function public.summarise_detail_month(integer, date, integer);
drop function public.detail_product_month(integer, date);
drop function public.detail_store_month(integer, date);
drop function public.mark_order_summary_months();
drop function public.mark_return_summary_months();
drop table public.product_monthly_adjustments;
drop table public.store_monthly_adjustments;
drop table public.summary_dirty_months;
drop function public.refuse_summary_update();
