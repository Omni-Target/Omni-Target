-- 0039: scoped imports (Phase 2; for task 10's reconciliation and re-imports of large shops).
--
-- An import may name the domains it covers (catalog, inventory, customers,
-- orders, returns); none named means all, as before. Re-importing a shop's
-- orders no longer re-reads a catalog of hundreds of thousands of products,
-- and its capacity reservation covers only what it will write. History beyond
-- the window goes with orders. The claim returns the scope to the run.
--
-- Changes no existing rows.

alter table public.shop_imports add column domains text[]
  check (domains is null or (cardinality(domains) between 1 and 5
         and domains <@ array['catalog', 'inventory', 'customers', 'orders', 'returns']::text[]));
comment on column public.shop_imports.domains is 'The domains this import covers; null means all.';

drop function public.request_shop_import(integer);
create function public.request_shop_import(p_shop_key integer, p_domains text[] default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop uuid;
  v_row public.shop_imports;
begin
  select id into v_shop from public.shops where shop_key = p_shop_key;
  if v_shop is null then raise exception 'shop_not_found'; end if;
  if not public.shop_ingestion_open(p_shop_key) then return jsonb_build_object('outcome', 'not_ingestible'); end if;
  select * into v_row from public.shop_imports where shop_id = v_shop and status in ('requested', 'dispatched', 'running');
  if found then
    return jsonb_build_object('outcome', 'existing', 'import_id', v_row.id, 'status', v_row.status, 'dispatch_attempts', v_row.dispatch_attempts);
  end if;
  begin
    insert into public.shop_imports (shop_id, domains) values (v_shop, p_domains) returning * into v_row;
  exception when unique_violation then
    select * into v_row from public.shop_imports where shop_id = v_shop and status in ('requested', 'dispatched', 'running');
    return jsonb_build_object('outcome', 'existing', 'import_id', v_row.id, 'status', v_row.status, 'dispatch_attempts', v_row.dispatch_attempts);
  end;
  return jsonb_build_object('outcome', 'requested', 'import_id', v_row.id, 'status', v_row.status, 'dispatch_attempts', 0);
end;
$$;

-- 0035's claim, also returning the scope.
create or replace function public.claim_shop_import(p_import uuid, p_run_id text, p_stale_seconds integer default 900)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.shop_imports;
  v_shop public.shops;
begin
  select * into v_row from public.shop_imports where id = p_import for update;
  if not found then return jsonb_build_object('outcome', 'missing'); end if;
  if v_row.status in ('succeeded', 'partial', 'failed', 'cancelled') then
    return jsonb_build_object('outcome', 'finished', 'status', v_row.status);
  end if;
  if v_row.status = 'running' and v_row.trigger_run_id is distinct from p_run_id
     and v_row.heartbeat_at > now() - make_interval(secs => p_stale_seconds) then
    return jsonb_build_object('outcome', 'busy');
  end if;
  update public.shop_imports
     set status = 'running', trigger_run_id = p_run_id, started_at = coalesce(started_at, now()), heartbeat_at = now(),
         window_start = coalesce(window_start, public.retention_window_start())
   where id = p_import
  returning * into v_row;
  select * into v_shop from public.shops where id = v_row.shop_id;
  return jsonb_build_object('outcome', 'claimed', 'shop_key', v_shop.shop_key, 'shop_domain', v_shop.myshopify_domain,
    'shopify_shop_id', v_shop.shopify_shop_id, 'coverage', v_row.coverage, 'window_start', v_row.window_start,
    'domains', to_jsonb(v_row.domains));
end;
$$;

revoke all on function public.request_shop_import(integer, text[]) from public, anon, authenticated;
grant execute on function public.request_shop_import(integer, text[]) to service_role;
