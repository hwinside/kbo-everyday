-- 커뮤니티 태그 기반 전환 (V3)
-- 게시물의 board_type/board_id "소속" 개념을 태그로 대체한다.
-- - team_tags: 팀 슬러그 배열 (복수 가능). 예: ["lg"], ["lg","ot"]
-- - player_tags: 기존 선수 태그 배열 (포맷 "69100:구본혁"). 그대로 사용.
-- - 팀태그 0 + 선수태그 0 = 자유글.
-- board_id/board_type 컬럼은 물리 삭제하지 않는다(롤백 안전 + 기존 딥링크/RLS 유지).
-- 조회/UI만 태그 기준으로 전환한다.

-- 1) 팀태그 컬럼 추가 (비파괴적, 기본 빈 배열)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS team_tags JSONB DEFAULT '[]'::jsonb;

-- 2) 태그 contains 조회용 GIN 인덱스
CREATE INDEX IF NOT EXISTS idx_posts_team_tags
  ON posts USING gin (team_tags);
CREATE INDEX IF NOT EXISTS idx_posts_player_tags
  ON posts USING gin (player_tags);

-- 3) 백필 — 팀보드 글: team_tags = [board_id]
--    (board_id가 팀 슬러그인 team 보드 글만. 빈 배열인 행만 갱신해 멱등성 보장)
UPDATE posts
   SET team_tags = jsonb_build_array(board_id)
 WHERE board_type = 'team'
   AND board_id IS NOT NULL
   AND board_id <> ''
   AND (team_tags IS NULL OR team_tags = '[]'::jsonb);

-- 자유글(board_type='free')과 선수보드 글의 팀태그 백필은 별도 단계에서 처리한다:
-- - free: team_tags 빈 배열 유지(= 무태그 자유글)
-- - player: 선수→팀 매핑이 DB에 없고 players-roster.json에 있으므로
--   scripts/migrations/backfill-player-team-tags.mjs 로 별도 백필(선수보드 글의 player_tags는 이미 존재)

COMMENT ON COLUMN posts.team_tags IS '팀 태그 슬러그 배열(복수 가능). 팀태그 0 + 선수태그 0 = 자유글. board_id는 레거시 호환용으로 잔존.';
