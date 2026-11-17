-- 0029: storage optimisations before Phase 2 ingestion (Phase 1, task 12).
--
-- The accepted candidates from architecture/storage-optimisation.md, each
-- measured on its own on the very large fixture (732 MB):
--   1. An integer shop key (shops.shop_key) in every commerce row and index,
--      instead of the 16-byte shop UUID: 60 MB (8.2%).
--   2. Sparse product metrics: a row must record activity: 37 MB (5.1%).
--   3. The raw city and presentment currency only when they differ from the
--      city and the shop currency: up to 7 MB (1%).
--   4. Metafield values at most 1,000 characters, the claims reader's limit.
--   5. No return_line_items (shop, line item) index: no planned query uses it.
--
-- Converted in place, so any existing rows are kept; the down script converts
-- back the same way. shops.id stays the shop's identity everywhere else.

alter table public.shops add column shop_key integer generated always as identity;
alter table public.shops add constraint shops_shop_key_key unique (shop_key);

do $$
declare
  t text;
begin
  foreach t in array array[
    'products', 'product_variants', 'inventory_locations', 'inventory_levels', 'customers', 'orders', 'order_line_items',
    'refunds', 'returns', 'return_line_items', 'metafields', 'metaobject_definitions', 'metaobjects', 'shop_settings',
    'shop_access', 'sync_runs', 'sync_checkpoints', 'webhook_events', 'product_metrics', 'store_metrics'] loop
    execute format('alter table public.%I add column shop_key integer', t);
    execute format('update public.%I x set shop_key = s.shop_key from public.shops s where s.id = x.shop_id', t);
    -- An inbox delivery can name a shop that is not yet modelled.
    if t <> 'webhook_events' then
      execute format('alter table public.%I alter column shop_key set not null', t);
    end if;
    -- Removes shop_id with every key, foreign key and index that includes it.
    execute format('alter table public.%I drop column shop_id cascade', t);
  end loop;
end;
$$;

alter table public.products add constraint products_pkey primary key (shop_key, shopify_id),
  add constraint products_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);
create index products_status_idx on public.products (shop_key, status);

alter table public.product_variants add constraint product_variants_pkey primary key (shop_key, shopify_id),
  add constraint product_variants_product_fkey foreign key (shop_key, product_shopify_id) references public.products (shop_key, shopify_id) on delete cascade;
create index product_variants_product_idx on public.product_variants (shop_key, product_shopify_id);
create unique index product_variants_inventory_item_idx on public.product_variants (shop_key, inventory_item_id) where inventory_item_id is not null;

alter table public.inventory_locations add constraint inventory_locations_pkey primary key (shop_key, shopify_id),
  add constraint inventory_locations_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

alter table public.inventory_levels add constraint inventory_levels_pkey primary key (shop_key, inventory_item_id, location_shopify_id),
  add constraint inventory_levels_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

alter table public.customers add constraint customers_pkey primary key (shop_key, shopify_id),
  add constraint customers_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

alter table public.orders add constraint orders_pkey primary key (shop_key, shopify_id),
  add constraint orders_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);
create index orders_processed_idx on public.orders (shop_key, processed_at);
create index orders_customer_idx on public.orders (shop_key, customer_shopify_id, processed_at) where customer_shopify_id is not null;

alter table public.order_line_items add constraint order_line_items_pkey primary key (shop_key, shopify_id),
  add constraint order_line_items_order_fkey foreign key (shop_key, order_shopify_id) references public.orders (shop_key, shopify_id) on delete cascade;
create index order_line_items_order_idx on public.order_line_items (shop_key, order_shopify_id);
create index order_line_items_product_idx on public.order_line_items (shop_key, product_shopify_id) where product_shopify_id is not null;

alter table public.refunds add constraint refunds_pkey primary key (shop_key, shopify_id),
  add constraint refunds_order_fkey foreign key (shop_key, order_shopify_id) references public.orders (shop_key, shopify_id) on delete cascade;
create index refunds_order_idx on public.refunds (shop_key, order_shopify_id);

alter table public.returns add constraint returns_pkey primary key (shop_key, shopify_id),
  add constraint returns_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);
create index returns_order_idx on public.returns (shop_key, order_shopify_id);

alter table public.return_line_items add constraint return_line_items_pkey primary key (shop_key, shopify_id),
  add constraint return_line_items_return_fkey foreign key (shop_key, return_shopify_id) references public.returns (shop_key, shopify_id) on delete cascade;
create index return_line_items_return_idx on public.return_line_items (shop_key, return_shopify_id);

alter table public.metafields add constraint metafields_pkey primary key (shop_key, owner_type, owner_shopify_id, namespace, key),
  add constraint metafields_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

alter table public.metaobject_definitions add constraint metaobject_definitions_pkey primary key (shop_key, shopify_id),
  add constraint metaobject_definitions_shop_key_type_key unique (shop_key, type),
  add constraint metaobject_definitions_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

alter table public.metaobjects add constraint metaobjects_pkey primary key (shop_key, shopify_id),
  add constraint metaobjects_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);
create index metaobjects_type_idx on public.metaobjects (shop_key, type);

alter table public.shop_settings add constraint shop_settings_pkey primary key (shop_key),
  add constraint shop_settings_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

alter table public.shop_access add constraint shop_access_pkey primary key (shop_key),
  add constraint shop_access_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

alter table public.sync_runs add constraint sync_runs_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);
create unique index sync_runs_one_full_idx on public.sync_runs (shop_key, domain)
  where kind in ('initial', 'full') and status in ('queued', 'running');
create index sync_runs_shop_idx on public.sync_runs (shop_key, domain, created_at desc);

alter table public.sync_checkpoints add constraint sync_checkpoints_pkey primary key (shop_key, domain),
  add constraint sync_checkpoints_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

alter table public.webhook_events add constraint webhook_events_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

alter table public.product_metrics add constraint product_metrics_pkey primary key (shop_key, product_shopify_id, window_days, calc_version),
  add constraint product_metrics_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

alter table public.store_metrics add constraint store_metrics_pkey primary key (shop_key, window_days, calc_version),
  add constraint store_metrics_shop_key_fkey foreign key (shop_key) references public.shops (shop_key);

-- 2. A product metric row exists only when the product had activity in the window.
alter table public.product_metrics add constraint product_metrics_activity
  check (orders > 0 or units > 0 or refunded_units > 0 or returned_units > 0 or refunded_amount > 0);

-- 3. Duplicates of the main field are not stored.
alter table public.orders add constraint orders_ship_city_raw_differs check (ship_city_raw is null or ship_city_raw is distinct from ship_city);
alter table public.orders add constraint orders_presentment_currency_differs check (presentment_currency is null or presentment_currency <> currency);

-- 4. The catalog-claims reader discards metafield values over 1,000 characters.
alter table public.metafields drop constraint metafields_value_excerpt_check;
alter table public.metafields add constraint metafields_value_excerpt_check check (char_length(value_excerpt) <= 1000);

-- The deletion helpers (0025), by shop key.
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
