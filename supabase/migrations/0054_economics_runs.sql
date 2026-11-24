-- Phase 4, task 6: every economics run and recommendation is recorded (architecture/phase-4-economics.md,
-- "Recording and reproducibility").
--
--  - economics_runs: one row per run (a brief's product, a portfolio, a check): when, the evidence's as-of time,
--    the calculation and policy versions, who asked, and the portfolio allocation when there was one.
--  - product_recommendations: one row per product in a run: the verdict, its reasons and the headline amounts as
--    columns, plus the complete arguments the engine received (evidence, merchant inputs, policy, campaign
--    results, options) and its complete output. Recomputing from `inputs` must give `outputs` exactly.
-- Written only by record_economics_run, all or none; read through economics_run and
-- latest_product_recommendations. Deleted with the shop's data; nothing here is pruned.

create table public.economics_runs (
  id             uuid primary key default gen_random_uuid(),
  shop_key       integer not null references public.shops (shop_key),
  created_at     timestamptz not null default now(),
  as_of          timestamptz not null,
  calc_version   text not null check (calc_version ~ '^econ-[0-9]+\.[0-9]+\.[0-9]+$'),
  policy_version integer not null references public.economics_policies (version),
  trigger        text not null check (trigger in ('brief', 'portfolio', 'check')),
  requested_by   text check (char_length(requested_by) <= 128),
  products       integer not null check (products between 1 and 200),
  portfolio      jsonb check (portfolio is null or (jsonb_typeof(portfolio) = 'object' and pg_column_size(portfolio) <= 65536)),
  summary        jsonb not null default '{}' check (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 8192)
);
create index economics_runs_shop_created_idx on public.economics_runs (shop_key, created_at desc);

create table public.product_recommendations (
  run_id             uuid not null references public.economics_runs (id) on delete cascade,
  shop_key           integer not null references public.shops (shop_key),
  product_shopify_id bigint not null,
  created_at         timestamptz not null default now(),
  verdict            text not null check (verdict in ('GO', 'PILOT', 'DO_NOT_LAUNCH', 'INSUFFICIENT_DATA', 'BLOCKED')),
  reasons            text[] not null default '{}' check (cardinality(reasons) <= 40),
  currency           text check (currency ~ '^[A-Z]{3}$'),
  budget_status      text not null check (budget_status in ('recommended', 'zero', 'withheld', 'awaiting_authority')),
  test_budget        numeric check (test_budget >= 0),
  daily_budget       numeric check (daily_budget >= 0),
  test_days          smallint check (test_days between 1 and 366),
  break_even_cpa     numeric,
  target_cpa         numeric,
  inputs             jsonb not null check (jsonb_typeof(inputs) = 'object' and pg_column_size(inputs) <= 262144),
  outputs            jsonb not null check (jsonb_typeof(outputs) = 'object' and pg_column_size(outputs) <= 131072),
  primary key (run_id, product_shopify_id),
  -- Blocked and unviable products are recorded with exactly zero; missing data with no amounts.
  check (verdict not in ('BLOCKED', 'DO_NOT_LAUNCH') or (coalesce(test_budget, 0) = 0 and coalesce(daily_budget, 0) = 0)),
  check (verdict <> 'INSUFFICIENT_DATA' or (test_budget is null and daily_budget is null))
);
create index product_recommendations_latest_idx on public.product_recommendations (shop_key, product_shopify_id, created_at desc);

alter table public.economics_runs enable row level security;
alter table public.product_recommendations enable row level security;
revoke all on table public.economics_runs, public.product_recommendations from public, anon, authenticated, service_role;
grant select on table public.economics_runs, public.product_recommendations to service_role;

-- Records a run and its recommendations, all or none. p_run: {as_of, calc_version, policy_version, trigger,
-- requested_by, portfolio, summary}; p_recommendations: [{product_id, verdict, reasons, currency, budget_status,
-- test_budget, daily_budget, test_days, break_even_cpa, target_cpa, inputs, outputs}] (1 to 200).
create or replace function public.record_economics_run(p_shop_key integer, p_run jsonb, p_recommendations jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_count integer := coalesce(jsonb_array_length(case when jsonb_typeof(p_recommendations) = 'array' then p_recommendations end), 0);
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if v_count not between 1 and 200 then raise exception 'economics_run_invalid: 1 to 200 recommendations' using errcode = 'P0001'; end if;
  insert into public.economics_runs (shop_key, as_of, calc_version, policy_version, trigger, requested_by, products, portfolio, summary)
  values (p_shop_key, (p_run->>'as_of')::timestamptz, p_run->>'calc_version', (p_run->>'policy_version')::integer, p_run->>'trigger',
          p_run->>'requested_by', v_count, nullif(p_run->'portfolio', 'null'::jsonb), coalesce(p_run->'summary', '{}'::jsonb))
  returning id into v_id;
  insert into public.product_recommendations (run_id, shop_key, product_shopify_id, verdict, reasons, currency, budget_status, test_budget,
    daily_budget, test_days, break_even_cpa, target_cpa, inputs, outputs)
  select v_id, p_shop_key, (r->>'product_id')::bigint, r->>'verdict', coalesce(array(select jsonb_array_elements_text(r->'reasons')), '{}'),
         r->>'currency', r->>'budget_status', (r->>'test_budget')::numeric, (r->>'daily_budget')::numeric, (r->>'test_days')::smallint,
         (r->>'break_even_cpa')::numeric, (r->>'target_cpa')::numeric, r->'inputs', r->'outputs'
    from jsonb_array_elements(p_recommendations) r;
  return v_id;
end;
$$;

-- A recorded run with every recommendation's inputs and outputs (for audit and recomputation).
create or replace function public.economics_run(p_shop_key integer, p_run_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('run', to_jsonb(r) - 'shop_key',
           'recommendations', coalesce((select jsonb_agg(jsonb_build_object('product_id', p.product_shopify_id, 'inputs', p.inputs, 'outputs', p.outputs)
                                                  order by p.product_shopify_id)
                                          from public.product_recommendations p where p.run_id = r.id), '[]'::jsonb))
    from public.economics_runs r
   where r.shop_key = p_shop_key and r.id = p_run_id;
$$;

-- Each product's latest recommendation (outputs only), at most 200 products.
create or replace function public.latest_product_recommendations(p_shop_key integer, p_product_ids bigint[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('product_id', l.product_shopify_id, 'run_id', l.run_id, 'created_at', l.created_at,
                                               'verdict', l.verdict, 'outputs', l.outputs) order by l.product_shopify_id), '[]'::jsonb)
    from (select distinct on (p.product_shopify_id) p.*
            from public.product_recommendations p
           where p.shop_key = p_shop_key and p.product_shopify_id = any ((coalesce(p_product_ids, '{}'))[1:200])
           order by p.product_shopify_id, p.created_at desc, p.run_id) l;
$$;

-- 0052's deletion helpers, with the recorded economics runs.
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
       + (select count(*) from public.product_recommendations where shop_key = v_key);
end;
$$;
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;

revoke all on function public.record_economics_run(integer, jsonb, jsonb), public.economics_run(integer, uuid),
  public.latest_product_recommendations(integer, bigint[]) from public, anon, authenticated;
grant execute on function public.record_economics_run(integer, jsonb, jsonb), public.economics_run(integer, uuid),
  public.latest_product_recommendations(integer, bigint[]) to service_role;
