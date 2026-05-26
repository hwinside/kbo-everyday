-- 움짤콜렉터 hotfix: gif_collector_queue.matched_kbo_id FK 제거.
--
-- 배경 (2026-05-26 deploy E2E 도중 발견):
-- prod players_roster 테이블이 *비어있는 deprecated 상태*. 실제 SSOT는
-- src/lib/constants/players-roster.json (build time bundle, 802명).
-- PR1에서 추가한 `matched_kbo_id TEXT REFERENCES players_roster(kbo_id)` FK가
-- *모든 INSERT를 깨뜨림*: 매칭은 local json으로 성공해 정상 kboId를 받아오지만
-- INSERT 시점에 빈 테이블에서 kboId를 못 찾아 foreign key constraint violation.
--
-- 결정: prod 테이블을 다시 SSOT처럼 채우는 건 안티패턴(roster crawler 부담 부활,
-- json과 동기화 burden) → FK 자체를 제거하고 application layer
-- (resolveInboxFromInput)의 검증에 의존. matched_kbo_id는 단순 TEXT로 유지.

ALTER TABLE gif_collector_queue
  DROP CONSTRAINT IF EXISTS gif_collector_queue_matched_kbo_id_fkey;

COMMENT ON COLUMN gif_collector_queue.matched_kbo_id IS
  'roster canonical kboId (한국 선수=숫자, 외국인=AQ002 등 영문). SSOT는 src/lib/constants/players-roster.json; FK는 prod 테이블 deprecated로 인해 제거됨 (2026-05-26).';
