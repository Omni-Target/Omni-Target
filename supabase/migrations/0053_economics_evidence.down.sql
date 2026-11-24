-- Reverts 0053_economics_evidence.sql.
drop function if exists public.product_economics_evidence(integer, bigint[], timestamptz, integer, integer, integer, integer);
