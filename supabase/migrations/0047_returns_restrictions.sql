-- Phase 3, task 4: returns and restrictions.
--
--  - orders: Shopify Collective (productNetwork: the order holds products a supplier fulfils) and the
--    order's return status;
--  - order lines: restockable, non-fulfillable quantity, requires shipping, gift card;
--  - refunds: the return they settle, and whether their line items have been read; refund line items
--    (line, quantity, restock type, subtotal) in a new table, read by ID after the order (a bulk export
--    cannot nest a refund's lines), so refunded units no longer rest on quantity less current quantity,
--    which also counts order edits;
--  - returns: decline reason (final sale, return period ended, other) and approval time; return lines:
--    processed, refunded and unprocessed quantities, the reason's name and any restocking fee. Customer
--    and staff free-text notes are not read;
--  - product_return_signals: why a product may not be returnable, each signal with its source and how
--    far it can be trusted; product_return_evidence: rates, reasons and maturity from the mirror, with
--    completeness, in place of the live 25-page fetch;
--  - delete_synced_records also deletes a deleted product's variant metafields (0044 left them).
-- Existing rows are unchanged; refunds already stored are due for their lines.

alter table public.orders
  add column product_network  boolean,
  add column return_status    text check (return_status ~ '^[a-z][a-z_]{0,39}$');

alter table public.order_line_items
  add column restockable              boolean,
  add column non_fulfillable_quantity integer check (non_fulfillable_quantity >= 0),
  add column requires_shipping        boolean,
  add column is_gift_card             boolean;

alter table public.refunds
  add column return_shopify_id  bigint check (return_shopify_id > 0),
  add column lines_read         boolean not null default false;
create index refunds_lines_due_idx on public.refunds (shop_key, shopify_id) where not lines_read;

create table public.refund_line_items (
  shop_key              integer not null,
  shopify_id            bigint not null check (shopify_id > 0),
  refund_shopify_id     bigint not null,
  line_item_shopify_id  bigint check (line_item_shopify_id > 0),
  quantity              integer not null check (quantity >= 0),
  restock_type          text check (restock_type in ('return', 'cancel', 'legacy_restock', 'no_restock')),
  subtotal              numeric check (subtotal >= 0),
  primary key (shop_key, shopify_id),
  constraint refund_line_items_refund_fkey foreign key (shop_key, refund_shopify_id) references public.refunds (shop_key, shopify_id) on delete cascade
);
create index refund_line_items_refund_idx on public.refund_line_items (shop_key, refund_shopify_id);
create index refund_line_items_line_idx on public.refund_line_items (shop_key, line_item_shopify_id);
alter table public.refund_line_items enable row level security;
revoke all on table public.refund_line_items from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.refund_line_items to service_role;

alter table public.returns
  add column fields_version       smallint check (fields_version > 0),
  add column decline_reason       text check (decline_reason in ('return_period_ended', 'final_sale', 'other')),
  add column request_approved_at  timestamptz;

alter table public.return_line_items
  add column processed_quantity         integer check (processed_quantity >= 0),
  add column refunded_quantity          integer check (refunded_quantity >= 0),
  add column unprocessed_quantity       integer check (unprocessed_quantity >= 0),
  add column return_reason_name         text check (char_length(return_reason_name) <= 255),
  add column restocking_fee_amount      numeric check (restocking_fee_amount >= 0),
  add column restocking_fee_percentage  numeric check (restocking_fee_percentage between 0 and 100);

-- The order write (0041), with the order and line fields above. A refund is written without its lines
-- (lines_read stays as it was: refunds do not change once made); ingest_refund_lines adds them.
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
        shopify_updated_at timestamptz, customer_digest text, order_digest text, product_network boolean, return_status text)
     where x.processed_at >= v_cutoff
  ), written as (
    insert into public.orders as o (shop_key, shopify_id, name, shopify_created_at, processed_at, cancelled_at, financial_status,
      fulfillment_status, currency, presentment_currency, subtotal, total_discounts, total_tax, total_shipping, total_price, total_refunded,
      customer_shopify_id, ship_country_code, ship_province_code, ship_city, ship_city_raw, source_name, is_test, shopify_updated_at, synced_at,
      product_network, return_status)
    select p_shop_key, shopify_id, name, shopify_created_at, processed_at, cancelled_at, financial_status, fulfillment_status, currency,
           presentment_currency, coalesce(subtotal, 0), coalesce(total_discounts, 0), coalesce(total_tax, 0), coalesce(total_shipping, 0),
           total_price, coalesce(total_refunded, 0),
           case when suppressed then null else customer_shopify_id end, ship_country_code,
           case when suppressed then null else ship_province_code end,
           case when suppressed then null else ship_city end,
           case when suppressed then null else ship_city_raw end,
           source_name, coalesce(is_test, false), shopify_updated_at, now(), product_network, return_status
      from incoming
    on conflict (shop_key, shopify_id) do update set
      name = excluded.name, shopify_created_at = excluded.shopify_created_at, processed_at = excluded.processed_at,
      cancelled_at = excluded.cancelled_at, financial_status = excluded.financial_status, fulfillment_status = excluded.fulfillment_status,
      currency = excluded.currency, presentment_currency = excluded.presentment_currency, subtotal = excluded.subtotal,
      total_discounts = excluded.total_discounts, total_tax = excluded.total_tax, total_shipping = excluded.total_shipping,
      total_price = excluded.total_price, total_refunded = excluded.total_refunded, customer_shopify_id = excluded.customer_shopify_id,
      ship_country_code = excluded.ship_country_code, ship_province_code = excluded.ship_province_code, ship_city = excluded.ship_city,
      ship_city_raw = excluded.ship_city_raw, source_name = excluded.source_name, is_test = excluded.is_test,
      shopify_updated_at = excluded.shopify_updated_at, synced_at = now(), product_network = excluded.product_network,
      return_status = excluded.return_status
     where o.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= o.shopify_updated_at
    returning o.shopify_id
  )
  select coalesce(array_agg(shopify_id), '{}') into v_written from written;

  insert into public.order_line_items as li (shop_key, shopify_id, order_shopify_id, product_shopify_id, variant_shopify_id, title, sku,
    quantity, current_quantity, refunded_quantity, unit_price, total_discount, restockable, non_fulfillable_quantity, requires_shipping, is_gift_card)
  select p_shop_key, x.shopify_id, x.order_shopify_id, x.product_shopify_id, x.variant_shopify_id, x.title, x.sku, x.quantity,
         x.current_quantity, coalesce(x.refunded_quantity, 0), x.unit_price, coalesce(x.total_discount, 0),
         x.restockable, x.non_fulfillable_quantity, x.requires_shipping, x.is_gift_card
    from jsonb_to_recordset(coalesce(p_line_items, '[]')) as x(shopify_id bigint, order_shopify_id bigint, product_shopify_id bigint,
         variant_shopify_id bigint, title text, sku text, quantity integer, current_quantity integer, refunded_quantity integer,
         unit_price numeric, total_discount numeric, restockable boolean, non_fulfillable_quantity integer, requires_shipping boolean,
         is_gift_card boolean)
   where x.order_shopify_id = any (v_written)
  on conflict (shop_key, shopify_id) do update set
    order_shopify_id = excluded.order_shopify_id, product_shopify_id = excluded.product_shopify_id,
    variant_shopify_id = excluded.variant_shopify_id, title = excluded.title, sku = excluded.sku, quantity = excluded.quantity,
    current_quantity = excluded.current_quantity, refunded_quantity = excluded.refunded_quantity, unit_price = excluded.unit_price,
    total_discount = excluded.total_discount, restockable = excluded.restockable, non_fulfillable_quantity = excluded.non_fulfillable_quantity,
    requires_shipping = excluded.requires_shipping, is_gift_card = excluded.is_gift_card;
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

-- A batch of refunds' line items, read by ID: each refund's lines are replaced, its return recorded, and it
-- is marked read. Refunds not stored (an order outside the window, or deleted) are skipped.
create or replace function public.ingest_refund_lines(p_shop_key integer, p_refunds jsonb, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_refunds bigint[];
  v_lines integer := 0;
  v_removed integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_refunds, p_lines) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  with marked as (
    update public.refunds r set return_shopify_id = x.return_shopify_id, lines_read = true
      from jsonb_to_recordset(coalesce(p_refunds, '[]')) as x(shopify_id bigint, return_shopify_id bigint)
     where r.shop_key = p_shop_key and r.shopify_id = x.shopify_id
    returning r.shopify_id
  )
  select coalesce(array_agg(shopify_id), '{}') into v_refunds from marked;

  delete from public.refund_line_items rl
   where rl.shop_key = p_shop_key and rl.refund_shopify_id = any (v_refunds)
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_lines, '[]')) as x(shopify_id bigint) where x.shopify_id = rl.shopify_id);
  get diagnostics v_removed = row_count;

  insert into public.refund_line_items as rl (shop_key, shopify_id, refund_shopify_id, line_item_shopify_id, quantity, restock_type, subtotal)
  select p_shop_key, x.shopify_id, x.refund_shopify_id, x.line_item_shopify_id, x.quantity, x.restock_type, x.subtotal
    from jsonb_to_recordset(coalesce(p_lines, '[]')) as x(shopify_id bigint, refund_shopify_id bigint, line_item_shopify_id bigint,
         quantity integer, restock_type text, subtotal numeric)
   where x.refund_shopify_id = any (v_refunds)
  on conflict (shop_key, shopify_id) do update set
    refund_shopify_id = excluded.refund_shopify_id, line_item_shopify_id = excluded.line_item_shopify_id, quantity = excluded.quantity,
    restock_type = excluded.restock_type, subtotal = excluded.subtotal;
  get diagnostics v_lines = row_count;

  return jsonb_build_object('refunds', cardinality(v_refunds), 'skipped', jsonb_array_length(coalesce(p_refunds, '[]')) - cardinality(v_refunds),
    'lines', v_lines, 'lines_removed', v_removed);
end;
$$;

-- Refunds whose line items have not been read yet, lowest first (at most 1,000).
create or replace function public.refund_lines_due(p_shop_key integer, p_limit integer default 100)
returns bigint[] language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(shopify_id order by shopify_id), '{}')
    from (select shopify_id from public.refunds where shop_key = p_shop_key and not lines_read
           order by shopify_id limit least(greatest(coalesce(p_limit, 100), 1), 1000)) due;
$$;

-- The returns write (0032), with Phase 3's return and line fields, and each return's refunds.
drop function public.ingest_returns(integer, jsonb, jsonb);
create or replace function public.ingest_returns(p_shop_key integer, p_returns jsonb, p_return_line_items jsonb, p_return_refunds jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_returns integer := 0;
  v_lines integer := 0;
  v_lines_removed integer := 0;
  v_refunds integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_returns, p_return_line_items, p_return_refunds) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  insert into public.returns as r (shop_key, shopify_id, order_shopify_id, name, status, total_quantity, shopify_created_at, closed_at, synced_at,
    fields_version, decline_reason, request_approved_at)
  select p_shop_key, x.shopify_id, x.order_shopify_id, x.name, x.status, x.total_quantity, x.shopify_created_at, x.closed_at, now(),
         x.fields_version, x.decline_reason, x.request_approved_at
    from jsonb_to_recordset(coalesce(p_returns, '[]')) as x(shopify_id bigint, order_shopify_id bigint, name text, status text,
         total_quantity integer, shopify_created_at timestamptz, closed_at timestamptz, fields_version smallint, decline_reason text,
         request_approved_at timestamptz)
  on conflict (shop_key, shopify_id) do update set
    order_shopify_id = excluded.order_shopify_id, name = excluded.name, status = excluded.status, total_quantity = excluded.total_quantity,
    shopify_created_at = excluded.shopify_created_at, closed_at = excluded.closed_at, synced_at = now(),
    fields_version = excluded.fields_version, decline_reason = excluded.decline_reason, request_approved_at = excluded.request_approved_at;
  get diagnostics v_returns = row_count;

  insert into public.return_line_items as rl (shop_key, shopify_id, return_shopify_id, line_item_shopify_id, quantity, return_reason,
    processed_quantity, refunded_quantity, unprocessed_quantity, return_reason_name, restocking_fee_amount, restocking_fee_percentage)
  select p_shop_key, x.shopify_id, x.return_shopify_id, x.line_item_shopify_id, x.quantity, x.return_reason,
         x.processed_quantity, x.refunded_quantity, x.unprocessed_quantity, x.return_reason_name, x.restocking_fee_amount, x.restocking_fee_percentage
    from jsonb_to_recordset(coalesce(p_return_line_items, '[]')) as x(shopify_id bigint, return_shopify_id bigint,
         line_item_shopify_id bigint, quantity integer, return_reason text, processed_quantity integer, refunded_quantity integer,
         unprocessed_quantity integer, return_reason_name text, restocking_fee_amount numeric, restocking_fee_percentage numeric)
   where exists (select 1 from jsonb_to_recordset(coalesce(p_returns, '[]')) as r(shopify_id bigint) where r.shopify_id = x.return_shopify_id)
  on conflict (shop_key, shopify_id) do update set
    return_shopify_id = excluded.return_shopify_id, line_item_shopify_id = excluded.line_item_shopify_id,
    quantity = excluded.quantity, return_reason = excluded.return_reason, processed_quantity = excluded.processed_quantity,
    refunded_quantity = excluded.refunded_quantity, unprocessed_quantity = excluded.unprocessed_quantity,
    return_reason_name = excluded.return_reason_name, restocking_fee_amount = excluded.restocking_fee_amount,
    restocking_fee_percentage = excluded.restocking_fee_percentage;
  get diagnostics v_lines = row_count;

  delete from public.return_line_items rl
   where rl.shop_key = p_shop_key
     and rl.return_shopify_id in (select r.shopify_id from jsonb_to_recordset(coalesce(p_returns, '[]')) as r(shopify_id bigint))
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_return_line_items, '[]')) as x(shopify_id bigint) where x.shopify_id = rl.shopify_id);
  get diagnostics v_lines_removed = row_count;

  -- The refunds that settle each return, from the return's side.
  update public.refunds f set return_shopify_id = x.return_shopify_id
    from jsonb_to_recordset(coalesce(p_return_refunds, '[]')) as x(return_shopify_id bigint, refund_shopify_id bigint)
   where f.shop_key = p_shop_key and f.shopify_id = x.refund_shopify_id and f.return_shopify_id is distinct from x.return_shopify_id;
  get diagnostics v_refunds = row_count;

  return jsonb_build_object('returns', v_returns, 'return_line_items', v_lines, 'return_line_items_removed', v_lines_removed, 'refunds_linked', v_refunds);
end;
$$;

-- Why a product may not be returnable, for products given (at most 500). Each signal names its source and
-- how far it can be trusted:
--   gift_card       verified    Shopify marks the product as a gift card;
--   declined_final_sale observed  the shop declined a return of it as a final sale;
--   tag             unverified  a merchant tag says final sale or no returns;
--   metafield       unverified  a merchant metafield says so (key or value).
-- No signal is not proof that a product is returnable: the shop's refund policy is read in task 5.
create or replace function public.product_return_signals(p_shop_key integer, p_product_ids bigint[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with wanted as (select unnest((coalesce(p_product_ids, '{}'))[1:500]) as id),
  signals as (
    select p.shopify_id as product_id, 'gift_card' as signal, 'verified' as trust, 'shopify_product' as source, null::text as detail
      from public.products p join wanted w on w.id = p.shopify_id where p.shop_key = p_shop_key and p.is_gift_card
    union all
    select distinct li.product_shopify_id, 'declined_final_sale', 'observed', 'shopify_return_decline', r.name
      from public.returns r
      join public.return_line_items rl on rl.shop_key = r.shop_key and rl.return_shopify_id = r.shopify_id
      join public.order_line_items li on li.shop_key = rl.shop_key and li.shopify_id = rl.line_item_shopify_id
      join wanted w on w.id = li.product_shopify_id
     where r.shop_key = p_shop_key and r.decline_reason = 'final_sale'
    union all
    select p.shopify_id, 'tag', 'unverified', 'merchant_tag', t.tag
      from public.products p join wanted w on w.id = p.shopify_id
      cross join lateral unnest(p.tags) as t(tag)
     where p.shop_key = p_shop_key and t.tag ~* '(final[ _-]?sale|non[ _-]?returnable|no[ _-]?returns?|not[ _-]?returnable)'
    union all
    select p.shopify_id, 'metafield', 'unverified', 'merchant_metafield', m.namespace || '.' || m.key
      from public.products p join wanted w on w.id = p.shopify_id
      join public.metafields m on m.shop_key = p.shop_key and m.owner_type = 'product' and m.owner_shopify_id = p.shopify_id
     where p.shop_key = p_shop_key
       and ((m.key ~* '(final[_-]?sale|non[_-]?returnable|no[_-]?returns?|returnable)' and m.value_excerpt ~* '^(true|yes|1|final sale|non-returnable|no returns?)$')
            or m.value_excerpt ~* '^(final sale|non-returnable|not returnable|no returns?)$')
  )
  select coalesce(jsonb_agg(jsonb_build_object('product_id', s.product_id, 'signal', s.signal, 'trust', s.trust, 'source', s.source, 'detail', s.detail)
           order by s.product_id, s.signal, s.detail), '[]'::jsonb)
    from signals s;
$$;

-- Return evidence per product (at most 500), from the mirror: units sold on orders processed in the year to
-- p_as_of less the 60-day maturity (Shopify's sales date: the live fetch used the creation date, wrong for
-- imported orders, as task 11 found), units returned (processed) and refunded on those orders, and the main
-- reason. As the live computation did: rates only from 30 eligible units, a reason only from 3 units, risk
-- "review" from a 15% processed return rate. Refunded units come from refund line items, so while any
-- refund on those orders has not had its lines read, refunded units are withheld (null), not guessed.
create or replace function public.product_return_evidence(p_shop_key integer, p_product_ids bigint[], p_as_of timestamptz default now())
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with wanted as (select unnest((coalesce(p_product_ids, '{}'))[1:500]) as id),
  eligible as (
    select li.shopify_id as line_id, li.product_shopify_id as product_id, li.quantity, o.shopify_id as order_id
      from public.order_line_items li
      join wanted w on w.id = li.product_shopify_id
      join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
     where li.shop_key = p_shop_key and li.quantity > 0 and o.cancelled_at is null and not o.is_test
       and o.financial_status in ('paid', 'partially_refunded', 'refunded')
       and o.processed_at >= p_as_of - interval '365 days' and o.processed_at < p_as_of - interval '60 days'
  ),
  sold as (select product_id, sum(quantity) as units from eligible group by product_id),
  returned as (
    select e.product_id, sum(rl.processed_quantity) as units
      from eligible e join public.return_line_items rl on rl.shop_key = p_shop_key and rl.line_item_shopify_id = e.line_id
     where coalesce(rl.processed_quantity, 0) > 0 group by e.product_id
  ),
  reasons as (
    select e.product_id, rl.return_reason_name as reason, sum(rl.processed_quantity) as units,
           row_number() over (partition by e.product_id order by sum(rl.processed_quantity) desc, rl.return_reason_name) as rank
      from eligible e join public.return_line_items rl on rl.shop_key = p_shop_key and rl.line_item_shopify_id = e.line_id
     where coalesce(rl.processed_quantity, 0) > 0 and rl.return_reason_name is not null group by e.product_id, rl.return_reason_name
  ),
  refunded as (
    select e.product_id, sum(fl.quantity) as units
      from eligible e join public.refund_line_items fl on fl.shop_key = p_shop_key and fl.line_item_shopify_id = e.line_id
     where fl.quantity > 0 group by e.product_id
  ),
  unread as (
    select e.product_id, count(distinct f.shopify_id) as refunds
      from eligible e join public.refunds f on f.shop_key = p_shop_key and f.order_shopify_id = e.order_id
     where not f.lines_read group by e.product_id
  ),
  returns_unread as (
    select e.product_id, count(distinct r.shopify_id) as returns
      from eligible e join public.returns r on r.shop_key = p_shop_key and r.order_shopify_id = e.order_id
     where r.fields_version is null group by e.product_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', s.product_id,
           'eligible_units', s.units,
           'processed_return_units', case when ru.returns is null then coalesce(r.units, 0) end,
           'refunded_units', case when u.refunds is null then coalesce(f.units, 0) end,
           'processed_return_rate', case when s.units >= 30 and ru.returns is null then round(coalesce(r.units, 0)::numeric / s.units, 4) end,
           'primary_reason', case when rs.units >= 3 then rs.reason end,
           'risk', case when s.units < 30 then 'insufficient_data' when ru.returns is not null then 'incomplete'
                        when coalesce(r.units, 0)::numeric / s.units >= 0.15 then 'review' else 'observed' end,
           'complete', u.refunds is null and ru.returns is null,
           'refunds_unread', coalesce(u.refunds, 0), 'returns_unread', coalesce(ru.returns, 0),
           'window_days', 365, 'maturity_days', 60
         ) order by s.product_id), '[]'::jsonb)
    from sold s
    left join returned r on r.product_id = s.product_id
    left join refunded f on f.product_id = s.product_id
    left join reasons rs on rs.product_id = s.product_id and rs.rank = 1
    left join unread u on u.product_id = s.product_id
    left join returns_unread ru on ru.product_id = s.product_id;
$$;

-- 0040's record deletion, with the variant metafields of a deleted product.
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
    -- And its variants' metafields (0044 stores them; variants themselves go with the product).
    delete from public.metafields m using public.product_variants v
     where m.shop_key = p_shop_key and m.owner_type = 'variant' and v.shop_key = p_shop_key and v.shopify_id = m.owner_shopify_id
       and v.product_shopify_id = any(v_ids);
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

-- 0044's deletion helpers, with refund line items.
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
  delete from public.refund_line_items where shop_key = v_key;
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
       + (select count(*) from public.refund_line_items where shop_key = v_key)
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

revoke all on function public.ingest_refund_lines(integer, jsonb, jsonb), public.refund_lines_due(integer, integer),
  public.ingest_returns(integer, jsonb, jsonb, jsonb), public.product_return_signals(integer, bigint[]),
  public.product_return_evidence(integer, bigint[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.ingest_refund_lines(integer, jsonb, jsonb), public.refund_lines_due(integer, integer),
  public.ingest_returns(integer, jsonb, jsonb, jsonb), public.product_return_signals(integer, bigint[]),
  public.product_return_evidence(integer, bigint[], timestamptz)
  to service_role;
