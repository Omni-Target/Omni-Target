-- Retain context and receipts on rollback: they are merchant records.
-- Roll back application first. Reapplying up restores these functions.
drop function if exists public.finalize_brief_version(text, uuid, uuid, jsonb, jsonb, text);
drop function if exists public.commit_brief_generation(text, uuid, text, uuid, jsonb, jsonb, jsonb, jsonb);
