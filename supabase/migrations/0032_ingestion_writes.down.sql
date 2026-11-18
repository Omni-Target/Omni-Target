-- Reverses 0032. Rows already written stay; only the write functions go.
drop function if exists public.save_sync_checkpoint(integer, text, uuid, bigint, bigint, timestamptz);
drop function if exists public.ingest_returns(integer, jsonb, jsonb);
drop function if exists public.derive_customer_order_facts(integer, bigint, integer);
drop function if exists public.ingest_customers(integer, jsonb);
drop function if exists public.ingest_orders(integer, jsonb, jsonb, jsonb);
drop function if exists public.ingest_inventory(integer, jsonb, jsonb);
drop function if exists public.ingest_catalog(integer, jsonb, jsonb, jsonb);
drop function if exists public.ingest_batch_size(jsonb[]);
