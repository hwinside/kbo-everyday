-- 직관 스토리 업로드 일별 영구 롤업.
--
-- 배경: venue-stories-cleanup cron 이 경기 종료+24h 등에서 venue_stories 행을 실제
-- DELETE 한다(src/app/api/cron/venue-stories-cleanup). 따라서 라이브 테이블을 그대로
-- 집계하면 과거일 업로드 수가 시간이 지나며 사라져 7일/30일/누적 추이를 못 낸다.
-- → 업로드 시점에 KST 일자 + media_type 별로 원자 upsert 하는 영구 카운터를 둔다.
--
-- 카운트 기준(하린아빠 7/25: "하루동안 업로드된 것들만 카운트"):
--  - status 가 처음 'active' 가 되는 순간 1회 집계(이미지=INSERT active, 영상=검증 승격 UPDATE pending→active).
--    검증 실패(pending→removed)한 영상은 집계하지 않는다(실제 게시된 업로드만).
--  - 실제 GPS 인증 유저 업로드(attendance_source='story_geofence')만 집계.
--    관리자 QA 우회(admin_qa)·구버전(legacy_unclassified)은 지표 오염 방지로 제외.
--  - 만료·신고삭제로 행이 나중에 사라져도 카운터는 무차감(그날 업로드된 사실은 영구).
-- 일자는 업로드(생성) 시각 = created_at 의 KST 날짜 기준.

CREATE TABLE IF NOT EXISTS venue_story_upload_daily (
  upload_day  DATE   NOT NULL,
  media_type  TEXT   NOT NULL CHECK (media_type IN ('video', 'image')),
  uploads     BIGINT NOT NULL DEFAULT 0 CHECK (uploads >= 0),
  PRIMARY KEY (upload_day, media_type)
);

COMMENT ON TABLE venue_story_upload_daily IS
  '직관 스토리 업로드 일별 영구 롤업. venue_stories 정리(삭제)와 독립적으로 그날 업로드 수를 보존한다. story_geofence 만 집계, admin_qa/legacy 제외.';

ALTER TABLE venue_story_upload_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE venue_story_upload_daily FROM PUBLIC, anon, authenticated;

-- status 가 처음 active 가 되는 트랜잭션에서 원자적으로 카운터를 올린다.
-- record_venue_attendance_from_story 와 동일한 트리거 지점(AFTER INSERT OR UPDATE OF status)을
-- 재사용하되, 이중집계 방지를 위해 active 로의 최초 전이(INSERT active / 비-active→active)만 +1 한다.
CREATE OR REPLACE FUNCTION bump_venue_story_upload_daily()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'active'
     AND NEW.attendance_source = 'story_geofence'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
    INSERT INTO venue_story_upload_daily (upload_day, media_type, uploads)
    VALUES ((NEW.created_at AT TIME ZONE 'Asia/Seoul')::date, NEW.media_type, 1)
    ON CONFLICT (upload_day, media_type)
    DO UPDATE SET uploads = venue_story_upload_daily.uploads + 1;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION bump_venue_story_upload_daily() FROM PUBLIC, anon, authenticated;

-- 백필: 아직 정리되지 않고 남아있는 active + story_geofence 행을 현재 스냅샷으로 세팅한다.
-- (이미 삭제된 과거 행은 복원 불가 — 배포 시점 이후의 정확성이 목표.)
-- 트리거보다 먼저 실행해 이 백필과 트리거의 동시 insert 이중집계를 원천 차단한다
-- (트리거가 아직 없으므로 백필에 잡힌 기존 행은 트리거로 다시 세지 않는다).
INSERT INTO venue_story_upload_daily (upload_day, media_type, uploads)
SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date, media_type, count(*)
  FROM venue_stories
 WHERE status = 'active'
   AND attendance_source = 'story_geofence'
 GROUP BY 1, 2
ON CONFLICT (upload_day, media_type)
DO UPDATE SET uploads = EXCLUDED.uploads;

DROP TRIGGER IF EXISTS trg_bump_venue_story_upload ON venue_stories;
CREATE TRIGGER trg_bump_venue_story_upload
AFTER INSERT OR UPDATE OF status ON venue_stories
FOR EACH ROW EXECUTE FUNCTION bump_venue_story_upload_daily();

-- 어드민 조회용 일별 집계(영상/사진 분해). 전 기간 반환 → API/프론트가 7일/30일/누적 토글.
-- service_role 전용, 어드민 PIN 게이트 뒤 호출.
CREATE OR REPLACE FUNCTION admin_venue_story_daily()
RETURNS TABLE(day date, videos bigint, photos bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT upload_day AS day,
         COALESCE(sum(uploads) FILTER (WHERE media_type = 'video'), 0) AS videos,
         COALESCE(sum(uploads) FILTER (WHERE media_type = 'image'), 0) AS photos
  FROM venue_story_upload_daily
  GROUP BY upload_day
  ORDER BY upload_day;
$$;

REVOKE EXECUTE ON FUNCTION admin_venue_story_daily() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_venue_story_daily() TO service_role;
