-- 재설치(토큰 교체) 자동 재발급 (#667 삼순 NO-GO 반영)
-- updated_at은 register-start heartbeat(같은 토큰도 매 등록 갱신, #664 catch-up 용도)라
-- 토큰 세대 판정에 쓸 수 없음. token_changed_at = *토큰 값이 실제로 바뀐 시각*만 기록.
-- backfill은 null = 보수적(기존 동작 유지: claim/구독 있으면 재발급 안 함). 이후
-- 실제 토큰 교체(재설치/신규 등록)부터 세대 시각이 쌓인다.
alter table live_activity_start_tokens
  add column if not exists token_changed_at timestamptz;
