-- ===== 초대 시스템 v2 Migration =====
-- 날짜: 2026-04-09
-- 스펙: specs/invite-system-v2.md

-- 1. invitations 테이블: activated_at 컬럼 추가
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS flagged BOOLEAN DEFAULT false;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS flagged_reason TEXT
  CHECK (flagged_reason IN ('ip_limit', 'fingerprint_match', 'manual', 'other'));
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;
COMMENT ON COLUMN invitations.activated_at IS '초대받은 유저가 활성화 조건(팀선택+첫글/댓글) 충족한 시점';
COMMENT ON COLUMN invitations.flagged IS '어뷰징 의심 플래그 - true이면 활성화 카운트에서 제외, 어드민 검토 대기';
COMMENT ON COLUMN invitations.flagged_reason IS '보류 사유: ip_limit, fingerprint_match 등';
COMMENT ON COLUMN invitations.flagged_at IS '보류 시점';

-- 2. profiles 기본 초대권: 3 → 5
ALTER TABLE profiles ALTER COLUMN invite_count SET DEFAULT 5;

-- 3. invite_refill_log 테이블 (리필 이력 추적)
CREATE TABLE IF NOT EXISTS invite_refill_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  refilled_count INT NOT NULL DEFAULT 3,
  refilled_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE invite_refill_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own refill" ON invite_refill_log FOR SELECT USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_refill_user ON invite_refill_log(user_id);

-- 4. invite_abuse_check 테이블 (어뷰징 방지)
CREATE TABLE IF NOT EXISTS invite_abuse_check (
  id BIGSERIAL PRIMARY KEY,
  invitee_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  fingerprint TEXT,
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE invite_abuse_check ENABLE ROW LEVEL SECURITY;
-- 클라이언트 직접 접근 차단 (service_role만 사용)
CREATE INDEX IF NOT EXISTS idx_abuse_fp ON invite_abuse_check(fingerprint);
CREATE INDEX IF NOT EXISTS idx_abuse_ip ON invite_abuse_check(ip_address);

-- 5. invitations에 활성화 기준 인덱스
CREATE INDEX IF NOT EXISTS idx_invitations_inviter ON invitations(inviter_id);
CREATE INDEX IF NOT EXISTS idx_invitations_activated ON invitations(inviter_id) WHERE activated_at IS NOT NULL;

-- 6. 기존 유저 중 이미 사용된 초대에 대해 activated_at 백필
-- (기존에 invitee_id가 있고 해당 유저가 team_id + 글/댓글 있으면 활성화로 간주)
UPDATE invitations inv
SET activated_at = inv.used_at
WHERE inv.invitee_id IS NOT NULL
  AND inv.activated_at IS NULL
  AND EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id = inv.invitee_id
      AND p.team_id IS NOT NULL
  )
  AND (
    EXISTS (SELECT 1 FROM posts WHERE author_id = inv.invitee_id)
    OR EXISTS (SELECT 1 FROM comments WHERE author_id = inv.invitee_id)
  );
