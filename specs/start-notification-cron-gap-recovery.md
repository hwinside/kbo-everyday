# 경기 시작알림 cron 공백 복구 — PR #889

- 상태: v3 IMPLEMENTED, 삼순 코드리뷰 대기
- 작성: 삼식이 (2026-07-26), v3 갱신 2026-07-27
- 트리거: 2026-07-26 18:00 KST 5경기 시작알림 전원 미발송
- 관련: PR #882 디바이스 전달 원장(Production `641d5b97e`)

## 1. 문제

Vercel `game-events-warmup` 분당 cron이 17:59:15→18:02:46 약 3.5분 비었다.
재개 시 5경기는 이미 live였고 기존 신선도 게이트가 시작알림을 전부 mark-only로 닫았다.
같은 Vercel scheduler에 self-heal을 추가해도 scheduler 자체 공백은 복구할 수 없다.

## 2. 이미 배포된 기반

PR #882가 다음 correctness 기반을 먼저 배포했다.

- event×token 전달 원장과 `pending/sending/accepted/permanent_failed/transient`
- snapshot-first, 게임별 round-robin drain, 90초 deadline
- 첫 타석 근거 null/모순 fail-close
- 시작 accepted barrier 뒤 초반 활약 release
- FCM TTL/APNs expiration과 `maxDuration=300`

따라서 #889는 별도 game-state SSOT를 만들지 않고 #882의 동일
`notifyGameStatusTransitions()`→delivery ledger 경로만 외부 scheduler에서 호출한다.

## 3. 설계

### 3.1 scheduler 독립성

- Supabase `pg_cron`이 15초마다 `private.invoke_game_start_watchdog()` 실행
- 활성 시간은 기본 KST 12:00~01:00, 자정 횡단 지원
- production URL과 `CRON_SECRET`은 `private.game_start_watchdog_config`에 운영 선주입
- config 기본 `enabled=false`; secret 값은 migration/repo에 남기지 않음
- `pg_net`이 `/api/cron/game-start-watchdog`를 호출하므로 Vercel cron 등록/재바인딩과 독립

### 3.2 얇은 watchdog route

- 요청 전체 deadline 14초, KBO 목록 fetch 4초, 첫 타석 근거 fetch 경기별 최대 3초
- scheduled/live·비취소 경기만 기존 상태 전이 함수에 전달
- watchdog의 bounded bulk state(`last_seen_scheduled_at`, snapshot deadline 포함)를 실제
  start 경로가 재사용해 게임별 5초 순차 read를 제거
- `start_notified=true` 또는 이미 snapshot이 열린 경기는 game-events 근거를 재조회하지 않음
- 신규 live 후보만 authoritative 첫 타석 근거를 읽고, null/timeout이면 기존 정책대로 fail-close
- 신규 snapshot open은 경기별 병렬·remaining-budget abort, claim/dispatch/settle/finalize도
  같은 route 절대 deadline을 사용하며 deadline 뒤 새 DB/FCM 작업을 시작하지 않음
- 발송은 #882의 snapshot/claim/settle/finalize를 그대로 사용해 중첩 watchdog과 Vercel cron 간 중복 차단

## 4. 실패 계약

- KBO 목록/DB 상태 조회 실패: HTTP 503, 상태 마킹·발송 없음
- game-events 근거 실패: 해당 경기만 근거 map에서 제외, snapshot을 열지 않고 다음 15초 tick 재시도
- FCM transient/worker 절단: delivery ledger lease/deadline 규칙으로 다음 tick drain
- config 누락/disabled/활성시간 밖: DB 함수 no-op

## 5. 배포 게이트

1. migration 선적용
2. `private.game_start_watchdog_config`에 production URL·동일 `CRON_SECRET` secret 주입 후 enabled
3. `cron.job`의 `game-start-watchdog-15s` 확인
4. `net._http_response`에서 2xx 및 route 로그 확인
5. 다음 실경기에서 token accepted/transient/settle, 중복 0, 실기기 도달 확인

migration·merge·Production은 삼순 GO와 하린아빠 명시 승인을 받은 뒤에만 진행한다.
