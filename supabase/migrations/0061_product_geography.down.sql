-- Reverts 0061_product_geography.sql.
drop function if exists public.product_geography_evidence(integer, bigint[], timestamptz, integer);
