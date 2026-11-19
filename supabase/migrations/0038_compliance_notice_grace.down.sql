-- Reverses 0038: compliance_exports_due returns to 0037.
create or replace function public.compliance_exports_due(p_stale_seconds integer default 900, p_max_dispatches integer default 10,
  p_limit integer default 200)
returns table (request_id uuid, shop_domain text, action text, reason text, object_key text, due_at timestamptz, level smallint)
language sql stable security definer set search_path = public, pg_temp as $$
  with open_exports as (
    select e.*, r.due_at as request_due_at, r.status as request_status, w.deleted_at, w.deletion_requested_at,
           exists (select 1 from public.compliance_requests s where s.topic = 'shop/redact' and s.shop_domain = e.shop_domain
                    and s.received_at >= e.created_at) as shop_redacted
      from public.compliance_exports e
      join public.compliance_requests r on r.id = e.request_id
      left join public.workspaces w on w.id = e.workspace_id
  ), actions as (
    select request_id, shop_domain, 'withdraw' as action,
           case when shop_redacted then 'shop_redacted' else 'workspace_deleted' end as reason,
           null::text as object_key, request_due_at, null::smallint as level
      from open_exports
     where status in ('pending', 'exporting', 'ready') and (shop_redacted or deleted_at is not null or deletion_requested_at is not null)
    union all
    select request_id, shop_domain, 'delete_file', close_reason, object_key, request_due_at, null
      from open_exports where status in ('expired', 'withdrawn') and object_key is not null
    union all
    select request_id, shop_domain, 'escalate', null, null, request_due_at,
           (case when request_due_at <= now() then 3 when request_due_at <= now() + interval '3 days' then 2 else 1 end)::smallint
      from open_exports
     where request_status <> 'completed' and status in ('pending', 'exporting', 'ready')
       and request_due_at <= now() + interval '10 days'
       and escalation_level < case when request_due_at <= now() then 3 when request_due_at <= now() + interval '3 days' then 2 else 1 end
    union all
    select request_id, shop_domain, 'expire', 'expired', object_key, request_due_at, null
      from open_exports where status = 'ready' and expires_at <= now()
    union all
    select request_id, shop_domain, 'notify', null, null, request_due_at, null
      from open_exports where status = 'ready' and notified_at is null and expires_at > now()
       and not shop_redacted and deleted_at is null and deletion_requested_at is null
    union all
    select request_id, shop_domain, 'dispatch', null, null, request_due_at, null
      from open_exports
     where not shop_redacted and deleted_at is null and deletion_requested_at is null and dispatch_attempts < p_max_dispatches
       and ((status = 'pending' and (dispatched_at is null or dispatched_at < now() - make_interval(secs => p_stale_seconds)))
            or (status = 'exporting' and claimed_at < now() - make_interval(secs => p_stale_seconds)))
  )
  select request_id, shop_domain, action, reason, object_key, request_due_at, level from actions
   order by case action when 'withdraw' then 0 when 'delete_file' then 1 when 'escalate' then 2 when 'expire' then 3
                        when 'notify' then 4 else 5 end, request_due_at
   limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;
