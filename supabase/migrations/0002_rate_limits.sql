-- Rate limiting: atomic fixed-window counters
--
-- Apply alongside the Wave 2 deploy. The application (src/lib/api/rate-limit.ts)
-- fails OPEN if these objects are missing — it logs a warning and allows the
-- request — so deploy ordering will not break routes. Limits only take effect
-- once this migration is applied.

create table if not exists public.rate_limits (
  key          text primary key,
  count        integer not null default 0,
  window_start timestamptz not null default now()
);

-- Atomically increment the counter for `p_key`, resetting it when the current
-- fixed window has elapsed. Returns true when the request is within the limit.
-- The whole read-modify-write happens in one statement, so concurrent calls
-- cannot under-count.
create or replace function public.check_rate_limit(
  p_key            text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
as $$
declare
  v_now   timestamptz := now();
  v_count integer;
begin
  insert into public.rate_limits as rl (key, count, window_start)
  values (p_key, 1, v_now)
  on conflict (key) do update
    set count = case
          when rl.window_start < v_now - make_interval(secs => p_window_seconds)
            then 1
          else rl.count + 1
        end,
        window_start = case
          when rl.window_start < v_now - make_interval(secs => p_window_seconds)
            then v_now
          else rl.window_start
        end
  returning rl.count into v_count;

  return v_count <= p_limit;
end;
$$;
