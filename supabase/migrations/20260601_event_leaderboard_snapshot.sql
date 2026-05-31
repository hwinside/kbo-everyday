-- 얼리멤버 이벤트 종료 — 최종 순위 스냅샷 동결 + 봇 제외
-- 2026-06-01 이벤트 종료 (컷오프 2026-05-31 24:00 KST)
--
-- 배경:
--   - 리더보드 두 트랙(초대/글쓰기)은 기간 필터 없는 누적 집계라 종료 후에도 라이브로 변동됨
--   - 종료 시점 순위를 불변 테이블에 박제해 글삭제·좋아요 변동 등으로 발표 순위가 흔들리지 않게 함
--   - 마이페이지 "내 최종 순위+상품" UI 가 이 테이블을 읽음 (라이브 뷰가 아니라)
--
-- ⚠️ 데이터 동결(INSERT)은 2026-06-01 01:35 KST Management API 로 1회 수행한 운영 작업.
--    이 마이그레이션은 스키마(테이블)와 제외 SSOT(함수)만 관리한다. 데이터는 재실행하지 않는다.

-- ============================================================
-- 1. 스냅샷 테이블 (불변 동결 레코드)
-- ============================================================

CREATE TABLE IF NOT EXISTS event_leaderboard_snapshot (
  id            bigserial PRIMARY KEY,
  track         text NOT NULL,                 -- 'invite' | 'writing'
  rank          int NOT NULL,
  user_id       uuid NOT NULL,
  nickname      text,
  team_id       int,
  score         int NOT NULL,                  -- invite_count 또는 total_points
  last_activity timestamptz,
  is_bot        boolean NOT NULL DEFAULT false,
  cutoff_at     timestamptz NOT NULL,          -- 집계 컷오프 (2026-06-01 00:00:00+09)
  frozen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (track, rank)
);

CREATE INDEX IF NOT EXISTS idx_event_snapshot_user
  ON event_leaderboard_snapshot (user_id);

-- RLS: 정책 미부여 → service_role(API 라우트) 만 접근. 클라이언트 직접 조회 차단.
ALTER TABLE event_leaderboard_snapshot ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. 리더보드 제외 SSOT — 움짤콜렉터(봇) 추가
--    TS SSOT: src/lib/events/leaderboard-exclusions.ts (1:1 동기화)
-- ============================================================

CREATE OR REPLACE FUNCTION leaderboard_internal_user_ids()
RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    '04f1fcff-6173-4dda-920a-e5f8ff66a696'::uuid, -- seq 1 · 하린아빠
    '3e38a6c9-c43a-418f-8809-75db09ac247c'::uuid, -- seq 4 · 정배현우
    '7b58d68e-e212-40aa-a96d-5018cb82cc81'::uuid, -- seq 5 · 크보팬 운영팀
    '256c43ce-9a44-4c3e-9eb6-6bf64378bb4a'::uuid, -- seq 6 · 하린엄마
    'ee5c25d8-bcab-4bb1-aa11-f64041d5e322'::uuid, -- seq 7 · QA테스터
    '9cba194d-686d-4d17-b5ac-185b34bc2dc6'::uuid, -- seq 8 · 윤연률
    'a8b26be1-ea79-45d1-a6a4-9c5a13c91768'::uuid, -- seq 62 · 김현우
    '75ee70e1-d5d1-4cbe-a2f7-a937e717437c'::uuid  -- 움짤콜렉터 (봇, is_bot) · 2026-06-01 하린아빠 제외 확정
  ];
$$;
