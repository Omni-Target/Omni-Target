-- Reverses 0037: record_customer_compliance returns to 0031; the export functions and table are dropped
-- (delete any export files under compliance-exports/ first: the table names them).
create or replace function public.record_customer_compliance(
  p_topic text, p_shopify_shop_id bigint, p_domain text, p_event_key text, p_triggered_at timestamptz,
  p_customer_shopify_id bigint default null, p_order_ids bigint[] default null,
  p_customer_digest bytea default null, p_order_digests bytea[] default null, p_key_version smallint default 1
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := lower(btrim(coalesce(p_domain, '')));
  v_orders_named bigint[] := coalesce(p_order_ids, '{}');
  v_event bigint;
  v_request uuid;
  v_key integer;
  v_shopify_shop bigint := p_shopify_shop_id;
  v_customers integer := 0;
  v_orders integer := 0;
  v_inbox integer := 0;
  v_suppressed integer := 0;
  v_held boolean := false;
  v_status text;
  v_resolution text;
begin
  if p_topic not in ('customers/redact', 'customers/data_request') then raise exception 'unsupported_compliance_topic'; end if;
  insert into public.shop_lifecycle_events (topic, event_key, shopify_shop_id, shop_domain, triggered_at)
  values (p_topic, p_event_key, p_shopify_shop_id, v_domain, p_triggered_at)
  on conflict (topic, event_key) do nothing returning id into v_event;
  if v_event is null then return jsonb_build_object('outcome', 'duplicate'); end if;

  select shop_key, shopify_shop_id into v_key, v_shopify_shop from public.shops
   where (p_shopify_shop_id is not null and shopify_shop_id = p_shopify_shop_id) or myshopify_domain = public.myshopify_domain_or_null(v_domain)
   order by (shopify_shop_id = p_shopify_shop_id) desc nulls last limit 1;
  v_shopify_shop := coalesce(p_shopify_shop_id, v_shopify_shop);

  if p_topic = 'customers/redact' then
    if v_key is not null then
      delete from public.customers where shop_key = v_key and shopify_id = p_customer_shopify_id;
      get diagnostics v_customers = row_count;
      update public.orders
         set customer_shopify_id = null, ship_city = null, ship_city_raw = null, ship_province_code = null
       where shop_key = v_key and (customer_shopify_id = p_customer_shopify_id or shopify_id = any(v_orders_named))
         and (customer_shopify_id is not null or ship_city is not null or ship_city_raw is not null or ship_province_code is not null);
      get diagnostics v_orders = row_count;
    end if;
    -- Inbox payloads about the customer, or carrying one of the named orders, are dropped unprocessed.
    update public.webhook_events
       set payload = null, status = 'ignored', processed_at = now(), last_error = 'customer_redacted'
     where shop_domain = v_domain and payload is not null
       and ((p_customer_shopify_id is not null and (payload -> 'customer' ->> 'id' = p_customer_shopify_id::text
                                                    or (topic like 'customers/%' and payload ->> 'id' = p_customer_shopify_id::text)))
            or (topic like 'orders/%' and payload ->> 'id' = any (v_orders_named::text[])));
    get diagnostics v_inbox = row_count;
    v_status := 'completed';
    v_resolution := case when v_customers + v_orders + v_inbox > 0 then 'customer_data_redacted' else 'no_customer_data_held' end;
  else
    v_held := v_key is not null and (
      exists (select 1 from public.customers where shop_key = v_key and shopify_id = p_customer_shopify_id)
      or exists (select 1 from public.orders where shop_key = v_key
                  and (customer_shopify_id = p_customer_shopify_id or (shopify_id = any(v_orders_named) and customer_shopify_id is not null))));
    v_status := case when v_held then 'open' else 'completed' end;
    v_resolution := case when v_held then null else 'no_customer_data_held' end;
  end if;

  update public.shop_lifecycle_events set outcome = coalesce(v_resolution, 'customer_data_held') where id = v_event;
  insert into public.compliance_requests (lifecycle_event_id, topic, shopify_shop_id, shop_domain, received_at, due_at, status, resolution, completed_at)
  values (v_event, p_topic, p_shopify_shop_id, v_domain, now(), now() + interval '30 days', v_status, v_resolution,
          case when v_status = 'completed' then now() end)
  returning id into v_request;

  -- Suppressions are recorded whether or not any data was held: a later import must not bring it in.
  if p_topic = 'customers/redact' and v_shopify_shop is not null then
    insert into public.redaction_suppressions (shopify_shop_id, subject_type, subject_digest, key_version, compliance_request_id)
    select v_shopify_shop, d.subject_type, d.digest, coalesce(p_key_version, 1), v_request
      from (select 'customer' as subject_type, p_customer_digest as digest
            union all select 'order', unnest(coalesce(p_order_digests, '{}'))) d
     where d.digest is not null
    on conflict do nothing;
    get diagnostics v_suppressed = row_count;
  end if;

  return jsonb_build_object('outcome', v_status, 'compliance_request_id', v_request, 'resolution', v_resolution,
    'redacted', jsonb_build_object('customers', v_customers, 'orders', v_orders, 'inbox', v_inbox),
    'suppressed', v_suppressed);
end;
$$;

drop function public.compliance_exports_due(integer, integer, integer);
drop function public.mark_compliance_escalated(uuid, smallint);
drop function public.compliance_export_file_deleted(uuid, text);
drop function public.close_compliance_export(uuid, text);
drop function public.compliance_exports_for_owner(text, uuid);
drop function public.authorize_compliance_download(uuid, text);
drop function public.compliance_export_owner(uuid);
drop function public.mark_compliance_export_notified(uuid);
drop function public.fail_compliance_export(uuid, text, text);
drop function public.record_compliance_export(uuid, text, text, bigint, text, smallint, jsonb);
drop function public.compliance_export_related(uuid, text);
drop function public.compliance_export_orders(uuid, text, bigint, integer);
drop function public.compliance_export_customer(uuid, text);
drop function public.claim_compliance_export(uuid, text, integer);
drop function public.mark_compliance_export_dispatched(uuid, text);
drop function public.compliance_export_for_run(uuid, text);
drop table public.compliance_exports;
