-- Reverses 0026. Archive objects in R2 are not touched; without these records
-- a trimmed row can still be restored by matching its archive's checksums.
drop table if exists public.brief_archive_entries;
drop table if exists public.brief_archive_runs;
