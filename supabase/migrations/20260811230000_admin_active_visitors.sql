-- 메인 대시보드 DAU/WAU/MAU + 추이 차트를 자체 집계(앱+웹)로 전환 (#cs 2026-08-11).
--
-- 지금까지 /admin 개요의 DAU/WAU/MAU·추이 차트는 GA4 activeUsers(외부 계측·
-- engaged 기준·차단 손실 포함)였고, /admin/traffic의 "일별 앱 활성 기기수"는
-- 자체 텔레메트리(admin_page_views → admin_traffic_daily_visitors rollup)라
-- 두 수치가 다르게 보였다. 아래는 자체 텔레메트리에서 전 플랫폼(web +
-- ios_native + android_native + native + unknown)을 합쳐 KST 기준으로 센다.
--
-- - 플랫폼을 넘나드는 동일인(웹 쿠키 vs 앱 기기 id)은 식별 불가라 각각 1로
--   센다 — 기기/브라우저 단위 활성 수라는 뜻이며 traffic 대시보드와 동일 기준.
-- - 플랫폼별·일별 UV 합산은 중복이 생기므로 전 구간 전역 DISTINCT만 쓴다.

-- 1) 누적용 영구 원장 --------------------------------------------------------
-- admin_traffic_daily_visitors rollup은 보존 365일이라 누적(런칭 이후)의
-- 원천으로 쓰면 1년 뒤부터 초기 방문자가 삭제돼 누적이 줄어든다(삼순 리뷰
-- 지적). 누적은 보존 삭제가 없는 전용 원장 2개로 분리한다:
--   admin_visitor_first_seen  — 방문자별 최초 등장일 (전역 distinct의 원천)
--   admin_traffic_daily_stats — 일별 PV 합 (누적 PV의 원천)
-- 자체 텔레메트리 수집 시작이 2026-06-25라(프로덕션 rollup 실측 min(day_kst))
-- 누적은 그 시점부터다 — 그 이전 이력은 GA4에만 있다.
CREATE TABLE IF NOT EXISTS admin_visitor_first_seen (
  visitor_id text PRIMARY KEY,
  first_day  date NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_traffic_daily_stats (
  day_kst date   PRIMARY KEY,
  pv      bigint NOT NULL DEFAULT 0
);

-- service_role only (RLS on + zero policies = deny all API roles).
ALTER TABLE admin_visitor_first_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_traffic_daily_stats ENABLE ROW LEVEL SECURITY;

-- 누적 시리즈는 first_day별 count라 커버링 인덱스로 index-only scan.
CREATE INDEX IF NOT EXISTS idx_admin_visitor_first_seen_day
  ON admin_visitor_first_seen (first_day);

-- 기존 rollup 트리거 함수에 두 원장 유지를 추가 (20260721 본문 + 신규 2블록).
CREATE OR REPLACE FUNCTION admin_page_views_track_traffic_rollups()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_platform text := COALESCE(NEW.platform, 'unknown');
  v_day date := (NEW.created_at AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
  IF NOT starts_with(NEW.path, '/_celeb') THEN
    INSERT INTO admin_traffic_daily_visitors (
      day_kst, platform, visitor_id, pv
    ) VALUES (
      v_day,
      v_platform,
      NEW.visitor_id,
      1
    )
    ON CONFLICT (day_kst, platform, visitor_id) DO UPDATE
    SET pv = admin_traffic_daily_visitors.pv + 1;

    -- 누적 원장: 최초 등장일은 한 번만 기록 (보존 삭제 없음).
    INSERT INTO admin_visitor_first_seen (visitor_id, first_day)
    VALUES (NEW.visitor_id, v_day)
    ON CONFLICT (visitor_id) DO NOTHING;

    -- 누적 원장: 일별 PV 합.
    INSERT INTO admin_traffic_daily_stats (day_kst, pv)
    VALUES (v_day, 1)
    ON CONFLICT (day_kst) DO UPDATE
    SET pv = admin_traffic_daily_stats.pv + 1;

    IF NEW.platform IN ('ios_native', 'android_native', 'native') THEN
      INSERT INTO admin_app_version_devices (
        platform, visitor_id, app_version, last_seen
      ) VALUES (
        NEW.platform, NEW.visitor_id, NEW.app_version, NEW.created_at
      )
      ON CONFLICT (platform, visitor_id) DO UPDATE
      SET app_version = EXCLUDED.app_version,
          last_seen = EXCLUDED.last_seen
      WHERE admin_app_version_devices.last_seen <= EXCLUDED.last_seen;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_page_views_track_traffic_rollups()
  FROM public, anon, authenticated;

-- 백필: 20260721과 동일한 handoff 패턴 — 쓰기를 잠근 뒤 스냅샷을 넣어 트리거
-- 경합으로 인한 이중집계/최초일 오염을 차단한다. rollup은 아직 365일 보존
-- 삭제가 한 번도 안 돈 상태(수집 시작 2026-06-25)라 전체 이력 백필이 완전하다.
LOCK TABLE admin_page_views IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO admin_visitor_first_seen (visitor_id, first_day)
SELECT visitor_id, min(day_kst)
FROM admin_traffic_daily_visitors
GROUP BY visitor_id
ON CONFLICT (visitor_id) DO UPDATE
SET first_day = LEAST(admin_visitor_first_seen.first_day, EXCLUDED.first_day);

INSERT INTO admin_traffic_daily_stats (day_kst, pv)
SELECT day_kst, sum(pv)
FROM admin_traffic_daily_visitors
GROUP BY day_kst
ON CONFLICT (day_kst) DO UPDATE
SET pv = EXCLUDED.pv;

ANALYZE admin_visitor_first_seen;
ANALYZE admin_traffic_daily_stats;

-- 2) KPI: 당일/7일/30일/누적 DISTINCT visitor_id ------------------------------
-- 당일/7일/30일은 rollup(보존 365일 » 30일 window)에서 전역 DISTINCT,
-- 누적(total)은 영구 원장에서 센다.
-- idx_admin_traffic_daily_visitors_day_covering (day_kst) INCLUDE
-- (platform, visitor_id, pv) 커버링 인덱스로 index-only scan.
CREATE OR REPLACE FUNCTION admin_active_visitors()
RETURNS TABLE(dau bigint, wau bigint, mau bigint, total bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT count(DISTINCT visitor_id)
       FROM admin_traffic_daily_visitors
      WHERE day_kst = (now() AT TIME ZONE 'Asia/Seoul')::date) AS dau,
    (SELECT count(DISTINCT visitor_id)
       FROM admin_traffic_daily_visitors
      WHERE day_kst >= (now() AT TIME ZONE 'Asia/Seoul')::date - 6) AS wau,
    (SELECT count(DISTINCT visitor_id)
       FROM admin_traffic_daily_visitors
      WHERE day_kst >= (now() AT TIME ZONE 'Asia/Seoul')::date - 29) AS mau,
    (SELECT count(*) FROM admin_visitor_first_seen) AS total;
$$;

REVOKE EXECUTE ON FUNCTION admin_active_visitors() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_active_visitors() TO service_role;

-- 3) 추이 시리즈: 당일(시간대별)/7일/30일(일별)/누적(running) -----------------
-- - today: raw admin_page_views에서 KST 시간대별 DISTINCT visitor_id + PV.
--   partial covering index(idx_apv_created_covering)와 동일한 celebration
--   제외 predicate를 써 index-only scan을 유지한다. raw 보존 30일 > 당일 OK.
-- - 7d/30d: GA4 구현과 동일하게 "완료된 날"만 — 어제까지 N일 (당일 미완성
--   구간이 곡선 끝을 왜곡하지 않게). 일별 값도 그 날의 전역 DISTINCT.
-- - cumulative: 영구 원장 기준 — 방문자 최초 등장일별 신규 수의 running sum
--   (재방문/일별 합산 중복 없음) + 일별 PV running sum. rollup 보존과 무관.
CREATE OR REPLACE FUNCTION admin_traffic_trend(p_period text)
RETURNS TABLE(label text, users bigint, pv bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Seoul')::date;
  v_days  int;
BEGIN
  IF p_period = 'today' THEN
    RETURN QUERY
    SELECT to_char(v.created_at AT TIME ZONE 'Asia/Seoul', 'HH24') AS label,
           count(DISTINCT v.visitor_id)::bigint AS users,
           count(*)::bigint AS pv
    FROM admin_page_views v
    WHERE v.created_at >= ((v_today::text || 'T00:00:00+09:00')::timestamptz)
      AND NOT starts_with(v.path, '/_celeb')
    GROUP BY 1
    ORDER BY 1;

  ELSIF p_period IN ('7d', '30d') THEN
    v_days := CASE WHEN p_period = '30d' THEN 30 ELSE 7 END;
    RETURN QUERY
    SELECT to_char(d.day_kst, 'MM/DD') AS label,
           count(DISTINCT d.visitor_id)::bigint AS users,
           sum(d.pv)::bigint AS pv
    FROM admin_traffic_daily_visitors d
    WHERE d.day_kst >= v_today - v_days
      AND d.day_kst < v_today
    GROUP BY d.day_kst
    ORDER BY d.day_kst;

  ELSIF p_period = 'cumulative' THEN
    RETURN QUERY
    WITH newbies AS (
      SELECT f.first_day AS day, count(*)::bigint AS n
      FROM admin_visitor_first_seen f
      GROUP BY f.first_day
    ),
    days AS (
      SELECT s.day_kst AS day, s.pv AS p
      FROM admin_traffic_daily_stats s
      WHERE s.day_kst < v_today
    )
    SELECT to_char(days.day, 'MM/DD') AS label,
           sum(COALESCE(newbies.n, 0)) OVER (ORDER BY days.day)::bigint AS users,
           sum(days.p) OVER (ORDER BY days.day)::bigint AS pv
    FROM days
    LEFT JOIN newbies ON newbies.day = days.day
    ORDER BY days.day;
  END IF;
  -- 알 수 없는 period는 0행 반환 (호출부에서 유효값만 보냄).
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_traffic_trend(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_traffic_trend(text) TO service_role;
