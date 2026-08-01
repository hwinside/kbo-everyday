-- Reject only new Kakao OAuth users whose provider has not verified the email.
-- The Before User Created hook runs before auth.users insertion and before
-- GoTrue attempts to send a confirmation email.

create schema if not exists auth_hooks;

revoke all on schema auth_hooks from public;
grant usage on schema auth_hooks to supabase_auth_admin;

create or replace function auth_hooks.reject_unverified_kakao(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
begin
  if event #>> '{user,app_metadata,provider}' = 'kakao'
     and event #> '{user,user_metadata,email_verified}' is distinct from 'true'::jsonb
  then
    return jsonb_build_object(
      'error',
      jsonb_build_object(
        'http_code', 422,
        'message', 'KAKAO_EMAIL_UNVERIFIED'
      )
    );
  end if;

  return '{}'::jsonb;
end;
$function$;

revoke all
  on function auth_hooks.reject_unverified_kakao(jsonb)
  from public, anon, authenticated, service_role;

grant execute
  on function auth_hooks.reject_unverified_kakao(jsonb)
  to supabase_auth_admin;

comment on function auth_hooks.reject_unverified_kakao(jsonb) is
  'Before User Created hook: reject only new Kakao users without a provider-verified email.';
