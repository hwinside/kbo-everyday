-- 움짤콜렉터 봇: 엠팍 KBO GIF 자동 수집 큐
-- 스펙: notion://[기획] 움짤콜렉터 (369c901b-b372-810a-9470-f1b84119e206)
--
-- 설계 요지:
--   - 신규 posts 테이블은 만들지 않음 (기존 posts 재사용)
--   - 큐 1개 테이블: 폴러가 raw insert → 매칭 → confidence 기반 발행/보류
--   - 발행 시 posts 행 만들고 posted_post_id로 FK 연결
--   - is_bot 컬럼으로 봇 배지 렌더링 + 통계에서 봇 제외

-- 1. profiles.is_bot — 봇 계정 식별자
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_profiles_is_bot
  ON profiles (is_bot)
  WHERE is_bot = TRUE;

COMMENT ON COLUMN profiles.is_bot IS
  '시스템 봇 계정 여부 (움짤콜렉터 등). UI에 봇 배지 표시 + 활동 통계에서 제외용.';

-- 2. gif_collector_queue
CREATE TABLE IF NOT EXISTS gif_collector_queue (
  id BIGSERIAL PRIMARY KEY,

  -- 원본 출처
  source_type TEXT NOT NULL
    CHECK (source_type IN ('mlbpark')),
  external_post_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_author TEXT,
  source_title TEXT NOT NULL,
  source_content TEXT,
  source_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  original_media_urls JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 매칭 결과
  matched_kbo_id TEXT REFERENCES players_roster(kbo_id) ON DELETE SET NULL,
  matched_board_type TEXT
    CHECK (matched_board_type IS NULL OR matched_board_type IN ('player', 'team')),
  matched_board_id TEXT,
  match_confidence REAL NOT NULL DEFAULT 0
    CHECK (match_confidence >= 0 AND match_confidence <= 1),

  -- 큐 상태
  match_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (match_status IN ('pending', 'auto_posted', 'rejected', 'taken_down')),
  posted_post_id BIGINT REFERENCES posts(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ,

  UNIQUE (source_type, external_post_id)
);

-- 큐 화면 조회 (운영자 review queue): 상태 + 최신순
CREATE INDEX IF NOT EXISTS idx_gif_collector_queue_status_created
  ON gif_collector_queue (match_status, created_at DESC);

-- 매칭된 항목 추적 (audit)
CREATE INDEX IF NOT EXISTS idx_gif_collector_queue_matched
  ON gif_collector_queue (matched_board_type, matched_board_id, created_at DESC)
  WHERE matched_kbo_id IS NOT NULL;

-- 발행된 post → queue 역추적 (takedown 시 큐 상태 업데이트)
CREATE INDEX IF NOT EXISTS idx_gif_collector_queue_posted_post
  ON gif_collector_queue (posted_post_id)
  WHERE posted_post_id IS NOT NULL;

-- RLS: service_role만 쓰기. 운영자(admin) SELECT 정책은 PR5 review queue 작업 시 추가.
ALTER TABLE gif_collector_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gif_collector_queue_service_all" ON gif_collector_queue;
CREATE POLICY "gif_collector_queue_service_all"
  ON gif_collector_queue
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE gif_collector_queue IS
  '움짤콜렉터 봇 수집 큐 — 엠팍 raw insert → 매칭 → confidence 기반 발행/보류. SSOT: notion://[기획] 움짤콜렉터.';
COMMENT ON COLUMN gif_collector_queue.external_post_id IS
  '출처별 글번호 (엠팍은 b.php?b=kbotown&id=<num>의 num). source_type과 함께 UNIQUE — dedupe key.';
COMMENT ON COLUMN gif_collector_queue.match_confidence IS
  '0.0~1.0. ≥0.8은 auto_posted, 미만은 review queue 보류.';
COMMENT ON COLUMN gif_collector_queue.original_media_urls IS
  '엠팍 원본 미디어 URL 배열 (감사용). 자체 호스팅 후 posts.video_urls/image_urls에는 우리 CDN URL이 들어감.';
COMMENT ON COLUMN gif_collector_queue.posted_post_id IS
  '발행 시 posts.id. NULL=미발행 (pending/rejected/taken_down).';
