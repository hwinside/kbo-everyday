-- 리더보드 제외 — 운영자/테스트 계정 일부 해제 (봇 + 운영팀 + QA테스터 잔류)
-- 요청: 2026-06-09 #marketing 하린아빠
--   "랭킹에서 제외했던 운영자계정 풀어줘. '움짤콜렉터'만 빼고." → "크보팬운영팀, QA테스터도 제외하자"
--
-- 배경:
--   - 기존 leaderboard_internal_user_ids() 는 운영자/테스트 7명 + 봇(움짤콜렉터) 8개 제외.
--   - 명예의 전당(누적·월별) 라이브 노출 시작에 맞춰 실유저성 계정은 랭킹 노출 결정.
--   - 잔류(제외 유지): 봇(움짤콜렉터) + 크보팬 운영팀(ops@) + QA테스터(qa@) — 순수 운영/봇/테스트.
--   - 해제(랭킹 노출): 하린아빠 / 정배현우 / 하린엄마 / 윤연률 / 김현우.
--
-- 영향:
--   - 이 함수를 참조하는 라이브 뷰( v_leaderboard_writing / v_leaderboard_writing_monthly /
--     v_leaderboard_invite )가 즉시 반영 → 해제된 5명이 누적/월별 랭킹에 노출.
--   - 프로즌 테이블 event_leaderboard_snapshot 은 이벤트 최종결과라 불변(이 변경과 무관).
--
-- TS SSOT 1:1: src/lib/events/leaderboard-exclusions.ts (동일 커밋에서 동기화)

CREATE OR REPLACE FUNCTION leaderboard_internal_user_ids()
RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    '75ee70e1-d5d1-4cbe-a2f7-a937e717437c'::uuid, -- 움짤콜렉터 (봇, is_bot)
    '7b58d68e-e212-40aa-a96d-5018cb82cc81'::uuid, -- 크보팬 운영팀 (ops@keubo.fan)
    'ee5c25d8-bcab-4bb1-aa11-f64041d5e322'::uuid  -- QA테스터 (qa@keubo.fan)
  ];
$$;
