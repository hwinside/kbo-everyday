-- 직관 다이어리 미디어 보관(archive) — S1 백엔드 보관 전환
--
-- 배경: venue-stories-cleanup cron 이 '경기 종료+24h'(expires_at) 지난 스토리의
-- storage 원본 + DB 행을 실제 삭제해, 유저가 올린 사진/영상/댓글이 하루 뒤 완전히 사라진다.
-- 요구(하린아빠): 공개는 하루 뒤 종료하되, 본인 미디어+댓글은 삭제하지 않고 보관 →
-- 나중에 /my 직관 다이어리에서 열람.
--
-- 이 migration 은:
--  1) status 에 'archived' 추가(공개 종료→보관 전환 상태).
--  2) archived_at(보관 전환 시각) / removed_at(removed 격리 시작 시각) 컬럼 추가.
--  3) 다이어리 조회 인덱스(본인 active+archived, 경기 최신순).
--  4) report RPC 가 신고 임계로 status='removed' 전이할 때 removed_at=now() 를 함께 기록.
--
-- 전부 멱등(IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE). production 선적용 금지(리뷰 후).

-- ── 1) status CHECK 재정의: 'archived' 추가 ───────────────────────────
-- 기존 제약을 drop 후 재생성(멱등). 20260718 의 인라인 CHECK 제약명은
-- 'venue_stories_status_check'(Postgres 기본 명명 규칙: <table>_<column>_check).
ALTER TABLE venue_stories DROP CONSTRAINT IF EXISTS venue_stories_status_check;
ALTER TABLE venue_stories
  ADD CONSTRAINT venue_stories_status_check
  CHECK (status IN ('pending', 'active', 'removed', 'cleanup_failed', 'archived'));

-- ── 2) 보관/격리 타임스탬프 ───────────────────────────────────────────
-- archived_at: expired_after_end 정상 만료 → 보관 전환 시각(공개 종료 시점).
-- removed_at : removed(신고 임계/어드민) 격리 시작 시각. 30일 경과 후 삭제(오신고 복구 여지).
--   null = 격리 대상 아님(레거시/검증실패 removed 는 즉시 정리 유지 — cleanup 이 null→delete).
ALTER TABLE venue_stories
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removed_at  TIMESTAMPTZ;

-- ── 3) 다이어리 조회 인덱스 ───────────────────────────────────────────
-- 본인(user_id)의 active+archived 미디어를 경기 최신순으로 조회(S2 다이어리 API 용).
-- game_id 는 'YYYYMMDD...' 로 날짜가 prefix 라 DESC = 경기 최신순(별도 game_date 컬럼 없음).
CREATE INDEX IF NOT EXISTS idx_venue_stories_diary
  ON venue_stories (user_id, game_id DESC)
  WHERE status IN ('active', 'archived');

-- ── 4) report RPC: removed 전이 시 removed_at 세팅 ────────────────────
-- 20260718 의 report_venue_story 를 CREATE OR REPLACE(멱등). 유일한 변경은
-- 신고 임계(>=3)로 active→removed 전이하는 그 UPDATE 에서 removed_at=now() 를 함께 기록해
-- cleanup 의 30일 격리 기준(removed_at)이 채워지도록 한 것. 나머지 로직/시그니처/ACL 불변.
CREATE OR REPLACE FUNCTION report_venue_story(
  p_story_id BIGINT,
  p_reporter UUID,
  p_reason   TEXT,
  p_detail   TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists BOOLEAN;
  v_rows   INT;
  v_count  INT;
  v_hidden BOOLEAN := false;
BEGIN
  SELECT true INTO v_exists FROM venue_stories WHERE id = p_story_id;
  IF v_exists IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  INSERT INTO reports (reporter_id, target_type, target_id, reason, detail)
  VALUES (p_reporter, 'venue_story', p_story_id::text, p_reason, p_detail)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok', true, 'alreadyReported', true);
  END IF;

  UPDATE venue_stories
     SET report_count = report_count + 1,
         status = CASE
                    WHEN report_count + 1 >= 3 AND status = 'active' THEN 'removed'
                    ELSE status
                  END,
         -- removed 전이 시각 기록(30일 격리 TTL 기준). 이미 removed 면 최초값 보존.
         removed_at = CASE
                        WHEN report_count + 1 >= 3 AND status = 'active' THEN now()
                        ELSE removed_at
                      END
   WHERE id = p_story_id
   RETURNING report_count, (status = 'removed') INTO v_count, v_hidden;

  RETURN jsonb_build_object('ok', true, 'reportCount', v_count, 'hidden', v_hidden);
END;
$$;

-- ACL fail-closed 재확인(CREATE OR REPLACE 는 기존 GRANT 를 유지하지만 멱등 재적용).
REVOKE ALL ON FUNCTION report_venue_story(BIGINT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION report_venue_story(BIGINT, UUID, TEXT, TEXT) TO service_role;
