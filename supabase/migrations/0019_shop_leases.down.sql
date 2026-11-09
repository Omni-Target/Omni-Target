-- Reverses 0019. Open leases are discarded; installations in progress fail closed.

drop function if exists public.record_shop_update(bigint, text, text);
drop function if exists public.complete_transfer_under_lease(text, uuid, uuid, text, bigint);
drop function if exists public.bind_shop_under_lease(text, uuid, bigint, text, text, uuid, text);
drop function if exists public.connect_check_under_lease(text, uuid, text, uuid);
drop function if exists public.shop_lease_held(text, uuid);
drop function if exists public.hold_shop_lease(text, uuid);
drop function if exists public.release_shop_lease(text, uuid);
drop function if exists public.acquire_shop_lease(text, text, text, integer);
drop function if exists public.install_lease_key(text);
drop table if exists public.shop_leases;

grant execute on function
  public.bind_shop_for_install(bigint, text, text, uuid, text),
  public.complete_ownership_transfer(uuid, text, bigint)
to service_role;
