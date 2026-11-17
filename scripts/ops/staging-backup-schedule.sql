-- Staging only: schedules the backup workflow from the staging database.
--
-- GitHub runs `schedule` triggers only from the default branch (main), which
-- development does not touch. Instead pg_cron, inside the staging Supabase
-- project, dispatches the workflow on ref `staging` through GitHub's
-- workflow_dispatch API (pg_net). The GitHub token lives in Supabase Vault as
-- `github_backup_dispatch_token`: a fine-grained token for Omni-Target/Omni-Target
-- with only "Actions: Read and write". Without it, nothing is dispatched and a
-- warning is logged.
--
-- Apply once to the staging database as postgres (idempotent). Not a numbered
-- migration: it schedules operations, it does not define application schema.
-- See scripts/ops/runbooks/backups.md.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create schema if not exists ops;
revoke all on schema ops from public, anon, authenticated, service_role;

create or replace function ops.dispatch_staging_backup(p_restore_test boolean)
returns bigint language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_token text;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'github_backup_dispatch_token';
  if v_token is null then
    raise warning 'github_backup_dispatch_token is missing from Vault; staging backup not dispatched';
    return null;
  end if;
  return net.http_post(
    url := 'https://api.github.com/repos/Omni-Target/Omni-Target/actions/workflows/db-backup.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'omnitarget-staging-scheduler',
      'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'staging', 'inputs', jsonb_build_object('restore_test', p_restore_test::text))
  );
end;
$$;
revoke all on function ops.dispatch_staging_backup(boolean) from public, anon, authenticated, service_role;

-- Nightly backup at 02:17 UTC; weekly backup plus restore test on Sunday 03:47 UTC.
select cron.schedule('staging-backup-nightly', '17 2 * * *', $$select ops.dispatch_staging_backup(false)$$);
select cron.schedule('staging-backup-weekly-restore', '47 3 * * 0', $$select ops.dispatch_staging_backup(true)$$);
