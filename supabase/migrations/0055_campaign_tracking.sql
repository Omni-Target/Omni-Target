-- Phase 4, task 7: tracked campaigns and their results, so the engine can judge what advertising achieved
-- (architecture/phase-4-economics.md, "Campaign results and feedback"). Omnitarget publishes nothing and spends
-- nothing: the merchant records a campaign they run and enters its daily results (an import may follow later).
--
--  - ad_campaigns: the products a campaign covers, its status, its ad-account currency, its current daily budget,
--    the test budget and loss limit authorised for it (in the shop's currency), and the recommendation run that
--    authorised it.
--  - ad_campaign_results: one row per campaign and day: spend, attributed conversions and their value, clicks and
--    impressions where known, in the campaign's currency, with the exchange rate to the shop's currency and its
--    source recorded beside each day, so every comparison with break-even and target is in one currency.
-- Written only by save_ad_campaign and save_ad_campaign_results; read through ad_campaigns_with_results.

create table public.ad_campaigns (
  id                    uuid primary key default gen_random_uuid(),
  shop_key              integer not null references public.shops (shop_key),
  name                  text not null check (char_length(name) between 1 and 200),
  platform              text not null default 'meta' check (platform in ('meta', 'other')),
  external_ref          text check (char_length(external_ref) <= 128),
  product_ids           bigint[] not null check (cardinality(product_ids) between 1 and 50),
  status                text not null check (status in ('planned', 'active', 'paused', 'ended')),
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  daily_budget          numeric check (daily_budget >= 0),
  authorised_budget     numeric check (authorised_budget >= 0),
  max_loss              numeric check (max_loss >= 0),
  attribution_setting   text not null default '7d_click_1d_view' check (char_length(attribution_setting) between 1 and 40),
  recommendation_run_id uuid references public.economics_runs (id) on delete set null,
  started_on            date,
  ended_on              date,
  last_scaled_on        date,
  created_by            text not null check (char_length(created_by) between 1 and 128),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (ended_on is null or started_on is null or ended_on >= started_on)
);
create index ad_campaigns_shop_idx on public.ad_campaigns (shop_key, status);

create table public.ad_campaign_results (
  campaign_id      uuid not null references public.ad_campaigns (id) on delete cascade,
  shop_key         integer not null references public.shops (shop_key),
  day              date not null,
  spend            numeric not null check (spend >= 0),
  conversions      integer not null check (conversions >= 0),
  conversion_value numeric check (conversion_value >= 0),
  clicks           integer check (clicks >= 0),
  impressions      integer check (impressions >= 0),
  fx_to_shop       numeric not null check (fx_to_shop > 0),
  fx_source        text not null check (char_length(fx_source) between 1 and 80),
  source           text not null check (source in ('merchant_entered', 'import')),
  entered_by       text not null check (char_length(entered_by) between 1 and 128),
  entered_at       timestamptz not null default now(),
  primary key (campaign_id, day)
);

alter table public.ad_campaigns enable row level security;
alter table public.ad_campaign_results enable row level security;
revoke all on table public.ad_campaigns, public.ad_campaign_results from public, anon, authenticated, service_role;
grant select on table public.ad_campaigns, public.ad_campaign_results to service_role;

-- Creates (no id) or updates (an id of this shop's) a campaign. Products must be the shop's.
create or replace function public.save_ad_campaign(p_shop_key integer, p_campaign jsonb, p_by text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := (p_campaign->>'id')::uuid;
  v_products bigint[] := array(select jsonb_array_elements_text(coalesce(p_campaign->'product_ids', '[]'::jsonb))::bigint);
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if p_by is null or char_length(p_by) not between 1 and 128 then raise exception 'ad_campaign_invalid: created_by' using errcode = 'P0001'; end if;
  if exists (select 1 from unnest(v_products) x(id) where not exists (select 1 from public.products p where p.shop_key = p_shop_key and p.shopify_id = x.id)) then
    raise exception 'ad_campaign_invalid: a product is not the shop''s' using errcode = 'P0001';
  end if;
  if p_campaign->>'recommendation_run_id' is not null and not exists (
       select 1 from public.economics_runs r where r.id = (p_campaign->>'recommendation_run_id')::uuid and r.shop_key = p_shop_key) then
    raise exception 'ad_campaign_invalid: the recommendation run is not the shop''s' using errcode = 'P0001';
  end if;
  if v_id is null then
    insert into public.ad_campaigns (shop_key, name, platform, external_ref, product_ids, status, currency, daily_budget, authorised_budget, max_loss,
      attribution_setting, recommendation_run_id, started_on, ended_on, last_scaled_on, created_by)
    values (p_shop_key, p_campaign->>'name', coalesce(p_campaign->>'platform', 'meta'), p_campaign->>'external_ref', v_products,
      p_campaign->>'status', p_campaign->>'currency', (p_campaign->>'daily_budget')::numeric, (p_campaign->>'authorised_budget')::numeric,
      (p_campaign->>'max_loss')::numeric, coalesce(p_campaign->>'attribution_setting', '7d_click_1d_view'), (p_campaign->>'recommendation_run_id')::uuid,
      (p_campaign->>'started_on')::date, (p_campaign->>'ended_on')::date, (p_campaign->>'last_scaled_on')::date, p_by)
    returning id into v_id;
  else
    update public.ad_campaigns set name = p_campaign->>'name', platform = coalesce(p_campaign->>'platform', platform), external_ref = p_campaign->>'external_ref',
      product_ids = v_products, status = p_campaign->>'status', currency = p_campaign->>'currency', daily_budget = (p_campaign->>'daily_budget')::numeric,
      authorised_budget = (p_campaign->>'authorised_budget')::numeric, max_loss = (p_campaign->>'max_loss')::numeric,
      attribution_setting = coalesce(p_campaign->>'attribution_setting', attribution_setting),
      recommendation_run_id = (p_campaign->>'recommendation_run_id')::uuid, started_on = (p_campaign->>'started_on')::date,
      ended_on = (p_campaign->>'ended_on')::date, last_scaled_on = (p_campaign->>'last_scaled_on')::date, updated_at = now()
     where id = v_id and shop_key = p_shop_key;
    if not found then raise exception 'ad_campaign_invalid: not the shop''s campaign' using errcode = 'P0001'; end if;
  end if;
  return v_id;
end;
$$;

-- Saves a campaign's daily results (at most 400 days), all or none. Each day: {day, spend, conversions,
-- conversion_value, clicks, impressions, fx_to_shop, fx_source}; money is in the campaign's currency. When the
-- campaign's currency is the shop's, the rate must be 1.
create or replace function public.save_ad_campaign_results(p_shop_key integer, p_campaign_id uuid, p_days jsonb, p_by text, p_source text default 'merchant_entered')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.ad_campaigns%rowtype;
  v_shop_currency text;
  v_saved integer;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  select * into c from public.ad_campaigns where id = p_campaign_id and shop_key = p_shop_key;
  if not found then raise exception 'ad_results_invalid: not the shop''s campaign' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_days) is distinct from 'array' or jsonb_array_length(p_days) not between 1 and 400 then
    raise exception 'ad_results_invalid: 1 to 400 days' using errcode = 'P0001';
  end if;
  select currency into v_shop_currency from public.shop_settings where shop_key = p_shop_key;
  if v_shop_currency is null then raise exception 'ad_results_invalid: the shop''s currency is not known yet' using errcode = 'P0001'; end if;
  if c.currency = v_shop_currency and exists (select 1 from jsonb_array_elements(p_days) d where (d->>'fx_to_shop')::numeric <> 1) then
    raise exception 'ad_results_invalid: same currency needs a rate of 1' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_days) d where (d->>'day')::date > current_date) then
    raise exception 'ad_results_invalid: a day in the future' using errcode = 'P0001';
  end if;
  insert into public.ad_campaign_results as t (campaign_id, shop_key, day, spend, conversions, conversion_value, clicks, impressions, fx_to_shop, fx_source,
    source, entered_by, entered_at)
  select p_campaign_id, p_shop_key, (d->>'day')::date, (d->>'spend')::numeric, (d->>'conversions')::integer, (d->>'conversion_value')::numeric,
         (d->>'clicks')::integer, (d->>'impressions')::integer, (d->>'fx_to_shop')::numeric, d->>'fx_source', p_source, p_by, now()
    from jsonb_array_elements(p_days) d
  on conflict (campaign_id, day) do update set spend = excluded.spend, conversions = excluded.conversions, conversion_value = excluded.conversion_value,
    clicks = excluded.clicks, impressions = excluded.impressions, fx_to_shop = excluded.fx_to_shop, fx_source = excluded.fx_source,
    source = excluded.source, entered_by = excluded.entered_by, entered_at = now();
  get diagnostics v_saved = row_count;
  return jsonb_build_object('saved', v_saved);
end;
$$;

-- The shop's campaigns (all, or those asked for) with their daily results from the last 400 days.
create or replace function public.ad_campaigns_with_results(p_shop_key integer, p_campaign_ids uuid[] default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg((to_jsonb(c) - 'shop_key') || jsonb_build_object('results', coalesce((
           select jsonb_agg(to_jsonb(r) - 'shop_key' - 'campaign_id' order by r.day)
             from public.ad_campaign_results r where r.campaign_id = c.id and r.day >= current_date - 400), '[]'::jsonb))
         order by c.created_at, c.id), '[]'::jsonb)
    from public.ad_campaigns c
   where c.shop_key = p_shop_key and (p_campaign_ids is null or c.id = any (p_campaign_ids));
$$;

-- 0054's deletion helpers, with tracked campaigns and their results.
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
  delete from public.ad_campaign_results where shop_key = v_key;
  delete from public.ad_campaigns where shop_key = v_key;
  delete from public.product_recommendations where shop_key = v_key;
  delete from public.economics_runs where shop_key = v_key;
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
       + (select count(*) from public.merchant_economics_inputs where shop_key = v_key)
       + (select count(*) from public.economics_runs where shop_key = v_key)
       + (select count(*) from public.product_recommendations where shop_key = v_key)
       + (select count(*) from public.ad_campaigns where shop_key = v_key)
       + (select count(*) from public.ad_campaign_results where shop_key = v_key);
end;
$$;
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;

revoke all on function public.save_ad_campaign(integer, jsonb, text), public.save_ad_campaign_results(integer, uuid, jsonb, text, text),
  public.ad_campaigns_with_results(integer, uuid[]) from public, anon, authenticated;
grant execute on function public.save_ad_campaign(integer, jsonb, text), public.save_ad_campaign_results(integer, uuid, jsonb, text, text),
  public.ad_campaigns_with_results(integer, uuid[]) to service_role;
