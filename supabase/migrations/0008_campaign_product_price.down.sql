-- Rollback for 0008: drop the added column (only discards display-only data).
alter table public.campaigns
  drop column if exists product_price;
