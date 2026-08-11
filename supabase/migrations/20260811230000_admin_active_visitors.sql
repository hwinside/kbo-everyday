-- 메인 대시보드 DAU/WAU/MAU + 추이 차트를 자체 집계(앱+웹)로 전환 (#cs 2026-08-11).
--
-- 지금까지 /admin 개요의 DAU/WAU/MAU·추이 차트는 GA4 activeUsers(외부 계측·
-- engaged 기준·차단 손실 포함)였고, /admin/traffic의 "일별 앱 활성 기기수"는
-- 자체 텔레메트리(admin_page_views → admin_traffic_daily_visitors rollup)라
-- 두 수치가 다르게 보였다. 아래 함수들은 자체 rollup에서 전 플랫폼(web +
-- ios_native + android_native + native + unknown)을 합쳐 KST 기준으로 센다.
--
-- - rollup은 insert 트리거로 실시간 유지되고 /_celeb 텔레메트리는 이미 제외됨
--   (20260721_admin_traffic_page_view_rollup.sql). 보존기간 365일이라 30일
--   window가 raw 보존(30일)에 걸리지 않는다.
-- - 플랫폼을 넘나드는 동일인(웹 쿠키 vs 앱 기기 id)은 식별 불가라 각각 1로
--   센다 — 기기/브라우저 단위 활성 수라는 뜻이며 traffic 대시보드와 동일 기준.
-- - idx_admin_traffic_daily_visitors_day_covering (day_kst) INCLUDE
--   (platform, visitor_id, pv) 커버링 인덱스로 index-only scan.

-- 1) KPI: 당일/7일/30일/누적 DISTINCT visitor_id ------------------------------
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
    (SELECT count(DISTINCT visitor_id)
       FROM admin_traffic_daily_visitors) AS total;
$$;

REVOKE EXECUTE ON FUNCTION admin_active_visitors() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_active_visitors() TO service_role;

-- 2) 추이 시리즈: 당일(시간대별)/7일/30일(일별)/누적(런칭 이후 running) --------
-- - today: raw admin_page_views에서 KST 시간대별 DISTINCT visitor_id + PV.
--   partial covering index(idx_apv_created_covering)와 동일한 celebration
--   제외 predicate를 써 index-only scan을 유지한다. raw 보존 30일 > 당일 OK.
-- - 7d/30d: GA4 구현과 동일하게 "완료된 날"만 — 어제까지 N일 (당일 미완성
--   구간이 곡선 끝을 왜곡하지 않게).
-- - cumulative: 방문자별 최초 등장일 기준 신규 수의 running sum (재방문 중복
--   제거) + PV running sum. 자체 텔레메트리 수집 시작이 2026-06-25라(프로덕션
--   rollup 실측 min(day_kst)) 누적은 그 시점부터다 — 그 이전 이력은 GA4에만
--   있다. 이후는 rollup 보존 365일 창 안에서 이어진다.
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
    WITH firsts AS (
      SELECT d.visitor_id, min(d.day_kst) AS day
      FROM admin_traffic_daily_visitors d
      GROUP BY d.visitor_id
    ),
    newbies AS (
      SELECT f.day, count(*)::bigint AS n FROM firsts f GROUP BY f.day
    ),
    days AS (
      SELECT d.day_kst AS day, sum(d.pv)::bigint AS p
      FROM admin_traffic_daily_visitors d
      WHERE d.day_kst < v_today
      GROUP BY d.day_kst
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
