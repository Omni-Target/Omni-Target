-- Reverts 0062_product_channel_evidence.sql.
drop function if exists public.product_channel_evidence(integer, bigint[], timestamptz, integer);
