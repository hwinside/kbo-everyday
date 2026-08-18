-- 검증 완료 RAG 답변 replay 원장 (2026-08-19 맛자욱 P0 — 동일입력 결정론).
--
-- 같은 프롬프트(input_tokens 동일)가 GROUNDED↔INSUFFICIENT 로 실제 플립했다.
-- temperature 0 으로도 provider 생성 변동이 원리적으로 남으므로, **출력 가드를 전부
-- 통과한(grounded) 답변**을 아래 키로 고정해 재질문 시 재사용한다:
--   entity + 정규화 질문 + 근거 fingerprint(corpus revision·순서·projection 결과 결속)
--   + 프롬프트 fingerprint.
-- corpus 재적재·프롬프트 변경은 fingerprint 불일치로 자동 무효(replay miss)가 된다.
-- insufficient/폐기 답변은 저장하지 않는다 — 일시적 생성 실패를 영구 고정하면 오답 캐시다.

create table if not exists public.genius_rag_verified_answers (
  entity_type text not null check (entity_type = 'player'),
  entity_id text not null,
  question_norm text not null,
  evidence_fingerprint text not null,
  prompt_fingerprint text not null,
  answer text not null check (char_length(answer) between 1 and 1200),
  source_url text,
  tone_compliant boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (entity_type, entity_id, question_norm, evidence_fingerprint, prompt_fingerprint)
);

comment on table public.genius_rag_verified_answers is
  '검증(출력 가드) 통과 RAG 답변 replay 원장 — 동일입력 결정론 (맛자욱 P0). 키 exact 일치 시에만 재생.';

-- service role 전용 — 클라이언트 직접 접근 경로 없음.
alter table public.genius_rag_verified_answers enable row level security;
