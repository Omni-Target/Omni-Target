-- 0058_campaign_reconciliation: attribution reconciliation and recorded campaign evaluations (Phase 4 closure;
-- architecture/phase-4-economics.md, "Attribution reconciliation"). Omnitarget publishes nothing and spends nothing.
--  - campaign_reconciliation_evidence: what Shopify recorded over a campaign's period (orders of its products,
--    placed and paid; the Conversions API purchase events Omnitarget sent for them; how many Shopify itself
--    attributes to a visit from Meta; how fresh the order data is), so the engine can check Meta's purchase count
--    before any increase in spend.
--  - ad_campaign_reviews: a manual review of a campaign's counts when they do not reconcile (who, when, through
--    which day, the outcome and why). The latest one covering the matured results lets scaling proceed.
--  - ad_campaign_evaluations: every campaign evaluation (scale, hold, pause, stop…) recorded with its policy and
--    calc version, its full inputs and its output, so each one recomputes.

create table public.ad_campaign_reviews (
  id           uuid primary key default gen_random_uuid(),
  shop_key     integer not null references public.shops (shop_key),
  campaign_id  uuid not null references public.ad_campaigns (id) on delete cascade,
  through_day  date not null,
  outcome      text not null check (outcome in ('confirmed', 'corrected')),
  note         text not null check (char_length(note) between 5 and 1000),
  reviewed_by  text not null check (char_length(reviewed_by) between 1 and 128),
  reviewed_at  timestamptz not null default now()
);
create index ad_campaign_reviews_campaign_idx on public.ad_campaign_reviews (campaign_id, reviewed_at desc);

create table public.ad_campaign_evaluations (
  id              uuid primary key default gen_random_uuid(),
  shop_key        integer not null references public.shops (shop_key),
  campaign_id     uuid not null references public.ad_campaigns (id) on delete cascade,
  run_id          uuid references public.economics_runs (id) on delete set null,
  as_of           timestamptz not null,
  policy_version  integer not null references public.economics_policies (version),
  calc_version    text not null check (calc_version ~ '^econ-[0-9]+\.[0-9]+\.[0-9]+$'),
  action          text not null check (action ~ '^[A-Z][A-Z_]{1,31}$'),
  inputs          jsonb not null check (jsonb_typeof(inputs) = 'object' and pg_column_size(inputs) <= 262144),
  output          jsonb not null check (jsonb_typeof(output) = 'object' and pg_column_size(output) <= 65536),
  requested_by    text check (char_length(requested_by) <= 128),
  created_at      timestamptz not null default now()
);
create index ad_campaign_evaluations_campaign_idx on public.ad_campaign_evaluations (shop_key, campaign_id, created_at desc);

alter table public.ad_campaign_reviews enable row level security;
alter table public.ad_campaign_evaluations enable row level security;
revoke all on table public.ad_campaign_reviews, public.ad_campaign_evaluations from public, anon, authenticated, service_role;
grant select on table public.ad_campaign_reviews, public.ad_campaign_evaluations to service_role;

-- What Shopify recorded over a campaign's period. The window runs from the day before the campaign's first day (or
-- first result, if earlier), in the shop's time zone (the ad account's day may start earlier), to the check.
create or replace function public.campaign_reconciliation_evidence(p_shop_key integer, p_campaign_id uuid, p_as_of timestamptz)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with c as (
    select a.id, a.product_ids,
           least(a.started_on, (select min(r.day) from public.ad_campaign_results r where r.campaign_id = a.id)) as first_day
      from public.ad_campaigns a where a.id = p_campaign_id and a.shop_key = p_shop_key
  ),
  win as (
    select c.*, coalesce(s.timezone, 'UTC') as tz,
           ((coalesce(c.first_day, p_as_of::date) - 1)::timestamp at time zone coalesce(s.timezone, 'UTC')) as from_ts
      from c left join public.shop_settings s on s.shop_key = p_shop_key
  ),
  o as (
    select distinct o.shopify_id, coalesce(o.financial_status in ('paid', 'partially_refunded', 'refunded'), false) as paid,
           (lower(coalesce(o.utm_source, '')) in ('facebook', 'fb', 'instagram', 'ig', 'meta')
            or lower(coalesce(o.visit_source, '')) in ('facebook', 'instagram')
            or coalesce(o.referrer_host, '') ~* '(^|\.)(facebook|instagram|fb)\.com$') as meta_visit,
           (o.visit_source is not null or o.utm_source is not null or o.referrer_host is not null) as journey_known
      from win
      join public.order_line_items li on li.shop_key = p_shop_key and li.product_shopify_id = any (win.product_ids)
      join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
     where not o.is_test and o.processed_at >= win.from_ts and o.processed_at <= p_as_of
  ),
  shop as (select lower(myshopify_domain) as domain from public.shops where shop_key = p_shop_key)
  select case when not exists (select 1 from c) then null else jsonb_build_object(
    'from', (select from_ts from win), 'to', p_as_of, 'timezone', (select tz from win),
    'placed', (select count(*) from o),
    'paid', (select count(*) from o where o.paid),
    'meta_visit_orders', (select count(*) from o where o.meta_visit),
    'journey_known_orders', (select count(*) from o where o.journey_known),
    'capi_sent', (select count(distinct e.shopify_order_id) from public.capi_events e, shop
                   where e.shop_domain = shop.domain and e.event_type = 'Purchase' and e.status = 'sent'
                     and e.shopify_order_id in (select o.shopify_id::text from o where o.paid)),
    'capi_connected', exists (select 1 from public.capi_events e, shop where e.shop_domain = shop.domain and e.status = 'sent'
                                and e.event_sent_at > p_as_of - interval '90 days'),
    'orders_fresh_at', (select greatest(k.watermark, nullif(k.updated_at, '-infinity')) from public.sync_checkpoints k
                         where k.shop_key = p_shop_key and k.domain = 'orders'),
    'review', (select jsonb_build_object('through_day', v.through_day, 'outcome', v.outcome, 'note', v.note,
                                         'reviewed_by', v.reviewed_by, 'reviewed_at', v.reviewed_at)
                 from public.ad_campaign_reviews v where v.campaign_id = p_campaign_id and v.shop_key = p_shop_key
                order by v.reviewed_at desc limit 1)
  ) end;
$$;

-- Records a manual review of a campaign's counts. p_review: {through_day, outcome ('confirmed'|'corrected'), note}.
create or replace function public.save_ad_campaign_review(p_shop_key integer, p_campaign_id uuid, p_review jsonb, p_by text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.ad_campaigns where id = p_campaign_id and shop_key = p_shop_key) then
    raise exception 'ad_campaign_review_invalid: the campaign is not the shop''s' using errcode = 'P0001';
  end if;
  if (p_review->>'through_day') is null or (p_review->>'through_day')::date > current_date then
    raise exception 'ad_campaign_review_invalid: through_day must be a day that has passed' using errcode = 'P0001';
  end if;
  insert into public.ad_campaign_reviews (shop_key, campaign_id, through_day, outcome, note, reviewed_by)
  values (p_shop_key, p_campaign_id, (p_review->>'through_day')::date, p_review->>'outcome', p_review->>'note', p_by)
  returning id into v_id;
  return v_id;
end;
$$;

-- Records campaign evaluations, all or none. p_rows: [{campaign_id, run_id, as_of, policy_version, calc_version, action, inputs, output}].
create or replace function public.record_ad_campaign_evaluations(p_shop_key integer, p_rows jsonb, p_by text)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then
    raise exception 'ad_campaign_evaluations_invalid: rows must be an array of at most 200' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) x
              where not exists (select 1 from public.ad_campaigns a where a.id = (x->>'campaign_id')::uuid and a.shop_key = p_shop_key)) then
    raise exception 'ad_campaign_evaluations_invalid: a campaign is not the shop''s' using errcode = 'P0001';
  end if;
  insert into public.ad_campaign_evaluations (shop_key, campaign_id, run_id, as_of, policy_version, calc_version, action, inputs, output, requested_by)
  select p_shop_key, (x->>'campaign_id')::uuid, (x->>'run_id')::uuid, (x->>'as_of')::timestamptz, (x->>'policy_version')::integer,
         x->>'calc_version', x->>'action', x->'inputs', x->'output', p_by
    from jsonb_array_elements(p_rows) x;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.campaign_reconciliation_evidence(integer, uuid, timestamptz), public.save_ad_campaign_review(integer, uuid, jsonb, text),
  public.record_ad_campaign_evaluations(integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.campaign_reconciliation_evidence(integer, uuid, timestamptz), public.save_ad_campaign_review(integer, uuid, jsonb, text),
  public.record_ad_campaign_evaluations(integer, jsonb, text) to service_role;

-- Shop deletion and redaction cover the new tables (as 0055, with them added).
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
  delete from public.ad_campaign_evaluations where shop_key = v_key;
  delete from public.ad_campaign_reviews where shop_key = v_key;
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
       + (select count(*) from public.ad_campaign_results where shop_key = v_key)
       + (select count(*) from public.ad_campaign_reviews where shop_key = v_key)
       + (select count(*) from public.ad_campaign_evaluations where shop_key = v_key);
end;
$$;
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;
