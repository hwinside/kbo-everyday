-- API Fallback Events 테이블
-- 외부 API 장애 추적 및 모니터링용

CREATE TABLE IF NOT EXISTS api_fallback_events (
  id BIGSERIAL PRIMARY KEY,
  
  -- 이벤트 식별
  api_name TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('timeout', 'http-error', 'schema-error', 'network-error')),
  
  -- 에러 상세
  status_code INT,
  error_message TEXT,
  
  -- 메타데이터
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alert_sent BOOLEAN DEFAULT FALSE,
  
  -- 인덱스 최적화
  CONSTRAINT valid_status_code CHECK (status_code IS NULL OR (status_code >= 100 AND status_code < 600))
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_api_fallback_events_timestamp ON api_fallback_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_api_fallback_events_api_name ON api_fallback_events(api_name);
CREATE INDEX IF NOT EXISTS idx_api_fallback_events_composite ON api_fallback_events(api_name, timestamp DESC);

-- RLS (Row Level Security)
ALTER TABLE api_fallback_events ENABLE ROW LEVEL SECURITY;

-- 어드민만 읽기 가능
CREATE POLICY "Admin read access" ON api_fallback_events
  FOR SELECT
  USING (auth.jwt() ->> 'role' = 'admin' OR auth.jwt() ->> 'role' = 'service_role');

-- 서비스 롤만 쓰기 가능
CREATE POLICY "Service role write access" ON api_fallback_events
  FOR INSERT
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- 코멘트
COMMENT ON TABLE api_fallback_events IS 'API Fallback 이벤트 추적 (외부 API 장애 모니터링)';
COMMENT ON COLUMN api_fallback_events.api_name IS 'API 식별자 (예: naver-standings, kbo-games)';
COMMENT ON COLUMN api_fallback_events.reason IS 'Fallback 원인 (timeout, http-error, schema-error, network-error)';
COMMENT ON COLUMN api_fallback_events.alert_sent IS '텔레그램 알림 발송 여부';
