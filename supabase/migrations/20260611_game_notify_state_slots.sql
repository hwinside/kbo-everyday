-- 푸시 알림 v1 — S4: 경기 종료 알림 팀 슬롯 상태 (삼순 #210 재리뷰)
-- 종료 알림은 최애팀 기준 승팀/패팀 다른 메시지라 away/home 슬롯별로 독립 발송.
-- 한 슬롯 성공·다른 슬롯 실패 시 그 슬롯만 재시도(성공 슬롯 중복 차단)하기 위해
-- 슬롯 단위 상태를 둔다. end_notified는 "두 슬롯 모두 완료" 요약(조기 skip용).
--
-- ⚠️ 20260611_game_notify_state.sql(테이블 생성)이 prod 선적용된 상태라, 컬럼 추가는
-- 그 파일에 넣지 않고 이 신규 timestamp migration으로 분리 — 멱등(IF NOT EXISTS)이라
-- 재실행 안전하고, migration history 미기록 환경에서도 새 파일이라 반드시 1회 적용됨.

ALTER TABLE game_notify_state ADD COLUMN IF NOT EXISTS end_away_notified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE game_notify_state ADD COLUMN IF NOT EXISTS end_home_notified BOOLEAN NOT NULL DEFAULT false;

-- 기존 end_notified=true 행은 양 슬롯 발송 완료로 간주 (재발송 방지)
UPDATE game_notify_state SET end_away_notified = true, end_home_notified = true WHERE end_notified = true;
