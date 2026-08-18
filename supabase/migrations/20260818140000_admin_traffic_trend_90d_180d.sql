-- admin_traffic_trend: 일별 추이 period에 90일/180일 추가.
-- 기존 7d/30d 완료일 로직을 그대로 확장 — 어제까지 N일(당일 미완성 제외),
-- 일별 값은 그 날의 전역 DISTINCT visitor + PV. today/cumulative 분기 무변경.
-- admin_traffic_daily_visitors는 일별 rollup이라 180행도 bounded.
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

  ELSIF p_period IN ('7d', '30d', '90d', '180d') THEN
    v_days := CASE p_period
                WHEN '180d' THEN 180
                WHEN '90d'  THEN 90
                WHEN '30d'  THEN 30
                ELSE 7
              END;
    RETURN QUERY
    SELECT to_char(d.day_kst, 'YYYY-MM-DD') AS label,
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
    SELECT to_char(days.day, 'YYYY-MM-DD') AS label,
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
