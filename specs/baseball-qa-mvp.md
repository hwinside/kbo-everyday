# 야구천재 — 야구 룰/용어 질문 AI MVP v1.2

- 상태: 삼순 NO-GO 반영
- Notion SSOT: https://www.notion.so/3acc901bb3728165b783d0f0960c9f02
- 범위: 신규 화면 0개, `/messages` 고정 DM과 기존 DM 인프라 재사용
- migration은 머지 게이트 뒤 적용한다. PR 단계에서는 적용하지 않는다.

## 1. 목표 / 비목표

야구 입문 유저가 룰·용어를 짧고 정확하게 묻고, 검수 사전 → 캐시 → 미매칭
LLM 순으로 비용을 0에 수렴시킨다. 선수·구단 기록/히스토리, 서비스 문의,
판정 논쟁, 실시간 경기, 자유 잡담은 MVP 답변 범위가 아니다.

## 2. 고정 DM UX

- `/learn/ask`와 `/learn` 진입 카드를 제거한다.
- `/messages` 최상단에 `야구천재` 방을 대화 유무와 무관하게 항상 고정한다.
- 최초 질문은 `new-${BASEBALL_GENIUS_USER_ID}` 가상 row에서 기존
  `send_dm_message_atomic` RPC로 대화와 유저 메시지를 원자 생성한다.
- 서버는 해당 사용자·대화·메시지 소유권을 재검증한 뒤 파이프라인을 실행하고,
  `sendOpsMessageToUser`/`admin_send_ops_message` 패턴으로 야구천재 계정 답변을
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
- 사용자 메시지 id 기반 `dedup_key=baseball-genius:${messageId}`로 답변 재처리를 멱등화한다.

## 5. 데이터 모델

- `baseball_terms`: term, aliases, answer, category, `source_url`, `rule_version`
- `genius_qa_cache`: 정규화 질문별 검증 통과 답변
- `genius_question_logs`: 전 경로와 토큰 기록
- `genius_daily_usage`: `(user_id, kst_day)`별 atomic 사용량

132개 seed는 2026 KBO 공식 규정 기준으로 재검수한다. 최근 변경 규정의 기준 URL은
https://www.koreabaseball.com/Kbo/League/GameManage2026.aspx 이며 모든 seed row에
`source_url`과 `rule_version='2026'`을 저장한다. 특히 수비 시프트 제재 강화,
29명 등록/28명 출장, 기존 외국인 외 아시아쿼터 1명 추가를 반영한다.

## 6. 일일 한도

`reserve_baseball_genius_daily_question(user_id, limit)` RPC가 KST 날짜 버킷에서
UPSERT+조건부 increment+RETURNING을 한 트랜잭션으로 수행한다. LLM 호출 전에 슬롯을
예약하고, 한도 초과 또는 DB 오류면 LLM에 진입하지 않는다.

## 7. 표준 문구

- 비야구: 야구 룰/용어 질문만 답할 수 있다는 안내
- 서비스: 마이페이지 > 피드백 보내기 안내
- 기록: 앱의 선수 페이지 / 기록 탭 안내
- 불확실: 추측하지 않고 사전 보강 대기 안내

## 8. 하린아빠 확정 대기 — 권장 기본값

하드코딩된 익명 숫자/불리언 대신 아래 네이밍된 config 상수를 사용한다.

- `BASEBALL_GENIUS_DAILY_LIMIT=20` — 권장 기본값
- `BASEBALL_GENIUS_PINNED_ROOM_LEAVABLE=false` — 권장 기본값
- `BASEBALL_GENIUS_MAX_ANSWER_LENGTH=200` — 권장 기본값
- `BASEBALL_GENIUS_MIN_QUESTION_LENGTH=2`, `BASEBALL_GENIUS_MAX_QUESTION_LENGTH=200`
- `BASEBALL_GENIUS_USER_ID` — 배포 전 동일 UUID auth/profile 시스템 계정 프로비저닝
- 말투: 친근한 존댓말 + ⚾ — 권장 기본값

## 9. 검증 DoD

- `tsc --noEmit`, 변경 파일 ESLint, full prebuild, query guard 신규 위반 0
- `qa:baseball-qa`: 4갈래 경로, 삼순 재현 3건, 캐시 오염 방지, 구조화 응답 검증
- used=19에서 25개 병렬 예약 시 통과 최대 1개
- migration 미적용 유지
