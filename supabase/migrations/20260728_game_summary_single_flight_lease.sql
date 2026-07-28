-- AI 경기요약 생성 livelock 근본수정: claim 을 true single-flight(lease) 로 전환.
--
-- 배경(삼순 P0 진단): 20260726 fence 의 claim_game_summary_generation() 은 동일 gameId 의
-- 동시 요청마다 nextval 로 새 token 을 발급하고 항상 최신 token 으로 claims 행을 덮었다.
-- Gemini 생성(수초)이 끝나 save 할 때쯤엔 그 사이 도착한 다른 사용자 요청/409 재시도가 이미
-- 더 높은 token 을 심어 두어 save_game_summary_if_current() 의 current-token exact-match 가
-- 실패 → 모든 선행 저장이 superseded(409). 그 409 가 다시 재요청을 유발하는 livelock 이 되어
-- 종료·boxscore 가 정상인 경기도 summary 가 영구 null 로 남았다(오늘 WOLG 등).
--
-- 처방: 동일 gameId 당 "활성 생성 1개"만 진행되도록 lease 를 둔다.
--   - claim: 유효 lease(claimed_at > now()-TTL)가 이미 있으면 새 token 을 발급/덮지 않고 NULL 반환
--     → 후발 요청은 backoff(라우트가 생성하지 않음), 선행 생성이 token 을 유지한 채 저장 성공.
--   - 첫 claim(행 부재) race 는 gameId 별 advisory xact lock 으로 직렬화.
--   - 죽은/멈춘 생성은 TTL(120s) 경과 후 다음 claim 이 인수 → 영구 잠김 없음.
--   - save 성공 시 lease 를 즉시 해제(claimed_at = -infinity)해 이후 fingerprint 변경 재생성이
--     TTL 만큼 막히지 않게 한다(generation_token 은 유지 → 단조 증가/순서 보존).
--
-- 테이블/시퀀스/grant 는 20260726 에서 생성됨. 여기서는 두 함수만 재정의(idempotent).

create or replace function public.claim_game_summary_generation(p_game_id text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token bigint;
  v_existing_token bigint;
  v_existing_claimed_at timestamptz;
  v_lease constant interval := interval '120 seconds';
begin
  if p_game_id is null or p_game_id = '' then
    raise exception 'game_id required';
  end if;

  -- gameId 별 직렬화. 행이 아직 없을 때의 첫 claim race 까지 안전하게 single-flight 로 만든다.
  perform pg_advisory_xact_lock(hashtext('game_summary_gen:' || p_game_id));

  select generation_token, claimed_at
    into v_existing_token, v_existing_claimed_at
    from public.game_summary_generation_claims
   where game_id = p_game_id;

  -- 활성 lease 를 다른 생성이 들고 있으면 새 token 을 발급/덮지 않는다(NULL = backoff 신호).
  if v_existing_token is not null
     and v_existing_claimed_at is not null
     and v_existing_claimed_at > now() - v_lease then
    return null;
  end if;

  -- 신규이거나 lease 가 만료됨 → lease 인수 + 새 token 발급.
  v_token := nextval('public.game_summary_generation_seq');
  insert into public.game_summary_generation_claims (game_id, generation_token, claimed_at)
  values (p_game_id, v_token, now())
  on conflict (game_id) do update
    set generation_token = excluded.generation_token,
        claimed_at = excluded.claimed_at;

  return v_token;
end;
$$;

create or replace function public.save_game_summary_if_current(
  p_game_id text,
  p_generation_token bigint,
  p_summary jsonb,
  p_prompt_version integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_token bigint;
begin
  select generation_token
    into v_current_token
    from public.game_summary_generation_claims
   where game_id = p_game_id
   for update;

  if v_current_token is null or v_current_token is distinct from p_generation_token then
    return false;
  end if;

  insert into public.game_summaries (game_id, summary, prompt_version, created_at)
  values (p_game_id, p_summary, p_prompt_version, now())
  on conflict (game_id) do update
    set summary = excluded.summary,
        prompt_version = excluded.prompt_version,
        created_at = excluded.created_at;

  -- 저장 성공 → lease 해제. 이후 fingerprint 변경 재생성이 TTL 만큼 막히지 않게 한다.
  -- generation_token 은 그대로 두어(다음 claim 이 더 큰 token 을 받음) 단조성/superseded 검증을 보존.
  update public.game_summary_generation_claims
     set claimed_at = '-infinity'::timestamptz
   where game_id = p_game_id;

  return true;
end;
$$;

revoke all on function public.claim_game_summary_generation(text) from public, anon, authenticated;
revoke all on function public.save_game_summary_if_current(text, bigint, jsonb, integer) from public, anon, authenticated;
grant execute on function public.claim_game_summary_generation(text) to service_role;
grant execute on function public.save_game_summary_if_current(text, bigint, jsonb, integer) to service_role;
