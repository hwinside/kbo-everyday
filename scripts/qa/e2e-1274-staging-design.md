# #1274 p95 재실측 — 격리 staging fixture 라우팅 설계 (승인 전 실행 금지)

상태: `[blocked]` — 격리 Supabase staging 프로젝트 신설 승인 전까지 어떤 실측도 실행하지 않는다.
Production/shared Supabase write 는 영구 0. 우회 플래그 없음 (`scripts/qa/send-guard.mjs` 가 강제).

## 왜 재설계가 필요한가

- 사고(2026-08-21): 하니스가 `game:<gameId>` 실경기방으로 발송 → 라이브 방 노출. 이후 send-guard 가
  `qa-fixture:*` room + staging ref allowlist 만 허용하도록 고정됐다.
- 기존 하니스는 `ROOM_ID = game:${GAME_ID}` 파생이라 guard 와 원리적으로 양립 불가였다
  (staging 이 생겨도 실행 불가). 본 설계가 그 간극을 닫는다. 하니스는 이제
  `QA_FIXTURE_ROOM` env(패턴 `qa-fixture:<slug>`)만 받는다.

## 라우팅 설계

1. **격리 staging Supabase 프로젝트** (신설, 승인 필요)
   - Production 과 조직/프로젝트 분리. 실유저 0, anon key 유출해도 실서비스 영향 0.
   - `chat_messages`·`profiles` 등 채팅 경로 스키마만 migration 으로 복제(시드는 fixture 전용).
   - staging project ref 를 `send-guard.mjs` 의 `STAGING_PROJECT_REFS` 에 등재하는 커밋 자체를
     삼순 리뷰 대상으로 한다(allowlist 등재 = 리뷰 게이트).
2. **fixture room 라우팅 (앱 코드 변경 없이)**
   - `chat_messages.room_id` 는 자유 문자열 — 앱 페이지를 띄우지 않고도 realtime 구독은
     `room_id=qa-fixture:<slug>` 채널로 동일하게 동작한다.
   - p95 측정은 "insert → 상대 클라이언트 수신"이 관심사이므로, 측정 클라이언트는
     게임 페이지 대신 **하니스 내장 구독 클라이언트**(supabase-js `postgres_changes` 또는
     동일 채널 broadcast)로 fixture room 을 구독한다. UI 렌더 경로가 필요한 축(A1 멀티플렉스
     프레임 하 chat 지연)은 staging 배포(Preview env → staging Supabase env 주입)에서
     게임 페이지가 fixture room 을 읽도록 `NEXT_PUBLIC_*` env 로 분기한다 — 이 분기는
     staging 배포에만 존재하며 Production 빌드에는 코드가 들어가지 않는다(env 부재 시 기존 경로).
3. **부하 재현 (라이브 방 대체)**
   - 라이브 경기 부하는 사용 금지. 대신 staging 에 합성 부하 발생기(메시지 N/s, 구독자 M)를
     두고 8/21 실측 원장(9개)의 send rate·동시 구독 규모를 재현 파라미터로 쓴다.
   - baseline(PROD 코드경로) vs A1(멀티플렉스) 을 **같은 staging** 에서 순차-교대(A/B/A/B)로
     동표본 측정 — 단일 머신 CPU 경합 회피를 위해 컨텍스트 2개 상한.
4. **측정 계약 (원계약 그대로)**
   - event-driven 수신시각, 양쪽 동일 성공 표본수(40+), send/retry 실패 0, 누락/중복 0,
     draft 보존, **A1 p95 ≤ baseline p95**. 완화대 없음.

## 실행 전 체크리스트 (전부 충족 전 실행 금지)

- [ ] staging 프로젝트 신설 승인 (하린아빠)
- [ ] `STAGING_PROJECT_REFS` 등재 커밋 삼순 GO
- [ ] `send-guard-gate` GREEN (등재 후에도 production 차단·fixture 강제 불변 확인)
- [ ] 측정 계획(표본수·부하 파라미터) 삼순 승인
