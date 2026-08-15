-- 수훈 인터뷰 알림 transient 기기 durable retry (2026-08-15 삼순 NO-GO hotfix).
--
-- 문제: 1차 발송에서 FCM이 transient(서버 불안정·쿼터)로 보고한 기기 토큰을 버리고
-- 행을 sent 종결 → 그 기기들은 알림 영구 유실.
-- 해결: transient 토큰을 durable 저장하고 행을 pending 복귀. 다음 run이 그 토큰에만
-- 재발송한다(accepted 기기 중복 없음). 상한 초과 시 gaveUp 관측 후 종결.
--
-- ⚠️ 저장 위치는 postgame_interviews 컬럼이 아니라 별도 원장이다(삼순 P0):
-- postgame_interviews는 anon/authenticated 공개 SELECT 정책이 있어 raw FCM 토큰을
-- 그 테이블에 두면 외부로 노출된다. 원장은 RLS enable + 정책 0 + 권한 revoke로
-- service_role만 접근한다.
create table if not exists postgame_interview_retry_tokens (
  row_id uuid primary key references postgame_interviews(id) on delete cascade,
  tokens jsonb not null,
  attempts integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table postgame_interview_retry_tokens enable row level security;
revoke all on table postgame_interview_retry_tokens from public, anon, authenticated;
