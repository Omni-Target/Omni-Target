-- Phase 3, task 5: shop context in the database.
--
-- The insights worker read shop details and the pre-spend datasets from Shopify each time it built a
-- shop's snapshot. A background sync (shop-context-refresh, after imports, and when the worker finds the
-- context missing or more than a day old) now reads them and stores them here, so building a snapshot
-- reads only the database:
--  - shop_settings (created empty in 0024): name, primary domain, currency and money format, timezone,
--    country and province (the shop's address, as REST gave it), plan, weight unit, taxes included, the
--    storefront logo, locales, markets, delivery zones and policies (each policy's text bounded);
--  - shop_context (new): the ShopifyQL analytics snapshot, active discounts, recent marketing history,
--    all locales, and each dataset's status (available, partial, missing scope, error) with the warnings
--    the read produced, and when it was read.
-- Locations come from inventory_locations (task 3) and granted scopes from shop_access (Phase 2).

alter table public.shop_settings
  add column fields_version       smallint check (fields_version > 0),
  add column name                 text check (char_length(name) <= 255),
  add column primary_domain       text check (char_length(primary_domain) <= 255),
  add column money_format         text check (char_length(money_format) <= 64),
  add column shopify_plus         boolean,
  add column partner_development  boolean,
  add column weight_unit          text check (weight_unit ~ '^[a-z][a-z_]{0,39}$'),
  add column taxes_included       boolean,
  add column logo_url             text check (char_length(logo_url) <= 1024);

create table public.shop_context (
  shop_key       integer primary key references public.shops (shop_key),
  fields_version smallint not null check (fields_version > 0),
  capabilities   jsonb not null default '{}' check (jsonb_typeof(capabilities) = 'object' and pg_column_size(capabilities) <= 8192),
  analytics      jsonb check (jsonb_typeof(analytics) = 'object' and pg_column_size(analytics) <= 16384),
  discounts      jsonb not null default '[]' check (jsonb_typeof(discounts) = 'array' and pg_column_size(discounts) <= 16384),
  marketing      jsonb not null default '[]' check (jsonb_typeof(marketing) = 'array' and pg_column_size(marketing) <= 16384),
  locales        jsonb not null default '[]' check (jsonb_typeof(locales) = 'array' and pg_column_size(locales) <= 8192),
  warnings       text[] not null default '{}' check (cardinality(warnings) <= 20),
  synced_at      timestamptz not null default now()
);
alter table public.shop_context enable row level security;
revoke all on table public.shop_context from public, anon, authenticated, service_role;
grant select on table public.shop_context to service_role;

-- Settings and context as one write, for a shop still ingestible.
create or replace function public.save_shop_context(p_shop_key integer, p_settings jsonb, p_context jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s record;
  c record;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  select * into s from jsonb_to_record(coalesce(p_settings, '{}')) as x(fields_version smallint, name text, primary_domain text, currency text,
    money_format text, timezone text, country_code text, province_code text, primary_locale text, enabled_locales text[], shopify_plan text,
    shopify_plus boolean, partner_development boolean, weight_unit text, taxes_included boolean, logo_url text, markets jsonb,
    delivery_summary jsonb, policies jsonb);
  select * into c from jsonb_to_record(coalesce(p_context, '{}')) as x(fields_version smallint, capabilities jsonb, analytics jsonb,
    discounts jsonb, marketing jsonb, locales jsonb, warnings text[]);

  insert into public.shop_settings as t (shop_key, fields_version, name, primary_domain, currency, money_format, timezone, country_code, province_code,
    primary_locale, enabled_locales, shopify_plan, shopify_plus, partner_development, weight_unit, taxes_included, logo_url, markets,
    delivery_summary, policies, synced_at)
  values (p_shop_key, s.fields_version, s.name, s.primary_domain, s.currency, s.money_format, s.timezone, s.country_code, s.province_code,
    s.primary_locale, coalesce(s.enabled_locales, '{}'), s.shopify_plan, s.shopify_plus, s.partner_development, s.weight_unit, s.taxes_included,
    s.logo_url, coalesce(s.markets, '[]'), coalesce(s.delivery_summary, '{}'), coalesce(s.policies, '{}'), now())
  on conflict (shop_key) do update set
    fields_version = excluded.fields_version, name = excluded.name, primary_domain = excluded.primary_domain, currency = excluded.currency,
    money_format = excluded.money_format, timezone = excluded.timezone, country_code = excluded.country_code, province_code = excluded.province_code,
    primary_locale = excluded.primary_locale, enabled_locales = excluded.enabled_locales, shopify_plan = excluded.shopify_plan,
    shopify_plus = excluded.shopify_plus, partner_development = excluded.partner_development, weight_unit = excluded.weight_unit,
    taxes_included = excluded.taxes_included,
    -- A logo the storefront did not give this time keeps the last one found.
    logo_url = coalesce(excluded.logo_url, t.logo_url),
    markets = excluded.markets, delivery_summary = excluded.delivery_summary, policies = excluded.policies, synced_at = now();

  insert into public.shop_context as t (shop_key, fields_version, capabilities, analytics, discounts, marketing, locales, warnings, synced_at)
  values (p_shop_key, coalesce(c.fields_version, 1), coalesce(c.capabilities, '{}'), c.analytics, coalesce(c.discounts, '[]'),
    coalesce(c.marketing, '[]'), coalesce(c.locales, '[]'), coalesce(c.warnings, '{}'), now())
  on conflict (shop_key) do update set
    fields_version = excluded.fields_version, capabilities = excluded.capabilities, analytics = excluded.analytics, discounts = excluded.discounts,
    marketing = excluded.marketing, locales = excluded.locales, warnings = excluded.warnings, synced_at = now();

  return jsonb_build_object('saved', true);
end;
$$;

-- What the read path needs about the shop: settings, context, its locations and granted scopes.
create or replace function public.insight_shop_context(p_shop_key integer)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'settings', (select to_jsonb(t) - 'shop_key' from public.shop_settings t where t.shop_key = p_shop_key),
    'context', (select to_jsonb(t) - 'shop_key' from public.shop_context t where t.shop_key = p_shop_key),
    'myshopify_domain', (select myshopify_domain from public.shops where shop_key = p_shop_key),
    'granted_scopes', coalesce((select to_jsonb(a.granted_scopes) from public.shop_access a where a.shop_key = p_shop_key), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.shopify_id, 'name', l.name, 'fulfills_online_orders', l.fulfills_online_orders,
                            'has_active_inventory', l.has_active_inventory, 'is_active', l.is_active) order by l.shopify_id)
                             from public.inventory_locations l where l.shop_key = p_shop_key), '[]'::jsonb));
$$;

-- Imported, ingestible shops (as the insights schedule picks them) whose context is missing or older than
-- p_max_age_seconds (default 20 hours).
create or replace function public.shops_context_due(p_max_age_seconds integer default 72000, p_limit integer default 100)
returns table (shop_domain text, synced_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.myshopify_domain, c.synced_at
    from public.shops s
    left join public.shop_context c on c.shop_key = s.shop_key
   where public.summary_maintenance_ready(s.shop_key)
     and (c.shop_key is null or c.synced_at < now() - make_interval(secs => greatest(coalesce(p_max_age_seconds, 72000), 60)))
   order by c.synced_at nulls first, s.shop_key
   limit least(greatest(coalesce(p_limit, 100), 1), 1000);
$$;

-- 0047's deletion helpers, with the shop context.
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
  delete from public.shop_context where shop_key = v_key;
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
       + (select count(*) from public.shop_context where shop_key = v_key)
       + (select count(*) from public.shop_access where shop_key = v_key);
end;
$$;
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;

revoke all on function public.save_shop_context(integer, jsonb, jsonb), public.insight_shop_context(integer), public.shops_context_due(integer, integer)
  from public, anon, authenticated;
grant execute on function public.save_shop_context(integer, jsonb, jsonb), public.insight_shop_context(integer), public.shops_context_due(integer, integer)
  to service_role;
