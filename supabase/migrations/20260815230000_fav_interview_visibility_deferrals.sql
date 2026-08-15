-- 수훈 인터뷰 알림: 노출 보류 카운터를 FCM 재시도 attempts와 분리 (2026-08-15 삼순 NO-GO P0-2).
--
-- 문제: 노출 확인 보류가 storeRetryTokens(rowId, [], attempts+1)로 기록돼
-- **FCM 재시도 예산(attempts)** 을 갉아먹었다. 5번 보류된 행은 그 다음 첫 FCM
-- transient 실패에서 곧바로 상한에 걸려 기기가 포기된다 — 서로 다른 두 실패 축이
-- 하나의 카운터를 공유하면 안 된다.
--
-- 해결: 노출 보류 전용 컬럼을 둔다. attempts는 FCM 시도만 센다.
alter table postgame_interview_retry_tokens
  add column if not exists visibility_deferrals integer not null default 0;
