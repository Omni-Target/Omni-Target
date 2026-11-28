-- 0059_economics_policy_v3_activate: the CEO approved economics policy version 3 on 2026-11-25
-- (architecture/phase-4-economics.md, "Policy version 3: approved and active"), together with the attribution
-- reconciliation safeguard that must hold before any scale-up (migration 0058; calc version econ-1.2.0).
--  - Version 3 becomes the active policy, its approval recorded. Its settings and rationale are exactly as 0057 wrote
--    them: a written version never changes (economics_policies_immutable).
--  - Version 2 is retired and kept, still marked pending: it was approved only provisionally, and every recommendation
--    recorded under it keeps referring to it and recomputes as it was.

update public.economics_policies set status = 'retired' where version = 2 and status = 'active';
update public.economics_policies
   set status = 'active', activated_at = now(), approval = 'approved', approved_at = now(),
       approved_by = 'CEO decision of 2026-11-25 (recorded by Omnitarget engineering)'
 where version = 3 and status in ('draft', 'retired');

do $$
begin
  if not exists (select 1 from public.economics_policies where version = 3 and status = 'active' and approval = 'approved'
                    and (settings->>'scale_confidence')::numeric = 0.975 and (settings->>'pause_confidence')::numeric = 0.95
                    and (settings->>'require_spending_limits')::boolean and (settings->>'refund_maturity_min_days')::numeric = 60) then
    raise exception 'economics policy version 3 is not the approved draft written by 0057';
  end if;
end;
$$;
