-- Store the product price on a campaign so the briefs grid can show it at a
-- glance. Additive + idempotent; existing rows keep NULL (price simply omitted
-- from their card). Populated going forward from the generation form input.

alter table public.campaigns
  add column if not exists product_price text;
