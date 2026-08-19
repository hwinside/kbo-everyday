-- 검증 완료 RAG 답변 replay 원장 (2026-08-19 맛자욱 P0 — 동일입력 결정론).
--
-- 같은 프롬프트(input_tokens 동일)가 GROUNDED↔INSUFFICIENT 로 실제 플립했다.
-- temperature 0 으로도 provider 생성 변동이 원리적으로 남으므로, **출력 가드를 전부
-- 통과한(grounded) 답변**을 아래 키로 고정해 재질문 시 재사용한다:
--   entity + 정규화 질문 + 근거 fingerprint(corpus revision·순서·projection 결과 결속)
--   + 요청 fingerprint(**model id + 실제 buildRagLlmRequest 요청 전체** — 원문 질문·
--     시스템 프롬프트·직전 대화 context·rosterBlock·generationConfig, 삼순 P0-①).
-- corpus 재적재·모델 교체·프롬프트/요청 형태 변경은 fingerprint 불일치로 자동 무효.
-- insufficient/폐기 답변은 settle 하지 않는다 — 일시적 생성 실패를 영구 고정하면 오답 캐시다.
--
-- ── 동시성 — owner-token CAS (삼순 P0-② + 2차 NO-GO + 3차 NO-GO) ────────────
-- status 3상 + owner_token fencing 으로 replay-key 단위 선점을 겸한다:
--   'pending' = winner 가 생성 중. claim 은 owner_token(uuid)을 발급하며, lease 만료
--               인수(takeover)는 **token 을 교체**한다 — 죽은 구 winner 의 token 은 그
--               순간 무효가 되어 stale settle/release 가 새 claim 을 건드릴 수 없다.
--   'settled' = grounded 답 고정 완료 — get 은 settled 만 재생하고, settled 는 어떤
--               경로로도 덮어쓰지 않는다(first-writer-wins).
--   'insufficient' = winner 가 non-grounded 로 사용자 응답을 끝냈다(삼순 3차 NO-GO).
--               같은 flight(lease TTL 내)의 모든 claim 은 같은 폐기 문구를 받아 재생한다
--               — release 로 풀면 waiter 가 새 winner 가 되어 같은 동시입력이 2답(자료
--               부족 vs GROUNDED)·LLM 2회로 갈라진다(역방향 플립). lease 만료 후 새
--               요청은 token 교체로 인수해 재생성한다 — 일시 실패의 영구 고정(오답
--               캐시) 금지 유지.
-- settle/mark/release 는 **token CAS** 로만 성공한다. settle CAS 패자는 앱이 canonical
-- 답을 재조회해 반환한다(자기 생성답 발송 금지 — 응답 결정론).

create table if not exists public.genius_rag_verified_answers (
  entity_type text not null check (entity_type = 'player'),
  entity_id text not null,
  question_norm text not null,
  evidence_fingerprint text not null,
  request_fingerprint text not null,
  status text not null default 'pending' check (status in ('pending', 'settled', 'insufficient')),
  -- pending 선점의 fencing token. settled 로 올라간 뒤에는 비교 대상이 아니다.
  owner_token uuid not null default gen_random_uuid(),
  -- settled(검증답)·insufficient(flight 공유 폐기 문구)에서 채워진다. pending 은 NULL.
  answer text check (answer is null or char_length(answer) between 1 and 1200),
  source_url text,
  tone_compliant boolean not null default true,
  claimed_at timestamptz not null default now(),
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  -- 상태 계약: settled 면 answer+settled_at 필수, insufficient 는 answer 필수(settled_at 없음),
  -- pending 은 둘 다 없음.
  constraint genius_rag_verified_answers_settle_shape
    check (
      (status = 'settled' and answer is not null and settled_at is not null)
      or (status = 'insufficient' and answer is not null and settled_at is null)
      or (status = 'pending' and answer is null and settled_at is null)
    ),
  primary key (entity_type, entity_id, question_norm, evidence_fingerprint, request_fingerprint)
);

comment on table public.genius_rag_verified_answers is
  '검증(출력 가드) 통과 RAG 답변 replay 원장 + owner-token CAS 선점(pending/settled) — 동일입력 결정론 (맛자욱 P0). 키 exact 일치·settled 만 재생.';

-- service role 전용 — 클라이언트 직접 접근 경로 없음 (정책 미부여 = anon/auth 전면 차단).
alter table public.genius_rag_verified_answers enable row level security;

-- claim RPC: 원자적 선점/판정. jsonb 반환:
--   {"verdict":"winner","owner_token":"<uuid>"} — INSERT 성공 또는 lease 만료 인수(token 교체)
--   {"verdict":"hit"}   — settled 답 존재
--   {"verdict":"wait"}  — 다른 winner 가 유효 lease 로 생성 중
--   {"verdict":"insufficient","answer":"<문구>"} — 이 flight 의 winner 가 non-grounded 로
--       종결 — 같은 폐기 문구 재생(재생성 금지). lease 만료 시에는 winner 로 인수된다.
create or replace function public.claim_genius_rag_verified_answer(
  p_entity_type text,
  p_entity_id text,
  p_question_norm text,
  p_evidence_fingerprint text,
  p_request_fingerprint text,
  p_lease_seconds integer default 60
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid := gen_random_uuid();
  v_status text;
  v_claimed_at timestamptz;
  v_answer text;
begin
  insert into genius_rag_verified_answers
    (entity_type, entity_id, question_norm, evidence_fingerprint, request_fingerprint, status, owner_token, claimed_at)
  values
    (p_entity_type, p_entity_id, p_question_norm, p_evidence_fingerprint, p_request_fingerprint, 'pending', v_token, now())
  on conflict (entity_type, entity_id, question_norm, evidence_fingerprint, request_fingerprint)
    do nothing;
  if found then
    return jsonb_build_object('verdict', 'winner', 'owner_token', v_token);
  end if;

  select status, claimed_at, answer into v_status, v_claimed_at, v_answer
    from genius_rag_verified_answers
   where entity_type = p_entity_type and entity_id = p_entity_id
     and question_norm = p_question_norm
     and evidence_fingerprint = p_evidence_fingerprint
     and request_fingerprint = p_request_fingerprint
   for update;
  if v_status is null then
    -- 충돌 직후 release 로 행이 사라진 좁은 창 — 이번 호출은 wait 로 물러난다.
    -- (즉시 재삽입하면 release 직후 두 worker 가 동시에 winner 가 되는 창이 생긴다.
    --  다음 폴링의 claim 이 정상 INSERT 경로로 승자를 다시 정한다.)
    return jsonb_build_object('verdict', 'wait');
  end if;
  if v_status = 'settled' then
    return jsonb_build_object('verdict', 'hit');
  end if;
  -- pending/insufficient: 만료 lease 는 **token 교체 + pending 복귀**로 인수한다
  -- (fencing — 구 winner 무효화. insufficient 도 TTL 후엔 새 flight 가 재생성 — 영구 캐시 금지).
  if v_claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 1)) then
    update genius_rag_verified_answers
       set claimed_at = now(), owner_token = v_token, status = 'pending', answer = null
     where entity_type = p_entity_type and entity_id = p_entity_id
       and question_norm = p_question_norm
       and evidence_fingerprint = p_evidence_fingerprint
       and request_fingerprint = p_request_fingerprint
       and status in ('pending', 'insufficient');
    return jsonb_build_object('verdict', 'winner', 'owner_token', v_token);
  end if;
  -- flight-terminal insufficient (삼순 3차 NO-GO): 같은 flight 전원 같은 폐기 문구 재생.
  if v_status = 'insufficient' then
    return jsonb_build_object('verdict', 'insufficient', 'answer', v_answer);
  end if;
  return jsonb_build_object('verdict', 'wait');
end;
$$;

-- mark-insufficient RPC: token CAS — 이 token 이 소유한 pending 행만 'insufficient' 로
-- 전이시킨다(삼순 3차 NO-GO — non-grounded 종결을 같은 flight 에 공유해 재생성 2답 분기 차단).
-- settled/타 token 행은 건드리지 않는다.
create or replace function public.mark_insufficient_genius_rag_verified_answer(
  p_entity_type text,
  p_entity_id text,
  p_question_norm text,
  p_evidence_fingerprint text,
  p_request_fingerprint text,
  p_owner_token uuid,
  p_answer text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update genius_rag_verified_answers
     set status = 'insufficient', answer = p_answer, claimed_at = now()
   where entity_type = p_entity_type and entity_id = p_entity_id
     and question_norm = p_question_norm
     and evidence_fingerprint = p_evidence_fingerprint
     and request_fingerprint = p_request_fingerprint
     and status = 'pending'
     and owner_token = p_owner_token;
  return found;
end;
$$;

-- settle RPC: token CAS — 이 token 이 여전히 pending 의 소유자일 때만 settled 로 올린다.
-- 반환 true = 내 답이 canonical. false = CAS 패배(이미 settled / token 교체됨 / 행 없음).
-- settled 는 어떤 경우에도 갱신하지 않는다(first-writer-wins).
create or replace function public.settle_genius_rag_verified_answer(
  p_entity_type text,
  p_entity_id text,
  p_question_norm text,
  p_evidence_fingerprint text,
  p_request_fingerprint text,
  p_owner_token uuid,
  p_answer text,
  p_source_url text,
  p_tone_compliant boolean
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update genius_rag_verified_answers
     set status = 'settled', answer = p_answer, source_url = p_source_url,
         tone_compliant = p_tone_compliant, settled_at = now()
   where entity_type = p_entity_type and entity_id = p_entity_id
     and question_norm = p_question_norm
     and evidence_fingerprint = p_evidence_fingerprint
     and request_fingerprint = p_request_fingerprint
     and status = 'pending'
     and owner_token = p_owner_token;
  return found;
end;
$$;

-- release RPC: token CAS — 이 token 이 소유한 pending 행만 지운다.
-- lease 인수로 token 이 교체된 뒤 구 winner 의 stale release 는 no-op 이다.
create or replace function public.release_genius_rag_verified_answer(
  p_entity_type text,
  p_entity_id text,
  p_question_norm text,
  p_evidence_fingerprint text,
  p_request_fingerprint text,
  p_owner_token uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from genius_rag_verified_answers
   where entity_type = p_entity_type and entity_id = p_entity_id
     and question_norm = p_question_norm
     and evidence_fingerprint = p_evidence_fingerprint
     and request_fingerprint = p_request_fingerprint
     and status = 'pending'
     and owner_token = p_owner_token;
  return found;
end;
$$;

revoke all on function public.claim_genius_rag_verified_answer(text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_genius_rag_verified_answer(text, text, text, text, text, integer) to service_role;
revoke all on function public.settle_genius_rag_verified_answer(text, text, text, text, text, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.settle_genius_rag_verified_answer(text, text, text, text, text, uuid, text, text, boolean) to service_role;
revoke all on function public.release_genius_rag_verified_answer(text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.release_genius_rag_verified_answer(text, text, text, text, text, uuid) to service_role;
revoke all on function public.mark_insufficient_genius_rag_verified_answer(text, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_insufficient_genius_rag_verified_answer(text, text, text, text, text, uuid, text) to service_role;
