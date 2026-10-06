-- Anthropic excludes cache reads and writes from usage.input_tokens. Preserve
-- those categories so new rows can be audited and priced accurately. Historical
-- rows stay NULL because their cache split cannot be reconstructed.
alter table public.api_usage_log
  add column if not exists model text,
  add column if not exists cache_creation_input_tokens integer,
  add column if not exists cache_read_input_tokens integer;
