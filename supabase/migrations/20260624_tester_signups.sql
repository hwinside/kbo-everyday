-- tester_signups: 안드로이드 비공개 테스트 신청자 (플레이스토어 이메일 수집)
-- 유저 입력 = play_store_email 하나. 나머지(가입 계정/user_id/기기 UA/시각)는 자동 수집.
-- 1인 1신청(user_id UNIQUE) — 이메일 변경 시 upsert로 갱신.

CREATE TABLE IF NOT EXISTS tester_signups (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  account_email TEXT,                 -- 로그인 계정 이메일 (자동)
  play_store_email TEXT NOT NULL,     -- 플레이스토어 Gmail (유저 입력)
  device_info TEXT,                   -- User-Agent (기기모델 포함, 자동)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tester_signups_created
  ON tester_signups(created_at DESC);

ALTER TABLE tester_signups ENABLE ROW LEVEL SECURITY;

-- service_role(서버 API route)만 접근. 신청/조회 모두 Bearer 검증 후 supabaseAdmin으로 처리.
CREATE POLICY "Service role full access on tester_signups"
  ON tester_signups FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
