-- W3c: 잠금화면 Live Activity on/off 토글
-- notification_prefs에 live_activity 컬럼 추가(디폴트 on → 기존 row/유저 전부 on 유지, 백필 불필요).
-- 토글 off 시 클라가 LA push token 미등록 + 서버 푸시에서 제외(coalesce(컬럼, true)).
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS live_activity BOOLEAN NOT NULL DEFAULT true;
