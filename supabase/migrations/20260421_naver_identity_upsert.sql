-- Naver OAuth identity upsert RPC
-- Spec: 2026-04-21 fryfish 모바일 로그인 실패 / 네이버 가입자 175명 identity 누락 P0
--
-- 배경:
--   Supabase는 네이버를 공식 OAuth provider로 지원하지 않아서
--   커스텀 콜백(/api/auth/naver/callback)이 admin.createUser({email})만 호출함 →
--   auth.identities에 email provider row만 자동 생성되고 naver provider row는 누락.
--   이 상태에서 Supabase의 OAuth/OIDC 흐름 어느 단계에서도 이 유저를 "네이버로 로그인했다"고
--   식별하지 못해 재로그인/연동 관리에 문제가 발생함.
--
-- 해법:
--   카카오/구글이 자동 생성하는 auth.identities row와 동일한 스키마로
--   naver provider row를 수동 upsert. service_role이 호출 가능한 SECURITY DEFINER 함수로 노출.
--
-- 호출:
--   supabase.rpc('upsert_naver_identity', {
--     p_user_id: uuid,
--     p_provider_id: text,  -- 네이버 고유 id (naverProfile.id)
--     p_identity_data: jsonb,
--     p_created_at: timestamptz
--   })

create or replace function public.upsert_naver_identity(
  p_user_id uuid,
  p_provider_id text,
  p_identity_data jsonb,
  p_created_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_existing auth.identities%rowtype;
begin
  -- 동일 (provider, provider_id) 조합 이미 존재하는지 확인
  select * into v_existing
    from auth.identities
    where provider = 'naver' and provider_id = p_provider_id
    limit 1;

  if found then
    -- 이미 있으면 identity_data + updated_at만 갱신
    update auth.identities
      set identity_data = p_identity_data,
          updated_at = now(),
          last_sign_in_at = now()
      where provider = 'naver' and provider_id = p_provider_id;
  else
    -- 신규 insert. prod 스키마: auth.identities.id는 uuid NOT NULL, email 컬럼 존재.
    -- 카카오/구글 row 검증 결과 id는 자동 생성 UUID이고 email은 identity_data와 동일.
    insert into auth.identities (
      id,
      user_id,
      identity_data,
      provider,
      provider_id,
      email,
      last_sign_in_at,
      created_at,
      updated_at
    ) values (
      gen_random_uuid(),                  -- 카카오/구글과 동일하게 자동 생성 UUID
      p_user_id,
      p_identity_data,
      'naver',
      p_provider_id,
      p_identity_data->>'email',          -- 카카오/구글이 채우는 email 컬럼 동일하게 채움
      p_created_at,
      p_created_at,
      now()
    );
  end if;
end;
$$;

-- service_role에게만 실행 권한 부여
revoke all on function public.upsert_naver_identity(uuid, text, jsonb, timestamptz) from public;
revoke all on function public.upsert_naver_identity(uuid, text, jsonb, timestamptz) from authenticated;
revoke all on function public.upsert_naver_identity(uuid, text, jsonb, timestamptz) from anon;
grant execute on function public.upsert_naver_identity(uuid, text, jsonb, timestamptz) to service_role;

comment on function public.upsert_naver_identity is
  'Naver OAuth identity upsert. service_role 전용. /api/auth/naver/callback에서 호출.';
