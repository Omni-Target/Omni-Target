-- Reverses 0022. The account map and orphan list are discarded; workspaces,
-- claims, ledger entries and purchase records created by a migration run stay.
drop function if exists public.clear_legacy_plaintext_credentials(uuid);
drop function if exists public.record_legacy_orphans(text);
drop function if exists public.migrate_legacy_account(uuid, text);
drop function if exists public.legacy_row_has_credentials(uuid);
drop function if exists public.legacy_token_columns();
drop table if exists public.legacy_orphans;
drop table if exists public.legacy_account_map;
