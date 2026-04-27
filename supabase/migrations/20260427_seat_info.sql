-- 좌석팁 구조화 데이터: 구역/블록/열/좌석 정보
ALTER TABLE posts ADD COLUMN IF NOT EXISTS seat_info JSONB DEFAULT NULL;

-- 좌석팁 게시글만 인덱싱 (board_id가 stadium:*:seats인 경우)
CREATE INDEX IF NOT EXISTS idx_posts_seat_info
  ON posts USING gin (seat_info)
  WHERE seat_info IS NOT NULL;

COMMENT ON COLUMN posts.seat_info IS '좌석팁 구조화 데이터: { zone, block?, row?, seat? }';
