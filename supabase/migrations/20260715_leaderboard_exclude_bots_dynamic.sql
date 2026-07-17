-- 리더보드 내부자 제외 — 봇 계정 동적 제외 (profiles.is_bot=true)
-- 요청: 2026-07-15 삼순 리뷰(PR #645). 짤콜렉터 등 신규 봇의 랜덤 UUID를 하드코딩 없이
--   자동 제외한다. 움짤콜렉터·짤콜렉터·향후 봇 전부 커버 → 사진글(짤콜렉터) 5점이
--   명예의전당(누적/월별 글쓰기 리더보드)에 들어가지 않는다.
--
-- 변경:
--   - leaderboard_internal_user_ids() 를 IMMUTABLE 상수배열 → STABLE 동적쿼리로 재정의.
--     · 봇(profiles.is_bot=true)은 동적 수집 (idx_profiles_is_bot 파셜 인덱스 사용).
--     · 순수 운영/테스트 계정(is_bot=false)은 하드코딩 유지 (TS SSOT와 1:1).
--   - 이 함수를 참조하는 라이브 뷰(v_leaderboard_writing / v_leaderboard_writing_monthly /
--     v_leaderboard_invite)가 함수 교체 즉시 반영 (뷰 재생성 불필요).
--   - 기존 움짤콜렉터(75ee70e1, is_bot=true)는 하드코딩 목록에서 빠지지만 동적 절로 계속
--     제외됨 → 무회귀.
--   - 프로즌 테이블 event_leaderboard_snapshot 은 이벤트 최종결과라 불변(이 변경과 무관).
--
-- TS SSOT: src/lib/events/leaderboard-exclusions.ts (동일 커밋에서 정적 부분 동기화).

CREATE OR REPLACE FUNCTION leaderboard_internal_user_ids()
RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT ARRAY(
    -- 봇 계정(움짤콜렉터·짤콜렉터·향후 봇)은 is_bot 플래그로 동적 제외
    SELECT id FROM profiles WHERE is_bot = TRUE
    UNION
    -- 순수 운영/테스트 계정 (is_bot=false) — 하드코딩 유지
    SELECT u FROM unnest(ARRAY[
      '7b58d68e-e212-40aa-a96d-5018cb82cc81'::uuid, -- 크보팬 운영팀 (ops@keubo.fan)
      'ee5c25d8-bcab-4bb1-aa11-f64041d5e322'::uuid  -- QA테스터 (qa@keubo.fan)
    ]) AS u
  );
$$;
