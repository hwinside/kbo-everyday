-- Naver custom OAuth needs an indexed, constant-time existing-user lookup.
-- listUsers pagination previously stopped after 20,000 users and treated older
-- existing users as new, causing create_user_error on duplicate email.

create or replace function public.lookup_auth_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, auth
as $$
  select u.id
  from auth.users as u
  where u.email = lower(btrim(p_email))
    and u.is_sso_user = false
  order by u.created_at asc
  limit 1;
$$;

revoke all on function public.lookup_auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.lookup_auth_user_id_by_email(text) to service_role;
