-- Fix (found in Phase 3 task 2's scale check; a Phase 2 defect): an import summarises a new shop's months
-- right after its bulk writes, before autovacuum has analysed the tables. When every shop the planner's
-- statistics know is in shop_key's most-common-values list, a shop they do not know is estimated at about
-- one row, and per-shop statements choose nested loops that filter joins row by row: one month of a
-- 1,500-order shop took over two minutes against the 8 s statement timeout, next to 1M other orders.
-- refresh_mirror_statistics analyses one table from a fixed list (bounded: ANALYZE samples a fixed number
-- of rows), so the import refreshes the statistics of what it wrote before summarising.
create or replace function public.refresh_mirror_statistics(p_table text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_started timestamptz := clock_timestamp();
begin
  if p_table is null or p_table not in ('products', 'product_variants', 'metafields', 'inventory_levels', 'customers', 'orders',
      'order_line_items', 'refunds', 'returns', 'return_line_items', 'history_stage_orders', 'history_stage_lines') then
    raise exception 'statistics_table_not_allowed';
  end if;
  execute format('analyze public.%I', p_table);
  return jsonb_build_object('table', p_table, 'ms', round(extract(epoch from clock_timestamp() - v_started) * 1000));
end;
$$;

revoke all on function public.refresh_mirror_statistics(text) from public, anon, authenticated;
grant execute on function public.refresh_mirror_statistics(text) to service_role;
