-- register-device(비인증)가 push_to_start_token으로 user_id를 역매핑하므로 토큰은 유저에
-- 유일해야 한다(삼순 #447 NO-GO). 같은 기기를 다른 계정이 쓰면(로그아웃→재로그인) 같은
-- 토큰이 여러 user row에 남을 수 있어, 최신(updated_at) 1개만 남기고 정리 후 unique 인덱스로
-- 강제한다. 이후 register-start가 등록 시 타 유저 row를 정리해 유일성을 유지한다.

-- 1) 중복 정리 — 같은 토큰 중 최신 updated_at(동률이면 user_id 큰 것) 1개만 보존.
delete from public.live_activity_start_tokens a
  using public.live_activity_start_tokens b
  where a.push_to_start_token = b.push_to_start_token
    and (a.updated_at < b.updated_at
         or (a.updated_at = b.updated_at and a.user_id < b.user_id));

-- 2) 토큰 유일성 강제.
create unique index if not exists live_activity_start_tokens_token_uniq
  on public.live_activity_start_tokens (push_to_start_token);
