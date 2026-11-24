-- Phase 4, task 2: the economics policy and the merchant's own inputs (architecture/phase-4-economics.md).
--
--  - economics_policies: the versioned business policy the engine applies (contribution reserve, test sizes,
--    evidence thresholds, maturity windows, scaling limits). A version is immutable once written; a change is a
--    new version. Exactly one version is active. Every recommendation records the version it used. Version 1
--    holds the conservative defaults proposed for CEO approval (approval = 'pending').
--  - economics_input_keys: the catalogue of what a merchant can enter, with each key's kind, scopes, allowed
--    states and range, so the database rejects anything else.
--  - merchant_economics_inputs: the merchant's cost inputs and spending limits, for the whole shop
--    (product_shopify_id = 0) or one product (an override). Each value keeps its state (entered, confirmed none,
--    or an estimate), its currency for money, who entered it and when. A missing row means unknown: the engine
--    never reads it as zero.

create table public.economics_policies (
  version      integer primary key check (version > 0),
  settings     jsonb not null check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 8192),
  rationale    jsonb not null check (jsonb_typeof(rationale) = 'object' and pg_column_size(rationale) <= 16384),
  status       text not null check (status in ('draft', 'active', 'retired')),
  approval     text not null default 'pending' check (approval in ('pending', 'approved')),
  approved_by  text check (char_length(approved_by) <= 128),
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  activated_at timestamptz,
  check ((approval = 'approved') = (approved_at is not null))
);
create unique index economics_policies_one_active on public.economics_policies ((status)) where status = 'active';

-- Every setting the engine reads, with its range. A version missing one, or holding one out of range, is refused.
create or replace function public.economics_policy_settings_valid(p jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select jsonb_typeof(p) = 'object'
     and (select bool_and(p ? k) from unnest(array[
           'contribution_reserve', 'pilot_conversions', 'test_conversions', 'min_test_conversions', 'scale_step',
           'scale_interval_days', 'min_scale_conversions', 'min_judgement_spend_multiple', 'high_confidence_orders',
           'medium_confidence_orders', 'sales_window_days', 'discount_window_days', 'product_discount_min_orders',
           'product_refund_min_matured_orders', 'store_proxy_min_matured_orders', 'return_maturity_days',
           'established_demand_orders', 'established_demand_window_days', 'proven_conversions', 'acquisition_window_days',
           'attribution_lag_days', 'decision_confidence', 'merchant_inputs_stale_days', 'inventory_stale_hours',
           'inventory_cover_days', 'default_test_days', 'max_test_days', 'material_change_threshold',
           'portfolio_period_days', 'count_incoming_inventory', 'reserve_organic_demand', 'allow_cost_estimates']) as k)
     and (p->>'contribution_reserve')::numeric >= 0 and (p->>'contribution_reserve')::numeric < 1
     and (p->>'scale_step')::numeric > 0 and (p->>'scale_step')::numeric <= 1
     and (p->>'decision_confidence')::numeric >= 0.5 and (p->>'decision_confidence')::numeric < 1
     and (p->>'material_change_threshold')::numeric > 0 and (p->>'material_change_threshold')::numeric < 1
     and (p->>'min_judgement_spend_multiple')::numeric > 0
     and (select bool_and((p->>k)::numeric = trunc((p->>k)::numeric) and (p->>k)::numeric >= 1) from unnest(array[
           'pilot_conversions', 'test_conversions', 'min_test_conversions', 'scale_interval_days', 'min_scale_conversions',
           'high_confidence_orders', 'medium_confidence_orders', 'sales_window_days', 'discount_window_days',
           'product_discount_min_orders', 'product_refund_min_matured_orders', 'store_proxy_min_matured_orders',
           'return_maturity_days', 'established_demand_orders', 'established_demand_window_days', 'proven_conversions',
           'acquisition_window_days', 'attribution_lag_days', 'merchant_inputs_stale_days', 'inventory_stale_hours',
           'inventory_cover_days', 'default_test_days', 'max_test_days', 'portfolio_period_days']) as k)
     and (p->>'min_test_conversions')::numeric <= (p->>'pilot_conversions')::numeric
     and (p->>'pilot_conversions')::numeric <= (p->>'test_conversions')::numeric
     and (p->>'medium_confidence_orders')::numeric <= (p->>'high_confidence_orders')::numeric
     and (p->>'default_test_days')::numeric <= (p->>'max_test_days')::numeric
     and jsonb_typeof(p->'count_incoming_inventory') = 'boolean'
     and jsonb_typeof(p->'reserve_organic_demand') = 'boolean'
     and jsonb_typeof(p->'allow_cost_estimates') = 'boolean';
$$;
alter table public.economics_policies add constraint economics_policies_settings_valid check (public.economics_policy_settings_valid(settings));

-- A written version never changes: only its status and approval move.
create or replace function public.economics_policies_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.version <> old.version or new.settings <> old.settings or new.rationale <> old.rationale or new.created_at <> old.created_at then
    raise exception 'economics_policy_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger economics_policies_immutable before update on public.economics_policies
  for each row execute function public.economics_policies_immutable();

insert into public.economics_policies (version, settings, rationale, status, activated_at) values (1,
  '{
    "contribution_reserve": 0.30,
    "pilot_conversions": 10, "test_conversions": 20, "min_test_conversions": 5,
    "scale_step": 0.20, "scale_interval_days": 3, "min_scale_conversions": 20, "min_judgement_spend_multiple": 1.0,
    "high_confidence_orders": 30, "medium_confidence_orders": 10,
    "sales_window_days": 365, "discount_window_days": 180, "product_discount_min_orders": 10,
    "product_refund_min_matured_orders": 20, "store_proxy_min_matured_orders": 50, "return_maturity_days": 60,
    "established_demand_orders": 10, "established_demand_window_days": 180,
    "proven_conversions": 20, "acquisition_window_days": 90, "attribution_lag_days": 7, "decision_confidence": 0.90,
    "merchant_inputs_stale_days": 180, "inventory_stale_hours": 48, "inventory_cover_days": 7,
    "default_test_days": 14, "max_test_days": 30, "material_change_threshold": 0.05, "portfolio_period_days": 30,
    "count_incoming_inventory": false, "reserve_organic_demand": true, "allow_cost_estimates": false
  }'::jsonb,
  '{
    "contribution_reserve": "Share of each sale''s contribution kept after advertising. 30% turns a $30 break-even CPA into a $21 target.",
    "pilot_conversions": "A pilot is sized to buy this many sales at the target CPA: enough to see whether sales happen, not enough to scale on.",
    "test_conversions": "A controlled test (GO) is sized to buy this many sales at the target CPA, giving a CPA estimate within roughly ±45% at 90%.",
    "min_test_conversions": "Below this many sales at the target CPA a test cannot tell a working product from a failing one, so no budget is recommended.",
    "scale_step": "Largest single budget increase: gradual enough not to reset the platform''s learning, and reversible.",
    "scale_interval_days": "Minimum days between budget increases.",
    "min_scale_conversions": "Matured sales needed before any increase.",
    "min_judgement_spend_multiple": "Matured spend, in break-even CPAs, before a campaign is judged at all.",
    "high_confidence_orders": "Product orders in the sales window for high economics confidence.",
    "medium_confidence_orders": "Product orders in the sales window for medium economics confidence; fewer is low.",
    "sales_window_days": "Detailed orders used for sales, units and variant mix.",
    "discount_window_days": "Recent orders used for the product''s discount rate.",
    "product_discount_min_orders": "Product orders in the discount window before its own discount rate is used.",
    "product_refund_min_matured_orders": "Matured product orders before its own refund rate is used.",
    "store_proxy_min_matured_orders": "Matured store orders before the store-wide rate may stand in for a product''s.",
    "return_maturity_days": "Orders younger than this may still be refunded, so they are left out of refund and return rates.",
    "established_demand_orders": "Product orders that establish demand without campaign results.",
    "established_demand_window_days": "Window for established demand.",
    "proven_conversions": "Matured campaign sales that prove acquisition for a product.",
    "acquisition_window_days": "Window for campaign results.",
    "attribution_lag_days": "Days a conversion may take to be attributed (Meta''s default 7-day click window); younger days are immature.",
    "decision_confidence": "One-sided confidence for pausing, scaling and maximum viable CPA.",
    "merchant_inputs_stale_days": "Merchant inputs older than this lower confidence to medium.",
    "inventory_stale_hours": "Inventory read longer ago than this lowers confidence to medium.",
    "inventory_cover_days": "Days of expected campaign orders the stock must cover.",
    "default_test_days": "Default test length.",
    "max_test_days": "Longest a test may stretch when the daily limit is binding.",
    "material_change_threshold": "A price or cost change beyond this share triggers recalculation.",
    "portfolio_period_days": "Period the monthly advertising limit covers.",
    "count_incoming_inventory": "Incoming stock has no arrival date in Shopify, so it is not counted as sellable.",
    "reserve_organic_demand": "Stock expected to sell without ads during the test is reserved before any is counted for ads.",
    "allow_cost_estimates": "No industry average stands in for a merchant''s cost: each cost is entered or confirmed."
  }'::jsonb,
  'active', now());

create table public.economics_input_keys (
  key           text primary key check (key ~ '^[a-z][a-z_]{1,47}$'),
  kind          text not null check (kind in ('rate', 'money', 'flag')),
  shop_scope    boolean not null,
  product_scope boolean not null,
  states        text[] not null check (states <@ array['merchant_entered', 'confirmed_none', 'merchant_estimate'] and cardinality(states) > 0),
  min_value     numeric not null default 0,
  max_value     numeric,
  description   text not null,
  check (shop_scope or product_scope)
);
insert into public.economics_input_keys (key, kind, shop_scope, product_scope, states, max_value, description) values
  ('payment_rate',              'rate',  true,  false, '{merchant_entered,confirmed_none}',  0.2,  'Payment processing rate on the amount charged'),
  ('payment_fixed_fee',         'money', true,  false, '{merchant_entered,confirmed_none}',  null, 'Fixed payment fee per order'),
  ('selling_fee_rate',          'rate',  true,  false, '{merchant_entered,confirmed_none}',  0.5,  'Other variable selling fees as a share of net revenue'),
  ('shipping_cost_per_order',   'money', true,  true,  '{merchant_entered,confirmed_none}',  null, 'What the merchant pays to ship one order'),
  ('fulfilment_cost_per_order', 'money', true,  true,  '{merchant_entered,confirmed_none}',  null, 'Pick, pack and fulfilment cost per order'),
  ('fulfilment_cost_per_unit',  'money', true,  true,  '{merchant_entered,confirmed_none}',  null, 'Fulfilment cost per unit'),
  ('landed_cost_rate',          'rate',  true,  true,  '{merchant_entered,confirmed_none}',  5,    'Freight, duties and other landed costs not in the unit cost, as a share of it'),
  ('landed_cost_per_unit',      'money', false, true,  '{merchant_entered,confirmed_none}',  null, 'Landed costs not in the unit cost, per unit'),
  ('return_handling_cost',      'money', true,  true,  '{merchant_entered,confirmed_none}',  null, 'Cost of handling one return, including return shipping the merchant pays'),
  ('expected_discount_rate',    'rate',  true,  true,  '{merchant_estimate}',               1,    'Discount rate the merchant expects, used only without product or store history'),
  ('expected_refund_rate',      'rate',  true,  true,  '{merchant_estimate}',               1,    'Share of revenue the merchant expects to refund, used only without history'),
  ('expected_return_rate',      'rate',  true,  true,  '{merchant_estimate}',               1,    'Returns per order the merchant expects, used only without history'),
  ('ad_monthly_limit',          'money', true,  false, '{merchant_entered}',                null, 'Most the merchant authorises on advertising across all products per period'),
  ('ad_test_limit',             'money', true,  true,  '{merchant_entered}',                null, 'Most the merchant authorises for one product test'),
  ('ad_daily_limit',            'money', true,  true,  '{merchant_entered}',                null, 'Most the merchant authorises per day for one product'),
  ('ad_max_loss',               'money', true,  true,  '{merchant_entered}',                null, 'Most the merchant will lose on one test before it stops'),
  ('advertising_excluded',      'flag',  false, true,  '{merchant_entered}',                1,    'The merchant does not want this product advertised');

create table public.merchant_economics_inputs (
  shop_key           integer not null references public.shops (shop_key),
  -- 0: the whole shop; otherwise an override for one product.
  product_shopify_id bigint not null default 0 check (product_shopify_id >= 0),
  key                text not null references public.economics_input_keys (key),
  value              numeric not null check (value >= 0),
  state              text not null check (state in ('merchant_entered', 'confirmed_none', 'merchant_estimate')),
  currency           text check (currency ~ '^[A-Z]{3}$'),
  entered_by         text not null check (char_length(entered_by) between 1 and 128),
  entered_at         timestamptz not null default now(),
  primary key (shop_key, product_shopify_id, key),
  check (state <> 'confirmed_none' or value = 0)
);
alter table public.economics_policies enable row level security;
alter table public.economics_input_keys enable row level security;
alter table public.merchant_economics_inputs enable row level security;
revoke all on table public.economics_policies, public.economics_input_keys, public.merchant_economics_inputs
  from public, anon, authenticated, service_role;
grant select on table public.economics_policies, public.economics_input_keys, public.merchant_economics_inputs to service_role;

-- Save or clear a merchant's inputs, all or none. Each element: {product_id (0 or absent: the shop), key,
-- value, state}; state 'cleared' removes the value (it becomes unknown again). Money is in the shop's currency.
create or replace function public.save_economics_inputs(p_shop_key integer, p_inputs jsonb, p_entered_by text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_currency text;
  e record;
  k public.economics_input_keys%rowtype;
  v_saved integer := 0;
  v_cleared integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if jsonb_typeof(p_inputs) is distinct from 'array' or jsonb_array_length(p_inputs) > 500 then
    raise exception 'economics_inputs_invalid: an array of at most 500 inputs' using errcode = 'P0001';
  end if;
  if p_entered_by is null or char_length(p_entered_by) not between 1 and 128 then
    raise exception 'economics_inputs_invalid: entered_by' using errcode = 'P0001';
  end if;
  select currency into v_currency from public.shop_settings where shop_key = p_shop_key;

  for e in select coalesce((x->>'product_id')::bigint, 0) as product_id, x->>'key' as key, x->'value' as value, x->>'state' as state
             from jsonb_array_elements(p_inputs) x loop
    select * into k from public.economics_input_keys where key = e.key;
    if not found then raise exception 'economics_inputs_invalid: unknown key %', e.key using errcode = 'P0001'; end if;
    if e.product_id < 0 or (e.product_id = 0 and not k.shop_scope) or (e.product_id > 0 and not k.product_scope) then
      raise exception 'economics_inputs_invalid: % is not set at this scope', e.key using errcode = 'P0001';
    end if;
    if e.state = 'cleared' then
      delete from public.merchant_economics_inputs
       where shop_key = p_shop_key and product_shopify_id = e.product_id and key = e.key;
      v_cleared := v_cleared + 1;
      continue;
    end if;
    if e.state is null or not (e.state = any (k.states)) then
      raise exception 'economics_inputs_invalid: % cannot be %', e.key, coalesce(e.state, 'null') using errcode = 'P0001';
    end if;
    if jsonb_typeof(e.value) is distinct from 'number' then
      raise exception 'economics_inputs_invalid: % needs a number', e.key using errcode = 'P0001';
    end if;
    if (e.value)::numeric < k.min_value or (k.max_value is not null and (e.value)::numeric > k.max_value)
       or (e.state = 'confirmed_none' and (e.value)::numeric <> 0)
       or (k.kind = 'flag' and (e.value)::numeric <> 1) then
      raise exception 'economics_inputs_invalid: % out of range', e.key using errcode = 'P0001';
    end if;
    if k.kind = 'money' and v_currency is null then
      raise exception 'economics_inputs_invalid: the shop''s currency is not known yet' using errcode = 'P0001';
    end if;
    insert into public.merchant_economics_inputs as t (shop_key, product_shopify_id, key, value, state, currency, entered_by, entered_at)
    values (p_shop_key, e.product_id, e.key, (e.value)::numeric, e.state, case when k.kind = 'money' then v_currency end, p_entered_by, now())
    on conflict (shop_key, product_shopify_id, key) do update set
      value = excluded.value, state = excluded.state, currency = excluded.currency, entered_by = excluded.entered_by, entered_at = now();
    v_saved := v_saved + 1;
  end loop;

  if (select count(*) from public.merchant_economics_inputs where shop_key = p_shop_key) > 20000 then
    raise exception 'economics_inputs_invalid: more than 20,000 inputs for one shop' using errcode = 'P0001';
  end if;
  return jsonb_build_object('saved', v_saved, 'cleared', v_cleared);
end;
$$;

-- The shop's currency and its inputs: shop-wide, plus overrides for the given products (at most 1,000).
create or replace function public.economics_inputs(p_shop_key integer, p_product_ids bigint[] default '{}')
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'currency', (select currency from public.shop_settings where shop_key = p_shop_key),
    'inputs', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', i.product_shopify_id, 'key', i.key, 'value', i.value, 'state', i.state,
                                          'currency', i.currency, 'entered_by', i.entered_by, 'entered_at', i.entered_at)
                       order by i.product_shopify_id, i.key)
        from public.merchant_economics_inputs i
       where i.shop_key = p_shop_key
         and (i.product_shopify_id = 0 or i.product_shopify_id = any (coalesce(p_product_ids[1:1000], '{}')))), '[]'::jsonb));
$$;

-- A policy version (the active one when p_version is null), as the engine reads it.
create or replace function public.economics_policy(p_version integer default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('version', p.version, 'settings', p.settings, 'rationale', p.rationale, 'status', p.status,
                            'approval', p.approval, 'approved_by', p.approved_by, 'approved_at', p.approved_at, 'activated_at', p.activated_at)
    from public.economics_policies p
   where (p_version is null and p.status = 'active') or p.version = p_version;
$$;

-- 0048's deletion helpers, with the merchant's economics inputs.
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
  delete from public.merchant_economics_inputs where shop_key = v_key;
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
       + (select count(*) from public.shop_access where shop_key = v_key)
       + (select count(*) from public.merchant_economics_inputs where shop_key = v_key);
end;
$$;
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;

revoke all on function public.economics_policy_settings_valid(jsonb), public.economics_policies_immutable()
  from public, anon, authenticated, service_role;
revoke all on function public.save_economics_inputs(integer, jsonb, text), public.economics_inputs(integer, bigint[]),
  public.economics_policy(integer) from public, anon, authenticated;
grant execute on function public.save_economics_inputs(integer, jsonb, text), public.economics_inputs(integer, bigint[]),
  public.economics_policy(integer) to service_role;
