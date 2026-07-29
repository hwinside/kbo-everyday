# 야구 용어/룰 질문 AI MVP (baseball-qa)

- 상태: 스펙 확정 → 구현 (2026-07-30)
- 승인: 하린아빠 (#cs 스레드 1785337823.334019 "만들어보자!")
- 계약: 삼순 조건부 GO — 검수 사전 우선(토큰 0) → 동일질문 캐시 → 미매칭만 초저가 LLM + 4중 가드
- Notion SSOT: 야구 용어/룰 질문 AI MVP 스펙 (기획/스펙)

## 1. 목표 / 비목표

**목표**
- 야구 입문 유저가 룰/용어를 물어보면 3줄 이내의 쉬운 한국어 설명을 즉시 받는다.
- 운영 비용을 구조적으로 0에 수렴시킨다: 상위 질문 대부분을 검수 사전(토큰 0)으로, 재질문은 캐시로, LLM은 미매칭 잔여분만.
- 모든 질문을 로그로 남겨 LLM 호출률·비용·오답 신고를 측정 가능하게 한다.

**비목표 (MVP 제외)**
- 대화형(멀티턴) 챗봇 — 단발 질문/답변만.
- 경기 데이터/선수 기록 질의 (기존 contextual-stats 영역).
- 실시간 판정 논쟁 판단("방금 그 판정 맞았나요?").
- 임베딩/벡터 검색 — 정규화 exact 매칭으로 시작, 히트율 데이터 보고 후속 판단.

## 2. 3단 파이프라인

```
질문 → [가드: 길이/한도] → 정규화(normalize)
  → ① 사전 매칭 (baseball_glossary, term+aliases exact) …… 토큰 0
  → ② 캐시 매칭 (baseball_qa_cache, question_norm exact) … 토큰 0
  → ③ Gemini flash-lite 단발 호출 (미매칭만)
       → 야구 외 질문: "NOT_BASEBALL" 센티널 → 차단 안내
       → 불확실: "UNSURE" 센티널 → "잘 모르겠어요" (추측 금지)
       → 정상 답변: 캐시에 저장 (같은 질문 재호출 방지)
  → 전 경로 baseball_qa_log 기록 (match_path + 토큰 수)
```

**정규화 규칙** (`src/lib/baseball-qa/normalize.ts`)
- NFKC → 소문자 → 공백/문장부호 전부 제거
- 질문형 어미 반복 제거: "~가뭐야/뭔가요/무엇인가요/무슨뜻(이야|인가요)/알려줘/설명해줘" 등
- 후행 조사 제거: 이란/란/이/가/은/는/을/를
- 예: "ABS가 뭐예요?" → "abs", "보크란 무엇인가요" → "보크"

**사전 매칭**: 정규화 질문 == 정규화(term 또는 alias). 사전은 서버 모듈 메모리에 10분 캐시(테이블 ≤ 수백 행, bounded).

## 3. DB 스키마 (migration: `supabase/migrations/20260730_baseball_qa.sql` + `_seed.sql`)

```sql
baseball_glossary (
  id uuid PK, term text UNIQUE, aliases text[], answer text,
  category text, source text, created_at timestamptz
)
baseball_qa_cache (
  id uuid PK, question_norm text UNIQUE, answer text,
  hit_count int, created_at, last_hit_at
)
baseball_qa_log (
  id uuid PK, user_id uuid, question text, question_norm text,
  match_path text CHECK IN ('dictionary','cache','llm','blocked','unsure','limited','error'),
  answer text, input_tokens int, output_tokens int, created_at
)  -- index (user_id, created_at) → 일일 한도 카운트
```

- 3테이블 모두 RLS ENABLE + 정책 0개 → 클라 직접 접근 차단, route(service-role) 전용.
- 시드: 검수 KBO 룰/용어 100+개 (KBO 공식 야구규칙/리그규정 기반, 불확실 항목 제외 원칙).
- **프로덕션 적용은 머지 게이트(삼순 GO + 하린아빠 승인) 이후.**

## 4. API 계약

`POST /api/baseball-qa` (인증 필수, Bearer)

요청: `{ "question": "보크가 뭐야?" }` (2~200자)

응답 200: `{ "answer": "...", "source": "dictionary|cache|llm|blocked|unsure", "term": "보크"?, "remaining": 19 }`
- `blocked`: "야구 룰/용어 질문만 답할 수 있어요" (야구 외 차단)
- `unsure`: "잘 모르겠어요…" (추측 금지 보류; 한도 차감 O, 캐시 저장 X)

에러: 400(형식), 401(비로그인), 429(일일 한도 초과), 503(LLM 실패 — 사전/캐시는 영향 없음)

## 5. LLM (③단계 전용)

- 모델: `gemini-2.5-flash-lite` (기존 AI 경기요약과 동일 `GEMINI_API_KEY`, generativelanguage v1beta REST)
- 시스템 프롬프트(고정, 짧게): KBO/야구 룰·용어만, 80~120자 쉬운 한국어, 모르면 정확히 `UNSURE`, 야구와 무관하면 정확히 `NOT_BASEBALL`, 추측 금지.
- 대화이력 미전송(단발). `maxOutputTokens` 제한. temperature 0.2.
- 정상 답변만 `baseball_qa_cache`에 저장 → 동일 질문 재호출 0회.

## 6. 가드 / 한도 정책

1. **야구 외 차단(이중)**: ①사전/캐시는 야구 용어만 존재 ②LLM 프롬프트 `NOT_BASEBALL` 센티널 → 서버가 차단 응답으로 치환(LLM 원문 미노출).
2. **추측 금지**: `UNSURE` 센티널 → 고정 보류 응답. 캐시에 저장하지 않음(사전 보강 후 정답 제공 여지).
3. **일일 한도**: 사용자별 20회/일 (KST 자정 리셋, `baseball_qa_log` count — feedback 패턴 동일). 사전/캐시 히트도 카운트(남용 방지), 429 시 로그 `limited`.
4. **입력 가드**: 2~200자, 인증 필수(익명 불가 → 어뷰즈 시 사용자 단위 대응 가능).
5. **로그**: 전 질문 `baseball_qa_log` (질문/정규화/경로/답변/토큰) → 비용·오답 추적.

## 7. 비용 추정

- flash-lite 단가: 입력 $0.10/1M tok, 출력 $0.40/1M tok.
- 1콜 ≈ 입력 ~250tok + 출력 ~120tok ≈ **$0.00007 (약 0.1원)**.
- 보수적 시나리오: DAU 500 × 1질문 × LLM 도달률 30% = 150콜/일 ≈ $0.011/일 ≈ **월 $0.3**. 캐시 적중 상승 시 추가 하락. 한도(20/일)로 상한 고정: 이론상 최악에도 유저당 월 $0.04.

## 8. UI / 진입점

- 페이지: `/learn/ask` — "야구 궁금증 바로 묻기". 검색/질문 입력 + 추천 질문 칩(사전 히트 보장 용어 6개) + 답변 카드(출처 배지: 크보팬 용어사전/AI 답변). 비로그인 시 로그인 유도.
- 진입점: **야구 쉽게 배우기(`/learn`) 상단 카드** — 입문 유저 타겟과 동일 동선이라 최적. (경기상세 진입은 히트율 데이터 확인 후 후속.)

## 9. 롤아웃 / 측정 지표

- 롤아웃: 머지 게이트 통과 → migration(스키마+시드) 적용 → 배포 → /learn 진입 카드 노출. 플래그 없이 페이지 단위 출시(진입점 1곳이라 리스크 최소).
- 지표 (baseball_qa_log 기반, 주간 리뷰):
  - **LLM 호출률** = llm / (dictionary+cache+llm) — 목표 < 40%, 상위 미매칭 질문은 사전에 승격.
  - **차단/보류율** = (blocked+unsure) / 전체 — unsure 상위 질문도 사전 승격 후보.
  - **오답률**: 로그 샘플 검수(주 1회) + 기존 피드백(건의) 채널로 신고 수집 — 목표 0 유지, 오답 발견 시 사전 term 우선 등재로 LLM 우회.
  - 일일 질문 수 / 한도 도달 유저 수 / 누적 토큰(비용).

## 10. 검증 (DoD)

- tsc 0 / eslint 신규 0 / full prebuild(qa:query-guard 포함) PASS
- `qa:baseball-qa` 파이프라인 스모크: 사전 매칭·별칭·정규화·캐시 적중·미매칭 LLM 폴백(mock)·NOT_BASEBALL 차단·UNSURE 보류·일일 한도 — 전부 PASS
- migration 프로덕션 적용 금지(머지 게이트 후), 시크릿 비노출
