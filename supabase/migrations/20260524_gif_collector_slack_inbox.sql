-- 움짤콜렉터 PR3: 슬랙 inbox 소스 타입 추가.
--
-- 원래 PR1에서 source_type CHECK가 ('mlbpark')만 허용했는데, 운영자가 슬랙 채널
-- (#gif-collector-inbox, C0B5YJV02LC)에 링크 던지는 방식으로 인입 채널이 변경됨.
-- 'slack_inbox' 값을 허용하도록 CHECK 확장.
--
-- external_post_id는 슬랙 인입 시 Slack 메시지 ts(예: '1779621969.509479')를 사용.
-- 동일 메시지 재전송 dedupe + 슬랙 메시지 추적용.

ALTER TABLE gif_collector_queue
  DROP CONSTRAINT IF EXISTS gif_collector_queue_source_type_check;

ALTER TABLE gif_collector_queue
  ADD CONSTRAINT gif_collector_queue_source_type_check
  CHECK (source_type IN ('mlbpark', 'slack_inbox'));

COMMENT ON COLUMN gif_collector_queue.source_type IS
  '수집 채널: mlbpark(폴러, 현재 미사용) | slack_inbox(운영자 슬랙 채널 인입).';
COMMENT ON COLUMN gif_collector_queue.external_post_id IS
  '수집 채널별 unique id. mlbpark=글번호, slack_inbox=Slack 메시지 ts. source_type과 함께 UNIQUE.';
