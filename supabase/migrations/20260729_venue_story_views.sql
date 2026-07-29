-- 직관 스토리 조회수 트래킹 (A안 원문 기준 확정 스펙, 하린아빠 승인 2026-07-29 23:08 + "숫자는 관리자만" 23:09).
--
-- A안 = 게시글(#735) 패턴 이식: **뷰어 열람(click) + 트레이 노출(impression) 2종 분리 집계**.
--  - dedupe: **스토리×뷰어×kind×KST일** 단위 1회 — 같은 뷰어가 같은 스토리를 같은 날
--    같은 방식으로 여러 번 봐도 1회만 집계(원자 처리, 서버 권위).
--  - viewer_key: 로그인 `user:{uuid}` / 비로그인 `guest:{uuid}`(#735 과 같은 localStorage
--    영속 guest id). IP/NAT 기반 dedupe 금지 — 서버는 IP 를 키로 쓰지 않는다.
--  - 표시: raw 2종 분리 저장, 노출은 관리자 전용(합산 배지 + 상세 툴팁).
--
-- 설계 (20260725_venue_story_upload_daily.sql 의 durable rollup 패턴 준수):
--  - venue_story_view_marks: dedupe 원장. (story_id, viewer_key, kind, view_date) PK.
--    venue_stories FK ON DELETE CASCADE — 스토리가 cleanup/삭제되면 마크도 정리
--    (이후 재조회 불가능하므로 원장은 남길 이유가 없음).
--  - venue_story_view_daily: kind별 일별 영구 롤업. 의도적으로 FK 없음 —
--    venue-stories-cleanup cron 이 venue_stories 행을 실제 DELETE 하므로(2026-07-25 결정)
--    FK CASCADE 를 걸면 과거일 조회수가 스토리 정리와 함께 사라진다. 카운트는 무차감 영구 보존.
--  - 참고: venue_stories.id 는 BIGINT IDENTITY (uuid 아님) — 20260718_venue_stories.sql.
--
-- 날짜 귀속: 조회 시각 now() 의 KST 날짜 기준 (upload_daily 와 동일한 AT TIME ZONE 패턴).

CREATE TABLE IF NOT EXISTS venue_story_view_marks (
  story_id   BIGINT NOT NULL REFERENCES venue_stories(id) ON DELETE CASCADE,
  viewer_key TEXT   NOT NULL,
  kind       TEXT   NOT NULL CHECK (kind IN ('click', 'impression')),
  view_date  DATE   NOT NULL,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_key, kind, view_date)
);

COMMENT ON TABLE venue_story_view_marks IS
  '직관 스토리 조회 dedupe 원장. 스토리×뷰어×kind(click|impression)×KST일 1행. 스토리 삭제 시 CASCADE 정리.';

CREATE TABLE IF NOT EXISTS venue_story_view_daily (
  story_id   BIGINT NOT NULL, -- 의도적 FK 없음: 스토리 cleanup 삭제 후에도 조회수 영구 보존
  kind       TEXT   NOT NULL CHECK (kind IN ('click', 'impression')),
  view_date  DATE   NOT NULL,
  view_count BIGINT NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  PRIMARY KEY (story_id, kind, view_date)
);

COMMENT ON TABLE venue_story_view_daily IS
  '직관 스토리 kind별(click|impression) 일별 조회수 영구 롤업. venue_stories 정리(삭제)와 독립 보존. 관리자 노출/운영 분석용.';

ALTER TABLE venue_story_view_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE venue_story_view_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE venue_story_view_marks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE venue_story_view_daily FROM PUBLIC, anon, authenticated;

-- 조회 기록 RPC — API(service_role)가 호출. 원자적으로:
--  1) kind 검증 (click|impression 외에는 no-op — API 가 선검증하지만 이중 방어)
--  2) active 스토리만 집계 (없거나 removed/pending 은 조용히 no-op — 정보 누출 없음)
--  3) marks INSERT ... ON CONFLICT DO NOTHING 으로 스토리×뷰어×kind×KST일 dedupe
--  4) 신규 insert 였을 때만 해당 kind 의 daily 롤업 +1
CREATE OR REPLACE FUNCTION record_venue_story_view(p_story_id BIGINT, p_viewer_key TEXT, p_kind TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day      DATE := (now() AT TIME ZONE 'Asia/Seoul')::date;
  v_inserted INT  := 0;
BEGIN
  IF p_story_id IS NULL OR p_viewer_key IS NULL OR length(trim(p_viewer_key)) = 0 THEN
    RETURN;
  END IF;
  IF p_kind IS DISTINCT FROM 'click' AND p_kind IS DISTINCT FROM 'impression' THEN
    RETURN;
  END IF;

  -- active 스토리만 집계. 없는/removed 스토리는 조용히 무시.
  IF NOT EXISTS (SELECT 1 FROM venue_stories WHERE id = p_story_id AND status = 'active') THEN
    RETURN;
  END IF;

  BEGIN
    INSERT INTO venue_story_view_marks (story_id, viewer_key, kind, view_date)
    VALUES (p_story_id, p_viewer_key, p_kind, v_day)
    ON CONFLICT (story_id, viewer_key, kind, view_date) DO NOTHING;
    -- ON CONFLICT skip 이면 ROW_COUNT=0 → 신규 조회일 때만 롤업 +1.
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    -- EXISTS 확인과 INSERT 사이에 스토리가 삭제된 레이스 — 조용히 무시.
    RETURN;
  END;

  IF v_inserted > 0 THEN
    INSERT INTO venue_story_view_daily (story_id, kind, view_date, view_count)
    VALUES (p_story_id, p_kind, v_day, 1)
    ON CONFLICT (story_id, kind, view_date)
    DO UPDATE SET view_count = venue_story_view_daily.view_count + 1;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION record_venue_story_view(BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_venue_story_view(BIGINT, TEXT, TEXT) TO service_role;
