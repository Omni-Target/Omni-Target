-- Reverses 0029: converts the commerce tables back to the shop UUID keys of
-- 0024/0025 (rows are kept), restoring their constraint names, the return line
-- item index, the 2,000-character metafield limit and the 0025 deletion
-- helpers; removes the checks and shops.shop_key. Columns come back at the end
-- of each table rather than first, which changes nothing else.

alter table public.product_metrics drop constraint product_metrics_activity;
alter table public.orders drop constraint orders_ship_city_raw_differs;
alter table public.orders drop constraint orders_presentment_currency_differs;
alter table public.metafields drop constraint metafields_value_excerpt_check;
alter table public.metafields add constraint metafields_value_excerpt_check check (char_length(value_excerpt) <= 2000);

do $$
declare
  t text;
begin
  foreach t in array array[
    'products', 'product_variants', 'inventory_locations', 'inventory_levels', 'customers', 'orders', 'order_line_items',
    'refunds', 'returns', 'return_line_items', 'metafields', 'metaobject_definitions', 'metaobjects', 'shop_settings',
    'shop_access', 'sync_runs', 'sync_checkpoints', 'webhook_events', 'product_metrics', 'store_metrics'] loop
    execute format('alter table public.%I add column shop_id uuid', t);
    execute format('update public.%I x set shop_id = s.id from public.shops s where s.shop_key = x.shop_key', t);
    if t <> 'webhook_events' then
      execute format('alter table public.%I alter column shop_id set not null', t);
    end if;
    execute format('alter table public.%I drop column shop_key cascade', t);
  end loop;
end;
$$;

alter table public.products add constraint products_pkey primary key (shop_id, shopify_id),
  add constraint products_shop_id_fkey foreign key (shop_id) references public.shops (id);
create index products_status_idx on public.products (shop_id, status);

alter table public.product_variants add constraint product_variants_pkey primary key (shop_id, shopify_id),
  add constraint product_variants_shop_id_product_shopify_id_fkey foreign key (shop_id, product_shopify_id) references public.products (shop_id, shopify_id) on delete cascade;
create index product_variants_product_idx on public.product_variants (shop_id, product_shopify_id);
create unique index product_variants_inventory_item_idx on public.product_variants (shop_id, inventory_item_id) where inventory_item_id is not null;

alter table public.inventory_locations add constraint inventory_locations_pkey primary key (shop_id, shopify_id),
  add constraint inventory_locations_shop_id_fkey foreign key (shop_id) references public.shops (id);

alter table public.inventory_levels add constraint inventory_levels_pkey primary key (shop_id, inventory_item_id, location_shopify_id),
  add constraint inventory_levels_shop_id_fkey foreign key (shop_id) references public.shops (id);

alter table public.customers add constraint customers_pkey primary key (shop_id, shopify_id),
  add constraint customers_shop_id_fkey foreign key (shop_id) references public.shops (id);

alter table public.orders add constraint orders_pkey primary key (shop_id, shopify_id),
  add constraint orders_shop_id_fkey foreign key (shop_id) references public.shops (id);
create index orders_processed_idx on public.orders (shop_id, processed_at);
create index orders_customer_idx on public.orders (shop_id, customer_shopify_id, processed_at) where customer_shopify_id is not null;

alter table public.order_line_items add constraint order_line_items_pkey primary key (shop_id, shopify_id),
  add constraint order_line_items_shop_id_order_shopify_id_fkey foreign key (shop_id, order_shopify_id) references public.orders (shop_id, shopify_id) on delete cascade;
create index order_line_items_order_idx on public.order_line_items (shop_id, order_shopify_id);
create index order_line_items_product_idx on public.order_line_items (shop_id, product_shopify_id) where product_shopify_id is not null;

alter table public.refunds add constraint refunds_pkey primary key (shop_id, shopify_id),
  add constraint refunds_shop_id_order_shopify_id_fkey foreign key (shop_id, order_shopify_id) references public.orders (shop_id, shopify_id) on delete cascade;
create index refunds_order_idx on public.refunds (shop_id, order_shopify_id);

alter table public.returns add constraint returns_pkey primary key (shop_id, shopify_id),
  add constraint returns_shop_id_fkey foreign key (shop_id) references public.shops (id);
create index returns_order_idx on public.returns (shop_id, order_shopify_id);

alter table public.return_line_items add constraint return_line_items_pkey primary key (shop_id, shopify_id),
  add constraint return_line_items_shop_id_return_shopify_id_fkey foreign key (shop_id, return_shopify_id) references public.returns (shop_id, shopify_id) on delete cascade;
create index return_line_items_return_idx on public.return_line_items (shop_id, return_shopify_id);
create index return_line_items_line_item_idx on public.return_line_items (shop_id, line_item_shopify_id) where line_item_shopify_id is not null;

alter table public.metafields add constraint metafields_pkey primary key (shop_id, owner_type, owner_shopify_id, namespace, key),
  add constraint metafields_shop_id_fkey foreign key (shop_id) references public.shops (id);

alter table public.metaobject_definitions add constraint metaobject_definitions_pkey primary key (shop_id, shopify_id),
  add constraint metaobject_definitions_shop_id_type_key unique (shop_id, type),
  add constraint metaobject_definitions_shop_id_fkey foreign key (shop_id) references public.shops (id);

alter table public.metaobjects add constraint metaobjects_pkey primary key (shop_id, shopify_id),
  add constraint metaobjects_shop_id_fkey foreign key (shop_id) references public.shops (id);
create index metaobjects_type_idx on public.metaobjects (shop_id, type);

alter table public.shop_settings add constraint shop_settings_pkey primary key (shop_id),
  add constraint shop_settings_shop_id_fkey foreign key (shop_id) references public.shops (id);

alter table public.shop_access add constraint shop_access_pkey primary key (shop_id),
  add constraint shop_access_shop_id_fkey foreign key (shop_id) references public.shops (id);

alter table public.sync_runs add constraint sync_runs_shop_id_fkey foreign key (shop_id) references public.shops (id);
create unique index sync_runs_one_full_idx on public.sync_runs (shop_id, domain)
  where kind in ('initial', 'full') and status in ('queued', 'running');
create index sync_runs_shop_idx on public.sync_runs (shop_id, domain, created_at desc);

alter table public.sync_checkpoints add constraint sync_checkpoints_pkey primary key (shop_id, domain),
  add constraint sync_checkpoints_shop_id_fkey foreign key (shop_id) references public.shops (id);

alter table public.webhook_events add constraint webhook_events_shop_id_fkey foreign key (shop_id) references public.shops (id);

alter table public.product_metrics add constraint product_metrics_pkey primary key (shop_id, product_shopify_id, window_days, calc_version),
  add constraint product_metrics_shop_id_fkey foreign key (shop_id) references public.shops (id);

alter table public.store_metrics add constraint store_metrics_pkey primary key (shop_id, window_days, calc_version),
  add constraint store_metrics_shop_id_fkey foreign key (shop_id) references public.shops (id);

-- 0025's helpers.
create or replace function public.delete_shop_synced_data(p_domain text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_domain text := public.normalize_shop_host(p_domain);
  v_shop uuid;
begin
  if v_domain is null then return; end if;
  select id into v_shop from public.shops where myshopify_domain = v_domain;
  delete from public.webhook_events where shop_domain = v_domain or (v_shop is not null and shop_id = v_shop);
  if v_shop is null then return; end if;
  delete from public.product_metrics where shop_id = v_shop;
  delete from public.store_metrics where shop_id = v_shop;
  delete from public.sync_checkpoints where shop_id = v_shop;
  delete from public.sync_runs where shop_id = v_shop;
  delete from public.return_line_items where shop_id = v_shop;
  delete from public.returns where shop_id = v_shop;
  delete from public.refunds where shop_id = v_shop;
  delete from public.order_line_items where shop_id = v_shop;
  delete from public.orders where shop_id = v_shop;
  delete from public.customers where shop_id = v_shop;
  delete from public.inventory_levels where shop_id = v_shop;
  delete from public.inventory_locations where shop_id = v_shop;
  delete from public.product_variants where shop_id = v_shop;
  delete from public.products where shop_id = v_shop;
  delete from public.metafields where shop_id = v_shop;
  delete from public.metaobjects where shop_id = v_shop;
  delete from public.metaobject_definitions where shop_id = v_shop;
  delete from public.shop_settings where shop_id = v_shop;
  delete from public.shop_access where shop_id = v_shop;
end;
$$;

create or replace function public.shop_synced_row_count(p_domain text)
returns bigint language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_domain text := public.normalize_shop_host(p_domain);
  v_shop uuid;
  v_inbox bigint;
begin
  if v_domain is null then return 0; end if;
  select id into v_shop from public.shops where myshopify_domain = v_domain;
  select count(*) into v_inbox from public.webhook_events where shop_domain = v_domain or (v_shop is not null and shop_id = v_shop);
  if v_shop is null then return v_inbox; end if;
  return v_inbox
       + (select count(*) from public.product_metrics where shop_id = v_shop)
       + (select count(*) from public.store_metrics where shop_id = v_shop)
       + (select count(*) from public.sync_checkpoints where shop_id = v_shop)
       + (select count(*) from public.sync_runs where shop_id = v_shop)
       + (select count(*) from public.products where shop_id = v_shop)
       + (select count(*) from public.product_variants where shop_id = v_shop)
       + (select count(*) from public.inventory_locations where shop_id = v_shop)
       + (select count(*) from public.inventory_levels where shop_id = v_shop)
       + (select count(*) from public.customers where shop_id = v_shop)
       + (select count(*) from public.orders where shop_id = v_shop)
       + (select count(*) from public.order_line_items where shop_id = v_shop)
       + (select count(*) from public.refunds where shop_id = v_shop)
       + (select count(*) from public.returns where shop_id = v_shop)
       + (select count(*) from public.return_line_items where shop_id = v_shop)
       + (select count(*) from public.metafields where shop_id = v_shop)
       + (select count(*) from public.metaobject_definitions where shop_id = v_shop)
       + (select count(*) from public.metaobjects where shop_id = v_shop)
       + (select count(*) from public.shop_settings where shop_id = v_shop)
       + (select count(*) from public.shop_access where shop_id = v_shop);
end;
$$;

revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;

alter table public.shops drop constraint shops_shop_key_key;
alter table public.shops drop column shop_key;
