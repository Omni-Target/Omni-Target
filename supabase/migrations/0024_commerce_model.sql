-- 0024: canonical commerce model (Phase 1, task 8).
--
-- Shopify data is mirrored per shop, not per workspace. Every row carries
-- shop_id and its Shopify ID, and (shop_id, shopify_id) is the primary key:
-- replayed imports are idempotent and one shop's IDs never meet another's. A
-- workspace reaches these rows only through its active binding (0018). After an
-- ownership transfer the shop's mirror serves the new owner; campaigns, credits
-- and history stay with the original workspace. shop/redact deletes every row.
--
-- Empty until Phase 2 ingestion, which writes these tables directly (batched
-- upserts on the primary key), so service_role may read and write them.
-- Ownership, lifecycle and credit tables keep their function-only writes.
--
-- Narrow typed columns; JSONB only for small, size-checked documents. No
-- customer name, email, phone or street address is stored. Fields Shopify
-- withholds without protected-data approval are nullable. Shopify enumerations
-- are stored lower-case and checked for shape, not against a fixed list, so a
-- new Shopify value never fails an import. Links between separately imported
-- domains (a line item's product, an inventory level's location) are not
-- foreign keys: a line item can outlive its product, and domains import in any
-- order. Additive: no existing row changes.

create table public.products (
  shop_id              uuid not null references public.shops (id),
  shopify_id           bigint not null check (shopify_id > 0),
  title                text not null check (char_length(title) <= 255),
  handle               text check (char_length(handle) <= 255),
  status               text not null check (status ~ '^[a-z][a-z_]{0,39}$'),
  product_type         text check (char_length(product_type) <= 255),
  vendor               text check (char_length(vendor) <= 255),
  category             text check (char_length(category) <= 512),
  tags                 text[] not null default '{}' check (cardinality(tags) <= 250),
  description_excerpt  text check (char_length(description_excerpt) <= 1000),
  is_gift_card         boolean not null default false,
  published_at         timestamptz,
  shopify_created_at   timestamptz,
  shopify_updated_at   timestamptz,
  synced_at            timestamptz not null default now(),
  primary key (shop_id, shopify_id)
);
create index products_status_idx on public.products (shop_id, status);

-- One inventory item per variant, so its fields live here.
create table public.product_variants (
  shop_id              uuid not null,
  shopify_id           bigint not null check (shopify_id > 0),
  product_shopify_id   bigint not null,
  title                text check (char_length(title) <= 255),
  sku                  text check (char_length(sku) <= 255),
  position             integer check (position >= 0),
  selected_options     jsonb not null default '[]' check (jsonb_typeof(selected_options) = 'array' and pg_column_size(selected_options) <= 2048),
  price                numeric(20, 4) not null check (price >= 0),
  compare_at_price     numeric(20, 4) check (compare_at_price >= 0),
  taxable              boolean,
  inventory_item_id    bigint check (inventory_item_id > 0),
  tracked              boolean,
  inventory_policy     text check (inventory_policy ~ '^[a-z][a-z_]{0,39}$'),
  inventory_quantity   integer,
  requires_shipping    boolean,
  weight               numeric(14, 4) check (weight >= 0),
  weight_unit          text check (weight_unit ~ '^[a-z][a-z_]{0,39}$'),
  unit_cost            numeric(20, 4) check (unit_cost >= 0),
  unit_cost_currency   text check (unit_cost_currency ~ '^[A-Z]{3}$'),
  country_of_origin    text check (country_of_origin ~ '^[A-Z]{2}$'),
  fulfillment_service  text check (char_length(fulfillment_service) <= 255),
  shopify_created_at   timestamptz,
  shopify_updated_at   timestamptz,
  synced_at            timestamptz not null default now(),
  primary key (shop_id, shopify_id),
  foreign key (shop_id, product_shopify_id) references public.products (shop_id, shopify_id) on delete cascade,
  check ((unit_cost is null) = (unit_cost_currency is null))
);
create index product_variants_product_idx on public.product_variants (shop_id, product_shopify_id);
create unique index product_variants_inventory_item_idx on public.product_variants (shop_id, inventory_item_id) where inventory_item_id is not null;

-- The merchant's own locations; country and province only.
create table public.inventory_locations (
  shop_id                 uuid not null references public.shops (id),
  shopify_id              bigint not null check (shopify_id > 0),
  name                    text not null check (char_length(name) <= 255),
  country_code            text check (country_code ~ '^[A-Z]{2}$'),
  province_code           text check (char_length(province_code) <= 16),
  is_active               boolean not null default true,
  fulfills_online_orders  boolean,
  is_fulfillment_service  boolean not null default false,
  synced_at               timestamptz not null default now(),
  primary key (shop_id, shopify_id)
);

create table public.inventory_levels (
  shop_id              uuid not null references public.shops (id),
  inventory_item_id    bigint not null check (inventory_item_id > 0),
  location_shopify_id  bigint not null check (location_shopify_id > 0),
  available            integer,
  on_hand              integer,
  shopify_updated_at   timestamptz,
  synced_at            timestamptz not null default now(),
  primary key (shop_id, inventory_item_id, location_shopify_id)
);

-- Minimised: no name, email, phone or address. The first order and its
-- products are kept, so first-purchase analysis survives order retention.
create table public.customers (
  shop_id                          uuid not null references public.shops (id),
  shopify_id                       bigint not null check (shopify_id > 0),
  country_code                     text check (country_code ~ '^[A-Z]{2}$'),
  orders_count                     integer check (orders_count >= 0),
  amount_spent                     numeric(20, 4) check (amount_spent >= 0),
  amount_spent_currency            text check (amount_spent_currency ~ '^[A-Z]{3}$'),
  first_order_at                   timestamptz,
  first_order_shopify_id           bigint check (first_order_shopify_id > 0),
  first_order_product_shopify_ids  bigint[] not null default '{}' check (cardinality(first_order_product_shopify_ids) <= 100),
  shopify_created_at               timestamptz,
  shopify_updated_at               timestamptz,
  synced_at                        timestamptz not null default now(),
  primary key (shop_id, shopify_id),
  check ((amount_spent is null) = (amount_spent_currency is null))
);

-- Amounts in the shop's currency. The destination is kept at city level at
-- most, and is null when Shopify withholds it.
create table public.orders (
  shop_id               uuid not null references public.shops (id),
  shopify_id            bigint not null check (shopify_id > 0),
  name                  text check (char_length(name) <= 64),
  shopify_created_at    timestamptz not null,
  processed_at          timestamptz not null,
  cancelled_at          timestamptz,
  financial_status      text check (financial_status ~ '^[a-z][a-z_]{0,39}$'),
  fulfillment_status    text check (fulfillment_status ~ '^[a-z][a-z_]{0,39}$'),
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  presentment_currency  text check (presentment_currency ~ '^[A-Z]{3}$'),
  subtotal              numeric(20, 4) not null default 0 check (subtotal >= 0),
  total_discounts       numeric(20, 4) not null default 0 check (total_discounts >= 0),
  total_tax             numeric(20, 4) not null default 0 check (total_tax >= 0),
  total_shipping        numeric(20, 4) not null default 0 check (total_shipping >= 0),
  total_price           numeric(20, 4) not null check (total_price >= 0),
  total_refunded        numeric(20, 4) not null default 0 check (total_refunded >= 0),
  customer_shopify_id   bigint check (customer_shopify_id > 0),
  ship_country_code     text check (ship_country_code ~ '^[A-Z]{2}$'),
  ship_province_code    text check (char_length(ship_province_code) <= 16),
  ship_city_raw         text check (char_length(ship_city_raw) <= 255),
  ship_city             text check (char_length(ship_city) <= 255),
  source_name           text check (char_length(source_name) <= 64),
  is_test               boolean not null default false,
  shopify_updated_at    timestamptz,
  synced_at             timestamptz not null default now(),
  primary key (shop_id, shopify_id)
);
create index orders_processed_idx on public.orders (shop_id, processed_at);
create index orders_customer_idx on public.orders (shop_id, customer_shopify_id, processed_at) where customer_shopify_id is not null;

-- Written with their order. The product and variant may since have been deleted.
create table public.order_line_items (
  shop_id              uuid not null,
  shopify_id           bigint not null check (shopify_id > 0),
  order_shopify_id     bigint not null,
  product_shopify_id   bigint check (product_shopify_id > 0),
  variant_shopify_id   bigint check (variant_shopify_id > 0),
  title                text check (char_length(title) <= 255),
  sku                  text check (char_length(sku) <= 255),
  quantity             integer not null check (quantity >= 0),
  current_quantity     integer check (current_quantity >= 0),
  refunded_quantity    integer not null default 0 check (refunded_quantity >= 0),
  unit_price           numeric(20, 4) not null check (unit_price >= 0),
  total_discount       numeric(20, 4) not null default 0 check (total_discount >= 0),
  primary key (shop_id, shopify_id),
  foreign key (shop_id, order_shopify_id) references public.orders (shop_id, shopify_id) on delete cascade
);
create index order_line_items_order_idx on public.order_line_items (shop_id, order_shopify_id);
create index order_line_items_product_idx on public.order_line_items (shop_id, product_shopify_id) where product_shopify_id is not null;

create table public.refunds (
  shop_id             uuid not null,
  shopify_id          bigint not null check (shopify_id > 0),
  order_shopify_id    bigint not null,
  shopify_created_at  timestamptz not null,
  total_refunded      numeric(20, 4) not null check (total_refunded >= 0),
  currency            text not null check (currency ~ '^[A-Z]{3}$'),
  primary key (shop_id, shopify_id),
  foreign key (shop_id, order_shopify_id) references public.orders (shop_id, shopify_id) on delete cascade
);
create index refunds_order_idx on public.refunds (shop_id, order_shopify_id);

-- A return can arrive before its order is imported, so the order is not a foreign key.
create table public.returns (
  shop_id             uuid not null references public.shops (id),
  shopify_id          bigint not null check (shopify_id > 0),
  order_shopify_id    bigint not null check (order_shopify_id > 0),
  name                text check (char_length(name) <= 64),
  status              text not null check (status ~ '^[a-z][a-z_]{0,39}$'),
  total_quantity      integer check (total_quantity >= 0),
  shopify_created_at  timestamptz,
  closed_at           timestamptz,
  synced_at           timestamptz not null default now(),
  primary key (shop_id, shopify_id)
);
create index returns_order_idx on public.returns (shop_id, order_shopify_id);

create table public.return_line_items (
  shop_id               uuid not null,
  shopify_id            bigint not null check (shopify_id > 0),
  return_shopify_id     bigint not null,
  line_item_shopify_id  bigint check (line_item_shopify_id > 0),
  quantity              integer not null check (quantity >= 0),
  return_reason         text check (return_reason ~ '^[a-z][a-z_]{0,39}$'),
  primary key (shop_id, shopify_id),
  foreign key (shop_id, return_shopify_id) references public.returns (shop_id, shopify_id) on delete cascade
);
create index return_line_items_return_idx on public.return_line_items (shop_id, return_shopify_id);
create index return_line_items_line_item_idx on public.return_line_items (shop_id, line_item_shopify_id) where line_item_shopify_id is not null;

-- Metafields and metaobjects are kept distinct. Only the namespaces and keys
-- the product needs are imported, as a bounded excerpt.
create table public.metafields (
  shop_id             uuid not null references public.shops (id),
  owner_type          text not null check (owner_type in ('product', 'variant', 'shop')),
  owner_shopify_id    bigint not null check (owner_shopify_id > 0),
  namespace           text not null check (char_length(namespace) between 1 and 255),
  key                 text not null check (char_length(key) between 1 and 64),
  type                text not null check (char_length(type) between 1 and 64),
  value_excerpt       text check (char_length(value_excerpt) <= 2000),
  value_truncated     boolean not null default false,
  shopify_updated_at  timestamptz,
  synced_at           timestamptz not null default now(),
  primary key (shop_id, owner_type, owner_shopify_id, namespace, key)
);

create table public.metaobject_definitions (
  shop_id            uuid not null references public.shops (id),
  shopify_id         bigint not null check (shopify_id > 0),
  type               text not null check (char_length(type) between 1 and 255),
  name               text check (char_length(name) <= 255),
  field_definitions  jsonb not null default '[]' check (jsonb_typeof(field_definitions) = 'array' and pg_column_size(field_definitions) <= 16384),
  synced_at          timestamptz not null default now(),
  primary key (shop_id, shopify_id),
  unique (shop_id, type)
);

-- Only the types products reference.
create table public.metaobjects (
  shop_id             uuid not null references public.shops (id),
  shopify_id          bigint not null check (shopify_id > 0),
  type                text not null check (char_length(type) between 1 and 255),
  handle              text check (char_length(handle) <= 255),
  display_name        text check (char_length(display_name) <= 255),
  fields              jsonb not null default '{}' check (jsonb_typeof(fields) = 'object' and pg_column_size(fields) <= 8192),
  shopify_updated_at  timestamptz,
  synced_at           timestamptz not null default now(),
  primary key (shop_id, shopify_id)
);
create index metaobjects_type_idx on public.metaobjects (shop_id, type);

create table public.shop_settings (
  shop_id             uuid primary key references public.shops (id),
  currency            text check (currency ~ '^[A-Z]{3}$'),
  timezone            text check (char_length(timezone) <= 64),
  country_code        text check (country_code ~ '^[A-Z]{2}$'),
  province_code       text check (char_length(province_code) <= 16),
  primary_locale      text check (char_length(primary_locale) <= 16),
  enabled_locales     text[] not null default '{}' check (cardinality(enabled_locales) <= 100),
  shopify_plan        text check (char_length(shopify_plan) <= 64),
  markets             jsonb not null default '[]' check (jsonb_typeof(markets) = 'array' and pg_column_size(markets) <= 16384),
  delivery_summary    jsonb not null default '{}' check (jsonb_typeof(delivery_summary) = 'object' and pg_column_size(delivery_summary) <= 16384),
  policies            jsonb not null default '{}' check (jsonb_typeof(policies) = 'object' and pg_column_size(policies) <= 16384),
  shopify_updated_at  timestamptz,
  synced_at           timestamptz not null default now()
);

-- What the shop lets us read: granted scopes, each data domain's availability
-- (available, partial or inaccessible, with reasons) and every field Shopify
-- withheld. Shown to the merchant; an import never proceeds silently without it.
create table public.shop_access (
  shop_id          uuid primary key references public.shops (id),
  granted_scopes   text[] not null default '{}' check (cardinality(granted_scopes) <= 100),
  domains          jsonb not null default '{}' check (jsonb_typeof(domains) = 'object' and pg_column_size(domains) <= 8192),
  withheld_fields  jsonb not null default '{}' check (jsonb_typeof(withheld_fields) = 'object' and pg_column_size(withheld_fields) <= 16384),
  checked_at       timestamptz not null default now()
);

-- Every row mirrored from one shop, removed when the shop's data is deleted.
create or replace function public.delete_shop_synced_data(p_domain text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_shop uuid;
begin
  select id into v_shop from public.shops where myshopify_domain = public.normalize_shop_host(p_domain);
  if v_shop is null then return; end if;
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

-- Rows still mirrored from one shop; a deletion is verified only at zero.
create or replace function public.shop_synced_row_count(p_domain text)
returns bigint language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_shop uuid;
begin
  select id into v_shop from public.shops where myshopify_domain = public.normalize_shop_host(p_domain);
  if v_shop is null then return 0; end if;
  return (select count(*) from public.products where shop_id = v_shop)
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

-- 0018's deletion, changed in two places: the shop's mirrored data is deleted
-- with its other Shopify-derived data, and verification requires none left.
create or replace function public.process_workspace_deletion(p_deletion uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_deletion public.workspace_deletions%rowtype;
  v_ws public.workspaces%rowtype;
  v_shop uuid;
  v_domain text;
  v_remaining jsonb;
begin
  select * into v_deletion from public.workspace_deletions where id = p_deletion for update;
  if not found then raise exception 'deletion_not_found'; end if;
  if v_deletion.status = 'completed' then return jsonb_build_object('outcome', 'completed', 'workspace_id', v_deletion.workspace_id); end if;
  update public.workspace_deletions set attempts = attempts + 1, started_at = coalesce(started_at, now()) where id = p_deletion;

  select * into v_ws from public.workspaces where id = v_deletion.workspace_id for update;
  select s.id, s.myshopify_domain into v_shop, v_domain from public.shop_bindings b join public.shops s on s.id = b.shop_id
   where b.workspace_id = v_ws.id and b.released_at is null;

  begin
    if v_domain is not null then
      perform public.redact_shop_data(v_domain);
      perform public.delete_shop_synced_data(v_domain);
    end if;
    delete from public.campaign_brief_versions where campaign_id in (select id from public.campaigns where workspace_id = v_ws.id);
    delete from public.campaigns where workspace_id = v_ws.id;

    v_remaining := jsonb_build_object(
      'integration_rows_naming_shop', (select count(*) from public.user_integrations
         where v_domain is not null and v_domain in (public.normalize_shop_host(shop_domain), public.normalize_shop_host(shopify_store_url))),
      'workspace_campaigns', (select count(*) from public.campaigns where workspace_id = v_ws.id),
      'capi_events', (select count(*) from public.capi_events where v_domain is not null and shop_domain = v_domain),
      'webhook_deliveries', (select count(*) from public.webhook_deliveries where v_domain is not null and shop_domain = v_domain),
      'shop_synced_rows', public.shop_synced_row_count(v_domain));
    if exists (select 1 from jsonb_each_text(v_remaining) where value::int > 0) then
      raise exception 'deletion_verification_failed';
    end if;
  exception when others then
    update public.workspace_deletions set status = 'failed', last_error = sqlerrm, verification = v_remaining where id = p_deletion;
    return jsonb_build_object('outcome', 'failed', 'error', sqlerrm, 'workspace_id', v_ws.id);
  end;

  update public.shop_bindings set released_at = now(), release_reason = 'deletion_completed'
   where workspace_id = v_ws.id and released_at is null;
  update public.workspaces set status = 'deleted', status_changed_at = now(), deleted_at = now() where id = v_ws.id;
  update public.workspace_deletions set status = 'completed', completed_at = now(), verification = v_remaining, last_error = null where id = p_deletion;
  update public.compliance_requests set status = 'completed', completed_at = now(), resolution = 'shop_data_deleted'
   where workspace_id = v_ws.id and status <> 'completed';
  perform public.log_workspace_event(v_ws.id, v_shop, 'deletion_verified', null, 'system', null, v_remaining);
  perform public.log_workspace_event(v_ws.id, v_shop, 'deleted', null, 'system', null, '{}'::jsonb);
  return jsonb_build_object('outcome', 'completed', 'workspace_id', v_ws.id, 'verification', v_remaining);
end;
$$;

-- 0018's unbound redaction, changed in the same two places.
create or replace function public.process_unbound_shop_redact(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request public.compliance_requests%rowtype;
  v_remaining integer;
begin
  select * into v_request from public.compliance_requests where id = p_request and topic = 'shop/redact' for update;
  if not found then raise exception 'compliance_request_not_found'; end if;
  if v_request.status = 'completed' then return jsonb_build_object('outcome', 'completed'); end if;
  if v_request.workspace_id is not null then return jsonb_build_object('outcome', 'has_workspace'); end if;
  perform public.redact_shop_data(v_request.shop_domain);
  perform public.delete_shop_synced_data(v_request.shop_domain);
  select count(*) + public.shop_synced_row_count(v_request.shop_domain) into v_remaining from public.user_integrations
   where v_request.shop_domain in (public.normalize_shop_host(shop_domain), public.normalize_shop_host(shopify_store_url));
  if v_remaining > 0 then
    update public.compliance_requests set status = 'processing' where id = p_request;
    return jsonb_build_object('outcome', 'failed', 'remaining', v_remaining);
  end if;
  update public.compliance_requests set status = 'completed', completed_at = now(), resolution = 'legacy_shop_data_deleted' where id = p_request;
  return jsonb_build_object('outcome', 'completed');
end;
$$;

alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.inventory_locations enable row level security;
alter table public.inventory_levels enable row level security;
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.order_line_items enable row level security;
alter table public.refunds enable row level security;
alter table public.returns enable row level security;
alter table public.return_line_items enable row level security;
alter table public.metafields enable row level security;
alter table public.metaobject_definitions enable row level security;
alter table public.metaobjects enable row level security;
alter table public.shop_settings enable row level security;
alter table public.shop_access enable row level security;

revoke all on table public.products, public.product_variants, public.inventory_locations, public.inventory_levels,
  public.customers, public.orders, public.order_line_items, public.refunds, public.returns, public.return_line_items,
  public.metafields, public.metaobject_definitions, public.metaobjects, public.shop_settings, public.shop_access
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.products, public.product_variants, public.inventory_locations, public.inventory_levels,
  public.customers, public.orders, public.order_line_items, public.refunds, public.returns, public.return_line_items,
  public.metafields, public.metaobject_definitions, public.metaobjects, public.shop_settings, public.shop_access
  to service_role;

-- Internal: reached only through the deletion functions above.
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;
