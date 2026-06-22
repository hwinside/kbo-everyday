-- 동영상 트랜스코딩 워커 상태 추적 테이블
--
-- 커뮤니티 영상(움짤콜렉터 photos 버킷 + 유저 업로드 videos 버킷)은 현재 원본 무압축으로
-- 서빙돼 로딩이 느리다. Mac mini 트랜스코딩 워커(scripts/transcode-videos.mjs)가
-- 720p H.264 + faststart 로 재인코딩 후 posts.video_urls 를 최적화본으로 스왑한다.
--
-- 이 테이블은 원본 URL 단위로 작업 상태를 추적해:
--   1) 멱등성 — 이미 처리(done/skipped)했거나 한도까지 실패(failed)한 URL은 재처리 안 함
--   2) 신규 발견 — posts.video_urls 에 있으나 이 테이블에 없는 URL = pending 으로 등록
--   3) 관측성 — 원본/최적화 용량, 실패 사유, 시도 횟수 기록
--
-- 워커는 service_role 로만 접근하므로 RLS는 활성화하되 정책은 추가하지 않는다(클라 접근 0).

CREATE TABLE IF NOT EXISTS video_transcode_jobs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id       BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  original_url  TEXT NOT NULL UNIQUE,
  optimized_url TEXT,
  -- pending: 발견됨, 미처리 / done: 최적화·스왑 완료 / skipped: 최적화본이 원본보다 커서 원본 유지
  -- failed: maxAttempts 까지 실패(트랜스코딩 불가/다운로드 실패 등)
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  original_bytes  BIGINT,
  optimized_bytes BIGINT,
  attempts      INT NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 처리 대기/재시도 후보를 최신 post 순으로 빠르게 뽑기 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_video_transcode_jobs_status
  ON video_transcode_jobs (status, post_id DESC);

ALTER TABLE video_transcode_jobs ENABLE ROW LEVEL SECURITY;
