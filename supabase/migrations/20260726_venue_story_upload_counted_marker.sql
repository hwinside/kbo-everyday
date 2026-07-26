-- 직관 스토리 "counted" 행 마커 — 어드민 목록을 카드(롤업) 집계와 1:1 정합화.
--
-- 배경(삼순 PR #885 NO-GO): 어드민 개요 '오늘 직관 영상/사진' 카드 값은
-- venue_story_upload_daily 롤업이라 "status 가 처음 active 가 된 story_geofence 업로드"만
-- 1회 집계하고, 만료·신고삭제·보관으로 행이 바뀌어도 무차감으로 보존한다.
-- 반면 카드 클릭 목록을 media_type+created_at 만으로 조회하면 pending(미게시),
-- admin_qa/legacy(지표 제외), 검증실패(pending→removed, 카드 미집계)까지 섞여
-- 카드 숫자와 목록 건수가 어긋난다.
--
-- → venue_story_upload_daily 트리거와 *완전히 동일한 조건*으로 각 행에 upload_counted_at
--   마커를 새긴다. 어드민 목록은 upload_counted_at IS NOT NULL 로만 조회하면
--   롤업이 +1 한 행 집합과 정확히 일치한다(이후 removed/archived 로 바뀌어도 마커 보존 = 무차감).
-- 단, 기존 롤업 배포 후 이미 removed/archived/DELETE 된 counted 행은 현재 행만으로 복원할 수 없다.
-- 최초 cutover 때 롤업과 현재 active+story_geofence 스냅샷이 날짜·미디어별로 다르면
-- migration 전체를 abort한다. 재적용 때는 기존 마커 집합과 롤업을 비교한다.
-- 조용한 부분 백필보다 fail-close가 안전하다.
--
-- 멱등: ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS / 조건부 UPDATE.
-- production 선적용 금지(리뷰 후).

-- ── 1) counted 마커 컬럼 ──────────────────────────────────────────────
-- upload_counted_at: 이 행이 롤업 카운트에 반영된(=처음 active+story_geofence 전이) 시각.
-- 값은 created_at 으로 고정 → 카드 upload_day(=created_at KST 날짜)와 목록 필터 기준이 동일해
-- 자정 넘겨 승격된 영상도 카드와 같은 날짜에 귀속된다. NULL = 미집계(pending/검증실패/admin_qa/legacy).
ALTER TABLE venue_stories
  ADD COLUMN IF NOT EXISTS upload_counted_at TIMESTAMPTZ;

COMMENT ON COLUMN venue_stories.upload_counted_at IS
  'venue_story_upload_daily 롤업에 집계된 행의 마커(=created_at). 어드민 목록을 카드 counted 집합과 1:1 정합화. NULL=미집계.';

-- ── 2) 최초 cutover preflight (복원 불가 이력은 fail-close) ───────────
-- Supabase 는 migration 파일을 단일 트랜잭션으로 실행한다. 두 테이블을 잠가 preflight부터
-- 백필·트리거 설치까지 concurrent INSERT/UPDATE/DELETE 및 롤업 변경을 막는다.
LOCK TABLE venue_stories IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE venue_story_upload_daily IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_mismatch RECORD;
BEGIN
  WITH marker_state AS (
    SELECT EXISTS (
      SELECT 1 FROM venue_stories WHERE upload_counted_at IS NOT NULL
    ) AS has_markers
  ),
  candidate_rows AS (
    SELECT (v.created_at AT TIME ZONE 'Asia/Seoul')::date AS upload_day,
           v.media_type,
           count(*)::bigint AS rows
      FROM venue_stories v
      CROSS JOIN marker_state m
     WHERE (m.has_markers AND v.upload_counted_at IS NOT NULL)
        OR (NOT m.has_markers
            AND v.status = 'active'
            AND v.attendance_source = 'story_geofence')
     GROUP BY 1, 2
  )
  SELECT COALESCE(r.upload_day, s.upload_day) AS upload_day,
         COALESCE(r.media_type, s.media_type) AS media_type,
         COALESCE(r.uploads, 0) AS rollup_uploads,
         COALESCE(s.rows, 0) AS candidate_rows
    INTO v_mismatch
    FROM (
      SELECT upload_day, media_type, uploads
        FROM venue_story_upload_daily
    ) r
    FULL OUTER JOIN candidate_rows s USING (upload_day, media_type)
   WHERE COALESCE(r.uploads, 0) <> COALESCE(s.rows, 0)
   ORDER BY 1, 2
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'venue story counted marker cutover mismatch: day=%, media_type=%, rollup=%, candidate_rows=%. Existing counted history cannot be reconstructed safely.',
      v_mismatch.upload_day, v_mismatch.media_type,
      v_mismatch.rollup_uploads, v_mismatch.candidate_rows;
  END IF;
END;
$$;

-- ── 3) BEFORE 트리거로 마커 세팅 ──────────────────────────────────────
-- bump_venue_story_upload_daily(AFTER, 롤업 +1)와 조건을 동일하게 유지한다:
--   status='active' AND attendance_source='story_geofence'
--   AND (INSERT active | 비-active→active 최초 전이)
-- BEFORE 트리거라 NEW 수정이 그 행 저장에 반영된다. 최초 1회만(IS NULL guard) 새겨
-- active↔active 재UPDATE·이후 removed/archived 전이에도 값이 흔들리지 않는다(무차감 대칭).
CREATE OR REPLACE FUNCTION mark_venue_story_upload_counted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'active'
     AND NEW.attendance_source = 'story_geofence'
     AND NEW.upload_counted_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
    NEW.upload_counted_at := NEW.created_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION mark_venue_story_upload_counted() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_mark_venue_story_upload_counted ON venue_stories;
CREATE TRIGGER trg_mark_venue_story_upload_counted
BEFORE INSERT OR UPDATE OF status ON venue_stories
FOR EACH ROW EXECUTE FUNCTION mark_venue_story_upload_counted();

-- ── 4) 백필 ───────────────────────────────────────────────────────────
-- 롤업 백필(20260725, status='active' AND story_geofence 스냅샷)과 동일 집합을 마킹한다.
-- preflight가 날짜·미디어별 롤업과 이 집합의 불일치에서 먼저 abort하므로, 이 UPDATE가
-- 일부만 마킹한 채 성공할 수 없다. 조건부(upload_counted_at IS NULL)라 멱등.
UPDATE venue_stories
   SET upload_counted_at = created_at
 WHERE status = 'active'
   AND attendance_source = 'story_geofence'
   AND upload_counted_at IS NULL;

-- ── 5) 어드민 목록 조회 인덱스 ────────────────────────────────────────
-- 오늘 KST 범위(created_at) + media_type + counted 필터의 최신순 목록용 partial 인덱스.
CREATE INDEX IF NOT EXISTS idx_venue_stories_counted_created
  ON venue_stories (media_type, created_at DESC)
  WHERE upload_counted_at IS NOT NULL;
