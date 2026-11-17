-- 0026: archive tracking for trimmed briefs (Phase 1, task 9).
--
-- Existing briefs carry the whole store snapshot. scripts/ops/brief-archive.mjs
-- archives each original, encrypted and checksummed, to R2, verifies the
-- archive by decrypting it, and only then replaces the snapshot with bounded
-- evidence. These tables record what was archived where, so any row can be
-- restored byte for byte until its archive expires (30 days, inside Shopify's
-- redaction deadline). They hold hashes, sizes and row identifiers, never
-- brief content. Owner-only: the application has no access.

create table public.brief_archive_runs (
  id                 uuid primary key default gen_random_uuid(),
  object_key         text not null unique check (char_length(object_key) between 1 and 512),
  key_id             text not null check (key_id ~ '^[0-9a-f]{16}$'),
  plaintext_sha256   text not null check (plaintext_sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext_sha256  text not null check (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  rows_archived      integer not null check (rows_archived > 0),
  created_at         timestamptz not null default now(),
  verified_at        timestamptz,
  expires_at         timestamptz not null,
  expired_at         timestamptz,
  check (expires_at > created_at)
);

create table public.brief_archive_entries (
  run_id           uuid not null references public.brief_archive_runs (id),
  table_name       text not null check (table_name in ('campaigns', 'campaign_brief_versions', 'brief_generation_receipts')),
  row_key          uuid not null,
  original_sha256  text not null check (original_sha256 ~ '^[0-9a-f]{64}$'),
  original_bytes   integer not null check (original_bytes > 0),
  trimmed_sha256   text check (trimmed_sha256 ~ '^[0-9a-f]{64}$'),
  trimmed_bytes    integer check (trimmed_bytes > 0),
  trimmed_at       timestamptz,
  restored_at      timestamptz,
  primary key (run_id, table_name, row_key),
  check ((trimmed_at is null) = (trimmed_sha256 is null) and (trimmed_sha256 is null) = (trimmed_bytes is null)),
  check (restored_at is null or trimmed_at is not null)
);
create index brief_archive_entries_row_idx on public.brief_archive_entries (table_name, row_key);

alter table public.brief_archive_runs enable row level security;
alter table public.brief_archive_entries enable row level security;
revoke all on table public.brief_archive_runs, public.brief_archive_entries from public, anon, authenticated, service_role;
