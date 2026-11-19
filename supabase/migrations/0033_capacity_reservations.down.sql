-- Reverses 0033. Reservation history is dropped; nothing else changes.
drop function if exists public.release_import_capacity(uuid, text);
drop function if exists public.renew_import_capacity(uuid, bigint, bigint, numeric, integer);
drop function if exists public.reserve_import_capacity(integer, text, bigint, bigint, numeric, integer, jsonb);
drop table if exists public.capacity_reservations;
