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
-- ── 동시성 (삼순 P0-②) ────────────────────────────────────────────────────
-- status 2상으로 replay-key 단위 선점을 겸한다:
--   'pending' = winner 가 생성 중 (claim 성공 = 이 행 INSERT 성공. 동시 첫 miss 에서
--               PK 충돌로 정확히 한 worker 만 winner 가 된다)
--   'settled' = grounded 답 고정 완료 — get 은 settled 만 재생한다.
-- winner 가 grounded 를 못 만들면 pending 행을 DELETE(release)해 loser deadlock 을 막고,
-- 죽은 winner 는 claimed_at 만료(기본 60초)로 다음 claim 이 인수한다.

create table if not exists public.genius_rag_verified_answers (
  entity_type text not null check (entity_type = 'player'),
  entity_id text not null,
  question_norm text not null,
  evidence_fingerprint text not null,
  request_fingerprint text not null,
  status text not null default 'pending' check (status in ('pending', 'settled')),
  -- settled 에서만 채워진다. pending 은 자리표시자 없이 NULL.
  answer text check (answer is null or char_length(answer) between 1 and 1200),
  source_url text,
  tone_compliant boolean not null default true,
  claimed_at timestamptz not null default now(),
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  -- settle 계약: settled 면 answer 필수, pending 이면 answer 없음.
  constraint genius_rag_verified_answers_settle_shape
    check ((status = 'settled') = (answer is not null and settled_at is not null)),
  primary key (entity_type, entity_id, question_norm, evidence_fingerprint, request_fingerprint)
);

comment on table public.genius_rag_verified_answers is
  '검증(출력 가드) 통과 RAG 답변 replay 원장 + replay-key 선점(pending/settled) — 동일입력 결정론 (맛자욱 P0). 키 exact 일치·settled 만 재생.';

-- service role 전용 — 클라이언트 직접 접근 경로 없음 (정책 미부여 = anon/auth 전면 차단).
alter table public.genius_rag_verified_answers enable row level security;

-- claim RPC: 원자적 선점/판정. 반환 'winner' | 'wait' | 'hit'.
--   INSERT 성공        → winner (이 worker 가 생성 책임)
--   기존 행 settled    → hit
--   기존 행 pending    → 만료 전 wait / 만료 후 인수(winner — 죽은 winner 복구)
create or replace function public.claim_genius_rag_verified_answer(
  p_entity_type text,
  p_entity_id text,
  p_question_norm text,
  p_evidence_fingerprint text,
  p_request_fingerprint text,
  p_lease_seconds integer default 60
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_claimed_at timestamptz;
begin
  insert into genius_rag_verified_answers as t
    (entity_type, entity_id, question_norm, evidence_fingerprint, request_fingerprint, status, claimed_at)
  values
    (p_entity_type, p_entity_id, p_question_norm, p_evidence_fingerprint, p_request_fingerprint, 'pending', now())
  on conflict (entity_type, entity_id, question_norm, evidence_fingerprint, request_fingerprint)
    do nothing;
  if found then
    return 'winner';
  end if;

  select status, claimed_at into v_status, v_claimed_at
    from genius_rag_verified_answers
   where entity_type = p_entity_type and entity_id = p_entity_id
     and question_norm = p_question_norm
     and evidence_fingerprint = p_evidence_fingerprint
     and request_fingerprint = p_request_fingerprint
   for update;
  if v_status is null then
    -- 충돌 직후 release 로 사라진 창 — 재삽입 시도 없이 winner 인수(다음 claim 이 정리).
    insert into genius_rag_verified_answers
      (entity_type, entity_id, question_norm, evidence_fingerprint, request_fingerprint, status, claimed_at)
    values
      (p_entity_type, p_entity_id, p_question_norm, p_evidence_fingerprint, p_request_fingerprint, 'pending', now())
    on conflict do nothing;
    return case when found then 'winner' else 'wait' end;
  end if;
  if v_status = 'settled' then
    return 'hit';
  end if;
  -- pending: 만료된 lease 는 인수한다(죽은 winner 복구).
  if v_claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 1)) then
    update genius_rag_verified_answers
       set claimed_at = now()
     where entity_type = p_entity_type and entity_id = p_entity_id
       and question_norm = p_question_norm
       and evidence_fingerprint = p_evidence_fingerprint
       and request_fingerprint = p_request_fingerprint
       and status = 'pending';
    return 'winner';
  end if;
  return 'wait';
end;
$$;

revoke all on function public.claim_genius_rag_verified_answer(text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_genius_rag_verified_answer(text, text, text, text, text, integer) to service_role;
