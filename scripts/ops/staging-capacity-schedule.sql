-- Daily capacity snapshot on staging (Phase 1, task 10).
--
-- Production records snapshots through /api/cron/capacity (vercel.json),
-- which also alerts in Sentry. Staging has no Vercel cron, so pg_cron records
-- them against the Free plan's 500 MB quota; read them with
--   select captured_at, database_bytes, public_bytes, tables -> 0 from public.db_capacity_snapshots order by captured_at desc;
-- Requires migration 0027 and the pg_cron extension (enabled on staging for the
-- backup schedule, staging-backup-schedule.sql). Apply as the database owner;
-- re-running replaces the job.
select cron.schedule('staging-capacity-snapshot', '5 5 * * *', $$select public.capture_capacity_snapshot(524288000)$$);

-- Daily housekeeping (migration 0028), just before the snapshot, as the
-- production cron does it.
select cron.schedule('staging-operational-prune', '0 5 * * *', $$select public.prune_operational_rows()$$);
