-- 수훈 인터뷰 알림 transient 기기 durable retry (2026-08-15 삼순 NO-GO hotfix).
--
-- 문제: 1차 발송에서 FCM이 transient(서버 불안정·쿼터)로 보고한 기기 토큰을 버리고
-- 행을 sent 종결 → 그 기기들은 알림 영구 유실.
-- 해결: transient 토큰을 행에 durable 저장하고 pending 복귀. 다음 run이 그 토큰에만
-- 재발송한다(accepted 기기 중복 없음). 상한 초과 시 gaveUp 관측 후 종결.
--
-- claim RPC는 setof postgame_interviews 반환이라 신규 컬럼이 자동 포함된다.
alter table postgame_interviews
  add column if not exists notify_retry_tokens jsonb;
alter table postgame_interviews
  add column if not exists notify_attempts integer not null default 0;
