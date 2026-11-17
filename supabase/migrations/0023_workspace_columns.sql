-- 0023: workspace_id on tenant tables (Phase 1, task 6).
--
-- Nullable at first: legacy rows are attributed by the legacy migration (0022),
-- and rows written by the current code get their workspace from the record they
-- belong to (insert triggers below), never from a browser-supplied value.
-- campaigns.workspace_id already exists (0018). Additive: no existing row changes.

alter table public.campaign_brief_versions add column if not exists workspace_id uuid references public.workspaces (id);
alter table public.brief_generation_receipts add column if not exists workspace_id uuid references public.workspaces (id);
alter table public.payments add column if not exists workspace_id uuid references public.workspaces (id);
alter table public.credit_usage add column if not exists workspace_id uuid references public.workspaces (id);
alter table public.capi_events add column if not exists workspace_id uuid references public.workspaces (id);

create index if not exists campaign_brief_versions_workspace_idx on public.campaign_brief_versions (workspace_id) where workspace_id is not null;
create index if not exists brief_generation_receipts_workspace_idx on public.brief_generation_receipts (workspace_id) where workspace_id is not null;
create index if not exists payments_workspace_idx on public.payments (workspace_id) where workspace_id is not null;
create index if not exists credit_usage_workspace_idx on public.credit_usage (workspace_id) where workspace_id is not null;
create index if not exists capi_events_workspace_idx on public.capi_events (workspace_id) where workspace_id is not null;

-- A brief version belongs to its campaign's workspace.
create or replace function public.fill_version_workspace()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.workspace_id is null then
    select workspace_id into new.workspace_id from public.campaigns where id = new.campaign_id;
  end if;
  return new;
end;
$$;
create trigger campaign_brief_versions_workspace before insert on public.campaign_brief_versions
  for each row execute function public.fill_version_workspace();

-- A generation receipt belongs to the workspace of the campaign it produced.
create or replace function public.fill_receipt_workspace()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_campaign text := new.response ->> 'campaignId';
begin
  if new.workspace_id is null and v_campaign ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select workspace_id into new.workspace_id from public.campaigns where id = v_campaign::uuid;
  end if;
  return new;
end;
$$;
create trigger brief_generation_receipts_workspace before insert on public.brief_generation_receipts
  for each row execute function public.fill_receipt_workspace();

-- A Stripe or Paystack payment belongs to the workspace of its purchase intent (0021).
create or replace function public.fill_payment_workspace()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.workspace_id is null then
    select workspace_id into new.workspace_id from public.purchase_intents
     where provider = new.provider and external_charge_id = new.id::text;
  end if;
  return new;
end;
$$;
create trigger payments_workspace before insert on public.payments
  for each row execute function public.fill_payment_workspace();

-- A CAPI event belongs to the workspace currently bound to its shop.
create or replace function public.fill_capi_workspace()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.workspace_id is null and new.shop_domain is not null then
    select b.workspace_id into new.workspace_id from public.shop_bindings b join public.shops s on s.id = b.shop_id
     where s.myshopify_domain = public.myshopify_domain_or_null(new.shop_domain) and b.released_at is null;
  end if;
  return new;
end;
$$;
create trigger capi_events_workspace before insert on public.capi_events
  for each row execute function public.fill_capi_workspace();

revoke all on function public.fill_version_workspace(), public.fill_receipt_workspace(), public.fill_payment_workspace(),
  public.fill_capi_workspace() from public, anon, authenticated, service_role;
