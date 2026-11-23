-- Reverts 0047: 0041's order write, 0032's returns write, 0040's record deletion and 0044's deletion helpers,
-- then the new functions, table, indexes and columns. Refund lines and the new fields are lost; the next
-- import reads them again after re-applying 0047.
drop function public.product_return_evidence(integer, bigint[], timestamptz);
drop function public.product_return_signals(integer, bigint[]);
drop function public.refund_lines_due(integer, integer);
drop function public.ingest_refund_lines(integer, jsonb, jsonb);
drop function public.ingest_returns(integer, jsonb, jsonb, jsonb);
create or replace function public.ingest_returns(p_shop_key integer, p_returns jsonb, p_return_line_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_returns integer := 0;
  v_lines integer := 0;
  v_lines_removed integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_returns, p_return_line_items) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  insert into public.returns as r (shop_key, shopify_id, order_shopify_id, name, status, total_quantity, shopify_created_at, closed_at, synced_at)
  select p_shop_key, x.shopify_id, x.order_shopify_id, x.name, x.status, x.total_quantity, x.shopify_created_at, x.closed_at, now()
    from jsonb_to_recordset(coalesce(p_returns, '[]')) as x(shopify_id bigint, order_shopify_id bigint, name text, status text,
         total_quantity integer, shopify_created_at timestamptz, closed_at timestamptz)
  on conflict (shop_key, shopify_id) do update set
    order_shopify_id = excluded.order_shopify_id, name = excluded.name, status = excluded.status, total_quantity = excluded.total_quantity,
    shopify_created_at = excluded.shopify_created_at, closed_at = excluded.closed_at, synced_at = now();
  get diagnostics v_returns = row_count;

  insert into public.return_line_items as rl (shop_key, shopify_id, return_shopify_id, line_item_shopify_id, quantity, return_reason)
  select p_shop_key, x.shopify_id, x.return_shopify_id, x.line_item_shopify_id, x.quantity, x.return_reason
    from jsonb_to_recordset(coalesce(p_return_line_items, '[]')) as x(shopify_id bigint, return_shopify_id bigint,
         line_item_shopify_id bigint, quantity integer, return_reason text)
   where exists (select 1 from jsonb_to_recordset(coalesce(p_returns, '[]')) as r(shopify_id bigint) where r.shopify_id = x.return_shopify_id)
  on conflict (shop_key, shopify_id) do update set
    return_shopify_id = excluded.return_shopify_id, line_item_shopify_id = excluded.line_item_shopify_id,
    quantity = excluded.quantity, return_reason = excluded.return_reason;
  get diagnostics v_lines = row_count;

  delete from public.return_line_items rl
   where rl.shop_key = p_shop_key
     and rl.return_shopify_id in (select r.shopify_id from jsonb_to_recordset(coalesce(p_returns, '[]')) as r(shopify_id bigint))
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_return_line_items, '[]')) as x(shopify_id bigint) where x.shopify_id = rl.shopify_id);
  get diagnostics v_lines_removed = row_count;

  return jsonb_build_object('returns', v_returns, 'return_line_items', v_lines, 'return_line_items_removed', v_lines_removed);
end;
$$;
revoke all on function public.ingest_returns(integer, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_returns(integer, jsonb, jsonb) to service_role;

create or replace function public.ingest_orders(p_shop_key integer, p_orders jsonb, p_line_items jsonb, p_refunds jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shopify_shop bigint;
  v_cutoff timestamptz := public.shop_window_start(p_shop_key);
  v_written bigint[];
  v_beyond integer := 0;
  v_suppressed integer := 0;
  v_lines integer := 0;
  v_lines_removed integer := 0;
  v_refunds integer := 0;
  v_refunds_removed integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_orders, p_line_items, p_refunds) > 2000 then raise exception 'ingest_batch_too_large'; end if;
  select shopify_shop_id into v_shopify_shop from public.shops where shop_key = p_shop_key;

  select count(*) filter (where x.processed_at < v_cutoff),
         count(*) filter (where x.processed_at >= v_cutoff and (
           exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'customer'
                    and x.customer_digest is not null and s.subject_digest = decode(x.customer_digest, 'hex'))
           or exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'order'
                    and x.order_digest is not null and s.subject_digest = decode(x.order_digest, 'hex'))))
    into v_beyond, v_suppressed
    from jsonb_to_recordset(coalesce(p_orders, '[]')) as x(processed_at timestamptz, customer_digest text, order_digest text);

  with incoming as (
    select x.*,
           exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'customer'
                    and x.customer_digest is not null and s.subject_digest = decode(x.customer_digest, 'hex'))
        or exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'order'
                    and x.order_digest is not null and s.subject_digest = decode(x.order_digest, 'hex')) as suppressed
      from jsonb_to_recordset(coalesce(p_orders, '[]')) as x(
        shopify_id bigint, name text, shopify_created_at timestamptz, processed_at timestamptz, cancelled_at timestamptz,
        financial_status text, fulfillment_status text, currency text, presentment_currency text, subtotal numeric, total_discounts numeric,
        total_tax numeric, total_shipping numeric, total_price numeric, total_refunded numeric, customer_shopify_id bigint,
        ship_country_code text, ship_province_code text, ship_city text, ship_city_raw text, source_name text, is_test boolean,
        shopify_updated_at timestamptz, customer_digest text, order_digest text)
     where x.processed_at >= v_cutoff
  ), written as (
    insert into public.orders as o (shop_key, shopify_id, name, shopify_created_at, processed_at, cancelled_at, financial_status,
      fulfillment_status, currency, presentment_currency, subtotal, total_discounts, total_tax, total_shipping, total_price, total_refunded,
      customer_shopify_id, ship_country_code, ship_province_code, ship_city, ship_city_raw, source_name, is_test, shopify_updated_at, synced_at)
    select p_shop_key, shopify_id, name, shopify_created_at, processed_at, cancelled_at, financial_status, fulfillment_status, currency,
           presentment_currency, coalesce(subtotal, 0), coalesce(total_discounts, 0), coalesce(total_tax, 0), coalesce(total_shipping, 0),
           total_price, coalesce(total_refunded, 0),
           case when suppressed then null else customer_shopify_id end, ship_country_code,
           case when suppressed then null else ship_province_code end,
           case when suppressed then null else ship_city end,
           case when suppressed then null else ship_city_raw end,
           source_name, coalesce(is_test, false), shopify_updated_at, now()
      from incoming
    on conflict (shop_key, shopify_id) do update set
      name = excluded.name, shopify_created_at = excluded.shopify_created_at, processed_at = excluded.processed_at,
      cancelled_at = excluded.cancelled_at, financial_status = excluded.financial_status, fulfillment_status = excluded.fulfillment_status,
      currency = excluded.currency, presentment_currency = excluded.presentment_currency, subtotal = excluded.subtotal,
      total_discounts = excluded.total_discounts, total_tax = excluded.total_tax, total_shipping = excluded.total_shipping,
      total_price = excluded.total_price, total_refunded = excluded.total_refunded, customer_shopify_id = excluded.customer_shopify_id,
      ship_country_code = excluded.ship_country_code, ship_province_code = excluded.ship_province_code, ship_city = excluded.ship_city,
      ship_city_raw = excluded.ship_city_raw, source_name = excluded.source_name, is_test = excluded.is_test,
      shopify_updated_at = excluded.shopify_updated_at, synced_at = now()
     where o.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= o.shopify_updated_at
    returning o.shopify_id
  )
  select coalesce(array_agg(shopify_id), '{}') into v_written from written;

  insert into public.order_line_items as li (shop_key, shopify_id, order_shopify_id, product_shopify_id, variant_shopify_id, title, sku,
    quantity, current_quantity, refunded_quantity, unit_price, total_discount)
  select p_shop_key, x.shopify_id, x.order_shopify_id, x.product_shopify_id, x.variant_shopify_id, x.title, x.sku, x.quantity,
         x.current_quantity, coalesce(x.refunded_quantity, 0), x.unit_price, coalesce(x.total_discount, 0)
    from jsonb_to_recordset(coalesce(p_line_items, '[]')) as x(shopify_id bigint, order_shopify_id bigint, product_shopify_id bigint,
         variant_shopify_id bigint, title text, sku text, quantity integer, current_quantity integer, refunded_quantity integer,
         unit_price numeric, total_discount numeric)
   where x.order_shopify_id = any (v_written)
  on conflict (shop_key, shopify_id) do update set
    order_shopify_id = excluded.order_shopify_id, product_shopify_id = excluded.product_shopify_id,
    variant_shopify_id = excluded.variant_shopify_id, title = excluded.title, sku = excluded.sku, quantity = excluded.quantity,
    current_quantity = excluded.current_quantity, refunded_quantity = excluded.refunded_quantity, unit_price = excluded.unit_price,
    total_discount = excluded.total_discount;
  get diagnostics v_lines = row_count;

  delete from public.order_line_items li
   where li.shop_key = p_shop_key and li.order_shopify_id = any (v_written)
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_line_items, '[]')) as x(shopify_id bigint) where x.shopify_id = li.shopify_id);
  get diagnostics v_lines_removed = row_count;

  insert into public.refunds as r (shop_key, shopify_id, order_shopify_id, shopify_created_at, processed_at, total_refunded, currency)
  select p_shop_key, x.shopify_id, x.order_shopify_id, x.shopify_created_at, coalesce(x.processed_at, x.shopify_created_at), x.total_refunded, x.currency
    from jsonb_to_recordset(coalesce(p_refunds, '[]')) as x(shopify_id bigint, order_shopify_id bigint, shopify_created_at timestamptz,
         processed_at timestamptz, total_refunded numeric, currency text)
   where x.order_shopify_id = any (v_written)
  on conflict (shop_key, shopify_id) do update set
    order_shopify_id = excluded.order_shopify_id, shopify_created_at = excluded.shopify_created_at,
    processed_at = excluded.processed_at, total_refunded = excluded.total_refunded, currency = excluded.currency;
  get diagnostics v_refunds = row_count;

  delete from public.refunds r
   where r.shop_key = p_shop_key and r.order_shopify_id = any (v_written)
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_refunds, '[]')) as x(shopify_id bigint) where x.shopify_id = r.shopify_id);
  get diagnostics v_refunds_removed = row_count;

  return jsonb_build_object('orders', cardinality(v_written),
    'stale', jsonb_array_length(coalesce(p_orders, '[]')) - v_beyond - cardinality(v_written),
    'beyond_window', v_beyond, 'suppressed', v_suppressed,
    'line_items', v_lines, 'line_items_removed', v_lines_removed, 'refunds', v_refunds, 'refunds_removed', v_refunds_removed);
end;
$$;

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
  delete from public.history_arrivals where shop_key = v_key;
  delete from public.shop_insights where shop_key = v_key;
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
  delete from public.metafield_definitions where shop_key = v_key;
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
       + (select count(*) from public.history_arrivals where shop_key = v_key)
       + (select count(*) from public.shop_insights where shop_key = v_key)
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
       + (select count(*) from public.metafield_definitions where shop_key = v_key)
       + (select count(*) from public.metaobject_definitions where shop_key = v_key)
       + (select count(*) from public.metaobjects where shop_key = v_key)
       + (select count(*) from public.shop_settings where shop_key = v_key)
       + (select count(*) from public.shop_access where shop_key = v_key);
end;
$$;
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;

drop table public.refund_line_items;
drop index public.refunds_lines_due_idx;
alter table public.return_line_items
  drop column processed_quantity, drop column refunded_quantity, drop column unprocessed_quantity, drop column return_reason_name,
  drop column restocking_fee_amount, drop column restocking_fee_percentage;
alter table public.returns drop column fields_version, drop column decline_reason, drop column request_approved_at;
alter table public.refunds drop column return_shopify_id, drop column lines_read;
alter table public.order_line_items drop column restockable, drop column non_fulfillable_quantity, drop column requires_shipping, drop column is_gift_card;
alter table public.orders drop column product_network, drop column return_status;
