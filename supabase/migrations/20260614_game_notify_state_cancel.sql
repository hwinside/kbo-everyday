-- 경기 취소 알림 dedup 플래그 (game-status.ts notifyGameStatusTransitions)
ALTER TABLE game_notify_state ADD COLUMN IF NOT EXISTS cancel_notified BOOLEAN NOT NULL DEFAULT false;
