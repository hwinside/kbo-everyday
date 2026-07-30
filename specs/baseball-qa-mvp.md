# 야잘알봇 — 야구 룰/용어 질문 AI MVP v1.2

- 상태: 구현 결정 완료 — 삼순 재리뷰 대기
- Notion SSOT: https://www.notion.so/3acc901bb3728165b783d0f0960c9f02
- 범위: 신규 화면 0개, `/messages` 고정 DM과 기존 DM 인프라 재사용
- migration은 머지 게이트 뒤 적용한다. PR 단계에서는 적용하지 않는다.

## 1. 목표 / 비목표

야구 입문 유저가 룰·용어를 짧고 정확하게 묻고, 검수 사전 → 캐시 → 미매칭
LLM 순으로 비용을 0에 수렴시킨다. 선수·구단 기록/히스토리, 서비스 문의,
판정 논쟁, 실시간 경기, 자유 잡담은 MVP 답변 범위가 아니다.

## 2. 고정 DM UX

- `/learn/ask`와 `/learn` 진입 카드를 제거한다.
- `/messages` 최상단에 `야잘알봇` 방을 대화 유무와 무관하게 항상 고정한다.
- 최초 질문은 `new-${BASEBALL_GENIUS_USER_ID}` 가상 row에서 기존
  `send_dm_message_atomic` RPC로 대화와 유저 메시지를 원자 생성한다.
- 서버는 해당 사용자·대화·메시지 소유권을 재검증한 뒤 파이프라인을 실행하고,
  `sendOpsMessageToUser`/`admin_send_ops_message` 패턴으로 야잘알봇 계정 답변을
  동일 대화에 insert한다.
- 답변 insert는 기존 `dm_messages` push trigger와 Realtime/안읽음 집계를 그대로 탄다.
- 고정방은 차단 필터에서 제외하고 신고·차단(나가기/삭제에 해당하는 UI)을 숨긴다.
  `BASEBALL_GENIUS_PINNED_ROOM_LEAVABLE=false`가 권장 기본값이다.

## 3. LLM 전 4갈래 deterministic router

1. `service_redirect`: 크보팬/앱/로그인/버그/건의/계정 등 → 마이페이지의 피드백 보내기 안내.
2. `history_hold`: 선수·구단 히스토리/기록/스탯 → 선수 페이지·기록 탭 안내.
3. `blocked`: 비야구 또는 프롬프트 인젝션 → 표준 거절.
4. `baseball_rule_term`: 이 경로만 사전 → 캐시 → LLM에 진입.

불명확한 입력은 `blocked`로 fail-closed한다. LLM 프롬프트도 룰/용어만 허용하며
기록 질문 답변 허용 문구는 없다.

## 4. LLM 후 검증과 캐시 계약

- Gemini는 `status=ANSWER|NOT_BASEBALL|UNSURE` JSON만 출력한다.
- 서버가 JSON 스키마, 센티널, 빈 문자열, 200자 상한, URL/마크다운/링크 금지를 검증한다.
- 검증에 실패하면 `UNSURE`로 보류한다.
- 검증을 통과한 `baseball_rule_term + ANSWER`만 `genius_qa_cache`에 저장한다.
- 서비스/히스토리/거절/보류/검증 실패는 캐시에 절대 저장하지 않는다.
- **서버측 durable handoff (3차 P0)**: 질문 DM INSERT와 같은 DB 트랜잭션에서
  `dm_messages` trigger가 `genius_question_jobs(status='queued')`를 생성한다.
  커밋 직후 앱 종료/응답 단절이어도 job은 유실되지 않으며,
  `/api/cron/baseball-qa-drain`(매분)이 due job을 끝까지 처리한다.
- 사용자 메시지 id를 quota/LLM 전에 atomic claim한다. quota 예약은 messageId 단위
  idempotent RPC(`reserve_baseball_genius_daily_question_for_message`)로 job 행에 고정한다.
- **LLM ≤1/messageId (4차 P1 + 5차 P1)**: `callLlm` 직전에 LLM 시작권을 atomic
  CAS(단일 `UPDATE ... WHERE llm_started=false RETURNING`)로 획득해 정확히 한 worker만
  winner가 되고(`llm_started_at` 기록), 응답 원본을 호출 직후 job 행에 저장한다.
  stale lease 재 claim으로 두 worker가 LLM 경계에 동시 진입해도 CAS loser는 답변 발송 없이
  물러난다(pending — job은 winner 소유). 재처리는 저장된 결과를 재사용하며,
  `llm_started=true`인데 결과가 없으면 fence(30s)로 구분한다: fence 안이면 winner가 아직
  실행 중일 수 있으므로 물러나고, fence 경과 후에만(응답 수신 후 DB 저장 실패/crash 창)
  공급자 소비가 ambiguous하므로 자동 재호출 없이 fail-closed 안내(`LLM_AMBIGUOUS_ANSWER`)로
  종결한다. crash 재처리는 어떤 경우에도 quota·LLM을 재소비하지 않는다.
- 처리 결과를 durable job에 `ready`로 저장한 뒤 답변 insert를 수행하고, 재시도는
  저장된 답변만 사용한다.
- **발송 재시도 분리 (4차 P1)**: 답변 DM 발송 실패는 처리 실패(`attempts`)와 분리된
  `delivery_attempts`로 집계한다(`record_baseball_genius_delivery_failure` RPC: +1, 60초
  backoff lease, status는 `ready` 유지). drainer의 due 선별은
  `due_baseball_genius_question_jobs` RPC가 담당하며 queued/processing/failed는
  `attempts<5`, `ready`는 `delivery_attempts<5`로 각각 bounded한다 — 5번째 처리에서 답변
  생성 성공 + 발송 일시 실패여도 job이 영구 제외되지 않는다. delivery 상한 소진 시
  `delivery exhausted` 운영 로그로 관측/알림한다.
- 브라우저는 DM 저장 직후 동일 `messageId`를 local outbox에 먼저 기록한다(즉시 응답 UX용
  best-effort 경로). 최초 500/abort, 앱 재진입, 온라인 복귀 시 같은 id만 재시도하며 실패
  상태와 수동 재시도 UI를 제공한다. 최종 전달 보장은 서버 drainer가 담당한다.

## 5. 데이터 모델

- `baseball_terms`: term, aliases, answer, category, `source_kind`, `source_url`,
  `rule_version`, `reviewed_at`
- `genius_qa_cache`: 정규화 질문별 검증 통과 답변 (`question_norm` UNIQUE)
- `genius_question_logs`: 전 경로와 토큰 기록 (관측용 append-only — 한도/중복 판정에는
  사용하지 않는다)
- `genius_daily_usage`: `(user_id, kst_day)`별 atomic 사용량
- `genius_question_jobs`: messageId PK durable job. `status(queued|processing|ready|completed|failed)`,
  `attempts`(처리)·`delivery_attempts`(발송) 분리, `lease_until`,
  `quota_reserved/quota_allowed/quota_remaining`(messageId 단위 quota 고정),
  `llm_started`(호출 전 atomic CAS 획득)·`llm_started_at`(winner 생존 fence 판정)·
  `llm_text/llm_input_tokens/llm_output_tokens`(응답 원본),
  `answer/source/remaining`(ready 결과), `last_error`. 질문 DM INSERT trigger가 생성한다.

132개 seed는 `official_rule / official_record / editorial_definition`으로 근거 성격을
구분한다. 공식 항목만 KBO 경기규칙·기록 페이지의 **항목별 실제 대응 URL**과
`rule_version='2026'`을 저장한다. 본문이 이미지 1장인 경기운영 페이지 등 근거 불가
페이지는 사용하지 않고 해당 항목은 editorial로 정직 분리한다(3차 P1). 문화·전술·세이버 설명은 공식 규정인 것처럼 가장하지
않고 URL 없이 `editorial_definition / not_applicable`로 표시한다.
전수 검수 산출물은 `specs/baseball-qa-seed-audit-2026.md`다.

## 6. 일일 한도

서버 처리 경로는 `reserve_baseball_genius_daily_question_for_message(message_id, user_id,
limit)` RPC를 사용한다: job 행을 `FOR UPDATE`로 잠그고, 이미 예약된 메시지면 저장된
결과(`quota_allowed/quota_remaining`)를 그대로 반환하며 usage를 증가시키지 않는다
(messageId 단위 idempotent — crash 재처리의 quota 중복 소비 방지). 미예약 메시지는 KST
날짜 버킷에서 UPSERT+조건부 increment+RETURNING을 한 트랜잭션으로 수행하고 결과를 job
행에 고정한다. LLM 호출 전에 슬롯을 예약하고, 한도 초과 또는 DB 오류면 LLM에 진입하지
않는다. 레거시 `reserve_baseball_genius_daily_question(user_id, limit)`는 동일한 날짜 버킷
원자 예약의 기본형으로 migration에 함께 있으나 서버 처리 경로는 message 단위 RPC만 쓴다.

## 7. 표준 문구

- 비야구: 야구 룰/용어 질문만 답할 수 있다는 안내
- 서비스: 마이페이지 > 피드백 보내기 안내
- 기록: 앱의 선수 페이지 / 기록 탭 안내
- 불확실: 추측하지 않고 사전 보강 대기 안내

## 8. 결정 완료 (2026-07-30, 하린아빠 `삼순 의견 반영`)

- 고정방은 삭제·나가기 불가: `BASEBALL_GENIUS_PINNED_ROOM_LEAVABLE=false`
- 일일 질문 한도는 KST 기준 20회: `BASEBALL_GENIUS_DAILY_LIMIT=20`
- 슬라이스①+②를 한 PR로 묶되 삼순 GO·하린아빠 머지 승인 전 출시하지 않는다.
- 말투는 친근한 존댓말 + ⚾
- MVP 답변 범위는 룰/용어만. 선수·구단 히스토리/기록은 앱 내 기록 화면으로 유도한다.
- 나무위키 운영 RAG는 법무 검토 전 제외한다. 향후 자체 DB·공식 출처 RAG만 별도 슬라이스로 검토한다.

구현 상수:

- `BASEBALL_GENIUS_MAX_ANSWER_LENGTH=200` — 권장 기본값
- `BASEBALL_GENIUS_MIN_QUESTION_LENGTH=2`, `BASEBALL_GENIUS_MAX_QUESTION_LENGTH=200`
- `BASEBALL_GENIUS_USER_ID` — 배포 전 동일 UUID auth/profile 시스템 계정 프로비저닝
- 계정명 (2026-07-30 하린아빠 결정): 사용자 가시 계정명 `야구천재 → 야잘알봇`.
  `BASEBALL_GENIUS_NAME=야잘알봇`, 기존 profile은 동일 UUID 유지한 채 nickname만 rename.
  provisioning lookup은 nickname이 아니라 UUID/email 안정 키로 수행해 시스템 계정 1개와
  기존 대화 연속성을 보장한다.

## 9. 검증 DoD

- `tsc --noEmit`, 변경 파일 ESLint, full prebuild, query guard 신규 위반 0
- `qa:baseball-qa`: 4갈래 경로, 삼순 재현 6건, 캐시 오염 방지, 구조화 응답 검증
- used=19에서 25개 병렬 예약 시 통과 최대 1개
- 동일 messageId 25-way에서 claim 1·reserve 1·LLM ≤1·답변 1
- 조사 결합 선수명/KBO ID 4건(김도영의/류현진은/박해민이/52605의) history_hold·LLM 0·cache 0
- 질문 INSERT 커밋만으로 job 생성(trigger, 클라이언트 호출 0) → claim 가능
- crash-after-reserve 재처리에서 quota 1·LLM ≤1·답변 1
- callLlm 성공 → storeLlm 1차 실패 → 재-claim에서 LLM 재호출 0 (fail-closed 안내로 종결)
- 4회 처리 실패 → 5번째 ready → 발송 1회 실패 → 다음 drain 수거·답변 정확히 1회·delivery
  상한 소진 시 제외
- seed 항목별 근거 감사 + 대표 오매핑 결함 주입 RED
- DM 저장 성공 → 첫 처리 500 → local outbox 동일 messageId 재시도 → 완료
- migration 미적용 유지
