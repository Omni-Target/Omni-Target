-- Reverses 0027. Snapshot history is discarded.
drop function if exists public.database_size_bytes();
drop function if exists public.capture_capacity_snapshot(bigint);
drop table if exists public.db_capacity_snapshots;
