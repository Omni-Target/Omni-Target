-- Reverts 0060_reconciliation_freshness.sql: the 0058 definition comes back.

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
revoke all on function public.campaign_reconciliation_evidence(integer, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.campaign_reconciliation_evidence(integer, uuid, timestamptz) to service_role;
